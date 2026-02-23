"""
Skipped Posts Service
Read operations for skipped_posts table
"""

import logging
from typing import Optional, Dict, List, Any
from .supabase_service import get_client

logger = logging.getLogger(__name__)


def _transform_from_db(row: Dict[str, Any]) -> Dict[str, Any]:
    """Transform database row to API format"""
    return {
        "id": row.get("id"),
        "postUrl": row.get("post_url"),
        "postTitle": row.get("post_title"),
        "subreddit": row.get("subreddit"),
        "author": row.get("author"),
        "sessionId": row.get("session_id"),
        "campaignId": row.get("campaign_id"),
        "skipReason": row.get("skip_reason"),
        "skipDetails": row.get("skip_details"),
        "classificationId": row.get("classification_id"),
        "qualificationId": row.get("qualification_id"),
        "createdAt": row.get("created_at")
    }


async def get_skipped_posts(filters: Dict[str, Any] = None, team_id: Optional[str] = None) -> List[Dict[str, Any]]:
    """Get skipped posts with optional filtering"""
    client = get_client()
    if not client:
        return []

    filters = filters or {}

    try:
        query = client.table("skipped_posts").select("*")

        if team_id:
            query = query.eq("team_id", team_id)

        if filters.get("subreddit"):
            query = query.eq("subreddit", filters["subreddit"])

        if filters.get("skipReason"):
            query = query.eq("skip_reason", filters["skipReason"])

        if filters.get("sessionId"):
            query = query.eq("session_id", filters["sessionId"])

        if filters.get("campaignId"):
            query = query.eq("campaign_id", filters["campaignId"])

        query = query.order("created_at", desc=True)

        limit = filters.get("limit", 100)
        offset = filters.get("offset", 0)
        query = query.range(offset, offset + limit - 1)

        result = query.execute()

        return [_transform_from_db(row) for row in (result.data or [])]
    except Exception as e:
        logger.error(f"Failed to get skipped posts: {e}")
        return []


async def get_skip_stats(team_id: Optional[str] = None) -> Dict[str, Any]:
    """Get statistics about skipped posts by reason"""
    client = get_client()
    if not client:
        return {"total": 0, "byReason": {}, "bySubreddit": {}}

    try:
        # Get all skipped posts (limited to recent for performance)
        query = client.table("skipped_posts").select(
            "skip_reason, subreddit"
        )
        if team_id:
            query = query.eq("team_id", team_id)
        result = query.order("created_at", desc=True).limit(5000).execute()

        if not result.data:
            return {"total": 0, "byReason": {}, "bySubreddit": {}}

        posts = result.data
        total = len(posts)

        # Count by reason
        by_reason: Dict[str, int] = {}
        for post in posts:
            reason = post.get("skip_reason", "unknown")
            by_reason[reason] = by_reason.get(reason, 0) + 1

        # Count by subreddit
        by_subreddit: Dict[str, int] = {}
        for post in posts:
            subreddit = post.get("subreddit")
            if subreddit:
                by_subreddit[subreddit] = by_subreddit.get(subreddit, 0) + 1

        # Sort by count and take top 10 subreddits
        sorted_subreddits = sorted(by_subreddit.items(), key=lambda x: x[1], reverse=True)
        top_subreddits = dict(sorted_subreddits[:10])

        return {
            "total": total,
            "byReason": by_reason,
            "bySubreddit": top_subreddits
        }
    except Exception as e:
        logger.error(f"Failed to get skip stats: {e}")
        return {"total": 0, "byReason": {}, "bySubreddit": {}}


async def log_skipped_post(data: Dict[str, Any], team_id: Optional[str] = None) -> bool:
    """Log a skipped post (for use by automation)"""
    client = get_client()
    if not client:
        return False

    try:
        db_data = {
            "post_url": data.get("postUrl"),
            "post_title": data.get("postTitle"),
            "subreddit": data.get("subreddit"),
            "author": data.get("author"),
            "session_id": data.get("sessionId"),
            "campaign_id": data.get("campaignId"),
            "skip_reason": data.get("skipReason"),
            "skip_details": data.get("skipDetails"),
            "classification_id": data.get("classificationId"),
            "qualification_id": data.get("qualificationId"),
            "team_id": team_id
        }

        # Remove None values
        db_data = {k: v for k, v in db_data.items() if v is not None}

        client.table("skipped_posts").insert(db_data).execute()
        return True
    except Exception as e:
        logger.error(f"Failed to log skipped post: {e}")
        return False
