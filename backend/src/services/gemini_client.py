"""
LLM API Client
Shared async client for LLM API calls.
Primary: OpenRouter (DeepSeek V3.2). Fallback: Google Gemini.
"""

import os
import logging
import httpx
import json
from typing import Optional
from google import genai
from google.genai import types

logger = logging.getLogger(__name__)

GEMINI_MODEL = "gemini-3-flash-preview"
OPENROUTER_MODEL = "deepseek/deepseek-v3.2"
OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions"

_gemini_client: Optional[genai.Client] = None


def get_gemini_client() -> genai.Client:
    """Get or create Gemini client singleton."""
    global _gemini_client
    if _gemini_client is None:
        api_key = os.getenv("GOOGLE_GEMINI_API_KEY")
        if not api_key:
            raise ValueError("GOOGLE_GEMINI_API_KEY not configured")
        _gemini_client = genai.Client(api_key=api_key)
    return _gemini_client


async def _openrouter_request(
    system_instruction: str,
    user_prompt: str,
    temperature: float = 0.7,
    response_mime_type: Optional[str] = None,
) -> str:
    """Call OpenRouter DeepSeek V3.2 (primary provider)."""
    api_key = os.getenv("OPENROUTER_API_KEY")
    if not api_key:
        raise ValueError("OPENROUTER_API_KEY not configured")

    messages = [
        {"role": "system", "content": system_instruction},
        {"role": "user", "content": user_prompt},
    ]

    body = {
        "model": OPENROUTER_MODEL,
        "messages": messages,
        "temperature": temperature,
    }

    if response_mime_type == "application/json":
        body["response_format"] = {"type": "json_object"}

    async with httpx.AsyncClient(timeout=60) as client:
        resp = await client.post(
            OPENROUTER_URL,
            headers={
                "Authorization": f"Bearer {api_key}",
                "Content-Type": "application/json",
            },
            json=body,
        )
        resp.raise_for_status()
        data = resp.json()

    text = data["choices"][0]["message"]["content"]
    if not text:
        raise ValueError("Empty response from OpenRouter")
    return text.strip()


async def _gemini_request(
    system_instruction: str,
    user_prompt: str,
    model: str = GEMINI_MODEL,
    temperature: float = 0.7,
    max_tokens: Optional[int] = None,
    response_mime_type: Optional[str] = None,
) -> str:
    """Call Gemini API (fallback provider)."""
    client = get_gemini_client()

    config_kwargs = {
        "system_instruction": system_instruction,
        "temperature": temperature,
        "response_mime_type": response_mime_type,
    }
    if max_tokens is not None:
        config_kwargs["max_output_tokens"] = max_tokens

    config = types.GenerateContentConfig(**config_kwargs)

    response = await client.aio.models.generate_content(
        model=model,
        contents=user_prompt,
        config=config,
    )

    if not response.text:
        raise ValueError("Empty response from Gemini API")

    return response.text.strip()


async def generate_content(
    system_instruction: str,
    user_prompt: str,
    model: str = GEMINI_MODEL,
    temperature: float = 0.7,
    max_tokens: Optional[int] = None,
    response_mime_type: Optional[str] = None,
) -> str:
    """
    Generate content via LLM.
    Primary: OpenRouter (DeepSeek V3.2). Fallback: Gemini.

    Args:
        system_instruction: System prompt/instructions
        user_prompt: User message
        model: Gemini model ID (used only if falling back to Gemini)
        temperature: Sampling temperature (0-2)
        max_tokens: Maximum output tokens (None = no limit)
        response_mime_type: Optional MIME type to constrain output (e.g. "application/json")

    Returns:
        Generated text content
    """
    # Try OpenRouter first
    try:
        return await _openrouter_request(
            system_instruction=system_instruction,
            user_prompt=user_prompt,
            temperature=temperature,
            response_mime_type=response_mime_type,
        )
    except Exception as e:
        logger.warning(f"OpenRouter failed, falling back to Gemini: {str(e)[:120]}")

    # Fallback to Gemini
    try:
        return await _gemini_request(
            system_instruction=system_instruction,
            user_prompt=user_prompt,
            model=model,
            temperature=temperature,
            max_tokens=max_tokens,
            response_mime_type=response_mime_type,
        )
    except Exception as fallback_err:
        logger.error(f"Gemini fallback also failed: {fallback_err}")
        raise fallback_err
