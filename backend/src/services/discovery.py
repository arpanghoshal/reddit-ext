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

from . import serpapi_client
from . import reddit_search
from . import classification as classification_service
from . import llm as llm_service
from . import gemini_client

logger = logging.getLogger(__name__)

MAX_LEADS = 75

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
        # Timeframe control
        "timeframe": input_data.get("timeframe", "w"),
        "timeframe_start": input_data.get("timeframeStart"),
        "timeframe_end": input_data.get("timeframeEnd"),
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
    relevance: str = None,
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

    # Relevance filter: "relevant" excludes irrelevant, "irrelevant" shows only irrelevant
    if relevance == "relevant":
        query = query.neq("lead_tier", "irrelevant")
    elif relevance == "irrelevant":
        query = query.eq("lead_tier", "irrelevant")
    # "all" or None = no filter

    query = query.order("lead_score", desc=True).range(offset, offset + limit - 1)
    result = query.execute()

    return result.data or []


async def get_previously_found_leads(
    current_session_id: str, team_id: str,
    limit: int = 50, offset: int = 0
) -> List[Dict[str, Any]]:
    """
    Get un-contacted leads from PAST sessions that were never DM'd.
    These are leads the pipeline skipped (dedup) but the user should still see.
    Returns leads with previously_found=True flag.
    """
    client = get_client()
    if not client:
        return []

    # Get authors already contacted (via DMs)
    contacted_usernames = set()

    # Check contacted_recipients
    cr_result = client.table("contacted_recipients").select(
        "recipient_username"
    ).eq("team_id", team_id).execute()
    for row in (cr_result.data or []):
        contacted_usernames.add(row["recipient_username"])

    # Check dm_queue (pending/approved/sent)
    dq_result = client.table("dm_queue").select(
        "recipient_username"
    ).eq("team_id", team_id).in_(
        "status", ["pending", "approved", "sent"]
    ).execute()
    for row in (dq_result.data or []):
        contacted_usernames.add(row["recipient_username"].lower())

    # Get authors already in the current session (no need to show duplicates)
    current_result = client.table("discovered_leads").select(
        "author_username"
    ).eq("session_id", current_session_id).eq("team_id", team_id).execute()
    current_authors = set()
    for row in (current_result.data or []):
        current_authors.add(row["author_username"].lower())

    # Get scored leads from OTHER sessions that haven't been contacted
    query = client.table("discovered_leads").select("*").eq(
        "team_id", team_id
    ).neq(
        "session_id", current_session_id
    ).eq(
        "status", "scored"
    ).neq(
        "lead_tier", "irrelevant"
    ).order(
        "lead_score", desc=True
    ).range(offset, offset + limit - 1)

    result = query.execute()

    # Filter out contacted and current-session authors, deduplicate by author
    seen_authors = set()
    filtered = []
    for lead in (result.data or []):
        author = lead.get("author_username", "").lower()
        if author in contacted_usernames:
            continue
        if author in current_authors:
            continue
        if author in seen_authors:
            continue
        seen_authors.add(author)
        lead["previously_found"] = True
        filtered.append(lead)

    return filtered


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


async def get_past_lead_stats(team_id: str) -> Dict[str, Any]:
    """
    Get stats on how many leads from all past discovery sessions were messaged.
    Returns total discovered, total messaged, total queued, conversion rate.
    """
    client = get_client()
    if not client:
        return {"total_discovered": 0, "total_messaged": 0, "total_queued": 0, "conversion_rate": 0}

    try:
        # Get all leads for this team
        leads_result = client.table("discovered_leads").select(
            "id, author_username, status, queue_item_id, session_id"
        ).eq("team_id", team_id).execute()

        leads = leads_result.data or []
        total_discovered = len(leads)
        total_queued = len([l for l in leads if l.get("status") == "queued"])

        # Check which lead authors were actually messaged (in contacted_recipients)
        authors = list(set(
            l["author_username"].lower()
            for l in leads
            if l.get("author_username")
        ))

        messaged_count = 0
        if authors:
            # Check in batches of 100 to avoid query limits
            for batch_start in range(0, len(authors), 100):
                batch = authors[batch_start:batch_start + 100]
                cr_result = client.table("contacted_recipients").select(
                    "recipient_username"
                ).eq("team_id", team_id).in_(
                    "recipient_username", batch
                ).execute()
                messaged_count += len(cr_result.data or [])

        return {
            "total_discovered": total_discovered,
            "total_messaged": messaged_count,
            "total_queued": total_queued,
            "conversion_rate": round(messaged_count / total_discovered * 100, 1) if total_discovered > 0 else 0,
        }
    except Exception as e:
        logger.warning(f"Failed to get past lead stats for team {team_id}: {e}")
        return {"total_discovered": 0, "total_messaged": 0, "total_queued": 0, "conversion_rate": 0}


# ============================================================================
# Message Generation & Queueing
# ============================================================================

async def generate_message_for_lead(lead_id: str, team_id: str) -> Optional[Dict[str, Any]]:
    """Generate an outreach message for a discovered lead."""
    lead = await get_lead(lead_id, team_id)
    if not lead:
        raise ValueError(f"Lead {lead_id} not found")

    # Get team settings
    client = get_client()
    if not client:
        raise ValueError("Database client not available")

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
        "url": lead.get("post_url", ""),
        "title": lead.get("post_title", ""),
        "body": lead.get("post_body", ""),
        "subreddit": lead.get("subreddit", ""),
        "author": lead.get("author_username", ""),
    }

    # Include source comment for comment-sourced leads
    if lead.get("source_type") == "comment" and lead.get("source_comment_body"):
        post_data["source_comment_body"] = lead["source_comment_body"]

    # Retry up to 2 times on transient LLM failures
    last_error = None
    for attempt in range(1, 3):
        try:
            result = await llm_service.generate_question({
                "post": post_data,
                "settings": settings,
            })
            message = result.get("message", "").strip()
            if not message:
                raise ValueError("LLM returned empty message")
            reasoning = result.get("reasoning", "")
            await update_lead(lead_id, {
                "generated_message": message,
                "message_reasoning": reasoning,
            })
            return {"message": message, "reasoning": reasoning}
        except Exception as e:
            last_error = e
            logger.warning(f"Message generation attempt {attempt} failed for lead {lead_id}: {e}")
            if attempt < 2:
                await asyncio.sleep(3)

    logger.error(f"Failed to generate message for lead {lead_id} after 2 attempts: {last_error}")
    raise ValueError(f"Message generation failed: {last_error}")


async def queue_lead(
    lead_id: str, team_id: str, account_id: str,
    edited_message: str = None
) -> Optional[Dict[str, Any]]:
    """Queue a discovered lead for outreach."""
    from . import queue as queue_service

    lead = await get_lead(lead_id, team_id)
    if not lead:
        logger.warning(f"queue_lead: lead {lead_id} not found for team {team_id}")
        return None

    message = edited_message or lead.get("generated_message")
    if not message:
        logger.info(f"queue_lead: generating message for lead {lead_id} (u/{lead['author_username']})")
        gen_result = await generate_message_for_lead(lead_id, team_id)
        if not gen_result:
            logger.error(f"queue_lead: message generation failed for lead {lead_id}")
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

    if not queue_item:
        logger.warning(f"queue_lead: add_to_queue returned None for lead {lead_id}")
        return None

    # Don't update lead status if dedup blocked the queue add
    if queue_item.get("error"):
        logger.info(f"queue_lead: blocked for lead {lead_id}: {queue_item.get('message')}")
        return queue_item

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
Given a business description and target persona, generate exactly 8 diverse Reddit search
queries that would find posts from people who need this product/service.

RESPOND IN VALID JSON FORMAT ONLY (no markdown, no explanation):
{
    "queries": ["query 1", "query 2", "query 3", "query 4", "query 5", "query 6", "query 7", "query 8"]
}

GUIDELINES:
- Generate exactly 8 search queries optimized for Google (site:reddit.com is added automatically)
- Each query should be 3-8 words — specific enough to find relevant posts
- Query 1: core problem/need (e.g. "best electric scooter commute")
- Query 2: pain points or frustrations (e.g. "frustrated with X alternative needed")
- Query 3: buying intent or recommendations (e.g. "looking for alternative to X")
- Query 4: competitor comparison or adjacent problem (e.g. "X vs Y recommendation")
- Query 5: different angle — use case, industry term, or niche phrasing (e.g. "how to solve Y for small business")
- Query 6: specific feature or requirement (e.g. "need X with long battery life")
- Query 7: budget or value question (e.g. "worth upgrading to X from Y")
- Query 8: newbie or first-time buyer (e.g. "first time buying X what should I know")
- Make each query VERY distinct — cover different angles, synonyms, phrasings, and user intents
- Think about what real people would actually type when looking for help
- Do NOT include subreddit names in queries — the search covers all of Reddit
- Do NOT repeat similar queries — maximize coverage across different intents"""

MAX_STRATEGY_RETRIES = 3


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
    # Remove trailing commas AGAIN — closing brackets above may have
    # created new trailing commas (e.g. "value",  +  ]} → "value",]})
    text = re.sub(r',\s*([}\]])', r'\1', text)
    return text


async def generate_search_strategy(session_id: str, settings: Dict[str, Any], team_id: str = None) -> Dict[str, Any]:
    """Use LLM to generate search keywords, pain phrases, and subreddit suggestions."""
    user_prompt = f"""Business Description: {settings.get('businessDesc', 'Not specified')}
Target Persona: {settings.get('persona', 'Not specified')}
Tone: {settings.get('tone', 'Curious')}
Insight Types: {', '.join(settings.get('insightTypes', []))}"""

    # Load past queries for this team to avoid repetition
    if team_id:
        try:
            client = get_client()
            if client:
                pq_result = client.table("discovery_query_history").select(
                    "query_text, times_used"
                ).eq("team_id", team_id).order(
                    "last_used_at", desc=True
                ).limit(20).execute()
                past_queries = pq_result.data or []
                if past_queries:
                    user_prompt += "\n\nPREVIOUSLY USED QUERIES (generate DIFFERENT queries that explore NEW angles, synonyms, and intents):\n"
                    for pq in past_queries:
                        user_prompt += f"- \"{pq['query_text']}\" (used {pq['times_used']}x)\n"
        except Exception as e:
            logger.warning(f"Failed to load past queries for evolution: {e}")

    last_error = None
    for attempt in range(1, MAX_STRATEGY_RETRIES + 1):
        try:
            content = await gemini_client.generate_content(
                system_instruction=STRATEGY_SYSTEM_PROMPT,
                user_prompt=user_prompt,
                temperature=0.7,
                response_mime_type="application/json",
            )

            json_str = _strip_json_fences(content)
            logger.debug(f"Strategy raw response (attempt {attempt}): {json_str[:300]}")

            # Try parsing directly first, then with repair
            try:
                strategy = json.loads(json_str)
            except json.JSONDecodeError:
                logger.warning(f"Strategy JSON parse failed (attempt {attempt}), trying repair. Raw: {json_str[:200]}")
                repaired = _repair_json(json_str)
                strategy = json.loads(repaired)

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
                # Back off longer for rate limit errors (429)
                err_str = str(e)
                if "429" in err_str or "RESOURCE_EXHAUSTED" in err_str:
                    delay = 8 * attempt  # 8s, 16s, 24s
                    logger.info(f"Rate limited, waiting {delay}s before retry")
                    await asyncio.sleep(delay)
                else:
                    await asyncio.sleep(1)

    logger.error(f"Failed to generate search strategy after {MAX_STRATEGY_RETRIES} attempts: {last_error}")
    raise ValueError("Failed to generate search strategy")


# ============================================================================
# Comment Lead Identification
# ============================================================================

PREFILTER_PROMPT = """You are evaluating Google search results for Reddit posts.
Pick the {max_picks} most relevant posts for this business — posts whose authors
are most likely potential customers or leads.

BUSINESS: {business_desc}
TARGET PERSONA: {persona}

RESPOND IN VALID JSON ONLY (no markdown):
{{"picks": [0, 3, 7]}}

Where each number is the 0-based index of a result you're selecting.
Only return the indices of the top {max_picks} most relevant posts.
If fewer than {max_picks} look relevant, return fewer."""


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

Only include commenters scoring >= 50 on relevance. Max 20 leads.
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
    Pipeline:
      - 1 Gemini: search strategy (8 queries)
      - 8 SerpAPI: Google search for Reddit posts (30 results each)
      - 1 Gemini: pre-filter (rank by title/snippet, pick top 25)
      - ≤25 ScrapeCreators: enrich top 25 posts (post content + comments)
      - 1-3 Gemini: batch classification
      - 1-4 Gemini: batch comment lead analysis (5 posts per batch, 20 posts max)
    Total: 8 SerpAPI + ≤25 SC + 6-10 Gemini → ~50-75 leads
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

        # ---- Build SerpAPI tbs param from timeframe settings ----
        if session.get("timeframe_start") and session.get("timeframe_end"):
            tf_start = datetime.strptime(str(session["timeframe_start"]), "%Y-%m-%d").strftime("%m/%d/%Y")
            tf_end = datetime.strptime(str(session["timeframe_end"]), "%Y-%m-%d").strftime("%m/%d/%Y")
            serp_tbs = f"cdr:1,cd_min:{tf_start},cd_max:{tf_end}"
        else:
            serp_tbs = f"qdr:{session.get('timeframe', 'w')}"
        logger.info(f"Discovery session {session_id} using tbs={serp_tbs}")

        # ---- Pre-load: Fetch own account usernames to exclude from leads ----
        own_account_usernames = set()
        try:
            accounts_result = client.table("reddit_accounts").select(
                "username"
            ).eq("team_id", team_id).execute()
            for row in (accounts_result.data or []):
                username = (row.get("username") or "").lower().strip()
                if username:
                    own_account_usernames.add(username)
            if own_account_usernames:
                logger.info(f"Excluding own accounts from leads: {own_account_usernames}")
        except Exception as e:
            logger.warning(f"Failed to fetch own accounts: {e}")

        # ---- Phase 1: Generate search strategy (1 Gemini call) ----
        await update_session(session_id, {
            "status": "searching",
            "started_at": datetime.utcnow().isoformat(),
        })

        strategy = await generate_search_strategy(session_id, settings, team_id=team_id)
        search_queries = strategy.get("queries", [])[:8]

        if not search_queries:
            logger.error(f"No search queries generated for session {session_id}")
            await update_session(session_id, {"status": "failed"})
            return

        await update_session(session_id, {
            "total_queries_planned": len(search_queries),
        })

        # ---- Phase 2: SerpAPI Search (5 SerpAPI calls) ----
        await update_session(session_id, {"status": "scoring"})

        serpapi_results = []  # list of SerpAPI result dicts
        seen_urls = set()

        if is_automation and target_subs:
            # Automation mode: search within specific subreddits via SerpAPI
            for sr_name in target_subs[:3]:
                sr_name = sr_name.strip().replace("r/", "")
                if not sr_name:
                    continue
                for query in search_queries[:3]:
                    try:
                        results = await serpapi_client.search_subreddit_posts(
                            subreddit=sr_name, query=query,
                            num_results=15, tbs=serp_tbs,
                        )
                        for r in results:
                            url = r.get("link", "")
                            if url and url not in seen_urls:
                                seen_urls.add(url)
                                serpapi_results.append(r)
                    except Exception as e:
                        logger.warning(f"SerpAPI search failed for r/{sr_name} '{query}': {e}")
        else:
            # Discovery mode: global Google search for Reddit posts
            for query in search_queries:
                try:
                    results = await serpapi_client.search_reddit_posts(
                        query, num_results=30, tbs=serp_tbs,
                    )
                    for r in results:
                        url = r.get("link", "")
                        if url and url not in seen_urls:
                            seen_urls.add(url)
                            serpapi_results.append(r)
                except Exception as e:
                    logger.warning(f"SerpAPI search failed for '{query}': {e}")

        logger.info(f"SerpAPI found {len(serpapi_results)} unique post URLs from {len(search_queries)} queries")

        if not serpapi_results:
            await update_session(session_id, {
                "status": "completed",
                "completed_at": datetime.utcnow().isoformat(),
                "total_posts_found": 0,
                "leads_qualified": 0,
            })
            logger.info(f"Discovery session {session_id} completed: 0 posts found")
            return

        # ---- Phase 2.5a: Pre-filter SerpAPI results (1 Gemini call) ----
        # Rank by title/snippet relevance so we only spend SC calls on the best posts
        MAX_ENRICH = 25
        picks = list(range(min(len(serpapi_results), MAX_ENRICH)))  # fallback: first N

        if len(serpapi_results) > MAX_ENRICH:
            try:
                listing = "\n".join(
                    f"[{i}] {r.get('title', '')} — {r.get('snippet', '')[:150]}"
                    for i, r in enumerate(serpapi_results)
                )
                prefilter_response = await gemini_client.generate_content(
                    system_instruction=PREFILTER_PROMPT.format(
                        max_picks=MAX_ENRICH,
                        business_desc=settings.get("businessDesc", ""),
                        persona=settings.get("persona", ""),
                    ),
                    user_prompt=f"RESULTS:\n{listing}",
                    temperature=0.3,
                    response_mime_type="application/json",
                )
                json_str = _strip_json_fences(prefilter_response)
                logger.debug(f"Pre-filter raw response: {prefilter_response[:200]}")
                if not json_str.strip():
                    raise ValueError("Pre-filter returned empty response")
                try:
                    parsed_picks = json.loads(json_str)
                except json.JSONDecodeError:
                    logger.warning(f"Pre-filter JSON parse failed, trying repair. Raw: {json_str[:200]}")
                    parsed_picks = json.loads(_repair_json(json_str))

                raw_picks = parsed_picks.get("picks", [])
                # Validate indices
                valid_picks = [
                    int(p) for p in raw_picks
                    if isinstance(p, (int, float)) and 0 <= int(p) < len(serpapi_results)
                ][:MAX_ENRICH]
                if valid_picks:
                    picks = valid_picks
                    logger.info(f"Pre-filter selected indices {picks} from {len(serpapi_results)} results")
                else:
                    logger.warning("Pre-filter returned no valid picks, using first N")
            except Exception as e:
                logger.warning(f"Pre-filter failed, using first {MAX_ENRICH} results: {e}")

        # ---- Phase 2.5b: Pre-enrichment URL dedup ----
        # Skip posts already in discovered_leads for this team (across all sessions).
        # This prevents wasting ScrapeCreators calls on posts we've already processed.
        from . import dedup
        pick_urls = [serpapi_results[idx].get("link", "") for idx in picks if serpapi_results[idx].get("link")]
        known_urls = await dedup.batch_check_known_urls(pick_urls, team_id)
        duplicate_posts_skipped = 0
        if known_urls:
            original_count = len(picks)
            picks = [idx for idx in picks if serpapi_results[idx].get("link", "") not in known_urls]
            duplicate_posts_skipped = original_count - len(picks)
            logger.info(f"Pre-enrichment URL dedup: skipped {duplicate_posts_skipped} already-known posts")

        # ---- Phase 2.5c: Enrich top picks via ScrapeCreators ----
        all_posts = []  # Enriched post dicts
        post_comments = {}  # {url: [comment_list]} for Phase 5
        seen_authors = set(own_account_usernames)  # Pre-seed with own accounts to skip them

        for idx in picks:
            serpapi_result = serpapi_results[idx]
            post_url = serpapi_result.get("link", "")
            if not post_url:
                continue

            try:
                enriched = await reddit_search.get_post_with_comments(post_url)
                if enriched and enriched["post"].get("author"):
                    post = enriched["post"]
                    author = post["author"]

                    # Skip deleted authors and deduplicate
                    if author == "[deleted]" or author.lower() in seen_authors:
                        continue
                    seen_authors.add(author.lower())

                    all_posts.append(post)

                    # Stash comments for Phase 5 comment mining
                    if enriched.get("comments"):
                        post_comments[post["url"]] = enriched["comments"]
                else:
                    logger.info(f"Skipping post (no author from enrichment): {post_url}")
            except Exception as e:
                logger.warning(f"Post enrichment failed for {post_url}: {e}")

        logger.info(
            f"Enriched {len(all_posts)} posts with full content + comments "
            f"({len(post_comments)} posts have comments)"
        )
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
            logger.info(f"Discovery session {session_id} completed: 0 posts enriched")
            return

        # Extract subreddits from enriched posts (no API calls)
        subreddit_records = {}
        for post in all_posts:
            sr_name = post.get("subreddit", "")
            if sr_name and sr_name not in subreddit_records:
                try:
                    record = await store_subreddit(
                        session_id, team_id, sr_name,
                        {"subscribers": 0, "description": ""},
                        relevance_reason="Found in search results"
                    )
                    if record:
                        subreddit_records[sr_name] = record
                except Exception as e:
                    logger.warning(f"Failed to store subreddit {sr_name}: {e}")

        # ---- Phase 2.7: Per-subreddit expansion via ScrapeCreators ----
        POSTS_PER_SUBREDDIT = 10
        expansion_posts = []
        expansion_seen_urls = set(seen_urls)

        subreddits_to_expand = list(subreddit_records.keys())
        logger.info(f"Phase 2.7: Expanding {len(subreddits_to_expand)} subreddits via ScrapeCreators ({POSTS_PER_SUBREDDIT} posts each)")

        for sr_name in subreddits_to_expand:
            try:
                sr_posts_raw = await reddit_search.get_subreddit_posts(
                    subreddit=sr_name,
                    sort="hot",
                    timeframe="week",
                )

                sr_record = subreddit_records.get(sr_name, {})
                expansion_count_for_sr = 0

                for raw_post in sr_posts_raw:
                    if expansion_count_for_sr >= POSTS_PER_SUBREDDIT:
                        break

                    normalized = reddit_search.normalize_post(raw_post)
                    post_url = normalized.get("url", "")
                    author = normalized.get("author", "")

                    # Skip if no URL, no author, deleted, or already seen
                    if not post_url or not author or author == "[deleted]":
                        continue
                    if post_url in expansion_seen_urls or post_url in known_urls:
                        continue
                    if author.lower() in seen_authors:
                        continue

                    expansion_seen_urls.add(post_url)
                    seen_authors.add(author.lower())

                    # Tag with source type and subreddit record id
                    normalized["_source_type"] = "subreddit_expansion"
                    normalized["_subreddit_record_id"] = sr_record.get("id")

                    expansion_posts.append(normalized)
                    expansion_count_for_sr += 1

                # Update subreddit expansion stats
                if sr_record.get("id") and expansion_count_for_sr > 0:
                    client = get_client()
                    if client:
                        client.table("discovered_subreddits").update({
                            "expansion_posts_fetched": expansion_count_for_sr,
                        }).eq("id", sr_record["id"]).execute()

            except Exception as e:
                logger.warning(f"Subreddit expansion failed for r/{sr_name}: {e}")

        logger.info(f"Phase 2.7: Found {len(expansion_posts)} additional posts from subreddit expansion")

        # Merge expansion posts into the main pipeline
        all_posts.extend(expansion_posts)
        seen_urls.update(expansion_seen_urls)

        await update_session(session_id, {
            "total_posts_found": len(all_posts),
            "subreddit_posts_fetched": len(expansion_posts),
        })

        # ---- Phase 3: Dedup (DB queries only) ----
        from . import dedup
        all_authors = [post["author"] for post in all_posts]
        contacted_set = await dedup.batch_check_contacted(all_authors, team_id)
        # Also exclude own accounts from leads
        contacted_set.update(own_account_usernames)
        logger.info(f"Batch dedup: {len(contacted_set)} of {len(all_authors)} authors already contacted/discovered/own-accounts")

        posts_to_classify = [
            post for post in all_posts
            if post["author"].lower().strip() not in contacted_set
        ]

        logger.info(
            f"Classifying {len(posts_to_classify)} posts "
            f"(skipped {len(all_posts) - len(posts_to_classify)} already-contacted/discovered)"
        )

        if not posts_to_classify:
            await update_session(session_id, {
                "status": "completed",
                "completed_at": datetime.utcnow().isoformat(),
                "total_leads_scored": len(all_posts),
                "leads_qualified": 0,
            })
            logger.info(f"Discovery session {session_id} completed: all authors already contacted/discovered")
            return

        # ---- Phase 4: Batch classify + score (1-3 Gemini calls) ----
        logger.info(f"Starting batch classification of {len(posts_to_classify)} posts")
        classifications = await classification_service.batch_classify_posts(
            posts_to_classify, settings
        )

        # Log classification distribution
        cat_dist = {}
        for c in classifications:
            cat = (c or {}).get("category", "none/null")
            cat_dist[cat] = cat_dist.get(cat, 0) + 1
        logger.info(f"Classification results: {cat_dist} (total: {len(classifications)})")

        # If classification completely failed (ALL not_relevant), fall back to
        # storing all posts as weak leads so discovery isn't a total loss
        classification_failed = all(
            (c or {}).get("category") == "not_relevant" for c in classifications
        )
        if classification_failed and len(posts_to_classify) > 5:
            logger.error(
                f"Classification FAILED: ALL {len(classifications)} posts are not_relevant. "
                f"Falling back to unscored leads. Business: {settings.get('businessDesc', '')[:100]}"
            )

        # Score and store ALL leads (including irrelevant ones)
        leads_qualified = 0
        total_irrelevant = 0
        scored_posts = []  # For comment mining
        subreddit_stats = {}

        for i, post in enumerate(posts_to_classify):
            classification = classifications[i] if i < len(classifications) else {}

            # If classification completely failed, treat all posts as weak leads
            if classification_failed:
                classification = {
                    "relevanceScore": 50, "buyerIntent": 30,
                    "problemAwareness": 40, "productFit": 40,
                    "confidence": 30, "category": "weak_match",
                    "reasoning": "Classification unavailable - stored as unscored lead",
                }

            is_irrelevant = (not classification or classification.get("category") == "not_relevant")

            # Only count relevant leads toward MAX_LEADS cap
            if not is_irrelevant and leads_qualified >= MAX_LEADS:
                logger.info(f"Reached {MAX_LEADS} relevant leads, stopping")
                break

            sr_name = post.get("subreddit", "")
            if sr_name not in subreddit_stats:
                subreddit_stats[sr_name] = {"posts": 0, "leads": 0}
            subreddit_stats[sr_name]["posts"] += 1

            # Calculate lead score from classification (no API call)
            relevance = classification.get("relevanceScore", 0) if classification else 0
            buyer_intent = classification.get("buyerIntent", 0) if classification else 0
            product_fit = classification.get("productFit", 0) if classification else 0
            confidence = classification.get("confidence", 0) if classification else 0
            score = (relevance * 0.4) + (buyer_intent * 0.3) + (product_fit * 0.2) + (confidence * 0.1)
            score = round(score)

            if is_irrelevant:
                tier = "irrelevant"
            elif relevance >= 70 and buyer_intent >= 60:
                tier = "hot"
            elif relevance >= 50 or buyer_intent >= 40:
                tier = "warm"
            else:
                tier = "cold"

            sr_record = subreddit_records.get(sr_name, {})

            # Use source_type from expansion tag if present, otherwise "post"
            source_type = post.get("_source_type", "post")

            lead_data = {
                "discovered_subreddit_id": post.get("_subreddit_record_id") or sr_record.get("id"),
                "post_url": post["url"],
                "post_title": post["title"],
                "post_body": post.get("body", "")[:2000],
                "subreddit": sr_name,
                "post_created_utc": post.get("created_utc", 0),
                "author_username": post["author"],
                "source_type": source_type,
                "relevance_score": relevance,
                "buyer_intent": buyer_intent,
                "problem_awareness": classification.get("problemAwareness", 0) if classification else 0,
                "product_fit": product_fit,
                "confidence": confidence,
                "classification_category": classification.get("category", "not_relevant") if classification else "not_relevant",
                "classification_reasoning": classification.get("reasoning", "") if classification else "",
                "is_qualified": not is_irrelevant and score >= 50,
                "account_quality_score": None,
                "engagement_score": None,
                "lead_score": score,
                "lead_tier": tier,
                "lead_insights": [{"type": "classification", "message": classification.get("reasoning", "") if classification else ""}],
                "status": "scored",
            }

            try:
                await store_lead(session_id, team_id, lead_data)
                if is_irrelevant:
                    total_irrelevant += 1
                else:
                    leads_qualified += 1
                    subreddit_stats[sr_name]["leads"] += 1

                # Only add relevant posts to comment mining candidates
                if not is_irrelevant and score >= 50:
                    scored_posts.append((post, score, sr_record.get("id")))
            except Exception as e:
                logger.warning(f"Failed to store lead for u/{post['author']}: {e}")

        await update_session(session_id, {
            "total_leads_scored": len(posts_to_classify),
            "leads_qualified": leads_qualified,
            "total_posts_irrelevant": total_irrelevant,
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

        # ---- Phase 5: Comment mining (0 API calls + 1-2 Gemini calls) ----
        # Comments were already fetched in Phase 2.5 — reuse them
        MAX_COMMENT_MINING = 20
        COMMENT_BATCH_SIZE = 5  # Posts per Gemini call
        scored_posts.sort(key=lambda x: x[1], reverse=True)
        top_posts = scored_posts[:MAX_COMMENT_MINING]

        all_comment_data = []  # (comments_list, post, sr_record_id)
        for post, _, sr_record_id in top_posts:
            post_url = post.get("url", "")
            comments = post_comments.get(post_url, [])
            if comments:
                all_comment_data.append((comments, post, sr_record_id))

        logger.info(f"Comment mining: {len(all_comment_data)} posts have pre-fetched comments")

        # Process comments in batches to avoid token limits
        for batch_start in range(0, len(all_comment_data), COMMENT_BATCH_SIZE):
            batch = all_comment_data[batch_start:batch_start + COMMENT_BATCH_SIZE]
            if not batch:
                continue

            combined_comments_text = ""
            post_boundaries = []
            for comments, post, _ in batch:
                post_title = post.get("title", "")
                combined_comments_text += f"\n--- POST: {post_title} ---\n"
                for c in comments[:15]:
                    author = c.get("author", "unknown")
                    body = (c.get("body") or "")[:300]
                    if author and author != "[deleted]" and body:
                        combined_comments_text += f"u/{author}: {body}\n"
                post_boundaries.append(post_title)

            if not combined_comments_text.strip():
                continue

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
                    response_mime_type="application/json",
                )

                json_str = _strip_json_fences(content)
                try:
                    parsed = json.loads(json_str)
                except json.JSONDecodeError:
                    logger.warning(f"Comment analysis JSON parse failed, trying repair. Raw: {json_str[:300]}")
                    parsed = json.loads(_repair_json(json_str))

                comment_leads = parsed.get("leads", [])
                logger.info(
                    f"Comment batch {batch_start // COMMENT_BATCH_SIZE + 1}: "
                    f"{len(comment_leads)} leads from {len(batch)} posts"
                )
                default_sr_id = batch[0][2]

                for cl in comment_leads:
                    comment_author = cl.get("author", "")
                    if not comment_author or comment_author == "[deleted]":
                        continue
                    if comment_author.lower() in seen_authors:
                        continue
                    seen_authors.add(comment_author.lower())

                    already_contacted = comment_author.lower().strip() in contacted_set

                    # Find which post this comment belongs to
                    source_post = batch[0][1]
                    source_sr_id = default_sr_id
                    for clist, p, sr_id in batch:
                        for c in clist:
                            if c.get("author", "").lower() == comment_author.lower():
                                source_post = p
                                source_sr_id = sr_id
                                break

                    rel_score = cl.get("relevance_score", 50)
                    lead_data = {
                        "discovered_subreddit_id": source_sr_id,
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
                logger.warning(f"Comment analysis batch {batch_start // COMMENT_BATCH_SIZE + 1} failed: {e}")

        # ---- Phase 6: Complete ----
        total_checked = len(all_posts) + duplicate_posts_skipped
        yield_rate = round((leads_qualified / total_checked * 100), 2) if total_checked > 0 else 0

        await update_session(session_id, {
            "status": "completed",
            "completed_at": datetime.utcnow().isoformat(),
            "leads_qualified": leads_qualified,
            "duplicate_posts_skipped": duplicate_posts_skipped,
            "yield_rate": yield_rate,
        })

        # ---- Phase 6b: Store query history for evolution ----
        try:
            for q in search_queries:
                # Check if query already exists, then update or insert
                existing = client.table("discovery_query_history").select(
                    "id, times_used"
                ).eq("team_id", team_id).eq("query_text", q).limit(1).execute()
                if existing.data:
                    client.table("discovery_query_history").update({
                        "times_used": (existing.data[0].get("times_used", 0) or 0) + 1,
                        "last_used_at": datetime.utcnow().isoformat(),
                    }).eq("id", existing.data[0]["id"]).execute()
                else:
                    client.table("discovery_query_history").insert({
                        "team_id": team_id,
                        "query_text": q,
                        "times_used": 1,
                        "last_used_at": datetime.utcnow().isoformat(),
                    }).execute()
        except Exception as e:
            logger.warning(f"Failed to store query history: {e}")

        logger.info(
            f"Discovery session {session_id} completed: "
            f"{len(all_posts)} posts enriched, {leads_qualified} leads qualified, "
            f"{duplicate_posts_skipped} duplicates skipped, yield={yield_rate}%"
        )

    except Exception as e:
        logger.error(f"Discovery pipeline failed for session {session_id}: {e}", exc_info=True)
        try:
            await update_session(session_id, {"status": "failed"})
        except Exception:
            pass
