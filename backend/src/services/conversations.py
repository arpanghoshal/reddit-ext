"""
Conversations Service
Manages conversation threads and messages for the inbox
"""

import os
import logging
import hashlib
from datetime import datetime
from typing import Dict, Any, List, Optional, Set
from supabase import create_client, Client

logger = logging.getLogger(__name__)

_supabase: Optional[Client] = None

# Conversation statuses
CONVERSATION_STATUS = {
    "ACTIVE": "active",
    "INTERESTED": "interested",
    "COLD": "cold",
    "CLOSED": "closed",
    "CONVERTED": "converted"
}


def get_client() -> Optional[Client]:
    """Get or create Supabase client"""
    global _supabase
    if _supabase is None:
        url = os.getenv("SUPABASE_URL")
        key = os.getenv("SUPABASE_KEY")
        if url and key:
            _supabase = create_client(url, key)
    return _supabase


def transform_conversation(row: Optional[Dict[str, Any]]) -> Optional[Dict[str, Any]]:
    """Transform conversation row to API format"""
    if not row:
        return None

    account = row.get("reddit_accounts")

    # Extract source post from whichever join returned data
    dm_hist = row.get("dm_history")
    dm_q = row.get("dm_queue")
    source = dm_hist or dm_q

    return {
        "id": row.get("id"),
        "teamId": row.get("team_id"),
        "redditConversationId": row.get("reddit_conversation_id"),
        "participantUsername": row.get("participant_username"),
        "accountId": row.get("account_id"),
        "accountUsername": account.get("username") if account else None,
        "accountStatus": account.get("status") if account else None,
        "initialDmId": row.get("initial_dm_id"),
        "initialQueueId": row.get("initial_queue_id"),
        "status": row.get("status"),
        "lastMessageAt": row.get("last_message_at"),
        "lastMessageDirection": row.get("last_message_direction"),
        "totalMessages": row.get("total_messages"),
        "hasReply": row.get("has_reply"),
        "notes": row.get("notes"),
        "tags": row.get("tags"),
        "createdAt": row.get("created_at"),
        "updatedAt": row.get("updated_at"),
        "sourcePostUrl": source.get("post_url") if source else None,
        "sourcePostTitle": source.get("post_title") if source else None,
        "sourceSubreddit": source.get("subreddit") if source else None,
    }


def transform_message(row: Optional[Dict[str, Any]]) -> Optional[Dict[str, Any]]:
    """Transform message row to API format"""
    if not row:
        return None

    return {
        "id": row.get("id"),
        "conversationId": row.get("conversation_id"),
        "direction": row.get("direction"),
        "content": row.get("content"),
        "sentAt": row.get("sent_at"),
        "isAiGenerated": row.get("is_ai_generated"),
        "createdAt": row.get("created_at")
    }


def create_message_fingerprint(content: str, direction: str, sent_at: str = None) -> str:
    """
    Create unique fingerprint for message deduplication.
    Uses content + direction + minute-level timestamp bucket (when available).
    This allows the same message text to appear again if sent >1 minute apart,
    while still deduplicating concurrent identical requests within the same minute.
    """
    normalized_content = " ".join((content or "").lower().strip().split())
    composite = f"{normalized_content}|{direction}"
    if sent_at:
        # Truncate to minute for dedup window (first 16 chars of ISO: "2026-02-10T14:30")
        minute_bucket = sent_at[:16]
        composite += f"|{minute_bucket}"
    return hashlib.sha256(composite.encode('utf-8')).hexdigest()[:16]


async def create_conversation(conversation_data: Dict[str, Any], team_id: Optional[str] = None) -> Optional[Dict[str, Any]]:
    """Create a new conversation"""
    client = get_client()
    if not client:
        logger.warning("supabase_not_configured")
        return None

    try:
        insert_data = {
            "reddit_conversation_id": conversation_data.get("redditConversationId"),
            "participant_username": conversation_data.get("participantUsername", "").lower(),
            "account_id": conversation_data.get("accountId"),
            "initial_dm_id": conversation_data.get("initialDmId"),
            "initial_queue_id": conversation_data.get("initialQueueId"),
            "status": conversation_data.get("status", "active"),
            "last_message_at": datetime.utcnow().isoformat(),
            "last_message_direction": "outbound",
            "total_messages": 0,
            "has_reply": False,
            "notes": conversation_data.get("notes"),
            "tags": conversation_data.get("tags", [])
        }

        # Add team_id if provided
        if team_id:
            insert_data["team_id"] = team_id

        result = client.table("conversations").insert(insert_data).execute()

        return transform_conversation(result.data[0]) if result.data else None
    except Exception as e:
        logger.error(f"Error creating conversation: {e}")
        return None


async def get_conversations(filters: Dict[str, Any] = None, team_id: Optional[str] = None) -> List[Dict[str, Any]]:
    """Get conversations with filters"""
    client = get_client()
    if not client:
        return []

    filters = filters or {}

    try:
        query = client.table("conversations").select(
            "*, reddit_accounts(id, username, status), "
            "dm_history!initial_dm_id(post_url, post_title, subreddit), "
            "dm_queue!initial_queue_id(post_url, post_title, subreddit)"
        ).order("last_message_at", desc=True)

        # Filter by team_id (required for multi-tenancy)
        if team_id:
            query = query.eq("team_id", team_id)

        if filters.get("status"):
            status = filters["status"]
            if isinstance(status, list):
                query = query.in_("status", status)
            else:
                query = query.eq("status", status)

        if "hasReply" in filters and filters["hasReply"] is not None:
            query = query.eq("has_reply", filters["hasReply"])

        if filters.get("accountId"):
            query = query.eq("account_id", filters["accountId"])

        if filters.get("participantUsername"):
            query = query.ilike("participant_username", f"%{filters['participantUsername']}%")

        limit = filters.get("limit", 50)
        offset = filters.get("offset", 0)

        if offset:
            query = query.range(offset, offset + limit - 1)
        else:
            query = query.limit(limit)

        result = query.execute()
        return [transform_conversation(row) for row in result.data] if result.data else []
    except Exception as e:
        logger.error(f"Error fetching conversations: {e}")
        return []


async def get_conversation(conversation_id: str, team_id: Optional[str] = None) -> Optional[Dict[str, Any]]:
    """Get a single conversation by ID with messages"""
    client = get_client()
    if not client:
        return None

    try:
        # Get conversation
        conv_query = client.table("conversations").select(
            "*, reddit_accounts(id, username, status), "
            "dm_history!initial_dm_id(post_url, post_title, subreddit), "
            "dm_queue!initial_queue_id(post_url, post_title, subreddit)"
        ).eq("id", conversation_id)
        if team_id:
            conv_query = conv_query.eq("team_id", team_id)
        conv_result = conv_query.execute()

        if not conv_result.data:
            return None

        conversation = transform_conversation(conv_result.data[0])

        # Fetch messages (include NULL team_id to recover orphaned sync messages)
        msg_query = client.table("messages").select("*").eq(
            "conversation_id", conversation_id
        )
        if team_id:
            msg_query = msg_query.or_(f"team_id.eq.{team_id},team_id.is.null")
        msg_query = msg_query.order("sent_at")
        msg_result = msg_query.execute()

        messages = [transform_message(row) for row in msg_result.data] if msg_result.data else []

        # Override totalMessages with actual count (the stored counter can drift)
        conversation["totalMessages"] = len(messages)

        return {**conversation, "messages": messages}
    except Exception as e:
        logger.error(f"Error fetching conversation: {e}")
        return None


async def get_conversation_by_participant(username: str, team_id: Optional[str] = None, account_id: Optional[str] = None) -> Optional[Dict[str, Any]]:
    """Get conversation by participant username, optionally scoped to a specific account"""
    client = get_client()
    if not client:
        return None

    try:
        query = client.table("conversations").select("*").eq(
            "participant_username", username.lower()
        )
        if team_id:
            query = query.eq("team_id", team_id)
        if account_id:
            query = query.eq("account_id", account_id)
        result = query.order("created_at", desc=True).limit(1).execute()

        return transform_conversation(result.data[0]) if result.data else None
    except Exception as e:
        if "PGRST116" not in str(e):
            logger.error(f"Error fetching conversation: {e}")
        return None


async def update_conversation(conversation_id: str, updates: Dict[str, Any], team_id: Optional[str] = None) -> Optional[Dict[str, Any]]:
    """Update a conversation"""
    client = get_client()
    if not client:
        return None

    try:
        update_data = {"updated_at": datetime.utcnow().isoformat()}

        if "status" in updates:
            update_data["status"] = updates["status"]
        if "notes" in updates:
            update_data["notes"] = updates["notes"]
        if "tags" in updates:
            update_data["tags"] = updates["tags"]
        if "hasReply" in updates:
            update_data["has_reply"] = updates["hasReply"]
        if "lastMessageAt" in updates:
            update_data["last_message_at"] = updates["lastMessageAt"]
        if "lastMessageDirection" in updates:
            update_data["last_message_direction"] = updates["lastMessageDirection"]
        if "totalMessages" in updates:
            update_data["total_messages"] = updates["totalMessages"]
        if "accountId" in updates:
            update_data["account_id"] = updates["accountId"]

        query = client.table("conversations").update(update_data).eq(
            "id", conversation_id
        )
        if team_id:
            query = query.eq("team_id", team_id)
        result = query.execute()

        return transform_conversation(result.data[0]) if result.data else None
    except Exception as e:
        logger.error(f"Error updating conversation: {e}")
        return None


async def add_message(message_data: Dict[str, Any], team_id: Optional[str] = None) -> Optional[Dict[str, Any]]:
    """Add a message to a conversation (with fingerprint-based deduplication)"""
    client = get_client()
    if not client:
        return None

    try:
        conversation_id = message_data.get("conversationId")
        direction = message_data.get("direction")
        content = message_data.get("content", "")
        sent_at = message_data.get("sentAt") or datetime.utcnow().isoformat()

        # Verify conversation belongs to this team
        if team_id and conversation_id:
            ownership_check = client.table("conversations").select("id").eq(
                "id", conversation_id
            ).eq("team_id", team_id).limit(1).execute()
            if not ownership_check.data:
                logger.warning(f"Conversation {conversation_id} not found for team {team_id}")
                return None

        # If no team_id provided, inherit from the parent conversation
        if not team_id and conversation_id:
            conv_lookup = client.table("conversations").select("team_id").eq(
                "id", conversation_id
            ).limit(1).execute()
            if conv_lookup.data and conv_lookup.data[0].get("team_id"):
                team_id = conv_lookup.data[0]["team_id"]

        # Compute fingerprint for deduplication
        fingerprint = create_message_fingerprint(content, direction, sent_at)

        insert_data = {
            "conversation_id": conversation_id,
            "direction": direction,
            "content": content,
            "sent_at": sent_at,
            "is_ai_generated": message_data.get("isAiGenerated", False),
            "fingerprint": fingerprint
        }
        if team_id:
            insert_data["team_id"] = team_id

        # Use upsert with the unique (conversation_id, fingerprint) constraint
        # to silently skip duplicates from concurrent syncs
        msg_result = None
        try:
            msg_result = client.table("messages").upsert(
                insert_data,
                on_conflict="conversation_id,fingerprint"
            ).execute()
        except Exception as upsert_err:
            logger.warning(f"Upsert failed (fingerprint dedup), falling back to insert: {upsert_err}")
            # Fallback: insert without fingerprint (migration 011 may not be applied)
            insert_data.pop("fingerprint", None)
            try:
                msg_result = client.table("messages").insert(insert_data).execute()
            except Exception as insert_err:
                logger.error(f"Insert fallback also failed: {insert_err}")
                return None

        if not msg_result or not msg_result.data:
            return None

        # Update conversation stats
        conv_update = {
            "last_message_at": sent_at,
            "last_message_direction": direction,
            "updated_at": datetime.utcnow().isoformat()
        }
        if direction == "inbound":
            conv_update["has_reply"] = True

        conv_stats_query = client.table("conversations").update(conv_update).eq("id", conversation_id)
        if team_id:
            conv_stats_query = conv_stats_query.eq("team_id", team_id)
        conv_stats_query.execute()

        return transform_message(msg_result.data[0])
    except Exception as e:
        logger.error(f"Error adding message: {e}")
        return None


async def get_messages(conversation_id: str, options: Dict[str, Any] = None, team_id: Optional[str] = None) -> List[Dict[str, Any]]:
    """Get messages for a conversation"""
    client = get_client()
    if not client:
        return []

    options = options or {}

    try:
        ascending = options.get("ascending", True)
        query = client.table("messages").select("*").eq(
            "conversation_id", conversation_id
        )
        if team_id:
            query = query.eq("team_id", team_id)
        query = query.order("sent_at", desc=not ascending)

        if options.get("limit"):
            query = query.limit(options["limit"])

        result = query.execute()
        return [transform_message(row) for row in result.data] if result.data else []
    except Exception as e:
        logger.error(f"Error fetching messages: {e}")
        return []


async def sync_conversation(sync_data: Dict[str, Any], team_id: Optional[str] = None) -> Optional[Dict[str, Any]]:
    """
    Sync a conversation from Reddit chat data.
    Uses content-based deduplication to handle:
    - Partial syncs (missing messages from DOM)
    - Reordered messages
    - Repeated syncs (idempotency)
    """
    participant_username = sync_data.get("participantUsername")
    reddit_conversation_id = sync_data.get("redditConversationId")
    messages = sync_data.get("messages", [])
    account_id = sync_data.get("accountId")
    account_username = sync_data.get("accountUsername")

    if not participant_username:
        logger.warning("Missing participant username for sync")
        return None

    # Guard: participant must not be the same as the sending account
    # This happens when the extension's getCurrentUsername() fails and
    # the logged-in user's own name gets detected as the chat "participant"
    if account_username and participant_username.lower() == account_username.lower():
        logger.info(f"Skipping sync: participant '{participant_username}' is the same as account '{account_username}'")
        return None

    # If we have a username but no account_id, try to resolve or auto-create
    if not account_id and account_username:
        client = get_client()
        if client:
            try:
                acct_result = client.table("reddit_accounts").select("id").ilike(
                    "username", account_username
                )
                if team_id:
                    acct_result = acct_result.eq("team_id", team_id)
                acct_result = acct_result.limit(1).execute()
                if acct_result.data:
                    account_id = acct_result.data[0]["id"]
                    logger.info(f"Resolved account '{account_username}' to id {account_id}")
                else:
                    # Auto-create the Reddit account
                    new_account = {
                        "username": account_username,
                        "status": "active",
                        "warmup_mode": False,
                    }
                    if team_id:
                        new_account["team_id"] = team_id
                    create_result = client.table("reddit_accounts").insert(new_account).execute()
                    if create_result.data:
                        account_id = create_result.data[0]["id"]
                        logger.info(f"Auto-created account '{account_username}' with id {account_id}")
            except Exception as e:
                logger.error(f"Failed to resolve/create account by username: {e}")

    # Get or create conversation
    # First try scoped to the specific account
    conversation = await get_conversation_by_participant(participant_username, team_id=team_id, account_id=account_id) if account_id else None

    if not conversation:
        # Fall back to finding any conversation with this participant (handles pre-existing NULL account_id)
        conversation = await get_conversation_by_participant(participant_username, team_id=team_id)

    if conversation and account_id and not conversation.get("accountId"):
        # Backfill account_id on existing conversation that had none
        await update_conversation(conversation["id"], {"accountId": account_id}, team_id=team_id)
        conversation["accountId"] = account_id

    # Inherit team_id from existing conversation if not provided in request
    if not team_id and conversation and conversation.get("teamId"):
        team_id = conversation["teamId"]

    if not conversation:
        conversation = await create_conversation({
            "participantUsername": participant_username,
            "redditConversationId": reddit_conversation_id,
            "accountId": account_id
        }, team_id=team_id)
        if not conversation:
            return None

    # Early exit if no messages to sync
    if not messages:
        conv = await get_conversation(conversation["id"], team_id=team_id)
        if conv:
            conv["_syncMeta"] = {
                "addedCount": 0,
                "receivedCount": 0,
                "existingCount": 0,
                "alreadySynced": True
            }
        return conv

    # Build fingerprint set of existing messages
    existing_messages = await get_messages(conversation["id"], team_id=team_id)
    existing_fingerprints: Set[str] = set()

    for msg in existing_messages:
        fp = create_message_fingerprint(
            msg.get("content", ""),
            msg.get("direction", ""),
            msg.get("sentAt")
        )
        existing_fingerprints.add(fp)

    # Identify and add new messages
    added_count = 0

    for msg in messages:
        content = (msg.get("content") or "").strip()
        direction = msg.get("direction", "")
        sent_at = msg.get("sentAt")

        # Skip empty messages
        if not content:
            continue

        # Check fingerprint
        fingerprint = create_message_fingerprint(content, direction, sent_at)

        if fingerprint in existing_fingerprints:
            continue  # Already exists, skip

        # Mark as seen (prevent duplicates within same sync batch)
        existing_fingerprints.add(fingerprint)

        # Add new message
        result = await add_message({
            "conversationId": conversation["id"],
            "direction": direction,
            "content": content,
            "sentAt": sent_at,
            "isAiGenerated": msg.get("isAiGenerated", False)
        }, team_id=team_id)

        if result:
            added_count += 1

    logger.info(f"Sync for {participant_username}: {added_count} new messages added (received {len(messages)}, existing {len(existing_messages)})")

    # Update total_messages to match actual count
    if added_count > 0:
        all_messages = await get_messages(conversation["id"], team_id=team_id)
        await update_conversation(conversation["id"], {
            "totalMessages": len(all_messages)
        }, team_id=team_id)

    # Return updated conversation with sync metadata
    conv = await get_conversation(conversation["id"], team_id=team_id)
    if conv:
        conv["_syncMeta"] = {
            "addedCount": added_count,
            "receivedCount": len(messages),
            "existingCount": len(existing_messages),
            "alreadySynced": added_count == 0 and len(messages) > 0
        }
    return conv


async def get_conversation_stats(team_id: Optional[str] = None) -> Dict[str, Any]:
    """Get conversation statistics for a team"""
    client = get_client()
    if not client:
        return {
            "total": 0,
            "active": 0,
            "interested": 0,
            "cold": 0,
            "closed": 0,
            "converted": 0,
            "withReplies": 0
        }

    try:
        query = client.table("conversations").select("status, has_reply")

        # Filter by team_id
        if team_id:
            query = query.eq("team_id", team_id)

        result = query.execute()

        if not result.data:
            return {
                "total": 0,
                "active": 0,
                "interested": 0,
                "cold": 0,
                "closed": 0,
                "converted": 0,
                "withReplies": 0,
                "replyRate": 0
            }

        data = result.data
        total = len(data)
        with_replies = len([c for c in data if c.get("has_reply")])

        return {
            "total": total,
            "active": len([c for c in data if c.get("status") == "active"]),
            "interested": len([c for c in data if c.get("status") == "interested"]),
            "cold": len([c for c in data if c.get("status") == "cold"]),
            "closed": len([c for c in data if c.get("status") == "closed"]),
            "converted": len([c for c in data if c.get("status") == "converted"]),
            "withReplies": with_replies,
            "replyRate": round((with_replies / total) * 100) if total > 0 else 0
        }
    except Exception as e:
        logger.error(f"Error fetching conversation stats: {e}")
        return {}


async def search_conversations(query: str, team_id: Optional[str] = None) -> List[Dict[str, Any]]:
    """Search conversations"""
    client = get_client()
    if not client:
        return []

    try:
        search_query = client.table("conversations").select("*").ilike(
            "participant_username", f"%{query}%"
        )
        if team_id:
            search_query = search_query.eq("team_id", team_id)
        result = search_query.order("last_message_at", desc=True).limit(20).execute()

        return [transform_conversation(row) for row in result.data] if result.data else []
    except Exception as e:
        logger.error(f"Error searching conversations: {e}")
        return []
