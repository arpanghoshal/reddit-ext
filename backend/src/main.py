"""
Reddit Automated DM Backend - Python FastAPI Application
Main entry point
"""

import os
import logging
import traceback
from contextlib import asynccontextmanager
from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from dotenv import load_dotenv
from datetime import datetime

from .routes import api
from .routes import auth as auth_routes
from .routes import teams as teams_routes
from .routes import quotas as quotas_routes
from .routes import audit as audit_routes
from .routes import team_analytics as team_analytics_routes
from .middleware.supabase_auth import SupabaseAuthMiddleware

# Load environment variables
load_dotenv()

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s'
)
logger = logging.getLogger(__name__)


def validate_required_env_vars():
    """Validate required environment variables at startup"""
    required_vars = []  # API_KEY is optional for development
    warnings = []

    # Check for API key (warn if not set)
    if not os.getenv("API_KEY"):
        warnings.append("API_KEY not set - API authentication is disabled (not recommended for production)")

    # Check for OpenRouter key
    if not os.getenv("OPENROUTER_API_KEY"):
        warnings.append("OPENROUTER_API_KEY not set - LLM features will not work")

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
    allow_headers=["Content-Type", "Authorization", "X-API-Key", "X-Team-ID"],
)

# Supabase JWT Authentication Middleware
app.add_middleware(SupabaseAuthMiddleware)

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

# Global error handler - sanitized for security
@app.exception_handler(Exception)
async def global_exception_handler(request: Request, exc: Exception):
    """
    Global exception handler that logs full errors internally
    but returns sanitized messages to clients
    """
    # Generate a unique error ID for correlation
    import uuid
    error_id = str(uuid.uuid4())[:8]

    # Log the full error with stack trace internally
    logger.error(
        f"Unhandled exception [error_id={error_id}] "
        f"path={request.url.path} method={request.method}",
        exc_info=True
    )

    # Return sanitized error to client
    # Never expose internal error details, stack traces, or sensitive information
    return JSONResponse(
        status_code=500,
        content={
            "error": "Internal server error",
            "error_id": error_id,
            "message": "An unexpected error occurred. Please try again or contact support with the error_id."
        }
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
