"""
Gemini API Client
Shared async client for Google Gemini API calls.
Falls back to OpenRouter (DeepSeek V3.2) when Gemini is unavailable.
"""

import os
import asyncio
import logging
import httpx
import json
from typing import Optional
from google import genai
from google.genai import types

logger = logging.getLogger(__name__)

DEFAULT_MODEL = "gemini-3-flash-preview"
OPENROUTER_MODEL = "deepseek/deepseek-v3.2"
OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions"
MAX_RETRIES = 3

_client: Optional[genai.Client] = None


def get_gemini_client() -> genai.Client:
    """Get or create Gemini client singleton."""
    global _client
    if _client is None:
        api_key = os.getenv("GOOGLE_GEMINI_API_KEY")
        if not api_key:
            raise ValueError("GOOGLE_GEMINI_API_KEY not configured")
        _client = genai.Client(api_key=api_key)
    return _client


async def _openrouter_fallback(
    system_instruction: str,
    user_prompt: str,
    temperature: float = 0.7,
    response_mime_type: Optional[str] = None,
) -> str:
    """Call OpenRouter DeepSeek V3.2 as fallback when Gemini is down."""
    api_key = os.getenv("OPENROUTER_API_KEY")
    if not api_key:
        raise ValueError("OPENROUTER_API_KEY not configured — cannot fall back from Gemini")

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
        raise ValueError("Empty response from OpenRouter fallback")
    return text.strip()


async def generate_content(
    system_instruction: str,
    user_prompt: str,
    model: str = DEFAULT_MODEL,
    temperature: float = 0.7,
    max_tokens: Optional[int] = None,
    response_mime_type: Optional[str] = None,
) -> str:
    """
    Generate content using Gemini async API.
    Retries on transient errors. Falls back to OpenRouter if Gemini is unavailable.

    Args:
        system_instruction: System prompt/instructions
        user_prompt: User message
        model: Gemini model ID
        temperature: Sampling temperature (0-2)
        max_tokens: Maximum output tokens (None = no limit)
        response_mime_type: Optional MIME type to constrain output (e.g. "application/json")

    Returns:
        Generated text content
    """
    client = get_gemini_client()

    config_kwargs = {
        "system_instruction": system_instruction,
        "temperature": temperature,
        "response_mime_type": response_mime_type,
    }
    if max_tokens is not None:
        config_kwargs["max_output_tokens"] = max_tokens

    config = types.GenerateContentConfig(**config_kwargs)

    last_error = None
    for attempt in range(1, MAX_RETRIES + 1):
        try:
            response = await client.aio.models.generate_content(
                model=model,
                contents=user_prompt,
                config=config,
            )

            if not response.text:
                raise ValueError("Empty response from Gemini API")

            return response.text.strip()

        except Exception as e:
            last_error = e
            err_str = str(e)
            is_retryable = (
                "429" in err_str or "RESOURCE_EXHAUSTED" in err_str
                or "503" in err_str or "UNAVAILABLE" in err_str
            )
            if is_retryable and attempt < MAX_RETRIES:
                delay = 8 * attempt  # 8s, 16s
                logger.warning(f"Gemini error (attempt {attempt}), retrying in {delay}s: {err_str[:120]}")
                await asyncio.sleep(delay)
            else:
                break

    # All Gemini retries failed — try OpenRouter fallback
    logger.warning(f"Gemini failed after {MAX_RETRIES} attempts, falling back to OpenRouter: {last_error}")
    try:
        return await _openrouter_fallback(
            system_instruction=system_instruction,
            user_prompt=user_prompt,
            temperature=temperature,
            response_mime_type=response_mime_type,
        )
    except Exception as fallback_err:
        logger.error(f"OpenRouter fallback also failed: {fallback_err}")
        raise last_error
