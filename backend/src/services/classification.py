"""
Post Classification Service
Uses LLM to classify Reddit posts for relevance scoring
"""

import os
import json
import asyncio
import logging
from datetime import datetime, timedelta
from typing import Dict, Any, List, Optional
from supabase import create_client, Client
from . import reddit_comments
from . import gemini_client

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


async def get_cached_classification(post_url: str) -> Optional[Dict[str, Any]]:
    """Get cached classification for a post URL"""
    client = get_client()
    if not client:
        return None

    try:
        result = client.table("post_classifications").select("*").eq(
            "post_url", post_url
        ).gt(
            "expires_at", datetime.utcnow().isoformat()
        ).execute()

        if not result.data:
            return None

        data = result.data[0]

        # Skip poisoned cache entries (all scores zero = previous failure default)
        if (data.get("relevance_score", 0) == 0
                and data.get("confidence_score", 0) == 0
                and data.get("category") == "not_relevant"):
            logger.info(f"Skipping poisoned cache entry for {post_url}")
            return None

        return {
            "relevanceScore": data.get("relevance_score"),
            "buyerIntent": data.get("buyer_intent_score"),
            "problemAwareness": data.get("problem_awareness_score"),
            "productFit": data.get("product_fit_score"),
            "confidence": data.get("confidence_score"),
            "category": data.get("category"),
            "reasoning": data.get("reasoning"),
            "cached": True,
            "classifiedAt": data.get("classified_at")
        }
    except Exception as e:
        print(f"Error fetching cached classification: {e}")
        return None


async def save_classification(post: Dict[str, Any], classification: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    """Save classification to cache"""
    client = get_client()
    if not client:
        return None

    try:
        expires_at = datetime.utcnow() + timedelta(days=7)
        result = client.table("post_classifications").upsert({
            "post_url": post.get("url"),
            "post_title": post.get("title"),
            "post_body": post.get("body"),
            "subreddit": post.get("subreddit"),
            "author": post.get("author"),
            "relevance_score": classification.get("relevanceScore"),
            "buyer_intent_score": classification.get("buyerIntent"),
            "problem_awareness_score": classification.get("problemAwareness"),
            "product_fit_score": classification.get("productFit"),
            "confidence_score": classification.get("confidence"),
            "category": classification.get("category"),
            "reasoning": classification.get("reasoning"),
            "classified_at": datetime.utcnow().isoformat(),
            "expires_at": expires_at.isoformat()
        }, on_conflict="post_url").execute()

        return result.data[0] if result.data else None
    except Exception as e:
        print(f"Error saving classification: {e}")
        return None


def build_classification_prompt(post: Dict[str, Any], settings: Dict[str, Any], comments_text: str = "") -> str:
    """Build the classification prompt for LLM"""
    insight_types = settings.get("insightTypes", [])
    comments_section = f"\n{comments_text}\n" if comments_text else ""
    return f"""TASK: Classify this Reddit post for outreach relevance.

BUSINESS CONTEXT:
- Business Description: {settings.get('businessDesc', 'Not specified')}
- Target Persona: {settings.get('persona', 'Not specified')}
- Insight Goals: {', '.join(insight_types) if insight_types else 'General insights'}

POST DATA:
- Subreddit: r/{post.get('subreddit', 'unknown')}
- Title: {post.get('title', 'No title')}
- Body: {post.get('body', 'No body content')}
- Author: u/{post.get('author', 'unknown')}
{comments_section}

EVALUATE AND SCORE (0-100):
1. Relevance Score: How relevant is this post to the business/product?
2. Buyer Intent: Does the user show signs of being in a buying/decision mode?
3. Problem Awareness: How aware is the user of their problem?
4. Product Fit: How well does the problem/need fit the business's solution?
5. Confidence: How confident are you in this assessment?

CATEGORIZATION RULES:
- strong_match: Relevance >= 70 AND (Buyer Intent >= 50 OR Problem Awareness >= 60)
- weak_match: Relevance >= 40 AND Confidence >= 50
- not_relevant: All other cases

RESPOND IN VALID JSON FORMAT ONLY (no markdown, no explanation):
{{
    "relevanceScore": <number 0-100>,
    "buyerIntent": <number 0-100>,
    "problemAwareness": <number 0-100>,
    "productFit": <number 0-100>,
    "confidence": <number 0-100>,
    "category": "<strong_match|weak_match|not_relevant>",
    "reasoning": "<one sentence explanation>"
}}"""


def parse_classification_response(response_text: str) -> Dict[str, Any]:
    """Parse LLM response to extract classification"""
    try:
        json_str = response_text.strip()

        # Handle markdown code blocks
        if "```json" in json_str:
            json_str = json_str.split("```json")[1].split("```")[0].strip()
        elif "```" in json_str:
            json_str = json_str.split("```")[1].split("```")[0].strip()

        parsed = json.loads(json_str)

        # Validate and clamp values
        result = {
            "relevanceScore": max(0, min(100, int(parsed.get("relevanceScore", 0)))),
            "buyerIntent": max(0, min(100, int(parsed.get("buyerIntent", 0)))),
            "problemAwareness": max(0, min(100, int(parsed.get("problemAwareness", 0)))),
            "productFit": max(0, min(100, int(parsed.get("productFit", 0)))),
            "confidence": max(0, min(100, int(parsed.get("confidence", 0)))),
            "category": parsed.get("category", "not_relevant"),
            "reasoning": parsed.get("reasoning", "No reasoning provided")
        }

        # Validate category
        valid_categories = ["strong_match", "weak_match", "not_relevant"]
        if result["category"] not in valid_categories:
            # Auto-calculate category
            if result["relevanceScore"] >= 70 and (result["buyerIntent"] >= 50 or result["problemAwareness"] >= 60):
                result["category"] = "strong_match"
            elif result["relevanceScore"] >= 40 and result["confidence"] >= 50:
                result["category"] = "weak_match"
            else:
                result["category"] = "not_relevant"

        return result
    except Exception as e:
        logger.warning(f"Error parsing classification response: {e}, response: {response_text[:500]}")
        # Fail closed: unparseable responses should not become leads
        return {
            "relevanceScore": 0,
            "buyerIntent": 0,
            "problemAwareness": 0,
            "productFit": 0,
            "confidence": 0,
            "category": "not_relevant",
            "reasoning": "Failed to parse LLM response, defaulting to not_relevant"
        }


async def classify_post(post: Dict[str, Any], settings: Dict[str, Any] = None) -> Dict[str, Any]:
    """
    Classify a post using LLM

    Args:
        post: Post data {url, title, body, subreddit, author}
        settings: User settings {businessDesc, persona, insightTypes}

    Returns:
        Classification result
    """
    settings = settings or {}

    # Check cache first
    cached = await get_cached_classification(post.get("url", ""))
    if cached:
        print(f"Using cached classification for: {post.get('url')}")
        return cached

    # Classify using title+body only — comments are fetched later for top posts in comment mining
    prompt = build_classification_prompt(post, settings)

    system_instruction = "You are a lead qualification expert. Analyze Reddit posts and classify them for sales outreach relevance. Respond only with valid JSON."

    response_text = await gemini_client.generate_content(
        system_instruction=system_instruction,
        user_prompt=prompt,
        temperature=0.3,
        max_tokens=500,
    )

    if not response_text:
        raise ValueError("Empty response from LLM")

    classification = parse_classification_response(response_text)

    # Save to cache
    await save_classification(post, classification)

    return {**classification, "cached": False}


BATCH_POSTS_PER_CALL = 30  # Max posts per single Gemini call


def _build_batch_prompt(posts: List[Dict[str, Any]], settings: Dict[str, Any]) -> str:
    """Build a batch classification prompt for multiple posts."""
    insight_types = settings.get("insightTypes", [])
    posts_text = ""
    for i, post in enumerate(posts):
        body = (post.get("body") or "")[:500]
        posts_text += (
            f"{i+1}. [r/{post.get('subreddit', '?')}] "
            f"Title: {post.get('title', 'No title')} | "
            f"Body: {body} | "
            f"Author: u/{post.get('author', '?')}\n"
        )

    return f"""TASK: Classify each Reddit post for outreach relevance.

BUSINESS CONTEXT:
- Business Description: {settings.get('businessDesc', 'Not specified')}
- Target Persona: {settings.get('persona', 'Not specified')}
- Insight Goals: {', '.join(insight_types) if insight_types else 'General insights'}

POSTS:
{posts_text}

EVALUATE EACH POST (0-100):
- relevanceScore: How relevant to the business/product?
- buyerIntent: Signs of buying/decision mode?
- problemAwareness: How aware of their problem?
- productFit: How well does the need fit the business solution?
- confidence: How confident in this assessment?

CATEGORIZATION RULES:
- strong_match: relevanceScore >= 70 AND (buyerIntent >= 50 OR problemAwareness >= 60)
- weak_match: relevanceScore >= 40 AND confidence >= 50
- not_relevant: All other cases

RESPOND WITH A JSON ARRAY ONLY (no markdown, no explanation):
[
  {{"index": 1, "relevanceScore": N, "buyerIntent": N, "problemAwareness": N, "productFit": N, "confidence": N, "category": "...", "reasoning": "..."}},
  ...
]"""


def _parse_batch_response(response_text: str, count: int) -> List[Dict[str, Any]]:
    """Parse batch classification response into list of results."""
    try:
        json_str = response_text.strip()
        if "```json" in json_str:
            json_str = json_str.split("```json")[1].split("```")[0].strip()
        elif "```" in json_str:
            json_str = json_str.split("```")[1].split("```")[0].strip()

        parsed = json.loads(json_str)
        if not isinstance(parsed, list):
            parsed = parsed.get("posts", parsed.get("results", []))

        results = []
        valid_categories = ["strong_match", "weak_match", "not_relevant"]

        for item in parsed:
            r = {
                "relevanceScore": max(0, min(100, int(item.get("relevanceScore", 0)))),
                "buyerIntent": max(0, min(100, int(item.get("buyerIntent", 0)))),
                "problemAwareness": max(0, min(100, int(item.get("problemAwareness", 0)))),
                "productFit": max(0, min(100, int(item.get("productFit", 0)))),
                "confidence": max(0, min(100, int(item.get("confidence", 0)))),
                "category": item.get("category", "not_relevant"),
                "reasoning": item.get("reasoning", ""),
            }
            if r["category"] not in valid_categories:
                if r["relevanceScore"] >= 70 and (r["buyerIntent"] >= 50 or r["problemAwareness"] >= 60):
                    r["category"] = "strong_match"
                elif r["relevanceScore"] >= 40 and r["confidence"] >= 50:
                    r["category"] = "weak_match"
                else:
                    r["category"] = "not_relevant"
            results.append(r)

        return results

    except Exception as e:
        logger.warning(f"Batch classification parse failed: {e}, response: {response_text[:500]}")
        return [_not_relevant_default() for _ in range(count)]


def _not_relevant_default() -> Dict[str, Any]:
    return {
        "relevanceScore": 0, "buyerIntent": 0, "problemAwareness": 0,
        "productFit": 0, "confidence": 0,
        "category": "not_relevant",
        "reasoning": "Parse failure, defaulting to not_relevant",
    }


async def batch_classify_posts(
    posts: List[Dict[str, Any]], settings: Dict[str, Any]
) -> List[Dict[str, Any]]:
    """
    Classify all posts in 1-3 Gemini calls (batch mode).

    Checks cache first for each post. Uncached posts are sent in batches
    of BATCH_POSTS_PER_CALL to a single Gemini call.

    Returns list of classification dicts aligned with input posts order.
    """
    settings = settings or {}
    results: List[Optional[Dict[str, Any]]] = [None] * len(posts)

    # Check cache for each post
    uncached_indices = []
    for i, post in enumerate(posts):
        cached = await get_cached_classification(post.get("url", ""))
        if cached:
            results[i] = cached
        else:
            uncached_indices.append(i)

    if not uncached_indices:
        return results

    # Batch classify uncached posts
    uncached_posts = [posts[i] for i in uncached_indices]

    for batch_start in range(0, len(uncached_posts), BATCH_POSTS_PER_CALL):
        batch = uncached_posts[batch_start:batch_start + BATCH_POSTS_PER_CALL]
        batch_indices = uncached_indices[batch_start:batch_start + BATCH_POSTS_PER_CALL]

        prompt = _build_batch_prompt(batch, settings)

        batch_failed = False
        try:
            response_text = await gemini_client.generate_content(
                system_instruction="You are a lead qualification expert. Classify Reddit posts for sales outreach relevance. Respond only with a valid JSON array.",
                user_prompt=prompt,
                temperature=0.3,
                max_tokens=8000,
                response_mime_type="application/json",
            )

            if not response_text:
                logger.error(f"Batch classification returned empty response for {len(batch)} posts")
                batch_results = [_not_relevant_default() for _ in batch]
                batch_failed = True
            else:
                logger.info(f"Batch classification response ({len(batch)} posts): {response_text[:200]}...")
                batch_results = _parse_batch_response(response_text, len(batch))

            # Pad if LLM returned fewer results than expected
            while len(batch_results) < len(batch):
                batch_results.append(_not_relevant_default())

            # Log category distribution for this batch
            cats = {}
            for br in batch_results:
                c = br.get("category", "unknown")
                cats[c] = cats.get(c, 0) + 1
            logger.info(f"Batch classification categories: {cats}")

            # Store results and save to cache (skip caching failures)
            for j, idx in enumerate(batch_indices):
                classification = batch_results[j] if j < len(batch_results) else _not_relevant_default()
                results[idx] = {**classification, "cached": False}
                # Only cache real classifications, not failure defaults
                if not batch_failed and classification.get("relevanceScore", 0) > 0:
                    await save_classification(posts[idx], classification)

        except Exception as e:
            logger.error(f"Batch classification call failed: {e}", exc_info=True)
            for idx in batch_indices:
                results[idx] = {**_not_relevant_default(), "cached": False}

    return results


async def classify_batch(posts: List[Dict[str, Any]], settings: Dict[str, Any] = None) -> List[Dict[str, Any]]:
    """
    Classify multiple posts in batch (legacy wrapper, calls batch_classify_posts).
    """
    settings = settings or {}
    classifications = await batch_classify_posts(posts, settings)
    results = []
    for i, post in enumerate(posts):
        c = classifications[i] if i < len(classifications) else _not_relevant_default()
        results.append({"postUrl": post.get("url"), **c})
    return results


async def get_classification_stats() -> Dict[str, int]:
    """Get classification statistics"""
    client = get_client()
    if not client:
        return {"total": 0, "strongMatch": 0, "weakMatch": 0, "notRelevant": 0}

    try:
        thirty_days_ago = (datetime.utcnow() - timedelta(days=30)).isoformat()
        result = client.table("post_classifications").select("category").gte(
            "classified_at", thirty_days_ago
        ).execute()

        if not result.data:
            return {"total": 0, "strongMatch": 0, "weakMatch": 0, "notRelevant": 0}

        data = result.data
        return {
            "total": len(data),
            "strongMatch": len([d for d in data if d.get("category") == "strong_match"]),
            "weakMatch": len([d for d in data if d.get("category") == "weak_match"]),
            "notRelevant": len([d for d in data if d.get("category") == "not_relevant"])
        }
    except Exception as e:
        print(f"Error fetching classification stats: {e}")
        return {"total": 0, "strongMatch": 0, "weakMatch": 0, "notRelevant": 0}
