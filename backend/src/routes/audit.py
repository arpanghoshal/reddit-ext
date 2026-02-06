"""
Audit Routes
API endpoints for team audit log access
"""

from fastapi import APIRouter, HTTPException, Request, Query
from typing import Optional

from ..middleware.supabase_auth import get_current_team_id, get_current_user_id, require_team
from ..services import audit

router = APIRouter(prefix="/audit", tags=["audit"])


@router.get("")
async def get_audit_log(
    request: Request,
    action: Optional[str] = None,
    user_id: Optional[str] = None,
    resource_type: Optional[str] = None,
    start_date: Optional[str] = None,
    end_date: Optional[str] = None,
    limit: int = Query(50, le=100),
    offset: int = Query(0)
):
    """Get audit log entries for the team (admin/owner only)"""
    team_id = require_team(request)

    # TODO: Verify user is admin/owner

    filters = {
        "action": action,
        "user_id": user_id,
        "resource_type": resource_type,
        "start_date": start_date,
        "end_date": end_date,
        "limit": limit,
        "offset": offset
    }

    entries = await audit.get_audit_log(team_id, filters)
    return {"success": True, "data": entries}


@router.get("/summary")
async def get_audit_summary(request: Request, days: int = Query(7, le=90)):
    """Get audit activity summary"""
    team_id = require_team(request)

    summary = await audit.get_audit_summary(team_id, days)
    return {"success": True, "data": summary}


@router.get("/user/{user_id}")
async def get_user_activity(request: Request, user_id: str, limit: int = Query(20, le=100)):
    """Get activity for a specific user"""
    team_id = require_team(request)

    activity = await audit.get_user_activity(team_id, user_id, limit)
    return {"success": True, "data": activity}


@router.get("/resource/{resource_type}/{resource_id}")
async def get_resource_history(
    request: Request,
    resource_type: str,
    resource_id: str
):
    """Get audit history for a specific resource"""
    team_id = require_team(request)

    history = await audit.get_resource_history(team_id, resource_type, resource_id)
    return {"success": True, "data": history}


@router.get("/actions")
async def get_available_actions():
    """Get list of available action types with descriptions"""
    return {"success": True, "data": audit.ACTIONS}
