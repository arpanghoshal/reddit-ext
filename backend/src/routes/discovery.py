"""
Discovery Routes
API endpoints for AI-powered lead discovery
"""

from fastapi import APIRouter, HTTPException, Request, Query, BackgroundTasks
from pydantic import BaseModel
from typing import Optional, List

from ..middleware.supabase_auth import get_current_team_id
from ..services import discovery

router = APIRouter(prefix="/discovery", tags=["discovery"])


# ============================================================================
# Pydantic Models
# ============================================================================

class DiscoveryStartRequest(BaseModel):
    businessDesc: Optional[str] = None
    persona: Optional[str] = None
    tone: Optional[str] = None
    insightTypes: Optional[List[str]] = None
    # Automation mode fields
    mode: Optional[str] = "discovery"  # "discovery" | "automation"
    targetSubreddits: Optional[List[str]] = None
    accountId: Optional[str] = None
    autoQueue: Optional[bool] = False
    autoApprove: Optional[bool] = False
    minLeadScore: Optional[int] = 50

class LeadQueueRequest(BaseModel):
    accountId: str
    editedMessage: Optional[str] = None

class BulkQueueRequest(BaseModel):
    leadIds: List[str]
    accountId: str


# ============================================================================
# Session Endpoints
# ============================================================================

@router.post("/start")
async def start_discovery(
    request: Request,
    body: DiscoveryStartRequest,
    background_tasks: BackgroundTasks,
):
    """Start a new discovery session. Returns immediately; pipeline runs in background."""
    team_id = get_current_team_id(request)
    if not team_id:
        raise HTTPException(status_code=401, detail="Team context required")

    input_data = body.dict(exclude_none=True)

    # If no business desc provided, fetch from settings
    if not input_data.get("businessDesc"):
        from ..services.supabase_service import get_client
        client = get_client()
        if client:
            settings_result = client.table("user_settings").select("*").eq(
                "team_id", team_id
            ).execute()
            if settings_result.data:
                s = settings_result.data[0]
                input_data.setdefault("businessDesc", s.get("business_desc", ""))
                input_data.setdefault("persona", s.get("persona", ""))
                input_data.setdefault("tone", s.get("tone", "Curious"))
                input_data.setdefault("insightTypes", s.get("insight_types", []))

    if not input_data.get("businessDesc"):
        raise HTTPException(
            status_code=400,
            detail="Business description required. Provide it in the request or configure in Settings."
        )

    # Validate automation mode fields
    if input_data.get("mode") == "automation":
        if not input_data.get("targetSubreddits"):
            raise HTTPException(
                status_code=400,
                detail="targetSubreddits required for automation mode."
            )
        if input_data.get("autoQueue") and not input_data.get("accountId"):
            raise HTTPException(
                status_code=400,
                detail="accountId required when autoQueue is enabled."
            )

    try:
        session = await discovery.create_session(team_id, input_data)
        background_tasks.add_task(discovery.run_discovery_pipeline, session["id"])
        return {"success": True, "data": {"sessionId": session["id"], "status": "pending"}}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/sessions")
async def list_sessions(
    request: Request,
    limit: int = Query(20, le=50),
    offset: int = Query(0),
):
    """List discovery sessions for the team."""
    team_id = get_current_team_id(request)
    if not team_id:
        raise HTTPException(status_code=401, detail="Team context required")

    sessions = await discovery.get_sessions(team_id, limit=limit, offset=offset)
    return {"success": True, "data": sessions}


@router.get("/sessions/{session_id}")
async def get_session(request: Request, session_id: str):
    """Get session details including progress."""
    team_id = get_current_team_id(request)
    if not team_id:
        raise HTTPException(status_code=401, detail="Team context required")

    session = await discovery.get_session(session_id, team_id)
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")

    return {"success": True, "data": session}


@router.post("/sessions/{session_id}/cancel")
async def cancel_session(request: Request, session_id: str):
    """Cancel a running discovery session."""
    team_id = get_current_team_id(request)
    if not team_id:
        raise HTTPException(status_code=401, detail="Team context required")

    session = await discovery.get_session(session_id, team_id)
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")

    if session["status"] in ("completed", "failed", "cancelled"):
        raise HTTPException(status_code=400, detail="Session is not running")

    await discovery.update_session(session_id, {"status": "cancelled"})
    return {"success": True, "data": {"status": "cancelled"}}


# ============================================================================
# Subreddit Endpoints
# ============================================================================

@router.get("/sessions/{session_id}/subreddits")
async def get_subreddits(request: Request, session_id: str):
    """Get discovered subreddits for a session."""
    team_id = get_current_team_id(request)
    if not team_id:
        raise HTTPException(status_code=401, detail="Team context required")

    subreddits = await discovery.get_session_subreddits(session_id, team_id)
    return {"success": True, "data": subreddits}


# ============================================================================
# Lead Endpoints
# ============================================================================

@router.get("/sessions/{session_id}/leads")
async def get_leads(
    request: Request,
    session_id: str,
    tier: Optional[str] = None,
    status: Optional[str] = None,
    subreddit: Optional[str] = None,
    limit: int = Query(50, le=200),
    offset: int = Query(0),
):
    """Get leads for a session with optional filters."""
    team_id = get_current_team_id(request)
    if not team_id:
        raise HTTPException(status_code=401, detail="Team context required")

    leads = await discovery.get_session_leads(
        session_id, team_id,
        tier=tier, status=status, subreddit=subreddit,
        limit=limit, offset=offset,
    )
    return {"success": True, "data": leads}


@router.get("/sessions/{session_id}/leads/{lead_id}")
async def get_lead_detail(request: Request, session_id: str, lead_id: str):
    """Get a single lead with full details."""
    team_id = get_current_team_id(request)
    if not team_id:
        raise HTTPException(status_code=401, detail="Team context required")

    lead = await discovery.get_lead(lead_id, team_id)
    if not lead:
        raise HTTPException(status_code=404, detail="Lead not found")

    return {"success": True, "data": lead}


@router.post("/sessions/{session_id}/leads/{lead_id}/generate-message")
async def generate_message(request: Request, session_id: str, lead_id: str):
    """Generate an outreach message for a lead."""
    team_id = get_current_team_id(request)
    if not team_id:
        raise HTTPException(status_code=401, detail="Team context required")

    result = await discovery.generate_message_for_lead(lead_id, team_id)
    if not result:
        raise HTTPException(status_code=500, detail="Failed to generate message")

    return {"success": True, "data": {
        "message": result["message"],
        "reasoning": result.get("reasoning", ""),
    }}


@router.post("/sessions/{session_id}/leads/{lead_id}/queue")
async def queue_lead(
    request: Request,
    session_id: str,
    lead_id: str,
    body: LeadQueueRequest,
):
    """Queue a lead for outreach (generates message if needed, adds to dm_queue)."""
    team_id = get_current_team_id(request)
    if not team_id:
        raise HTTPException(status_code=401, detail="Team context required")

    result = await discovery.queue_lead(
        lead_id, team_id, body.accountId, body.editedMessage
    )
    if not result:
        raise HTTPException(status_code=500, detail="Failed to queue lead")

    return {"success": True, "data": result}


@router.post("/sessions/{session_id}/leads/{lead_id}/dismiss")
async def dismiss_lead(request: Request, session_id: str, lead_id: str):
    """Dismiss a lead."""
    team_id = get_current_team_id(request)
    if not team_id:
        raise HTTPException(status_code=401, detail="Team context required")

    await discovery.dismiss_lead(lead_id, team_id)
    return {"success": True}


@router.post("/sessions/{session_id}/leads/bulk-queue")
async def bulk_queue(
    request: Request,
    session_id: str,
    body: BulkQueueRequest,
):
    """Bulk queue multiple leads."""
    team_id = get_current_team_id(request)
    if not team_id:
        raise HTTPException(status_code=401, detail="Team context required")

    result = await discovery.bulk_queue_leads(body.leadIds, team_id, body.accountId)
    return {"success": True, "data": result}


# ============================================================================
# Automation Stats
# ============================================================================

@router.get("/sessions/{session_id}/automation-stats")
async def get_automation_stats(request: Request, session_id: str):
    """Get automation-specific stats: how many leads queued, approved, sent, etc."""
    team_id = get_current_team_id(request)
    if not team_id:
        raise HTTPException(status_code=401, detail="Team context required")

    session = await discovery.get_session(session_id, team_id)
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")

    stats = await discovery.get_automation_stats(session_id, team_id)
    return {"success": True, "data": stats}
