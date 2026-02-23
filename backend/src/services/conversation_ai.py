"""
Conversation AI Service
Handles automated conversation replies and smart follow-up scheduling
"""

import os
from datetime import datetime, timedelta
from typing import Dict, Any, List, Optional
from supabase import create_client, Client

from . import llm
from . import intent_detection
from . import user_analysis
import logging

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


# =============================================================================
# CONVERSATION HEALTH SCORING
# =============================================================================

def calculate_conversation_health(conversation: Dict[str, Any]) -> Dict[str, Any]:
    """
    Calculate health score for a conversation (0-100)

    Factors:
    - Has reply: +30
    - Sentiment trend: +25
    - Engagement level: +20
    - Recency: +15
    - Intent signals: +10
    """
    score = 0
    factors = {}

    messages = conversation.get("messages", [])

    # Factor 1: Has reply (+30)
    inbound_messages = [m for m in messages if m.get("direction") == "inbound"]
    has_reply = len(inbound_messages) > 0
    factors["has_reply"] = 30 if has_reply else 0
    score += factors["has_reply"]

    # Factor 2: Sentiment trend (+25)
    if inbound_messages:
        sentiment_result = intent_detection.analyze_sentiment_trajectory(messages)
        trajectory = sentiment_result.get("trajectory", "stable")
        current_sentiment = sentiment_result.get("current_sentiment", "neutral")

        if trajectory == "improving" and current_sentiment == "positive":
            factors["sentiment"] = 25
        elif current_sentiment == "positive":
            factors["sentiment"] = 20
        elif trajectory == "improving":
            factors["sentiment"] = 15
        elif current_sentiment == "neutral":
            factors["sentiment"] = 10
        elif trajectory == "declining":
            factors["sentiment"] = 0
        else:
            factors["sentiment"] = 5
    else:
        factors["sentiment"] = 10  # Neutral if no replies
    score += factors["sentiment"]

    # Factor 3: Engagement level (+20)
    reply_count = len(inbound_messages)
    if reply_count >= 5:
        factors["engagement"] = 20
    elif reply_count >= 3:
        factors["engagement"] = 15
    elif reply_count >= 1:
        factors["engagement"] = 10
    else:
        factors["engagement"] = 0
    score += factors["engagement"]

    # Factor 4: Recency (+15)
    last_activity = conversation.get("last_activity_at") or conversation.get("updated_at")
    if last_activity:
        try:
            if isinstance(last_activity, str):
                last_activity = datetime.fromisoformat(last_activity.replace("Z", "+00:00"))
            hours_since = (datetime.utcnow().replace(tzinfo=last_activity.tzinfo) - last_activity).total_seconds() / 3600

            if hours_since <= 24:
                factors["recency"] = 15
            elif hours_since <= 72:
                factors["recency"] = 10
            elif hours_since <= 168:  # 1 week
                factors["recency"] = 5
            else:
                factors["recency"] = 0
        except:
            factors["recency"] = 5
    else:
        factors["recency"] = 5
    score += factors["recency"]

    # Factor 5: Intent signals (+10)
    if inbound_messages:
        last_inbound = inbound_messages[-1].get("content", "")
        rule_intent = intent_detection.detect_intent_rule_based(last_inbound)

        if rule_intent:
            intent = rule_intent.get("intent", "")
            if intent in ["interested", "requesting_demo", "meeting_request"]:
                factors["intent"] = 10
            elif intent in ["question", "positive_feedback", "pricing_inquiry"]:
                factors["intent"] = 7
            elif intent in ["request_for_time"]:
                factors["intent"] = 5
            elif intent in ["objection"]:
                factors["intent"] = 2
            elif intent in ["spam_report"]:
                factors["intent"] = 0
            else:
                factors["intent"] = 3
        else:
            factors["intent"] = 3
    else:
        factors["intent"] = 0
    score += factors["intent"]

    # Determine status
    if score >= 70:
        status = "hot"
    elif score >= 45:
        status = "warm"
    elif score >= 25:
        status = "cool"
    else:
        status = "cold"

    return {
        "score": score,
        "status": status,
        "factors": factors,
        "calculated_at": datetime.utcnow().isoformat()
    }


# =============================================================================
# AUTOMATED REPLY HANDLING
# =============================================================================

async def get_conversations_needing_reply(
    account_id: str = None,
    limit: int = 50
) -> List[Dict[str, Any]]:
    """
    Get conversations that have unhandled incoming replies

    Criteria:
    - Has at least one inbound message
    - Last message is inbound (they replied, we haven't responded)
    - Not marked as closed/spam/blocked
    """
    client = get_client()
    if not client:
        return []

    try:
        query = client.table("conversations").select(
            "id, participant_username, status, messages, last_activity_at, account_id, original_post"
        ).in_(
            "status", ["active", "replied", "interested"]
        ).order("last_activity_at", desc=True).limit(limit)

        if account_id:
            query = query.eq("account_id", account_id)

        result = query.execute()

        if not result.data:
            return []

        # Filter to those where last message is inbound
        needing_reply = []
        for conv in result.data:
            messages = conv.get("messages", [])
            if messages:
                last_msg = messages[-1]
                if last_msg.get("direction") == "inbound":
                    needing_reply.append(conv)

        return needing_reply
    except Exception as e:
        logger.error(f"Error getting conversations needing reply: {e}")
        return []


async def analyze_reply_and_suggest_response(
    conversation: Dict[str, Any],
    settings: Dict[str, Any] = None
) -> Dict[str, Any]:
    """
    Analyze incoming reply and generate suggested response

    Returns:
        Analysis with intent, suggested response, and recommended action
    """
    settings = settings or {}
    messages = conversation.get("messages", [])

    if not messages:
        return {"error": "No messages in conversation"}

    # Get last inbound message
    inbound_messages = [m for m in messages if m.get("direction") == "inbound"]
    if not inbound_messages:
        return {"error": "No inbound messages to analyze"}

    last_reply = inbound_messages[-1]
    reply_content = last_reply.get("content", "")

    # Build conversation context for intent detection
    conversation_context = "\n".join([
        f"{'You' if m.get('direction') == 'outbound' else 'Them'}: {m.get('content', '')}"
        for m in messages[:-1]  # Exclude last message
    ])

    # Detect intent
    intent_result = await intent_detection.detect_intent(
        message=reply_content,
        conversation_context=conversation_context,
        use_llm_fallback=True
    )

    # Check for immediate stop intents
    if intent_result.get("intent") == "spam_report":
        return {
            "intent": intent_result,
            "recommended_action": "stop_immediately",
            "auto_reply_enabled": False,
            "suggested_response": "Really sorry about that - won't message again. Apologies for the bother.",
            "should_close_conversation": True,
            "close_reason": "spam_reported"
        }

    # Get response template for this intent
    template = intent_detection.get_response_template(intent_result.get("intent", "unknown"))

    # Generate personalized response using LLM
    suggested_response = await llm.generate_reply_suggestion(conversation, settings)

    # Calculate conversation health
    health = calculate_conversation_health(conversation)

    # Determine recommended action based on intent
    intent = intent_result.get("intent", "unknown")

    if intent in ["interested", "requesting_demo", "meeting_request"]:
        recommended_action = "reply_promptly"
        priority = "high"
    elif intent in ["positive_feedback", "question"]:
        recommended_action = "reply_soon"
        priority = "medium"
    elif intent in ["pricing_inquiry"]:
        recommended_action = "reply_with_value"
        priority = "medium"
    elif intent in ["request_for_time"]:
        recommended_action = "schedule_follow_up"
        priority = "low"
    elif intent in ["objection"]:
        recommended_action = "handle_gracefully"
        priority = "medium"
    else:
        recommended_action = "review_and_reply"
        priority = "medium"

    return {
        "conversation_id": conversation.get("id"),
        "participant": conversation.get("participant_username"),
        "last_reply": reply_content,
        "intent": intent_result,
        "template_guidance": template,
        "suggested_response": suggested_response,
        "recommended_action": recommended_action,
        "priority": priority,
        "conversation_health": health,
        "auto_reply_eligible": intent not in ["spam_report", "objection"] and health.get("score", 0) >= 40
    }


async def process_pending_replies(
    account_id: str = None,
    auto_send: bool = False,
    settings: Dict[str, Any] = None
) -> Dict[str, Any]:
    """
    Process all pending replies for an account

    Args:
        account_id: Filter to specific account
        auto_send: Whether to auto-send approved replies
        settings: User settings

    Returns:
        Processing results
    """
    conversations = await get_conversations_needing_reply(account_id)

    if not conversations:
        return {
            "processed": 0,
            "results": [],
            "message": "No conversations needing reply"
        }

    results = []

    for conv in conversations:
        try:
            analysis = await analyze_reply_and_suggest_response(conv, settings)

            # Handle spam reports immediately
            if analysis.get("should_close_conversation"):
                await close_conversation(
                    conv.get("id"),
                    reason=analysis.get("close_reason", "closed")
                )
                results.append({
                    "conversation_id": conv.get("id"),
                    "action": "closed",
                    "reason": analysis.get("close_reason")
                })
                continue

            # Queue reply if auto-send is enabled and eligible
            if auto_send and analysis.get("auto_reply_eligible"):
                # In real implementation, this would queue the reply for sending
                results.append({
                    "conversation_id": conv.get("id"),
                    "action": "queued_for_send",
                    "suggested_response": analysis.get("suggested_response"),
                    "intent": analysis.get("intent", {}).get("intent")
                })
            else:
                results.append({
                    "conversation_id": conv.get("id"),
                    "action": "pending_review",
                    "analysis": analysis
                })
        except Exception as e:
            results.append({
                "conversation_id": conv.get("id"),
                "action": "error",
                "error": str(e)
            })

    return {
        "processed": len(conversations),
        "results": results,
        "auto_sent": len([r for r in results if r.get("action") == "queued_for_send"]),
        "pending_review": len([r for r in results if r.get("action") == "pending_review"])
    }


async def close_conversation(conversation_id: str, reason: str = "closed") -> bool:
    """Close a conversation with given reason"""
    client = get_client()
    if not client:
        return False

    try:
        client.table("conversations").update({
            "status": reason,
            "closed_at": datetime.utcnow().isoformat(),
            "updated_at": datetime.utcnow().isoformat()
        }).eq("id", conversation_id).execute()
        return True
    except Exception as e:
        logger.error(f"Error closing conversation: {e}")
        return False


# =============================================================================
# SMART FOLLOW-UP SCHEDULING
# =============================================================================

# Follow-up timing rules by scenario
FOLLOW_UP_RULES = {
    "no_reply": {
        "intervals_hours": [48, 120, 240],  # 2 days, 5 days, 10 days
        "max_follow_ups": 3
    },
    "interested": {
        "intervals_hours": [24, 72, 168],  # 1 day, 3 days, 7 days
        "max_follow_ups": 4
    },
    "request_for_time": {
        "intervals_hours": [168, 336],  # 7 days, 14 days
        "max_follow_ups": 2
    },
    "question_unanswered": {
        "intervals_hours": [72, 168],  # 3 days, 7 days
        "max_follow_ups": 2
    },
    "meeting_scheduled": {
        "intervals_hours": [24],  # 1 day before/after
        "max_follow_ups": 1
    }
}


async def get_conversations_needing_follow_up(
    account_id: str = None,
    limit: int = 50
) -> List[Dict[str, Any]]:
    """
    Get conversations that need follow-up based on timing rules
    """
    client = get_client()
    if not client:
        return []

    try:
        # Get conversations where we sent last message and haven't gotten a reply
        query = client.table("conversations").select(
            "id, participant_username, status, messages, last_activity_at, account_id, follow_up_count, last_follow_up_at, original_post"
        ).in_(
            "status", ["active", "no_reply", "pending"]
        ).order("last_activity_at", desc=False).limit(limit)

        if account_id:
            query = query.eq("account_id", account_id)

        result = query.execute()

        if not result.data:
            return []

        # Filter to those where last message is outbound and follow-up is due
        needing_follow_up = []
        now = datetime.utcnow()

        for conv in result.data:
            messages = conv.get("messages", [])
            if not messages:
                continue

            last_msg = messages[-1]

            # Only consider if we sent the last message (waiting for reply)
            if last_msg.get("direction") != "outbound":
                continue

            # Calculate time since last message
            last_activity = conv.get("last_activity_at")
            if not last_activity:
                continue

            try:
                if isinstance(last_activity, str):
                    last_activity = datetime.fromisoformat(last_activity.replace("Z", "+00:00"))
                hours_since = (now.replace(tzinfo=last_activity.tzinfo) - last_activity).total_seconds() / 3600
            except:
                continue

            # Determine follow-up scenario
            follow_up_count = conv.get("follow_up_count", 0)
            status = conv.get("status", "active")

            # Get applicable rules
            if status == "interested":
                rules = FOLLOW_UP_RULES["interested"]
            elif status == "request_for_time":
                rules = FOLLOW_UP_RULES["request_for_time"]
            else:
                rules = FOLLOW_UP_RULES["no_reply"]

            # Check if max follow-ups reached
            if follow_up_count >= rules["max_follow_ups"]:
                continue

            # Check if follow-up is due
            intervals = rules["intervals_hours"]
            if follow_up_count < len(intervals):
                required_hours = intervals[follow_up_count]
                if hours_since >= required_hours:
                    needing_follow_up.append({
                        **conv,
                        "hours_since_last": round(hours_since, 1),
                        "follow_up_number": follow_up_count + 1,
                        "scenario": status if status in FOLLOW_UP_RULES else "no_reply"
                    })

        return needing_follow_up
    except Exception as e:
        logger.error(f"Error getting follow-up conversations: {e}")
        return []


async def generate_follow_up_for_conversation(
    conversation: Dict[str, Any],
    settings: Dict[str, Any] = None
) -> Dict[str, Any]:
    """
    Generate a follow-up message for a conversation
    """
    settings = settings or {}

    # Calculate days since last message
    hours_since = conversation.get("hours_since_last", 48)
    days_since = round(hours_since / 24, 1)
    follow_up_number = conversation.get("follow_up_number", 1)

    # Get user profile for personalization
    participant = conversation.get("participant_username", "")
    user_profile = None

    try:
        if participant:
            user_profile = await user_analysis.get_or_analyze(participant)
    except:
        pass

    # Generate follow-up message
    follow_up_message = await llm.generate_follow_up(
        conversation=conversation,
        days_since_last_message=days_since,
        settings=settings
    )

    # Calculate optimal send time if user profile available
    optimal_time = None
    if user_profile and not user_profile.get("error"):
        optimal_time = user_profile.get("optimal_send_time")

    return {
        "conversation_id": conversation.get("id"),
        "participant": participant,
        "follow_up_number": follow_up_number,
        "days_since_last_message": days_since,
        "generated_message": follow_up_message,
        "optimal_send_time": optimal_time,
        "scenario": conversation.get("scenario", "no_reply")
    }


async def process_scheduled_follow_ups(
    account_id: str = None,
    auto_queue: bool = False,
    settings: Dict[str, Any] = None
) -> Dict[str, Any]:
    """
    Process all due follow-ups and generate messages

    Args:
        account_id: Filter to specific account
        auto_queue: Whether to automatically queue follow-ups for sending
        settings: User settings

    Returns:
        Processing results
    """
    conversations = await get_conversations_needing_follow_up(account_id)

    if not conversations:
        return {
            "processed": 0,
            "follow_ups": [],
            "message": "No follow-ups due"
        }

    follow_ups = []

    for conv in conversations:
        try:
            follow_up = await generate_follow_up_for_conversation(conv, settings)

            if auto_queue:
                # Queue the follow-up for sending
                queued = await queue_follow_up(
                    conversation_id=conv.get("id"),
                    message=follow_up.get("generated_message"),
                    account_id=conv.get("account_id")
                )
                follow_up["queued"] = queued

            follow_ups.append(follow_up)
        except Exception as e:
            follow_ups.append({
                "conversation_id": conv.get("id"),
                "error": str(e)
            })

    return {
        "processed": len(conversations),
        "follow_ups": follow_ups,
        "auto_queued": len([f for f in follow_ups if f.get("queued")])
    }


async def queue_follow_up(
    conversation_id: str,
    message: str,
    account_id: str
) -> bool:
    """Queue a follow-up message for sending"""
    client = get_client()
    if not client:
        return False

    try:
        # Get conversation details
        result = client.table("conversations").select(
            "participant_username, original_post"
        ).eq("id", conversation_id).single().execute()

        if not result.data:
            return False

        conv = result.data

        # Add to DM queue as follow-up
        client.table("dm_queue").insert({
            "account_id": account_id,
            "recipient_username": conv.get("participant_username"),
            "conversation_id": conversation_id,
            "generated_message": message,
            "message_type": "follow_up",
            "status": "pending_review",
            "created_at": datetime.utcnow().isoformat()
        }).execute()

        # Update conversation follow-up count
        client.table("conversations").update({
            "last_follow_up_at": datetime.utcnow().isoformat(),
            "follow_up_count": client.rpc("increment_follow_up_count", {"conv_id": conversation_id})
        }).eq("id", conversation_id).execute()

        return True
    except Exception as e:
        logger.error(f"Error queuing follow-up: {e}")
        return False


# =============================================================================
# CONVERSATION PRIORITIZATION
# =============================================================================

async def get_prioritized_conversations(
    account_id: str = None,
    limit: int = 20
) -> List[Dict[str, Any]]:
    """
    Get conversations prioritized by urgency and opportunity

    Priority factors:
    1. Hot conversations (recent positive engagement)
    2. Conversations needing reply (inbound message waiting)
    3. Follow-ups due
    4. Warm conversations
    """
    client = get_client()
    if not client:
        return []

    try:
        query = client.table("conversations").select(
            "id, participant_username, status, messages, last_activity_at, account_id, follow_up_count, original_post"
        ).in_(
            "status", ["active", "replied", "interested", "no_reply", "pending"]
        ).order("last_activity_at", desc=True).limit(100)

        if account_id:
            query = query.eq("account_id", account_id)

        result = query.execute()

        if not result.data:
            return []

        # Calculate priority for each conversation
        prioritized = []

        for conv in result.data:
            health = calculate_conversation_health(conv)
            messages = conv.get("messages", [])

            # Determine if needs reply
            needs_reply = False
            if messages:
                last_msg = messages[-1]
                needs_reply = last_msg.get("direction") == "inbound"

            # Calculate priority score
            priority_score = health.get("score", 0)

            # Boost for needing reply
            if needs_reply:
                priority_score += 30

            # Boost for hot status
            if health.get("status") == "hot":
                priority_score += 20

            # Detect urgent intents
            if needs_reply and messages:
                last_inbound = [m for m in messages if m.get("direction") == "inbound"][-1]
                intent = intent_detection.detect_intent_rule_based(last_inbound.get("content", ""))
                if intent and intent.get("intent") in ["interested", "requesting_demo", "meeting_request"]:
                    priority_score += 25

            prioritized.append({
                **conv,
                "health": health,
                "needs_reply": needs_reply,
                "priority_score": priority_score
            })

        # Sort by priority score
        prioritized.sort(key=lambda x: x.get("priority_score", 0), reverse=True)

        return prioritized[:limit]
    except Exception as e:
        logger.error(f"Error getting prioritized conversations: {e}")
        return []


async def get_conversation_summary(account_id: str = None) -> Dict[str, Any]:
    """Get summary of conversation statuses and priorities"""
    client = get_client()
    if not client:
        return {"error": "No database connection"}

    try:
        query = client.table("conversations").select(
            "id, status, messages, last_activity_at"
        )

        if account_id:
            query = query.eq("account_id", account_id)

        result = query.execute()

        if not result.data:
            return {
                "total": 0,
                "by_status": {},
                "needing_reply": 0,
                "follow_ups_due": 0
            }

        conversations = result.data

        # Count by status
        by_status = {}
        needing_reply = 0
        hot_count = 0

        for conv in conversations:
            status = conv.get("status", "unknown")
            by_status[status] = by_status.get(status, 0) + 1

            messages = conv.get("messages", [])
            if messages and messages[-1].get("direction") == "inbound":
                needing_reply += 1

            health = calculate_conversation_health(conv)
            if health.get("status") == "hot":
                hot_count += 1

        # Get follow-ups due
        follow_ups = await get_conversations_needing_follow_up(account_id)

        return {
            "total": len(conversations),
            "by_status": by_status,
            "needing_reply": needing_reply,
            "follow_ups_due": len(follow_ups),
            "hot_conversations": hot_count
        }
    except Exception as e:
        logger.error(f"Error getting conversation summary: {e}")
        return {"error": str(e)}
