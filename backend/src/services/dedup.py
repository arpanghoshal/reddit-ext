"""
Deduplication Service
Prevents messaging the same person twice across all accounts in a team.
"""

import logging
from typing import Optional, Dict, Any, List
from .supabase_service import get_client

logger = logging.getLogger(__name__)


async def has_been_contacted(recipient_username: str, team_id: str) -> Dict[str, Any]:
    """
    Check if a recipient has EVER been contacted by ANY account in this team.

    Checks (in order):
    1. contacted_recipients table (fast, indexed)
    2. dm_queue (pending/approved/sent items)
    3. dm_history (confirmed sends)
    4. conversations (established contact)

    Returns:
        {"contacted": bool, "source": str|None, "details": dict|None}
    """
    if not recipient_username or not team_id:
        return {"contacted": False}

    client = get_client()
    if not client:
        return {"contacted": False, "reason": "no_database"}

    username = recipient_username.lower().strip()

    try:
        # 1. Check contacted_recipients table first (fastest - has unique index)
        result = client.table("contacted_recipients").select(
            "id, first_contact_source, first_contact_account_id, first_contacted_at"
        ).eq("team_id", team_id).eq(
            "recipient_username", username
        ).limit(1).execute()

        if result.data:
            row = result.data[0]
            return {
                "contacted": True,
                "source": "contacted_recipients",
                "details": {
                    "first_contact_source": row.get("first_contact_source"),
                    "account_id": row.get("first_contact_account_id"),
                    "contacted_at": row.get("first_contacted_at"),
                }
            }

        # 2. Fallback: check dm_queue (pending, approved, or sent)
        result = client.table("dm_queue").select(
            "id, account_id, status, sent_at"
        ).eq("team_id", team_id).eq(
            "recipient_username", username
        ).in_("status", ["pending", "approved", "sent"]).limit(1).execute()

        if result.data:
            row = result.data[0]
            return {
                "contacted": True,
                "source": "dm_queue",
                "details": {
                    "account_id": row.get("account_id"),
                    "status": row.get("status"),
                    "sent_at": row.get("sent_at"),
                }
            }

        # 3. Fallback: check dm_history (confirmed sends)
        result = client.table("dm_history").select(
            "id, account_id, created_at"
        ).eq("team_id", team_id).eq(
            "recipient_username", username
        ).limit(1).execute()

        if result.data:
            row = result.data[0]
            return {
                "contacted": True,
                "source": "dm_history",
                "details": {
                    "account_id": row.get("account_id"),
                    "contacted_at": row.get("created_at"),
                }
            }

        # 4. Fallback: check conversations
        result = client.table("conversations").select(
            "id, account_id, created_at"
        ).eq("team_id", team_id).eq(
            "participant_username", username
        ).limit(1).execute()

        if result.data:
            row = result.data[0]
            return {
                "contacted": True,
                "source": "conversations",
                "details": {
                    "account_id": row.get("account_id"),
                    "contacted_at": row.get("created_at"),
                }
            }

        return {"contacted": False}

    except Exception as e:
        logger.warning(f"Error checking if {username} was contacted: {e}")
        return {"contacted": False, "error": str(e)}


async def record_contact(
    recipient_username: str,
    team_id: str,
    source: str = "dm_queue",
    account_id: Optional[str] = None,
):
    """
    Record that a recipient has been contacted. Uses upsert to handle races.
    Should be called after a message is queued or sent.
    """
    if not recipient_username or not team_id:
        return

    client = get_client()
    if not client:
        return

    username = recipient_username.lower().strip()

    try:
        data = {
            "team_id": team_id,
            "recipient_username": username,
            "first_contact_source": source,
        }
        if account_id:
            data["first_contact_account_id"] = account_id

        client.table("contacted_recipients").upsert(
            data, on_conflict="team_id,recipient_username"
        ).execute()
    except Exception as e:
        logger.warning(f"Failed to record contact for {username}: {e}")
