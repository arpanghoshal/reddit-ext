"""
Supabase Service
Database operations for DM history, automation logs, settings, and analytics
"""

import os
import logging
import random
import string
import hashlib
from datetime import datetime, timedelta
from typing import Optional, Dict, List, Any
from supabase import create_client, Client

from .redis_client import cache_get, cache_set, cache_delete

logger = logging.getLogger(__name__)

_supabase: Optional[Client] = None


def get_client() -> Optional[Client]:
    """Get or create Supabase client (singleton)"""
    global _supabase
    if _supabase is None:
        url = os.getenv("SUPABASE_URL")
        key = os.getenv("SUPABASE_KEY")

        if not url or not key:
            return None

        _supabase = create_client(url, key)
    return _supabase


def is_configured() -> bool:
    """Check if Supabase is configured"""
    return bool(os.getenv("SUPABASE_URL") and os.getenv("SUPABASE_KEY"))


def generate_session_id() -> str:
    """Generate a unique session ID"""
    timestamp = int(datetime.now().timestamp() * 1000)
    random_str = ''.join(random.choices(string.ascii_lowercase + string.digits, k=9))
    return f"session_{timestamp}_{random_str}"


# --- DM History ---

async def log_dm(data: Dict[str, Any], team_id: Optional[str] = None) -> Optional[Dict[str, Any]]:
    """Log a DM to the database and create a conversation"""
    client = get_client()
    if not client:
        logger.warning("Supabase not configured - skipping DM logging")
        return None

    try:
        insert_data = {
            "recipient_username": data.get("recipientUsername"),
            "post_url": data.get("postUrl"),
            "post_title": data.get("postTitle"),
            "subreddit": data.get("subreddit"),
            "message_content": data.get("messageContent"),
            "status": data.get("status", "sent"),
            "automation_type": data.get("automationType", "single"),
            "session_id": data.get("sessionId"),
            "account_id": data.get("accountId")
        }
        if team_id:
            insert_data["team_id"] = team_id

        # Insert DM record
        result = client.table("dm_history").insert(insert_data).execute()

        if result.data:
            dm_record = result.data[0]
            logger.info(f"DM logged: {dm_record.get('id', 'unknown')}")

            # Auto-create conversation for this DM
            recipient = data.get("recipientUsername", "").lower()
            if recipient:
                await _create_or_update_conversation(client, recipient, dm_record, data, team_id)

            # Record contact for dedup (covers extension direct sends)
            if team_id and recipient:
                from . import dedup
                await dedup.record_contact(
                    recipient, team_id,
                    source="dm_history",
                    account_id=data.get("accountId"),
                )

            return dm_record
        return None
    except Exception as e:
        logger.error(f"Failed to log DM: {e}")
        return None


async def _create_or_update_conversation(
    client: Client,
    recipient: str,
    dm_record: Dict[str, Any],
    data: Dict[str, Any],
    team_id: Optional[str] = None
) -> None:
    """Create or update conversation when DM is sent"""
    try:
        # Check if conversation already exists for this recipient (scoped to account)
        query = client.table("conversations").select("id, total_messages").eq(
            "participant_username", recipient
        )
        if team_id:
            query = query.eq("team_id", team_id)
        account_id = data.get("accountId")
        if account_id:
            query = query.eq("account_id", account_id)
        existing = query.limit(1).execute()

        conversation_id = None
        now = datetime.utcnow().isoformat()

        if existing.data and len(existing.data) > 0:
            # Update existing conversation (don't increment total_messages yet)
            conversation_id = existing.data[0]["id"]
            client.table("conversations").update({
                "last_message_at": now,
                "last_message_direction": "outbound",
                "updated_at": now
            }).eq("id", conversation_id).execute()
        else:
            # Create new conversation (total_messages starts at 0, updated after insert)
            conv_insert = {
                "participant_username": recipient,
                "account_id": data.get("accountId"),
                "initial_dm_id": dm_record.get("id"),
                "status": "active",
                "last_message_at": now,
                "last_message_direction": "outbound",
                "total_messages": 0,
                "has_reply": False
            }
            if team_id:
                conv_insert["team_id"] = team_id
            conv_result = client.table("conversations").insert(conv_insert).execute()
            if conv_result.data:
                conversation_id = conv_result.data[0]["id"]
                logger.info(f"Conversation created for {recipient}")

        # Add the message to the messages table (with fingerprint dedup)
        if conversation_id and data.get("messageContent"):
            content = data.get("messageContent")
            normalized = " ".join(content.lower().strip().split())
            # Include minute-level timestamp to allow same message text sent >1 min apart
            minute_bucket = now[:16]  # "2026-02-10T14:30"
            fingerprint = hashlib.sha256(f"{normalized}|outbound|{minute_bucket}".encode('utf-8')).hexdigest()[:16]

            msg_insert = {
                "conversation_id": conversation_id,
                "direction": "outbound",
                "content": content,
                "sent_at": now,
                "is_ai_generated": True,
                "fingerprint": fingerprint
            }
            if team_id:
                msg_insert["team_id"] = team_id

            msg_ok = False
            try:
                client.table("messages").upsert(
                    msg_insert,
                    on_conflict="conversation_id,fingerprint"
                ).execute()
                msg_ok = True
            except Exception as upsert_err:
                logger.warning(f"Message upsert failed, trying insert without fingerprint: {upsert_err}")
                msg_insert.pop("fingerprint", None)
                try:
                    client.table("messages").insert(msg_insert).execute()
                    msg_ok = True
                except Exception as insert_err:
                    logger.error(f"Message insert fallback also failed: {insert_err}")

            if msg_ok:
                # Update total_messages based on actual count
                count_result = client.table("messages").select("id", count="exact").eq(
                    "conversation_id", conversation_id
                ).execute()
                actual_count = count_result.count if count_result.count is not None else 1
                client.table("conversations").update({
                    "total_messages": actual_count
                }).eq("id", conversation_id).execute()
                logger.info(f"Message added to conversation {conversation_id} (total: {actual_count})")

    except Exception as e:
        logger.error(f"Failed to create/update conversation: {e}")


async def get_dm_history(limit: int = 50, team_id: Optional[str] = None) -> List[Dict[str, Any]]:
    """Get DM history"""
    client = get_client()
    if not client:
        return []

    try:
        query = client.table("dm_history").select("*, reddit_accounts(id, username)").order(
            "created_at", desc=True
        )
        if team_id:
            query = query.eq("team_id", team_id)
        result = query.limit(limit).execute()

        if not result.data:
            return []
        # Extract account username into flat structure
        for row in result.data:
            account = row.pop("reddit_accounts", None)
            row["account_username"] = account.get("username") if account else None
        return result.data
    except Exception as e:
        logger.error(f"Failed to get DM history: {e}")
        return []


# --- Automation Logs ---

async def start_automation_session(data: Dict[str, Any], team_id: Optional[str] = None) -> Dict[str, Any]:
    """Start a new automation session"""
    client = get_client()
    session_id = generate_session_id()

    if not client:
        logger.warning("Supabase not configured - skipping session logging")
        return {"sessionId": session_id, "record": None}

    try:
        insert_data = {
            "session_id": session_id,
            "subreddit": data.get("subreddit"),
            "total_posts": data.get("totalPosts", 0),
            "processed_count": 0,
            "success_count": 0,
            "failed_count": 0,
            "status": "running"
        }
        if team_id:
            insert_data["team_id"] = team_id
        result = client.table("automation_logs").insert(insert_data).execute()

        if result.data:
            logger.info(f"Automation session started: {session_id}")
            return {"sessionId": session_id, "record": result.data[0]}
        return {"sessionId": session_id, "record": None}
    except Exception as e:
        logger.error(f"Failed to start automation session: {e}")
        return {"sessionId": session_id, "record": None}


async def update_automation_session(session_id: str, data: Dict[str, Any], team_id: Optional[str] = None) -> Optional[Dict[str, Any]]:
    """Update an automation session"""
    client = get_client()
    if not client:
        return None

    try:
        update_data = {}

        if "processedCount" in data:
            update_data["processed_count"] = data["processedCount"]
        if "successCount" in data:
            update_data["success_count"] = data["successCount"]
        if "failedCount" in data:
            update_data["failed_count"] = data["failedCount"]
        if "status" in data:
            update_data["status"] = data["status"]
            if data["status"] in ["completed", "stopped"]:
                update_data["completed_at"] = datetime.utcnow().isoformat()

        query = client.table("automation_logs").update(
            update_data
        ).eq("session_id", session_id)
        if team_id:
            query = query.eq("team_id", team_id)
        result = query.execute()

        if result.data:
            logger.info(f"Automation session updated: {session_id}")
            return result.data[0]
        return None
    except Exception as e:
        logger.error(f"Failed to update automation session: {e}")
        return None


async def get_automation_logs(limit: int = 20, team_id: Optional[str] = None) -> List[Dict[str, Any]]:
    """Get automation logs"""
    client = get_client()
    if not client:
        return []

    try:
        query = client.table("automation_logs").select("*").order(
            "created_at", desc=True
        )
        if team_id:
            query = query.eq("team_id", team_id)
        result = query.limit(limit).execute()

        return result.data if result.data else []
    except Exception as e:
        logger.error(f"Failed to get automation logs: {e}")
        return []


# --- User Settings ---

async def save_settings(settings: Dict[str, Any], team_id: Optional[str] = None) -> Optional[Dict[str, Any]]:
    """Save user settings"""
    client = get_client()
    if not client:
        logger.warning("Supabase not configured - settings saved locally only")
        return None

    try:
        existing = await get_settings(team_id=team_id)

        settings_data = {
            "business_desc": settings.get("businessDesc"),
            "persona": settings.get("persona"),
            "insight_types": settings.get("insightTypes", []),
            "tone": settings.get("tone", "Curious"),
            "business_context": settings.get("businessContext"),
            "updated_at": datetime.utcnow().isoformat()
        }

        if existing:
            result = client.table("user_settings").update(
                settings_data
            ).eq("id", existing["id"]).execute()
        else:
            if team_id:
                settings_data["team_id"] = team_id
            result = client.table("user_settings").insert(settings_data).execute()

        if result.data:
            logger.info("Settings saved to Supabase")
            await cache_delete(f"user_settings:{team_id or 'default'}")
            return result.data[0]
        return None
    except Exception as e:
        logger.error(f"Failed to save settings: {e}")
        return None


async def get_settings(team_id: Optional[str] = None) -> Optional[Dict[str, Any]]:
    """Get user settings"""
    cache_key = f"user_settings:{team_id or 'default'}"
    cached = await cache_get(cache_key)
    if cached is not None:
        return cached

    client = get_client()
    if not client:
        return None

    try:
        query = client.table("user_settings").select("*")
        if team_id:
            query = query.eq("team_id", team_id)
        result = query.order(
            "created_at", desc=True
        ).limit(1).execute()

        if result.data:
            await cache_set(cache_key, result.data[0], 3600)
            return result.data[0]
        return None
    except Exception as e:
        # PGRST116 = no rows found
        if "PGRST116" not in str(e):
            logger.error(f"Failed to get settings: {e}")
        return None


# --- Analytics Functions ---

async def get_analytics(team_id: Optional[str] = None) -> Dict[str, Any]:
    """Get analytics data"""
    cache_key = f"analytics:{team_id or 'default'}"
    cached = await cache_get(cache_key)
    if cached is not None:
        return cached

    client = get_client()
    if not client:
        return {"totalDMs": 0, "successRate": 0, "todayCount": 0, "weekCount": 0}

    try:
        query = client.table("dm_history").select("*").order(
            "created_at", desc=True
        )
        if team_id:
            query = query.eq("team_id", team_id)
        result = query.limit(1000).execute()

        if not result.data:
            return {"totalDMs": 0, "successRate": 0, "todayCount": 0, "weekCount": 0}

        dms = result.data
        now = datetime.utcnow()
        # Use last 24 hours instead of "UTC today" to be timezone-agnostic
        twenty_four_hours_ago = now - timedelta(hours=24)
        week_ago = now - timedelta(days=7)

        def parse_timestamp(ts_str):
            """Parse timestamp string to naive UTC datetime"""
            try:
                # Handle different timestamp formats
                ts = ts_str.replace("Z", "+00:00")
                dt = datetime.fromisoformat(ts)
                # Convert to UTC naive datetime for comparison
                if dt.tzinfo is not None:
                    dt = dt.replace(tzinfo=None)
                return dt
            except Exception:
                return None

        today_dms = []
        week_dms = []
        for dm in dms:
            created = parse_timestamp(dm.get("created_at", ""))
            if created:
                if created >= twenty_four_hours_ago:
                    today_dms.append(dm)
                if created >= week_ago:
                    week_dms.append(dm)

        success_dms = [dm for dm in dms if dm.get("status") == "sent"]

        analytics_result = {
            "totalDMs": len(dms),
            "successRate": round((len(success_dms) / len(dms)) * 100) if dms else 0,
            "todayCount": len(today_dms),
            "weekCount": len(week_dms)
        }
        await cache_set(cache_key, analytics_result, 600)
        return analytics_result
    except Exception as e:
        logger.error(f"Failed to get analytics: {e}")
        return {"totalDMs": 0, "successRate": 0, "todayCount": 0, "weekCount": 0}


async def get_dms_by_subreddit(limit: int = 10, team_id: Optional[str] = None) -> List[Dict[str, Any]]:
    """Get top subreddits by DM count"""
    cache_key = f"dms_by_sub:{team_id or 'default'}:{limit}"
    cached = await cache_get(cache_key)
    if cached is not None:
        return cached

    client = get_client()
    if not client:
        return []

    try:
        query = client.table("dm_history").select("subreddit").order(
            "created_at", desc=True
        )
        if team_id:
            query = query.eq("team_id", team_id)
        result = query.limit(500).execute()

        if not result.data:
            return []

        # Count by subreddit
        counts: Dict[str, int] = {}
        for dm in result.data:
            subreddit = dm.get("subreddit")
            if subreddit:
                counts[subreddit] = counts.get(subreddit, 0) + 1

        # Sort by count and take top N
        sorted_items = sorted(counts.items(), key=lambda x: x[1], reverse=True)
        sub_result = [{"subreddit": sub, "count": count} for sub, count in sorted_items[:limit]]
        await cache_set(cache_key, sub_result, 900)
        return sub_result
    except Exception as e:
        logger.error(f"Failed to get DMs by subreddit: {e}")
        return []
