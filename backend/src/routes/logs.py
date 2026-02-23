"""
System Log Routes
Accepts error/event logs from frontend and extension clients,
and provides a query API for the dashboard log viewer.
"""

from fastapi import APIRouter, Request, Query
from pydantic import BaseModel, field_validator
from typing import Optional, List

from ..middleware.supabase_auth import get_current_team_id, get_current_user_id
from ..services import system_logs

router = APIRouter(prefix="/logs", tags=["logs"])

VALID_LEVELS = {"debug", "info", "warn", "error", "fatal"}
VALID_SOURCES = {"frontend", "extension"}


class LogEntry(BaseModel):
    level: str
    message: str
    source: str
    component: Optional[str] = None
    error_name: Optional[str] = None
    error_stack: Optional[str] = None
    metadata: Optional[dict] = None
    url: Optional[str] = None
    request_id: Optional[str] = None

    @field_validator("level")
    @classmethod
    def validate_level(cls, v):
        if v not in VALID_LEVELS:
            raise ValueError(f"level must be one of {VALID_LEVELS}")
        return v

    @field_validator("source")
    @classmethod
    def validate_source(cls, v):
        if v not in VALID_SOURCES:
            raise ValueError(f"source must be one of {VALID_SOURCES}")
        return v


class LogBatch(BaseModel):
    entries: List[LogEntry]


@router.post("")
async def ingest_log(request: Request, entry: LogEntry):
    """Ingest a single log entry from a client."""
    team_id = get_current_team_id(request)
    user_id = get_current_user_id(request)
    browser_info = request.headers.get("user-agent")

    await system_logs.insert_log(
        source=entry.source,
        level=entry.level,
        message=entry.message,
        team_id=team_id,
        user_id=user_id,
        request_id=entry.request_id,
        component=entry.component,
        error_name=entry.error_name,
        error_stack=entry.error_stack,
        metadata=entry.metadata,
        browser_info=browser_info,
        url=entry.url,
    )
    return {"success": True}


@router.post("/batch")
async def ingest_log_batch(request: Request, batch: LogBatch):
    """Ingest multiple log entries at once (for buffered client-side reporting)."""
    team_id = get_current_team_id(request)
    user_id = get_current_user_id(request)
    browser_info = request.headers.get("user-agent")

    count = 0
    for entry in batch.entries[:50]:  # Cap batch size at 50
        await system_logs.insert_log(
            source=entry.source,
            level=entry.level,
            message=entry.message,
            team_id=team_id,
            user_id=user_id,
            request_id=entry.request_id,
            component=entry.component,
            error_name=entry.error_name,
            error_stack=entry.error_stack,
            metadata=entry.metadata,
            browser_info=browser_info,
            url=entry.url,
        )
        count += 1

    return {"success": True, "ingested": count}


@router.get("")
async def get_system_logs(
    request: Request,
    level: Optional[str] = None,
    source: Optional[str] = None,
    component: Optional[str] = None,
    request_id: Optional[str] = None,
    search: Optional[str] = None,
    limit: int = Query(50, le=200),
    offset: int = Query(0),
):
    """Get system logs for the current team."""
    team_id = get_current_team_id(request)
    if not team_id:
        return {"success": True, "data": []}

    data = await system_logs.get_logs(
        team_id=team_id,
        level=level,
        source=source,
        component=component,
        request_id=request_id,
        search=search,
        limit=limit,
        offset=offset,
    )
    return {"success": True, "data": data}
