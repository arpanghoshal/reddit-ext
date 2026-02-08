"""
Reddit Post Comments Fetcher
Fetches and formats comments from Reddit's public JSON API for use in LLM prompts.
"""

import re
import logging
from typing import Dict, Any, List, Optional
from datetime import datetime, timedelta
import httpx

logger = logging.getLogger(__name__)

MAX_TOP_LEVEL_COMMENTS = 10
MAX_COMMENT_BODY_LENGTH = 300
MAX_TOTAL_COMMENTS_CHARS = 2000
USER_AGENT = "Reddit-Automated-DM/1.0"
REQUEST_TIMEOUT = 15.0

# In-memory cache: {post_id: {"data": [...], "fetched_at": datetime}}
_comment_cache: Dict[str, Dict[str, Any]] = {}
CACHE_TTL_MINUTES = 60


def extract_post_id(url: str) -> Optional[str]:
    """Extract the Reddit post ID from a post URL."""
    if not url:
        return None
    match = re.search(r'/comments/([a-zA-Z0-9]+)', url)
    return match.group(1) if match else None


def _evict_expired_cache():
    """Remove expired entries from the in-memory cache."""
    now = datetime.utcnow()
    expired = [
        k for k, v in _comment_cache.items()
        if now - v["fetched_at"] > timedelta(minutes=CACHE_TTL_MINUTES)
    ]
    for k in expired:
        del _comment_cache[k]


async def fetch_post_comments(
    post_url: str,
    max_comments: int = MAX_TOP_LEVEL_COMMENTS
) -> List[Dict[str, Any]]:
    """
    Fetch top-level comments for a Reddit post.

    Args:
        post_url: Full Reddit post URL
        max_comments: Max number of top-level comments to return

    Returns:
        List of comment dicts with {body, author, score}
    """
    post_id = extract_post_id(post_url)
    if not post_id:
        return []

    # Check cache
    _evict_expired_cache()
    if post_id in _comment_cache:
        return _comment_cache[post_id]["data"]

    try:
        api_url = f"https://www.reddit.com/comments/{post_id}.json?sort=top&limit={max_comments}"

        async with httpx.AsyncClient() as client:
            response = await client.get(
                api_url,
                headers={"User-Agent": USER_AGENT},
                timeout=REQUEST_TIMEOUT,
                follow_redirects=True
            )

            if response.status_code != 200:
                logger.warning(f"Reddit API returned {response.status_code} for post {post_id}")
                return []

            data = response.json()

            # Reddit returns [post_listing, comments_listing]
            if not isinstance(data, list) or len(data) < 2:
                return []

            comments_listing = data[1].get("data", {}).get("children", [])

            comments = []
            for child in comments_listing:
                if child.get("kind") != "t1":
                    continue
                c = child.get("data", {})
                body = (c.get("body") or "").strip()
                if not body or body == "[deleted]" or body == "[removed]":
                    continue
                comments.append({
                    "body": body,
                    "author": c.get("author", "[deleted]"),
                    "score": c.get("score", 0)
                })

            # Sort by score descending
            comments.sort(key=lambda x: x["score"], reverse=True)
            comments = comments[:max_comments]

            # Cache
            _comment_cache[post_id] = {
                "data": comments,
                "fetched_at": datetime.utcnow()
            }

            return comments

    except Exception as e:
        logger.warning(f"Failed to fetch comments for post {post_id}: {e}")
        return []


def format_comments_for_prompt(
    comments: List[Dict[str, Any]],
    max_chars: int = MAX_TOTAL_COMMENTS_CHARS
) -> str:
    """
    Format comments into a string for LLM prompt injection.

    Returns a string like:
        TOP COMMENTS:
        [+125] u/user1: Comment text...
        [+89] u/user2: Another comment...
    """
    if not comments:
        return ""

    lines = ["TOP COMMENTS:"]
    total_len = len(lines[0])

    for c in comments:
        body = c["body"]
        if len(body) > MAX_COMMENT_BODY_LENGTH:
            body = body[:MAX_COMMENT_BODY_LENGTH] + "..."
        line = f"[+{c['score']}] u/{c['author']}: {body}"

        if total_len + len(line) + 1 > max_chars:
            lines.append("... (more comments omitted)")
            break
        lines.append(line)
        total_len += len(line) + 1

    return "\n".join(lines)


async def get_post_comments_text(post_url: str) -> str:
    """
    Convenience wrapper: fetch comments and return formatted text for LLM prompts.
    Returns empty string on any failure.
    """
    if not post_url:
        return ""
    comments = await fetch_post_comments(post_url)
    if not comments:
        return ""
    return format_comments_for_prompt(comments)
