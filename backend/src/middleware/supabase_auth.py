"""
Supabase JWT Authentication Middleware
Validates Supabase JWT tokens for protected routes
Supports both HS256 (JWT secret) and ES256 (JWKS public key) verification
"""

import os
import time
from typing import Optional, Dict, Any
import jwt
from jwt import PyJWKClient
from fastapi import Request, HTTPException
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.responses import JSONResponse


# Public endpoints that don't require authentication
PUBLIC_ENDPOINTS = {
    "/health",
    "/api/status",
    "/api/auth/signup",
    "/api/auth/login",
    "/api/auth/refresh",
    "/api/auth/accept-invite",
    "/docs",
    "/openapi.json",
    "/redoc",
}

# Cache for JWKS client
_jwks_client: Optional[PyJWKClient] = None
_jwks_cache_time: float = 0
JWKS_CACHE_TTL = 3600  # 1 hour


def get_supabase_url() -> str:
    """Get Supabase URL from environment"""
    return os.getenv("SUPABASE_URL", "")


def get_supabase_jwt_secret() -> str:
    """Get Supabase JWT secret from environment (for HS256)"""
    return os.getenv("SUPABASE_JWT_SECRET", "")


def get_jwks_client() -> Optional[PyJWKClient]:
    """Get or create JWKS client for ES256 verification"""
    global _jwks_client, _jwks_cache_time

    supabase_url = get_supabase_url()
    if not supabase_url:
        return None

    # Check if we need to refresh the client
    current_time = time.time()
    if _jwks_client is None or (current_time - _jwks_cache_time) > JWKS_CACHE_TTL:
        jwks_url = f"{supabase_url}/auth/v1/.well-known/jwks.json"
        try:
            _jwks_client = PyJWKClient(jwks_url)
            _jwks_cache_time = current_time
            print(f"JWKS client initialized from {jwks_url}")
        except Exception as e:
            print(f"Failed to create JWKS client: {e}")
            return None

    return _jwks_client


def is_public_endpoint(path: str) -> bool:
    """Check if the endpoint is public (doesn't require auth)"""
    if path in PUBLIC_ENDPOINTS:
        return True
    for endpoint in PUBLIC_ENDPOINTS:
        if path.startswith(endpoint):
            return True
    return False


def decode_supabase_jwt(token: str) -> Optional[Dict[str, Any]]:
    """
    Decode and validate a Supabase JWT token.
    Tries ES256 (JWKS) first, falls back to HS256 (secret).
    Returns the payload if valid, None otherwise.
    """
    # Try ES256 with JWKS first (Supabase's default)
    jwks_client = get_jwks_client()
    if jwks_client:
        try:
            signing_key = jwks_client.get_signing_key_from_jwt(token)
            payload = jwt.decode(
                token,
                signing_key.key,
                algorithms=["ES256"],
                audience="authenticated"
            )
            return payload
        except jwt.ExpiredSignatureError:
            print("JWT token expired")
            return None
        except jwt.InvalidTokenError as e:
            print(f"ES256 JWT validation failed: {e}")
            # Fall through to try HS256
        except Exception as e:
            print(f"JWKS verification error: {e}")
            # Fall through to try HS256

    # Fallback to HS256 with secret (older Supabase projects)
    jwt_secret = get_supabase_jwt_secret()
    if jwt_secret:
        try:
            payload = jwt.decode(
                token,
                jwt_secret,
                algorithms=["HS256"],
                audience="authenticated"
            )
            return payload
        except jwt.ExpiredSignatureError:
            print("JWT token expired")
            return None
        except jwt.InvalidTokenError as e:
            print(f"HS256 JWT validation failed: {e}")
            return None

    print("WARNING: No JWT verification method available (set SUPABASE_URL or SUPABASE_JWT_SECRET)")
    return None


def is_auth_configured() -> bool:
    """Check if any auth method is configured"""
    return bool(get_supabase_url() or get_supabase_jwt_secret())


class SupabaseAuthMiddleware(BaseHTTPMiddleware):
    """Middleware to validate Supabase JWT tokens on protected routes"""

    async def dispatch(self, request: Request, call_next):
        # Skip auth for public endpoints
        if is_public_endpoint(request.url.path):
            return await call_next(request)

        # Skip auth for OPTIONS requests (CORS preflight)
        if request.method == "OPTIONS":
            return await call_next(request)

        # Check if auth is configured
        if not is_auth_configured():
            print("WARNING: Auth not configured - running in dev mode")
            request.state.user_id = None
            request.state.team_id = None
            request.state.user = {
                "user_id": "anonymous",
                "email": "anonymous@dev.local",
                "role": "admin"
            }
            return await call_next(request)

        # Get Authorization header
        auth_header = request.headers.get("Authorization", "")

        if not auth_header.startswith("Bearer "):
            return JSONResponse(
                status_code=401,
                content={
                    "error": "Missing or invalid authorization header",
                    "detail": "Include 'Authorization: Bearer <token>' header"
                }
            )

        token = auth_header.replace("Bearer ", "")

        # Decode and validate JWT
        payload = decode_supabase_jwt(token)

        if not payload:
            return JSONResponse(
                status_code=401,
                content={
                    "error": "Invalid or expired token",
                    "detail": "Please login again to get a new token"
                }
            )

        # Extract user info from JWT payload
        user_id = payload.get("sub")
        email = payload.get("email")

        # Get team_id from custom claims or query param
        # Team ID can be passed in:
        # 1. Custom JWT claim (app_metadata.team_id)
        # 2. X-Team-ID header
        app_metadata = payload.get("app_metadata", {})
        team_id = app_metadata.get("team_id")

        # Allow override via header for team switching
        header_team_id = request.headers.get("X-Team-ID")
        if header_team_id:
            team_id = header_team_id

        # Attach user info to request state
        request.state.user_id = user_id
        request.state.team_id = team_id
        request.state.user = {
            "user_id": user_id,
            "email": email,
            "role": payload.get("role", "authenticated"),
            "app_metadata": app_metadata,
            "user_metadata": payload.get("user_metadata", {})
        }

        return await call_next(request)


def get_current_user(request: Request) -> Optional[Dict[str, Any]]:
    """Get current user from request state"""
    return getattr(request.state, "user", None)


def get_current_user_id(request: Request) -> Optional[str]:
    """Get current user ID from request state"""
    return getattr(request.state, "user_id", None)


def get_current_team_id(request: Request) -> Optional[str]:
    """Get current team ID from request state"""
    return getattr(request.state, "team_id", None)


def require_team(request: Request) -> str:
    """
    Require team_id to be present in request.
    Raises HTTPException if not set.
    """
    team_id = get_current_team_id(request)
    if not team_id:
        raise HTTPException(
            status_code=400,
            detail="Team ID required. Set X-Team-ID header or select a team."
        )
    return team_id
