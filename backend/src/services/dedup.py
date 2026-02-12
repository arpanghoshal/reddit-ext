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
    Check if a recipient has EVER been contacted/messaged by ANY account in this team.

    Used by the DM queue to prevent double-sends. Checks:
    1. contacted_recipients table (fast, indexed)
    2. dm_queue (pending/approved/sent items)
    3. dm_history (confirmed sends)
    4. conversations (established contact)

    Note: Does NOT check discovered_leads — that dedup is handled
    separately in batch_check_contacted() for the discovery pipeline.

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

        # Note: discovered_leads is intentionally NOT checked here.
        # This function guards the DM queue (preventing double-sends).
        # discovered_leads dedup is in batch_check_contacted() for the
        # discovery pipeline (preventing re-classification across sessions).

        return {"contacted": False}

    except Exception as e:
        logger.warning(f"Error checking if {username} was contacted: {e}")
        return {"contacted": False, "error": str(e)}


async def batch_check_contacted(usernames: List[str], team_id: str) -> set:
    """
    Check which usernames have been contacted, using batch queries.
    Returns a set of lowercase usernames that have been contacted.
    Much faster than checking one by one (4 queries total instead of 4*N).
    """
    if not usernames or not team_id:
        return set()

    client = get_client()
    if not client:
        return set()

    contacted = set()
    # Normalize all usernames
    normalized = [u.lower().strip() for u in usernames if u]

    try:
        # 1. Check contacted_recipients (fastest)
        result = client.table("contacted_recipients").select(
            "recipient_username"
        ).eq("team_id", team_id).in_(
            "recipient_username", normalized
        ).execute()
        for row in (result.data or []):
            contacted.add(row["recipient_username"])

        # Only check remaining tables for usernames not yet found
        remaining = [u for u in normalized if u not in contacted]
        if not remaining:
            return contacted

        # 2. Check dm_queue
        result = client.table("dm_queue").select(
            "recipient_username"
        ).eq("team_id", team_id).in_(
            "recipient_username", remaining
        ).in_("status", ["pending", "approved", "sent"]).execute()
        for row in (result.data or []):
            contacted.add(row["recipient_username"])

        remaining = [u for u in remaining if u not in contacted]
        if not remaining:
            return contacted

        # 3. Check dm_history
        result = client.table("dm_history").select(
            "recipient_username"
        ).eq("team_id", team_id).in_(
            "recipient_username", remaining
        ).execute()
        for row in (result.data or []):
            contacted.add(row["recipient_username"])

        remaining = [u for u in remaining if u not in contacted]
        if not remaining:
            return contacted

        # 4. Check conversations
        result = client.table("conversations").select(
            "participant_username"
        ).eq("team_id", team_id).in_(
            "participant_username", remaining
        ).execute()
        for row in (result.data or []):
            contacted.add(row["participant_username"])

        # 5. Check discovered_leads (past discovery sessions)
        # Prevents re-classifying the same users across sessions (saves API costs).
        # Un-contacted leads from past sessions are shown separately in the UI
        # with a "Previously Found" badge instead.
        remaining = [u for u in remaining if u not in contacted]
        if remaining:
            result = client.table("discovered_leads").select(
                "author_username"
            ).eq("team_id", team_id).in_(
                "author_username", remaining
            ).neq("status", "dismissed").execute()
            for row in (result.data or []):
                contacted.add(row["author_username"].lower())

    except Exception as e:
        logger.warning(f"Batch dedup check failed: {e}")

    return contacted


async def batch_check_known_urls(urls: List[str], team_id: str) -> set:
    """
    Check which post URLs already exist in discovered_leads for this team
    (across all sessions). Used BEFORE enrichment to skip re-enriching
    posts that were already processed in a previous discovery run.

    Returns a set of URLs that are already known.
    """
    if not urls or not team_id:
        return set()

    client = get_client()
    if not client:
        return set()

    known = set()
    try:
        # Query in batches of 100 to avoid query size limits
        for batch_start in range(0, len(urls), 100):
            batch = urls[batch_start:batch_start + 100]
            result = client.table("discovered_leads").select(
                "post_url"
            ).eq("team_id", team_id).in_(
                "post_url", batch
            ).execute()
            for row in (result.data or []):
                if row.get("post_url"):
                    known.add(row["post_url"])
    except Exception as e:
        logger.warning(f"Batch URL dedup check failed: {e}")

    return known


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
