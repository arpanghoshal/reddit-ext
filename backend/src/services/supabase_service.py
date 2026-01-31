"""
Supabase Service
Database operations for DM history, automation logs, settings, and analytics
"""

import os
import random
import string
from datetime import datetime, timedelta
from typing import Optional, Dict, List, Any
from supabase import create_client, Client

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

async def log_dm(data: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    """Log a DM to the database"""
    client = get_client()
    if not client:
        print("Supabase not configured - skipping DM logging")
        return None

    try:
        result = client.table("dm_history").insert({
            "recipient_username": data.get("recipientUsername"),
            "post_url": data.get("postUrl"),
            "post_title": data.get("postTitle"),
            "subreddit": data.get("subreddit"),
            "message_content": data.get("messageContent"),
            "status": data.get("status", "sent"),
            "automation_type": data.get("automationType", "single"),
            "session_id": data.get("sessionId")
        }).execute()

        if result.data:
            print(f"DM logged to Supabase: {result.data[0]}")
            return result.data[0]
        return None
    except Exception as e:
        print(f"Failed to log DM: {e}")
        return None


async def get_dm_history(limit: int = 50) -> List[Dict[str, Any]]:
    """Get DM history"""
    client = get_client()
    if not client:
        return []

    try:
        result = client.table("dm_history").select("*").order(
            "created_at", desc=True
        ).limit(limit).execute()

        return result.data if result.data else []
    except Exception as e:
        print(f"Failed to get DM history: {e}")
        return []


# --- Automation Logs ---

async def start_automation_session(data: Dict[str, Any]) -> Dict[str, Any]:
    """Start a new automation session"""
    client = get_client()
    session_id = generate_session_id()

    if not client:
        print("Supabase not configured - skipping session logging")
        return {"sessionId": session_id, "record": None}

    try:
        result = client.table("automation_logs").insert({
            "session_id": session_id,
            "subreddit": data.get("subreddit"),
            "total_posts": data.get("totalPosts", 0),
            "processed_count": 0,
            "success_count": 0,
            "failed_count": 0,
            "status": "running"
        }).execute()

        if result.data:
            print(f"Automation session started: {result.data[0]}")
            return {"sessionId": session_id, "record": result.data[0]}
        return {"sessionId": session_id, "record": None}
    except Exception as e:
        print(f"Failed to start automation session: {e}")
        return {"sessionId": session_id, "record": None}


async def update_automation_session(session_id: str, data: Dict[str, Any]) -> Optional[Dict[str, Any]]:
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

        result = client.table("automation_logs").update(
            update_data
        ).eq("session_id", session_id).execute()

        if result.data:
            print(f"Automation session updated: {result.data[0]}")
            return result.data[0]
        return None
    except Exception as e:
        print(f"Failed to update automation session: {e}")
        return None


async def get_automation_logs(limit: int = 20) -> List[Dict[str, Any]]:
    """Get automation logs"""
    client = get_client()
    if not client:
        return []

    try:
        result = client.table("automation_logs").select("*").order(
            "created_at", desc=True
        ).limit(limit).execute()

        return result.data if result.data else []
    except Exception as e:
        print(f"Failed to get automation logs: {e}")
        return []


# --- User Settings ---

async def save_settings(settings: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    """Save user settings"""
    client = get_client()
    if not client:
        print("Supabase not configured - settings saved locally only")
        return None

    try:
        existing = await get_settings()

        settings_data = {
            "business_desc": settings.get("businessDesc"),
            "persona": settings.get("persona"),
            "insight_types": settings.get("insightTypes", []),
            "tone": settings.get("tone", "Curious"),
            "updated_at": datetime.utcnow().isoformat()
        }

        if existing:
            result = client.table("user_settings").update(
                settings_data
            ).eq("id", existing["id"]).execute()
        else:
            result = client.table("user_settings").insert(settings_data).execute()

        if result.data:
            print(f"Settings saved to Supabase: {result.data[0]}")
            return result.data[0]
        return None
    except Exception as e:
        print(f"Failed to save settings: {e}")
        return None


async def get_settings() -> Optional[Dict[str, Any]]:
    """Get user settings"""
    client = get_client()
    if not client:
        return None

    try:
        result = client.table("user_settings").select("*").order(
            "created_at", desc=True
        ).limit(1).execute()

        return result.data[0] if result.data else None
    except Exception as e:
        # PGRST116 = no rows found
        if "PGRST116" not in str(e):
            print(f"Failed to get settings: {e}")
        return None


# --- Analytics Functions ---

async def get_analytics() -> Dict[str, Any]:
    """Get analytics data"""
    client = get_client()
    if not client:
        return {"totalDMs": 0, "successRate": 0, "todayCount": 0, "weekCount": 0}

    try:
        result = client.table("dm_history").select("*").order(
            "created_at", desc=True
        ).limit(1000).execute()

        if not result.data:
            return {"totalDMs": 0, "successRate": 0, "todayCount": 0, "weekCount": 0}

        dms = result.data
        now = datetime.utcnow()
        today = now.replace(hour=0, minute=0, second=0, microsecond=0)
        week_ago = today - timedelta(days=7)

        today_dms = [dm for dm in dms if datetime.fromisoformat(
            dm["created_at"].replace("Z", "+00:00")
        ).replace(tzinfo=None) >= today]

        week_dms = [dm for dm in dms if datetime.fromisoformat(
            dm["created_at"].replace("Z", "+00:00")
        ).replace(tzinfo=None) >= week_ago]

        success_dms = [dm for dm in dms if dm.get("status") == "sent"]

        return {
            "totalDMs": len(dms),
            "successRate": round((len(success_dms) / len(dms)) * 100) if dms else 0,
            "todayCount": len(today_dms),
            "weekCount": len(week_dms)
        }
    except Exception as e:
        print(f"Failed to get analytics: {e}")
        return {"totalDMs": 0, "successRate": 0, "todayCount": 0, "weekCount": 0}


async def get_dms_by_subreddit(limit: int = 10) -> List[Dict[str, Any]]:
    """Get top subreddits by DM count"""
    client = get_client()
    if not client:
        return []

    try:
        result = client.table("dm_history").select("subreddit").order(
            "created_at", desc=True
        ).limit(500).execute()

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
        return [{"subreddit": sub, "count": count} for sub, count in sorted_items[:limit]]
    except Exception as e:
        print(f"Failed to get DMs by subreddit: {e}")
        return []
