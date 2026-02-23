"""
Reddit Automated DM Backend - Python FastAPI Application
Main entry point
"""

import os
import logging
import time
import uuid
from contextlib import asynccontextmanager
from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from starlette.middleware.base import BaseHTTPMiddleware
from dotenv import load_dotenv
from datetime import datetime

from .routes import api
from .routes import auth as auth_routes
from .routes import teams as teams_routes
from .routes import quotas as quotas_routes
from .routes import audit as audit_routes
from .routes import team_analytics as team_analytics_routes
from .routes import discovery as discovery_routes
from .routes import logs as logs_routes
from .middleware.supabase_auth import SupabaseAuthMiddleware
from .config.logging_config import (
    setup_logging,
    request_id_var,
    team_id_var,
    user_id_var,
)

# Load environment variables
load_dotenv()

# Configure structured logging (replaces basicConfig)
setup_logging()
logger = logging.getLogger(__name__)

# Initialize Sentry (if configured)
_sentry_dsn = os.getenv("SENTRY_DSN")
if _sentry_dsn:
    try:
        import sentry_sdk
        from sentry_sdk.integrations.fastapi import FastApiIntegration

        sentry_sdk.init(
            dsn=_sentry_dsn,
            integrations=[FastApiIntegration()],
            traces_sample_rate=0.1,
            environment=os.getenv("ENVIRONMENT", "development"),
            release="reddit-ext-backend@0.0.1",
            send_default_pii=False,
        )
        logger.info("Sentry initialized")
    except Exception as e:
        logger.warning(f"Sentry init failed: {e}")


def validate_required_env_vars():
    """Validate required environment variables at startup"""
    required_vars = []  # API_KEY is optional for development
    warnings = []

    # Check for API key (warn if not set)
    if not os.getenv("API_KEY"):
        warnings.append("API_KEY not set - API authentication is disabled (not recommended for production)")

    # Check for Gemini API key
    if not os.getenv("GOOGLE_GEMINI_API_KEY"):
        warnings.append("GOOGLE_GEMINI_API_KEY not set - LLM features will not work")

    # Check for Supabase
    if not os.getenv("SUPABASE_URL") or not os.getenv("SUPABASE_KEY"):
        warnings.append("Supabase credentials not set - database features will not work")

    for warning in warnings:
        logger.warning(warning)

    return True


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Application lifespan events"""
    # Startup
    validate_required_env_vars()

    port = os.getenv("PORT", "3000")
    env = os.getenv("ENVIRONMENT", "development")

    logger.info(f"Reddit Automated DM Backend starting...")
    logger.info(f"Environment: {env}")
    logger.info(f"Port: {port}")
    logger.info(f"Health check: http://localhost:{port}/health")

    yield

    # Shutdown
    logger.info("Reddit Automated DM Backend shutting down...")


app = FastAPI(
    title="Reddit Automated DM Backend",
    description="Backend API for Reddit Automated DM Chrome Extension",
    version="0.0.1",
    lifespan=lifespan,
    # Disable docs in production if needed
    docs_url="/docs" if os.getenv("ENVIRONMENT") != "production" else None,
    redoc_url="/redoc" if os.getenv("ENVIRONMENT") != "production" else None
)

# CORS Middleware
allowed_origins = os.getenv("ALLOWED_ORIGINS")
if allowed_origins:
    origins = [origin.strip() for origin in allowed_origins.split(",")]
else:
    # In development, allow common origins; in production, require explicit config
    if os.getenv("ENVIRONMENT") == "production":
        origins = []  # No origins allowed by default in production
        logger.warning("ALLOWED_ORIGINS not set in production - CORS will block all origins")
    else:
        origins = ["*"]  # Allow all in development
        logger.warning("CORS allowing all origins (development mode)")

app.add_middleware(
    CORSMiddleware,
    allow_origins=origins,
    allow_origin_regex=r"^chrome-extension://.*$",
    allow_credentials=True,
    allow_methods=["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
    allow_headers=["Content-Type", "Authorization", "X-API-Key", "X-Team-ID", "X-Request-ID"],
    expose_headers=["X-Request-ID"],
)


# Request context middleware — generates/reads X-Request-ID and logs request lifecycle
class RequestContextMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next):
        req_id = request.headers.get("X-Request-ID") or str(uuid.uuid4())[:8]
        request_id_var.set(req_id)

        start = time.time()
        response = await call_next(request)
        duration_ms = round((time.time() - start) * 1000, 2)

        # Read team/user context set by SupabaseAuthMiddleware
        team_id_var.set(getattr(request.state, "team_id", "") or "")
        user_id_var.set(getattr(request.state, "user_id", "") or "")

        response.headers["X-Request-ID"] = req_id

        # Log request completion (skip noisy health checks)
        if request.url.path != "/health":
            logger.info(
                "request_completed",
                extra={
                    "method": request.method,
                    "path": request.url.path,
                    "status": response.status_code,
                    "duration_ms": duration_ms,
                },
            )

        return response


# Middleware order: added last = runs first
# 1. RequestContextMiddleware (outermost — sets request_id)
# 2. SupabaseAuthMiddleware (inner — sets team_id/user_id on request.state)
app.add_middleware(SupabaseAuthMiddleware)
app.add_middleware(RequestContextMiddleware)

# Health check endpoint (public, no auth required)
@app.get("/health")
async def health_check():
    return {
        "status": "ok",
        "timestamp": datetime.utcnow().isoformat(),
        "version": "0.0.1"
    }

# Include API routes
app.include_router(api.router, prefix="/api")
app.include_router(auth_routes.router, prefix="/api")
app.include_router(teams_routes.router, prefix="/api")
app.include_router(quotas_routes.router, prefix="/api")
app.include_router(audit_routes.router, prefix="/api")
app.include_router(team_analytics_routes.router, prefix="/api")
app.include_router(discovery_routes.router, prefix="/api")
app.include_router(logs_routes.router, prefix="/api")


# Global error handler - sanitized for security
@app.exception_handler(Exception)
async def global_exception_handler(request: Request, exc: Exception):
    """
    Global exception handler that logs full errors internally
    but returns sanitized messages to clients
    """
    error_id = str(uuid.uuid4())[:8]
    req_id = request_id_var.get("")

    # Enrich Sentry context if available
    if _sentry_dsn:
        try:
            import sentry_sdk

            sentry_sdk.set_tag("error_id", error_id)
            sentry_sdk.set_tag("request_id", req_id)
            sentry_sdk.set_context(
                "request",
                {
                    "path": request.url.path,
                    "method": request.method,
                    "team_id": getattr(request.state, "team_id", None),
                },
            )
        except Exception:
            pass

    logger.error(
        "unhandled_exception",
        extra={
            "error_id": error_id,
            "request_id": req_id,
            "path": request.url.path,
            "method": request.method,
        },
        exc_info=True,
    )

    return JSONResponse(
        status_code=500,
        content={
            "error": "Internal server error",
            "error_id": error_id,
            "message": "An unexpected error occurred. Please try again or contact support with the error_id.",
        },
    )


if __name__ == "__main__":
    import uvicorn

    port = int(os.getenv("PORT", "3000"))
    environment = os.getenv("ENVIRONMENT", "development")

    # Only enable reload in development
    reload_enabled = environment == "development"

    # Use 127.0.0.1 in production, 0.0.0.0 for development/docker
    host = "0.0.0.0" if os.getenv("BIND_ALL_INTERFACES", "false").lower() == "true" else "127.0.0.1"

    logger.info(f"Starting server on {host}:{port} (reload={reload_enabled})")

    uvicorn.run(
        "src.main:app",
        host=host,
        port=port,
        reload=reload_enabled,
        log_level="info"
    )
