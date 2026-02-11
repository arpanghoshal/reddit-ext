"""
Discovery Service
AI-powered lead discovery pipeline orchestrator.
Composes existing services (classification, qualification, lead_scoring, llm, queue)
into a multi-stage discovery pipeline.
"""

import os
import re
import json
import asyncio
import logging
from datetime import datetime, timedelta
from typing import Dict, Any, List, Optional
from supabase import create_client, Client

from . import reddit_search
from . import classification as classification_service
from . import qualification as qualification_service
from . import lead_scoring
from . import llm as llm_service
from . import gemini_client

logger = logging.getLogger(__name__)

MAX_POSTS_PER_SUBREDDIT = 25
MAX_SUBREDDITS = 15
MAX_COMMENT_MINING_POSTS = 15
MAX_LEADS = 50

_supabase: Optional[Client] = None


def get_client() -> Optional[Client]:
    global _supabase
    if _supabase is None:
        url = os.getenv("SUPABASE_URL")
        key = os.getenv("SUPABASE_KEY")
        if url and key:
            _supabase = create_client(url, key)
    return _supabase


# ============================================================================
# Session Management
# ============================================================================

async def create_session(team_id: str, input_data: Dict[str, Any]) -> Dict[str, Any]:
    """Create a new discovery session."""
    client = get_client()
    if not client:
        raise ValueError("Database not configured")

    insert_data = {
        "team_id": team_id,
        "status": "pending",
        "business_desc": input_data.get("businessDesc", ""),
        "target_persona": input_data.get("persona", ""),
        "tone": input_data.get("tone", "Curious"),
        "insight_types": input_data.get("insightTypes", []),
        # Automation mode fields
        "mode": input_data.get("mode", "discovery"),
        "target_subreddits": input_data.get("targetSubreddits", []),
        "auto_queue": input_data.get("autoQueue", False),
        "auto_approve": input_data.get("autoApprove", False),
        "min_lead_score": input_data.get("minLeadScore", 50),
    }
    if input_data.get("accountId"):
        insert_data["account_id"] = input_data["accountId"]

    result = client.table("discovery_sessions").insert(insert_data).execute()

    if not result.data:
        raise ValueError("Failed to create discovery session")

    return result.data[0]


async def get_session(session_id: str, team_id: str) -> Optional[Dict[str, Any]]:
    """Get a discovery session by ID."""
    client = get_client()
    if not client:
        return None

    result = client.table("discovery_sessions").select("*").eq(
        "id", session_id
    ).eq("team_id", team_id).execute()

    return result.data[0] if result.data else None


async def get_sessions(team_id: str, limit: int = 20, offset: int = 0) -> List[Dict[str, Any]]:
    """List discovery sessions for a team."""
    client = get_client()
    if not client:
        return []

    result = client.table("discovery_sessions").select("*").eq(
        "team_id", team_id
    ).order("created_at", desc=True).range(offset, offset + limit - 1).execute()

    return result.data or []


async def update_session(session_id: str, updates: Dict[str, Any]):
    """Update session fields."""
    client = get_client()
    if not client:
        return

    updates["updated_at"] = datetime.utcnow().isoformat()
    client.table("discovery_sessions").update(updates).eq("id", session_id).execute()


# ============================================================================
# Subreddit Management
# ============================================================================

async def store_subreddit(
    session_id: str, team_id: str, subreddit_name: str,
    info: Dict[str, Any], relevance_reason: str = "", relevance_score: int = 50
) -> Optional[Dict[str, Any]]:
    """Store a discovered subreddit."""
    client = get_client()
    if not client:
        return None

    try:
        result = client.table("discovered_subreddits").upsert({
            "session_id": session_id,
            "team_id": team_id,
            "subreddit_name": subreddit_name,
            "subscriber_count": info.get("subscribers", 0),
            "description": info.get("description", ""),
            "relevance_reason": relevance_reason,
            "relevance_score": relevance_score,
            "status": "discovered",
        }, on_conflict="session_id,subreddit_name").execute()
        return result.data[0] if result.data else None
    except Exception as e:
        logger.warning(f"Failed to store subreddit r/{subreddit_name}: {e}")
        return None


async def get_session_subreddits(session_id: str, team_id: str) -> List[Dict[str, Any]]:
    """Get discovered subreddits for a session."""
    client = get_client()
    if not client:
        return []

    result = client.table("discovered_subreddits").select("*").eq(
        "session_id", session_id
    ).eq("team_id", team_id).order("relevance_score", desc=True).execute()

    return result.data or []


async def update_subreddit_stats(subreddit_id: str, posts_scanned: int, leads_found: int):
    """Update subreddit scan stats."""
    client = get_client()
    if not client:
        return

    client.table("discovered_subreddits").update({
        "posts_scanned": posts_scanned,
        "leads_found": leads_found,
        "status": "scanned",
    }).eq("id", subreddit_id).execute()


# ============================================================================
# Lead Management
# ============================================================================

async def store_lead(session_id: str, team_id: str, lead_data: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    """Store a discovered lead. Skips duplicates via unique index."""
    client = get_client()
    if not client:
        return None

    try:
        result = client.table("discovered_leads").upsert({
            "session_id": session_id,
            "team_id": team_id,
            "discovered_subreddit_id": lead_data.get("discovered_subreddit_id"),
            "post_url": lead_data["post_url"],
            "post_title": lead_data.get("post_title", ""),
            "post_body": lead_data.get("post_body", ""),
            "subreddit": lead_data["subreddit"],
            "post_created_utc": lead_data.get("post_created_utc", 0),
            "author_username": lead_data["author_username"],
            "source_type": lead_data.get("source_type", "post"),
            "source_comment_body": lead_data.get("source_comment_body"),
            "relevance_score": lead_data.get("relevance_score"),
            "buyer_intent": lead_data.get("buyer_intent"),
            "problem_awareness": lead_data.get("problem_awareness"),
            "product_fit": lead_data.get("product_fit"),
            "confidence": lead_data.get("confidence"),
            "classification_category": lead_data.get("classification_category"),
            "classification_reasoning": lead_data.get("classification_reasoning"),
            "is_qualified": lead_data.get("is_qualified"),
            "account_quality_score": lead_data.get("account_quality_score"),
            "engagement_score": lead_data.get("engagement_score"),
            "lead_score": lead_data.get("lead_score"),
            "lead_tier": lead_data.get("lead_tier"),
            "lead_insights": lead_data.get("lead_insights", []),
            "status": lead_data.get("status", "scored"),
        }, on_conflict="session_id,author_username,post_url").execute()
        return result.data[0] if result.data else None
    except Exception as e:
        logger.warning(f"Failed to store lead u/{lead_data.get('author_username')}: {e}")
        return None


async def get_session_leads(
    session_id: str, team_id: str,
    tier: str = None, status: str = None, subreddit: str = None,
    limit: int = 50, offset: int = 0
) -> List[Dict[str, Any]]:
    """Get leads for a session with optional filters."""
    client = get_client()
    if not client:
        return []

    query = client.table("discovered_leads").select("*").eq(
        "session_id", session_id
    ).eq("team_id", team_id)

    if tier:
        query = query.eq("lead_tier", tier)
    if status:
        query = query.eq("status", status)
    if subreddit:
        query = query.eq("subreddit", subreddit)

    query = query.order("lead_score", desc=True).range(offset, offset + limit - 1)
    result = query.execute()

    return result.data or []


async def get_lead(lead_id: str, team_id: str) -> Optional[Dict[str, Any]]:
    """Get a single lead by ID."""
    client = get_client()
    if not client:
        return None

    result = client.table("discovered_leads").select("*").eq(
        "id", lead_id
    ).eq("team_id", team_id).execute()

    return result.data[0] if result.data else None


async def update_lead(lead_id: str, updates: Dict[str, Any]):
    """Update a lead."""
    client = get_client()
    if not client:
        return

    updates["updated_at"] = datetime.utcnow().isoformat()
    client.table("discovered_leads").update(updates).eq("id", lead_id).execute()


async def dismiss_lead(lead_id: str, team_id: str):
    """Dismiss a lead."""
    client = get_client()
    if not client:
        return

    client.table("discovered_leads").update({
        "status": "dismissed",
        "updated_at": datetime.utcnow().isoformat(),
    }).eq("id", lead_id).eq("team_id", team_id).execute()


async def get_automation_stats(session_id: str, team_id: str) -> Dict[str, Any]:
    """Get queue item stats for leads from this discovery session."""
    client = get_client()
    if not client:
        return {"pending": 0, "approved": 0, "sent": 0, "failed": 0, "rejected": 0}

    # Get queue_item_ids from leads in this session
    leads_result = client.table("discovered_leads").select("queue_item_id").eq(
        "session_id", session_id
    ).eq("team_id", team_id).not_.is_("queue_item_id", "null").execute()

    queue_item_ids = [
        l["queue_item_id"] for l in (leads_result.data or [])
        if l.get("queue_item_id")
    ]

    stats = {"pending": 0, "approved": 0, "sent": 0, "failed": 0, "rejected": 0, "total": len(queue_item_ids)}
    if not queue_item_ids:
        return stats

    items_result = client.table("dm_queue").select("status").in_(
        "id", queue_item_ids
    ).execute()
    for item in (items_result.data or []):
        s = item.get("status", "pending")
        if s in stats:
            stats[s] += 1

    return stats


# ============================================================================
# Message Generation & Queueing
# ============================================================================

async def generate_message_for_lead(lead_id: str, team_id: str) -> Optional[str]:
    """Generate an outreach message for a discovered lead."""
    lead = await get_lead(lead_id, team_id)
    if not lead:
        return None

    # Get team settings
    client = get_client()
    settings_result = client.table("user_settings").select("*").eq(
        "team_id", team_id
    ).execute()
    settings = {}
    if settings_result.data:
        s = settings_result.data[0]
        settings = {
            "businessDesc": s.get("business_desc", ""),
            "persona": s.get("persona", ""),
            "insightTypes": s.get("insight_types", []),
            "tone": s.get("tone", "Curious"),
            "businessContext": s.get("business_context", ""),
        }

    post_data = {
        "url": lead["post_url"],
        "title": lead.get("post_title", ""),
        "body": lead.get("post_body", ""),
        "subreddit": lead["subreddit"],
        "author": lead["author_username"],
    }

    # Include source comment for comment-sourced leads
    if lead.get("source_type") == "comment" and lead.get("source_comment_body"):
        post_data["source_comment_body"] = lead["source_comment_body"]

    try:
        result = await llm_service.generate_question({
            "post": post_data,
            "settings": settings,
        })
        message = result["message"]
        reasoning = result.get("reasoning", "")
        await update_lead(lead_id, {
            "generated_message": message,
            "message_reasoning": reasoning,
        })
        return {"message": message, "reasoning": reasoning}
    except Exception as e:
        logger.error(f"Failed to generate message for lead {lead_id}: {e}")
        return None


async def queue_lead(
    lead_id: str, team_id: str, account_id: str,
    edited_message: str = None
) -> Optional[Dict[str, Any]]:
    """Queue a discovered lead for outreach."""
    from . import queue as queue_service

    lead = await get_lead(lead_id, team_id)
    if not lead:
        return None

    message = edited_message or lead.get("generated_message")
    if not message:
        gen_result = await generate_message_for_lead(lead_id, team_id)
        if not gen_result:
            return None
        message = gen_result["message"] if isinstance(gen_result, dict) else gen_result

    queue_item = await queue_service.add_to_queue({
        "accountId": account_id,
        "recipientUsername": lead["author_username"],
        "subreddit": lead["subreddit"],
        "postUrl": lead["post_url"],
        "postTitle": lead.get("post_title", ""),
        "postBody": lead.get("post_body", ""),
        "classificationScore": lead.get("relevance_score"),
        "classificationCategory": lead.get("classification_category"),
        "generatedMessage": message,
        "status": "pending",
        "queueMode": "review",
        "messageType": "outreach",
    }, team_id=team_id)

    if queue_item:
        await update_lead(lead_id, {
            "status": "queued",
            "queue_item_id": queue_item.get("id"),
            "generated_message": message,
        })

    return queue_item


async def bulk_queue_leads(
    lead_ids: List[str], team_id: str, account_id: str
) -> Dict[str, Any]:
    """Queue multiple leads."""
    results = {"queued": 0, "failed": 0, "errors": []}
    for lead_id in lead_ids:
        try:
            result = await queue_lead(lead_id, team_id, account_id)
            if result:
                results["queued"] += 1
            else:
                results["failed"] += 1
                results["errors"].append(f"Lead {lead_id}: failed to queue")
        except Exception as e:
            results["failed"] += 1
            results["errors"].append(f"Lead {lead_id}: {str(e)}")
    return results


# ============================================================================
# Search Strategy Generation
# ============================================================================

STRATEGY_SYSTEM_PROMPT = """You are an expert at finding potential customers on Reddit.
Given a business description and target persona, generate search strategies to find
people discussing problems this business solves.

RESPOND IN VALID JSON FORMAT ONLY (no markdown, no explanation):
{
    "keywords": ["keyword1", "keyword2", ...],
    "pain_phrases": ["struggling with X", "need help with Y", ...],
    "intent_queries": ["best tool for X", "looking for alternative to Y", ...],
    "suggested_subreddits": ["subreddit1", "subreddit2", ...]
}

GUIDELINES:
- keywords: 5-10 specific search terms (product categories, problem names, tool names)
- pain_phrases: 5-8 natural language phrases people use when describing the problem
- intent_queries: 3-5 buying-intent search queries (comparing, looking for, best)
- suggested_subreddits: 5-15 subreddits where the target audience hangs out (names only, no r/ prefix)
- Think about adjacent/related problems, not just direct matches
- Include both technical and non-technical language variants
- Consider competitor names as keywords"""

MAX_STRATEGY_RETRIES = 2


def _strip_json_fences(text: str) -> str:
    """Remove markdown code fences from LLM output."""
    text = text.strip()
    if "```json" in text:
        text = text.split("```json", 1)[1].split("```", 1)[0].strip()
    elif "```" in text:
        text = text.split("```", 1)[1].split("```", 1)[0].strip()
    return text


def _repair_json(text: str) -> str:
    """Best-effort repair of common JSON issues from LLM output."""
    # Remove trailing commas before ] or }
    text = re.sub(r',\s*([}\]])', r'\1', text)
    # If the string is truncated, try to close open structures
    open_braces = text.count('{') - text.count('}')
    open_brackets = text.count('[') - text.count(']')
    # Check for unterminated string (odd number of unescaped quotes)
    in_string = False
    i = 0
    while i < len(text):
        ch = text[i]
        if ch == '\\' and in_string:
            i += 2
            continue
        if ch == '"':
            in_string = not in_string
        i += 1
    if in_string:
        text += '"'
    text += ']' * max(open_brackets, 0)
    text += '}' * max(open_braces, 0)
    return text


async def generate_search_strategy(session_id: str, settings: Dict[str, Any]) -> Dict[str, Any]:
    """Use LLM to generate search keywords, pain phrases, and subreddit suggestions."""
    user_prompt = f"""Business Description: {settings.get('businessDesc', 'Not specified')}
Target Persona: {settings.get('persona', 'Not specified')}
Tone: {settings.get('tone', 'Curious')}
Insight Types: {', '.join(settings.get('insightTypes', []))}"""

    last_error = None
    for attempt in range(1, MAX_STRATEGY_RETRIES + 1):
        try:
            content = await gemini_client.generate_content(
                system_instruction=STRATEGY_SYSTEM_PROMPT,
                user_prompt=user_prompt,
                temperature=0.7,
                max_tokens=1000,
                response_mime_type="application/json",
            )

            json_str = _strip_json_fences(content)

            # Try parsing directly first, then with repair
            try:
                strategy = json.loads(json_str)
            except json.JSONDecodeError:
                logger.warning(f"Strategy JSON parse failed (attempt {attempt}), trying repair")
                strategy = json.loads(_repair_json(json_str))

            # Validate structure
            strategy.setdefault("keywords", [])
            strategy.setdefault("pain_phrases", [])
            strategy.setdefault("intent_queries", [])
            strategy.setdefault("suggested_subreddits", [])

            # Store strategy in session
            await update_session(session_id, {"search_strategy": strategy})

            return strategy

        except Exception as e:
            last_error = e
            logger.warning(f"generate_search_strategy attempt {attempt}/{MAX_STRATEGY_RETRIES} failed: {e}")
            if attempt < MAX_STRATEGY_RETRIES:
                await asyncio.sleep(1)

    logger.error(f"Failed to generate search strategy after {MAX_STRATEGY_RETRIES} attempts: {last_error}")
    raise ValueError("Failed to generate search strategy")


# ============================================================================
# Comment Lead Identification
# ============================================================================

COMMENT_ANALYSIS_PROMPT = """Analyze these Reddit comments from a post about: {post_title}

BUSINESS CONTEXT: {business_desc}
TARGET PERSONA: {persona}

For each comment, determine if the commenter could be a potential lead.
Look for: pain points, frustrations, questions about solutions, buying intent,
professional context, decision-maker signals.

RESPOND IN VALID JSON FORMAT ONLY (no markdown):
{{
    "leads": [
        {{
            "author": "username",
            "reason": "why they're a lead",
            "relevance_score": 0-100,
            "buyer_intent": 0-100,
            "comment_excerpt": "key quote"
        }}
    ]
}}

Only include commenters scoring >= 50 on relevance. Max 5 leads.
Exclude [deleted] users and bot-like accounts."""


async def identify_comment_leads(
    comments: List[Dict[str, Any]], post_title: str, settings: Dict[str, Any]
) -> List[Dict[str, Any]]:
    """Use LLM to identify potential leads from post comments."""
    if not comments:
        return []

    # Format comments for the prompt
    comments_text = "\n".join([
        f"u/{c.get('author', 'unknown')}: {c.get('body', '')[:300]}"
        for c in comments[:20]
        if c.get("author") and c.get("author") != "[deleted]"
    ])

    prompt = COMMENT_ANALYSIS_PROMPT.format(
        post_title=post_title,
        business_desc=settings.get("businessDesc", ""),
        persona=settings.get("persona", ""),
    )

    try:
        content = await gemini_client.generate_content(
            system_instruction=prompt,
            user_prompt=f"COMMENTS:\n{comments_text}",
            temperature=0.5,
            max_tokens=800,
            response_mime_type="application/json",
        )

        json_str = _strip_json_fences(content)
        try:
            parsed = json.loads(json_str)
        except json.JSONDecodeError:
            parsed = json.loads(_repair_json(json_str))
        return parsed.get("leads", [])

    except Exception as e:
        logger.warning(f"Comment lead identification failed: {e}")
        return []


# ============================================================================
# Deduplication
# ============================================================================

async def check_already_contacted(author_username: str, team_id: str) -> bool:
    """Check if we've already contacted this user. Uses unified dedup service."""
    from . import dedup
    result = await dedup.has_been_contacted(author_username, team_id)
    return result.get("contacted", False)


# ============================================================================
# Pre-filter Helpers
# ============================================================================

def _post_matches_keywords(post: Dict[str, Any], keywords: List[str], min_matches: int = 1) -> bool:
    """
    Lightweight keyword pre-filter. Returns True if the post title+body
    contains at least `min_matches` keywords (case-insensitive).
    Avoids sending obviously irrelevant posts to the expensive LLM classifier.
    """
    if not keywords:
        return True

    text = (post.get("title", "") + " " + post.get("body", "")).lower()
    if not text.strip():
        return False

    match_count = 0
    for kw in keywords:
        if kw.lower() in text:
            match_count += 1
            if match_count >= min_matches:
                return True
    return False


# ============================================================================
# Main Discovery Pipeline
# ============================================================================

async def run_discovery_pipeline(session_id: str):
    """
    Main orchestrator. Runs as a background task.
    1. Generate search strategy
    2. Discover subreddits
    3. Search posts in each subreddit
    4. Score each post (classify + qualify + lead score)
    5. Mine comments from top posts
    6. Mark already-contacted leads
    """
    try:
        # Load session
        client = get_client()
        if not client:
            await update_session(session_id, {"status": "failed"})
            return

        session_result = client.table("discovery_sessions").select("*").eq(
            "id", session_id
        ).execute()
        if not session_result.data:
            return
        session = session_result.data[0]
        team_id = session["team_id"]

        settings = {
            "businessDesc": session["business_desc"],
            "persona": session.get("target_persona", ""),
            "tone": session.get("tone", "Curious"),
            "insightTypes": session.get("insight_types", []),
        }

        is_automation = session.get("mode") == "automation"
        target_subs = session.get("target_subreddits") or []

        # ---- Phase 1: Generate search strategy ----
        await update_session(session_id, {
            "status": "searching",
            "started_at": datetime.utcnow().isoformat(),
        })

        if is_automation and target_subs:
            # Automation mode: generate keywords for search, but use provided subreddits
            strategy = await generate_search_strategy(session_id, settings)
            keywords = strategy.get("keywords", [])
            pain_phrases = strategy.get("pain_phrases", [])
            intent_queries = strategy.get("intent_queries", [])
            suggested_subreddits = []  # Skip AI subreddit suggestions
        else:
            strategy = await generate_search_strategy(session_id, settings)
            keywords = strategy.get("keywords", [])
            pain_phrases = strategy.get("pain_phrases", [])
            intent_queries = strategy.get("intent_queries", [])
            suggested_subreddits = strategy.get("suggested_subreddits", [])

        all_queries = keywords + pain_phrases[:3] + intent_queries[:2]
        total_queries = len(all_queries) * max(len(suggested_subreddits), 1)
        await update_session(session_id, {"total_queries_planned": total_queries})

        # ---- Phase 2: Discover subreddits ----
        subreddit_names = set()

        if is_automation and target_subs:
            # Automation mode: use explicitly provided subreddits
            for sr in target_subs[:MAX_SUBREDDITS]:
                sr_name = sr.strip().replace("r/", "")
                if sr_name:
                    subreddit_names.add(sr_name)
        else:
            # Discovery mode: AI-suggested + keyword search
            for sr in suggested_subreddits[:MAX_SUBREDDITS]:
                sr_name = sr.strip().replace("r/", "")
                if sr_name:
                    subreddit_names.add(sr_name)

            for keyword in keywords[:3]:
                try:
                    results = await reddit_search.search_subreddits(keyword, limit=5)
                    for sr in results:
                        name = sr.get("name", "")
                        if name and not sr.get("over18", False):
                            subreddit_names.add(name)
                except Exception as e:
                    logger.warning(f"Subreddit search failed for '{keyword}': {e}")

        # Limit total subreddits
        subreddit_names = list(subreddit_names)[:MAX_SUBREDDITS]

        # Store subreddits with metadata
        subreddit_records = {}
        for sr_name in subreddit_names:
            info = await reddit_search.get_subreddit_info(sr_name)
            if info:
                record = await store_subreddit(
                    session_id, team_id, sr_name, info,
                    relevance_reason=f"Matches business context: {settings.get('businessDesc', '')[:100]}"
                )
                if record:
                    subreddit_records[sr_name] = record

        # ---- Phase 3: Search posts ----
        await update_session(session_id, {"status": "scoring"})

        all_posts = []  # (normalized_post, subreddit_record_id)
        seen_urls = set()
        queries_done = 0

        # Only search subreddits that were validated (info fetch succeeded)
        valid_subreddit_names = [sr for sr in subreddit_names if sr in subreddit_records]
        if len(valid_subreddit_names) < len(subreddit_names):
            skipped = len(subreddit_names) - len(valid_subreddit_names)
            logger.info(f"Skipping {skipped} invalid subreddits (info fetch failed)")

        for sr_name in valid_subreddit_names:
            sr_record = subreddit_records[sr_name]
            sr_record_id = sr_record["id"]

            # Search with keywords and pain phrases
            for query in all_queries:
                try:
                    posts = await reddit_search.search_subreddit_posts(
                        subreddit=sr_name,
                        query=query,
                        sort="relevance",
                        timeframe="week",
                    )
                    for post in posts:
                        try:
                            normalized = reddit_search.normalize_post(post)
                            url = normalized["url"]
                            if url and url not in seen_urls and normalized["author"] and normalized["author"] != "[deleted]":
                                seen_urls.add(url)
                                all_posts.append((normalized, sr_record_id))
                        except Exception as e:
                            logger.warning(f"Failed to normalize post in r/{sr_name}: {e}")
                except Exception as e:
                    logger.warning(f"Post search failed for r/{sr_name} query '{query}': {e}")

                queries_done += 1
                await update_session(session_id, {"queries_completed": queries_done})

            # Also get hot posts — but only keep those with keyword overlap
            try:
                hot_posts = await reddit_search.get_subreddit_posts(sr_name, sort="hot")
                for post in hot_posts:
                    try:
                        normalized = reddit_search.normalize_post(post)
                        url = normalized["url"]
                        if url and url not in seen_urls and normalized["author"] and normalized["author"] != "[deleted]":
                            if _post_matches_keywords(normalized, keywords):
                                seen_urls.add(url)
                                all_posts.append((normalized, sr_record_id))
                    except Exception as e:
                        logger.warning(f"Failed to normalize hot post in r/{sr_name}: {e}")
            except Exception as e:
                logger.warning(f"Hot posts fetch failed for r/{sr_name}: {e}")

        await update_session(session_id, {"total_posts_found": len(all_posts)})

        # ---- Phase 4: Score each post ----
        leads_scored = 0
        leads_qualified = 0
        scored_posts = []  # Track for comment mining
        seen_authors = set()  # Deduplicate authors across posts

        # Track per-subreddit stats
        subreddit_stats = {}  # sr_name -> {posts: 0, leads: 0}

        for normalized_post, sr_record_id in all_posts:
            try:
                # Stop once we have enough qualified leads
                if leads_qualified >= MAX_LEADS:
                    logger.info(f"Reached {MAX_LEADS} leads, stopping scoring")
                    break

                # Check if session was cancelled
                session_check = await get_session(session_id, team_id)
                if session_check and session_check.get("status") == "cancelled":
                    logger.info(f"Discovery session {session_id} cancelled")
                    return

                author = normalized_post["author"]
                sr_name = normalized_post["subreddit"]

                if sr_name not in subreddit_stats:
                    subreddit_stats[sr_name] = {"posts": 0, "leads": 0}
                subreddit_stats[sr_name]["posts"] += 1

                # Skip duplicate authors — keep first (most relevant) post
                if author.lower() in seen_authors:
                    leads_scored += 1
                    continue
                seen_authors.add(author.lower())

                # Skip already-contacted users — no need to classify/qualify
                already_contacted = await check_already_contacted(author, team_id)
                if already_contacted:
                    leads_scored += 1
                    continue

                # Classify post
                classification = await classification_service.classify_post(
                    normalized_post, settings
                )

                if classification.get("category") == "not_relevant":
                    leads_scored += 1
                    continue

                # Qualify user
                qualification = await qualification_service.qualify_user(author)

                # Calculate lead score
                lead_score_result = await lead_scoring.calculate_lead_score(
                    post=normalized_post,
                    classification=classification,
                    qualification=qualification,
                )

                score = lead_score_result.get("score", 0)
                tier = lead_score_result.get("tier", "cold")

                lead_data = {
                    "discovered_subreddit_id": sr_record_id,
                    "post_url": normalized_post["url"],
                    "post_title": normalized_post["title"],
                    "post_body": normalized_post["body"][:2000],
                    "subreddit": sr_name,
                    "post_created_utc": normalized_post.get("created_utc", 0),
                    "author_username": author,
                    "source_type": "post",
                    "relevance_score": classification.get("relevanceScore"),
                    "buyer_intent": classification.get("buyerIntent"),
                    "problem_awareness": classification.get("problemAwareness"),
                    "product_fit": classification.get("productFit"),
                    "confidence": classification.get("confidence"),
                    "classification_category": classification.get("category"),
                    "classification_reasoning": classification.get("reasoning"),
                    "is_qualified": qualification.get("isQualified", False),
                    "account_quality_score": qualification.get("accountQualityScore"),
                    "engagement_score": qualification.get("engagementScore"),
                    "lead_score": score,
                    "lead_tier": tier,
                    "lead_insights": lead_score_result.get("insights", []),
                    "status": "scored",
                }

                await store_lead(session_id, team_id, lead_data)
                leads_scored += 1
                leads_qualified += 1
                subreddit_stats[sr_name]["leads"] += 1

                # Track high-scoring posts for comment mining
                if score >= 50:
                    scored_posts.append((normalized_post, score, sr_record_id))

                # Batch session updates every 10 posts
                if leads_scored % 10 == 0:
                    await update_session(session_id, {
                        "total_leads_scored": leads_scored,
                        "leads_qualified": leads_qualified,
                    })

            except Exception as e:
                logger.warning(f"Failed to score post by u/{normalized_post.get('author')}: {e}")
                leads_scored += 1

        # Final session update after loop
        await update_session(session_id, {
            "total_leads_scored": leads_scored,
            "leads_qualified": leads_qualified,
        })

        # Update subreddit stats
        for sr_name, stats in subreddit_stats.items():
            sr_record = subreddit_records.get(sr_name)
            if sr_record:
                await update_subreddit_stats(
                    sr_record["id"], stats["posts"], stats["leads"]
                )

        # ---- Phase 4.5: Auto-queue qualified leads (automation mode) ----
        if session.get("auto_queue") and session.get("account_id"):
            await update_session(session_id, {"status": "queuing"})
            account_id = session["account_id"]
            min_score = session.get("min_lead_score", 50)
            should_auto_approve = session.get("auto_approve", False)

            qualified_leads = await get_session_leads(
                session_id, team_id, status="scored", limit=200
            )
            qualified_leads = [
                l for l in qualified_leads
                if (l.get("lead_score") or 0) >= min_score
            ]

            leads_queued_count = 0
            leads_approved_count = 0

            for lead in qualified_leads:
                try:
                    # Check cancellation
                    session_check = await get_session(session_id, team_id)
                    if session_check and session_check.get("status") == "cancelled":
                        logger.info(f"Discovery session {session_id} cancelled during auto-queue")
                        return

                    # Generate message and queue
                    queue_item = await queue_lead(lead["id"], team_id, account_id)
                    if not queue_item:
                        continue
                    leads_queued_count += 1

                    # Auto-approve if requested
                    if should_auto_approve and queue_item.get("id"):
                        from . import queue as queue_service
                        await queue_service.approve_queue_item(
                            queue_item["id"], approved_by="automation", team_id=team_id
                        )
                        leads_approved_count += 1

                except Exception as e:
                    logger.warning(f"Auto-queue failed for lead {lead.get('id')}: {e}")

            await update_session(session_id, {
                "leads_queued": leads_queued_count,
                "leads_auto_approved": leads_approved_count,
            })
            logger.info(
                f"Auto-queue complete for session {session_id}: "
                f"{leads_queued_count} queued, {leads_approved_count} approved"
            )

        # ---- Phase 5: Comment mining on top posts ----
        scored_posts.sort(key=lambda x: x[1], reverse=True)
        top_posts = scored_posts[:MAX_COMMENT_MINING_POSTS]

        for normalized_post, _, sr_record_id in top_posts:
            try:
                session_check = await get_session(session_id, team_id)
                if session_check and session_check.get("status") == "cancelled":
                    return

                post_url = normalized_post["url"]
                if not post_url:
                    continue

                comments = await reddit_search.get_post_comments(post_url)
                if not comments:
                    continue

                normalized_comments = [reddit_search.normalize_comment(c) for c in comments]
                comment_leads = await identify_comment_leads(
                    normalized_comments, normalized_post["title"], settings
                )

                for cl in comment_leads:
                    comment_author = cl.get("author", "")
                    if not comment_author or comment_author == "[deleted]":
                        continue

                    already_contacted = await check_already_contacted(comment_author, team_id)

                    # Qualify the commenter
                    try:
                        qualification = await qualification_service.qualify_user(comment_author)
                    except Exception:
                        qualification = {}

                    lead_data = {
                        "discovered_subreddit_id": sr_record_id,
                        "post_url": post_url,
                        "post_title": normalized_post["title"],
                        "post_body": normalized_post["body"][:2000],
                        "subreddit": normalized_post["subreddit"],
                        "post_created_utc": normalized_post.get("created_utc", 0),
                        "author_username": comment_author,
                        "source_type": "comment",
                        "source_comment_body": cl.get("comment_excerpt", ""),
                        "relevance_score": cl.get("relevance_score", 50),
                        "buyer_intent": cl.get("buyer_intent", 50),
                        "problem_awareness": 50,
                        "product_fit": 50,
                        "confidence": 60,
                        "classification_category": "weak_match" if cl.get("relevance_score", 0) >= 50 else "not_relevant",
                        "classification_reasoning": cl.get("reason", ""),
                        "is_qualified": qualification.get("isQualified", False),
                        "account_quality_score": qualification.get("accountQualityScore"),
                        "engagement_score": qualification.get("engagementScore"),
                        "lead_score": cl.get("relevance_score", 50),
                        "lead_tier": "warm" if cl.get("relevance_score", 0) >= 60 else "cold",
                        "lead_insights": [{"type": "comment_lead", "message": cl.get("reason", "")}],
                        "status": "already_contacted" if already_contacted else "scored",
                    }

                    await store_lead(session_id, team_id, lead_data)
                    leads_qualified += 1

            except Exception as e:
                logger.warning(f"Comment mining failed for {normalized_post.get('url')}: {e}")

        # ---- Phase 6: Complete ----
        await update_session(session_id, {
            "status": "completed",
            "completed_at": datetime.utcnow().isoformat(),
            "leads_qualified": leads_qualified,
        })

        logger.info(
            f"Discovery session {session_id} completed: "
            f"{len(all_posts)} posts found, {leads_qualified} leads qualified"
        )

    except Exception as e:
        logger.error(f"Discovery pipeline failed for session {session_id}: {e}", exc_info=True)
        try:
            await update_session(session_id, {"status": "failed"})
        except Exception:
            pass
