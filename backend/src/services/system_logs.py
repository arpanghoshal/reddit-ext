"""
System Logs Service
Stores and retrieves system-wide logs from backend, frontend, and extension.
"""

import os
import logging
from typing import Dict, Any, List, Optional
from supabase import create_client, Client

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


async def insert_log(
    source: str,
    level: str,
    message: str,
    team_id: Optional[str] = None,
    user_id: Optional[str] = None,
    request_id: Optional[str] = None,
    component: Optional[str] = None,
    error_name: Optional[str] = None,
    error_stack: Optional[str] = None,
    metadata: Optional[Dict[str, Any]] = None,
    browser_info: Optional[str] = None,
    url: Optional[str] = None,
) -> Optional[Dict[str, Any]]:
    """Insert a log entry into the system_logs table."""
    client = get_client()
    if not client:
        logger.warning("system_logs_unavailable", extra={"reason": "supabase_not_configured"})
        return None

    try:
        row = {
            "source": source,
            "level": level,
            "message": message[:2000],  # Truncate very long messages
            "component": component,
            "error_name": error_name,
            "error_stack": error_stack[:10000] if error_stack else None,  # Truncate stacks
            "metadata": metadata or {},
            "browser_info": browser_info,
            "url": url,
        }

        # Only include non-null FK fields to avoid insert errors
        if team_id:
            row["team_id"] = team_id
        if user_id:
            row["user_id"] = user_id
        if request_id:
            row["request_id"] = request_id

        result = client.table("system_logs").insert(row).execute()
        return result.data[0] if result.data else None
    except Exception as e:
        # Don't let logging failures crash the app
        logger.error("system_log_insert_failed", extra={"error": str(e)})
        return None


async def get_logs(
    team_id: str,
    level: Optional[str] = None,
    source: Optional[str] = None,
    component: Optional[str] = None,
    request_id: Optional[str] = None,
    search: Optional[str] = None,
    limit: int = 50,
    offset: int = 0,
) -> List[Dict[str, Any]]:
    """Get system logs for a team with optional filters."""
    client = get_client()
    if not client:
        return []

    try:
        query = (
            client.table("system_logs")
            .select("*")
            .eq("team_id", team_id)
            .order("created_at", desc=True)
        )

        if level:
            query = query.eq("level", level)
        if source:
            query = query.eq("source", source)
        if component:
            query = query.eq("component", component)
        if request_id:
            query = query.eq("request_id", request_id)
        if search:
            query = query.ilike("message", f"%{search}%")

        if offset:
            query = query.range(offset, offset + limit - 1)
        else:
            query = query.limit(limit)

        result = query.execute()
        return result.data or []
    except Exception as e:
        logger.error("system_log_query_failed", extra={"error": str(e)})
        return []
