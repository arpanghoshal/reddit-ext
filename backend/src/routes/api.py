"""
API Routes
All REST API endpoints for the Reddit Insight Backend
"""

import os
from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel
from typing import Dict, Any, List, Optional

from ..services import supabase_service as supabase
from ..services import llm
from ..services import classification
from ..services import qualification
from ..services import queue
from ..services import accounts
from ..services import rotation
from ..services import safety
from ..services import rules
from ..services import conversations

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
    scheduledAt: Optional[str] = None


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


class RuleCreateRequest(BaseModel):
    name: str
    description: Optional[str] = None
    ruleType: str
    value: Dict[str, Any]
    isActive: Optional[bool] = True
    priority: Optional[int] = 0


class RuleUpdateRequest(BaseModel):
    name: Optional[str] = None
    description: Optional[str] = None
    value: Optional[Dict[str, Any]] = None
    isActive: Optional[bool] = None
    priority: Optional[int] = None


class RuleEvaluateRequest(BaseModel):
    post: Dict[str, Any]
    userProfile: Optional[Dict[str, Any]] = None


class RuleTestRequest(BaseModel):
    rule: Dict[str, Any]
    testData: Dict[str, Any]


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
async def log_dm(request: DMLogRequest):
    result = await supabase.log_dm(request.model_dump())
    return {"success": True, "data": result}


@router.get("/dm/history")
async def get_dm_history(limit: int = Query(50)):
    history = await supabase.get_dm_history(limit)
    return {"success": True, "data": history}


@router.get("/dm/subreddits")
async def get_dm_subreddits(limit: int = Query(10)):
    data = await supabase.get_dms_by_subreddit(limit)
    return {"success": True, "data": data}


# --- Automation Session Routes ---

@router.post("/session/start")
async def start_session(request: SessionStartRequest):
    result = await supabase.start_automation_session(request.model_dump())
    return {"success": True, **result}


@router.patch("/session/{session_id}")
async def update_session(session_id: str, request: SessionUpdateRequest):
    result = await supabase.update_automation_session(session_id, request.model_dump(exclude_none=True))
    return {"success": True, "data": result}


@router.get("/session/logs")
async def get_session_logs(limit: int = Query(20)):
    logs = await supabase.get_automation_logs(limit)
    return {"success": True, "data": logs}


# --- Analytics Routes ---

@router.get("/analytics")
async def get_analytics():
    analytics = await supabase.get_analytics()
    return {"success": True, "data": analytics}


# --- Settings Routes ---

@router.get("/settings")
async def get_settings():
    settings = await supabase.get_settings()
    return {"success": True, "data": settings}


@router.post("/settings")
async def save_settings(request: SettingsSaveRequest):
    result = await supabase.save_settings(request.model_dump())
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

    result = await classification.classify_post(post, settings)
    return {"success": True, "data": result}


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
    status: Optional[str] = None,
    accountId: Optional[str] = None,
    subreddit: Optional[str] = None,
    mode: Optional[str] = None,
    limit: int = Query(50),
    offset: int = Query(0)
):
    filters = {
        "status": status,
        "accountId": accountId,
        "subreddit": subreddit,
        "queueMode": mode,
        "limit": limit,
        "offset": offset
    }
    items = await queue.get_queue(filters)
    return {"success": True, "data": items}


@router.post("/queue")
async def add_to_queue_route(request: QueueAddRequest):
    item = await queue.add_to_queue(request.model_dump())
    return {"success": True, "data": item}


@router.get("/queue/stats")
async def get_queue_stats():
    stats = await queue.get_queue_stats()
    return {"success": True, "data": stats}


@router.get("/queue/next")
async def get_next_to_send(accountId: Optional[str] = None):
    item = await queue.get_next_to_send(accountId)
    return {"success": True, "data": item}


@router.get("/queue/{item_id}")
async def get_queue_item_route(item_id: str):
    item = await queue.get_queue_item(item_id)
    if not item:
        raise HTTPException(status_code=404, detail="Queue item not found")
    return {"success": True, "data": item}


@router.patch("/queue/{item_id}")
async def update_queue_item_route(item_id: str, request: QueueUpdateRequest):
    item = await queue.update_queue_item(item_id, request.model_dump(exclude_none=True))
    return {"success": True, "data": item}


@router.delete("/queue/{item_id}")
async def delete_queue_item_route(item_id: str):
    success = await queue.delete_queue_item(item_id)
    return {"success": success}


@router.post("/queue/{item_id}/approve")
async def approve_queue_item_route(item_id: str, approvedBy: Optional[str] = None):
    item = await queue.approve_queue_item(item_id, approvedBy)
    return {"success": True, "data": item}


@router.post("/queue/{item_id}/reject")
async def reject_queue_item_route(item_id: str, reason: Optional[str] = None):
    item = await queue.reject_queue_item(item_id, reason)
    return {"success": True, "data": item}


@router.post("/queue/{item_id}/sent")
async def mark_as_sent_route(item_id: str):
    item = await queue.mark_as_sent(item_id)
    return {"success": True, "data": item}


@router.post("/queue/{item_id}/failed")
async def mark_as_failed_route(item_id: str, reason: str = ""):
    item = await queue.mark_as_failed(item_id, reason)
    return {"success": True, "data": item}


@router.post("/queue/bulk-approve")
async def bulk_approve_route(request: BulkApproveRequest):
    if not request.ids:
        raise HTTPException(status_code=400, detail="IDs array is required")
    result = await queue.bulk_approve(request.ids, request.approvedBy)
    return {"success": True, "data": result}


@router.post("/queue/bulk-reject")
async def bulk_reject_route(request: BulkRejectRequest):
    if not request.ids:
        raise HTTPException(status_code=400, detail="IDs array is required")
    result = await queue.bulk_reject(request.ids, request.reason)
    return {"success": True, "data": result}


# --- Account Routes ---

@router.get("/accounts")
async def get_accounts_route(
    status: Optional[str] = None,
    activeOnly: bool = False
):
    filters = {"status": status, "activeOnly": activeOnly}
    accounts_list = await accounts.get_accounts(filters)
    return {"success": True, "data": accounts_list}


@router.post("/accounts")
async def add_account_route(request: AccountAddRequest):
    account = await accounts.add_account(request.model_dump())
    return {"success": True, "data": account}


@router.get("/accounts/{account_id}")
async def get_account_route(account_id: str):
    account = await accounts.get_account(account_id)
    if not account:
        raise HTTPException(status_code=404, detail="Account not found")
    return {"success": True, "data": account}


@router.patch("/accounts/{account_id}")
async def update_account_route(account_id: str, request: AccountUpdateRequest):
    account = await accounts.update_account(account_id, request.model_dump(exclude_none=True))
    return {"success": True, "data": account}


@router.delete("/accounts/{account_id}")
async def delete_account_route(account_id: str):
    success = await accounts.delete_account(account_id)
    return {"success": success}


@router.get("/accounts/{account_id}/cookies")
async def get_account_cookies_route(account_id: str):
    cookies = await accounts.get_account_cookies(account_id)
    if not cookies:
        raise HTTPException(status_code=404, detail="Cookies not found")
    return {"success": True, "data": cookies}


@router.get("/accounts/{account_id}/can-send")
async def can_account_send_route(account_id: str):
    result = await accounts.can_account_send_dm(account_id)
    return {"success": True, "data": result}


@router.post("/accounts/{account_id}/increment-dm")
async def increment_dm_route(account_id: str):
    account = await accounts.increment_dm_count(account_id)
    return {"success": True, "data": account}


@router.post("/accounts/{account_id}/check-shadowban")
async def check_shadowban_route(account_id: str):
    account = await accounts.get_account(account_id)
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
async def get_account_subreddits_route(account_id: str):
    subreddits = await accounts.get_account_subreddits(account_id)
    return {"success": True, "data": subreddits}


@router.post("/accounts/{account_id}/subreddits")
async def assign_to_subreddit_route(account_id: str, request: SubredditAssignRequest):
    success = await accounts.assign_to_subreddit(account_id, request.subreddit, request.priority)
    return {"success": success}


@router.delete("/accounts/{account_id}/subreddits/{subreddit_name}")
async def remove_from_subreddit_route(account_id: str, subreddit_name: str):
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


# --- Rules Routes ---

@router.get("/rules")
async def get_rules_route(
    activeOnly: bool = False,
    type: Optional[str] = None
):
    filters = {"activeOnly": activeOnly, "ruleType": type}
    rules_list = await rules.get_rules(filters)
    return {"success": True, "data": rules_list}


@router.post("/rules")
async def create_rule_route(request: RuleCreateRequest):
    rule = await rules.create_rule(request.model_dump())
    return {"success": True, "data": rule}


@router.get("/rules/templates")
async def get_rule_templates():
    templates = rules.get_default_rule_templates()
    return {"success": True, "data": templates}


@router.patch("/rules/{rule_id}")
async def update_rule_route(rule_id: str, request: RuleUpdateRequest):
    rule = await rules.update_rule(rule_id, request.model_dump(exclude_none=True))
    return {"success": True, "data": rule}


@router.delete("/rules/{rule_id}")
async def delete_rule_route(rule_id: str):
    success = await rules.delete_rule(rule_id)
    return {"success": success}


@router.post("/rules/evaluate")
async def evaluate_rules_route(request: RuleEvaluateRequest):
    result = await rules.evaluate_rules(request.post, request.userProfile)
    return {"success": True, "data": result}


@router.post("/rules/test")
async def test_rule_route(request: RuleTestRequest):
    result = rules.test_rule(request.rule, request.testData)
    return {"success": True, "data": result}


# --- Conversations Routes ---

@router.get("/conversations")
async def get_conversations_route(
    status: Optional[str] = None,
    hasReply: Optional[str] = None,
    accountId: Optional[str] = None,
    limit: int = Query(50),
    offset: int = Query(0)
):
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
    conv_list = await conversations.get_conversations(filters)
    return {"success": True, "data": conv_list}


@router.post("/conversations")
async def create_conversation_route(request: ConversationCreateRequest):
    conv = await conversations.create_conversation(request.model_dump())
    return {"success": True, "data": conv}


@router.get("/conversations/stats")
async def get_conversation_stats():
    stats = await conversations.get_conversation_stats()
    return {"success": True, "data": stats}


@router.get("/conversations/search")
async def search_conversations_route(q: str = ""):
    results = await conversations.search_conversations(q)
    return {"success": True, "data": results}


@router.get("/conversations/{conversation_id}")
async def get_conversation_route(conversation_id: str):
    conv = await conversations.get_conversation(conversation_id)
    if not conv:
        raise HTTPException(status_code=404, detail="Conversation not found")
    return {"success": True, "data": conv}


@router.patch("/conversations/{conversation_id}")
async def update_conversation_route(conversation_id: str, request: ConversationUpdateRequest):
    conv = await conversations.update_conversation(conversation_id, request.model_dump(exclude_none=True))
    return {"success": True, "data": conv}


@router.post("/conversations/{conversation_id}/messages")
async def add_message_route(conversation_id: str, request: MessageAddRequest):
    message = await conversations.add_message({
        "conversationId": conversation_id,
        **request.model_dump()
    })
    return {"success": True, "data": message}


@router.get("/conversations/{conversation_id}/messages")
async def get_messages_route(conversation_id: str, limit: int = Query(100)):
    messages = await conversations.get_messages(conversation_id, {"limit": limit})
    return {"success": True, "data": messages}


@router.post("/conversations/sync")
async def sync_conversation_route(request: ConversationSyncRequest):
    conv = await conversations.sync_conversation(request.model_dump())
    return {"success": True, "data": conv}


@router.post("/conversations/{conversation_id}/reply-suggestion")
async def get_reply_suggestion_route(conversation_id: str):
    conv = await conversations.get_conversation(conversation_id)
    if not conv:
        raise HTTPException(status_code=404, detail="Conversation not found")

    # Get settings
    settings = await supabase.get_settings()

    # Generate reply suggestion using LLM
    suggestion = await llm.generate_reply_suggestion(conv, settings or {})

    return {"success": True, "data": {"suggestion": suggestion}}
