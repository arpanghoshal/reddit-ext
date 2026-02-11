"""
Reddit Search Service
Wraps ScrapeCreators API (search/discovery) + Reddit public JSON (supplementary data).
"""

import os
import asyncio
import logging
import time
from typing import Dict, Any, List, Optional
from datetime import datetime, timedelta
import httpx

logger = logging.getLogger(__name__)

SCRAPECREATORS_BASE_URL = "https://api.scrapecreators.com/v1/reddit"
REDDIT_BASE_URL = "https://www.reddit.com"
USER_AGENT = "Reddit-Automated-DM/1.0"
REQUEST_TIMEOUT = 20.0

# In-memory caches with TTL
_post_search_cache: Dict[str, Dict[str, Any]] = {}
_subreddit_search_cache: Dict[str, Dict[str, Any]] = {}
_subreddit_info_cache: Dict[str, Dict[str, Any]] = {}

POST_SEARCH_CACHE_TTL = 15  # minutes
SUBREDDIT_SEARCH_CACHE_TTL = 30  # minutes
SUBREDDIT_INFO_CACHE_TTL = 60  # minutes

# Rate limiter for Reddit public JSON (45 req/min)
_reddit_tokens = 45.0
_reddit_last_refill = time.monotonic()
_reddit_lock = asyncio.Lock()

# Delay between ScrapeCreators calls
SCRAPECREATORS_DELAY = 0.5  # seconds


def _get_scrapecreators_key() -> Optional[str]:
    return os.getenv("SCRAPECREATORS_API_KEY")


def _evict_cache(cache: Dict[str, Dict[str, Any]], ttl_minutes: int):
    """Remove expired entries from a cache."""
    now = datetime.utcnow()
    expired = [
        k for k, v in cache.items()
        if now - v["fetched_at"] > timedelta(minutes=ttl_minutes)
    ]
    for k in expired:
        del cache[k]


async def _reddit_rate_limit():
    """Token bucket rate limiter for Reddit public JSON."""
    global _reddit_tokens, _reddit_last_refill
    async with _reddit_lock:
        now = time.monotonic()
        elapsed = now - _reddit_last_refill
        _reddit_tokens = min(45.0, _reddit_tokens + elapsed * (45.0 / 60.0))
        _reddit_last_refill = now
        if _reddit_tokens < 1:
            wait_time = (1 - _reddit_tokens) * (60.0 / 45.0)
            await asyncio.sleep(wait_time)
            _reddit_tokens = 0
        else:
            _reddit_tokens -= 1


# ============================================================================
# ScrapeCreators API endpoints
# ============================================================================

async def search_posts(query: str, sort: str = "relevance", trim: bool = True) -> List[Dict[str, Any]]:
    """
    Search Reddit posts by keyword via ScrapeCreators API.
    GET /v1/reddit/search
    """
    api_key = _get_scrapecreators_key()
    if not api_key:
        logger.error("SCRAPECREATORS_API_KEY not set")
        return []

    cache_key = f"search:{query}:{sort}"
    _evict_cache(_post_search_cache, POST_SEARCH_CACHE_TTL)
    if cache_key in _post_search_cache:
        return _post_search_cache[cache_key]["data"]

    try:
        await asyncio.sleep(SCRAPECREATORS_DELAY)
        async with httpx.AsyncClient() as client:
            response = await client.get(
                f"{SCRAPECREATORS_BASE_URL}/search",
                headers={
                    "x-api-key": api_key,
                    "Content-Type": "application/json",
                },
                params={
                    "query": query,
                    "sort": sort,
                    "trim": str(trim).lower(),
                },
                timeout=REQUEST_TIMEOUT,
            )

            if response.status_code != 200:
                logger.warning(f"ScrapeCreators search returned {response.status_code} for query '{query}'")
                return []

            data = response.json()
            posts = data.get("posts", data.get("data", []))
            if not isinstance(posts, list):
                posts = []

            _post_search_cache[cache_key] = {
                "data": posts,
                "fetched_at": datetime.utcnow(),
            }
            return posts

    except Exception as e:
        logger.warning(f"ScrapeCreators search failed for '{query}': {e}")
        return []


async def search_subreddit_posts(
    subreddit: str,
    query: str = "",
    sort: str = "relevance",
    timeframe: str = "week",
    filter_type: str = "posts",
) -> List[Dict[str, Any]]:
    """
    Search within a specific subreddit via ScrapeCreators API.
    GET /v1/reddit/subreddit/search
    """
    api_key = _get_scrapecreators_key()
    if not api_key:
        logger.error("SCRAPECREATORS_API_KEY not set")
        return []

    cache_key = f"sub_search:{subreddit}:{query}:{sort}:{timeframe}:{filter_type}"
    _evict_cache(_post_search_cache, POST_SEARCH_CACHE_TTL)
    if cache_key in _post_search_cache:
        return _post_search_cache[cache_key]["data"]

    try:
        await asyncio.sleep(SCRAPECREATORS_DELAY)
        params = {
            "subreddit": subreddit,
            "sort": sort,
            "timeframe": timeframe,
            "filter": filter_type,
        }
        if query:
            params["query"] = query

        async with httpx.AsyncClient() as client:
            response = await client.get(
                f"{SCRAPECREATORS_BASE_URL}/subreddit/search",
                headers={
                    "x-api-key": api_key,
                    "Content-Type": "application/json",
                },
                params=params,
                timeout=REQUEST_TIMEOUT,
            )

            if response.status_code != 200:
                logger.warning(
                    f"ScrapeCreators subreddit search returned {response.status_code} "
                    f"for r/{subreddit} query '{query}'"
                )
                return []

            data = response.json()
            posts = data.get("posts", data.get("data", []))
            if not isinstance(posts, list):
                posts = []

            _post_search_cache[cache_key] = {
                "data": posts,
                "fetched_at": datetime.utcnow(),
            }
            return posts

    except Exception as e:
        logger.warning(f"ScrapeCreators subreddit search failed for r/{subreddit}: {e}")
        return []


async def get_subreddit_posts(
    subreddit: str,
    sort: str = "hot",
    timeframe: str = "week",
    trim: bool = True,
) -> List[Dict[str, Any]]:
    """
    Get posts from a subreddit via ScrapeCreators API.
    GET /v1/reddit/subreddit
    """
    api_key = _get_scrapecreators_key()
    if not api_key:
        logger.error("SCRAPECREATORS_API_KEY not set")
        return []

    cache_key = f"subreddit_posts:{subreddit}:{sort}:{timeframe}"
    _evict_cache(_post_search_cache, POST_SEARCH_CACHE_TTL)
    if cache_key in _post_search_cache:
        return _post_search_cache[cache_key]["data"]

    try:
        await asyncio.sleep(SCRAPECREATORS_DELAY)
        async with httpx.AsyncClient() as client:
            response = await client.get(
                f"{SCRAPECREATORS_BASE_URL}/subreddit",
                headers={
                    "x-api-key": api_key,
                    "Content-Type": "application/json",
                },
                params={
                    "subreddit": subreddit,
                    "sort": sort,
                    "timeframe": timeframe,
                    "trim": str(trim).lower(),
                },
                timeout=REQUEST_TIMEOUT,
            )

            if response.status_code != 200:
                logger.warning(
                    f"ScrapeCreators subreddit posts returned {response.status_code} for r/{subreddit}"
                )
                return []

            data = response.json()
            posts = data.get("posts", data.get("data", []))
            if not isinstance(posts, list):
                posts = []

            _post_search_cache[cache_key] = {
                "data": posts,
                "fetched_at": datetime.utcnow(),
            }
            return posts

    except Exception as e:
        logger.warning(f"ScrapeCreators subreddit posts failed for r/{subreddit}: {e}")
        return []


async def get_post_comments(post_url: str, trim: bool = True) -> List[Dict[str, Any]]:
    """
    Get comments for a Reddit post via ScrapeCreators API.
    GET /v1/reddit/post/comments
    """
    api_key = _get_scrapecreators_key()
    if not api_key:
        logger.error("SCRAPECREATORS_API_KEY not set")
        return []

    try:
        await asyncio.sleep(SCRAPECREATORS_DELAY)
        async with httpx.AsyncClient() as client:
            response = await client.get(
                f"{SCRAPECREATORS_BASE_URL}/post/comments",
                headers={
                    "x-api-key": api_key,
                    "Content-Type": "application/json",
                },
                params={
                    "url": post_url,
                    "trim": str(trim).lower(),
                },
                timeout=REQUEST_TIMEOUT,
            )

            if response.status_code != 200:
                logger.warning(
                    f"ScrapeCreators comments returned {response.status_code} for {post_url}"
                )
                return []

            data = response.json()
            comments = data.get("comments", data.get("data", []))
            if not isinstance(comments, list):
                comments = []

            return comments

    except Exception as e:
        logger.warning(f"ScrapeCreators comments failed for {post_url}: {e}")
        return []


# ============================================================================
# Reddit public JSON endpoints (no auth)
# ============================================================================

async def search_subreddits(query: str, limit: int = 10) -> List[Dict[str, Any]]:
    """
    Search for subreddits by keyword via Reddit public JSON.
    GET /search.json?q={query}&type=sr
    """
    cache_key = f"sr_search:{query}:{limit}"
    _evict_cache(_subreddit_search_cache, SUBREDDIT_SEARCH_CACHE_TTL)
    if cache_key in _subreddit_search_cache:
        return _subreddit_search_cache[cache_key]["data"]

    try:
        await _reddit_rate_limit()
        async with httpx.AsyncClient() as client:
            response = await client.get(
                f"{REDDIT_BASE_URL}/search.json",
                headers={"User-Agent": USER_AGENT},
                params={"q": query, "type": "sr", "limit": limit},
                timeout=REQUEST_TIMEOUT,
                follow_redirects=True,
            )

            if response.status_code != 200:
                logger.warning(f"Reddit subreddit search returned {response.status_code} for '{query}'")
                return []

            data = response.json()
            children = data.get("data", {}).get("children", [])

            subreddits = []
            for child in children:
                sr = child.get("data", {})
                subreddits.append({
                    "name": sr.get("display_name", ""),
                    "subscribers": sr.get("subscribers", 0),
                    "description": sr.get("public_description", ""),
                    "url": sr.get("url", ""),
                    "over18": sr.get("over18", False),
                    "created_utc": sr.get("created_utc", 0),
                })

            _subreddit_search_cache[cache_key] = {
                "data": subreddits,
                "fetched_at": datetime.utcnow(),
            }
            return subreddits

    except Exception as e:
        logger.warning(f"Reddit subreddit search failed for '{query}': {e}")
        return []


async def get_subreddit_info(subreddit: str) -> Optional[Dict[str, Any]]:
    """
    Get subreddit metadata via Reddit public JSON.
    GET /r/{subreddit}/about.json
    """
    cache_key = subreddit.lower()
    _evict_cache(_subreddit_info_cache, SUBREDDIT_INFO_CACHE_TTL)
    if cache_key in _subreddit_info_cache:
        return _subreddit_info_cache[cache_key]["data"]

    try:
        await _reddit_rate_limit()
        async with httpx.AsyncClient() as client:
            response = await client.get(
                f"{REDDIT_BASE_URL}/r/{subreddit}/about.json",
                headers={"User-Agent": USER_AGENT},
                timeout=REQUEST_TIMEOUT,
                follow_redirects=True,
            )

            if response.status_code != 200:
                logger.warning(f"Reddit subreddit info returned {response.status_code} for r/{subreddit}")
                return None

            data = response.json().get("data", {})
            info = {
                "name": data.get("display_name", subreddit),
                "subscribers": data.get("subscribers", 0),
                "description": data.get("public_description", ""),
                "title": data.get("title", ""),
                "over18": data.get("over18", False),
                "created_utc": data.get("created_utc", 0),
            }

            _subreddit_info_cache[cache_key] = {
                "data": info,
                "fetched_at": datetime.utcnow(),
            }
            return info

    except Exception as e:
        logger.warning(f"Reddit subreddit info failed for r/{subreddit}: {e}")
        return None


# ============================================================================
# Helpers
# ============================================================================

def _str_field(value) -> str:
    """Safely coerce a field to string. ScrapeCreators sometimes returns dicts/lists."""
    if value is None:
        return ""
    if isinstance(value, str):
        return value
    if isinstance(value, dict):
        # Try common nested patterns: {"text": "..."}, {"url": "..."}, {"link": "..."}
        for key in ("text", "url", "link", "href", "value"):
            if key in value and isinstance(value[key], str):
                return value[key]
        return ""
    if isinstance(value, (int, float)):
        return str(value)
    return ""


def normalize_post(post: Dict[str, Any]) -> Dict[str, Any]:
    """
    Normalize post data from ScrapeCreators responses to a consistent format.
    Handles variations in field names across different endpoints.
    """
    # Try various field name patterns
    url = (
        _str_field(post.get("url"))
        or _str_field(post.get("permalink"))
        or _str_field(post.get("post_url"))
        or ""
    )
    # Ensure it's a full URL
    if url and not url.startswith("http"):
        url = f"https://www.reddit.com{url}"

    author = (
        _str_field(post.get("author"))
        or _str_field(post.get("author_name"))
        or _str_field(post.get("user"))
        or ""
    )

    title = _str_field(post.get("title")) or _str_field(post.get("post_title")) or ""

    body = (
        _str_field(post.get("selftext"))
        or _str_field(post.get("body"))
        or _str_field(post.get("text"))
        or _str_field(post.get("post_body"))
        or ""
    )

    subreddit = (
        _str_field(post.get("subreddit"))
        or _str_field(post.get("subreddit_name"))
        or ""
    )
    # Strip r/ prefix if present
    if subreddit.startswith("r/"):
        subreddit = subreddit[2:]

    created_utc = (
        post.get("created_utc")
        or post.get("created_at")
        or post.get("timestamp")
        or 0
    )
    # If it's a string timestamp, try to parse
    if isinstance(created_utc, str):
        try:
            dt = datetime.fromisoformat(created_utc.replace("Z", "+00:00"))
            created_utc = int(dt.timestamp())
        except (ValueError, TypeError):
            created_utc = 0

    score = post.get("score") or post.get("ups") or post.get("votes") or post.get("upvotes") or 0
    num_comments = post.get("num_comments") or post.get("comments_count") or post.get("comment_count") or 0

    return {
        "url": url,
        "title": title,
        "body": body,
        "author": author,
        "subreddit": subreddit,
        "created_utc": created_utc,
        "score": score,
        "num_comments": num_comments,
    }


def normalize_comment(comment: Dict[str, Any]) -> Dict[str, Any]:
    """Normalize comment data from ScrapeCreators to a consistent format."""
    author = (
        _str_field(comment.get("author"))
        or _str_field(comment.get("author_name"))
        or _str_field(comment.get("user"))
        or ""
    )
    body = (
        _str_field(comment.get("body"))
        or _str_field(comment.get("text"))
        or _str_field(comment.get("content"))
        or ""
    )
    score = comment.get("score") or comment.get("ups") or comment.get("votes") or 0
    created_utc = comment.get("created_utc") or comment.get("created_at") or 0

    if isinstance(created_utc, str):
        try:
            dt = datetime.fromisoformat(created_utc.replace("Z", "+00:00"))
            created_utc = int(dt.timestamp())
        except (ValueError, TypeError):
            created_utc = 0

    return {
        "author": author,
        "body": body,
        "score": score,
        "created_utc": created_utc,
    }
