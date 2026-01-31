"""
Account Rotation Service
Selects the best account for sending DMs based on various factors
"""

import os
import random
from datetime import datetime
from typing import Dict, Any, List, Optional
from supabase import create_client, Client

from . import accounts

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


async def get_subreddit_accounts(subreddit: str) -> List[Dict[str, Any]]:
    """Get accounts assigned to a subreddit"""
    client = get_client()
    if not client:
        return []

    try:
        clean_subreddit = subreddit.lower().replace("r/", "")
        result = client.table("account_subreddit_assignments").select(
            "priority, reddit_accounts(id, username, display_name, warmup_mode, "
            "daily_limit, current_daily_count, last_dm_at, status)"
        ).eq("subreddit", clean_subreddit).order("priority", desc=True).execute()

        if not result.data:
            return []

        return [
            {"priority": d.get("priority"), "account": d.get("reddit_accounts")}
            for d in result.data if d.get("reddit_accounts")
        ]
    except Exception as e:
        print(f"Error fetching subreddit accounts: {e}")
        return []


def calculate_account_score(account: Dict[str, Any], priority: int = 1) -> float:
    """
    Calculate account score for rotation selection
    Higher score = better candidate
    """
    score = 100.0

    # Priority boost (each priority level adds 10 points)
    score += priority * 10

    # Penalize for high daily usage (prefer fresh accounts)
    daily_limit = account.get("daily_limit", 20)
    current_count = account.get("current_daily_count", 0)

    # Get effective limit considering warmup
    effective_limit = accounts.get_effective_daily_limit({
        "warmupMode": account.get("warmup_mode"),
        "warmupStartDate": account.get("warmup_start_date"),
        "dailyLimit": daily_limit
    })

    if effective_limit > 0:
        usage_ratio = current_count / effective_limit
        score -= usage_ratio * 30

    # Bonus for longer time since last DM (cooled down)
    last_dm_at = account.get("last_dm_at")
    if last_dm_at:
        if isinstance(last_dm_at, str):
            last_dm_at = datetime.fromisoformat(last_dm_at.replace("Z", "+00:00"))
        hours_since = (datetime.now(last_dm_at.tzinfo) - last_dm_at).total_seconds() / 3600
        score += min(hours_since * 5, 20)
    else:
        # Never sent a DM - fresh account
        score += 15

    # Penalize warmup accounts slightly (prefer established)
    if account.get("warmup_mode"):
        score -= 10

    # Penalize based on status
    if account.get("status") == "warming_up":
        score -= 5

    return max(score, 1.0)


async def select_account_for_subreddit(subreddit: str) -> Optional[Dict[str, Any]]:
    """Select the best account for a subreddit"""
    # Get accounts assigned to this subreddit
    assignments = await get_subreddit_accounts(subreddit)

    if not assignments:
        # Fall back to any available account
        print(f"No accounts assigned to r/{subreddit}, selecting any available")
        return await select_any_available_account()

    # Filter to available accounts
    available_accounts = []
    for assignment in assignments:
        account = assignment.get("account")
        if not account:
            continue

        # Transform for can_account_send_dm
        account_transformed = {
            "id": account.get("id"),
            "status": account.get("status"),
            "currentDailyCount": account.get("current_daily_count"),
            "warmupMode": account.get("warmup_mode"),
            "warmupStartDate": account.get("warmup_start_date"),
            "dailyLimit": account.get("daily_limit"),
            "lastDmAt": account.get("last_dm_at")
        }

        can_send = await accounts.can_account_send_dm(account["id"])
        if can_send.get("allowed"):
            score = calculate_account_score(account, assignment.get("priority", 1))
            available_accounts.append({
                **account,
                "priority": assignment.get("priority", 1),
                "score": score
            })

    if not available_accounts:
        print(f"No available accounts for r/{subreddit}")
        return None

    # Sort by score (descending)
    available_accounts.sort(key=lambda a: a["score"], reverse=True)

    # Weighted random selection (favor higher scored accounts)
    total_weight = sum(a["score"] for a in available_accounts)
    rand = random.random() * total_weight

    for account in available_accounts:
        rand -= account["score"]
        if rand <= 0:
            print(f"Selected account {account['username']} for r/{subreddit} (score: {account['score']})")
            return account

    # Fallback to highest scored
    return available_accounts[0]


async def select_any_available_account() -> Optional[Dict[str, Any]]:
    """Select any available account (fallback when no subreddit assignment)"""
    all_accounts = await accounts.get_accounts({"activeOnly": True})

    available_accounts = []
    for account in all_accounts:
        can_send = await accounts.can_account_send_dm(account["id"])
        if can_send.get("allowed"):
            score = calculate_account_score({
                "warmup_mode": account.get("warmupMode"),
                "warmup_start_date": account.get("warmupStartDate"),
                "daily_limit": account.get("dailyLimit"),
                "current_daily_count": account.get("currentDailyCount"),
                "last_dm_at": account.get("lastDmAt"),
                "status": account.get("status")
            }, 1)
            available_accounts.append({**account, "score": score})

    if not available_accounts:
        return None

    # Sort by score and do weighted random selection
    available_accounts.sort(key=lambda a: a["score"], reverse=True)

    total_weight = sum(a["score"] for a in available_accounts)
    rand = random.random() * total_weight

    for account in available_accounts:
        rand -= account["score"]
        if rand <= 0:
            return account

    return available_accounts[0]


async def get_rotation_status() -> Dict[str, int]:
    """Get account rotation status for dashboard"""
    all_accounts = await accounts.get_accounts({"activeOnly": True})

    available = 0
    at_limit = 0
    on_cooldown = 0
    warming_up = 0

    for account in all_accounts:
        can_send = await accounts.can_account_send_dm(account["id"])

        if can_send.get("allowed"):
            available += 1
        elif "Daily limit" in (can_send.get("reason") or ""):
            at_limit += 1
        elif "Cooldown" in (can_send.get("reason") or ""):
            on_cooldown += 1

        if account.get("warmupMode"):
            warming_up += 1

    return {
        "total": len(all_accounts),
        "available": available,
        "atLimit": at_limit,
        "onCooldown": on_cooldown,
        "warmingUp": warming_up
    }


async def get_next_available() -> Dict[str, Any]:
    """Get next available account with estimated wait time"""
    account = await select_any_available_account()

    if account:
        return {"account": account, "waitTime": 0}

    # No account available - calculate wait time until one becomes available
    all_accounts = await accounts.get_accounts({"activeOnly": True})

    shortest_wait = float("inf")

    for account in all_accounts:
        # Check cooldown
        last_dm_at = account.get("lastDmAt")
        if last_dm_at:
            if isinstance(last_dm_at, str):
                last_dm_at = datetime.fromisoformat(last_dm_at.replace("Z", "+00:00"))
            time_since = (datetime.now(last_dm_at.tzinfo) - last_dm_at).total_seconds() * 1000
            if time_since < 30000:
                wait_time = 30000 - time_since
                shortest_wait = min(shortest_wait, wait_time)

    if shortest_wait == float("inf"):
        # All accounts at daily limit - wait until midnight
        now = datetime.now()
        midnight = now.replace(hour=0, minute=0, second=0, microsecond=0)
        midnight = midnight.replace(day=midnight.day + 1)
        shortest_wait = (midnight - now).total_seconds() * 1000

    return {"account": None, "waitTime": int(shortest_wait)}


async def rebalance_assignments() -> Dict[str, Any]:
    """
    Rebalance account assignments across subreddits
    Ensures even distribution of DM load
    """
    client = get_client()
    if not client:
        return {"success": False, "reason": "Database not configured"}

    try:
        # Get all assignments grouped by account
        result = client.table("account_subreddit_assignments").select(
            "account_id, subreddit, priority"
        ).execute()

        if not result.data:
            return {"success": True, "stats": {}, "recommendation": "No assignments found"}

        assignments = result.data

        # Count assignments per account
        account_counts: Dict[str, int] = {}
        for a in assignments:
            account_id = a.get("account_id")
            account_counts[account_id] = account_counts.get(account_id, 0) + 1

        # Get accounts with high/low assignment counts
        num_accounts = len(account_counts)
        avg_assignments = len(assignments) / num_accounts if num_accounts > 0 else 0

        stats = {
            "totalAssignments": len(assignments),
            "accountsWithAssignments": num_accounts,
            "averagePerAccount": avg_assignments,
            "distribution": account_counts
        }

        recommendation = (
            "Consider adding more accounts for better load distribution"
            if avg_assignments > 5
            else "Current distribution looks healthy"
        )

        return {"success": True, "stats": stats, "recommendation": recommendation}
    except Exception as e:
        print(f"Error rebalancing: {e}")
        return {"success": False, "reason": str(e)}
