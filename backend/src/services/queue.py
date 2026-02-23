"""
DM Queue Service
Manages the queue of pending, approved, and sent DMs
"""

import os
import logging
from datetime import datetime, timedelta
from typing import Dict, Any, List, Optional
from supabase import create_client, Client

logger = logging.getLogger(__name__)

_supabase: Optional[Client] = None


def get_client() -> Optional[Client]:
    """Get or create Supabase client"""
    global _supabase
    if _supabase is None:
        url = os.getenv("SUPABASE_URL")
        key = os.getenv("SUPABASE_KEY")
        if url and key:
            _supabase = create_client(url, key)
    return _supabase


def transform_queue_item(row: Optional[Dict[str, Any]]) -> Optional[Dict[str, Any]]:
    """Transform database row to API format"""
    if not row:
        return None

    account = row.get("reddit_accounts")
    return {
        "id": row.get("id"),
        "accountId": row.get("account_id"),
        "accountUsername": account.get("username") if account else None,
        "recipientUsername": row.get("recipient_username"),
        "subreddit": row.get("subreddit"),
        "postUrl": row.get("post_url"),
        "postTitle": row.get("post_title"),
        "postBody": row.get("post_body"),
        "classificationId": row.get("classification_id"),
        "classificationScore": row.get("classification_score"),
        "classificationCategory": row.get("classification_category"),
        "generatedMessage": row.get("generated_message"),
        "editedMessage": row.get("edited_message"),
        "finalMessage": row.get("edited_message") or row.get("generated_message"),
        "status": row.get("status"),
        "queueMode": row.get("queue_mode"),
        "messageType": row.get("message_type", "outreach"),
        "conversationId": row.get("conversation_id"),
        "scheduledAt": row.get("scheduled_at"),
        "approvedAt": row.get("approved_at"),
        "approvedBy": row.get("approved_by"),
        "sentAt": row.get("sent_at"),
        "failedReason": row.get("failed_reason"),
        "retryCount": row.get("retry_count"),
        "createdAt": row.get("created_at"),
        "updatedAt": row.get("updated_at")
    }


async def add_to_queue(item: Dict[str, Any], team_id: Optional[str] = None) -> Optional[Dict[str, Any]]:
    """Add item to queue"""
    client = get_client()
    if not client:
        logger.warning("Supabase not configured - cannot add to queue")
        return None

    # Dedup check: block if recipient was already contacted (skip for replies)
    message_type = item.get("messageType", "outreach")
    recipient = (item.get("recipientUsername") or "").lower().strip()
    if message_type != "reply" and team_id and recipient:
        from . import dedup
        check = await dedup.has_been_contacted(recipient, team_id)
        if check.get("contacted"):
            logger.info(f"Blocked duplicate queue add for u/{recipient} (source: {check.get('source')})")
            return {
                "error": "duplicate_recipient",
                "message": f"User u/{recipient} has already been contacted",
                "source": check.get("source"),
            }

    try:
        insert_data = {
            "account_id": item.get("accountId"),
            "recipient_username": item.get("recipientUsername"),
            "subreddit": item.get("subreddit"),
            "post_url": item.get("postUrl"),
            "post_title": item.get("postTitle"),
            "post_body": item.get("postBody"),
            "classification_id": item.get("classificationId"),
            "classification_score": item.get("classificationScore"),
            "classification_category": item.get("classificationCategory"),
            "generated_message": item.get("generatedMessage"),
            "edited_message": item.get("editedMessage"),
            "status": item.get("status", "pending"),
            "queue_mode": item.get("queueMode", "review"),
            "message_type": item.get("messageType", "outreach"),
            "scheduled_at": item.get("scheduledAt")
        }

        # Add team_id if provided
        if team_id:
            insert_data["team_id"] = team_id

        # Add conversation_id if provided (for reply messages)
        if item.get("conversationId"):
            insert_data["conversation_id"] = item.get("conversationId")

        result = client.table("dm_queue").insert(insert_data).execute()

        # Record contact for dedup (outreach only)
        if result.data and message_type != "reply" and team_id and recipient:
            from . import dedup
            await dedup.record_contact(
                recipient, team_id,
                source="dm_queue",
                account_id=item.get("accountId"),
            )

        return transform_queue_item(result.data[0]) if result.data else None
    except Exception as e:
        logger.error(f"Error adding to queue: {e}")
        return None


async def get_queue(filters: Dict[str, Any] = None, team_id: Optional[str] = None) -> List[Dict[str, Any]]:
    """Get queue items with filters"""
    client = get_client()
    if not client:
        return []

    filters = filters or {}

    try:
        query = client.table("dm_queue").select("*, reddit_accounts(id, username)").order("created_at", desc=True)

        # Filter by team_id (required for multi-tenancy)
        if team_id:
            query = query.eq("team_id", team_id)

        # Apply filters
        if filters.get("status"):
            status = filters["status"]
            if isinstance(status, list):
                query = query.in_("status", status)
            else:
                query = query.eq("status", status)

        if filters.get("accountId"):
            query = query.eq("account_id", filters["accountId"])

        if filters.get("subreddit"):
            query = query.eq("subreddit", filters["subreddit"])

        if filters.get("queueMode"):
            query = query.eq("queue_mode", filters["queueMode"])

        if filters.get("minScore"):
            query = query.gte("classification_score", filters["minScore"])

        # Filter by message type (outreach or reply)
        if filters.get("messageType"):
            query = query.eq("message_type", filters["messageType"])

        # Filter by conversation ID (for replies)
        if filters.get("conversationId"):
            query = query.eq("conversation_id", filters["conversationId"])

        limit = filters.get("limit", 50)
        offset = filters.get("offset", 0)

        if offset:
            query = query.range(offset, offset + limit - 1)
        else:
            query = query.limit(limit)

        result = query.execute()
        return [transform_queue_item(row) for row in result.data] if result.data else []
    except Exception as e:
        logger.error(f"Error fetching queue: {e}")
        return []


async def get_queue_item(item_id: str, team_id: Optional[str] = None) -> Optional[Dict[str, Any]]:
    """Get a single queue item by ID"""
    client = get_client()
    if not client:
        return None

    try:
        query = client.table("dm_queue").select("*").eq("id", item_id)
        if team_id:
            query = query.eq("team_id", team_id)
        result = query.execute()
        return transform_queue_item(result.data[0]) if result.data else None
    except Exception as e:
        logger.error(f"Error fetching queue item: {e}")
        return None


async def update_queue_item(item_id: str, updates: Dict[str, Any], team_id: Optional[str] = None) -> Optional[Dict[str, Any]]:
    """Update a queue item"""
    client = get_client()
    if not client:
        return None

    try:
        update_data = {"updated_at": datetime.utcnow().isoformat()}

        if "editedMessage" in updates:
            update_data["edited_message"] = updates["editedMessage"]
        if "status" in updates:
            update_data["status"] = updates["status"]
        if "accountId" in updates:
            update_data["account_id"] = updates["accountId"]
        if "scheduledAt" in updates:
            update_data["scheduled_at"] = updates["scheduledAt"]

        query = client.table("dm_queue").update(update_data).eq("id", item_id)
        if team_id:
            query = query.eq("team_id", team_id)
        result = query.execute()
        return transform_queue_item(result.data[0]) if result.data else None
    except Exception as e:
        logger.error(f"Error updating queue item: {e}")
        return None


async def delete_queue_item(item_id: str, team_id: Optional[str] = None) -> bool:
    """Delete a queue item"""
    client = get_client()
    if not client:
        return False

    try:
        query = client.table("dm_queue").delete().eq("id", item_id)
        if team_id:
            query = query.eq("team_id", team_id)
        query.execute()
        return True
    except Exception as e:
        logger.error(f"Error deleting queue item: {e}")
        return False


async def approve_queue_item(item_id: str, approved_by: Optional[str] = None, team_id: Optional[str] = None) -> Optional[Dict[str, Any]]:
    """Approve a queue item"""
    client = get_client()
    if not client:
        return None

    try:
        query = client.table("dm_queue").update({
            "status": "approved",
            "approved_at": datetime.utcnow().isoformat(),
            "approved_by": approved_by,
            "updated_at": datetime.utcnow().isoformat()
        }).eq("id", item_id).eq("status", "pending")
        if team_id:
            query = query.eq("team_id", team_id)
        result = query.execute()

        return transform_queue_item(result.data[0]) if result.data else None
    except Exception as e:
        logger.error(f"Error approving queue item: {e}")
        return None


async def reject_queue_item(item_id: str, reason: Optional[str] = None, team_id: Optional[str] = None) -> Optional[Dict[str, Any]]:
    """Reject a queue item (works on both pending and approved items)"""
    client = get_client()
    if not client:
        return None

    try:
        query = client.table("dm_queue").update({
            "status": "rejected",
            "failed_reason": reason,
            "updated_at": datetime.utcnow().isoformat()
        }).eq("id", item_id).in_("status", ["pending", "approved"])
        if team_id:
            query = query.eq("team_id", team_id)
        result = query.execute()

        return transform_queue_item(result.data[0]) if result.data else None
    except Exception as e:
        logger.error(f"Error rejecting queue item: {e}")
        return None


async def bulk_approve(ids: List[str], approved_by: Optional[str] = None, team_id: Optional[str] = None) -> Dict[str, int]:
    """Bulk approve queue items"""
    client = get_client()
    if not client:
        return {"success": 0, "failed": len(ids)}

    try:
        query = client.table("dm_queue").update({
            "status": "approved",
            "approved_at": datetime.utcnow().isoformat(),
            "approved_by": approved_by,
            "updated_at": datetime.utcnow().isoformat()
        }).in_("id", ids).eq("status", "pending")
        if team_id:
            query = query.eq("team_id", team_id)
        result = query.execute()

        success_count = len(result.data) if result.data else 0
        return {"success": success_count, "failed": len(ids) - success_count}
    except Exception as e:
        logger.error(f"Error bulk approving: {e}")
        return {"success": 0, "failed": len(ids)}


async def bulk_reject(ids: List[str], reason: Optional[str] = None, team_id: Optional[str] = None) -> Dict[str, int]:
    """Bulk reject queue items"""
    client = get_client()
    if not client:
        return {"success": 0, "failed": len(ids)}

    try:
        query = client.table("dm_queue").update({
            "status": "rejected",
            "failed_reason": reason,
            "updated_at": datetime.utcnow().isoformat()
        }).in_("id", ids).in_("status", ["pending", "approved"])
        if team_id:
            query = query.eq("team_id", team_id)
        result = query.execute()

        success_count = len(result.data) if result.data else 0
        return {"success": success_count, "failed": len(ids) - success_count}
    except Exception as e:
        logger.error(f"Error bulk rejecting: {e}")
        return {"success": 0, "failed": len(ids)}


async def get_next_to_send(account_id: Optional[str] = None, message_type: Optional[str] = None, team_id: Optional[str] = None) -> Optional[Dict[str, Any]]:
    """Get the next approved item to send"""
    client = get_client()
    if not client:
        return None

    try:
        query = client.table("dm_queue").select("*").eq(
            "status", "approved"
        ).order("approved_at").limit(1)

        # Filter by team_id
        if team_id:
            query = query.eq("team_id", team_id)

        if account_id:
            query = query.eq("account_id", account_id)

        if message_type:
            query = query.eq("message_type", message_type)

        result = query.execute()
        return transform_queue_item(result.data[0]) if result.data else None
    except Exception as e:
        # PGRST116 = no rows found
        if "PGRST116" not in str(e):
            logger.error(f"Error getting next to send: {e}")
        return None


async def get_next_reply_to_send(account_id: Optional[str] = None, team_id: Optional[str] = None) -> Optional[Dict[str, Any]]:
    """Get the next approved reply to send"""
    return await get_next_to_send(account_id=account_id, message_type="reply", team_id=team_id)


async def mark_as_sent(item_id: str, team_id: Optional[str] = None) -> Optional[Dict[str, Any]]:
    """Mark item as sent"""
    client = get_client()
    if not client:
        return None

    try:
        query = client.table("dm_queue").update({
            "status": "sent",
            "sent_at": datetime.utcnow().isoformat(),
            "updated_at": datetime.utcnow().isoformat()
        }).eq("id", item_id)
        if team_id:
            query = query.eq("team_id", team_id)
        result = query.execute()

        # Record contact for dedup (ensures coverage for items queued before this change)
        if result.data and team_id:
            row = result.data[0]
            recipient = (row.get("recipient_username") or "").lower().strip()
            msg_type = row.get("message_type", "outreach")
            if recipient and msg_type != "reply":
                from . import dedup
                await dedup.record_contact(
                    recipient, team_id,
                    source="dm_queue",
                    account_id=row.get("account_id"),
                )

        return transform_queue_item(result.data[0]) if result.data else None
    except Exception as e:
        logger.error(f"Error marking as sent: {e}")
        return None


async def mark_as_failed(item_id: str, reason: str, team_id: Optional[str] = None) -> Optional[Dict[str, Any]]:
    """Mark item as failed"""
    client = get_client()
    if not client:
        return None

    try:
        # Set status to failed directly without reading retry_count first
        # to avoid race condition. The retry_count is kept for informational
        # purposes but not critical for correctness.
        query = client.table("dm_queue").update({
            "status": "failed",
            "failed_reason": reason,
            "updated_at": datetime.utcnow().isoformat()
        }).eq("id", item_id)
        if team_id:
            query = query.eq("team_id", team_id)
        result = query.execute()

        return transform_queue_item(result.data[0]) if result.data else None
    except Exception as e:
        logger.error(f"Error marking as failed: {e}")
        return None


async def get_queue_stats(message_type: Optional[str] = None, team_id: Optional[str] = None) -> Dict[str, int]:
    """Get queue statistics, optionally filtered by message type and team"""
    client = get_client()
    if not client:
        return {"pending": 0, "approved": 0, "sent": 0, "failed": 0, "rejected": 0}

    try:
        seven_days_ago = (datetime.utcnow() - timedelta(days=7)).isoformat()
        query = client.table("dm_queue").select("status").gte(
            "created_at", seven_days_ago
        )

        # Filter by team_id
        if team_id:
            query = query.eq("team_id", team_id)

        if message_type:
            query = query.eq("message_type", message_type)

        result = query.execute()

        if not result.data:
            return {"pending": 0, "approved": 0, "sent": 0, "failed": 0, "rejected": 0}

        data = result.data
        return {
            "pending": len([d for d in data if d.get("status") == "pending"]),
            "approved": len([d for d in data if d.get("status") == "approved"]),
            "sent": len([d for d in data if d.get("status") == "sent"]),
            "failed": len([d for d in data if d.get("status") == "failed"]),
            "rejected": len([d for d in data if d.get("status") == "rejected"]),
            "total": len(data)
        }
    except Exception as e:
        logger.error(f"Error fetching queue stats: {e}")
        return {"pending": 0, "approved": 0, "sent": 0, "failed": 0, "rejected": 0}


async def get_pending_reply_for_conversation(conversation_id: str, team_id: Optional[str] = None) -> Optional[Dict[str, Any]]:
    """Check if a conversation has a pending or approved reply in queue"""
    client = get_client()
    if not client:
        return None

    try:
        query = client.table("dm_queue").select("*").eq(
            "conversation_id", conversation_id
        ).eq(
            "message_type", "reply"
        ).in_(
            "status", ["pending", "approved"]
        )
        if team_id:
            query = query.eq("team_id", team_id)
        result = query.order("created_at", desc=True).limit(1).execute()

        return transform_queue_item(result.data[0]) if result.data else None
    except Exception as e:
        logger.error(f"Error checking pending reply: {e}")
        return None
