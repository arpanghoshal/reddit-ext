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
from . import llm as llm_service
from . import gemini_client

logger = logging.getLogger(__name__)

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
Given a business description and target persona, generate exactly 5 diverse Reddit search
queries that would find posts from people who need this product/service.

RESPOND IN VALID JSON FORMAT ONLY (no markdown, no explanation):
{
    "queries": ["query 1", "query 2", "query 3", "query 4", "query 5"]
}

GUIDELINES:
- Generate exactly 5 search queries optimized for Reddit's search engine
- Each query should be 3-8 words — specific enough to find relevant posts
- Query 1: core problem/need (e.g. "best electric scooter commute")
- Query 2: pain points or frustrations (e.g. "frustrated with X alternative needed")
- Query 3: buying intent or recommendations (e.g. "looking for alternative to X")
- Query 4: competitor comparison or adjacent problem (e.g. "X vs Y recommendation")
- Query 5: different angle — use case, industry term, or niche phrasing (e.g. "how to solve Y for small business")
- Make each query distinct — cover different angles, synonyms, and phrasings
- Think about what real people would actually type when looking for help
- Do NOT include subreddit names in queries — the search covers all of Reddit"""

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

            # Validate structure — new format has "queries" list
            strategy.setdefault("queries", [])
            # Backward compat: if old format returned, build queries from keywords
            if not strategy["queries"] and strategy.get("keywords"):
                strategy["queries"] = strategy["keywords"][:5]

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
# Main Discovery Pipeline
# ============================================================================

async def run_discovery_pipeline(session_id: str):
    """
    Main orchestrator. Runs as a background task.
    Optimized for minimal API calls:
      - 1 Gemini call: search strategy (5 queries)
      - 5 ScrapeCreators calls: global Reddit search
      - 1-3 Gemini calls: batch classification
      - 1-2 ScrapeCreators calls: comment mining on top posts
      - 1 Gemini call: batch comment lead analysis
    Total: ~7 ScrapeCreators + 3-5 Gemini calls
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

        # ---- Phase 1: Generate search strategy (1 Gemini call) ----
        await update_session(session_id, {
            "status": "searching",
            "started_at": datetime.utcnow().isoformat(),
        })

        strategy = await generate_search_strategy(session_id, settings)
        search_queries = strategy.get("queries", [])[:5]

        if not search_queries:
            logger.error(f"No search queries generated for session {session_id}")
            await update_session(session_id, {"status": "failed"})
            return

        await update_session(session_id, {
            "total_queries_planned": len(search_queries),
        })

        # ---- Phase 2+3: Search posts (2-3 ScrapeCreators calls) ----
        await update_session(session_id, {"status": "scoring"})

        all_posts = []  # list of normalized_post dicts
        seen_urls = set()
        seen_authors = set()

        if is_automation and target_subs:
            # Automation mode: search within specific subreddits
            for sr_name in target_subs[:2]:
                sr_name = sr_name.strip().replace("r/", "")
                if not sr_name:
                    continue
                for query in search_queries[:3]:
                    try:
                        posts = await reddit_search.search_subreddit_posts(
                            subreddit=sr_name, query=query,
                            sort="relevance", timeframe="week",
                        )
                        for post in posts:
                            try:
                                normalized = reddit_search.normalize_post(post)
                                url = normalized["url"]
                                author = normalized.get("author", "")
                                if (url and url not in seen_urls
                                        and author and author != "[deleted]"
                                        and author.lower() not in seen_authors):
                                    seen_urls.add(url)
                                    seen_authors.add(author.lower())
                                    all_posts.append(normalized)
                            except Exception as e:
                                logger.warning(f"Failed to normalize post: {e}")
                    except Exception as e:
                        logger.warning(f"Search failed for r/{sr_name} '{query}': {e}")
        else:
            # Discovery mode: global Reddit search with LLM-generated queries
            for query in search_queries:
                try:
                    posts = await reddit_search.search_posts(query, sort="relevance")
                    for post in posts:
                        try:
                            normalized = reddit_search.normalize_post(post)
                            url = normalized["url"]
                            author = normalized.get("author", "")
                            if (url and url not in seen_urls
                                    and author and author != "[deleted]"
                                    and author.lower() not in seen_authors):
                                seen_urls.add(url)
                                seen_authors.add(author.lower())
                                all_posts.append(normalized)
                        except Exception as e:
                            logger.warning(f"Failed to normalize post: {e}")
                except Exception as e:
                    logger.warning(f"Global search failed for '{query}': {e}")

        logger.info(f"Found {len(all_posts)} unique posts from {len(search_queries)} queries")
        await update_session(session_id, {
            "total_posts_found": len(all_posts),
            "queries_completed": len(search_queries),
        })

        if not all_posts:
            await update_session(session_id, {
                "status": "completed",
                "completed_at": datetime.utcnow().isoformat(),
                "leads_qualified": 0,
            })
            logger.info(f"Discovery session {session_id} completed: 0 posts found")
            return

        # Extract subreddits from post results (no API calls)
        subreddit_records = {}
        for post in all_posts:
            sr_name = post.get("subreddit", "")
            if sr_name and sr_name not in subreddit_records:
                try:
                    record = await store_subreddit(
                        session_id, team_id, sr_name,
                        {"subscribers": 0, "description": ""},
                        relevance_reason=f"Found in search results"
                    )
                    if record:
                        subreddit_records[sr_name] = record
                except Exception as e:
                    logger.warning(f"Failed to store subreddit {sr_name}: {e}")

        # ---- Phase 4: Batch classify + score (1-3 Gemini calls) ----

        # Filter out already-contacted authors (DB checks only, no API calls)
        posts_to_classify = []
        for post in all_posts:
            author = post["author"]
            already_contacted = await check_already_contacted(author, team_id)
            if not already_contacted:
                posts_to_classify.append(post)

        logger.info(
            f"Classifying {len(posts_to_classify)} posts "
            f"(skipped {len(all_posts) - len(posts_to_classify)} already-contacted)"
        )

        if not posts_to_classify:
            await update_session(session_id, {
                "status": "completed",
                "completed_at": datetime.utcnow().isoformat(),
                "total_leads_scored": len(all_posts),
                "leads_qualified": 0,
            })
            logger.info(f"Discovery session {session_id} completed: all authors already contacted")
            return

        # Batch classify all posts (1-3 Gemini calls instead of N)
        classifications = await classification_service.batch_classify_posts(
            posts_to_classify, settings
        )

        # Score and store leads
        leads_qualified = 0
        scored_posts = []  # For comment mining
        subreddit_stats = {}

        for i, post in enumerate(posts_to_classify):
            if leads_qualified >= MAX_LEADS:
                logger.info(f"Reached {MAX_LEADS} leads, stopping")
                break

            classification = classifications[i] if i < len(classifications) else {}
            if not classification or classification.get("category") == "not_relevant":
                continue

            sr_name = post.get("subreddit", "")
            if sr_name not in subreddit_stats:
                subreddit_stats[sr_name] = {"posts": 0, "leads": 0}
            subreddit_stats[sr_name]["posts"] += 1

            # Calculate lead score from classification (no API call)
            relevance = classification.get("relevanceScore", 0)
            buyer_intent = classification.get("buyerIntent", 0)
            product_fit = classification.get("productFit", 0)
            confidence = classification.get("confidence", 0)
            score = (relevance * 0.4) + (buyer_intent * 0.3) + (product_fit * 0.2) + (confidence * 0.1)
            score = round(score)

            if relevance >= 70 and buyer_intent >= 60:
                tier = "hot"
            elif relevance >= 50 or buyer_intent >= 40:
                tier = "warm"
            else:
                tier = "cold"

            sr_record = subreddit_records.get(sr_name, {})

            lead_data = {
                "discovered_subreddit_id": sr_record.get("id"),
                "post_url": post["url"],
                "post_title": post["title"],
                "post_body": post["body"][:2000],
                "subreddit": sr_name,
                "post_created_utc": post.get("created_utc", 0),
                "author_username": post["author"],
                "source_type": "post",
                "relevance_score": relevance,
                "buyer_intent": buyer_intent,
                "problem_awareness": classification.get("problemAwareness", 0),
                "product_fit": product_fit,
                "confidence": confidence,
                "classification_category": classification.get("category"),
                "classification_reasoning": classification.get("reasoning"),
                "is_qualified": score >= 50,
                "account_quality_score": None,
                "engagement_score": None,
                "lead_score": score,
                "lead_tier": tier,
                "lead_insights": [{"type": "classification", "message": classification.get("reasoning", "")}],
                "status": "scored",
            }

            try:
                await store_lead(session_id, team_id, lead_data)
                leads_qualified += 1
                subreddit_stats[sr_name]["leads"] += 1

                if score >= 50:
                    scored_posts.append((post, score, sr_record.get("id")))
            except Exception as e:
                logger.warning(f"Failed to store lead for u/{post['author']}: {e}")

        await update_session(session_id, {
            "total_leads_scored": len(posts_to_classify),
            "leads_qualified": leads_qualified,
        })

        # Update subreddit stats
        for sr_name, stats in subreddit_stats.items():
            sr_record = subreddit_records.get(sr_name)
            if sr_record:
                await update_subreddit_stats(
                    sr_record["id"], stats["posts"], stats["leads"]
                )

        # ---- Phase 4.5: Auto-queue (no message generation — deferred to on-demand) ----
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
                    queue_item = await queue_lead(lead["id"], team_id, account_id)
                    if not queue_item:
                        continue
                    leads_queued_count += 1

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

        # ---- Phase 5: Comment mining on top 2 posts (1-2 SC + 1 Gemini) ----
        MAX_COMMENT_MINING = 2
        scored_posts.sort(key=lambda x: x[1], reverse=True)
        top_posts = scored_posts[:MAX_COMMENT_MINING]

        # Collect comments from top posts, then analyze in batch
        all_comment_data = []  # (normalized_comments, post, sr_record_id)
        for post, _, sr_record_id in top_posts:
            post_url = post.get("url", "")
            if not post_url:
                continue
            try:
                comments = await reddit_search.get_post_comments(post_url)
                if comments:
                    normalized_comments = [reddit_search.normalize_comment(c) for c in comments]
                    all_comment_data.append((normalized_comments, post, sr_record_id))
            except Exception as e:
                logger.warning(f"Comment fetch failed for {post_url}: {e}")

        # Batch analyze all comments in a single Gemini call
        if all_comment_data:
            # Build combined prompt for all posts' comments
            combined_comments_text = ""
            post_boundaries = []  # (start_line, post_title)
            for normalized_comments, post, _ in all_comment_data:
                post_title = post.get("title", "")
                combined_comments_text += f"\n--- POST: {post_title} ---\n"
                for c in normalized_comments[:15]:
                    author = c.get("author", "unknown")
                    body = (c.get("body") or "")[:300]
                    if author and author != "[deleted]" and body:
                        combined_comments_text += f"u/{author}: {body}\n"
                post_boundaries.append(post_title)

            if combined_comments_text.strip():
                # Single Gemini call for all comment analysis
                try:
                    batch_comment_prompt = COMMENT_ANALYSIS_PROMPT.format(
                        post_title=" | ".join(post_boundaries),
                        business_desc=settings.get("businessDesc", ""),
                        persona=settings.get("persona", ""),
                    )
                    content = await gemini_client.generate_content(
                        system_instruction=batch_comment_prompt,
                        user_prompt=f"COMMENTS:\n{combined_comments_text}",
                        temperature=0.5,
                        max_tokens=800,
                        response_mime_type="application/json",
                    )

                    json_str = _strip_json_fences(content)
                    try:
                        parsed = json.loads(json_str)
                    except json.JSONDecodeError:
                        parsed = json.loads(_repair_json(json_str))

                    comment_leads = parsed.get("leads", [])

                    # Use the first post's sr_record_id as default
                    default_sr_id = all_comment_data[0][2] if all_comment_data else None

                    for cl in comment_leads:
                        comment_author = cl.get("author", "")
                        if not comment_author or comment_author == "[deleted]":
                            continue
                        if comment_author.lower() in seen_authors:
                            continue
                        seen_authors.add(comment_author.lower())

                        already_contacted = await check_already_contacted(comment_author, team_id)

                        # Find which post this comment belongs to
                        source_post = all_comment_data[0][1]  # default to first
                        for nc, p, sr_id in all_comment_data:
                            for c in nc:
                                if c.get("author", "").lower() == comment_author.lower():
                                    source_post = p
                                    default_sr_id = sr_id
                                    break

                        rel_score = cl.get("relevance_score", 50)
                        lead_data = {
                            "discovered_subreddit_id": default_sr_id,
                            "post_url": source_post.get("url", ""),
                            "post_title": source_post.get("title", ""),
                            "post_body": source_post.get("body", "")[:2000],
                            "subreddit": source_post.get("subreddit", ""),
                            "post_created_utc": source_post.get("created_utc", 0),
                            "author_username": comment_author,
                            "source_type": "comment",
                            "source_comment_body": cl.get("comment_excerpt", ""),
                            "relevance_score": rel_score,
                            "buyer_intent": cl.get("buyer_intent", 50),
                            "problem_awareness": 50,
                            "product_fit": 50,
                            "confidence": 60,
                            "classification_category": "weak_match" if rel_score >= 50 else "not_relevant",
                            "classification_reasoning": cl.get("reason", ""),
                            "is_qualified": rel_score >= 50,
                            "account_quality_score": None,
                            "engagement_score": None,
                            "lead_score": rel_score,
                            "lead_tier": "warm" if rel_score >= 60 else "cold",
                            "lead_insights": [{"type": "comment_lead", "message": cl.get("reason", "")}],
                            "status": "already_contacted" if already_contacted else "scored",
                        }

                        await store_lead(session_id, team_id, lead_data)
                        if not already_contacted:
                            leads_qualified += 1

                except Exception as e:
                    logger.warning(f"Batch comment analysis failed: {e}")

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
