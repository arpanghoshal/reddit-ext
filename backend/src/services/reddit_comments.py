"""
Reddit Post Comments Fetcher
Fetches and formats comments via ScrapeCreators API for use in LLM prompts.
"""

import re
import logging
from typing import Dict, Any, List, Optional

from . import reddit_search
from .redis_client import cache_get, cache_set

logger = logging.getLogger(__name__)

MAX_TOP_LEVEL_COMMENTS = 10
MAX_COMMENT_BODY_LENGTH = 300
MAX_TOTAL_COMMENTS_CHARS = 2000

COMMENT_CACHE_TTL = 3600  # 60 minutes in seconds


async def fetch_post_comments(
    post_url: str,
    max_comments: int = MAX_TOP_LEVEL_COMMENTS
) -> List[Dict[str, Any]]:
    """
    Fetch top-level comments for a Reddit post via ScrapeCreators.

    Args:
        post_url: Full Reddit post URL
        max_comments: Max number of top-level comments to return

    Returns:
        List of comment dicts with {body, author, score}
    """
    if not post_url:
        return []

    # Check cache
    cache_key = f"comments:{post_url}"
    cached = await cache_get(cache_key)
    if cached is not None:
        return cached

    try:
        raw_comments = await reddit_search.get_post_comments(post_url)
        if not raw_comments:
            return []

        comments = []
        for c in raw_comments:
            normalized = reddit_search.normalize_comment(c)
            body = (normalized.get("body") or "").strip()
            author = normalized.get("author", "")
            if not body or body == "[deleted]" or body == "[removed]":
                continue
            if not author or author == "[deleted]":
                continue
            comments.append({
                "body": body,
                "author": author,
                "score": normalized.get("score", 0),
            })

        # Sort by score descending
        comments.sort(key=lambda x: x["score"], reverse=True)
        comments = comments[:max_comments]

        # Cache
        await cache_set(cache_key, comments, COMMENT_CACHE_TTL)

        return comments

    except Exception as e:
        logger.warning(f"Failed to fetch comments for {post_url}: {e}")
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
