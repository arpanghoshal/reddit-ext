"""
Post Classification Service
Uses LLM to classify Reddit posts for relevance scoring
"""

import os
import json
import asyncio
from datetime import datetime, timedelta
from typing import Dict, Any, List, Optional
import httpx
from supabase import create_client, Client

OPENROUTER_API_URL = "https://openrouter.ai/api/v1/chat/completions"
DEFAULT_MODEL = "deepseek/deepseek-r1t-chimera:free"

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


def build_classification_prompt(post: Dict[str, Any], settings: Dict[str, Any]) -> str:
    """Build the classification prompt for LLM"""
    insight_types = settings.get("insightTypes", [])
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
        print(f"Error parsing classification response: {e}, response: {response_text}")
        # Return a default "fail open" classification
        return {
            "relevanceScore": 50,
            "buyerIntent": 50,
            "problemAwareness": 50,
            "productFit": 50,
            "confidence": 30,
            "category": "weak_match",
            "reasoning": "Failed to parse LLM response, defaulting to weak match"
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

    api_key = os.getenv("OPENROUTER_API_KEY")
    if not api_key:
        raise ValueError("OpenRouter API key not configured")

    prompt = build_classification_prompt(post, settings)

    async with httpx.AsyncClient() as client:
        response = await client.post(
            OPENROUTER_API_URL,
            headers={
                "Authorization": f"Bearer {api_key}",
                "Content-Type": "application/json",
                "HTTP-Referer": "https://reddit-insight-gatherer.local",
                "X-Title": "Reddit Insight Gatherer"
            },
            json={
                "model": settings.get("model", DEFAULT_MODEL),
                "messages": [
                    {
                        "role": "system",
                        "content": "You are a lead qualification expert. Analyze Reddit posts and classify them for sales outreach relevance. Respond only with valid JSON."
                    },
                    {"role": "user", "content": prompt}
                ],
                "temperature": 0.3,
                "max_tokens": 500
            },
            timeout=60.0
        )

        if response.status_code != 200:
            error_text = response.text
            raise ValueError(f"OpenRouter API error: {response.status_code} - {error_text}")

        data = response.json()
        response_text = data.get("choices", [{}])[0].get("message", {}).get("content", "")

        if not response_text:
            raise ValueError("Empty response from LLM")

        classification = parse_classification_response(response_text)

        # Save to cache
        await save_classification(post, classification)

        return {**classification, "cached": False}


async def classify_batch(posts: List[Dict[str, Any]], settings: Dict[str, Any] = None) -> List[Dict[str, Any]]:
    """
    Classify multiple posts in batch

    Args:
        posts: Array of post objects
        settings: User settings

    Returns:
        Array of classification results
    """
    settings = settings or {}
    results = []

    for post in posts:
        try:
            classification = await classify_post(post, settings)
            results.append({
                "postUrl": post.get("url"),
                **classification
            })

            # Add a small delay between API calls to avoid rate limiting
            await asyncio.sleep(0.5)
        except Exception as e:
            print(f"Error classifying post {post.get('url')}: {e}")
            results.append({
                "postUrl": post.get("url"),
                "error": str(e),
                "category": "not_relevant"
            })

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
