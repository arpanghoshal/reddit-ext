"""
Reddit Search Service
Wraps ScrapeCreators API (search/discovery) + Reddit public JSON (supplementary data).
"""

import os
import asyncio
import logging
from typing import Dict, Any, List, Optional
from datetime import datetime
import httpx

from .redis_client import cache_get, cache_set

logger = logging.getLogger(__name__)

SCRAPECREATORS_BASE_URL = "https://api.scrapecreators.com/v1/reddit"
REQUEST_TIMEOUT = 20.0

POST_SEARCH_CACHE_TTL = 900      # 15 minutes in seconds
SUBREDDIT_SEARCH_CACHE_TTL = 1800  # 30 minutes in seconds
SUBREDDIT_INFO_CACHE_TTL = 3600    # 60 minutes in seconds

# Delay between ScrapeCreators calls
SCRAPECREATORS_DELAY = 0.5  # seconds


def _get_scrapecreators_key() -> Optional[str]:
    return os.getenv("SCRAPECREATORS_API_KEY")


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
    cached = await cache_get(cache_key)
    if cached is not None:
        return cached

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

            await cache_set(cache_key, posts, POST_SEARCH_CACHE_TTL)
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
    cursor: Optional[str] = None,
) -> Dict[str, Any]:
    """
    Search within a specific subreddit via ScrapeCreators API.
    GET /v1/reddit/subreddit/search

    Returns:
        {"items": [...], "cursor": "..." or None}
    """
    api_key = _get_scrapecreators_key()
    if not api_key:
        logger.error("SCRAPECREATORS_API_KEY not set")
        return {"items": [], "cursor": None}

    cache_key = f"sub_search:{subreddit}:{query}:{sort}:{timeframe}:{filter_type}:{cursor or ''}"
    cached = await cache_get(cache_key)
    if cached is not None:
        return cached

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
        if cursor:
            params["cursor"] = cursor

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
                return {"items": [], "cursor": None}

            data = response.json()

            # Extract items based on filter type
            if filter_type == "comments":
                items = data.get("comments", [])
            elif filter_type == "media":
                items = data.get("media", [])
            else:
                items = data.get("posts", data.get("data", []))

            if not isinstance(items, list):
                items = []

            result = {
                "items": items,
                "cursor": data.get("cursor"),
            }

            await cache_set(cache_key, result, POST_SEARCH_CACHE_TTL)
            return result

    except Exception as e:
        logger.warning(f"ScrapeCreators subreddit search failed for r/{subreddit}: {e}")
        return {"items": [], "cursor": None}


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
    cached = await cache_get(cache_key)
    if cached is not None:
        return cached

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

            await cache_set(cache_key, posts, POST_SEARCH_CACHE_TTL)
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


async def get_post_with_comments(post_url: str) -> Optional[Dict[str, Any]]:
    """
    Fetch full post content AND comments via ScrapeCreators.
    Uses /v1/reddit/post/comments which returns the full response including
    post data and comments. Returns normalized post + comments.

    Returns:
        {"post": {url, title, body, author, subreddit, ...}, "comments": [...]}
        or None on failure
    """
    api_key = _get_scrapecreators_key()
    if not api_key:
        logger.error("SCRAPECREATORS_API_KEY not set")
        return None

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
                    "trim": "false",  # Get full content for enrichment
                },
                timeout=REQUEST_TIMEOUT,
            )

            if response.status_code != 200:
                logger.warning(
                    f"ScrapeCreators post+comments returned {response.status_code} for {post_url}"
                )
                return None

            data = response.json()

            # Extract post data from response
            # ScrapeCreators may return post data in various fields
            post_data = data.get("post", data.get("submission", {}))
            if not post_data:
                # If no dedicated post field, try to construct from top-level fields
                post_data = {
                    "title": data.get("title", ""),
                    "selftext": data.get("selftext", data.get("body", data.get("text", ""))),
                    "author": data.get("author", data.get("author_name", "")),
                    "subreddit": data.get("subreddit", data.get("subreddit_name", "")),
                    "url": data.get("url", data.get("permalink", post_url)),
                    "score": data.get("score", data.get("ups", 0)),
                    "num_comments": data.get("num_comments", data.get("comments_count", 0)),
                    "created_utc": data.get("created_utc", data.get("created_at", 0)),
                }

            # Normalize the post data using the existing normalize_post function
            normalized_post = normalize_post(post_data)

            # Ensure we have a valid URL
            if not normalized_post["url"] or not normalized_post["url"].startswith("http"):
                normalized_post["url"] = post_url

            # Extract and normalize comments
            raw_comments = data.get("comments", data.get("data", []))
            if not isinstance(raw_comments, list):
                raw_comments = []

            normalized_comments = []
            for c in raw_comments:
                nc = normalize_comment(c)
                if nc["author"] and nc["author"] != "[deleted]" and nc["body"]:
                    normalized_comments.append(nc)

            logger.info(
                f"ScrapeCreators post+comments: {post_url} → "
                f"author=u/{normalized_post['author']}, "
                f"{len(normalized_comments)} comments"
            )

            return {
                "post": normalized_post,
                "comments": normalized_comments,
            }

    except Exception as e:
        logger.warning(f"ScrapeCreators post+comments failed for {post_url}: {e}")
        return None


# ============================================================================
# Subreddit discovery & info (via ScrapeCreators)
# ============================================================================

async def search_subreddits(query: str, limit: int = 10) -> List[Dict[str, Any]]:
    """
    Discover subreddits by searching posts via ScrapeCreators and extracting
    unique subreddit names from results. Returns subreddits where the keyword
    is actually being discussed.
    """
    api_key = _get_scrapecreators_key()
    if not api_key:
        logger.error("SCRAPECREATORS_API_KEY not set")
        return []

    cache_key = f"sr_search:{query}:{limit}"
    cached = await cache_get(cache_key)
    if cached is not None:
        return cached

    try:
        await asyncio.sleep(SCRAPECREATORS_DELAY)
        async with httpx.AsyncClient() as client:
            response = await client.get(
                f"{SCRAPECREATORS_BASE_URL}/search",
                headers={
                    "x-api-key": api_key,
                    "Content-Type": "application/json",
                },
                params={"query": query, "sort": "relevance"},
                timeout=REQUEST_TIMEOUT,
            )

            if response.status_code != 200:
                logger.warning(f"ScrapeCreators search returned {response.status_code} for subreddit discovery '{query}'")
                return []

            data = response.json()
            posts = data.get("posts", data.get("data", []))
            if not isinstance(posts, list):
                posts = []

            # Extract unique subreddit names from post results
            seen = set()
            subreddits = []
            for post in posts:
                sr_name = (
                    post.get("subreddit")
                    or post.get("subreddit_name")
                    or ""
                )
                if isinstance(sr_name, dict):
                    sr_name = sr_name.get("text", sr_name.get("name", ""))
                if sr_name.startswith("r/"):
                    sr_name = sr_name[2:]
                if sr_name and sr_name.lower() not in seen:
                    seen.add(sr_name.lower())
                    subreddits.append({
                        "name": sr_name,
                        "subscribers": 0,
                        "description": "",
                        "url": f"/r/{sr_name}/",
                        "over18": False,
                        "created_utc": 0,
                    })
                    if len(subreddits) >= limit:
                        break

            await cache_set(cache_key, subreddits, SUBREDDIT_SEARCH_CACHE_TTL)
            return subreddits

    except Exception as e:
        logger.warning(f"ScrapeCreators subreddit discovery failed for '{query}': {e}")
        return []


async def get_subreddit_info(subreddit: str) -> Optional[Dict[str, Any]]:
    """
    Validate a subreddit exists and get basic info via ScrapeCreators.
    Fetches a small number of posts — if any return, the subreddit is valid.
    """
    api_key = _get_scrapecreators_key()
    if not api_key:
        logger.error("SCRAPECREATORS_API_KEY not set")
        return None

    cache_key = f"sr_info:{subreddit.lower()}"
    cached = await cache_get(cache_key)
    if cached is not None:
        return cached

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
                    "sort": "hot",
                    "trim": "true",
                },
                timeout=REQUEST_TIMEOUT,
            )

            if response.status_code != 200:
                logger.warning(f"ScrapeCreators subreddit info returned {response.status_code} for r/{subreddit}")
                return None

            data = response.json()
            posts = data.get("posts", data.get("data", []))

            info = {
                "name": subreddit,
                "subscribers": 0,
                "description": "",
                "title": subreddit,
                "over18": False,
                "created_utc": 0,
            }

            # Try to extract subscriber count from response metadata
            if isinstance(data.get("subreddit"), dict):
                sr_meta = data["subreddit"]
                info["subscribers"] = sr_meta.get("subscribers", 0)
                info["description"] = sr_meta.get("public_description", sr_meta.get("description", ""))
                info["title"] = sr_meta.get("title", subreddit)
                info["over18"] = sr_meta.get("over18", False)

            await cache_set(cache_key, info, SUBREDDIT_INFO_CACHE_TTL)
            return info

    except Exception as e:
        logger.warning(f"ScrapeCreators subreddit info failed for r/{subreddit}: {e}")
        return None


# ============================================================================
# User data (via ScrapeCreators)
# ============================================================================

async def get_user_about(username: str) -> Optional[Dict[str, Any]]:
    """
    Get Reddit user profile data via ScrapeCreators API.
    GET /v1/reddit/user
    """
    api_key = _get_scrapecreators_key()
    if not api_key:
        logger.error("SCRAPECREATORS_API_KEY not set")
        return None

    try:
        await asyncio.sleep(SCRAPECREATORS_DELAY)
        async with httpx.AsyncClient() as client:
            response = await client.get(
                f"{SCRAPECREATORS_BASE_URL}/user",
                headers={
                    "x-api-key": api_key,
                    "Content-Type": "application/json",
                },
                params={"username": username},
                timeout=REQUEST_TIMEOUT,
            )

            if response.status_code != 200:
                logger.warning(f"ScrapeCreators user about returned {response.status_code} for u/{username}")
                return None

            data = response.json()
            return data.get("user", data.get("data", data))

    except Exception as e:
        logger.warning(f"ScrapeCreators user about failed for u/{username}: {e}")
        return None


async def get_user_posts(username: str, limit: int = 25) -> List[Dict[str, Any]]:
    """
    Get a user's recent posts via ScrapeCreators API.
    GET /v1/reddit/user/posts
    """
    api_key = _get_scrapecreators_key()
    if not api_key:
        logger.error("SCRAPECREATORS_API_KEY not set")
        return []

    try:
        await asyncio.sleep(SCRAPECREATORS_DELAY)
        async with httpx.AsyncClient() as client:
            response = await client.get(
                f"{SCRAPECREATORS_BASE_URL}/user/posts",
                headers={
                    "x-api-key": api_key,
                    "Content-Type": "application/json",
                },
                params={"username": username},
                timeout=REQUEST_TIMEOUT,
            )

            if response.status_code != 200:
                logger.warning(f"ScrapeCreators user posts returned {response.status_code} for u/{username}")
                return []

            data = response.json()
            posts = data.get("posts", data.get("data", []))
            return posts[:limit] if isinstance(posts, list) else []

    except Exception as e:
        logger.warning(f"ScrapeCreators user posts failed for u/{username}: {e}")
        return []


async def get_user_comments(username: str, limit: int = 25) -> List[Dict[str, Any]]:
    """
    Get a user's recent comments via ScrapeCreators API.
    GET /v1/reddit/user/comments
    """
    api_key = _get_scrapecreators_key()
    if not api_key:
        logger.error("SCRAPECREATORS_API_KEY not set")
        return []

    try:
        await asyncio.sleep(SCRAPECREATORS_DELAY)
        async with httpx.AsyncClient() as client:
            response = await client.get(
                f"{SCRAPECREATORS_BASE_URL}/user/comments",
                headers={
                    "x-api-key": api_key,
                    "Content-Type": "application/json",
                },
                params={"username": username},
                timeout=REQUEST_TIMEOUT,
            )

            if response.status_code != 200:
                logger.warning(f"ScrapeCreators user comments returned {response.status_code} for u/{username}")
                return []

            data = response.json()
            comments = data.get("comments", data.get("data", []))
            return comments[:limit] if isinstance(comments, list) else []

    except Exception as e:
        logger.warning(f"ScrapeCreators user comments failed for u/{username}: {e}")
        return []


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
