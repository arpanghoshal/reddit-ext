"""
LLM Service
Handles interactions with OpenRouter API for message generation
"""

import os
from typing import Dict, Any, List, Optional
import httpx

# Import user analysis for personalization
from . import user_analysis
from . import reddit_comments

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

    # Fetch post comments for richer context
    comments_text = ""
    try:
        comments_text = await reddit_comments.get_post_comments_text(post.get("url", ""))
    except Exception as e:
        print(f"[DEBUG] Could not fetch post comments: {e}")

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

    system_prompt = f"""You're writing a casual Reddit DM as a real person reaching out genuinely.

CONTEXT:
Business: {settings.get('businessDesc', 'Not specified')}
Looking for: {settings.get('persona', 'General')}
Want to learn about: {', '.join(settings.get('insightTypes', [])) or 'their experience'}
Vibe: {settings.get('tone', 'Curious')}
{personalization_section}{subreddit_section}
WRITE LIKE A HUMAN:
- Use contractions (you're, I'm, don't, it's, that's)
- Lowercase is fine for casual openers (hey, yo, hi there)
- Skip the formalities - no "I hope this message finds you well"
- Write how you'd actually text a friend about something interesting
- One thought, naturally expressed. Not a checklist of points
- It's ok to trail off or use "..." or "haha" or "lol" if it fits
- DON'T start with "I" - mix it up (saw your post, your post about X, that thing you mentioned)
- Sound curious, not like you're conducting an interview

AVOID THESE AI TELLS:
- "I came across your post" (robotic)
- "I'd love to hear your thoughts" (too formal)
- "Would you be open to..." (salesy)
- "I noticed that..." (sounds scripted)
- Perfect grammar and punctuation (real people are messier)
- Starting every sentence the same way

GOOD EXAMPLES:
- "yo saw your post about X - been dealing with the same thing. how'd you end up handling it?"
- "that thing you mentioned about X is so real. did you ever figure out a good solution?"
- "your post hit home lol. been stuck on the same problem - mind if i ask what you tried?"

BAD EXAMPLES (don't do these):
- "I noticed your post about X. I would love to learn more about your experience."
- "Hi! I saw your post and found it very interesting. Could you share more details?"

HARD RULES:
- NO selling, pitching, links, or product mentions
- Keep it short - 1-2 sentences max
- Output ONLY the message, nothing else"""

    comments_section = f"\n{comments_text}\n" if comments_text else ""
    user_prompt = f"""Their post in r/{post.get('subreddit', 'Unknown')}:
"{post.get('title', 'No title')}"

{post.get('body', '') or '(no body text)'}
{comments_section}
Author: u/{post.get('author', 'unknown')}

Write a quick DM to them:"""

    async with httpx.AsyncClient() as client:
        response = await client.post(
            OPENROUTER_API_URL,
            headers={
                "Authorization": f"Bearer {api_key}",
                "Content-Type": "application/json",
                "HTTP-Referer": "https://github.com/reddit-automated-dm",
                "X-Title": "Reddit Automated DM"
            },
            json={
                "model": model,
                "messages": [
                    {"role": "system", "content": system_prompt},
                    {"role": "user", "content": user_prompt}
                ],
                "temperature": 0.85,  # Higher temp for more human-like variation
                "max_tokens": 150
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

    system_prompt = f"""You're continuing a Reddit DM conversation as a real person, not a bot.

CONTEXT:
Business: {settings.get('businessDesc') or settings.get('business_desc', 'Not specified')}
Vibe: casual chat, learning from them
Status: {conversation.get('status', 'active')}
{personalization_section}
WRITE LIKE A HUMAN:
- Mirror their energy - if they're chill, be chill. if they're detailed, match it
- Use contractions naturally (that's, I'm, you're, don't)
- React genuinely to what they said before asking more
- It's ok to say "oh interesting" or "haha yeah" or "oh nice"
- Don't interrogate - have a conversation
- Match their message length roughly

HOW REAL CONVOS FLOW:
- Acknowledge what they said → share a quick thought → maybe ask something
- "oh that makes sense - yeah I've been wondering about that too. did X work out?"
- "haha fair enough. so what ended up happening with Y?"
- NOT: "Thank you for sharing. That is very helpful. Could you elaborate on..."

AVOID AI TELLS:
- "Thank you for sharing" (robotic)
- "That's really insightful" (sycophantic)
- "I appreciate you taking the time" (too formal)
- "Would you mind elaborating" (interview mode)
- Perfect punctuation and capitalization

READ THE ROOM:
- They seem interested → keep it flowing naturally, maybe suggest next step casually
- They seem lukewarm → back off a bit, keep it light
- They seem cold → be gracious, no pressure, leave door open

Output ONLY the reply, nothing else"""

    user_prompt = f"""The convo so far:
{conversation_context}

Your reply:"""

    async with httpx.AsyncClient() as client:
        response = await client.post(
            OPENROUTER_API_URL,
            headers={
                "Authorization": f"Bearer {api_key}",
                "Content-Type": "application/json",
                "HTTP-Referer": "https://github.com/reddit-automated-dm",
                "X-Title": "Reddit Automated DM"
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

    system_prompt = f"""You're sending a casual follow-up to someone who didn't reply. Be a real person, not a robot.

CONTEXT:
It's been {days_since_last_message} days since you messaged
Their username: u/{participant_username}
Status: {conversation.get('status', 'no reply')}{personalization_hint}

HUMAN FOLLOW-UPS SOUND LIKE:
- "hey just bumping this in case it got buried - no worries if you're busy tho"
- "figured I'd check back - totally get it if you're not interested btw"
- "hey! sorry to bug you again, just curious if you had thoughts on this"
- Keep it super short - one casual sentence

DON'T SOUND LIKE A BOT:
- "I wanted to follow up on my previous message" (corporate)
- "I hope this finds you well" (email template)
- "Just circling back" (LinkedIn vibes)
- "I understand you must be busy" (passive aggressive)
- "At your earliest convenience" (formal)

THE VIBE:
- You're a real person who sent a message and is casually checking in
- Zero guilt, zero pressure
- Give them an easy out
- If they're not into it, that's totally fine

AVOID:
- Being apologetic (one "sorry to bug" max)
- Multiple sentences
- Questions that demand answers
- Anything that sounds automated

Output ONLY the message, nothing else"""

    user_prompt = "Write a quick follow-up:"

    async with httpx.AsyncClient() as client:
        response = await client.post(
            OPENROUTER_API_URL,
            headers={
                "Authorization": f"Bearer {api_key}",
                "Content-Type": "application/json",
                "HTTP-Referer": "https://github.com/reddit-automated-dm",
                "X-Title": "Reddit Automated DM"
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
