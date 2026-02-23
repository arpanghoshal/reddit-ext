"""
Safety Service
Handles shadowban detection, safety event logging, and humanization
"""

import os
import math
import random
import asyncio
from datetime import datetime, timedelta
from typing import Dict, Any, List, Optional, Tuple
import httpx
from supabase import create_client, Client
import logging

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


async def check_shadowban(username: str) -> Dict[str, Any]:
    """
    Check if a Reddit account is shadowbanned via ScrapeCreators API.
    If the user profile returns no data, likely shadowbanned or suspended.
    """
    from . import reddit_search

    try:
        # Check if profile is accessible via ScrapeCreators
        user_data = await reddit_search.get_user_about(username)

        if not user_data:
            return {
                "isShadowbanned": True,
                "method": "profile_not_found",
                "details": {"message": "Profile not accessible - likely shadowbanned or suspended"}
            }

        # Check for suspended account
        if user_data.get("is_suspended"):
            return {
                "isShadowbanned": False,
                "method": "suspended",
                "details": {"message": "Account is suspended (not shadowbanned)"}
            }

        # Check if user has visible posts
        posts = await reddit_search.get_user_posts(username, limit=5)
        if not posts:
            # No posts could mean shadowbanned or just a lurker
            return {
                "isShadowbanned": False,
                "method": "no_posts",
                "details": {"message": "No visible posts found - could be lurker or shadowbanned"}
            }

        return {
            "isShadowbanned": False,
            "method": "verified_clean",
            "details": {"message": "No shadowban indicators detected"}
        }

    except Exception as e:
        return {
            "isShadowbanned": False,
            "method": "error",
            "details": {"message": str(e)}
        }


async def log_safety_event(event: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    """Log a safety event"""
    client = get_client()
    if not client:
        logger.warning(f"Safety event (not logged): {event.get('eventType', 'unknown')}")
        return None

    try:
        result = client.table("safety_events").insert({
            "account_id": event.get("accountId"),
            "event_type": event.get("eventType"),
            "details": event.get("details", {})
        }).execute()

        return result.data[0] if result.data else None
    except Exception as e:
        logger.error(f"Error logging safety event: {e}")
        return None


async def get_safety_events(filters: Dict[str, Any] = None) -> List[Dict[str, Any]]:
    """Get safety events with filters"""
    client = get_client()
    if not client:
        return []

    filters = filters or {}

    try:
        query = client.table("safety_events").select("*").order("created_at", desc=True)

        if filters.get("accountId"):
            query = query.eq("account_id", filters["accountId"])

        if filters.get("eventType"):
            query = query.eq("event_type", filters["eventType"])

        if filters.get("since"):
            query = query.gte("created_at", filters["since"])

        if filters.get("limit"):
            query = query.limit(filters["limit"])

        result = query.execute()
        return result.data if result.data else []
    except Exception as e:
        logger.error(f"Error fetching safety events: {e}")
        return []


def calculate_humanized_delay(options: Dict[str, Any] = None) -> int:
    """
    Calculate humanized delay with Gaussian distribution
    More natural than uniform random
    """
    options = options or {}

    min_delay = options.get("minDelay", 30000)       # 30 seconds minimum
    max_delay = options.get("maxDelay", 180000)      # 3 minutes maximum
    center = options.get("center", 60000)            # 1 minute center
    std_dev = options.get("stdDev", 30000)           # 30 seconds std deviation
    warmup_multiplier = options.get("warmupMultiplier", 1)

    # Box-Muller transform for Gaussian distribution
    u1 = random.random()
    u2 = random.random()
    gaussian = math.sqrt(-2 * math.log(u1)) * math.cos(2 * math.pi * u2)

    # Calculate delay using Gaussian distribution
    delay = center + (gaussian * std_dev)

    # Clamp to min/max
    delay = max(min_delay, min(max_delay, delay))

    # Apply warmup multiplier
    delay *= warmup_multiplier

    # Add micro-jitter (1-3 seconds)
    delay += random.random() * 2000 + 1000

    return round(delay)


def should_take_session_break(session_stats: Dict[str, Any]) -> Dict[str, Any]:
    """Determine if a session break should be taken"""
    dms_since_last_break = session_stats.get("dmsSinceLastBreak", 0)
    min_dms_before_break = session_stats.get("minDmsBeforeBreak", 5)
    max_dms_before_break = session_stats.get("maxDmsBeforeBreak", 15)
    break_probability_per_dm = session_stats.get("breakProbabilityPerDm", 0.1)

    # Force break if max reached
    if dms_since_last_break >= max_dms_before_break:
        return {"shouldBreak": True, "reason": "max_dms_reached"}

    # No break if below minimum
    if dms_since_last_break < min_dms_before_break:
        return {"shouldBreak": False}

    # Probabilistic break with increasing probability
    probability = break_probability_per_dm * (dms_since_last_break - min_dms_before_break + 1)
    if random.random() < probability:
        return {"shouldBreak": True, "reason": "probabilistic"}

    return {"shouldBreak": False}


def calculate_break_duration(options: Dict[str, Any] = None) -> int:
    """Calculate session break duration"""
    options = options or {}

    min_duration = options.get("minDuration", 300000)    # 5 minutes
    max_duration = options.get("maxDuration", 1800000)   # 30 minutes

    # Use weighted random - prefer shorter breaks
    rand = random.random() ** 1.5  # Skewed towards 0
    duration = min_duration + (rand * (max_duration - min_duration))

    return round(duration)


def calculate_typing_delay(char: str, prev_char: str = "", base_speed: int = 100) -> int:
    """
    Calculate typing delay for a character
    Simulates human typing patterns
    """
    delay = float(base_speed)

    # Slower for punctuation (thinking pause)
    if char in ".!?":
        delay *= 2 + random.random()
    # Slightly slower after space (word boundary)
    elif char == " ":
        delay *= 1.2 + (random.random() * 0.5)
    # Faster for repeated characters
    elif prev_char == char:
        delay *= 0.7
    # Slower for uppercase (shift key)
    elif char.isupper() and char.lower() != char:
        delay *= 1.3

    # Add natural variance (-30% to +50%)
    delay *= 0.7 + (random.random() * 0.8)

    return round(delay)


def should_simulate_typo(options: Dict[str, Any] = None) -> Dict[str, Any]:
    """Decide if a typo should be simulated"""
    options = options or {}

    typo_probability = options.get("typoProbability", 0.01)  # 1% chance per character
    enabled = options.get("enabled", False)

    if not enabled:
        return {"shouldTypo": False}

    if random.random() < typo_probability:
        return {
            "shouldTypo": True,
            "correction": {
                # Random delay before noticing typo
                "noticeDelay": 200 + random.random() * 400,
                # Delay to delete typo
                "deleteDelay": 100 + random.random() * 100
            }
        }

    return {"shouldTypo": False}


def get_typo_character(char: str) -> str:
    """Get a random adjacent key for typo simulation"""
    keyboard = {
        "q": ["w", "a"],
        "w": ["q", "e", "s", "a"],
        "e": ["w", "r", "d", "s"],
        "r": ["e", "t", "f", "d"],
        "t": ["r", "y", "g", "f"],
        "y": ["t", "u", "h", "g"],
        "u": ["y", "i", "j", "h"],
        "i": ["u", "o", "k", "j"],
        "o": ["i", "p", "l", "k"],
        "p": ["o", "l"],
        "a": ["q", "w", "s", "z"],
        "s": ["a", "w", "e", "d", "z", "x"],
        "d": ["s", "e", "r", "f", "x", "c"],
        "f": ["d", "r", "t", "g", "c", "v"],
        "g": ["f", "t", "y", "h", "v", "b"],
        "h": ["g", "y", "u", "j", "b", "n"],
        "j": ["h", "u", "i", "k", "n", "m"],
        "k": ["j", "i", "o", "l", "m"],
        "l": ["k", "o", "p"],
        "z": ["a", "s", "x"],
        "x": ["z", "s", "d", "c"],
        "c": ["x", "d", "f", "v"],
        "v": ["c", "f", "g", "b"],
        "b": ["v", "g", "h", "n"],
        "n": ["b", "h", "j", "m"],
        "m": ["n", "j", "k"]
    }

    lower_char = char.lower()
    adjacent_keys = keyboard.get(lower_char)

    if not adjacent_keys:
        return char  # No adjacent keys, return original

    typo = random.choice(adjacent_keys)

    # Preserve case
    return typo.upper() if char.isupper() else typo


async def get_account_health(account_id: str) -> Dict[str, Any]:
    """Get account health summary"""
    client = get_client()
    if not client:
        return {"warnings": [], "status": "unknown"}

    try:
        # Get recent safety events
        seven_days_ago = (datetime.utcnow() - timedelta(days=7)).isoformat()
        events = await get_safety_events({
            "accountId": account_id,
            "since": seven_days_ago,
            "limit": 50
        })

        warnings = []

        # Check for shadowban events
        shadowban_events = [e for e in events if e.get("event_type") == "shadowban_detected"]
        if shadowban_events:
            warnings.append({
                "level": "critical",
                "message": "Shadowban detected",
                "lastOccurred": shadowban_events[0].get("created_at")
            })

        # Check for high failure rate
        failed_events = [e for e in events if e.get("event_type") == "dm_failed"]
        if len(failed_events) > 5:
            warnings.append({
                "level": "warning",
                "message": f"High failure rate: {len(failed_events)} failures in last 7 days",
                "lastOccurred": failed_events[0].get("created_at")
            })

        # Check for rate limit hits
        rate_limit_events = [e for e in events if e.get("event_type") == "rate_limit_hit"]
        if rate_limit_events:
            warnings.append({
                "level": "warning",
                "message": "Rate limits being hit frequently",
                "lastOccurred": rate_limit_events[0].get("created_at")
            })

        status = "critical" if any(w["level"] == "critical" for w in warnings) else \
                 "warning" if warnings else "healthy"

        return {"warnings": warnings, "status": status, "recentEvents": events[:10]}
    except Exception as e:
        logger.error(f"Error getting account health: {e}")
        return {"warnings": [], "status": "unknown", "error": str(e)}


# =============================================================================
# PROACTIVE SHADOWBAN PREVENTION
# =============================================================================

# Risk thresholds for shadowban prevention
RISK_THRESHOLDS = {
    "daily_dm_velocity": 25,         # Max DMs per day threshold
    "hourly_dm_velocity": 5,          # Max DMs per hour
    "same_subreddit_ratio": 0.5,      # Max % to same subreddit
    "template_similarity": 0.85,      # Max message similarity
    "rejection_rate": 0.1,            # Max rejection/block rate
    "high_risk_threshold": 0.7,       # Risk level to pause account
    "medium_risk_threshold": 0.5      # Risk level to reduce velocity
}


async def get_recent_dm_activity(account_id: str, hours: int = 24) -> Dict[str, Any]:
    """Get recent DM activity for an account"""
    client = get_client()
    if not client:
        return {"dms": [], "count": 0}

    try:
        since = (datetime.utcnow() - timedelta(hours=hours)).isoformat()

        result = client.table("dm_queue").select(
            "id, recipient_username, subreddit, generated_message, status, created_at, sent_at"
        ).eq("account_id", account_id).gte("created_at", since).execute()

        dms = result.data if result.data else []

        return {
            "dms": dms,
            "count": len(dms),
            "sent_count": len([d for d in dms if d.get("status") == "sent"]),
            "failed_count": len([d for d in dms if d.get("status") == "failed"]),
            "rejected_count": len([d for d in dms if d.get("status") == "rejected"])
        }
    except Exception as e:
        logger.error(f"Error getting recent DM activity: {e}")
        return {"dms": [], "count": 0}


def assess_velocity_risk(activity: Dict[str, Any]) -> float:
    """Assess risk based on DM velocity"""
    sent_count = activity.get("sent_count", 0)
    daily_threshold = RISK_THRESHOLDS["daily_dm_velocity"]

    # Calculate velocity risk (0-1)
    velocity_ratio = sent_count / max(daily_threshold, 1)

    if velocity_ratio >= 1.0:
        return 1.0  # At or over limit
    elif velocity_ratio >= 0.8:
        return 0.7
    elif velocity_ratio >= 0.6:
        return 0.4
    elif velocity_ratio >= 0.4:
        return 0.2
    return 0.0


def assess_pattern_risk(dms: List[Dict[str, Any]]) -> float:
    """Assess risk based on DM patterns"""
    if not dms:
        return 0.0

    # Check subreddit concentration
    subreddits = [d.get("subreddit") for d in dms if d.get("subreddit")]
    if subreddits:
        from collections import Counter
        sub_counts = Counter(subreddits)
        most_common_ratio = sub_counts.most_common(1)[0][1] / len(subreddits)

        if most_common_ratio > RISK_THRESHOLDS["same_subreddit_ratio"]:
            return 0.6  # High concentration in one subreddit

    # Check timing patterns (too regular = bot-like)
    timestamps = []
    for d in dms:
        sent_at = d.get("sent_at")
        if sent_at:
            try:
                if isinstance(sent_at, str):
                    timestamps.append(datetime.fromisoformat(sent_at.replace("Z", "+00:00")))
            except:
                pass

    if len(timestamps) >= 3:
        timestamps.sort()
        intervals = [
            (timestamps[i+1] - timestamps[i]).total_seconds()
            for i in range(len(timestamps) - 1)
        ]

        # Check if intervals are too regular (within 10% variance)
        if intervals:
            avg_interval = sum(intervals) / len(intervals)
            if avg_interval > 0:
                variance = sum(abs(i - avg_interval) / avg_interval for i in intervals) / len(intervals)
                if variance < 0.1:  # Very regular pattern
                    return 0.5

    return 0.0


def assess_rejection_risk(activity: Dict[str, Any]) -> float:
    """Assess risk based on rejection/failure rate"""
    total = activity.get("sent_count", 0) + activity.get("failed_count", 0)
    if total == 0:
        return 0.0

    failed = activity.get("failed_count", 0)
    rejected = activity.get("rejected_count", 0)

    rejection_rate = (failed + rejected) / total

    if rejection_rate >= RISK_THRESHOLDS["rejection_rate"] * 2:
        return 0.8
    elif rejection_rate >= RISK_THRESHOLDS["rejection_rate"]:
        return 0.5
    return rejection_rate * 3  # Scale up smaller rates


async def assess_content_similarity(dms: List[Dict[str, Any]]) -> float:
    """Assess risk based on message content similarity"""
    messages = [d.get("generated_message", "") for d in dms if d.get("generated_message")]

    if len(messages) < 3:
        return 0.0

    # Simple similarity check using common phrases
    from collections import Counter

    # Extract common n-grams
    all_ngrams = []
    for msg in messages:
        words = msg.lower().split()
        ngrams = [" ".join(words[i:i+3]) for i in range(len(words) - 2)]
        all_ngrams.extend(ngrams)

    if not all_ngrams:
        return 0.0

    ngram_counts = Counter(all_ngrams)
    most_common = ngram_counts.most_common(5)

    # If any n-gram appears in more than 80% of messages, high similarity
    for ngram, count in most_common:
        if count / len(messages) > RISK_THRESHOLDS["template_similarity"]:
            return 0.7

    return 0.0


async def assess_risk_level(account_id: str) -> Dict[str, Any]:
    """
    Comprehensive risk assessment for shadowban prevention

    Returns:
        Risk assessment with level (0-1), category, and recommendations
    """
    # Get recent activity
    activity = await get_recent_dm_activity(account_id, hours=24)
    dms = activity.get("dms", [])

    # Calculate individual risk factors
    risk_factors = {
        "velocity_risk": assess_velocity_risk(activity),
        "pattern_risk": assess_pattern_risk(dms),
        "rejection_risk": assess_rejection_risk(activity),
        "content_risk": await assess_content_similarity(dms)
    }

    # Weight and combine risks
    weights = {
        "velocity_risk": 0.35,
        "pattern_risk": 0.25,
        "rejection_risk": 0.25,
        "content_risk": 0.15
    }

    overall_risk = sum(
        risk_factors[key] * weights[key]
        for key in weights
    )

    # Determine risk category
    if overall_risk >= RISK_THRESHOLDS["high_risk_threshold"]:
        risk_category = "high"
    elif overall_risk >= RISK_THRESHOLDS["medium_risk_threshold"]:
        risk_category = "medium"
    else:
        risk_category = "low"

    # Generate recommendations
    recommendations = []

    if overall_risk >= RISK_THRESHOLDS["high_risk_threshold"]:
        recommendations.append({
            "action": "pause_account",
            "duration_hours": 12,
            "reason": "High shadowban risk detected - pause to protect account"
        })
    elif overall_risk >= RISK_THRESHOLDS["medium_risk_threshold"]:
        recommendations.append({
            "action": "reduce_velocity",
            "factor": 0.5,
            "reason": "Elevated risk - reduce sending rate by 50%"
        })

    if risk_factors["pattern_risk"] > 0.4:
        recommendations.append({
            "action": "diversify_subreddits",
            "reason": "Activity too concentrated in few subreddits"
        })

    if risk_factors["content_risk"] > 0.5:
        recommendations.append({
            "action": "vary_messages",
            "reason": "Messages too similar - add more variation"
        })

    return {
        "risk_level": round(overall_risk, 3),
        "risk_category": risk_category,
        "factors": risk_factors,
        "recommendations": recommendations,
        "activity_summary": {
            "dms_24h": activity.get("sent_count", 0),
            "failed_24h": activity.get("failed_count", 0)
        }
    }


def calculate_adaptive_delay(
    base_delay: int,
    risk_assessment: Dict[str, Any],
    last_action_result: str = "success"
) -> int:
    """
    Calculate adaptive delay based on risk level and last action result

    Args:
        base_delay: Base delay in milliseconds
        risk_assessment: Risk assessment from assess_risk_level
        last_action_result: Result of last action (success, error, rate_limited)

    Returns:
        Adjusted delay in milliseconds
    """
    risk_level = risk_assessment.get("risk_level", 0)

    # Base multiplier from risk level (1x to 3x)
    risk_multiplier = 1 + (risk_level * 2)

    # Adjust based on last action result
    result_multiplier = {
        "success": 1.0,
        "error": 2.0,
        "rate_limited": 5.0,
        "failed": 1.5
    }.get(last_action_result, 1.0)

    # Time of day adjustment (Reddit staff hours PST = 14:00-22:00 UTC)
    hour = datetime.utcnow().hour
    time_multiplier = 1.2 if 14 <= hour <= 22 else 1.0

    # Calculate final delay
    delay = base_delay * risk_multiplier * result_multiplier * time_multiplier

    # Add jitter (10-20% variation)
    jitter = delay * (0.1 + random.random() * 0.1)
    delay += jitter

    # Enforce minimum and maximum bounds
    min_delay = 30000   # 30 seconds minimum
    max_delay = 600000  # 10 minutes maximum

    return round(max(min_delay, min(max_delay, delay)))


def get_safe_daily_limit(account: Dict[str, Any], risk_assessment: Dict[str, Any]) -> int:
    """
    Calculate safe daily limit based on account health and risk

    Args:
        account: Account data
        risk_assessment: Current risk assessment

    Returns:
        Safe daily limit
    """
    base_limit = account.get("daily_limit", 20)

    # Apply warmup reduction if applicable
    if account.get("warmup_mode"):
        warmup_schedule = [3, 5, 8, 12, 18, 25, 35, 50]
        warmup_start = account.get("warmup_started_at")

        if warmup_start:
            try:
                if isinstance(warmup_start, str):
                    warmup_start = datetime.fromisoformat(warmup_start.replace("Z", "+00:00"))
                warmup_days = (datetime.utcnow().replace(tzinfo=warmup_start.tzinfo) - warmup_start).days
                warmup_limit = warmup_schedule[min(warmup_days, len(warmup_schedule) - 1)]
                base_limit = min(warmup_limit, base_limit)
            except:
                pass

    # Apply risk reduction
    risk_level = risk_assessment.get("risk_level", 0)
    if risk_level >= RISK_THRESHOLDS["high_risk_threshold"]:
        base_limit = int(base_limit * 0.25)  # 75% reduction
    elif risk_level >= RISK_THRESHOLDS["medium_risk_threshold"]:
        base_limit = int(base_limit * 0.5)   # 50% reduction

    # Minimum of 3 per day
    return max(3, base_limit)


# =============================================================================
# CROSS-ACCOUNT DUPLICATE DETECTION
# =============================================================================

async def check_duplicate_recipient(
    recipient_username: str,
    exclude_account_id: str = None,
    lookback_days: int = 30
) -> Dict[str, Any]:
    """
    Check if recipient has been contacted by any account

    Args:
        recipient_username: Username to check
        exclude_account_id: Account to exclude from check (self)
        lookback_days: How far back to look

    Returns:
        Duplicate check result
    """
    client = get_client()
    if not client:
        return {"is_duplicate": False, "reason": "no_database"}

    try:
        since = (datetime.utcnow() - timedelta(days=lookback_days)).isoformat()

        query = client.table("dm_queue").select(
            "id, account_id, status, sent_at, subreddit"
        ).eq(
            "recipient_username", recipient_username.lower()
        ).gte("created_at", since)

        # Exclude current account if provided
        if exclude_account_id:
            query = query.neq("account_id", exclude_account_id)

        result = query.execute()

        if not result.data:
            return {"is_duplicate": False}

        # Found previous contact
        previous = result.data[0]
        return {
            "is_duplicate": True,
            "previous_contact": {
                "account_id": previous.get("account_id"),
                "sent_at": previous.get("sent_at"),
                "status": previous.get("status"),
                "subreddit": previous.get("subreddit")
            },
            "recommendation": "skip",
            "reason": f"User was contacted {len(result.data)} time(s) in the last {lookback_days} days"
        }
    except Exception as e:
        logger.error(f"Error checking duplicate recipient: {e}")
        return {"is_duplicate": False, "error": str(e)}


async def check_message_similarity(
    message: str,
    account_id: str,
    threshold: float = 0.85,
    lookback_hours: int = 24
) -> Dict[str, Any]:
    """
    Check if a message is too similar to recent messages

    Args:
        message: Message to check
        account_id: Account ID
        threshold: Similarity threshold (0-1)
        lookback_hours: How far back to look

    Returns:
        Similarity check result
    """
    client = get_client()
    if not client:
        return {"is_similar": False, "reason": "no_database"}

    try:
        since = (datetime.utcnow() - timedelta(hours=lookback_hours)).isoformat()

        result = client.table("dm_queue").select(
            "generated_message"
        ).eq(
            "account_id", account_id
        ).eq(
            "status", "sent"
        ).gte("sent_at", since).execute()

        if not result.data:
            return {"is_similar": False}

        # Simple word-based similarity check
        message_words = set(message.lower().split())

        for dm in result.data:
            prev_message = dm.get("generated_message", "")
            if not prev_message:
                continue

            prev_words = set(prev_message.lower().split())

            # Jaccard similarity
            intersection = len(message_words & prev_words)
            union = len(message_words | prev_words)

            if union > 0:
                similarity = intersection / union
                if similarity >= threshold:
                    return {
                        "is_similar": True,
                        "similarity": round(similarity, 3),
                        "recommendation": "regenerate",
                        "reason": f"Message is {similarity*100:.0f}% similar to a recent message"
                    }

        return {"is_similar": False}
    except Exception as e:
        logger.error(f"Error checking message similarity: {e}")
        return {"is_similar": False, "error": str(e)}


async def pre_send_safety_check(
    account_id: str,
    recipient_username: str,
    message: str,
    subreddit: str = None,
    team_id: str = None,
    message_type: str = "outreach",
) -> Dict[str, Any]:
    """
    Comprehensive pre-send safety check

    Args:
        account_id: Sending account ID
        recipient_username: Target username
        message: Message to send
        subreddit: Target subreddit
        team_id: Team ID for cross-account dedup
        message_type: 'outreach' or 'reply' (replies skip dedup)

    Returns:
        Safety check result with approval/denial
    """
    # 1. Check risk level
    risk_assessment = await assess_risk_level(account_id)

    if risk_assessment.get("risk_category") == "high":
        return {
            "approved": False,
            "reason": "Account risk level too high",
            "risk_assessment": risk_assessment,
            "recommendation": "pause_and_review"
        }

    # 2. Check for duplicate recipient (cross-account, no time limit, skip for replies)
    if message_type != "reply" and team_id:
        from . import dedup
        duplicate_check = await dedup.has_been_contacted(recipient_username, team_id)
        if duplicate_check.get("contacted"):
            return {
                "approved": False,
                "reason": "Recipient already contacted",
                "duplicate_check": duplicate_check,
                "recommendation": "skip"
            }
    elif message_type != "reply":
        # Fallback to old check if no team_id (shouldn't happen, but safe)
        duplicate_check = await check_duplicate_recipient(recipient_username)
        if duplicate_check.get("is_duplicate"):
            return {
                "approved": False,
                "reason": "Recipient already contacted",
                "duplicate_check": duplicate_check,
                "recommendation": "skip"
            }

    # 3. Check message similarity
    similarity_check = await check_message_similarity(message, account_id)

    if similarity_check.get("is_similar"):
        return {
            "approved": False,
            "reason": "Message too similar to recent messages",
            "similarity_check": similarity_check,
            "recommendation": "regenerate_message"
        }

    # 4. Calculate safe delay
    base_delay = calculate_humanized_delay()
    adaptive_delay = calculate_adaptive_delay(base_delay, risk_assessment)

    return {
        "approved": True,
        "risk_assessment": risk_assessment,
        "recommended_delay_ms": adaptive_delay,
        "checks_passed": ["risk_level", "duplicate_recipient", "message_similarity"]
    }
