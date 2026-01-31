# Hardcoded API Keys Configuration
# In production, these would be stored in a database with user associations
# Format: { api_key: { user_id, name, created_at, is_active } }

from datetime import datetime

# Hardcoded API keys for development/testing
# Empty dict = authentication disabled (dev mode)
# To enable auth, add API keys here
VALID_API_KEYS = {
    # Uncomment these for production:
    # "rig-admin-key-2024-super-secret": {
    #     "user_id": "admin",
    #     "name": "Admin User",
    #     "role": "admin",
    #     "created_at": "2024-01-01T00:00:00Z",
    #     "is_active": True,
    #     "daily_limit": 1000
    # },
}


def get_api_key_info(api_key: str) -> dict | None:
    """Get information about an API key if it's valid and active."""
    key_info = VALID_API_KEYS.get(api_key)
    if key_info and key_info.get("is_active", False):
        return key_info
    return None


def is_valid_api_key(api_key: str) -> bool:
    """Check if an API key is valid and active."""
    return get_api_key_info(api_key) is not None


def get_user_daily_limit(api_key: str) -> int:
    """Get the daily DM limit for a user based on their API key."""
    key_info = get_api_key_info(api_key)
    if key_info:
        return key_info.get("daily_limit", 50)
    return 0


def list_active_keys() -> list:
    """List all active API keys (for admin purposes)."""
    return [
        {
            "key_preview": f"{key[:8]}...{key[-4:]}",
            "user_id": info["user_id"],
            "name": info["name"],
            "role": info["role"],
            "daily_limit": info["daily_limit"]
        }
        for key, info in VALID_API_KEYS.items()
        if info.get("is_active", False)
    ]
