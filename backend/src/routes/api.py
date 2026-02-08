"""
API Routes
All REST API endpoints for the Reddit Automated DM Backend
"""

import os
import logging
from fastapi import APIRouter, HTTPException, Query, Request
from pydantic import BaseModel

logger = logging.getLogger(__name__)
from typing import Dict, Any, List, Optional

from ..middleware.supabase_auth import get_current_team_id
from ..services import supabase_service as supabase
from ..services import llm
from ..services import classification
from ..services import qualification
from ..services import queue
from ..services import accounts
from ..services import rotation
from ..services import safety
from ..services import conversations
from ..services import user_analysis
from ..services import lead_scoring
from ..services import intent_detection
from ..services import ab_testing
from ..services import analytics
from ..services import conversation_ai
from ..services import automation_settings
from ..services import skipped_posts

router = APIRouter()


# --- Pydantic Models ---

class PostData(BaseModel):
    url: Optional[str] = None
    title: Optional[str] = None
    body: Optional[str] = None
    subreddit: Optional[str] = None
    author: Optional[str] = None


class Settings(BaseModel):
    businessDesc: Optional[str] = None
    persona: Optional[str] = None
    insightTypes: Optional[List[str]] = None
    tone: Optional[str] = None
    model: Optional[str] = None


class GenerateRequest(BaseModel):
    post: PostData
    settings: Optional[Settings] = None


class DMLogRequest(BaseModel):
    recipientUsername: str
    postUrl: Optional[str] = None
    postTitle: Optional[str] = None
    subreddit: Optional[str] = None
    messageContent: str
    status: Optional[str] = "sent"
    automationType: Optional[str] = "single"
    sessionId: Optional[str] = None


class SessionStartRequest(BaseModel):
    subreddit: Optional[str] = None
    totalPosts: Optional[int] = 0


class SessionUpdateRequest(BaseModel):
    processedCount: Optional[int] = None
    successCount: Optional[int] = None
    failedCount: Optional[int] = None
    status: Optional[str] = None


class SettingsSaveRequest(BaseModel):
    businessDesc: Optional[str] = None
    persona: Optional[str] = None
    insightTypes: Optional[List[str]] = None
    tone: Optional[str] = None


class ClassifyRequest(BaseModel):
    post: PostData
    settings: Optional[Settings] = None


class ClassifyBatchRequest(BaseModel):
    posts: List[PostData]
    settings: Optional[Settings] = None


class QualifyBatchRequest(BaseModel):
    usernames: List[str]
    options: Optional[Dict[str, Any]] = None


class FilterRequest(BaseModel):
    post: PostData
    settings: Optional[Settings] = None


class QueueAddRequest(BaseModel):
    accountId: Optional[str] = None
    recipientUsername: str
    subreddit: Optional[str] = None
    postUrl: Optional[str] = None
    postTitle: Optional[str] = None
    postBody: Optional[str] = None
    classificationId: Optional[str] = None
    classificationScore: Optional[float] = None
    classificationCategory: Optional[str] = None
    generatedMessage: str
    editedMessage: Optional[str] = None
    status: Optional[str] = "pending"
    queueMode: Optional[str] = "review"
    messageType: Optional[str] = "outreach"
    conversationId: Optional[str] = None
    scheduledAt: Optional[str] = None


class ReplyQueueAddRequest(BaseModel):
    conversationId: str
    recipientUsername: str
    generatedMessage: str
    editedMessage: Optional[str] = None
    status: Optional[str] = "pending"
    accountId: Optional[str] = None


class QueueUpdateRequest(BaseModel):
    editedMessage: Optional[str] = None
    status: Optional[str] = None
    accountId: Optional[str] = None
    scheduledAt: Optional[str] = None


class BulkApproveRequest(BaseModel):
    ids: List[str]
    approvedBy: Optional[str] = None


class BulkRejectRequest(BaseModel):
    ids: List[str]
    reason: Optional[str] = None


class AccountAddRequest(BaseModel):
    username: str
    displayName: Optional[str] = None
    cookies: Optional[List[Dict[str, Any]]] = None
    warmupMode: Optional[bool] = True
    dailyLimit: Optional[int] = 20


class AccountUpdateRequest(BaseModel):
    displayName: Optional[str] = None
    warmupMode: Optional[bool] = None
    dailyLimit: Optional[int] = None
    status: Optional[str] = None
    cookies: Optional[List[Dict[str, Any]]] = None


class SubredditAssignRequest(BaseModel):
    subreddit: str
    priority: Optional[int] = 1


class SafetyEventRequest(BaseModel):
    accountId: Optional[str] = None
    eventType: str
    details: Optional[Dict[str, Any]] = None


class ConversationCreateRequest(BaseModel):
    participantUsername: str
    redditConversationId: Optional[str] = None
    accountId: Optional[str] = None
    initialDmId: Optional[str] = None
    initialQueueId: Optional[str] = None
    status: Optional[str] = "active"
    notes: Optional[str] = None
    tags: Optional[List[str]] = None


class ConversationUpdateRequest(BaseModel):
    status: Optional[str] = None
    notes: Optional[str] = None
    tags: Optional[List[str]] = None
    hasReply: Optional[bool] = None
    lastMessageAt: Optional[str] = None
    lastMessageDirection: Optional[str] = None
    totalMessages: Optional[int] = None
    accountId: Optional[str] = None


class MessageAddRequest(BaseModel):
    direction: str
    content: str
    sentAt: Optional[str] = None
    isAiGenerated: Optional[bool] = False


class ConversationSyncRequest(BaseModel):
    participantUsername: str
    redditConversationId: Optional[str] = None
    messages: List[Dict[str, Any]]
    accountId: Optional[str] = None
    accountUsername: Optional[str] = None


# --- LLM Routes ---

@router.post("/generate")
async def generate_message(request: GenerateRequest):
    if not request.post:
        raise HTTPException(status_code=400, detail="Post data is required")

    post = request.post.model_dump()
    settings = request.settings.model_dump() if request.settings else {}

    message = await llm.generate_question({"post": post, "settings": settings})
    return {"success": True, "message": message}


@router.get("/models")
async def get_models():
    return {"models": llm.get_available_models()}


# --- DM History Routes ---

@router.post("/dm")
async def log_dm(request: Request, body: DMLogRequest):
    team_id = get_current_team_id(request)
    result = await supabase.log_dm(body.model_dump(), team_id=team_id)
    return {"success": True, "data": result}


@router.get("/dm/history")
async def get_dm_history(request: Request, limit: int = Query(50, le=200)):
    team_id = get_current_team_id(request)
    history = await supabase.get_dm_history(limit, team_id=team_id)
    return {"success": True, "data": history}


@router.get("/dm/subreddits")
async def get_dm_subreddits(request: Request, limit: int = Query(10)):
    team_id = get_current_team_id(request)
    data = await supabase.get_dms_by_subreddit(limit, team_id=team_id)
    return {"success": True, "data": data}


# --- Automation Session Routes ---

@router.post("/session/start")
async def start_session(request: Request, body: SessionStartRequest):
    team_id = get_current_team_id(request)
    result = await supabase.start_automation_session(body.model_dump(), team_id=team_id)
    return {"success": True, **result}


@router.patch("/session/{session_id}")
async def update_session(request: Request, session_id: str, body: SessionUpdateRequest):
    team_id = get_current_team_id(request)
    result = await supabase.update_automation_session(session_id, body.model_dump(exclude_none=True), team_id=team_id)
    return {"success": True, "data": result}


@router.get("/session/logs")
async def get_session_logs(request: Request, limit: int = Query(20, le=200)):
    team_id = get_current_team_id(request)
    logs = await supabase.get_automation_logs(limit, team_id=team_id)
    return {"success": True, "data": logs}


# --- Analytics Routes ---

@router.get("/analytics")
async def get_analytics(request: Request):
    team_id = get_current_team_id(request)
    analytics_data = await supabase.get_analytics(team_id=team_id)
    return {"success": True, "data": analytics_data}


# --- Settings Routes ---

@router.get("/settings")
async def get_settings(request: Request):
    team_id = get_current_team_id(request)
    settings = await supabase.get_settings(team_id=team_id)
    return {"success": True, "data": settings}


@router.post("/settings")
async def save_settings(request: Request, body: SettingsSaveRequest):
    team_id = get_current_team_id(request)
    result = await supabase.save_settings(body.model_dump(), team_id=team_id)
    return {"success": True, "data": result}


# --- Health/Status ---

@router.get("/status")
async def get_status():
    return {
        "supabaseConfigured": supabase.is_configured(),
        "openrouterConfigured": bool(os.getenv("OPENROUTER_API_KEY"))
    }


# --- Authentication Routes ---

class ValidateKeyRequest(BaseModel):
    apiKey: str


@router.post("/auth/validate")
async def validate_api_key_route(request: ValidateKeyRequest):
    """Validate an API key and return user info if valid."""
    from ..middleware.auth import validate_api_key_multi

    user_info = validate_api_key_multi(request.apiKey)

    if user_info:
        return {
            "valid": True,
            "user": {
                "userId": user_info.get("user_id"),
                "name": user_info.get("name"),
                "role": user_info.get("role"),
                "dailyLimit": user_info.get("daily_limit", 50)
            }
        }
    else:
        return {
            "valid": False,
            "user": None
        }


# --- Classification Routes ---

@router.post("/classify")
async def classify_post_route(request: ClassifyRequest):
    if not request.post or not request.post.url:
        raise HTTPException(status_code=400, detail="Post data with URL is required")

    post = request.post.model_dump()
    settings = request.settings.model_dump() if request.settings else {}

    try:
        result = await classification.classify_post(post, settings)
        return {"success": True, "data": result}
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        logger.error(f"Classification failed for {request.post.url}: {e}")
        raise HTTPException(status_code=500, detail=f"Classification failed: {str(e)}")


@router.post("/classify/batch")
async def classify_batch_route(request: ClassifyBatchRequest):
    if not request.posts:
        raise HTTPException(status_code=400, detail="Posts array is required")

    posts = [p.model_dump() for p in request.posts]
    settings = request.settings.model_dump() if request.settings else {}

    results = await classification.classify_batch(posts, settings)
    return {"success": True, "data": results}


@router.get("/classification/stats")
async def get_classification_stats():
    stats = await classification.get_classification_stats()
    return {"success": True, "data": stats}


# --- Qualification Routes ---

@router.get("/qualify/{username}")
async def qualify_user_route(
    username: str,
    minAge: Optional[int] = None,
    minKarma: Optional[int] = None,
    blockBots: str = "true"
):
    options = {
        "minAccountAgeDays": minAge,
        "minKarma": minKarma,
        "blockSuspectedBots": blockBots != "false"
    }
    # Remove None values
    options = {k: v for k, v in options.items() if v is not None}

    result = await qualification.qualify_user(username, options)
    return {"success": True, "data": result}


@router.post("/qualify/batch")
async def qualify_batch_route(request: QualifyBatchRequest):
    if not request.usernames:
        raise HTTPException(status_code=400, detail="Usernames array is required")

    results = await qualification.qualify_batch(request.usernames, request.options or {})
    return {"success": True, "data": results}


@router.get("/qualification/stats")
async def get_qualification_stats():
    stats = await qualification.get_qualification_stats()
    return {"success": True, "data": stats}


# --- Combined Filter Endpoint ---

@router.post("/filter")
async def filter_route(request: FilterRequest):
    if not request.post:
        raise HTTPException(status_code=400, detail="Post data is required")

    post = request.post.model_dump()
    settings = request.settings.model_dump() if request.settings else {}

    # Classify the post
    classification_result = await classification.classify_post(post, settings)

    # If not relevant, skip qualification
    if classification_result.get("category") == "not_relevant":
        return {
            "success": True,
            "data": {
                "shouldProceed": False,
                "reason": "Post not relevant",
                "classification": classification_result,
                "qualification": None
            }
        }

    # Qualify the user
    qualification_result = await qualification.qualify_user(post.get("author", ""), settings)

    should_proceed = (
        classification_result.get("category") != "not_relevant" and
        qualification_result.get("isQualified", False)
    )

    return {
        "success": True,
        "data": {
            "shouldProceed": should_proceed,
            "reason": (
                qualification_result.get("disqualificationReason") or "User not qualified"
            ) if not should_proceed else None,
            "classification": classification_result,
            "qualification": qualification_result
        }
    }


# --- Queue Routes ---

@router.get("/queue")
async def get_queue_route(
    request: Request,
    status: Optional[str] = None,
    accountId: Optional[str] = None,
    subreddit: Optional[str] = None,
    mode: Optional[str] = None,
    messageType: Optional[str] = None,
    conversationId: Optional[str] = None,
    limit: int = Query(50, le=200),
    offset: int = Query(0)
):
    team_id = get_current_team_id(request)
    filters = {
        "status": status,
        "accountId": accountId,
        "subreddit": subreddit,
        "queueMode": mode,
        "messageType": messageType,
        "conversationId": conversationId,
        "limit": limit,
        "offset": offset
    }
    items = await queue.get_queue(filters, team_id=team_id)
    return {"success": True, "data": items}


@router.post("/queue")
async def add_to_queue_route(request: Request, body: QueueAddRequest):
    team_id = get_current_team_id(request)
    item = await queue.add_to_queue(body.model_dump(), team_id=team_id)
    return {"success": True, "data": item}


@router.post("/queue/reply")
async def add_reply_to_queue_route(request: Request, body: ReplyQueueAddRequest):
    """Add a reply message to the queue"""
    team_id = get_current_team_id(request)
    item = await queue.add_to_queue({
        "conversationId": body.conversationId,
        "recipientUsername": body.recipientUsername,
        "generatedMessage": body.generatedMessage,
        "editedMessage": body.editedMessage,
        "status": body.status,
        "accountId": body.accountId,
        "messageType": "reply",
        "queueMode": "review"
    }, team_id=team_id)
    return {"success": True, "data": item}


@router.get("/queue/stats")
async def get_queue_stats(request: Request, messageType: Optional[str] = None):
    team_id = get_current_team_id(request)
    stats = await queue.get_queue_stats(message_type=messageType, team_id=team_id)
    return {"success": True, "data": stats}


@router.get("/queue/next")
async def get_next_to_send(request: Request, accountId: Optional[str] = None, messageType: Optional[str] = None):
    team_id = get_current_team_id(request)
    item = await queue.get_next_to_send(account_id=accountId, message_type=messageType, team_id=team_id)
    return {"success": True, "data": item}


@router.get("/queue/next-reply")
async def get_next_reply_to_send(request: Request, accountId: Optional[str] = None):
    """Get the next approved reply to send"""
    team_id = get_current_team_id(request)
    item = await queue.get_next_reply_to_send(account_id=accountId, team_id=team_id)
    return {"success": True, "data": item}


@router.get("/queue/pending-reply/{conversation_id}")
async def get_pending_reply_for_conversation_route(request: Request, conversation_id: str):
    """Check if a conversation has a pending/approved reply in queue"""
    team_id = get_current_team_id(request)
    item = await queue.get_pending_reply_for_conversation(conversation_id, team_id=team_id)
    return {"success": True, "data": item}


@router.get("/queue/{item_id}")
async def get_queue_item_route(request: Request, item_id: str):
    team_id = get_current_team_id(request)
    item = await queue.get_queue_item(item_id, team_id=team_id)
    if not item:
        raise HTTPException(status_code=404, detail="Queue item not found")
    return {"success": True, "data": item}


@router.patch("/queue/{item_id}")
async def update_queue_item_route(request: Request, item_id: str, body: QueueUpdateRequest):
    team_id = get_current_team_id(request)
    item = await queue.update_queue_item(item_id, body.model_dump(exclude_none=True), team_id=team_id)
    return {"success": True, "data": item}


@router.delete("/queue/{item_id}")
async def delete_queue_item_route(request: Request, item_id: str):
    team_id = get_current_team_id(request)
    success = await queue.delete_queue_item(item_id, team_id=team_id)
    return {"success": success}


@router.post("/queue/{item_id}/approve")
async def approve_queue_item_route(request: Request, item_id: str, approvedBy: Optional[str] = None):
    team_id = get_current_team_id(request)
    item = await queue.approve_queue_item(item_id, approvedBy, team_id=team_id)
    return {"success": True, "data": item}


@router.post("/queue/{item_id}/reject")
async def reject_queue_item_route(request: Request, item_id: str, reason: Optional[str] = None):
    team_id = get_current_team_id(request)
    item = await queue.reject_queue_item(item_id, reason, team_id=team_id)
    return {"success": True, "data": item}


@router.post("/queue/{item_id}/sent")
async def mark_as_sent_route(request: Request, item_id: str):
    team_id = get_current_team_id(request)
    item = await queue.mark_as_sent(item_id, team_id=team_id)
    return {"success": True, "data": item}


@router.post("/queue/{item_id}/failed")
async def mark_as_failed_route(request: Request, item_id: str, reason: str = ""):
    team_id = get_current_team_id(request)
    item = await queue.mark_as_failed(item_id, reason, team_id=team_id)
    return {"success": True, "data": item}


@router.post("/queue/bulk-approve")
async def bulk_approve_route(request: Request, body: BulkApproveRequest):
    if not body.ids:
        raise HTTPException(status_code=400, detail="IDs array is required")
    team_id = get_current_team_id(request)
    result = await queue.bulk_approve(body.ids, body.approvedBy, team_id=team_id)
    return {"success": True, "data": result}


@router.post("/queue/bulk-reject")
async def bulk_reject_route(request: Request, body: BulkRejectRequest):
    if not body.ids:
        raise HTTPException(status_code=400, detail="IDs array is required")
    team_id = get_current_team_id(request)
    result = await queue.bulk_reject(body.ids, body.reason, team_id=team_id)
    return {"success": True, "data": result}


# --- Account Routes ---

@router.get("/accounts/summary")
async def get_accounts_summary_route(request: Request):
    """Lightweight endpoint returning only id/username/status for dropdowns"""
    team_id = get_current_team_id(request)
    accounts_list = await accounts.get_accounts({}, team_id=team_id)
    summary = [{"id": a["id"], "username": a["username"], "status": a["status"]} for a in accounts_list]
    return {"success": True, "data": summary}


@router.get("/accounts")
async def get_accounts_route(
    request: Request,
    status: Optional[str] = None,
    activeOnly: bool = False
):
    team_id = get_current_team_id(request)
    filters = {"status": status, "activeOnly": activeOnly}
    accounts_list = await accounts.get_accounts(filters, team_id=team_id)
    return {"success": True, "data": accounts_list}


@router.post("/accounts")
async def add_account_route(request: Request, body: AccountAddRequest):
    team_id = get_current_team_id(request)
    account = await accounts.add_account(body.model_dump(), team_id=team_id)
    return {"success": True, "data": account}


@router.get("/accounts/{account_id}")
async def get_account_route(request: Request, account_id: str):
    team_id = get_current_team_id(request)
    account = await accounts.get_account(account_id, team_id=team_id)
    if not account:
        raise HTTPException(status_code=404, detail="Account not found")
    return {"success": True, "data": account}


@router.patch("/accounts/{account_id}")
async def update_account_route(request: Request, account_id: str, body: AccountUpdateRequest):
    team_id = get_current_team_id(request)
    account = await accounts.update_account(account_id, body.model_dump(exclude_none=True), team_id=team_id)
    return {"success": True, "data": account}


@router.delete("/accounts/{account_id}")
async def delete_account_route(request: Request, account_id: str):
    team_id = get_current_team_id(request)
    success = await accounts.delete_account(account_id, team_id=team_id)
    return {"success": success}


@router.get("/accounts/{account_id}/cookies")
async def get_account_cookies_route(request: Request, account_id: str):
    team_id = get_current_team_id(request)
    cookies = await accounts.get_account_cookies(account_id, team_id=team_id)
    if not cookies:
        raise HTTPException(status_code=404, detail="Cookies not found")
    return {"success": True, "data": cookies}


@router.get("/accounts/{account_id}/can-send")
async def can_account_send_route(request: Request, account_id: str):
    team_id = get_current_team_id(request)
    result = await accounts.can_account_send_dm(account_id, team_id=team_id)
    return {"success": True, "data": result}


@router.post("/accounts/{account_id}/increment-dm")
async def increment_dm_route(request: Request, account_id: str):
    team_id = get_current_team_id(request)
    account = await accounts.increment_dm_count(account_id, team_id=team_id)
    return {"success": True, "data": account}


@router.post("/accounts/{account_id}/check-shadowban")
async def check_shadowban_route(request: Request, account_id: str):
    team_id = get_current_team_id(request)
    account = await accounts.get_account(account_id, team_id=team_id)
    if not account:
        raise HTTPException(status_code=404, detail="Account not found")

    result = await safety.check_shadowban(account["username"])

    if result.get("isShadowbanned"):
        await accounts.mark_as_shadowbanned(account_id, result)
        await safety.log_safety_event({
            "accountId": account_id,
            "eventType": "shadowban_detected",
            "details": result
        })

    return {"success": True, "data": result}


@router.get("/accounts/{account_id}/subreddits")
async def get_account_subreddits_route(request: Request, account_id: str):
    subreddits = await accounts.get_account_subreddits(account_id)
    return {"success": True, "data": subreddits}


@router.post("/accounts/{account_id}/subreddits")
async def assign_to_subreddit_route(request: Request, account_id: str, body: SubredditAssignRequest):
    success = await accounts.assign_to_subreddit(account_id, body.subreddit, body.priority)
    return {"success": success}


@router.delete("/accounts/{account_id}/subreddits/{subreddit_name}")
async def remove_from_subreddit_route(request: Request, account_id: str, subreddit_name: str):
    success = await accounts.remove_from_subreddit(account_id, subreddit_name)
    return {"success": success}


# --- Rotation Routes ---

@router.get("/rotation/next/{subreddit}")
async def get_rotation_next(subreddit: str):
    account = await rotation.select_account_for_subreddit(subreddit)
    return {"success": True, "data": account}


@router.get("/rotation/status")
async def get_rotation_status():
    status = await rotation.get_rotation_status()
    return {"success": True, "data": status}


@router.get("/rotation/next-available")
async def get_next_available_route():
    result = await rotation.get_next_available()
    return {"success": True, "data": result}


# --- Safety Routes ---

@router.get("/safety/events")
async def get_safety_events_route(
    accountId: Optional[str] = None,
    type: Optional[str] = None,
    since: Optional[str] = None,
    limit: int = Query(50)
):
    filters = {
        "accountId": accountId,
        "eventType": type,
        "since": since,
        "limit": limit
    }
    events = await safety.get_safety_events(filters)
    return {"success": True, "data": events}


@router.post("/safety/events")
async def log_safety_event_route(request: SafetyEventRequest):
    event = await safety.log_safety_event(request.model_dump())
    return {"success": True, "data": event}


@router.get("/safety/health/{account_id}")
async def get_account_health_route(account_id: str):
    health = await safety.get_account_health(account_id)
    return {"success": True, "data": health}


# --- Conversations Routes ---

@router.get("/conversations")
async def get_conversations_route(
    request: Request,
    status: Optional[str] = None,
    hasReply: Optional[str] = None,
    accountId: Optional[str] = None,
    limit: int = Query(50, le=200),
    offset: int = Query(0)
):
    team_id = get_current_team_id(request)
    has_reply_bool = None
    if hasReply == "true":
        has_reply_bool = True
    elif hasReply == "false":
        has_reply_bool = False

    filters = {
        "status": status,
        "hasReply": has_reply_bool,
        "accountId": accountId,
        "limit": limit,
        "offset": offset
    }
    conv_list = await conversations.get_conversations(filters, team_id=team_id)
    return {"success": True, "data": conv_list}


@router.post("/conversations")
async def create_conversation_route(request: Request, body: ConversationCreateRequest):
    team_id = get_current_team_id(request)
    conv = await conversations.create_conversation(body.model_dump(), team_id=team_id)
    return {"success": True, "data": conv}


@router.get("/conversations/stats")
async def get_conversation_stats(request: Request):
    team_id = get_current_team_id(request)
    stats = await conversations.get_conversation_stats(team_id=team_id)
    return {"success": True, "data": stats}


@router.get("/conversations/search")
async def search_conversations_route(request: Request, q: str = ""):
    team_id = get_current_team_id(request)
    results = await conversations.search_conversations(q, team_id=team_id)
    return {"success": True, "data": results}


@router.get("/conversations/{conversation_id}")
async def get_conversation_route(request: Request, conversation_id: str):
    team_id = get_current_team_id(request)
    conv = await conversations.get_conversation(conversation_id, team_id=team_id)
    if not conv:
        raise HTTPException(status_code=404, detail="Conversation not found")
    return {"success": True, "data": conv}


@router.patch("/conversations/{conversation_id}")
async def update_conversation_route(request: Request, conversation_id: str, body: ConversationUpdateRequest):
    team_id = get_current_team_id(request)
    conv = await conversations.update_conversation(conversation_id, body.model_dump(exclude_none=True), team_id=team_id)
    return {"success": True, "data": conv}


@router.post("/conversations/{conversation_id}/messages")
async def add_message_route(request: Request, conversation_id: str, body: MessageAddRequest):
    team_id = get_current_team_id(request)
    message = await conversations.add_message({
        "conversationId": conversation_id,
        **body.model_dump()
    }, team_id=team_id)
    return {"success": True, "data": message}


@router.get("/conversations/{conversation_id}/messages")
async def get_messages_route(request: Request, conversation_id: str, limit: int = Query(100, le=200)):
    team_id = get_current_team_id(request)
    messages = await conversations.get_messages(conversation_id, {"limit": limit}, team_id=team_id)
    return {"success": True, "data": messages}


@router.post("/conversations/sync")
async def sync_conversation_route(request: Request, body: ConversationSyncRequest):
    team_id = get_current_team_id(request)
    conv = await conversations.sync_conversation(body.model_dump(), team_id=team_id)
    return {"success": True, "data": conv}


@router.post("/conversations/{conversation_id}/reply-suggestion")
async def get_reply_suggestion_route(request: Request, conversation_id: str):
    team_id = get_current_team_id(request)
    conv = await conversations.get_conversation(conversation_id, team_id=team_id)
    if not conv:
        raise HTTPException(status_code=404, detail="Conversation not found")

    # Get settings
    settings = await supabase.get_settings(team_id=team_id)

    # Generate reply suggestion using LLM
    suggestion = await llm.generate_reply_suggestion(conv, settings or {})

    return {"success": True, "data": {"suggestion": suggestion}}


# =============================================================================
# USER ANALYSIS ROUTES (Deep Profile Analysis)
# =============================================================================

@router.get("/user-analysis/{username}")
async def analyze_user_route(username: str, forceRefresh: bool = False):
    """Get deep analysis of a Reddit user's profile"""
    profile = await user_analysis.analyze_user(username, force_refresh=forceRefresh)
    return {"success": True, "data": profile}


@router.get("/user-analysis/{username}/optimal-time")
async def get_optimal_send_time_route(username: str):
    """Get optimal time to send a DM to this user"""
    profile = await user_analysis.get_or_analyze(username)

    if profile.get("error"):
        raise HTTPException(status_code=404, detail=profile.get("message", "User not found"))

    optimal_time = profile.get("optimal_send_time", {})
    return {"success": True, "data": optimal_time}


@router.get("/subreddit-culture/{subreddit}")
async def get_subreddit_culture_route(subreddit: str):
    """Get subreddit culture information for tone matching"""
    culture = await user_analysis.get_subreddit_culture(subreddit)
    return {"success": True, "data": culture}


# =============================================================================
# LEAD SCORING ROUTES
# =============================================================================

class LeadScoreRequest(BaseModel):
    post: PostData
    classification: Dict[str, Any]
    qualification: Dict[str, Any]
    userProfile: Optional[Dict[str, Any]] = None


class LeadScoreBatchRequest(BaseModel):
    leads: List[Dict[str, Any]]


@router.post("/lead-score")
async def calculate_lead_score_route(request: LeadScoreRequest):
    """Calculate comprehensive lead score for a post/user"""
    score = await lead_scoring.calculate_lead_score(
        post=request.post.model_dump(),
        classification=request.classification,
        qualification=request.qualification,
        user_profile=request.userProfile
    )
    return {"success": True, "data": score}


@router.post("/lead-score/batch")
async def score_leads_batch_route(request: LeadScoreBatchRequest):
    """Score multiple leads in batch"""
    results = await lead_scoring.score_batch(request.leads)
    return {"success": True, "data": results}


@router.get("/lead-score/stats")
async def get_lead_score_stats_route(days: int = Query(7)):
    """Get lead scoring statistics"""
    stats = await lead_scoring.get_lead_score_stats(days)
    return {"success": True, "data": stats}


# =============================================================================
# INTENT DETECTION ROUTES
# =============================================================================

class IntentDetectRequest(BaseModel):
    message: str
    conversationContext: Optional[str] = ""
    useLlmFallback: Optional[bool] = True


@router.post("/intent/detect")
async def detect_intent_route(request: IntentDetectRequest):
    """Detect intent from a user's reply message"""
    result = await intent_detection.detect_intent(
        message=request.message,
        conversation_context=request.conversationContext or "",
        use_llm_fallback=request.useLlmFallback
    )
    return {"success": True, "data": result}


@router.get("/intent/{intent_name}/template")
async def get_intent_template_route(intent_name: str):
    """Get response template for a specific intent"""
    template = intent_detection.get_response_template(intent_name)
    return {"success": True, "data": template}


class SentimentRequest(BaseModel):
    messages: List[Dict[str, Any]]


@router.post("/intent/sentiment-trajectory")
async def analyze_sentiment_route(request: SentimentRequest):
    """Analyze sentiment trajectory across a conversation"""
    result = intent_detection.analyze_sentiment_trajectory(request.messages)
    return {"success": True, "data": result}


# =============================================================================
# A/B TESTING ROUTES
# =============================================================================

class ExperimentCreateRequest(BaseModel):
    name: str
    variants: List[Dict[str, Any]]
    targetMetric: Optional[str] = "reply_rate"
    minimumSample: Optional[int] = 100
    confidenceLevel: Optional[float] = 0.95
    description: Optional[str] = ""


class OutcomeRecordRequest(BaseModel):
    success: bool
    dmId: Optional[str] = None


@router.get("/experiments")
async def get_experiments_route(status: Optional[str] = "running"):
    """Get all experiments (optionally filter by status)"""
    if status == "running":
        experiments = await ab_testing.get_active_experiments()
    else:
        # Would need to add a get_all_experiments function for other statuses
        experiments = await ab_testing.get_active_experiments()
    return {"success": True, "data": experiments}


@router.post("/experiments")
async def create_experiment_route(request: ExperimentCreateRequest):
    """Create a new A/B test experiment"""
    experiment = await ab_testing.create_experiment(
        name=request.name,
        variants=request.variants,
        target_metric=request.targetMetric,
        minimum_sample=request.minimumSample,
        confidence_level=request.confidenceLevel,
        description=request.description
    )
    return {"success": True, "data": experiment}


@router.get("/experiments/{experiment_id}")
async def get_experiment_route(experiment_id: str):
    """Get experiment details"""
    experiment = await ab_testing.get_experiment(experiment_id)
    if not experiment:
        raise HTTPException(status_code=404, detail="Experiment not found")
    return {"success": True, "data": experiment}


@router.get("/experiments/{experiment_id}/stats")
async def get_experiment_stats_route(experiment_id: str):
    """Get detailed statistics for an experiment"""
    stats = await ab_testing.get_experiment_stats(experiment_id)
    return {"success": True, "data": stats}


@router.post("/experiments/{experiment_id}/select-variant")
async def select_variant_route(experiment_id: str):
    """Select a variant using Thompson Sampling"""
    result = await ab_testing.select_variant(experiment_id)
    if result.get("error"):
        raise HTTPException(status_code=400, detail=result["error"])
    return {"success": True, "data": result}


@router.post("/experiments/{experiment_id}/variants/{variant_id}/outcome")
async def record_outcome_route(
    experiment_id: str,
    variant_id: str,
    request: OutcomeRecordRequest
):
    """Record the outcome of a variant (success/failure)"""
    success = await ab_testing.record_outcome(
        experiment_id=experiment_id,
        variant_id=variant_id,
        success=request.success,
        dm_id=request.dmId
    )
    return {"success": success}


@router.get("/experiments/{experiment_id}/significance")
async def check_significance_route(experiment_id: str):
    """Check statistical significance of an experiment"""
    result = await ab_testing.check_statistical_significance(experiment_id)
    return {"success": True, "data": result}


@router.post("/experiments/{experiment_id}/pause")
async def pause_experiment_route(experiment_id: str):
    """Pause a running experiment"""
    result = await ab_testing.pause_experiment(experiment_id)
    return {"success": True, "data": result}


@router.post("/experiments/{experiment_id}/resume")
async def resume_experiment_route(experiment_id: str):
    """Resume a paused experiment"""
    result = await ab_testing.resume_experiment(experiment_id)
    return {"success": True, "data": result}


@router.post("/experiments/{experiment_id}/promote-winner")
async def promote_winner_route(experiment_id: str):
    """Promote winning variant to a template"""
    result = await ab_testing.promote_winner_to_template(experiment_id)
    if result.get("error"):
        raise HTTPException(status_code=400, detail=result["error"])
    return {"success": True, "data": result}


# =============================================================================
# ANALYTICS ROUTES (Funnel & ROI)
# =============================================================================

class FunnelEventRequest(BaseModel):
    stage: str
    entityType: str
    entityId: str
    accountId: Optional[str] = None
    subreddit: Optional[str] = None
    metadata: Optional[Dict[str, Any]] = None


class ConversionLogRequest(BaseModel):
    conversationId: str
    conversionType: str
    dealValue: Optional[float] = 0
    metadata: Optional[Dict[str, Any]] = None


@router.get("/analytics/funnel")
async def get_funnel_metrics_route(
    startDate: Optional[str] = None,
    endDate: Optional[str] = None,
    accountId: Optional[str] = None,
    subreddit: Optional[str] = None
):
    """Get conversion funnel metrics"""
    from datetime import datetime

    start = datetime.fromisoformat(startDate) if startDate else None
    end = datetime.fromisoformat(endDate) if endDate else None

    metrics = await analytics.get_funnel_metrics(
        start_date=start,
        end_date=end,
        account_id=accountId,
        subreddit=subreddit
    )
    return {"success": True, "data": metrics}


@router.post("/analytics/funnel/event")
async def log_funnel_event_route(request: FunnelEventRequest):
    """Log a funnel event"""
    event = await analytics.log_funnel_event(
        stage=request.stage,
        entity_type=request.entityType,
        entity_id=request.entityId,
        account_id=request.accountId,
        subreddit=request.subreddit,
        metadata=request.metadata
    )
    return {"success": True, "data": event}


@router.get("/analytics/roi")
async def get_roi_metrics_route(
    startDate: Optional[str] = None,
    endDate: Optional[str] = None
):
    """Get ROI metrics"""
    from datetime import datetime

    start = datetime.fromisoformat(startDate) if startDate else None
    end = datetime.fromisoformat(endDate) if endDate else None

    metrics = await analytics.get_roi_metrics(start_date=start, end_date=end)
    return {"success": True, "data": metrics}


@router.post("/analytics/conversion")
async def log_conversion_route(request: ConversionLogRequest):
    """Log a conversion event"""
    conversion = await analytics.log_conversion(
        conversation_id=request.conversationId,
        conversion_type=request.conversionType,
        deal_value=request.dealValue,
        metadata=request.metadata
    )
    return {"success": True, "data": conversion}


@router.get("/analytics/by-subreddit")
async def get_performance_by_subreddit_route(
    startDate: Optional[str] = None,
    endDate: Optional[str] = None,
    limit: int = Query(10)
):
    """Get performance metrics by subreddit"""
    from datetime import datetime

    start = datetime.fromisoformat(startDate) if startDate else None
    end = datetime.fromisoformat(endDate) if endDate else None

    performance = await analytics.get_performance_by_subreddit(
        start_date=start,
        end_date=end,
        limit=limit
    )
    return {"success": True, "data": performance}


@router.get("/analytics/by-day")
async def get_performance_by_day_route(
    startDate: Optional[str] = None,
    endDate: Optional[str] = None
):
    """Get daily performance metrics"""
    from datetime import datetime

    start = datetime.fromisoformat(startDate) if startDate else None
    end = datetime.fromisoformat(endDate) if endDate else None

    performance = await analytics.get_performance_by_day(
        start_date=start,
        end_date=end
    )
    return {"success": True, "data": performance}


@router.get("/analytics/recommendations")
async def get_recommendations_route():
    """Get actionable recommendations based on analytics"""
    recommendations = await analytics.generate_recommendations()
    return {"success": True, "data": recommendations}


@router.get("/analytics/dashboard")
async def get_dashboard_summary_route():
    """Get dashboard summary data"""
    summary = await analytics.get_dashboard_summary()
    return {"success": True, "data": summary}


# =============================================================================
# SAFETY PRE-SEND CHECK ROUTES
# =============================================================================

class PreSendCheckRequest(BaseModel):
    accountId: str
    recipientUsername: str
    message: str
    subreddit: Optional[str] = None


@router.post("/safety/pre-send-check")
async def pre_send_safety_check_route(request: PreSendCheckRequest):
    """Comprehensive pre-send safety check"""
    result = await safety.pre_send_safety_check(
        account_id=request.accountId,
        recipient_username=request.recipientUsername,
        message=request.message,
        subreddit=request.subreddit
    )
    return {"success": True, "data": result}


@router.get("/safety/risk-assessment/{account_id}")
async def get_risk_assessment_route(account_id: str):
    """Get current risk assessment for an account"""
    result = await safety.assess_risk_level(account_id)
    return {"success": True, "data": result}


class DuplicateCheckRequest(BaseModel):
    recipientUsername: str
    excludeAccountId: Optional[str] = None
    lookbackDays: Optional[int] = 30


@router.post("/safety/check-duplicate")
async def check_duplicate_recipient_route(request: DuplicateCheckRequest):
    """Check if recipient was already contacted"""
    result = await safety.check_duplicate_recipient(
        recipient_username=request.recipientUsername,
        exclude_account_id=request.excludeAccountId,
        lookback_days=request.lookbackDays
    )
    return {"success": True, "data": result}


# =============================================================================
# CONVERSATION AI ROUTES (Automated Replies & Follow-ups)
# =============================================================================

@router.get("/conversations/needing-reply")
async def get_conversations_needing_reply_route(
    accountId: Optional[str] = None,
    limit: int = Query(50, le=100)
):
    """Get conversations with unhandled incoming replies"""
    conversations = await conversation_ai.get_conversations_needing_reply(
        account_id=accountId,
        limit=limit
    )
    return {"success": True, "data": conversations}


class AnalyzeReplyRequest(BaseModel):
    conversation: Dict[str, Any]
    settings: Optional[Dict[str, Any]] = None


@router.post("/conversations/analyze-reply")
async def analyze_reply_route(request: AnalyzeReplyRequest):
    """Analyze incoming reply and generate suggested response"""
    result = await conversation_ai.analyze_reply_and_suggest_response(
        conversation=request.conversation,
        settings=request.settings
    )
    return {"success": True, "data": result}


class ProcessRepliesRequest(BaseModel):
    accountId: Optional[str] = None
    autoSend: Optional[bool] = False
    settings: Optional[Dict[str, Any]] = None


@router.post("/conversations/process-pending-replies")
async def process_pending_replies_route(request: ProcessRepliesRequest):
    """Process all pending replies for an account"""
    result = await conversation_ai.process_pending_replies(
        account_id=request.accountId,
        auto_send=request.autoSend,
        settings=request.settings
    )
    return {"success": True, "data": result}


@router.get("/conversations/needing-follow-up")
async def get_conversations_needing_follow_up_route(
    accountId: Optional[str] = None,
    limit: int = Query(50, le=100)
):
    """Get conversations that need follow-up based on timing rules"""
    conversations = await conversation_ai.get_conversations_needing_follow_up(
        account_id=accountId,
        limit=limit
    )
    return {"success": True, "data": conversations}


class GenerateFollowUpRequest(BaseModel):
    conversation: Dict[str, Any]
    settings: Optional[Dict[str, Any]] = None


@router.post("/conversations/generate-follow-up")
async def generate_follow_up_route(request: GenerateFollowUpRequest):
    """Generate a follow-up message for a conversation"""
    result = await conversation_ai.generate_follow_up_for_conversation(
        conversation=request.conversation,
        settings=request.settings
    )
    return {"success": True, "data": result}


class ProcessFollowUpsRequest(BaseModel):
    accountId: Optional[str] = None
    autoQueue: Optional[bool] = False
    settings: Optional[Dict[str, Any]] = None


@router.post("/conversations/process-follow-ups")
async def process_follow_ups_route(request: ProcessFollowUpsRequest):
    """Process all due follow-ups and generate messages"""
    result = await conversation_ai.process_scheduled_follow_ups(
        account_id=request.accountId,
        auto_queue=request.autoQueue,
        settings=request.settings
    )
    return {"success": True, "data": result}


@router.get("/conversations/prioritized")
async def get_prioritized_conversations_route(
    accountId: Optional[str] = None,
    limit: int = Query(20, le=50)
):
    """Get conversations prioritized by urgency and opportunity"""
    conversations = await conversation_ai.get_prioritized_conversations(
        account_id=accountId,
        limit=limit
    )
    return {"success": True, "data": conversations}


@router.get("/conversations/summary")
async def get_conversation_summary_route(accountId: Optional[str] = None):
    """Get summary of conversation statuses and priorities"""
    summary = await conversation_ai.get_conversation_summary(account_id=accountId)
    return {"success": True, "data": summary}


@router.get("/conversations/{conversation_id}/health")
async def get_conversation_health_route(request: Request, conversation_id: str):
    """Get health score for a specific conversation"""
    team_id = get_current_team_id(request)
    # Fetch conversation
    client = supabase.get_client()
    if not client:
        raise HTTPException(status_code=500, detail="Database not configured")

    query = client.table("conversations").select("*").eq("id", conversation_id)
    if team_id:
        query = query.eq("team_id", team_id)
    result = query.single().execute()

    if not result.data:
        raise HTTPException(status_code=404, detail="Conversation not found")

    health = conversation_ai.calculate_conversation_health(result.data)
    return {"success": True, "data": health}


class QueueFollowUpRequest(BaseModel):
    conversationId: str
    message: str
    accountId: str


@router.post("/conversations/queue-follow-up")
async def queue_follow_up_route(request: QueueFollowUpRequest):
    """Queue a follow-up message for sending"""
    success = await conversation_ai.queue_follow_up(
        conversation_id=request.conversationId,
        message=request.message,
        account_id=request.accountId
    )
    return {"success": success}


# =============================================================================
# AUTOMATION SETTINGS ROUTES
# =============================================================================

class AutomationSettingsSaveRequest(BaseModel):
    defaultQueueMode: Optional[str] = None
    minRelevanceScore: Optional[int] = None
    allowWeakMatches: Optional[bool] = None
    minAccountAgeDays: Optional[int] = None
    minKarma: Optional[int] = None
    blockSuspectedBots: Optional[bool] = None
    globalDailyLimit: Optional[int] = None
    delayBetweenDmsMin: Optional[int] = None
    delayBetweenDmsMax: Optional[int] = None
    enableSessionBreaks: Optional[bool] = None
    sessionBreakAfterMin: Optional[int] = None
    sessionBreakAfterMax: Optional[int] = None
    sessionBreakDurationMin: Optional[int] = None
    sessionBreakDurationMax: Optional[int] = None
    typingSpeedMin: Optional[int] = None
    typingSpeedMax: Optional[int] = None
    enableTypoSimulation: Optional[bool] = None


@router.get("/automation-settings")
async def get_automation_settings_route(request: Request):
    """Get automation settings"""
    team_id = get_current_team_id(request)
    settings = await automation_settings.get_automation_settings(team_id=team_id)
    return {"success": True, "data": settings}


@router.post("/automation-settings")
async def save_automation_settings_route(request: Request, body: AutomationSettingsSaveRequest):
    """Save automation settings"""
    team_id = get_current_team_id(request)
    result = await automation_settings.save_automation_settings(body.model_dump(exclude_none=True), team_id=team_id)
    return {"success": True, "data": result}


# =============================================================================
# SKIPPED POSTS ROUTES
# =============================================================================

@router.get("/skipped-posts")
async def get_skipped_posts_route(
    request: Request,
    subreddit: Optional[str] = None,
    skipReason: Optional[str] = None,
    sessionId: Optional[str] = None,
    campaignId: Optional[str] = None,
    limit: int = Query(100, le=200),
    offset: int = Query(0)
):
    """Get skipped posts with optional filtering"""
    team_id = get_current_team_id(request)
    filters = {
        "subreddit": subreddit,
        "skipReason": skipReason,
        "sessionId": sessionId,
        "campaignId": campaignId,
        "limit": limit,
        "offset": offset
    }
    posts = await skipped_posts.get_skipped_posts(filters, team_id=team_id)
    return {"success": True, "data": posts}


@router.post("/skipped-posts")
async def log_skipped_post_route(request: Request):
    """Log a skipped post from the extension"""
    team_id = get_current_team_id(request)
    body = await request.json()
    if not body.get("skipReason"):
        raise HTTPException(status_code=400, detail="skipReason is required")
    if not body.get("postUrl"):
        raise HTTPException(status_code=400, detail="postUrl is required")
    success = await skipped_posts.log_skipped_post(body, team_id=team_id)
    if not success:
        raise HTTPException(status_code=500, detail="Failed to log skipped post")
    return {"success": True}


@router.get("/skipped-posts/stats")
async def get_skip_stats_route(request: Request):
    """Get statistics about skipped posts"""
    team_id = get_current_team_id(request)
    stats = await skipped_posts.get_skip_stats(team_id=team_id)
    return {"success": True, "data": stats}
