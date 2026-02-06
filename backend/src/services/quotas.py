"""
Team Quotas Service
Manages team usage limits and quota enforcement
"""

import os
from datetime import datetime, date
from typing import Dict, Any, Optional
from supabase import create_client, Client

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


async def get_team_quota(team_id: str) -> Optional[Dict[str, Any]]:
    """Get quota limits for a team"""
    client = get_client()
    if not client:
        return None

    try:
        result = client.table("team_quotas").select("*").eq("team_id", team_id).execute()
        if result.data:
            return result.data[0]
        return None
    except Exception as e:
        print(f"Error fetching team quota: {e}")
        return None


async def get_today_usage(team_id: str) -> Optional[Dict[str, Any]]:
    """Get today's usage for a team"""
    client = get_client()
    if not client:
        return None

    try:
        today = date.today().isoformat()
        result = client.table("team_usage").select("*").eq(
            "team_id", team_id
        ).eq("date", today).execute()

        if result.data:
            return result.data[0]

        # Create record if doesn't exist
        create_result = client.table("team_usage").insert({
            "team_id": team_id,
            "date": today
        }).execute()

        return create_result.data[0] if create_result.data else None
    except Exception as e:
        print(f"Error fetching today's usage: {e}")
        return None


async def check_quota(team_id: str, resource: str) -> Dict[str, Any]:
    """
    Check if team is within quota limits.
    Returns: {"allowed": bool, "current": int, "limit": int, "message": str}
    """
    client = get_client()
    if not client:
        return {"allowed": True, "message": "Quota service unavailable"}

    try:
        quota = await get_team_quota(team_id)
        if not quota:
            return {"allowed": True, "message": "No quota limits set"}

        usage = await get_today_usage(team_id)

        # Define limits based on resource type
        if resource == "dms":
            current = usage.get("dms_sent", 0) if usage else 0
            limit = quota.get("max_dms_per_day", 100)
        elif resource == "accounts":
            result = client.table("reddit_accounts").select("id", count="exact").eq(
                "team_id", team_id
            ).execute()
            current = result.count or 0
            limit = quota.get("max_accounts", 5)
        elif resource == "members":
            result = client.table("team_members").select("id", count="exact").eq(
                "team_id", team_id
            ).execute()
            current = result.count or 0
            limit = quota.get("max_members", 10)
        elif resource == "campaigns":
            result = client.table("campaigns").select("id", count="exact").eq(
                "team_id", team_id
            ).eq("status", "active").execute()
            current = result.count or 0
            limit = quota.get("max_campaigns", 10)
        elif resource == "rules":
            result = client.table("filter_rules").select("id", count="exact").eq(
                "team_id", team_id
            ).execute()
            current = result.count or 0
            limit = quota.get("max_rules", 50)
        else:
            return {"allowed": True, "message": f"Unknown resource: {resource}"}

        allowed = current < limit
        return {
            "allowed": allowed,
            "current": current,
            "limit": limit,
            "remaining": max(0, limit - current),
            "message": f"Quota exceeded for {resource}" if not allowed else None
        }
    except Exception as e:
        print(f"Error checking quota: {e}")
        return {"allowed": True, "message": f"Quota check error: {e}"}


async def increment_usage(team_id: str, metric: str, amount: int = 1) -> Optional[Dict[str, Any]]:
    """Increment a daily usage metric using atomic RPC call"""
    client = get_client()
    if not client:
        return None

    try:
        # Valid metrics
        valid_metrics = ["dms_sent", "dms_received", "accounts_active", "api_calls"]
        if metric not in valid_metrics:
            print(f"Invalid metric: {metric}")
            return None

        # Use atomic RPC function to avoid read-then-write race condition
        try:
            result = client.rpc("increment_daily_usage", {
                "p_team_id": team_id,
                "p_metric": metric,
                "p_amount": amount
            }).execute()
            return result.data if result.data else {"success": True}
        except Exception:
            # Fallback if RPC not available: ensure record exists then update
            usage = await get_today_usage(team_id)
            if not usage:
                return None

            today = date.today().isoformat()
            new_value = usage.get(metric, 0) + amount

            result = client.table("team_usage").update({
                metric: new_value
            }).eq("team_id", team_id).eq("date", today).execute()

            return result.data[0] if result.data else None
    except Exception as e:
        print(f"Error incrementing usage: {e}")
        return None


async def get_usage_summary(team_id: str, days: int = 7) -> Dict[str, Any]:
    """Get usage summary for the past N days"""
    client = get_client()
    if not client:
        return {}

    try:
        from datetime import timedelta

        start_date = (datetime.utcnow() - timedelta(days=days)).date().isoformat()

        result = client.table("team_usage").select("*").eq(
            "team_id", team_id
        ).gte("date", start_date).order("date", desc=True).execute()

        quota = await get_team_quota(team_id)

        usage_data = result.data or []

        # Calculate totals
        total_dms = sum(d.get("dms_sent", 0) for d in usage_data)
        total_received = sum(d.get("dms_received", 0) for d in usage_data)
        avg_daily_dms = total_dms / max(len(usage_data), 1)

        return {
            "period_days": days,
            "daily_usage": usage_data,
            "totals": {
                "dms_sent": total_dms,
                "dms_received": total_received,
                "avg_daily_dms": round(avg_daily_dms, 1)
            },
            "quotas": {
                "max_dms_per_day": quota.get("max_dms_per_day", 100) if quota else 100,
                "max_accounts": quota.get("max_accounts", 5) if quota else 5,
                "max_members": quota.get("max_members", 10) if quota else 10,
                "max_campaigns": quota.get("max_campaigns", 10) if quota else 10,
                "max_rules": quota.get("max_rules", 50) if quota else 50
            }
        }
    except Exception as e:
        print(f"Error fetching usage summary: {e}")
        return {}


async def update_quota(team_id: str, updates: Dict[str, int]) -> Optional[Dict[str, Any]]:
    """Update quota limits for a team (admin only)"""
    client = get_client()
    if not client:
        return None

    try:
        valid_fields = ["max_accounts", "max_dms_per_day", "max_members", "max_campaigns", "max_rules"]
        update_data = {k: v for k, v in updates.items() if k in valid_fields}

        if not update_data:
            return None

        update_data["updated_at"] = datetime.utcnow().isoformat()

        result = client.table("team_quotas").update(update_data).eq(
            "team_id", team_id
        ).execute()

        return result.data[0] if result.data else None
    except Exception as e:
        print(f"Error updating quota: {e}")
        return None


async def get_quota_status(team_id: str) -> Dict[str, Any]:
    """Get comprehensive quota status for a team"""
    quota = await get_team_quota(team_id)
    usage = await get_today_usage(team_id)

    client = get_client()
    if not client:
        return {}

    try:
        # Count current resources
        accounts_result = client.table("reddit_accounts").select("id", count="exact").eq(
            "team_id", team_id
        ).execute()
        accounts_count = accounts_result.count or 0

        members_result = client.table("team_members").select("id", count="exact").eq(
            "team_id", team_id
        ).execute()
        members_count = members_result.count or 0

        campaigns_result = client.table("campaigns").select("id", count="exact").eq(
            "team_id", team_id
        ).eq("status", "active").execute()
        campaigns_count = campaigns_result.count or 0

        rules_result = client.table("filter_rules").select("id", count="exact").eq(
            "team_id", team_id
        ).execute()
        rules_count = rules_result.count or 0

        dms_sent = usage.get("dms_sent", 0) if usage else 0

        quota = quota or {}

        return {
            "accounts": {
                "current": accounts_count,
                "limit": quota.get("max_accounts", 5),
                "percentage": round((accounts_count / max(quota.get("max_accounts", 5), 1)) * 100)
            },
            "dms_today": {
                "current": dms_sent,
                "limit": quota.get("max_dms_per_day", 100),
                "percentage": round((dms_sent / max(quota.get("max_dms_per_day", 100), 1)) * 100)
            },
            "members": {
                "current": members_count,
                "limit": quota.get("max_members", 10),
                "percentage": round((members_count / max(quota.get("max_members", 10), 1)) * 100)
            },
            "campaigns": {
                "current": campaigns_count,
                "limit": quota.get("max_campaigns", 10),
                "percentage": round((campaigns_count / max(quota.get("max_campaigns", 10), 1)) * 100)
            },
            "rules": {
                "current": rules_count,
                "limit": quota.get("max_rules", 50),
                "percentage": round((rules_count / max(quota.get("max_rules", 50), 1)) * 100)
            }
        }
    except Exception as e:
        print(f"Error fetching quota status: {e}")
        return {}
