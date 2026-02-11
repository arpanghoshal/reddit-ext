"""
LLM Service
Handles interactions with Google Gemini API for message generation
"""

import json
import logging
from typing import Dict, Any, List, Optional

from . import gemini_client
from . import user_analysis
from . import reddit_comments

logger = logging.getLogger(__name__)


def _clean_message(text: str) -> str:
    """Remove em dashes, en dashes, and other unwanted characters from generated messages."""
    text = text.replace("\u2014", "-")  # em dash
    text = text.replace("\u2013", "-")  # en dash
    return text


def _parse_message_response(raw: str) -> Dict[str, str]:
    """Parse LLM response that should contain message + reasoning JSON."""
    raw = raw.strip()

    # Try JSON parse first
    try:
        if "```json" in raw:
            raw = raw.split("```json")[1].split("```")[0].strip()
        elif "```" in raw:
            raw = raw.split("```")[1].split("```")[0].strip()

        parsed = json.loads(raw)
        return {
            "message": _clean_message(parsed.get("message", "").strip()),
            "reasoning": parsed.get("reasoning", "").strip(),
        }
    except (json.JSONDecodeError, IndexError):
        pass

    # Fallback: treat entire output as the message
    return {"message": _clean_message(raw), "reasoning": ""}


async def generate_question(input_data: Dict[str, Any]) -> Dict[str, str]:
    """
    Generate a DM question based on a Reddit post.

    Args:
        input_data: Dict containing 'post' and 'settings'

    Returns:
        Dict with 'message' and 'reasoning' keys
    """
    post = input_data.get("post", {})
    settings = input_data.get("settings", {})

    # Fetch user profile for deep personalization
    personalization_context = {}
    subreddit_culture = {}

    try:
        author = post.get("author", "")
        if author and author != "[deleted]":
            user_profile = await user_analysis.get_or_analyze(author)
            if user_profile and not user_profile.get("error"):
                personalization_context = user_profile.get("personalization_context", {})
                logger.debug(f"User profile loaded for {author}")

        # Get subreddit culture
        subreddit = post.get("subreddit", "")
        if subreddit:
            subreddit_culture = await user_analysis.get_subreddit_culture(subreddit)
    except Exception as e:
        logger.debug(f"Could not load user profile: {e}")

    # Fetch post comments for richer context
    comments_text = ""
    try:
        comments_text = await reddit_comments.get_post_comments_text(post.get("url", ""))
    except Exception as e:
        logger.debug(f"Could not fetch post comments: {e}")

    # Build rich personalization section
    personalization_section = ""
    if personalization_context:
        sections = []
        if personalization_context.get("interest_summary"):
            sections.append(f"- Interests: {personalization_context['interest_summary']}")
        if personalization_context.get("pain_summary"):
            sections.append(f"- Pain points: {personalization_context['pain_summary']}")
        if personalization_context.get("professional_context"):
            sections.append(f"- Professional context: {personalization_context['professional_context']}")
        if personalization_context.get("style_guidance"):
            sections.append(f"- How they write: {personalization_context['style_guidance']}")
        if personalization_context.get("length_guidance"):
            sections.append(f"- Message length preference: {personalization_context['length_guidance']}")

        if sections:
            personalization_section = f"""
WHO THIS PERSON IS (from their Reddit activity):
{chr(10).join(sections)}
Use these insights to connect with them on their level. Reference their world, not yours.
"""

    subreddit_section = ""
    if subreddit_culture:
        subreddit_section = f"""
r/{post.get('subreddit', 'unknown')} CULTURE:
- People here talk like: {subreddit_culture.get('typical_tone', 'friendly')}
- Common openers: {', '.join(subreddit_culture.get('greeting_examples', ['Hey', 'Hi']))}
- Never mention: {', '.join(subreddit_culture.get('taboo_topics', []))}
- Vibe: {subreddit_culture.get('culture_notes', '')}
Match this community's energy. Don't stick out as an outsider.
"""

    business_context_section = ""
    business_context = settings.get("businessContext") or ""
    if business_context:
        business_context_section = f"""
YOUR CONTEXT (use this to inform your angle, but NEVER pitch or sell):
{business_context}
"""

    tone = settings.get("tone", "Curious")
    tone_instructions = _get_tone_instructions(tone)

    system_prompt = f"""You are a real person on Reddit writing a DM to someone whose post caught your eye.

YOUR GOAL: Start a genuine conversation. You want to understand their experience. You have real context about who they are - USE IT to make this feel personal, not generic.

BUSINESS BACKGROUND (shapes your perspective, but NEVER mention it directly):
- What you do: {settings.get('businessDesc', 'Not specified')}
- Who you're looking to connect with: {settings.get('persona', 'General')}
- What you want to learn: {', '.join(settings.get('insightTypes', [])) or 'their experience'}
{business_context_section}{personalization_section}{subreddit_section}
TONE: {tone}
{tone_instructions}

DEEP PERSONALIZATION RULES:
- You've read their post AND their profile. Reference something SPECIFIC from their post.
- If you know their interests, weave that in naturally ("saw you're into X too")
- If you know their communication style, mirror it exactly
- If they write long technical posts, you can be slightly more detailed
- If they write short casual comments, keep it ultra brief
- Show you actually understand their situation, don't just reference it superficially

CRITICAL FORMATTING:
- NEVER use em dashes or en dashes. Use regular hyphens (-) only.
- 1-2 sentences max for the message
- NO selling, pitching, links, or product mentions

RESPOND WITH VALID JSON:
{{"message": "your DM message here", "reasoning": "2-3 sentences explaining: what specific context you used from their profile/post, why you chose this angle, and what makes this feel personal vs generic"}}"""

    # Build user prompt with all available context
    comments_section = f"\nTOP COMMENTS ON THEIR POST:\n{comments_text}\n" if comments_text else ""

    source_comment = post.get("source_comment_body") or ""
    comment_source_section = ""
    if source_comment:
        comment_source_section = f"""
THE SPECIFIC COMMENT THAT FLAGGED THEM AS A LEAD:
"{source_comment}"
(This is what they actually said - reference this directly in your message)
"""

    user_prompt = f"""POST in r/{post.get('subreddit', 'Unknown')}:
Title: "{post.get('title', 'No title')}"

Body:
{post.get('body', '') or '(no body text)'}
{comments_section}{comment_source_section}
Author: u/{post.get('author', 'unknown')}

Write a DM to this person. Use everything you know about them. Make it impossible for them to think this is a template."""

    result = await gemini_client.generate_content(
        system_instruction=system_prompt,
        user_prompt=user_prompt,
        temperature=0.85,
    )

    return _parse_message_response(result)


def _get_tone_instructions(tone: str) -> str:
    """Get detailed writing instructions for each tone."""
    tones = {
        "Curious": """HOW TO WRITE (Curious tone):
- Lead with genuine curiosity about THEIR specific situation
- Ask about something specific from their post, not a generic question
- Show you're fascinated by their particular take or experience
- "wait so when you said X, did you mean...?" or "curious how that worked out for you"
- Think: a smart person who read their post and genuinely wants to know more""",

        "Helpful": """HOW TO WRITE (Helpful tone):
- Lead by showing you relate to their problem or situation
- Share a tiny relevant nugget from your own experience (not a pitch)
- Make them feel like you've been where they are
- "been through something similar - what helped me was thinking about X differently"
- Think: a peer who's been in their shoes and casually mentioning something useful""",

        "Casual": """HOW TO WRITE (Casual tone):
- Super laid back. Think texting a friend.
- Use lowercase, abbreviations, "lol", "tbh", "ngl" naturally
- Very short - could be just one line
- "yo that thing about X is so relatable lol. how'd you end up dealing with it?"
- Think: someone who just genuinely vibes with what they posted""",

        "Professional": """HOW TO WRITE (Professional tone):
- Still casual enough for Reddit, but slightly more polished
- Show you understand the professional context of their post
- Reference specific details that show business/industry knowledge
- "your point about X in the context of Y is spot on - been seeing the same thing"
- Think: a knowledgeable peer having a watercooler conversation""",

        "Friendly": """HOW TO WRITE (Friendly tone):
- Warm and approachable, like someone they'd want to grab coffee with
- Lead with validation or shared experience
- Make them feel good about what they shared
- "dude your post about X really resonated - we've been wrestling with the same thing"
- Think: a genuinely nice person who found a kindred spirit""",

        "Direct": """HOW TO WRITE (Direct tone):
- Get straight to the point. No fluff.
- Reference the specific thing that caught your attention
- Ask one clear, direct question
- "saw your post about X. quick q - did Y approach actually work?"
- Think: a busy person who respects their time and gets to the point""",
    }
    return tones.get(tone, tones["Curious"])


def get_available_models() -> List[Dict[str, str]]:
    """Get list of available LLM models"""
    return [
        {"id": "gemini-2.5-flash", "name": "Gemini 2.5 Flash"},
    ]


async def generate_reply_suggestion(conversation: Dict[str, Any], settings: Dict[str, Any] = None) -> str:
    """
    Generate a reply suggestion for an ongoing conversation.

    Args:
        conversation: Conversation object with messages
        settings: User settings

    Returns:
        Generated reply suggestion
    """
    settings = settings or {}

    # Fetch user profile for context
    participant_username = conversation.get("participantUsername", "")
    personalization_context = {}

    try:
        if participant_username:
            user_profile = await user_analysis.get_or_analyze(participant_username)
            if user_profile and not user_profile.get("error"):
                personalization_context = user_profile.get("personalization_context", {})
    except Exception as e:
        logger.debug(f"Could not load user profile for reply: {e}")

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
            sections.append(f"- Their interests: {personalization_context['interest_summary']}")
        if personalization_context.get("style_guidance"):
            sections.append(f"- How they write: {personalization_context['style_guidance']}")
        if personalization_context.get("length_guidance"):
            sections.append(f"- Their message length: {personalization_context['length_guidance']}")
        if personalization_context.get("professional_context"):
            sections.append(f"- Professional context: {personalization_context['professional_context']}")

        if sections:
            personalization_section = f"""
WHO YOU'RE TALKING TO:
{chr(10).join(sections)}
Mirror their style. If they're brief, be brief. If they're detailed, match it.
"""

    business_context_section = ""
    business_context = settings.get("businessContext") or settings.get("business_context", "")
    if business_context:
        business_context_section = f"""
YOUR CONTEXT (informs your replies but never pitch directly):
{business_context}
"""

    tone = settings.get("tone") or settings.get("tone", "Curious")
    tone_instructions = _get_tone_instructions(tone)

    system_prompt = f"""You're in a Reddit DM conversation. You're a real person, not a bot.

BACKGROUND:
Business: {settings.get('businessDesc') or settings.get('business_desc', 'Not specified')}
Conversation status: {conversation.get('status', 'active')}
{business_context_section}{personalization_section}
TONE: {tone}
{tone_instructions}

CONVERSATION RULES:
- Read their last message carefully. React to what they ACTUALLY said.
- Mirror their energy exactly. Chill = chill. Detailed = detailed.
- Use contractions naturally (that's, I'm, you're, don't)
- Acknowledge what they said FIRST, then continue the conversation
- It's ok to say "oh interesting" or "haha yeah" or "oh nice"
- NEVER use em dashes or en dashes - use regular hyphens (-) only

READ THE ROOM:
- Interested/enthusiastic -> keep the momentum, maybe suggest a next step casually
- Lukewarm/short replies -> keep it light, don't push
- Cold/negative -> be gracious, zero pressure, leave the door open

NEVER DO THESE:
- "Thank you for sharing" (robotic)
- "That's really insightful" (sycophantic)
- "I appreciate you taking the time" (too formal)
- "Would you mind elaborating" (interview mode)

Output ONLY the reply message, nothing else."""

    user_prompt = f"""The conversation so far:
{conversation_context}

Write your next reply:"""

    result = await gemini_client.generate_content(
        system_instruction=system_prompt,
        user_prompt=user_prompt,
        temperature=0.7,
    )

    return _clean_message(result)


async def generate_follow_up(
    conversation: Dict[str, Any],
    days_since_last_message: int = 3,
    settings: Dict[str, Any] = None
) -> str:
    """
    Generate a follow-up message for a cold conversation.

    Args:
        conversation: Conversation object
        days_since_last_message: Days since last message
        settings: User settings

    Returns:
        Generated follow-up message
    """
    settings = settings or {}
    participant_username = conversation.get("participantUsername", "there")

    # Get user profile for personalization
    personalization_hint = ""

    try:
        if participant_username and participant_username != "there":
            user_profile = await user_analysis.get_or_analyze(participant_username)
            if user_profile and not user_profile.get("error"):
                interests = user_profile.get("interests", [])
                if interests:
                    top_interest = interests[0].get("topic", "")
                    if top_interest:
                        personalization_hint = f"\nThey're active in: {top_interest} - you could reference this to make the follow-up feel personal"
                style = user_profile.get("personalization_context", {}).get("style_guidance", "")
                if style:
                    personalization_hint += f"\nTheir writing style: {style}"
    except Exception as e:
        logger.debug(f"Could not load user profile for follow-up: {e}")

    business_context_section = ""
    business_context = settings.get("businessContext") or settings.get("business_context", "")
    if business_context:
        business_context_section = f"""
YOUR CONTEXT:
{business_context}
"""

    tone = settings.get("tone") or "Curious"

    system_prompt = f"""You're following up with someone who didn't reply to your Reddit DM. Be a real person.

CONTEXT:
Days since your last message: {days_since_last_message}
Their username: u/{participant_username}
Conversation status: {conversation.get('status', 'no reply')}{personalization_hint}
{business_context_section}
THE VIBE:
- You're a real person casually checking in
- Zero guilt, zero pressure
- Give them an easy out
- If they're not into it, that's totally fine
- One short sentence max
- NEVER use em dashes or en dashes - use regular hyphens (-) only

GOOD FOLLOW-UPS:
- "hey just bumping this in case it got buried - no worries if you're busy tho"
- "figured I'd check back - totally get it if you're not interested btw"
- "hey! sorry to bug you again, just curious if you had thoughts on this"

NEVER DO:
- "I wanted to follow up on my previous message" (corporate)
- "I hope this finds you well" (email template)
- "Just circling back" (LinkedIn vibes)
- "I understand you must be busy" (passive aggressive)
- Multiple sentences
- Questions that demand answers

Output ONLY the message, nothing else."""

    user_prompt = "Write a quick follow-up:"

    result = await gemini_client.generate_content(
        system_instruction=system_prompt,
        user_prompt=user_prompt,
        temperature=0.7,
    )

    return _clean_message(result)
