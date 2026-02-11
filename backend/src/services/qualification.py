"""
User Qualification Service
Evaluates Reddit user profiles for outreach suitability
"""

import os
import re
import asyncio
from datetime import datetime, timedelta
from typing import Dict, Any, List, Optional, Tuple
import httpx
from supabase import create_client, Client

_supabase: Optional[Client] = None

# Default qualification thresholds
DEFAULT_THRESHOLDS = {
    "minAccountAgeDays": 30,
    "minKarma": 100,
    "minPostKarma": 10,
    "minCommentKarma": 50,
    "maxAccountAgeDays": 365 * 15,  # 15 years max
    "suspiciousPatterns": ["bot", "spam", "auto", "test"]
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


async def fetch_reddit_user_data(username: str) -> Dict[str, Any]:
    """Fetch user data via ScrapeCreators API"""
    from . import reddit_search

    try:
        data = await reddit_search.get_user_about(username)
        if not data:
            return {"error": "not_found", "message": "User not found or API error"}
        return data
    except Exception as e:
        logger.warning(f"Error fetching Reddit user data for u/{username}: {e}")
        return {"error": "fetch_error", "message": str(e)}


async def fetch_user_posts(username: str, limit: int = 25) -> List[Dict[str, Any]]:
    """Fetch user's recent posts via ScrapeCreators API"""
    from . import reddit_search

    try:
        return await reddit_search.get_user_posts(username, limit=limit)
    except Exception as e:
        logger.warning(f"Error fetching user posts for u/{username}: {e}")
        return []


async def fetch_user_comments(username: str, limit: int = 25) -> List[Dict[str, Any]]:
    """Fetch user's recent comments via ScrapeCreators API"""
    from . import reddit_search

    try:
        return await reddit_search.get_user_comments(username, limit=limit)
    except Exception as e:
        logger.warning(f"Error fetching user comments for u/{username}: {e}")
        return []


async def get_cached_qualification(username: str) -> Optional[Dict[str, Any]]:
    """Get cached qualification for a username"""
    client = get_client()
    if not client:
        return None

    try:
        result = client.table("user_qualifications").select("*").eq(
            "username", username.lower()
        ).gt(
            "expires_at", datetime.utcnow().isoformat()
        ).execute()

        if not result.data:
            return None

        data = result.data[0]
        return {
            "isQualified": data.get("is_qualified"),
            "accountQualityScore": data.get("account_quality_score"),
            "engagementScore": data.get("engagement_score"),
            "disqualificationReason": data.get("disqualification_reason"),
            "isBotLikely": data.get("is_bot_likely"),
            "isSpamLikely": data.get("is_spam_likely"),
            "metrics": {
                "accountAgeDays": data.get("account_age_days"),
                "totalKarma": data.get("total_karma"),
                "postKarma": data.get("post_karma"),
                "commentKarma": data.get("comment_karma"),
                "postingFrequency": data.get("posting_frequency"),
                "primarySubreddits": data.get("primary_subreddits")
            },
            "cached": True,
            "qualifiedAt": data.get("qualified_at")
        }
    except Exception as e:
        print(f"Error fetching cached qualification: {e}")
        return None


async def save_qualification(
    username: str,
    qualification: Dict[str, Any],
    user_data: Optional[Dict[str, Any]]
) -> Optional[Dict[str, Any]]:
    """Save qualification to cache"""
    client = get_client()
    if not client:
        return None

    try:
        metrics = qualification.get("metrics", {})
        expires_at = datetime.utcnow() + timedelta(days=30)

        account_created_at = None
        if user_data and user_data.get("created_utc"):
            account_created_at = datetime.fromtimestamp(user_data["created_utc"]).isoformat()

        result = client.table("user_qualifications").upsert({
            "username": username.lower(),
            "account_age_days": metrics.get("accountAgeDays"),
            "total_karma": metrics.get("totalKarma"),
            "post_karma": metrics.get("postKarma"),
            "comment_karma": metrics.get("commentKarma"),
            "account_created_at": account_created_at,
            "posting_frequency": metrics.get("postingFrequency"),
            "primary_subreddits": metrics.get("primarySubreddits", []),
            "professional_signals": metrics.get("professionalSignals", []),
            "account_quality_score": qualification.get("accountQualityScore"),
            "engagement_score": qualification.get("engagementScore"),
            "is_bot_likely": qualification.get("isBotLikely", False),
            "is_spam_likely": qualification.get("isSpamLikely", False),
            "is_qualified": qualification.get("isQualified"),
            "disqualification_reason": qualification.get("disqualificationReason"),
            "qualified_at": datetime.utcnow().isoformat(),
            "expires_at": expires_at.isoformat()
        }, on_conflict="username").execute()

        return result.data[0] if result.data else None
    except Exception as e:
        print(f"Error saving qualification: {e}")
        return None


def analyze_posting_frequency(posts: List[Dict], comments: List[Dict]) -> str:
    """Analyze posting frequency from user history"""
    total_items = len(posts) + len(comments)

    if total_items == 0:
        return "inactive"

    all_dates = [
        p.get("created_utc") for p in posts if p.get("created_utc")
    ] + [
        c.get("created_utc") for c in comments if c.get("created_utc")
    ]

    if not all_dates:
        return "low"

    oldest_date = min(all_dates)
    newest_date = max(all_dates)
    day_span = max(1, (newest_date - oldest_date) / (24 * 60 * 60))

    posts_per_day = total_items / day_span

    if posts_per_day >= 5:
        return "high"
    if posts_per_day >= 1:
        return "medium"
    if posts_per_day >= 0.1:
        return "low"
    return "inactive"


def extract_primary_subreddits(posts: List[Dict], comments: List[Dict]) -> List[str]:
    """Extract primary subreddits from user activity"""
    subreddit_counts: Dict[str, int] = {}

    for p in posts:
        sub = (p.get("subreddit") or "").lower()
        if sub:
            subreddit_counts[sub] = subreddit_counts.get(sub, 0) + 2  # Posts count more

    for c in comments:
        sub = (c.get("subreddit") or "").lower()
        if sub:
            subreddit_counts[sub] = subreddit_counts.get(sub, 0) + 1

    sorted_subs = sorted(subreddit_counts.items(), key=lambda x: x[1], reverse=True)
    return [sub for sub, _ in sorted_subs[:10]]


def detect_bot_patterns(
    user_data: Dict[str, Any],
    posts: List[Dict],
    comments: List[Dict]
) -> Dict[str, Any]:
    """Detect suspicious bot-like patterns"""
    signals = []

    # Check username patterns
    username = (user_data.get("name") or "").lower()
    if re.search(r"bot|auto|spam|test\d+", username):
        signals.append("suspicious_username")

    # Check for repetitive content
    if len(posts) >= 5:
        titles = [p.get("title", "").lower() for p in posts if p.get("title")]
        unique_titles = set(titles)
        if len(unique_titles) < len(titles) * 0.5:
            signals.append("repetitive_posts")

    # Check for extremely high karma ratios (possible karma farming)
    karma = (user_data.get("link_karma", 0) or 0) + (user_data.get("comment_karma", 0) or 0)
    created_utc = user_data.get("created_utc", 0)
    if created_utc:
        account_age_days = (datetime.now().timestamp() - created_utc) / (24 * 60 * 60)
        if account_age_days > 0 and karma / account_age_days > 1000:
            signals.append("suspicious_karma_rate")

    # Check for single-subreddit spam
    if len(posts) >= 10:
        subs = [p.get("subreddit") for p in posts if p.get("subreddit")]
        unique_subs = set(subs)
        if len(unique_subs) == 1:
            signals.append("single_subreddit_activity")

    return {
        "isBotLikely": len(signals) >= 2,
        "signals": signals
    }


def calculate_quality_score(
    user_data: Dict[str, Any],
    posts: List[Dict],
    comments: List[Dict],
    thresholds: Dict[str, Any]
) -> int:
    """Calculate account quality score"""
    score = 50  # Start at neutral

    created_utc = user_data.get("created_utc", 0)
    account_age_days = (datetime.now().timestamp() - created_utc) / (24 * 60 * 60) if created_utc else 0
    total_karma = (user_data.get("link_karma", 0) or 0) + (user_data.get("comment_karma", 0) or 0)

    # Account age scoring (+/- 20 points)
    if account_age_days >= 365:
        score += 20
    elif account_age_days >= 180:
        score += 15
    elif account_age_days >= 90:
        score += 10
    elif account_age_days >= thresholds.get("minAccountAgeDays", 30):
        score += 5
    else:
        score -= 15

    # Karma scoring (+/- 20 points)
    if total_karma >= 10000:
        score += 20
    elif total_karma >= 1000:
        score += 15
    elif total_karma >= 500:
        score += 10
    elif total_karma >= thresholds.get("minKarma", 100):
        score += 5
    else:
        score -= 15

    # Activity scoring (+/- 10 points)
    total_activity = len(posts) + len(comments)
    if total_activity >= 50:
        score += 10
    elif total_activity >= 20:
        score += 5
    elif total_activity < 5:
        score -= 10

    # Diversity scoring (+/- 10 points)
    subreddits = extract_primary_subreddits(posts, comments)
    if len(subreddits) >= 5:
        score += 10
    elif len(subreddits) >= 3:
        score += 5
    elif len(subreddits) == 1:
        score -= 5

    return max(0, min(100, score))


def calculate_engagement_score(
    user_data: Dict[str, Any],
    posts: List[Dict],
    comments: List[Dict]
) -> int:
    """Calculate engagement score based on karma and activity"""
    score = 50

    comment_karma = user_data.get("comment_karma", 0) or 0
    if comment_karma >= 5000:
        score += 25
    elif comment_karma >= 1000:
        score += 15
    elif comment_karma >= 100:
        score += 5

    # Recent activity
    now = datetime.now().timestamp()
    recent_items = [
        item for item in (posts + comments)
        if item.get("created_utc") and (now - item["created_utc"]) / 3600 <= 168  # Last 7 days
    ]

    if len(recent_items) >= 10:
        score += 15
    elif len(recent_items) >= 5:
        score += 10
    elif len(recent_items) >= 1:
        score += 5
    else:
        score -= 10

    return max(0, min(100, score))


async def qualify_user(username: str, options: Dict[str, Any] = None) -> Dict[str, Any]:
    """
    Qualify a Reddit user

    Args:
        username: Reddit username
        options: Qualification options/thresholds

    Returns:
        Qualification result
    """
    options = options or {}
    thresholds = {**DEFAULT_THRESHOLDS, **options}

    # Check cache first
    cached = await get_cached_qualification(username)
    if cached:
        print(f"Using cached qualification for: {username}")
        return cached

    # Fetch user data from Reddit
    user_data = await fetch_reddit_user_data(username)

    # Handle error cases
    if user_data.get("error"):
        result = {
            "isQualified": False,
            "accountQualityScore": 0,
            "engagementScore": 0,
            "disqualificationReason": user_data.get("message"),
            "isBotLikely": False,
            "isSpamLikely": False,
            "metrics": {},
            "cached": False
        }

        # Don't cache 'not found' errors permanently
        if user_data.get("error") != "not_found":
            await save_qualification(username, result, None)

        return result

    # Check for suspended accounts
    if user_data.get("is_suspended"):
        return {
            "isQualified": False,
            "accountQualityScore": 0,
            "engagementScore": 0,
            "disqualificationReason": "Account is suspended",
            "isBotLikely": False,
            "isSpamLikely": False,
            "metrics": {"totalKarma": 0, "accountAgeDays": 0},
            "cached": False
        }

    # Fetch additional user data
    posts, comments = await asyncio.gather(
        fetch_user_posts(username, 25),
        fetch_user_comments(username, 25)
    )

    # Calculate metrics
    created_utc = user_data.get("created_utc", 0)
    account_age_days = int((datetime.now().timestamp() - created_utc) / (24 * 60 * 60)) if created_utc else 0
    total_karma = (user_data.get("link_karma", 0) or 0) + (user_data.get("comment_karma", 0) or 0)
    posting_frequency = analyze_posting_frequency(posts, comments)
    primary_subreddits = extract_primary_subreddits(posts, comments)
    bot_analysis = detect_bot_patterns(user_data, posts, comments)

    account_quality_score = calculate_quality_score(user_data, posts, comments, thresholds)
    engagement_score = calculate_engagement_score(user_data, posts, comments)

    # Determine qualification
    is_qualified = True
    disqualification_reason = None

    # Check thresholds
    if account_age_days < thresholds.get("minAccountAgeDays", 30):
        is_qualified = False
        disqualification_reason = f"Account too new ({account_age_days} days < {thresholds['minAccountAgeDays']} required)"
    elif total_karma < thresholds.get("minKarma", 100):
        is_qualified = False
        disqualification_reason = f"Karma too low ({total_karma} < {thresholds['minKarma']} required)"
    elif bot_analysis["isBotLikely"] and options.get("blockSuspectedBots", True):
        is_qualified = False
        disqualification_reason = f"Suspected bot account: {', '.join(bot_analysis['signals'])}"

    result = {
        "isQualified": is_qualified,
        "accountQualityScore": account_quality_score,
        "engagementScore": engagement_score,
        "disqualificationReason": disqualification_reason,
        "isBotLikely": bot_analysis["isBotLikely"],
        "isSpamLikely": "single_subreddit_activity" in bot_analysis["signals"],
        "metrics": {
            "accountAgeDays": account_age_days,
            "totalKarma": total_karma,
            "postKarma": user_data.get("link_karma", 0),
            "commentKarma": user_data.get("comment_karma", 0),
            "postingFrequency": posting_frequency,
            "primarySubreddits": primary_subreddits,
            "professionalSignals": []
        },
        "cached": False
    }

    # Save to cache
    await save_qualification(username, result, user_data)

    return result


async def qualify_batch(usernames: List[str], options: Dict[str, Any] = None) -> List[Dict[str, Any]]:
    """
    Qualify multiple users in batch

    Args:
        usernames: Array of usernames
        options: Qualification options

    Returns:
        Array of qualification results
    """
    options = options or {}
    results = []

    for username in usernames:
        try:
            qualification = await qualify_user(username, options)
            results.append({
                "username": username,
                **qualification
            })

            # Add delay to avoid rate limiting
            await asyncio.sleep(1.0)
        except Exception as e:
            print(f"Error qualifying user {username}: {e}")
            results.append({
                "username": username,
                "isQualified": False,
                "error": str(e),
                "disqualificationReason": "Qualification error"
            })

    return results


async def get_qualification_stats() -> Dict[str, int]:
    """Get qualification statistics"""
    client = get_client()
    if not client:
        return {"total": 0, "qualified": 0, "disqualified": 0, "bots": 0}

    try:
        thirty_days_ago = (datetime.utcnow() - timedelta(days=30)).isoformat()
        result = client.table("user_qualifications").select(
            "is_qualified, is_bot_likely"
        ).gte("qualified_at", thirty_days_ago).execute()

        if not result.data:
            return {"total": 0, "qualified": 0, "disqualified": 0, "bots": 0}

        data = result.data
        return {
            "total": len(data),
            "qualified": len([d for d in data if d.get("is_qualified")]),
            "disqualified": len([d for d in data if not d.get("is_qualified")]),
            "bots": len([d for d in data if d.get("is_bot_likely")])
        }
    except Exception as e:
        print(f"Error fetching qualification stats: {e}")
        return {"total": 0, "qualified": 0, "disqualified": 0, "bots": 0}
