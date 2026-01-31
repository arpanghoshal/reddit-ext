"""
API Key Authentication Middleware
Validates API key in request headers for all protected routes
Supports multiple hardcoded API keys with user info
"""

import os
import secrets
from fastapi import Request, HTTPException
from fastapi.security import APIKeyHeader
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.responses import JSONResponse

from src.config.api_keys import get_api_key_info, is_valid_api_key, VALID_API_KEYS

# API key header name
API_KEY_HEADER = "X-API-Key"

# Public endpoints that don't require authentication
PUBLIC_ENDPOINTS = {
    "/health",
    "/api/status",
    "/api/auth/validate",  # Allow key validation without auth
    "/docs",
    "/openapi.json",
    "/redoc",
}


def get_single_api_key() -> str:
    """Get single API key from environment (fallback mode)"""
    return os.getenv("API_KEY", "")


def is_public_endpoint(path: str) -> bool:
    """Check if the endpoint is public (doesn't require auth)"""
    # Exact match
    if path in PUBLIC_ENDPOINTS:
        return True
    # Check if path starts with any public endpoint prefix
    for endpoint in PUBLIC_ENDPOINTS:
        if path.startswith(endpoint):
            return True
    return False


def validate_api_key_multi(api_key: str) -> dict | None:
    """
    Validate API key against hardcoded keys or environment variable.
    Returns user info if valid, None otherwise.
    """
    # First, check hardcoded keys
    key_info = get_api_key_info(api_key)
    if key_info:
        return key_info

    # Fallback: check environment variable (single key mode)
    env_key = get_single_api_key()
    if env_key and secrets.compare_digest(api_key, env_key):
        return {
            "user_id": "env-user",
            "name": "Environment User",
            "role": "admin",
            "daily_limit": 100
        }

    return None


class APIKeyMiddleware(BaseHTTPMiddleware):
    """Middleware to validate API key on all protected routes"""

    async def dispatch(self, request: Request, call_next):
        # Skip auth for public endpoints
        if is_public_endpoint(request.url.path):
            return await call_next(request)

        # Skip auth for OPTIONS requests (CORS preflight)
        if request.method == "OPTIONS":
            return await call_next(request)

        # Check if we have any API keys configured
        has_hardcoded_keys = len(VALID_API_KEYS) > 0
        has_env_key = bool(get_single_api_key())

        # If no API keys configured at all, allow all requests (development mode)
        if not has_hardcoded_keys and not has_env_key:
            print("WARNING: No API keys configured - API authentication disabled")
            request.state.user = {
                "user_id": "anonymous",
                "name": "Anonymous",
                "role": "admin",
                "daily_limit": 50
            }
            return await call_next(request)

        # Get API key from request header
        request_api_key = request.headers.get(API_KEY_HEADER)

        # Validate API key
        if not request_api_key:
            return JSONResponse(
                status_code=401,
                content={
                    "error": "Missing API key",
                    "detail": f"Include '{API_KEY_HEADER}' header with your API key"
                }
            )

        # Validate against all configured keys
        user_info = validate_api_key_multi(request_api_key)

        if not user_info:
            return JSONResponse(
                status_code=403,
                content={
                    "error": "Invalid API key",
                    "detail": "The provided API key is not valid"
                }
            )

        # Attach user info to request state for use in routes
        request.state.user = user_info

        return await call_next(request)


def validate_api_key(api_key: str) -> bool:
    """Validate an API key (for use in route dependencies)"""
    return validate_api_key_multi(api_key) is not None


def get_current_user(request: Request) -> dict:
    """Get current user from request state"""
    return getattr(request.state, "user", None)
