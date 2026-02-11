"""
Gemini API Client
Shared async client for Google Gemini API calls
"""

import os
import logging
from typing import Optional
from google import genai
from google.genai import types

logger = logging.getLogger(__name__)

DEFAULT_MODEL = "gemini-2.5-flash"

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


async def generate_content(
    system_instruction: str,
    user_prompt: str,
    model: str = DEFAULT_MODEL,
    temperature: float = 0.7,
    max_tokens: int = 1000,
    response_mime_type: Optional[str] = None,
) -> str:
    """
    Generate content using Gemini async API.

    Args:
        system_instruction: System prompt/instructions
        user_prompt: User message
        model: Gemini model ID
        temperature: Sampling temperature (0-2)
        max_tokens: Maximum output tokens
        response_mime_type: Optional MIME type to constrain output (e.g. "application/json")

    Returns:
        Generated text content
    """
    client = get_gemini_client()

    config = types.GenerateContentConfig(
        system_instruction=system_instruction,
        temperature=temperature,
        max_output_tokens=max_tokens,
        response_mime_type=response_mime_type,
    )

    response = await client.aio.models.generate_content(
        model=model,
        contents=user_prompt,
        config=config,
    )

    if not response.text:
        raise ValueError("Empty response from Gemini API")

    return response.text.strip()
