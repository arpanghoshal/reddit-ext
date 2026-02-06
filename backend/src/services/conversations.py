"""
Conversations Service
Manages conversation threads and messages for the inbox
"""

import os
import hashlib
from datetime import datetime
from typing import Dict, Any, List, Optional, Set
from supabase import create_client, Client

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

    return {
        "id": row.get("id"),
        "redditConversationId": row.get("reddit_conversation_id"),
        "participantUsername": row.get("participant_username"),
        "accountId": row.get("account_id"),
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
        "updatedAt": row.get("updated_at")
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
    Uses content + direction only (no timestamp) since frontend timestamps are unreliable.
    This means the same exact message can only appear once per conversation.
    """
    normalized_content = " ".join((content or "").lower().strip().split())
    composite = f"{normalized_content}|{direction}"
    return hashlib.sha256(composite.encode('utf-8')).hexdigest()[:16]


async def create_conversation(conversation_data: Dict[str, Any], team_id: Optional[str] = None) -> Optional[Dict[str, Any]]:
    """Create a new conversation"""
    client = get_client()
    if not client:
        print("Supabase not configured")
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
        print(f"Error creating conversation: {e}")
        return None


async def get_conversations(filters: Dict[str, Any] = None, team_id: Optional[str] = None) -> List[Dict[str, Any]]:
    """Get conversations with filters"""
    client = get_client()
    if not client:
        return []

    filters = filters or {}

    try:
        query = client.table("conversations").select("*").order("last_message_at", desc=True)

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
        print(f"Error fetching conversations: {e}")
        return []


async def get_conversation(conversation_id: str, team_id: Optional[str] = None) -> Optional[Dict[str, Any]]:
    """Get a single conversation by ID with messages"""
    client = get_client()
    if not client:
        return None

    try:
        # Get conversation
        conv_query = client.table("conversations").select("*").eq("id", conversation_id)
        if team_id:
            conv_query = conv_query.eq("team_id", team_id)
        conv_result = conv_query.execute()

        if not conv_result.data:
            return None

        conversation = transform_conversation(conv_result.data[0])

        # Fetch messages
        msg_query = client.table("messages").select("*").eq(
            "conversation_id", conversation_id
        ).order("sent_at")
        msg_result = msg_query.execute()

        messages = [transform_message(row) for row in msg_result.data] if msg_result.data else []

        return {**conversation, "messages": messages}
    except Exception as e:
        print(f"Error fetching conversation: {e}")
        return None


async def get_conversation_by_participant(username: str, team_id: Optional[str] = None) -> Optional[Dict[str, Any]]:
    """Get conversation by participant username"""
    client = get_client()
    if not client:
        return None

    try:
        query = client.table("conversations").select("*").eq(
            "participant_username", username.lower()
        )
        if team_id:
            query = query.eq("team_id", team_id)
        result = query.order("created_at", desc=True).limit(1).execute()

        return transform_conversation(result.data[0]) if result.data else None
    except Exception as e:
        if "PGRST116" not in str(e):
            print(f"Error fetching conversation: {e}")
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

        query = client.table("conversations").update(update_data).eq(
            "id", conversation_id
        )
        if team_id:
            query = query.eq("team_id", team_id)
        result = query.execute()

        return transform_conversation(result.data[0]) if result.data else None
    except Exception as e:
        print(f"Error updating conversation: {e}")
        return None


async def add_message(message_data: Dict[str, Any], team_id: Optional[str] = None) -> Optional[Dict[str, Any]]:
    """Add a message to a conversation"""
    client = get_client()
    if not client:
        return None

    try:
        conversation_id = message_data.get("conversationId")
        direction = message_data.get("direction")
        sent_at = message_data.get("sentAt") or datetime.utcnow().isoformat()

        # Insert message
        msg_result = client.table("messages").insert({
            "conversation_id": conversation_id,
            "direction": direction,
            "content": message_data.get("content"),
            "sent_at": sent_at,
            "is_ai_generated": message_data.get("isAiGenerated", False)
        }).execute()

        if not msg_result.data:
            return None

        # Update conversation stats atomically (without reading total_messages first)
        conv_update = {
            "last_message_at": sent_at,
            "last_message_direction": direction,
            "updated_at": datetime.utcnow().isoformat()
        }
        if direction == "inbound":
            conv_update["has_reply"] = True

        client.table("conversations").update(conv_update).eq("id", conversation_id).execute()

        return transform_message(msg_result.data[0])
    except Exception as e:
        print(f"Error adding message: {e}")
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
        ).order("sent_at", desc=not ascending)

        if options.get("limit"):
            query = query.limit(options["limit"])

        result = query.execute()
        return [transform_message(row) for row in result.data] if result.data else []
    except Exception as e:
        print(f"Error fetching messages: {e}")
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

    if not participant_username:
        print("Missing participant username")
        return None

    # Get or create conversation
    conversation = await get_conversation_by_participant(participant_username, team_id=team_id)

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
        return await get_conversation(conversation["id"], team_id=team_id)

    # Build fingerprint set of existing messages
    existing_messages = await get_messages(conversation["id"])
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

    print(f"Sync for {participant_username}: {added_count} new messages added "
          f"(received {len(messages)}, existing {len(existing_messages)})")

    # Return updated conversation
    return await get_conversation(conversation["id"], team_id=team_id)


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
        print(f"Error fetching conversation stats: {e}")
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
        print(f"Error searching conversations: {e}")
        return []
