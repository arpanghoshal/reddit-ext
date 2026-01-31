"""
LLM Service
Handles interactions with OpenRouter API for message generation
"""

import os
from typing import Dict, Any, List, Optional
import httpx

# Import user analysis for personalization
from . import user_analysis

OPENROUTER_API_URL = "https://openrouter.ai/api/v1/chat/completions"
DEFAULT_MODEL = "deepseek/deepseek-v3.2"


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

    model = settings.get("model") or DEFAULT_MODEL
    print(f"[DEBUG] Using model: {model}")

    # Fetch user profile for deep personalization
    user_profile = None
    personalization_context = {}
    subreddit_culture = {}

    try:
        author = post.get("author", "")
        if author and author != "[deleted]":
            user_profile = await user_analysis.get_or_analyze(author)
            if user_profile and not user_profile.get("error"):
                personalization_context = user_profile.get("personalization_context", {})
                print(f"[DEBUG] User profile loaded for {author}")

        # Get subreddit culture
        subreddit = post.get("subreddit", "")
        if subreddit:
            subreddit_culture = await user_analysis.get_subreddit_culture(subreddit)
    except Exception as e:
        print(f"[DEBUG] Could not load user profile: {e}")

    # Build enhanced system prompt with personalization
    personalization_section = ""
    if personalization_context:
        sections = []
        if personalization_context.get("interest_summary"):
            sections.append(f"- {personalization_context['interest_summary']}")
        if personalization_context.get("pain_summary"):
            sections.append(f"- {personalization_context['pain_summary']}")
        if personalization_context.get("professional_context"):
            sections.append(f"- {personalization_context['professional_context']}")
        if personalization_context.get("style_guidance"):
            sections.append(f"- Style: {personalization_context['style_guidance']}")
        if personalization_context.get("length_guidance"):
            sections.append(f"- Length: {personalization_context['length_guidance']}")

        if sections:
            personalization_section = f"""
USER PROFILE INSIGHTS:
{chr(10).join(sections)}
"""

    subreddit_section = ""
    if subreddit_culture:
        subreddit_section = f"""
SUBREDDIT CULTURE (r/{post.get('subreddit', 'unknown')}):
- Typical Tone: {subreddit_culture.get('typical_tone', 'friendly')}
- Greeting Style: {', '.join(subreddit_culture.get('greeting_examples', ['Hey', 'Hi']))}
- Avoid: {', '.join(subreddit_culture.get('taboo_topics', []))}
- Culture: {subreddit_culture.get('culture_notes', '')}
"""

    system_prompt = f"""You are a helpful assistant for a founder/marketer crafting highly personalized outreach.
Your goal is to generate a single, natural, open-ended DM that feels like it's from someone who genuinely understands the user's situation.

BUSINESS CONTEXT:
Business: {settings.get('businessDesc', 'Not specified')}
Target Persona: {settings.get('persona', 'General')}
Insight Goal: {', '.join(settings.get('insightTypes', [])) or 'General insights'}
Tone: {settings.get('tone', 'Curious')}
{personalization_section}{subreddit_section}
RULES:
1. NO selling, pitching, or promoting.
2. NO links or product mentions.
3. Must feel like a personal, human message from someone who "gets it".
4. Keep it short (1-2 sentences max).
5. Focus on their specific situation, not generic questions.
6. If user profile insights are available, subtly reference relevant details.
7. Match the subreddit culture and user's communication style.
8. Start with an appropriate greeting based on subreddit culture.
9. Output ONLY the message text, no quotes or explanations."""

    user_prompt = f"""Post Title: {post.get('title', 'No title')}
Post Body: {post.get('body', 'No body')}
Subreddit: r/{post.get('subreddit', 'Unknown')}
Author: u/{post.get('author', 'unknown')}

Generate a personalized DM:"""

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
            print(f"[DEBUG] OpenRouter error response: {error_data}")
            raise ValueError(error_data.get("error", {}).get("message", "Failed to generate question"))

        data = response.json()

        if not data.get("choices") or not data["choices"][0].get("message"):
            print(f"Unexpected API response structure: {data}")
            raise ValueError("Invalid API response format")

        return data["choices"][0]["message"]["content"].strip()


def get_available_models() -> List[Dict[str, str]]:
    """Get list of available LLM models"""
    return [
        {"id": "deepseek/deepseek-v3.2", "name": "DeepSeek V3"},
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

    # Fetch user profile for context
    participant_username = conversation.get("participantUsername", "")
    user_profile = None
    personalization_context = {}

    try:
        if participant_username:
            user_profile = await user_analysis.get_or_analyze(participant_username)
            if user_profile and not user_profile.get("error"):
                personalization_context = user_profile.get("personalization_context", {})
    except Exception as e:
        print(f"[DEBUG] Could not load user profile for reply: {e}")

    # Format conversation history
    messages = conversation.get("messages", [])
    conversation_context = "\n".join([
        f"{'You' if m.get('direction') == 'outbound' else 'Them'}: {m.get('content', '')}"
        for m in messages
    ])

    # Build personalization section
    personalization_section = ""
    if personalization_context:
        sections = []
        if personalization_context.get("interest_summary"):
            sections.append(f"- {personalization_context['interest_summary']}")
        if personalization_context.get("style_guidance"):
            sections.append(f"- Communication style: {personalization_context['style_guidance']}")
        if personalization_context.get("length_guidance"):
            sections.append(f"- {personalization_context['length_guidance']}")

        if sections:
            personalization_section = f"""
USER PROFILE:
{chr(10).join(sections)}
"""

    system_prompt = f"""You are helping craft a follow-up reply in an ongoing Reddit DM conversation.

CONTEXT:
Business: {settings.get('businessDesc') or settings.get('business_desc', 'Not specified')}
Goal: Gather insights, build relationship
Conversation Status: {conversation.get('status', 'active')}
{personalization_section}
RULES:
1. Keep the conversation natural and human
2. Don't be pushy or salesy
3. Match the tone of the conversation AND the user's communication style
4. If they seem interested, gently move toward next steps
5. If they seem cold, be gracious and leave door open
6. Keep reply concise - match their message length
7. Reference their interests or context naturally if relevant
8. Output ONLY the reply text, no quotes or explanations"""

    user_prompt = f"""Conversation so far:
{conversation_context}

Generate a contextual follow-up reply:"""

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

    # Get user profile for optimal timing and personalization
    user_profile = None
    personalization_hint = ""

    try:
        if participant_username and participant_username != "there":
            user_profile = await user_analysis.get_or_analyze(participant_username)
            if user_profile and not user_profile.get("error"):
                # Get a relevant interest to potentially reference
                interests = user_profile.get("interests", [])
                if interests:
                    top_interest = interests[0].get("topic", "")
                    if top_interest:
                        personalization_hint = f"\nNote: User is active in {top_interest} - you could reference this naturally"
    except Exception as e:
        print(f"[DEBUG] Could not load user profile for follow-up: {e}")

    system_prompt = f"""You are helping craft a gentle follow-up message for someone who hasn't replied to a previous DM.

CONTEXT:
Days since last message: {days_since_last_message}
Their username: u/{participant_username}
Conversation status: {conversation.get('status', 'no reply')}{personalization_hint}

RULES:
1. Be friendly and not pushy
2. Acknowledge they might be busy
3. Give them an easy out if not interested
4. Keep it very short (1-2 sentences)
5. Don't guilt them or be passive-aggressive
6. If referencing their interests, do so naturally and briefly
7. Output ONLY the message text"""

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
