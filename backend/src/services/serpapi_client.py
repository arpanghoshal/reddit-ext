"""
SerpAPI Client
Wraps SerpAPI Google search for Reddit content discovery.
Post content and comments are fetched via ScrapeCreators (see reddit_search.py).
"""

import os
import re
import asyncio
import logging
from typing import Dict, Any, List, Optional
from datetime import datetime, timedelta
import httpx

logger = logging.getLogger(__name__)

SERPAPI_BASE_URL = "https://serpapi.com/search"
SERPAPI_TIMEOUT = 20.0

# Cache
_search_cache: Dict[str, Dict[str, Any]] = {}
SEARCH_CACHE_TTL = 15  # minutes

# Rate limiting
SERPAPI_DELAY = 0.3  # seconds between SerpAPI calls


def _get_serpapi_key() -> Optional[str]:
    return os.getenv("SERPAPI_API_KEY")


def _evict_cache(cache: Dict, ttl_minutes: int):
    now = datetime.utcnow()
    expired = [
        k for k, v in cache.items()
        if now - v["fetched_at"] > timedelta(minutes=ttl_minutes)
    ]
    for k in expired:
        del cache[k]


# ============================================================================
# SerpAPI: Google Search for Reddit Posts
# ============================================================================

async def search_reddit_posts(
    query: str,
    num_results: int = 20,
    time_period: str = "m",
    tbs: Optional[str] = None,
) -> List[Dict[str, Any]]:
    """
    Search Google for Reddit posts via SerpAPI.

    Args:
        query: Search query (site:reddit.com is appended automatically)
        num_results: Number of results to request
        time_period: Google time filter shortcut (h/d/w/m/y). Ignored if tbs is set.
        tbs: Full Google tbs param (e.g. "qdr:w" or "cdr:1,cd_min:01/01/2025,cd_max:02/01/2025").
             If provided, overrides time_period.

    Returns:
        List of result dicts with: title, link, snippet, displayed_link
    """
    api_key = _get_serpapi_key()
    if not api_key:
        logger.error("SERPAPI_API_KEY not set")
        return []

    tbs_value = tbs if tbs else f"qdr:{time_period}"
    cache_key = f"serp:{query}:{num_results}:{tbs_value}"
    _evict_cache(_search_cache, SEARCH_CACHE_TTL)
    if cache_key in _search_cache:
        return _search_cache[cache_key]["data"]

    full_query = f"{query} site:reddit.com"

    try:
        await asyncio.sleep(SERPAPI_DELAY)
        async with httpx.AsyncClient() as client:
            response = await client.get(
                SERPAPI_BASE_URL,
                params={
                    "engine": "google",
                    "q": full_query,
                    "api_key": api_key,
                    "num": str(num_results),
                    "tbs": tbs_value,
                    "gl": "us",
                    "hl": "en",
                },
                timeout=SERPAPI_TIMEOUT,
            )

            if response.status_code != 200:
                logger.warning(f"SerpAPI returned {response.status_code} for '{query}'")
                return []

            data = response.json()

            # Check for API errors
            if "error" in data:
                logger.error(f"SerpAPI error for '{query}': {data['error']}")
                return []

            organic = data.get("organic_results", [])

            # Filter to only reddit.com post URLs
            results = []
            for item in organic:
                link = item.get("link", "")
                if "reddit.com" not in link:
                    continue
                # Only include actual post URLs (not subreddit pages, wikis, etc.)
                if not re.search(r'/r/\w+/comments/\w+', link):
                    continue
                results.append({
                    "title": item.get("title", ""),
                    "link": link,
                    "snippet": item.get("snippet", ""),
                    "displayed_link": item.get("displayed_link", ""),
                    "date": item.get("date", ""),
                })

            logger.info(f"SerpAPI: '{query}' → {len(results)} Reddit posts (from {len(organic)} organic results)")

            _search_cache[cache_key] = {
                "data": results,
                "fetched_at": datetime.utcnow(),
            }
            return results

    except Exception as e:
        logger.warning(f"SerpAPI search failed for '{query}': {e}")
        return []


async def search_subreddit_posts(
    subreddit: str,
    query: str,
    num_results: int = 15,
    time_period: str = "m",
    tbs: Optional[str] = None,
) -> List[Dict[str, Any]]:
    """
    Search Google for posts within a specific subreddit.
    Scopes search with site:reddit.com/r/{subreddit}.

    Args:
        tbs: Full Google tbs param. If provided, overrides time_period.
    """
    scoped_query = f"{query} site:reddit.com/r/{subreddit}"
    api_key = _get_serpapi_key()
    if not api_key:
        logger.error("SERPAPI_API_KEY not set")
        return []

    tbs_value = tbs if tbs else f"qdr:{time_period}"
    cache_key = f"serp_sub:{subreddit}:{query}:{num_results}:{tbs_value}"
    _evict_cache(_search_cache, SEARCH_CACHE_TTL)
    if cache_key in _search_cache:
        return _search_cache[cache_key]["data"]

    try:
        await asyncio.sleep(SERPAPI_DELAY)
        async with httpx.AsyncClient() as client:
            response = await client.get(
                SERPAPI_BASE_URL,
                params={
                    "engine": "google",
                    "q": scoped_query,
                    "api_key": api_key,
                    "num": str(num_results),
                    "tbs": tbs_value,
                    "gl": "us",
                    "hl": "en",
                },
                timeout=SERPAPI_TIMEOUT,
            )

            if response.status_code != 200:
                logger.warning(f"SerpAPI returned {response.status_code} for r/{subreddit} '{query}'")
                return []

            data = response.json()
            if "error" in data:
                logger.error(f"SerpAPI error for r/{subreddit} '{query}': {data['error']}")
                return []

            organic = data.get("organic_results", [])
            results = []
            for item in organic:
                link = item.get("link", "")
                if "reddit.com" not in link:
                    continue
                if not re.search(r'/r/\w+/comments/\w+', link):
                    continue
                results.append({
                    "title": item.get("title", ""),
                    "link": link,
                    "snippet": item.get("snippet", ""),
                    "displayed_link": item.get("displayed_link", ""),
                    "date": item.get("date", ""),
                })

            logger.info(f"SerpAPI: r/{subreddit} '{query}' → {len(results)} posts")

            _search_cache[cache_key] = {
                "data": results,
                "fetched_at": datetime.utcnow(),
            }
            return results

    except Exception as e:
        logger.warning(f"SerpAPI subreddit search failed for r/{subreddit} '{query}': {e}")
        return []


# ============================================================================
# SerpAPI Result Normalization
# ============================================================================

def parse_serpapi_result(result: Dict[str, Any]) -> Dict[str, Any]:
    """
    Normalize a SerpAPI organic result into the format expected
    by the discovery pipeline (matching the normalized post format).

    Note: author will be empty and body will be the Google snippet only.
    Full data is fetched via ScrapeCreators in the enrichment phase.
    """
    link = result.get("link", "")
    title = result.get("title", "")
    snippet = result.get("snippet", "")

    # Extract subreddit from URL
    subreddit = ""
    sr_match = re.search(r'/r/(\w+)', link)
    if sr_match:
        subreddit = sr_match.group(1)

    # Clean up title: Google often appends " : r/subreddit" or " - Reddit"
    title = re.sub(r'\s*[-:]\s*r/\w+\s*$', '', title)
    title = re.sub(r'\s*[-:]\s*Reddit\s*$', '', title)

    return {
        "url": link,
        "title": title,
        "body": snippet,  # Placeholder — enriched later via ScrapeCreators
        "author": "",     # Empty — enriched later via ScrapeCreators
        "subreddit": subreddit,
        "created_utc": 0,
        "score": 0,
        "num_comments": 0,
    }
