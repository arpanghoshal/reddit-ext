"""
Reddit Insight Backend - Python FastAPI Application
Main entry point
"""

import os
from contextlib import asynccontextmanager
from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from dotenv import load_dotenv
from datetime import datetime

from .routes import api

load_dotenv()

@asynccontextmanager
async def lifespan(app: FastAPI):
    """Application lifespan events"""
    port = os.getenv("PORT", "3000")
    print(f"Reddit Insight Backend running on port {port}")
    print(f"Health check: http://localhost:{port}/health")
    yield

app = FastAPI(
    title="Reddit Insight Backend",
    description="Backend API for Reddit Insight Gatherer Chrome Extension",
    version="1.0.0",
    lifespan=lifespan
)

# CORS Middleware
allowed_origins = os.getenv("ALLOWED_ORIGINS")
if allowed_origins:
    origins = [origin.strip() for origin in allowed_origins.split(",")]
else:
    origins = ["*"]

app.add_middleware(
    CORSMiddleware,
    allow_origins=origins,
    allow_credentials=True,
    allow_methods=["GET", "POST", "PATCH", "DELETE"],
    allow_headers=["Content-Type", "Authorization"],
)

# Health check endpoint
@app.get("/health")
async def health_check():
    return {"status": "ok", "timestamp": datetime.utcnow().isoformat()}

# Include API routes
app.include_router(api.router, prefix="/api")

# Global error handler
@app.exception_handler(Exception)
async def global_exception_handler(request: Request, exc: Exception):
    print(f"Error: {exc}")
    return JSONResponse(
        status_code=500,
        content={"error": str(exc) or "Internal server error"}
    )

if __name__ == "__main__":
    import uvicorn
    port = int(os.getenv("PORT", "3000"))
    uvicorn.run("src.main:app", host="0.0.0.0", port=port, reload=True)
