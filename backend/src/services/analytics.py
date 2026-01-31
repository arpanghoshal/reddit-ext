"""
Analytics Service
Funnel tracking, ROI metrics, and actionable recommendations
"""

import os
from datetime import datetime, timedelta
from typing import Dict, Any, List, Optional
from collections import Counter
from supabase import create_client, Client

_supabase: Optional[Client] = None

# Funnel stages in order
FUNNEL_STAGES = [
    "post_identified",
    "post_qualified",
    "dm_generated",
    "dm_approved",
    "dm_sent",
    "reply_received",
    "positive_reply",
    "meeting_scheduled",
    "converted"
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


# =============================================================================
# FUNNEL ANALYTICS
# =============================================================================

async def log_funnel_event(
    stage: str,
    entity_type: str,
    entity_id: str,
    account_id: str = None,
    subreddit: str = None,
    metadata: Dict[str, Any] = None
) -> Optional[Dict[str, Any]]:
    """
    Log a funnel event

    Args:
        stage: Funnel stage name
        entity_type: Type of entity (post, dm, conversation)
        entity_id: Entity ID
        account_id: Optional account ID
        subreddit: Optional subreddit
        metadata: Optional additional data

    Returns:
        Created event
    """
    client = get_client()
    if not client:
        return None

    try:
        import uuid

        result = client.table("funnel_events").insert({
            "id": str(uuid.uuid4()),
            "stage": stage,
            "entity_type": entity_type,
            "entity_id": entity_id,
            "account_id": account_id,
            "subreddit": subreddit,
            "metadata": metadata or {},
            "created_at": datetime.utcnow().isoformat()
        }).execute()

        return result.data[0] if result.data else None
    except Exception as e:
        print(f"Error logging funnel event: {e}")
        return None


async def get_funnel_metrics(
    start_date: datetime = None,
    end_date: datetime = None,
    account_id: str = None,
    subreddit: str = None
) -> Dict[str, Any]:
    """
    Get conversion funnel metrics

    Args:
        start_date: Start of date range
        end_date: End of date range
        account_id: Filter by account
        subreddit: Filter by subreddit

    Returns:
        Funnel metrics with stage counts and conversion rates
    """
    client = get_client()
    if not client:
        return {"error": "No database connection"}

    # Default to last 30 days
    if not end_date:
        end_date = datetime.utcnow()
    if not start_date:
        start_date = end_date - timedelta(days=30)

    try:
        query = client.table("funnel_events").select(
            "stage, entity_id"
        ).gte(
            "created_at", start_date.isoformat()
        ).lte(
            "created_at", end_date.isoformat()
        )

        if account_id:
            query = query.eq("account_id", account_id)
        if subreddit:
            query = query.eq("subreddit", subreddit)

        result = query.execute()

        if not result.data:
            return {
                "stages": {stage: {"count": 0, "conversion_rate": 0} for stage in FUNNEL_STAGES},
                "overall_conversion": 0,
                "bottlenecks": [],
                "period": {"start": start_date.isoformat(), "end": end_date.isoformat()}
            }

        # Count unique entities per stage
        stage_counts = {}
        for stage in FUNNEL_STAGES:
            stage_events = [e for e in result.data if e.get("stage") == stage]
            unique_entities = len(set(e.get("entity_id") for e in stage_events))
            stage_counts[stage] = unique_entities

        # Calculate conversion rates
        stages = {}
        prev_count = None

        for stage in FUNNEL_STAGES:
            count = stage_counts.get(stage, 0)

            if prev_count is not None and prev_count > 0:
                conversion_rate = (count / prev_count) * 100
            else:
                conversion_rate = 100 if count > 0 else 0

            stages[stage] = {
                "count": count,
                "conversion_rate": round(conversion_rate, 1)
            }

            if count > 0:
                prev_count = count

        # Identify bottlenecks (biggest drop-offs)
        bottlenecks = identify_bottlenecks(stages)

        # Calculate overall conversion
        first_stage_count = stage_counts.get(FUNNEL_STAGES[0], 0)
        last_stage_count = stage_counts.get(FUNNEL_STAGES[-1], 0)
        overall_conversion = (last_stage_count / max(first_stage_count, 1)) * 100

        return {
            "stages": stages,
            "overall_conversion": round(overall_conversion, 2),
            "bottlenecks": bottlenecks,
            "period": {"start": start_date.isoformat(), "end": end_date.isoformat()}
        }

    except Exception as e:
        print(f"Error getting funnel metrics: {e}")
        return {"error": str(e)}


def identify_bottlenecks(stages: Dict[str, Dict]) -> List[Dict[str, Any]]:
    """Identify stages with biggest drop-offs"""
    bottlenecks = []

    stage_list = list(stages.items())

    for i in range(1, len(stage_list)):
        stage_name, data = stage_list[i]
        prev_name, prev_data = stage_list[i-1]

        drop_off = 100 - data["conversion_rate"]

        if drop_off > 50 and prev_data["count"] > 0:
            recommendation = get_bottleneck_recommendation(stage_name, drop_off)
            bottlenecks.append({
                "stage": stage_name,
                "from_stage": prev_name,
                "drop_off_rate": round(drop_off, 1),
                "recommendation": recommendation
            })

    # Sort by drop-off rate (highest first)
    bottlenecks.sort(key=lambda x: x["drop_off_rate"], reverse=True)

    return bottlenecks[:3]  # Top 3 bottlenecks


def get_bottleneck_recommendation(stage: str, drop_off: float) -> str:
    """Get recommendation for improving a bottleneck"""
    recommendations = {
        "post_qualified": "Review qualification criteria - may be too strict",
        "dm_generated": "Check LLM service availability and prompt quality",
        "dm_approved": "Consider auto-approval for high-scoring leads",
        "dm_sent": "Check account health and rate limits",
        "reply_received": "Improve message personalization with A/B testing",
        "positive_reply": "Review conversation handling and follow-up timing",
        "meeting_scheduled": "Add clear CTAs and make scheduling easy",
        "converted": "Review meeting-to-conversion process"
    }

    return recommendations.get(stage, "Analyze this stage for improvement opportunities")


# =============================================================================
# ROI METRICS
# =============================================================================

async def get_roi_metrics(
    start_date: datetime = None,
    end_date: datetime = None
) -> Dict[str, Any]:
    """
    Calculate ROI metrics

    Args:
        start_date: Start of date range
        end_date: End of date range

    Returns:
        ROI metrics
    """
    client = get_client()
    if not client:
        return {"error": "No database connection"}

    if not end_date:
        end_date = datetime.utcnow()
    if not start_date:
        start_date = end_date - timedelta(days=30)

    try:
        # Get DMs sent in period
        dm_result = client.table("dm_queue").select(
            "id, status, created_at"
        ).gte(
            "created_at", start_date.isoformat()
        ).lte(
            "created_at", end_date.isoformat()
        ).execute()

        dms = dm_result.data if dm_result.data else []
        dms_sent = len([d for d in dms if d.get("status") == "sent"])

        # Get conversions in period
        conv_result = client.table("conversions").select(
            "id, deal_value, converted_at"
        ).gte(
            "converted_at", start_date.isoformat()
        ).lte(
            "converted_at", end_date.isoformat()
        ).execute()

        conversions = conv_result.data if conv_result.data else []
        total_revenue = sum(c.get("deal_value", 0) or 0 for c in conversions)
        num_conversions = len(conversions)

        # Estimate AI API costs (rough estimate)
        # Assume ~$0.002 per DM generation + $0.001 per classification
        ai_cost_per_dm = 0.003
        estimated_ai_cost = dms_sent * ai_cost_per_dm

        # Calculate metrics
        cost_per_lead = estimated_ai_cost / max(num_conversions, 1)
        revenue_per_dm = total_revenue / max(dms_sent, 1)
        roi_percentage = ((total_revenue - estimated_ai_cost) / max(estimated_ai_cost, 0.01)) * 100

        # Estimate time saved (3 minutes per manual DM)
        time_saved_hours = (dms_sent * 3) / 60
        equivalent_salary_saved = time_saved_hours * 50  # $50/hr equivalent

        return {
            "period": {
                "start": start_date.isoformat(),
                "end": end_date.isoformat()
            },
            "activity": {
                "dms_sent": dms_sent,
                "conversions": num_conversions,
                "conversion_rate": round((num_conversions / max(dms_sent, 1)) * 100, 2)
            },
            "revenue": {
                "total": round(total_revenue, 2),
                "per_dm": round(revenue_per_dm, 2),
                "per_conversion": round(total_revenue / max(num_conversions, 1), 2)
            },
            "costs": {
                "estimated_ai_cost": round(estimated_ai_cost, 2),
                "cost_per_lead": round(cost_per_lead, 2)
            },
            "roi": {
                "percentage": round(roi_percentage, 1),
                "net_profit": round(total_revenue - estimated_ai_cost, 2)
            },
            "efficiency": {
                "time_saved_hours": round(time_saved_hours, 1),
                "equivalent_salary_saved": round(equivalent_salary_saved, 2)
            }
        }

    except Exception as e:
        print(f"Error calculating ROI metrics: {e}")
        return {"error": str(e)}


async def log_conversion(
    conversation_id: str,
    conversion_type: str,
    deal_value: float = 0,
    metadata: Dict[str, Any] = None
) -> Optional[Dict[str, Any]]:
    """
    Log a conversion event

    Args:
        conversation_id: Associated conversation ID
        conversion_type: Type of conversion (meeting, signup, purchase)
        deal_value: Monetary value of the deal
        metadata: Additional data

    Returns:
        Created conversion record
    """
    client = get_client()
    if not client:
        return None

    try:
        import uuid

        result = client.table("conversions").insert({
            "id": str(uuid.uuid4()),
            "conversation_id": conversation_id,
            "conversion_type": conversion_type,
            "deal_value": deal_value,
            "metadata": metadata or {},
            "converted_at": datetime.utcnow().isoformat()
        }).execute()

        # Also log funnel event
        await log_funnel_event(
            stage="converted",
            entity_type="conversation",
            entity_id=conversation_id,
            metadata={"conversion_type": conversion_type, "deal_value": deal_value}
        )

        return result.data[0] if result.data else None
    except Exception as e:
        print(f"Error logging conversion: {e}")
        return None


# =============================================================================
# PERFORMANCE BY DIMENSION
# =============================================================================

async def get_performance_by_subreddit(
    start_date: datetime = None,
    end_date: datetime = None,
    limit: int = 10
) -> List[Dict[str, Any]]:
    """Get performance metrics broken down by subreddit"""
    client = get_client()
    if not client:
        return []

    if not end_date:
        end_date = datetime.utcnow()
    if not start_date:
        start_date = end_date - timedelta(days=30)

    try:
        result = client.table("dm_queue").select(
            "subreddit, status"
        ).gte(
            "created_at", start_date.isoformat()
        ).lte(
            "created_at", end_date.isoformat()
        ).not_.is_("subreddit", "null").execute()

        if not result.data:
            return []

        # Aggregate by subreddit
        subreddit_stats = {}

        for dm in result.data:
            sub = dm.get("subreddit", "unknown")
            if sub not in subreddit_stats:
                subreddit_stats[sub] = {"total": 0, "sent": 0, "replied": 0}

            subreddit_stats[sub]["total"] += 1
            if dm.get("status") == "sent":
                subreddit_stats[sub]["sent"] += 1

        # Get reply counts from conversations
        for sub in subreddit_stats:
            conv_result = client.table("conversations").select(
                "id"
            ).eq("subreddit", sub).eq("has_reply", True).execute()

            if conv_result.data:
                subreddit_stats[sub]["replied"] = len(conv_result.data)

        # Convert to list and calculate rates
        performance = []
        for sub, stats in subreddit_stats.items():
            sent = stats["sent"]
            replied = stats["replied"]
            reply_rate = (replied / max(sent, 1)) * 100

            performance.append({
                "subreddit": sub,
                "dms_sent": sent,
                "replies_received": replied,
                "reply_rate": round(reply_rate, 1),
                "total_processed": stats["total"]
            })

        # Sort by DMs sent and limit
        performance.sort(key=lambda x: x["dms_sent"], reverse=True)
        return performance[:limit]

    except Exception as e:
        print(f"Error getting subreddit performance: {e}")
        return []


async def get_performance_by_day(
    start_date: datetime = None,
    end_date: datetime = None
) -> List[Dict[str, Any]]:
    """Get daily performance metrics"""
    client = get_client()
    if not client:
        return []

    if not end_date:
        end_date = datetime.utcnow()
    if not start_date:
        start_date = end_date - timedelta(days=30)

    try:
        result = client.table("dm_queue").select(
            "status, created_at, sent_at"
        ).gte(
            "created_at", start_date.isoformat()
        ).lte(
            "created_at", end_date.isoformat()
        ).execute()

        if not result.data:
            return []

        # Group by day
        daily_stats = {}

        for dm in result.data:
            # Use sent_at if available, otherwise created_at
            date_str = dm.get("sent_at") or dm.get("created_at")
            if date_str:
                day = date_str[:10]  # YYYY-MM-DD
                if day not in daily_stats:
                    daily_stats[day] = {"total": 0, "sent": 0, "failed": 0}

                daily_stats[day]["total"] += 1
                if dm.get("status") == "sent":
                    daily_stats[day]["sent"] += 1
                elif dm.get("status") == "failed":
                    daily_stats[day]["failed"] += 1

        # Convert to sorted list
        performance = []
        for day, stats in sorted(daily_stats.items()):
            performance.append({
                "date": day,
                "dms_sent": stats["sent"],
                "dms_failed": stats["failed"],
                "total": stats["total"],
                "success_rate": round((stats["sent"] / max(stats["total"], 1)) * 100, 1)
            })

        return performance

    except Exception as e:
        print(f"Error getting daily performance: {e}")
        return []


# =============================================================================
# RECOMMENDATIONS ENGINE
# =============================================================================

async def generate_recommendations() -> List[Dict[str, Any]]:
    """Generate actionable recommendations based on analytics data"""
    recommendations = []

    # Get recent metrics
    funnel = await get_funnel_metrics(
        start_date=datetime.utcnow() - timedelta(days=7)
    )

    roi = await get_roi_metrics(
        start_date=datetime.utcnow() - timedelta(days=7)
    )

    subreddit_perf = await get_performance_by_subreddit(
        start_date=datetime.utcnow() - timedelta(days=7),
        limit=20
    )

    # Check reply rate
    reply_stage = funnel.get("stages", {}).get("reply_received", {})
    if reply_stage.get("conversion_rate", 100) < 15:
        recommendations.append({
            "priority": "high",
            "category": "messaging",
            "title": "Low Reply Rate Detected",
            "description": f"Your reply rate is {reply_stage.get('conversion_rate', 0)}%. "
                          "This is below the target of 15%.",
            "action": {
                "type": "create_ab_test",
                "description": "Run A/B tests on message templates to improve personalization"
            },
            "expected_impact": "+20% reply rate with optimized messaging"
        })

    # Check for bottlenecks
    bottlenecks = funnel.get("bottlenecks", [])
    for bottleneck in bottlenecks[:1]:  # Top bottleneck
        if bottleneck.get("drop_off_rate", 0) > 60:
            recommendations.append({
                "priority": "high",
                "category": "funnel",
                "title": f"Major Bottleneck at {bottleneck.get('stage', 'unknown')}",
                "description": f"{bottleneck.get('drop_off_rate', 0)}% drop-off from "
                              f"{bottleneck.get('from_stage', 'previous stage')}",
                "action": {
                    "type": "investigate",
                    "description": bottleneck.get("recommendation", "Investigate this stage")
                },
                "expected_impact": "Significant funnel improvement"
            })

    # Check subreddit performance
    if subreddit_perf:
        top_performers = [s for s in subreddit_perf if s.get("reply_rate", 0) > 15]
        underperformers = [s for s in subreddit_perf if s.get("reply_rate", 0) < 5 and s.get("dms_sent", 0) > 10]

        if underperformers and top_performers:
            recommendations.append({
                "priority": "medium",
                "category": "targeting",
                "title": "Refocus Subreddit Targeting",
                "description": f"Subreddits {', '.join(s['subreddit'] for s in underperformers[:3])} "
                              f"have <5% reply rate. Consider reallocating to top performers.",
                "action": {
                    "type": "update_subreddit_assignments",
                    "add": [s["subreddit"] for s in top_performers[:3]],
                    "reduce": [s["subreddit"] for s in underperformers[:3]]
                },
                "expected_impact": "+15% overall conversion"
            })

    # Check ROI
    if roi.get("roi", {}).get("percentage", 100) < 0:
        recommendations.append({
            "priority": "critical",
            "category": "roi",
            "title": "Negative ROI Detected",
            "description": "Current outreach is costing more than it generates.",
            "action": {
                "type": "review_strategy",
                "description": "Focus on higher-quality leads and improve conversion rates"
            },
            "expected_impact": "Return to positive ROI"
        })

    # Sort by priority
    priority_order = {"critical": 0, "high": 1, "medium": 2, "low": 3}
    recommendations.sort(key=lambda x: priority_order.get(x.get("priority"), 99))

    return recommendations


async def get_dashboard_summary() -> Dict[str, Any]:
    """Get summary data for dashboard display"""
    now = datetime.utcnow()
    today_start = now.replace(hour=0, minute=0, second=0, microsecond=0)
    week_start = today_start - timedelta(days=7)
    month_start = today_start - timedelta(days=30)

    # Get key metrics
    today_funnel = await get_funnel_metrics(start_date=today_start)
    week_funnel = await get_funnel_metrics(start_date=week_start)

    roi = await get_roi_metrics(start_date=month_start)
    recommendations = await generate_recommendations()

    # Get DM counts
    client = get_client()
    today_dms = 0
    week_dms = 0

    if client:
        try:
            today_result = client.table("dm_queue").select(
                "id"
            ).eq("status", "sent").gte("sent_at", today_start.isoformat()).execute()
            today_dms = len(today_result.data) if today_result.data else 0

            week_result = client.table("dm_queue").select(
                "id"
            ).eq("status", "sent").gte("sent_at", week_start.isoformat()).execute()
            week_dms = len(week_result.data) if week_result.data else 0
        except:
            pass

    return {
        "overview": {
            "dms_today": today_dms,
            "dms_this_week": week_dms,
            "reply_rate_week": week_funnel.get("stages", {}).get("reply_received", {}).get("conversion_rate", 0),
            "overall_conversion": week_funnel.get("overall_conversion", 0)
        },
        "roi_summary": {
            "total_revenue": roi.get("revenue", {}).get("total", 0),
            "roi_percentage": roi.get("roi", {}).get("percentage", 0),
            "time_saved_hours": roi.get("efficiency", {}).get("time_saved_hours", 0)
        },
        "top_recommendations": recommendations[:3],
        "bottlenecks": week_funnel.get("bottlenecks", [])[:2]
    }
