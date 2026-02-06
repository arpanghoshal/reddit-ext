"""
Team Analytics Routes
API endpoints for team analytics and performance metrics
"""

from datetime import date, datetime, timedelta
from fastapi import APIRouter, Request, Query
from typing import Optional

from ..middleware.supabase_auth import require_team
from ..services import team_analytics

router = APIRouter(prefix="/team-analytics", tags=["team-analytics"])


@router.get("")
async def get_analytics(
    request: Request,
    period: str = Query("30d", description="Period: 7d, 30d, 90d, or custom"),
    start_date: Optional[str] = None,
    end_date: Optional[str] = None
):
    """Get comprehensive team analytics"""
    team_id = require_team(request)

    # Parse period
    if start_date and end_date:
        start = date.fromisoformat(start_date)
        end = date.fromisoformat(end_date)
    else:
        end = date.today()
        period_days = {
            "7d": 7,
            "30d": 30,
            "90d": 90
        }.get(period, 30)
        start = end - timedelta(days=period_days)

    analytics = await team_analytics.get_team_analytics(team_id, start, end)
    return {"success": True, "data": analytics}


@router.get("/summary")
async def get_summary(
    request: Request,
    days: int = Query(30, le=90)
):
    """Get analytics summary"""
    team_id = require_team(request)

    end = date.today()
    start = end - timedelta(days=days)

    summary = await team_analytics.get_summary_stats(team_id, start, end)
    return {"success": True, "data": summary}


@router.get("/daily")
async def get_daily_breakdown(
    request: Request,
    days: int = Query(30, le=90)
):
    """Get daily breakdown of stats"""
    team_id = require_team(request)

    end = date.today()
    start = end - timedelta(days=days)

    daily = await team_analytics.get_daily_stats(team_id, start, end)
    return {"success": True, "data": daily}


@router.get("/heatmap")
async def get_activity_heatmap(
    request: Request,
    days: int = Query(30, le=90)
):
    """Get hourly/daily activity heatmap data"""
    team_id = require_team(request)

    end = date.today()
    start = end - timedelta(days=days)

    heatmap = await team_analytics.get_hourly_activity(team_id, start, end)
    return {"success": True, "data": heatmap}


@router.get("/leaderboard")
async def get_member_leaderboard(
    request: Request,
    days: int = Query(30, le=90)
):
    """Get member performance leaderboard"""
    team_id = require_team(request)

    end = date.today()
    start = end - timedelta(days=days)

    leaderboard = await team_analytics.get_member_stats(team_id, start, end)
    return {"success": True, "data": leaderboard}


@router.get("/lifetime")
async def get_lifetime_stats(request: Request):
    """Get lifetime analytics summary"""
    team_id = require_team(request)

    summary = await team_analytics.get_analytics_summary_view(team_id)
    return {"success": True, "data": summary}
