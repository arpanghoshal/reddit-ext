"""
Redis cache client.
Provides async get/set helpers with JSON serialization and graceful fallback.
"""

import os
import json
import logging
from typing import Any, Optional

import redis.asyncio as redis

logger = logging.getLogger(__name__)

_redis: Optional[redis.Redis] = None


async def get_redis() -> Optional[redis.Redis]:
    """Return the shared Redis connection, creating it on first call."""
    global _redis
    if _redis is not None:
        return _redis

    url = os.getenv("REDIS_URL")
    if not url:
        logger.warning("REDIS_URL not set — caching disabled")
        return None

    try:
        _redis = redis.from_url(url, decode_responses=True)
        await _redis.ping()
        logger.info("Redis connected")
        return _redis
    except Exception as e:
        logger.warning(f"Redis connection failed: {e} — caching disabled")
        _redis = None
        return None


async def close_redis():
    """Close the Redis connection on shutdown."""
    global _redis
    if _redis is not None:
        await _redis.aclose()
        _redis = None
        logger.info("Redis disconnected")


async def cache_get(key: str) -> Optional[Any]:
    """Get a JSON-deserialized value from Redis. Returns None on miss or error."""
    try:
        r = await get_redis()
        if r is None:
            return None
        raw = await r.get(key)
        if raw is None:
            return None
        return json.loads(raw)
    except Exception as e:
        logger.debug(f"Redis cache_get error for {key}: {e}")
        return None


async def cache_delete(key: str) -> bool:
    """Delete a key from Redis (for cache invalidation). Returns False on error."""
    try:
        r = await get_redis()
        if r is None:
            return False
        await r.delete(key)
        return True
    except Exception as e:
        logger.debug(f"Redis cache_delete error for {key}: {e}")
        return False


async def cache_set(key: str, data: Any, ttl_seconds: int) -> bool:
    """Set a JSON-serialized value in Redis with TTL. Returns False on error."""
    try:
        r = await get_redis()
        if r is None:
            return False
        await r.set(key, json.dumps(data, default=str), ex=ttl_seconds)
        return True
    except Exception as e:
        logger.debug(f"Redis cache_set error for {key}: {e}")
        return False
