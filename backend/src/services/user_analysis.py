"""
User Analysis Service
Deep profile analysis for hyper-personalized messaging
"""

import os
import re
import asyncio
from datetime import datetime, timedelta
from typing import Dict, Any, List, Optional, Tuple
from collections import Counter
import httpx
from supabase import create_client, Client

_supabase: Optional[Client] = None

# Communication style indicators
FORMAL_INDICATORS = [
    "therefore", "however", "furthermore", "consequently", "regarding",
    "pursuant", "accordingly", "nevertheless", "moreover", "hence"
]

CASUAL_INDICATORS = [
    "lol", "lmao", "tbh", "ngl", "imo", "imho", "gonna", "wanna",
    "kinda", "sorta", "idk", "btw", "omg", "rn", "fr", "lowkey"
]

TECHNICAL_INDICATORS = [
    "api", "backend", "frontend", "deploy", "repository", "git",
    "docker", "kubernetes", "database", "algorithm", "framework"
]

# Pain point indicators in posts
PAIN_POINT_PHRASES = [
    "struggling with", "having trouble", "can't figure out", "frustrated",
    "help me", "any advice", "how do i", "what should i", "stuck on",
    "problem with", "issue with", "not working", "broken", "confused about",
    "need help", "looking for advice", "recommendation", "suggestions"
]

# Professional signal patterns
PROFESSIONAL_PATTERNS = [
    r"\b(ceo|cto|cfo|coo|founder|co-founder|director|manager|lead|head of)\b",
    r"\b(engineer|developer|designer|analyst|consultant|specialist)\b",
    r"\b(senior|junior|principal|staff|associate)\b",
    r"\b(my company|our company|my startup|our startup|my business)\b",
    r"\b(we launched|we built|we created|i founded|i started)\b"
]

# Purchase/decision signals
PURCHASE_SIGNALS = [
    "looking to buy", "considering", "comparing", "best option",
    "worth it", "should i get", "recommend", "alternatives to",
    "switching from", "migrating to", "upgrading", "budget for"
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


async def fetch_user_posts(username: str, limit: int = 100) -> List[Dict[str, Any]]:
    """Fetch user's recent posts via ScrapeCreators API"""
    from . import reddit_search

    try:
        return await reddit_search.get_user_posts(username, limit=limit)
    except Exception as e:
        logger.warning(f"Error fetching user posts for u/{username}: {e}")
        return []


async def fetch_user_comments(username: str, limit: int = 100) -> List[Dict[str, Any]]:
    """Fetch user's recent comments via ScrapeCreators API"""
    from . import reddit_search

    try:
        return await reddit_search.get_user_comments(username, limit=limit)
    except Exception as e:
        logger.warning(f"Error fetching user comments for u/{username}: {e}")
        return []


def extract_interests(posts: List[Dict], comments: List[Dict]) -> List[Dict[str, Any]]:
    """Extract user interests from their activity"""
    # Count subreddit activity
    subreddit_counts: Counter = Counter()

    for p in posts:
        sub = (p.get("subreddit") or "").lower()
        if sub:
            subreddit_counts[sub] += 2  # Posts weighted more

    for c in comments:
        sub = (c.get("subreddit") or "").lower()
        if sub:
            subreddit_counts[sub] += 1

    # Extract topics from titles and content
    topic_counts: Counter = Counter()

    # Common topic keywords to look for
    topic_keywords = {
        "programming": ["code", "programming", "developer", "software", "coding"],
        "gaming": ["game", "gaming", "play", "xbox", "playstation", "pc gaming"],
        "finance": ["invest", "stock", "crypto", "money", "finance", "trading"],
        "fitness": ["gym", "workout", "fitness", "exercise", "weight"],
        "business": ["business", "startup", "entrepreneur", "company", "marketing"],
        "technology": ["tech", "technology", "gadget", "device", "app"],
        "career": ["job", "career", "interview", "resume", "salary", "work"],
        "relationships": ["relationship", "dating", "partner", "marriage"],
        "health": ["health", "medical", "doctor", "symptom", "treatment"],
        "education": ["college", "university", "school", "degree", "learning"]
    }

    all_text = " ".join([
        p.get("title", "") + " " + p.get("selftext", "")
        for p in posts
    ] + [
        c.get("body", "") for c in comments
    ]).lower()

    for topic, keywords in topic_keywords.items():
        count = sum(1 for kw in keywords if kw in all_text)
        if count > 0:
            topic_counts[topic] = count

    # Combine subreddits and topics into interests
    interests = []

    # Add top subreddits as interests
    for sub, count in subreddit_counts.most_common(5):
        confidence = min(100, count * 10)
        interests.append({
            "topic": f"r/{sub}",
            "confidence": confidence,
            "evidence": f"Active in r/{sub} ({count} interactions)"
        })

    # Add detected topics
    for topic, count in topic_counts.most_common(5):
        if count >= 2:  # Require at least 2 mentions
            confidence = min(100, count * 15)
            interests.append({
                "topic": topic,
                "confidence": confidence,
                "evidence": f"Discussed {topic} multiple times"
            })

    return interests[:10]  # Return top 10 interests


def extract_pain_points(posts: List[Dict], comments: List[Dict]) -> List[Dict[str, Any]]:
    """Extract pain points from user's posts and comments"""
    pain_points = []

    for p in posts:
        title = (p.get("title") or "").lower()
        body = (p.get("selftext") or "").lower()
        text = title + " " + body

        for phrase in PAIN_POINT_PHRASES:
            if phrase in text:
                # Extract context around the pain point
                pain_points.append({
                    "description": p.get("title", "")[:100],
                    "subreddit": p.get("subreddit"),
                    "indicator": phrase,
                    "source": "post"
                })
                break

    # Also check comments for pain points (questions they've asked)
    for c in comments:
        body = (c.get("body") or "").lower()

        # Check if comment is a question
        if "?" in body:
            for phrase in PAIN_POINT_PHRASES:
                if phrase in body:
                    pain_points.append({
                        "description": c.get("body", "")[:100],
                        "subreddit": c.get("subreddit"),
                        "indicator": phrase,
                        "source": "comment"
                    })
                    break

    # Deduplicate and limit
    seen = set()
    unique_pain_points = []
    for pp in pain_points:
        key = pp["description"][:50]
        if key not in seen:
            seen.add(key)
            unique_pain_points.append(pp)

    return unique_pain_points[:10]


def analyze_communication_style(posts: List[Dict], comments: List[Dict]) -> Dict[str, Any]:
    """Analyze user's communication style"""
    all_text = " ".join([
        p.get("selftext", "") for p in posts
    ] + [
        c.get("body", "") for c in comments
    ]).lower()

    # Count style indicators
    formal_count = sum(1 for word in FORMAL_INDICATORS if word in all_text)
    casual_count = sum(1 for word in CASUAL_INDICATORS if word in all_text)
    technical_count = sum(1 for word in TECHNICAL_INDICATORS if word in all_text)

    # Calculate average message length
    all_bodies = [p.get("selftext", "") for p in posts if p.get("selftext")] + \
                 [c.get("body", "") for c in comments if c.get("body")]

    avg_length = sum(len(b) for b in all_bodies) / max(len(all_bodies), 1)

    # Determine primary style
    if technical_count > 5:
        style = "technical"
    elif formal_count > casual_count * 2:
        style = "formal"
    elif casual_count > formal_count * 2:
        style = "casual"
    else:
        style = "balanced"

    # Determine verbosity
    if avg_length > 500:
        verbosity = "verbose"
    elif avg_length < 100:
        verbosity = "concise"
    else:
        verbosity = "moderate"

    return {
        "primary_style": style,
        "verbosity": verbosity,
        "avg_message_length": round(avg_length),
        "indicators": {
            "formal_count": formal_count,
            "casual_count": casual_count,
            "technical_count": technical_count
        }
    }


def detect_professional_signals(posts: List[Dict], comments: List[Dict]) -> Dict[str, Any]:
    """Detect professional signals from user content"""
    signals = []

    all_text = " ".join([
        p.get("title", "") + " " + p.get("selftext", "")
        for p in posts
    ] + [
        c.get("body", "") for c in comments
    ])

    text_lower = all_text.lower()

    for pattern in PROFESSIONAL_PATTERNS:
        matches = re.findall(pattern, text_lower, re.IGNORECASE)
        if matches:
            signals.extend(matches)

    # Check for company/role mentions
    role_indicators = []
    if "founder" in text_lower or "started my" in text_lower:
        role_indicators.append("founder/entrepreneur")
    if re.search(r"i work (at|for|in)", text_lower):
        role_indicators.append("employed professional")
    if "freelance" in text_lower or "consultant" in text_lower:
        role_indicators.append("freelancer/consultant")

    # Check for decision-maker signals
    decision_maker = any(term in text_lower for term in [
        "our budget", "our team", "we decided", "i approved",
        "my department", "my team", "hiring", "procurement"
    ])

    return {
        "detected_signals": list(set(signals))[:10],
        "role_indicators": list(set(role_indicators)),
        "is_decision_maker": decision_maker,
        "confidence": min(100, len(signals) * 15 + len(role_indicators) * 20)
    }


def detect_purchase_signals(posts: List[Dict], comments: List[Dict]) -> List[Dict[str, Any]]:
    """Detect purchase/buying intent signals"""
    signals = []

    for p in posts:
        text = (p.get("title", "") + " " + p.get("selftext", "")).lower()

        for signal in PURCHASE_SIGNALS:
            if signal in text:
                signals.append({
                    "signal_type": signal,
                    "source_post": p.get("title", "")[:100],
                    "subreddit": p.get("subreddit"),
                    "detected_at": datetime.fromtimestamp(
                        p.get("created_utc", 0)
                    ).isoformat() if p.get("created_utc") else None
                })
                break

    return signals[:10]


def calculate_peak_activity(posts: List[Dict], comments: List[Dict]) -> Dict[str, Any]:
    """Calculate user's peak activity hours and days"""
    hour_counts: Counter = Counter()
    day_counts: Counter = Counter()

    all_items = posts + comments

    for item in all_items:
        created_utc = item.get("created_utc")
        if created_utc:
            dt = datetime.fromtimestamp(created_utc)
            hour_counts[dt.hour] += 1
            day_counts[dt.strftime("%A")] += 1

    # Find peak hours (top 3)
    peak_hours = [h for h, _ in hour_counts.most_common(3)]

    # Find peak days (top 3)
    peak_days = [d for d, _ in day_counts.most_common(3)]

    # Calculate activity distribution
    total_activity = sum(hour_counts.values())
    activity_by_hour = {
        h: round(c / max(total_activity, 1) * 100, 1)
        for h, c in hour_counts.items()
    }

    return {
        "peak_hours_utc": peak_hours,
        "peak_days": peak_days,
        "activity_by_hour": activity_by_hour,
        "total_activity_count": total_activity
    }


def calculate_optimal_send_time(activity_data: Dict[str, Any]) -> Dict[str, Any]:
    """Calculate optimal time to send a DM based on activity patterns"""
    peak_hours = activity_data.get("peak_hours_utc", [])
    peak_days = activity_data.get("peak_days", [])

    if not peak_hours:
        # Default to common active hours if no data
        peak_hours = [10, 14, 20]  # 10am, 2pm, 8pm UTC

    if not peak_days:
        peak_days = ["Monday", "Tuesday", "Wednesday"]

    # Calculate next optimal window
    now = datetime.utcnow()
    current_hour = now.hour
    current_day = now.strftime("%A")

    # Find next peak hour today or tomorrow
    next_optimal = None
    for hour in sorted(peak_hours):
        if hour > current_hour:
            next_optimal = now.replace(hour=hour, minute=0, second=0, microsecond=0)
            break

    if not next_optimal:
        # Next peak is tomorrow
        tomorrow = now + timedelta(days=1)
        next_optimal = tomorrow.replace(
            hour=min(peak_hours) if peak_hours else 10,
            minute=0, second=0, microsecond=0
        )

    # Calculate confidence based on data quality
    total_activity = activity_data.get("total_activity_count", 0)
    confidence = min(100, total_activity * 2)  # More data = higher confidence

    return {
        "best_hours_utc": peak_hours,
        "best_days": peak_days,
        "next_optimal_window": next_optimal.isoformat(),
        "confidence": confidence
    }


def generate_personalization_context(profile: Dict[str, Any]) -> Dict[str, str]:
    """Generate context strings for LLM personalization"""
    interests = profile.get("interests", [])
    pain_points = profile.get("pain_points", [])
    comm_style = profile.get("communication_style", {})
    professional = profile.get("professional_signals", {})

    # Generate interest summary
    interest_summary = ""
    if interests:
        topics = [i["topic"] for i in interests[:5]]
        interest_summary = f"User is interested in: {', '.join(topics)}"

    # Generate pain point summary
    pain_summary = ""
    if pain_points:
        pains = [pp["description"][:50] for pp in pain_points[:3]]
        pain_summary = f"Recent challenges: {'; '.join(pains)}"

    # Generate style guidance
    style = comm_style.get("primary_style", "balanced")
    verbosity = comm_style.get("verbosity", "moderate")

    style_guidance = {
        "formal": "Use professional language, proper grammar",
        "casual": "Be relaxed, use conversational language, abbreviations OK",
        "technical": "Can use technical terms, be specific",
        "balanced": "Be friendly but professional"
    }.get(style, "Be friendly and natural")

    length_guidance = {
        "verbose": "They appreciate detailed messages",
        "concise": "Keep it very short and direct",
        "moderate": "2-3 sentences is ideal"
    }.get(verbosity, "2-3 sentences is ideal")

    # Professional context
    prof_context = ""
    if professional.get("is_decision_maker"):
        prof_context = "User appears to be a decision-maker in their organization"
    elif professional.get("role_indicators"):
        prof_context = f"User context: {', '.join(professional['role_indicators'])}"

    return {
        "interest_summary": interest_summary,
        "pain_summary": pain_summary,
        "style_guidance": style_guidance,
        "length_guidance": length_guidance,
        "professional_context": prof_context
    }


async def get_cached_profile(username: str) -> Optional[Dict[str, Any]]:
    """Get cached user profile"""
    client = get_client()
    if not client:
        return None

    try:
        result = client.table("user_profiles").select("*").eq(
            "username", username.lower()
        ).gt(
            "expires_at", datetime.utcnow().isoformat()
        ).execute()

        if not result.data:
            return None

        data = result.data[0]
        return {
            "username": data.get("username"),
            "interests": data.get("interests", []),
            "pain_points": data.get("pain_points", []),
            "communication_style": data.get("communication_style", {}),
            "professional_signals": data.get("professional_signals", {}),
            "purchase_signals": data.get("purchase_signals", []),
            "peak_activity": data.get("peak_activity", {}),
            "optimal_send_time": data.get("optimal_send_time", {}),
            "personalization_context": data.get("personalization_context", {}),
            "analyzed_at": data.get("analyzed_at"),
            "cached": True
        }
    except Exception as e:
        print(f"Error fetching cached profile: {e}")
        return None


async def save_profile(username: str, profile: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    """Save user profile to cache"""
    client = get_client()
    if not client:
        return None

    try:
        expires_at = datetime.utcnow() + timedelta(days=30)

        result = client.table("user_profiles").upsert({
            "username": username.lower(),
            "interests": profile.get("interests", []),
            "pain_points": profile.get("pain_points", []),
            "communication_style": profile.get("communication_style", {}),
            "professional_signals": profile.get("professional_signals", {}),
            "purchase_signals": profile.get("purchase_signals", []),
            "peak_activity": profile.get("peak_activity", {}),
            "optimal_send_time": profile.get("optimal_send_time", {}),
            "personalization_context": profile.get("personalization_context", {}),
            "analyzed_at": datetime.utcnow().isoformat(),
            "expires_at": expires_at.isoformat()
        }, on_conflict="username").execute()

        return result.data[0] if result.data else None
    except Exception as e:
        print(f"Error saving profile: {e}")
        return None


async def analyze_user(username: str, force_refresh: bool = False) -> Dict[str, Any]:
    """
    Perform deep analysis of a Reddit user

    Args:
        username: Reddit username
        force_refresh: Skip cache and re-analyze

    Returns:
        Comprehensive user profile
    """
    # Check cache first (unless force refresh)
    if not force_refresh:
        cached = await get_cached_profile(username)
        if cached:
            print(f"Using cached profile for: {username}")
            return cached

    print(f"Analyzing user: {username}")

    # Fetch user activity
    posts, comments = await asyncio.gather(
        fetch_user_posts(username, 100),
        fetch_user_comments(username, 100)
    )

    if not posts and not comments:
        return {
            "username": username,
            "error": "no_activity",
            "message": "Could not fetch user activity",
            "cached": False
        }

    # Perform analysis
    interests = extract_interests(posts, comments)
    pain_points = extract_pain_points(posts, comments)
    communication_style = analyze_communication_style(posts, comments)
    professional_signals = detect_professional_signals(posts, comments)
    purchase_signals = detect_purchase_signals(posts, comments)
    peak_activity = calculate_peak_activity(posts, comments)
    optimal_send_time = calculate_optimal_send_time(peak_activity)

    profile = {
        "username": username,
        "interests": interests,
        "pain_points": pain_points,
        "communication_style": communication_style,
        "professional_signals": professional_signals,
        "purchase_signals": purchase_signals,
        "peak_activity": peak_activity,
        "optimal_send_time": optimal_send_time,
        "analyzed_at": datetime.utcnow().isoformat(),
        "cached": False
    }

    # Generate personalization context
    profile["personalization_context"] = generate_personalization_context(profile)

    # Save to cache
    await save_profile(username, profile)

    return profile


async def get_or_analyze(username: str) -> Dict[str, Any]:
    """Get cached profile or analyze if not available"""
    return await analyze_user(username, force_refresh=False)


async def get_subreddit_culture(subreddit: str) -> Dict[str, Any]:
    """
    Analyze subreddit culture for tone matching

    Returns guidelines for matching the subreddit's communication style
    """
    # Predefined subreddit culture profiles
    # In a production system, this could be dynamically analyzed
    SUBREDDIT_CULTURES = {
        # Tech/Professional
        "entrepreneur": {
            "typical_tone": "professional yet approachable",
            "greeting_examples": ["Hey", "Hi there"],
            "taboo_topics": ["get-rich-quick schemes", "MLM"],
            "culture_notes": "Founders and business-minded people, value actionable advice"
        },
        "startups": {
            "typical_tone": "direct and practical",
            "greeting_examples": ["Hey", "Hi"],
            "taboo_topics": ["blatant self-promotion", "unfounded claims"],
            "culture_notes": "Startup founders, appreciate brevity and substance"
        },
        "saas": {
            "typical_tone": "technical but friendly",
            "greeting_examples": ["Hey", "Hi there"],
            "taboo_topics": ["spam", "unsolicited pitches"],
            "culture_notes": "SaaS builders, value metrics and concrete examples"
        },
        "programming": {
            "typical_tone": "technical and precise",
            "greeting_examples": ["Hey", "Hi"],
            "taboo_topics": ["low-effort questions", "homework requests"],
            "culture_notes": "Developers, appreciate technical depth"
        },
        "webdev": {
            "typical_tone": "casual technical",
            "greeting_examples": ["Hey", "Hi there"],
            "taboo_topics": ["spam", "low-quality content"],
            "culture_notes": "Web developers, mix of beginners and experts"
        },

        # Consumer/Lifestyle
        "personalfinance": {
            "typical_tone": "helpful and supportive",
            "greeting_examples": ["Hi", "Hey there"],
            "taboo_topics": ["financial advice without disclaimers", "scams"],
            "culture_notes": "People seeking financial guidance, appreciate empathy"
        },
        "fitness": {
            "typical_tone": "motivational and supportive",
            "greeting_examples": ["Hey", "Hi"],
            "taboo_topics": ["body shaming", "dangerous advice"],
            "culture_notes": "Fitness enthusiasts, value encouragement"
        },
        "gaming": {
            "typical_tone": "casual and enthusiastic",
            "greeting_examples": ["Hey", "Yo"],
            "taboo_topics": ["spoilers", "console wars"],
            "culture_notes": "Gamers, casual conversation style"
        },

        # Default for unknown subreddits
        "default": {
            "typical_tone": "friendly and respectful",
            "greeting_examples": ["Hey", "Hi", "Hi there"],
            "taboo_topics": ["spam", "unsolicited promotion"],
            "culture_notes": "Match the tone of the post you're responding to"
        }
    }

    sub_lower = subreddit.lower().replace("r/", "")
    culture = SUBREDDIT_CULTURES.get(sub_lower, SUBREDDIT_CULTURES["default"])

    return {
        "subreddit": subreddit,
        **culture
    }
