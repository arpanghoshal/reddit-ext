"""
Intent Detection Service
Detect user intent from reply messages for intelligent conversation handling
"""

import os
import re
from typing import Dict, Any, List, Optional
import httpx

OPENROUTER_API_URL = "https://openrouter.ai/api/v1/chat/completions"
DEFAULT_MODEL = "deepseek/deepseek-v3.2"

# Intent definitions with patterns and next actions
INTENT_DEFINITIONS = {
    "interested": {
        "description": "User shows interest in learning more",
        "patterns": [
            r"tell me more",
            r"sounds interesting",
            r"i('d| would) (like|love) to",
            r"how does (it|that|this) work",
            r"what (is|are) the",
            r"can you (explain|share)",
            r"i'm curious",
            r"that's (cool|interesting|great)",
            r"yeah,? (sure|definitely)"
        ],
        "sentiment": "positive",
        "next_action": "provide_value",
        "priority": 1
    },
    "requesting_demo": {
        "description": "User wants to see the product/service",
        "patterns": [
            r"can i (see|try)",
            r"show me",
            r"(free )?demo",
            r"(free )?trial",
            r"test it out",
            r"sign up",
            r"get started",
            r"how (do i|can i) (try|start|use)"
        ],
        "sentiment": "positive",
        "next_action": "schedule_demo",
        "priority": 1
    },
    "pricing_inquiry": {
        "description": "User asking about pricing or cost",
        "patterns": [
            r"how much",
            r"pric(e|ing)",
            r"cost",
            r"(is it|are you) free",
            r"paid",
            r"subscription",
            r"money",
            r"budget",
            r"afford"
        ],
        "sentiment": "neutral",
        "next_action": "share_pricing",
        "priority": 2
    },
    "question": {
        "description": "User asking a question",
        "patterns": [
            r"\?$",
            r"^(what|who|where|when|why|how|is|are|can|could|would|do|does)",
            r"wondering (if|about|whether)",
            r"curious (about|if)"
        ],
        "sentiment": "neutral",
        "next_action": "answer_question",
        "priority": 2
    },
    "objection": {
        "description": "User expressing concern or objection",
        "patterns": [
            r"not (sure|interested|looking)",
            r"no thanks",
            r"already (have|use|using)",
            r"too (expensive|complicated|busy)",
            r"don't (need|think|have)",
            r"doesn't (seem|sound|fit)",
            r"not (for me|right now)",
            r"maybe later"
        ],
        "sentiment": "negative",
        "next_action": "handle_objection",
        "priority": 3
    },
    "spam_report": {
        "description": "User indicating message is unwanted",
        "patterns": [
            r"spam",
            r"stop (messaging|contacting)",
            r"reported",
            r"block(ed)?",
            r"leave me alone",
            r"unsubscribe",
            r"don't (message|contact) me"
        ],
        "sentiment": "negative",
        "next_action": "immediate_stop",
        "priority": 0  # Highest priority - stop immediately
    },
    "positive_feedback": {
        "description": "User expressing positive sentiment",
        "patterns": [
            r"(that's|this is) (great|awesome|helpful|useful)",
            r"thank(s| you)",
            r"appreciate",
            r"love (it|this|that)",
            r"perfect",
            r"exactly what"
        ],
        "sentiment": "positive",
        "next_action": "continue_conversation",
        "priority": 2
    },
    "request_for_time": {
        "description": "User needs time to consider",
        "patterns": [
            r"let me (think|consider)",
            r"i('ll| will) (get back|think)",
            r"give me (some )?time",
            r"need to (check|ask|discuss)",
            r"talk to (my|the) (team|boss|partner)",
            r"not (right )?now",
            r"busy (right )?now"
        ],
        "sentiment": "neutral",
        "next_action": "schedule_followup",
        "priority": 2
    },
    "meeting_request": {
        "description": "User wants to schedule a meeting/call",
        "patterns": [
            r"(schedule|book) a (call|meeting|chat)",
            r"let's (talk|chat|meet|hop on)",
            r"set up a (call|meeting|time)",
            r"(free|available) (for|to)",
            r"when (are you|can we)",
            r"calendar"
        ],
        "sentiment": "positive",
        "next_action": "schedule_meeting",
        "priority": 1
    }
}


def detect_intent_rule_based(message: str) -> Optional[Dict[str, Any]]:
    """
    Detect intent using rule-based pattern matching

    Args:
        message: User's reply message

    Returns:
        Intent result if match found, None otherwise
    """
    message_lower = message.lower().strip()

    # Check patterns for each intent
    matches = []

    for intent_name, config in INTENT_DEFINITIONS.items():
        for pattern in config["patterns"]:
            if re.search(pattern, message_lower, re.IGNORECASE):
                matches.append({
                    "intent": intent_name,
                    "confidence": 0.8,
                    "matched_pattern": pattern,
                    "sentiment": config["sentiment"],
                    "next_action": config["next_action"],
                    "priority": config["priority"],
                    "method": "rule_based"
                })
                break

    if not matches:
        return None

    # Return highest priority match (lowest priority number)
    matches.sort(key=lambda x: x["priority"])
    return matches[0]


async def detect_intent_llm(message: str, conversation_context: str = "") -> Dict[str, Any]:
    """
    Detect intent using LLM for nuanced cases

    Args:
        message: User's reply message
        conversation_context: Previous conversation for context

    Returns:
        Intent detection result
    """
    api_key = os.getenv("OPENROUTER_API_KEY")
    if not api_key:
        return {
            "intent": "unknown",
            "confidence": 0,
            "error": "No API key configured"
        }

    intent_list = "\n".join([
        f"- {name}: {config['description']}"
        for name, config in INTENT_DEFINITIONS.items()
    ])

    system_prompt = f"""You are an intent classifier for sales/marketing conversations.
Analyze the user's message and classify their intent.

POSSIBLE INTENTS:
{intent_list}
- unknown: Cannot determine intent

RESPOND WITH ONLY JSON in this format:
{{"intent": "intent_name", "confidence": 0.0-1.0, "sentiment": "positive/neutral/negative", "reasoning": "brief explanation"}}"""

    user_prompt = f"""Message to classify: "{message}"

Previous context (if any): {conversation_context if conversation_context else "No prior context"}

Classify the intent:"""

    try:
        async with httpx.AsyncClient() as client:
            response = await client.post(
                OPENROUTER_API_URL,
                headers={
                    "Authorization": f"Bearer {api_key}",
                    "Content-Type": "application/json"
                },
                json={
                    "model": DEFAULT_MODEL,
                    "messages": [
                        {"role": "system", "content": system_prompt},
                        {"role": "user", "content": user_prompt}
                    ],
                    "temperature": 0.3,
                    "max_tokens": 200
                },
                timeout=30.0
            )

            if response.status_code != 200:
                return {
                    "intent": "unknown",
                    "confidence": 0,
                    "error": f"API error: {response.status_code}"
                }

            data = response.json()
            content = data["choices"][0]["message"]["content"].strip()

            # Parse JSON response
            import json

            # Handle markdown code blocks
            if "```json" in content:
                content = content.split("```json")[1].split("```")[0].strip()
            elif "```" in content:
                content = content.split("```")[1].split("```")[0].strip()

            result = json.loads(content)

            # Add next action from definitions
            intent_name = result.get("intent", "unknown")
            if intent_name in INTENT_DEFINITIONS:
                result["next_action"] = INTENT_DEFINITIONS[intent_name]["next_action"]
                result["priority"] = INTENT_DEFINITIONS[intent_name]["priority"]
            else:
                result["next_action"] = "manual_review"
                result["priority"] = 99

            result["method"] = "llm"
            return result

    except Exception as e:
        print(f"Error in LLM intent detection: {e}")
        return {
            "intent": "unknown",
            "confidence": 0,
            "error": str(e)
        }


async def detect_intent(
    message: str,
    conversation_context: str = "",
    use_llm_fallback: bool = True
) -> Dict[str, Any]:
    """
    Detect intent using hybrid approach (rules first, LLM fallback)

    Args:
        message: User's reply message
        conversation_context: Previous conversation for context
        use_llm_fallback: Whether to use LLM for unclear cases

    Returns:
        Intent detection result
    """
    # Try rule-based detection first
    rule_result = detect_intent_rule_based(message)

    if rule_result and rule_result["confidence"] >= 0.8:
        return rule_result

    # Use LLM for nuanced cases
    if use_llm_fallback:
        llm_result = await detect_intent_llm(message, conversation_context)

        # If rule-based had a match but lower confidence, compare
        if rule_result:
            if llm_result.get("confidence", 0) > rule_result["confidence"]:
                return llm_result
            return rule_result

        return llm_result

    # Return rule result or unknown
    return rule_result or {
        "intent": "unknown",
        "confidence": 0,
        "sentiment": "neutral",
        "next_action": "manual_review",
        "method": "none"
    }


def get_response_template(intent: str) -> Dict[str, Any]:
    """
    Get suggested response template based on detected intent

    Args:
        intent: Detected intent name

    Returns:
        Response template and guidance
    """
    templates = {
        "interested": {
            "tone": "enthusiastic but not pushy",
            "structure": "Acknowledge interest → Provide value → Ask follow-up question",
            "example": "Great to hear! Here's how [feature] can help with [their situation]. What's been your biggest challenge with [topic]?",
            "tips": ["Share specific benefit relevant to their situation", "Keep it conversational"]
        },
        "requesting_demo": {
            "tone": "helpful and accommodating",
            "structure": "Confirm availability → Provide options → Make it easy",
            "example": "Would love to show you! I can share a quick demo link or hop on a 15-min call - whatever works better for you?",
            "tips": ["Make it low commitment", "Offer multiple options"]
        },
        "pricing_inquiry": {
            "tone": "transparent and value-focused",
            "structure": "Acknowledge question → Frame value → Share pricing",
            "example": "Happy to share! Before I do, curious what you're looking to solve - that'll help me point you to the right plan.",
            "tips": ["Lead with value, not just numbers", "Understand their needs first"]
        },
        "question": {
            "tone": "helpful and informative",
            "structure": "Answer clearly → Add context → Invite follow-up",
            "example": "[Clear answer]. Does that help? Happy to dive deeper if needed.",
            "tips": ["Be direct and clear", "Don't over-explain"]
        },
        "objection": {
            "tone": "understanding and non-defensive",
            "structure": "Acknowledge → Address concern → Leave door open",
            "example": "Totally understand! If anything changes or you want to chat later, just ping me.",
            "tips": ["Don't argue or be pushy", "Respect their decision"]
        },
        "spam_report": {
            "tone": "apologetic and immediate",
            "structure": "Apologize → Confirm no more messages",
            "example": "Really sorry about that - won't message again. Apologies for the bother.",
            "tips": ["STOP immediately", "Add to blacklist", "Log for review"]
        },
        "positive_feedback": {
            "tone": "appreciative and forward-moving",
            "structure": "Thank them → Build on momentum",
            "example": "Glad it's helpful! [Continue conversation naturally]",
            "tips": ["Keep momentum", "Move toward goal naturally"]
        },
        "request_for_time": {
            "tone": "patient and accommodating",
            "structure": "Respect their timeline → Offer to follow up",
            "example": "No rush at all! Want me to check back in next week, or ping me whenever you're ready?",
            "tips": ["Don't be pushy", "Make follow-up easy"]
        },
        "meeting_request": {
            "tone": "enthusiastic and efficient",
            "structure": "Confirm eagerness → Provide scheduling option",
            "example": "Would love that! Here's my calendar link [link] - grab any time that works for you.",
            "tips": ["Strike while iron is hot", "Remove friction"]
        }
    }

    return templates.get(intent, {
        "tone": "helpful and professional",
        "structure": "Acknowledge → Respond appropriately",
        "example": "[Contextual response based on their message]",
        "tips": ["Read carefully", "Respond appropriately"]
    })


def analyze_sentiment_trajectory(messages: List[Dict[str, Any]]) -> Dict[str, Any]:
    """
    Analyze sentiment trajectory across a conversation

    Args:
        messages: List of conversation messages

    Returns:
        Sentiment analysis with trajectory
    """
    sentiment_scores = []

    for msg in messages:
        if msg.get("direction") == "inbound":
            content = msg.get("content", "").lower()

            # Simple sentiment scoring
            positive_words = ["great", "thanks", "helpful", "love", "awesome", "perfect", "yes", "sure", "definitely"]
            negative_words = ["no", "don't", "not", "spam", "stop", "busy", "later", "can't"]

            pos_count = sum(1 for word in positive_words if word in content)
            neg_count = sum(1 for word in negative_words if word in content)

            if pos_count > neg_count:
                sentiment_scores.append(1)
            elif neg_count > pos_count:
                sentiment_scores.append(-1)
            else:
                sentiment_scores.append(0)

    if not sentiment_scores:
        return {
            "current_sentiment": "neutral",
            "trajectory": "stable",
            "scores": [],
            "trend_score": 0
        }

    # Calculate trajectory
    current = sentiment_scores[-1] if sentiment_scores else 0

    if len(sentiment_scores) >= 2:
        recent_avg = sum(sentiment_scores[-2:]) / 2
        earlier_avg = sum(sentiment_scores[:-2]) / max(len(sentiment_scores) - 2, 1) if len(sentiment_scores) > 2 else 0

        if recent_avg > earlier_avg + 0.3:
            trajectory = "improving"
        elif recent_avg < earlier_avg - 0.3:
            trajectory = "declining"
        else:
            trajectory = "stable"
    else:
        trajectory = "stable"

    current_sentiment = "positive" if current > 0 else "negative" if current < 0 else "neutral"

    return {
        "current_sentiment": current_sentiment,
        "trajectory": trajectory,
        "scores": sentiment_scores,
        "trend_score": sum(sentiment_scores) / max(len(sentiment_scores), 1)
    }
