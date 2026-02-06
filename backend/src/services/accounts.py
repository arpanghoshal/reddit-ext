"""
Reddit Accounts Service
Manages multiple Reddit accounts for automation
"""

import os
import json
from datetime import datetime, timedelta
from typing import Dict, Any, List, Optional
from supabase import create_client, Client

from ..utils.crypto import encrypt, decrypt

_supabase: Optional[Client] = None

# Warmup schedule: progressive daily limits
WARMUP_SCHEDULE = [
    3,   # Day 1
    5,   # Day 2
    8,   # Day 3
    12,  # Day 4
    18,  # Day 5
    25,  # Day 6
    35,  # Day 7
    50   # Day 8+ (normal)
]


def get_client() -> Optional[Client]:
    """Get or create Supabase client"""
    global _supabase
    if _supabase is None:
        url = os.getenv("SUPABASE_URL")
        key = os.getenv("SUPABASE_KEY")
        if url and key:
            _supabase = create_client(url, key)
    return _supabase


def get_effective_daily_limit(account: Dict[str, Any]) -> int:
    """Get effective daily limit considering warmup mode"""
    if not account.get("warmupMode"):
        return account.get("dailyLimit", 20)

    warmup_start = account.get("warmupStartDate")
    if not warmup_start:
        return account.get("dailyLimit", 20)

    if isinstance(warmup_start, str):
        warmup_start = datetime.fromisoformat(warmup_start.replace("Z", "+00:00"))

    warmup_days = (datetime.now(warmup_start.tzinfo) - warmup_start).days

    warmup_limit = WARMUP_SCHEDULE[min(warmup_days, len(WARMUP_SCHEDULE) - 1)]
    return min(warmup_limit, account.get("dailyLimit", 20))


def transform_account(row: Optional[Dict[str, Any]]) -> Optional[Dict[str, Any]]:
    """Transform database row to API format"""
    if not row:
        return None

    account = {
        "id": row.get("id"),
        "username": row.get("username"),
        "displayName": row.get("display_name"),
        "warmupMode": row.get("warmup_mode"),
        "warmupStartDate": row.get("warmup_start_date"),
        "dailyLimit": row.get("daily_limit"),
        "currentDailyCount": row.get("current_daily_count"),
        "lastDailyReset": row.get("last_daily_reset"),
        "lastDmAt": row.get("last_dm_at"),
        "lastActivityAt": row.get("last_activity_at"),
        "isShadowbanned": row.get("is_shadowbanned"),
        "shadowbanCheckedAt": row.get("shadowban_checked_at"),
        "status": row.get("status"),
        "createdAt": row.get("created_at"),
        "updatedAt": row.get("updated_at")
    }

    account["effectiveDailyLimit"] = get_effective_daily_limit(account)
    return account


async def add_account(account_data: Dict[str, Any], team_id: Optional[str] = None) -> Optional[Dict[str, Any]]:
    """Add a new Reddit account"""
    client = get_client()
    if not client:
        print("Supabase not configured")
        return None

    try:
        # Encrypt cookies if provided
        encrypted_cookie = None
        if account_data.get("cookies"):
            encrypted_cookie = encrypt(json.dumps(account_data["cookies"]))

        warmup_mode = account_data.get("warmupMode", True)
        insert_data = {
            "username": account_data.get("username", "").lower(),
            "display_name": account_data.get("displayName") or account_data.get("username"),
            "encrypted_cookie": encrypted_cookie,
            "warmup_mode": warmup_mode,
            "warmup_start_date": datetime.utcnow().isoformat(),
            "daily_limit": account_data.get("dailyLimit", 20),
            "current_daily_count": 0,
            "status": "warming_up" if warmup_mode else "active"
        }

        # Add team_id if provided
        if team_id:
            insert_data["team_id"] = team_id

        result = client.table("reddit_accounts").insert(insert_data).execute()

        return transform_account(result.data[0]) if result.data else None
    except Exception as e:
        print(f"Error adding account: {e}")
        return None


async def get_accounts(filters: Dict[str, Any] = None, team_id: Optional[str] = None) -> List[Dict[str, Any]]:
    """Get all accounts for a team"""
    client = get_client()
    if not client:
        return []

    filters = filters or {}

    try:
        query = client.table("reddit_accounts").select("*").order("created_at", desc=True)

        # Filter by team_id (required for multi-tenancy)
        if team_id:
            query = query.eq("team_id", team_id)

        if filters.get("status"):
            query = query.eq("status", filters["status"])

        if filters.get("activeOnly"):
            query = query.in_("status", ["active", "warming_up"])

        result = query.execute()
        return [transform_account(row) for row in result.data] if result.data else []
    except Exception as e:
        print(f"Error fetching accounts: {e}")
        return []


async def get_account(account_id: str, team_id: Optional[str] = None) -> Optional[Dict[str, Any]]:
    """Get a single account by ID, optionally verifying team ownership"""
    client = get_client()
    if not client:
        return None

    try:
        query = client.table("reddit_accounts").select("*").eq("id", account_id)

        # Filter by team_id if provided (for access control)
        if team_id:
            query = query.eq("team_id", team_id)

        result = query.execute()
        return transform_account(result.data[0]) if result.data else None
    except Exception as e:
        print(f"Error fetching account: {e}")
        return None


async def get_account_by_username(username: str, team_id: Optional[str] = None) -> Optional[Dict[str, Any]]:
    """Get account by username, optionally filtering by team"""
    client = get_client()
    if not client:
        return None

    try:
        query = client.table("reddit_accounts").select("*").eq(
            "username", username.lower()
        )

        # Filter by team_id if provided
        if team_id:
            query = query.eq("team_id", team_id)

        result = query.execute()
        return transform_account(result.data[0]) if result.data else None
    except Exception as e:
        if "PGRST116" not in str(e):
            print(f"Error fetching account: {e}")
        return None


async def update_account(account_id: str, updates: Dict[str, Any], team_id: Optional[str] = None) -> Optional[Dict[str, Any]]:
    """Update an account"""
    client = get_client()
    if not client:
        return None

    try:
        update_data = {"updated_at": datetime.utcnow().isoformat()}

        if "displayName" in updates:
            update_data["display_name"] = updates["displayName"]
        if "warmupMode" in updates:
            update_data["warmup_mode"] = updates["warmupMode"]
            if updates["warmupMode"]:
                update_data["warmup_start_date"] = datetime.utcnow().isoformat()
                update_data["status"] = "warming_up"
        if "dailyLimit" in updates:
            update_data["daily_limit"] = updates["dailyLimit"]
        if "status" in updates:
            update_data["status"] = updates["status"]
        if "cookies" in updates:
            update_data["encrypted_cookie"] = encrypt(json.dumps(updates["cookies"]))

        query = client.table("reddit_accounts").update(update_data).eq("id", account_id)
        if team_id:
            query = query.eq("team_id", team_id)
        result = query.execute()
        return transform_account(result.data[0]) if result.data else None
    except Exception as e:
        print(f"Error updating account: {e}")
        return None


async def delete_account(account_id: str, team_id: Optional[str] = None) -> bool:
    """Delete an account"""
    client = get_client()
    if not client:
        return False

    try:
        query = client.table("reddit_accounts").delete().eq("id", account_id)
        if team_id:
            query = query.eq("team_id", team_id)
        query.execute()
        return True
    except Exception as e:
        print(f"Error deleting account: {e}")
        return False


async def get_account_cookies(account_id: str, team_id: Optional[str] = None) -> Optional[List[Dict[str, Any]]]:
    """Get decrypted cookies for an account"""
    client = get_client()
    if not client:
        return None

    try:
        query = client.table("reddit_accounts").select("encrypted_cookie").eq(
            "id", account_id
        )
        if team_id:
            query = query.eq("team_id", team_id)
        result = query.execute()

        if not result.data or not result.data[0].get("encrypted_cookie"):
            print("Error fetching account cookies: no data")
            return None

        decrypted = decrypt(result.data[0]["encrypted_cookie"])
        return json.loads(decrypted)
    except Exception as e:
        print(f"Error decrypting cookies: {e}")
        return None


async def can_account_send_dm(account_id: str) -> Dict[str, Any]:
    """Check if account can send a DM"""
    account = await get_account(account_id)

    if not account:
        return {"allowed": False, "reason": "Account not found"}

    if account.get("status") == "suspended":
        return {"allowed": False, "reason": "Account is suspended"}

    if account.get("status") == "shadowbanned":
        return {"allowed": False, "reason": "Account is shadowbanned"}

    if account.get("status") == "paused":
        return {"allowed": False, "reason": "Account is paused"}

    # Calculate effective daily limit based on warmup
    effective_limit = get_effective_daily_limit(account)

    if (account.get("currentDailyCount") or 0) >= effective_limit:
        return {"allowed": False, "reason": f"Daily limit reached ({effective_limit})"}

    # Check minimum cooldown between DMs (30 seconds)
    if account.get("lastDmAt"):
        last_dm = account["lastDmAt"]
        if isinstance(last_dm, str):
            last_dm = datetime.fromisoformat(last_dm.replace("Z", "+00:00"))
        time_since_last = (datetime.now(last_dm.tzinfo) - last_dm).total_seconds() * 1000
        if time_since_last < 30000:
            return {"allowed": False, "reason": "Cooldown period active"}

    return {"allowed": True}


async def increment_dm_count(account_id: str) -> Optional[Dict[str, Any]]:
    """Increment DM count for an account"""
    client = get_client()
    if not client:
        return None

    try:
        # First check if we need to reset daily count
        current = client.table("reddit_accounts").select(
            "current_daily_count, last_daily_reset"
        ).eq("id", account_id).execute()

        if not current.data:
            return None

        today = datetime.utcnow().date().isoformat()
        last_reset = current.data[0].get("last_daily_reset")
        last_reset_date = None
        if last_reset:
            last_reset_date = datetime.fromisoformat(
                last_reset.replace("Z", "+00:00")
            ).date().isoformat()

        new_count = (current.data[0].get("current_daily_count") or 0) + 1
        update_data = {
            "current_daily_count": new_count,
            "last_dm_at": datetime.utcnow().isoformat(),
            "last_activity_at": datetime.utcnow().isoformat(),
            "updated_at": datetime.utcnow().isoformat()
        }

        # Reset if it's a new day
        if last_reset_date != today:
            new_count = 1
            update_data["current_daily_count"] = 1
            update_data["last_daily_reset"] = datetime.utcnow().isoformat()

        result = client.table("reddit_accounts").update(update_data).eq("id", account_id).execute()
        return transform_account(result.data[0]) if result.data else None
    except Exception as e:
        print(f"Error incrementing DM count: {e}")
        return None


async def reset_daily_counts() -> int:
    """Reset daily DM counts for all accounts (for new day)"""
    client = get_client()
    if not client:
        return 0

    try:
        today = datetime.utcnow().replace(hour=0, minute=0, second=0, microsecond=0)

        result = client.table("reddit_accounts").update({
            "current_daily_count": 0,
            "last_daily_reset": datetime.utcnow().isoformat()
        }).lt("last_daily_reset", today.isoformat()).execute()

        return len(result.data) if result.data else 0
    except Exception as e:
        print(f"Error resetting daily counts: {e}")
        return 0


async def mark_as_shadowbanned(account_id: str, check_result: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    """Mark account as shadowbanned"""
    client = get_client()
    if not client:
        return None

    try:
        result = client.table("reddit_accounts").update({
            "is_shadowbanned": True,
            "shadowban_checked_at": datetime.utcnow().isoformat(),
            "shadowban_check_result": check_result,
            "status": "shadowbanned",
            "updated_at": datetime.utcnow().isoformat()
        }).eq("id", account_id).execute()

        return transform_account(result.data[0]) if result.data else None
    except Exception as e:
        print(f"Error marking as shadowbanned: {e}")
        return None


async def assign_to_subreddit(account_id: str, subreddit: str, priority: int = 1) -> bool:
    """Assign account to subreddit"""
    client = get_client()
    if not client:
        return False

    try:
        clean_subreddit = subreddit.lower().replace("r/", "")
        client.table("account_subreddit_assignments").upsert({
            "account_id": account_id,
            "subreddit": clean_subreddit,
            "priority": priority
        }, on_conflict="account_id,subreddit").execute()
        return True
    except Exception as e:
        print(f"Error assigning to subreddit: {e}")
        return False


async def remove_from_subreddit(account_id: str, subreddit: str) -> bool:
    """Remove account from subreddit"""
    client = get_client()
    if not client:
        return False

    try:
        clean_subreddit = subreddit.lower().replace("r/", "")
        client.table("account_subreddit_assignments").delete().eq(
            "account_id", account_id
        ).eq("subreddit", clean_subreddit).execute()
        return True
    except Exception as e:
        print(f"Error removing from subreddit: {e}")
        return False


async def get_account_subreddits(account_id: str) -> List[Dict[str, Any]]:
    """Get subreddits assigned to an account"""
    client = get_client()
    if not client:
        return []

    try:
        result = client.table("account_subreddit_assignments").select(
            "subreddit, priority"
        ).eq("account_id", account_id).order("priority", desc=True).execute()

        return result.data if result.data else []
    except Exception as e:
        print(f"Error fetching account subreddits: {e}")
        return []
