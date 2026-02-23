"""
Team Analytics Service
Aggregated analytics for team performance tracking
"""

import logging
import os
from datetime import datetime, timedelta, date
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


async def get_team_analytics(
    team_id: str,
    start_date: Optional[date] = None,
    end_date: Optional[date] = None
) -> Dict[str, Any]:
    """Get comprehensive team analytics for a date range"""
    client = get_client()
    if not client:
        return {}

    # Default to last 30 days
    if not end_date:
        end_date = date.today()
    if not start_date:
        start_date = end_date - timedelta(days=30)

    try:
        return {
            "summary": await get_summary_stats(team_id, start_date, end_date),
            "daily_breakdown": await get_daily_stats(team_id, start_date, end_date),
            "hourly_heatmap": await get_hourly_activity(team_id, start_date, end_date),
            "member_breakdown": await get_member_stats(team_id, start_date, end_date),
            "period": {
                "start_date": start_date.isoformat(),
                "end_date": end_date.isoformat(),
                "days": (end_date - start_date).days + 1
            }
        }
    except Exception as e:
        logger.error(f"Error fetching team analytics: {e}")
        return {}


async def get_summary_stats(
    team_id: str,
    start_date: date,
    end_date: date
) -> Dict[str, Any]:
    """Get summary statistics for a team"""
    client = get_client()
    if not client:
        return {}

    try:
        result = client.table("team_daily_stats").select("*").eq(
            "team_id", team_id
        ).gte("date", start_date.isoformat()).lte(
            "date", end_date.isoformat()
        ).execute()

        data = result.data or []

        if not data:
            return {
                "total_dms_sent": 0,
                "total_responses": 0,
                "response_rate": 0,
                "leads_generated": 0,
                "positive_responses": 0,
                "avg_response_time": None,
                "active_days": 0
            }

        total_dms = sum(d.get("dms_sent", 0) for d in data)
        total_responses = sum(d.get("response_count", 0) for d in data)
        total_leads = sum(d.get("leads_generated", 0) for d in data)
        total_positive = sum(d.get("positive_responses", 0) for d in data)

        response_times = [d.get("avg_response_time_mins") for d in data if d.get("avg_response_time_mins")]
        avg_response_time = sum(response_times) / len(response_times) if response_times else None

        return {
            "total_dms_sent": total_dms,
            "total_responses": total_responses,
            "response_rate": round((total_responses / total_dms * 100), 1) if total_dms > 0 else 0,
            "leads_generated": total_leads,
            "positive_responses": total_positive,
            "positive_rate": round((total_positive / total_responses * 100), 1) if total_responses > 0 else 0,
            "avg_response_time_mins": round(avg_response_time, 1) if avg_response_time else None,
            "active_days": len(data),
            "avg_dms_per_day": round(total_dms / len(data), 1) if data else 0
        }
    except Exception as e:
        logger.error(f"Error fetching summary stats: {e}")
        return {}


async def get_daily_stats(
    team_id: str,
    start_date: date,
    end_date: date
) -> List[Dict[str, Any]]:
    """Get daily breakdown of stats"""
    client = get_client()
    if not client:
        return []

    try:
        result = client.table("team_daily_stats").select("*").eq(
            "team_id", team_id
        ).gte("date", start_date.isoformat()).lte(
            "date", end_date.isoformat()
        ).order("date").execute()

        return result.data or []
    except Exception as e:
        logger.error(f"Error fetching daily stats: {e}")
        return []


async def get_hourly_activity(
    team_id: str,
    start_date: date,
    end_date: date
) -> Dict[str, Any]:
    """Get hourly activity heatmap data"""
    client = get_client()
    if not client:
        return {}

    try:
        result = client.table("team_hourly_activity").select("*").eq(
            "team_id", team_id
        ).gte("date", start_date.isoformat()).lte(
            "date", end_date.isoformat()
        ).execute()

        data = result.data or []

        # Aggregate by hour and day of week
        hourly_totals = {i: {"dms_sent": 0, "responses": 0} for i in range(24)}
        day_of_week_totals = {i: {"dms_sent": 0, "responses": 0} for i in range(7)}

        for entry in data:
            hour = entry.get("hour", 0)
            hourly_totals[hour]["dms_sent"] += entry.get("dms_sent", 0)
            hourly_totals[hour]["responses"] += entry.get("responses", 0)

            entry_date = datetime.fromisoformat(entry.get("date")).date()
            day_of_week = entry_date.weekday()
            day_of_week_totals[day_of_week]["dms_sent"] += entry.get("dms_sent", 0)
            day_of_week_totals[day_of_week]["responses"] += entry.get("responses", 0)

        # Find best hours/days
        best_hour = max(hourly_totals, key=lambda h: hourly_totals[h]["responses"])
        best_day = max(day_of_week_totals, key=lambda d: day_of_week_totals[d]["responses"])

        day_names = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"]

        return {
            "by_hour": hourly_totals,
            "by_day_of_week": {day_names[k]: v for k, v in day_of_week_totals.items()},
            "best_hour": best_hour,
            "best_day": day_names[best_day],
            "recommendation": f"Best engagement: {day_names[best_day]}s around {best_hour}:00"
        }
    except Exception as e:
        logger.error(f"Error fetching hourly activity: {e}")
        return {}


async def get_member_stats(
    team_id: str,
    start_date: date,
    end_date: date
) -> List[Dict[str, Any]]:
    """Get per-member performance stats"""
    client = get_client()
    if not client:
        return []

    try:
        result = client.table("member_stats").select(
            "user_id, dms_sent, dms_approved, responses"
        ).eq(
            "team_id", team_id
        ).gte("date", start_date.isoformat()).lte(
            "date", end_date.isoformat()
        ).execute()

        data = result.data or []

        # Aggregate by user
        user_totals = {}
        for entry in data:
            user_id = entry.get("user_id")
            if user_id not in user_totals:
                user_totals[user_id] = {
                    "user_id": user_id,
                    "dms_sent": 0,
                    "dms_approved": 0,
                    "responses": 0
                }
            user_totals[user_id]["dms_sent"] += entry.get("dms_sent", 0)
            user_totals[user_id]["dms_approved"] += entry.get("dms_approved", 0)
            user_totals[user_id]["responses"] += entry.get("responses", 0)

        # Get user profiles
        if user_totals:
            profiles = client.table("profiles").select("id, email, full_name").in_(
                "id", list(user_totals.keys())
            ).execute()

            profile_map = {p["id"]: p for p in (profiles.data or [])}

            for user_id, stats in user_totals.items():
                profile = profile_map.get(user_id, {})
                stats["email"] = profile.get("email", "Unknown")
                stats["name"] = profile.get("full_name", "Unknown")

        # Sort by DMs sent
        leaderboard = sorted(
            user_totals.values(),
            key=lambda x: x["dms_sent"],
            reverse=True
        )

        return leaderboard
    except Exception as e:
        logger.error(f"Error fetching member stats: {e}")
        return []


async def record_dm_sent(
    team_id: str,
    user_id: Optional[str] = None
):
    """Record a DM being sent - updates all analytics tables"""
    client = get_client()
    if not client:
        return

    try:
        now = datetime.utcnow()
        today = now.date()
        hour = now.hour

        # Increment daily stat
        client.rpc("increment_daily_stat", {
            "p_team_id": team_id,
            "p_date": today.isoformat(),
            "p_metric": "dms_sent",
            "p_amount": 1
        }).execute()

        # Increment hourly activity
        client.rpc("increment_hourly_activity", {
            "p_team_id": team_id,
            "p_date": today.isoformat(),
            "p_hour": hour,
            "p_metric": "dms_sent",
            "p_amount": 1
        }).execute()

        # Increment member stat if user provided
        if user_id:
            client.rpc("increment_member_stat", {
                "p_team_id": team_id,
                "p_user_id": user_id,
                "p_date": today.isoformat(),
                "p_metric": "dms_sent",
                "p_amount": 1
            }).execute()

    except Exception as e:
        logger.error(f"Error recording DM sent: {e}")


async def record_response_received(
    team_id: str,
    is_positive: bool = False,
    response_time_mins: Optional[float] = None
):
    """Record a response being received"""
    client = get_client()
    if not client:
        return

    try:
        now = datetime.utcnow()
        today = now.date()
        hour = now.hour

        # Increment response count
        client.rpc("increment_daily_stat", {
            "p_team_id": team_id,
            "p_date": today.isoformat(),
            "p_metric": "response_count",
            "p_amount": 1
        }).execute()

        # Increment positive if applicable
        if is_positive:
            client.rpc("increment_daily_stat", {
                "p_team_id": team_id,
                "p_date": today.isoformat(),
                "p_metric": "positive_responses",
                "p_amount": 1
            }).execute()

        # Increment hourly responses
        client.rpc("increment_hourly_activity", {
            "p_team_id": team_id,
            "p_date": today.isoformat(),
            "p_hour": hour,
            "p_metric": "responses",
            "p_amount": 1
        }).execute()

        # Update average response time if provided
        if response_time_mins is not None:
            # For simplicity, just update to the new value
            # A more sophisticated approach would maintain a running average
            client.table("team_daily_stats").update({
                "avg_response_time_mins": response_time_mins
            }).eq("team_id", team_id).eq("date", today.isoformat()).execute()

    except Exception as e:
        logger.error(f"Error recording response: {e}")


async def get_analytics_summary_view(team_id: str) -> Dict[str, Any]:
    """Get analytics from the summary view"""
    client = get_client()
    if not client:
        return {}

    try:
        result = client.table("team_analytics_summary").select("*").eq(
            "team_id", team_id
        ).execute()

        return result.data[0] if result.data else {}
    except Exception as e:
        logger.error(f"Error fetching analytics summary: {e}")
        return {}
