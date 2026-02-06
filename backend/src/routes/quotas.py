"""
Quota Routes
API endpoints for team quota management
"""

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel
from typing import Dict, Any, Optional

from ..middleware.supabase_auth import get_current_team_id, require_team
from ..services import quotas

router = APIRouter(prefix="/quotas", tags=["quotas"])


class QuotaUpdateRequest(BaseModel):
    max_accounts: Optional[int] = None
    max_dms_per_day: Optional[int] = None
    max_members: Optional[int] = None
    max_campaigns: Optional[int] = None
    max_rules: Optional[int] = None


@router.get("/status")
async def get_quota_status(request: Request):
    """Get current quota status for the team"""
    team_id = require_team(request)
    status = await quotas.get_quota_status(team_id)
    return {"success": True, "data": status}


@router.get("/check/{resource}")
async def check_quota(request: Request, resource: str):
    """Check if team can use more of a resource"""
    team_id = require_team(request)
    result = await quotas.check_quota(team_id, resource)
    return {"success": True, "data": result}


@router.get("/usage")
async def get_usage(request: Request, days: int = 7):
    """Get usage summary for the past N days"""
    team_id = require_team(request)
    summary = await quotas.get_usage_summary(team_id, days)
    return {"success": True, "data": summary}


@router.post("/increment/{metric}")
async def increment_usage(request: Request, metric: str, amount: int = 1):
    """Increment a usage metric (internal use)"""
    team_id = require_team(request)
    result = await quotas.increment_usage(team_id, metric, amount)
    return {"success": True, "data": result}


@router.patch("/limits")
async def update_quota_limits(request: Request, body: QuotaUpdateRequest):
    """Update quota limits (admin only)"""
    team_id = require_team(request)

    # TODO: Check if user is admin/owner

    result = await quotas.update_quota(team_id, body.model_dump(exclude_none=True))
    if not result:
        raise HTTPException(status_code=400, detail="Failed to update quota limits")

    return {"success": True, "data": result}
