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
    Check if a Reddit account is shadowbanned
    Uses public Reddit JSON API to verify profile visibility
    """
    user_agent = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"

    async with httpx.AsyncClient() as client:
        try:
            # Method 1: Check if profile is accessible
            profile_url = f"https://www.reddit.com/user/{username}/about.json"
            profile_response = await client.get(
                profile_url,
                headers={"User-Agent": user_agent},
                timeout=30.0
            )

            if profile_response.status_code == 404:
                return {
                    "isShadowbanned": True,
                    "method": "profile_404",
                    "details": {"message": "Profile returns 404 - likely shadowbanned or suspended"}
                }

            if profile_response.status_code == 403:
                return {
                    "isShadowbanned": False,
                    "method": "profile_private",
                    "details": {"message": "Profile is private - cannot determine shadowban status"}
                }

            if profile_response.status_code != 200:
                return {
                    "isShadowbanned": False,
                    "method": "api_error",
                    "details": {"message": f"API error: {profile_response.status_code}"}
                }

            profile_data = profile_response.json()

            # Check for suspended account
            if profile_data.get("data", {}).get("is_suspended"):
                return {
                    "isShadowbanned": False,
                    "method": "suspended",
                    "details": {"message": "Account is suspended (not shadowbanned)"}
                }

            # Method 2: Check if recent posts are visible in subreddit
            posts_url = f"https://www.reddit.com/user/{username}/submitted.json?limit=5"
            posts_response = await client.get(
                posts_url,
                headers={"User-Agent": user_agent},
                timeout=30.0
            )

            if posts_response.status_code == 200:
                posts_data = posts_response.json()
                posts = posts_data.get("data", {}).get("children", [])

                # Check if any post is visible in its subreddit
                for post in posts[:3]:
                    post_data = post.get("data", {})
                    permalink = post_data.get("permalink")
                    if not permalink:
                        continue

                    # Try to access the post directly
                    post_url = f"https://www.reddit.com{permalink}.json"
                    post_response = await client.get(
                        post_url,
                        headers={"User-Agent": user_agent},
                        timeout=30.0
                    )

                    if post_response.status_code == 404:
                        return {
                            "isShadowbanned": True,
                            "method": "post_hidden",
                            "details": {
                                "message": "Posts exist on profile but are hidden from subreddit",
                                "hiddenPost": permalink
                            }
                        }

                    # Add small delay to avoid rate limiting
                    await asyncio.sleep(0.5)

            return {
                "isShadowbanned": False,
                "method": "verified_clean",
                "details": {"message": "No shadowban indicators detected"}
            }

        except Exception as e:
            print(f"Error checking shadowban: {e}")
            return {
                "isShadowbanned": False,
                "method": "error",
                "details": {"message": str(e)}
            }


async def log_safety_event(event: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    """Log a safety event"""
    client = get_client()
    if not client:
        print(f"Safety event (not logged): {event}")
        return None

    try:
        result = client.table("safety_events").insert({
            "account_id": event.get("accountId"),
            "event_type": event.get("eventType"),
            "details": event.get("details", {})
        }).execute()

        return result.data[0] if result.data else None
    except Exception as e:
        print(f"Error logging safety event: {e}")
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
        print(f"Error fetching safety events: {e}")
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
        print(f"Error getting account health: {e}")
        return {"warnings": [], "status": "unknown", "error": str(e)}
