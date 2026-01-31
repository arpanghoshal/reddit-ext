"""
Lead Scoring Service
Multi-factor lead scoring for intelligent targeting
"""

import os
from datetime import datetime, timedelta
from typing import Dict, Any, List, Optional
from supabase import create_client, Client

_supabase: Optional[Client] = None

# Scoring weights for different factors
SCORING_WEIGHTS = {
    "relevance_score": 0.25,        # Post classification relevance
    "buyer_intent": 0.20,            # Buyer intent signals
    "account_quality": 0.15,         # Account quality score
    "engagement_score": 0.15,        # User engagement level
    "timing_score": 0.10,            # Post recency
    "professional_signals": 0.10,    # Decision-maker indicators
    "previous_interactions": 0.05    # Past conversation success
}

# Lead tier thresholds
TIER_THRESHOLDS = {
    "hot": 70,
    "warm": 45,
    "cold": 0
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


def calculate_timing_score(post: Dict[str, Any]) -> float:
    """Calculate score based on post recency"""
    created_utc = post.get("created_utc", 0)

    if not created_utc:
        return 50  # Neutral if no timestamp

    # Convert to datetime
    if isinstance(created_utc, (int, float)):
        post_time = datetime.fromtimestamp(created_utc)
    else:
        return 50

    hours_old = (datetime.utcnow() - post_time).total_seconds() / 3600

    # Scoring based on recency
    if hours_old <= 2:
        return 100  # Very fresh - hot lead
    elif hours_old <= 6:
        return 90
    elif hours_old <= 12:
        return 80
    elif hours_old <= 24:
        return 70
    elif hours_old <= 48:
        return 55
    elif hours_old <= 72:
        return 40
    elif hours_old <= 168:  # 1 week
        return 25
    else:
        return 10  # Old post


def calculate_professional_score(user_profile: Dict[str, Any]) -> float:
    """Calculate score based on professional signals"""
    if not user_profile:
        return 50  # Neutral

    professional_signals = user_profile.get("professional_signals", {})

    score = 50  # Start at neutral

    # Decision maker bonus
    if professional_signals.get("is_decision_maker"):
        score += 30

    # Role indicators
    role_indicators = professional_signals.get("role_indicators", [])
    if "founder/entrepreneur" in role_indicators:
        score += 20
    elif "employed professional" in role_indicators:
        score += 10
    elif "freelancer/consultant" in role_indicators:
        score += 15

    # Detected signals
    signals = professional_signals.get("detected_signals", [])
    score += min(len(signals) * 5, 20)  # Up to 20 points for signals

    return min(100, score)


async def get_interaction_history_score(username: str) -> float:
    """Calculate score based on past interaction success"""
    client = get_client()
    if not client:
        return 50  # Neutral if no database

    try:
        # Check for any previous conversations with this user
        result = client.table("conversations").select(
            "status, has_reply"
        ).eq("participant_username", username.lower()).execute()

        if not result.data:
            return 50  # No previous interactions

        conversations = result.data

        # If we've had successful interactions before
        for conv in conversations:
            if conv.get("status") == "converted":
                return 100  # Previous conversion - very hot
            if conv.get("status") == "interested":
                return 85
            if conv.get("has_reply"):
                return 70  # They've responded before

        # If we've contacted but no response, slight penalty
        return 40

    except Exception as e:
        print(f"Error getting interaction history: {e}")
        return 50


async def calculate_lead_score(
    post: Dict[str, Any],
    classification: Dict[str, Any],
    qualification: Dict[str, Any],
    user_profile: Dict[str, Any] = None
) -> Dict[str, Any]:
    """
    Calculate comprehensive lead score

    Args:
        post: Reddit post data
        classification: Post classification result
        qualification: User qualification result
        user_profile: Optional user profile from user_analysis

    Returns:
        Lead score with breakdown and tier
    """
    # Extract individual scores
    component_scores = {}

    # 1. Relevance score from classification
    component_scores["relevance_score"] = classification.get("relevanceScore", 50)

    # 2. Buyer intent from classification
    component_scores["buyer_intent"] = classification.get("buyerIntent", 50)

    # 3. Account quality from qualification
    component_scores["account_quality"] = qualification.get("accountQualityScore", 50)

    # 4. Engagement score from qualification
    component_scores["engagement_score"] = qualification.get("engagementScore", 50)

    # 5. Timing score (post recency)
    component_scores["timing_score"] = calculate_timing_score(post)

    # 6. Professional signals
    component_scores["professional_signals"] = calculate_professional_score(user_profile)

    # 7. Previous interactions
    author = post.get("author", "")
    if author and author != "[deleted]":
        component_scores["previous_interactions"] = await get_interaction_history_score(author)
    else:
        component_scores["previous_interactions"] = 50

    # Calculate weighted final score
    final_score = sum(
        component_scores[key] * SCORING_WEIGHTS[key]
        for key in SCORING_WEIGHTS
    )

    # Determine tier
    if final_score >= TIER_THRESHOLDS["hot"]:
        tier = "hot"
        priority = 1
    elif final_score >= TIER_THRESHOLDS["warm"]:
        tier = "warm"
        priority = 2
    else:
        tier = "cold"
        priority = 3

    # Generate insights
    insights = generate_lead_insights(component_scores, tier)

    return {
        "score": round(final_score, 1),
        "tier": tier,
        "priority": priority,
        "component_scores": {k: round(v, 1) for k, v in component_scores.items()},
        "weights": SCORING_WEIGHTS,
        "insights": insights,
        "calculated_at": datetime.utcnow().isoformat()
    }


def generate_lead_insights(scores: Dict[str, float], tier: str) -> List[Dict[str, str]]:
    """Generate actionable insights from lead scores"""
    insights = []

    # Highlight strengths
    strengths = sorted(scores.items(), key=lambda x: x[1], reverse=True)[:2]
    for key, value in strengths:
        if value >= 70:
            insight_map = {
                "relevance_score": "Post is highly relevant to your business",
                "buyer_intent": "Strong buying signals detected",
                "account_quality": "High-quality Reddit account",
                "engagement_score": "Very engaged user",
                "timing_score": "Fresh post - act quickly",
                "professional_signals": "Decision-maker indicators present",
                "previous_interactions": "Positive past interactions"
            }
            if key in insight_map:
                insights.append({
                    "type": "strength",
                    "factor": key,
                    "message": insight_map[key]
                })

    # Highlight concerns
    concerns = sorted(scores.items(), key=lambda x: x[1])[:2]
    for key, value in concerns:
        if value < 40:
            concern_map = {
                "relevance_score": "Post may not be highly relevant",
                "buyer_intent": "Limited buying signals",
                "account_quality": "Account quality is lower",
                "engagement_score": "User engagement is low",
                "timing_score": "Post is getting older",
                "professional_signals": "No professional signals detected",
                "previous_interactions": "No response to previous outreach"
            }
            if key in concern_map:
                insights.append({
                    "type": "concern",
                    "factor": key,
                    "message": concern_map[key]
                })

    # Add tier-specific recommendations
    if tier == "hot":
        insights.append({
            "type": "recommendation",
            "message": "High priority - send personalized message immediately"
        })
    elif tier == "warm":
        insights.append({
            "type": "recommendation",
            "message": "Good prospect - personalize message based on their interests"
        })
    else:
        insights.append({
            "type": "recommendation",
            "message": "Lower priority - consider if worth outreach effort"
        })

    return insights


async def score_batch(
    leads: List[Dict[str, Any]]
) -> List[Dict[str, Any]]:
    """
    Score multiple leads in batch

    Args:
        leads: List of dicts with post, classification, qualification, user_profile

    Returns:
        List of scored leads
    """
    results = []

    for lead in leads:
        try:
            score = await calculate_lead_score(
                post=lead.get("post", {}),
                classification=lead.get("classification", {}),
                qualification=lead.get("qualification", {}),
                user_profile=lead.get("user_profile")
            )

            results.append({
                "post": lead.get("post"),
                "lead_score": score
            })
        except Exception as e:
            print(f"Error scoring lead: {e}")
            results.append({
                "post": lead.get("post"),
                "lead_score": {"error": str(e)}
            })

    # Sort by score (highest first)
    results.sort(
        key=lambda x: x.get("lead_score", {}).get("score", 0),
        reverse=True
    )

    return results


async def get_lead_score_stats(days: int = 7) -> Dict[str, Any]:
    """Get lead scoring statistics"""
    client = get_client()
    if not client:
        return {"error": "No database connection"}

    try:
        since = (datetime.utcnow() - timedelta(days=days)).isoformat()

        # Get recent DM queue items with scores
        result = client.table("dm_queue").select(
            "lead_score, status, created_at"
        ).gte("created_at", since).not_.is_("lead_score", "null").execute()

        if not result.data:
            return {
                "total_scored": 0,
                "by_tier": {"hot": 0, "warm": 0, "cold": 0}
            }

        leads = result.data

        # Calculate stats
        hot = len([l for l in leads if l.get("lead_score", {}).get("tier") == "hot"])
        warm = len([l for l in leads if l.get("lead_score", {}).get("tier") == "warm"])
        cold = len([l for l in leads if l.get("lead_score", {}).get("tier") == "cold"])

        # Calculate conversion rates by tier
        sent_leads = [l for l in leads if l.get("status") == "sent"]

        return {
            "total_scored": len(leads),
            "by_tier": {
                "hot": hot,
                "warm": warm,
                "cold": cold
            },
            "tier_percentages": {
                "hot": round(hot / max(len(leads), 1) * 100, 1),
                "warm": round(warm / max(len(leads), 1) * 100, 1),
                "cold": round(cold / max(len(leads), 1) * 100, 1)
            },
            "period_days": days
        }

    except Exception as e:
        print(f"Error getting lead score stats: {e}")
        return {"error": str(e)}


def should_auto_approve(lead_score: Dict[str, Any], settings: Dict[str, Any] = None) -> Dict[str, Any]:
    """
    Determine if a lead should be auto-approved based on score

    Args:
        lead_score: Lead score result
        settings: User settings for auto-approval thresholds

    Returns:
        Auto-approval decision
    """
    settings = settings or {}

    auto_approve_threshold = settings.get("auto_approve_threshold", 75)
    auto_reject_threshold = settings.get("auto_reject_threshold", 25)

    score = lead_score.get("score", 0)
    tier = lead_score.get("tier", "cold")

    if score >= auto_approve_threshold or tier == "hot":
        return {
            "decision": "auto_approve",
            "reason": f"Score {score} exceeds threshold {auto_approve_threshold}",
            "confidence": "high"
        }
    elif score <= auto_reject_threshold:
        return {
            "decision": "auto_reject",
            "reason": f"Score {score} below threshold {auto_reject_threshold}",
            "confidence": "high"
        }
    else:
        return {
            "decision": "manual_review",
            "reason": f"Score {score} requires manual review",
            "confidence": "medium"
        }
