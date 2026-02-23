"""
Team Audit Log Service
Tracks all team actions for accountability and compliance
"""

import logging
import os
from datetime import datetime
from typing import Dict, Any, List, Optional
from supabase import create_client, Client
from fastapi import Request

logger = logging.getLogger(__name__)

_supabase: Optional[Client] = None

# Action constants
ACTIONS = {
    # Member actions
    "member.invited": "Invited new member",
    "member.joined": "Member joined team",
    "member.removed": "Removed team member",
    "member.left": "Member left team",
    "member.role_changed": "Changed member role",

    # Account actions
    "account.added": "Added Reddit account",
    "account.removed": "Removed Reddit account",
    "account.updated": "Updated account settings",

    # Campaign actions
    "campaign.created": "Created campaign",
    "campaign.updated": "Updated campaign",
    "campaign.deleted": "Deleted campaign",
    "campaign.started": "Started campaign",
    "campaign.paused": "Paused campaign",

    # Rule actions
    "rule.created": "Created automation rule",
    "rule.updated": "Updated rule",
    "rule.deleted": "Deleted rule",

    # Settings actions
    "settings.updated": "Updated team settings",

    # DM actions
    "dm.sent": "Sent DM",
    "dm.approved": "Approved DM from queue",
    "dm.rejected": "Rejected DM from queue",

    # Quota actions
    "quota.exceeded": "Quota limit reached",
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


async def log_action(
    team_id: str,
    user_id: str,
    action: str,
    resource_type: Optional[str] = None,
    resource_id: Optional[str] = None,
    details: Optional[Dict[str, Any]] = None,
    request: Optional[Request] = None
) -> Optional[Dict[str, Any]]:
    """
    Log an audit event.

    Args:
        team_id: The team this action belongs to
        user_id: The user who performed the action
        action: Action type (e.g., 'member.invited', 'account.added')
        resource_type: Type of resource affected (e.g., 'member', 'account')
        resource_id: ID of the affected resource
        details: Additional context as JSON
        request: FastAPI request object for IP/user-agent extraction
    """
    client = get_client()
    if not client:
        logger.warning("Audit logging unavailable - Supabase not configured")
        return None

    try:
        ip_address = None
        user_agent = None

        if request:
            # Extract client IP (handle proxies)
            forwarded = request.headers.get("x-forwarded-for")
            if forwarded:
                ip_address = forwarded.split(",")[0].strip()
            else:
                ip_address = request.client.host if request.client else None

            user_agent = request.headers.get("user-agent")

        result = client.table("team_audit_log").insert({
            "team_id": team_id,
            "user_id": user_id,
            "action": action,
            "resource_type": resource_type,
            "resource_id": resource_id,
            "details": details or {},
            "ip_address": ip_address,
            "user_agent": user_agent
        }).execute()

        return result.data[0] if result.data else None
    except Exception as e:
        logger.error(f"Error logging audit event: {e}")
        return None


async def get_audit_log(
    team_id: str,
    filters: Optional[Dict[str, Any]] = None
) -> List[Dict[str, Any]]:
    """
    Get audit log entries for a team.

    Filters:
        - action: Filter by action type
        - user_id: Filter by user
        - resource_type: Filter by resource type
        - start_date: Start of date range
        - end_date: End of date range
        - limit: Max entries (default 50)
        - offset: Pagination offset
    """
    client = get_client()
    if not client:
        return []

    filters = filters or {}

    try:
        # Use the view for user info
        query = client.table("audit_log_with_users").select("*").eq(
            "team_id", team_id
        ).order("created_at", desc=True)

        if filters.get("action"):
            query = query.eq("action", filters["action"])

        if filters.get("user_id"):
            query = query.eq("user_id", filters["user_id"])

        if filters.get("resource_type"):
            query = query.eq("resource_type", filters["resource_type"])

        if filters.get("start_date"):
            query = query.gte("created_at", filters["start_date"])

        if filters.get("end_date"):
            query = query.lte("created_at", filters["end_date"])

        limit = filters.get("limit", 50)
        offset = filters.get("offset", 0)

        if offset:
            query = query.range(offset, offset + limit - 1)
        else:
            query = query.limit(limit)

        result = query.execute()
        return result.data or []
    except Exception as e:
        logger.error(f"Error fetching audit log: {e}")
        return []


async def get_audit_summary(team_id: str, days: int = 7) -> Dict[str, Any]:
    """Get summary of audit activity for the past N days"""
    client = get_client()
    if not client:
        return {}

    try:
        from datetime import timedelta

        start_date = (datetime.utcnow() - timedelta(days=days)).isoformat()

        result = client.table("team_audit_log").select("action, user_id").eq(
            "team_id", team_id
        ).gte("created_at", start_date).execute()

        entries = result.data or []

        # Count by action type
        action_counts = {}
        user_counts = {}

        for entry in entries:
            action = entry.get("action", "unknown")
            user_id = entry.get("user_id", "unknown")

            action_counts[action] = action_counts.get(action, 0) + 1
            user_counts[user_id] = user_counts.get(user_id, 0) + 1

        return {
            "period_days": days,
            "total_events": len(entries),
            "by_action": action_counts,
            "by_user": user_counts,
            "most_active_action": max(action_counts, key=action_counts.get) if action_counts else None,
            "most_active_user": max(user_counts, key=user_counts.get) if user_counts else None
        }
    except Exception as e:
        logger.error(f"Error fetching audit summary: {e}")
        return {}


async def get_user_activity(team_id: str, user_id: str, limit: int = 20) -> List[Dict[str, Any]]:
    """Get recent activity for a specific user"""
    return await get_audit_log(team_id, {"user_id": user_id, "limit": limit})


async def get_resource_history(
    team_id: str,
    resource_type: str,
    resource_id: str
) -> List[Dict[str, Any]]:
    """Get all audit entries for a specific resource"""
    client = get_client()
    if not client:
        return []

    try:
        result = client.table("audit_log_with_users").select("*").eq(
            "team_id", team_id
        ).eq(
            "resource_type", resource_type
        ).eq(
            "resource_id", resource_id
        ).order("created_at", desc=True).execute()

        return result.data or []
    except Exception as e:
        logger.error(f"Error fetching resource history: {e}")
        return []


def get_action_description(action: str) -> str:
    """Get human-readable description for an action"""
    return ACTIONS.get(action, action)


# Convenience functions for common audit events
async def log_member_invited(
    team_id: str,
    user_id: str,
    invited_email: str,
    role: str,
    request: Optional[Request] = None
):
    return await log_action(
        team_id=team_id,
        user_id=user_id,
        action="member.invited",
        resource_type="member",
        details={"email": invited_email, "role": role},
        request=request
    )


async def log_member_removed(
    team_id: str,
    user_id: str,
    removed_user_id: str,
    removed_email: str,
    request: Optional[Request] = None
):
    return await log_action(
        team_id=team_id,
        user_id=user_id,
        action="member.removed",
        resource_type="member",
        resource_id=removed_user_id,
        details={"email": removed_email},
        request=request
    )


async def log_account_added(
    team_id: str,
    user_id: str,
    account_id: str,
    username: str,
    request: Optional[Request] = None
):
    return await log_action(
        team_id=team_id,
        user_id=user_id,
        action="account.added",
        resource_type="account",
        resource_id=account_id,
        details={"username": username},
        request=request
    )


async def log_campaign_created(
    team_id: str,
    user_id: str,
    campaign_id: str,
    campaign_name: str,
    request: Optional[Request] = None
):
    return await log_action(
        team_id=team_id,
        user_id=user_id,
        action="campaign.created",
        resource_type="campaign",
        resource_id=campaign_id,
        details={"name": campaign_name},
        request=request
    )


async def log_settings_updated(
    team_id: str,
    user_id: str,
    changes: Dict[str, Any],
    request: Optional[Request] = None
):
    return await log_action(
        team_id=team_id,
        user_id=user_id,
        action="settings.updated",
        resource_type="settings",
        details={"changes": changes},
        request=request
    )
