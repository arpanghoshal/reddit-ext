"""
LLM Service
Handles interactions with OpenRouter API for message generation
"""

import os
from typing import Dict, Any, List, Optional
import httpx

OPENROUTER_API_URL = "https://openrouter.ai/api/v1/chat/completions"
DEFAULT_MODEL = "tngtech/deepseek-r1t2-chimera:free"


async def generate_question(input_data: Dict[str, Any]) -> str:
    """
    Generate a DM question based on a Reddit post

    Args:
        input_data: Dict containing 'post' and 'settings'

    Returns:
        Generated message string
    """
    post = input_data.get("post", {})
    settings = input_data.get("settings", {})

    api_key = os.getenv("OPENROUTER_API_KEY")
    if not api_key:
        raise ValueError("OpenRouter API key not configured")

    model = settings.get("model", DEFAULT_MODEL)

    system_prompt = f"""You are a helpful assistant for a founder/marketer.
Your goal is to generate a single, natural, open-ended DM question with an introduction like hey or hi to a Reddit user based on their post.

CONTEXT:
Business: {settings.get('businessDesc', 'Not specified')}
Target Persona: {settings.get('persona', 'General')}
Insight Goal: {', '.join(settings.get('insightTypes', [])) or 'General insights'}
Tone: {settings.get('tone', 'Curious')}

RULES:
1. NO selling, pitching, or promoting.
2. NO links or product mentions.
3. Must feel like a personal, human message.
4. Keep it short (1-2 sentences).
5. Focus on the user's problem/situation.
6. The output should be ONLY the message text, no quotes or explanations."""

    user_prompt = f"""Post Title: {post.get('title', 'No title')}
Post Body: {post.get('body', 'No body')}
Subreddit: {post.get('subreddit', 'Unknown')}

Generate a DM question:"""

    async with httpx.AsyncClient() as client:
        response = await client.post(
            OPENROUTER_API_URL,
            headers={
                "Authorization": f"Bearer {api_key}",
                "Content-Type": "application/json",
                "HTTP-Referer": "https://github.com/reddit-insight-gatherer",
                "X-Title": "Reddit Insight Gatherer"
            },
            json={
                "model": model,
                "messages": [
                    {"role": "system", "content": system_prompt},
                    {"role": "user", "content": user_prompt}
                ]
            },
            timeout=60.0
        )

        if response.status_code != 200:
            error_data = response.json()
            raise ValueError(error_data.get("error", {}).get("message", "Failed to generate question"))

        data = response.json()

        if not data.get("choices") or not data["choices"][0].get("message"):
            print(f"Unexpected API response structure: {data}")
            raise ValueError("Invalid API response format")

        return data["choices"][0]["message"]["content"].strip()


def get_available_models() -> List[Dict[str, str]]:
    """Get list of available LLM models"""
    return [
        {"id": "tngtech/deepseek-r1t2-chimera:free", "name": "DeepSeek R1T2 Chimera (Free)"},
        {"id": "google/gemma-2-9b-it:free", "name": "Gemma 2 9B (Free)"},
        {"id": "meta-llama/llama-3.1-8b-instruct:free", "name": "Llama 3.1 8B (Free)"},
        {"id": "anthropic/claude-3-haiku", "name": "Claude 3 Haiku"},
        {"id": "openai/gpt-4o-mini", "name": "GPT-4o Mini"}
    ]


async def generate_reply_suggestion(conversation: Dict[str, Any], settings: Dict[str, Any] = None) -> str:
    """
    Generate a reply suggestion for an ongoing conversation

    Args:
        conversation: Conversation object with messages
        settings: User settings

    Returns:
        Generated reply suggestion
    """
    settings = settings or {}
    api_key = os.getenv("OPENROUTER_API_KEY")
    if not api_key:
        raise ValueError("OpenRouter API key not configured")

    model = settings.get("model", DEFAULT_MODEL)

    # Format conversation history
    messages = conversation.get("messages", [])
    conversation_context = "\n".join([
        f"{'You' if m.get('direction') == 'outbound' else 'Them'}: {m.get('content', '')}"
        for m in messages
    ])

    system_prompt = f"""You are helping craft a follow-up reply in an ongoing Reddit DM conversation.

CONTEXT:
Business: {settings.get('businessDesc') or settings.get('business_desc', 'Not specified')}
Goal: Gather insights, build relationship
Conversation Status: {conversation.get('status', 'active')}

RULES:
1. Keep the conversation natural and human
2. Don't be pushy or salesy
3. Match the tone of the conversation
4. If they seem interested, gently move toward next steps
5. If they seem cold, be gracious and leave door open
6. Keep reply concise (1-3 sentences)
7. Output ONLY the reply text, no quotes or explanations"""

    user_prompt = f"""Conversation so far:
{conversation_context}

Generate a follow-up reply:"""

    async with httpx.AsyncClient() as client:
        response = await client.post(
            OPENROUTER_API_URL,
            headers={
                "Authorization": f"Bearer {api_key}",
                "Content-Type": "application/json",
                "HTTP-Referer": "https://github.com/reddit-insight-gatherer",
                "X-Title": "Reddit Insight Gatherer"
            },
            json={
                "model": model,
                "messages": [
                    {"role": "system", "content": system_prompt},
                    {"role": "user", "content": user_prompt}
                ],
                "temperature": 0.7,
                "max_tokens": 200
            },
            timeout=60.0
        )

        if response.status_code != 200:
            error_data = response.json()
            raise ValueError(error_data.get("error", {}).get("message", "Failed to generate reply suggestion"))

        data = response.json()

        if not data.get("choices") or not data["choices"][0].get("message"):
            raise ValueError("Invalid API response format")

        return data["choices"][0]["message"]["content"].strip()


async def generate_follow_up(
    conversation: Dict[str, Any],
    days_since_last_message: int = 3,
    settings: Dict[str, Any] = None
) -> str:
    """
    Generate a follow-up message for a cold conversation

    Args:
        conversation: Conversation object
        days_since_last_message: Days since last message
        settings: User settings

    Returns:
        Generated follow-up message
    """
    settings = settings or {}
    api_key = os.getenv("OPENROUTER_API_KEY")
    if not api_key:
        raise ValueError("OpenRouter API key not configured")

    model = settings.get("model", DEFAULT_MODEL)
    participant_username = conversation.get("participantUsername", "there")

    system_prompt = f"""You are helping craft a gentle follow-up message for someone who hasn't replied to a previous DM.

CONTEXT:
Days since last message: {days_since_last_message}
Their username: u/{participant_username}
Conversation status: {conversation.get('status', 'no reply')}

RULES:
1. Be friendly and not pushy
2. Acknowledge they might be busy
3. Give them an easy out if not interested
4. Keep it very short (1-2 sentences)
5. Don't guilt them or be passive-aggressive
6. Output ONLY the message text"""

    user_prompt = "Generate a gentle follow-up message:"

    async with httpx.AsyncClient() as client:
        response = await client.post(
            OPENROUTER_API_URL,
            headers={
                "Authorization": f"Bearer {api_key}",
                "Content-Type": "application/json",
                "HTTP-Referer": "https://github.com/reddit-insight-gatherer",
                "X-Title": "Reddit Insight Gatherer"
            },
            json={
                "model": model,
                "messages": [
                    {"role": "system", "content": system_prompt},
                    {"role": "user", "content": user_prompt}
                ],
                "temperature": 0.7,
                "max_tokens": 150
            },
            timeout=60.0
        )

        if response.status_code != 200:
            error_data = response.json()
            raise ValueError(error_data.get("error", {}).get("message", "Failed to generate follow-up"))

        data = response.json()

        if not data.get("choices") or not data["choices"][0].get("message"):
            raise ValueError("Invalid API response format")

        return data["choices"][0]["message"]["content"].strip()
