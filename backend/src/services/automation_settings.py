"""
Automation Settings Service
CRUD operations for automation_settings table
"""

from datetime import datetime
from typing import Optional, Dict, Any
from .supabase_service import get_client


def _transform_from_db(row: Dict[str, Any]) -> Dict[str, Any]:
    """Transform database row to API format"""
    return {
        "id": row.get("id"),
        "defaultQueueMode": row.get("default_queue_mode", "review"),
        "minRelevanceScore": row.get("min_relevance_score", 40),
        "allowWeakMatches": row.get("allow_weak_matches", True),
        "minAccountAgeDays": row.get("min_account_age_days", 30),
        "minKarma": row.get("min_karma", 100),
        "blockSuspectedBots": row.get("block_suspected_bots", True),
        "globalDailyLimit": row.get("global_daily_limit", 100),
        "delayBetweenDmsMin": row.get("delay_between_dms_min", 30),
        "delayBetweenDmsMax": row.get("delay_between_dms_max", 180),
        "enableSessionBreaks": row.get("enable_session_breaks", True),
        "sessionBreakAfterMin": row.get("session_break_after_min", 5),
        "sessionBreakAfterMax": row.get("session_break_after_max", 15),
        "sessionBreakDurationMin": row.get("session_break_duration_min", 300),
        "sessionBreakDurationMax": row.get("session_break_duration_max", 1800),
        "typingSpeedMin": row.get("typing_speed_min", 50),
        "typingSpeedMax": row.get("typing_speed_max", 150),
        "enableTypoSimulation": row.get("enable_typo_simulation", False),
        "createdAt": row.get("created_at"),
        "updatedAt": row.get("updated_at")
    }


def _transform_to_db(data: Dict[str, Any]) -> Dict[str, Any]:
    """Transform API format to database format"""
    db_data = {}

    field_mapping = {
        "defaultQueueMode": "default_queue_mode",
        "minRelevanceScore": "min_relevance_score",
        "allowWeakMatches": "allow_weak_matches",
        "minAccountAgeDays": "min_account_age_days",
        "minKarma": "min_karma",
        "blockSuspectedBots": "block_suspected_bots",
        "globalDailyLimit": "global_daily_limit",
        "delayBetweenDmsMin": "delay_between_dms_min",
        "delayBetweenDmsMax": "delay_between_dms_max",
        "enableSessionBreaks": "enable_session_breaks",
        "sessionBreakAfterMin": "session_break_after_min",
        "sessionBreakAfterMax": "session_break_after_max",
        "sessionBreakDurationMin": "session_break_duration_min",
        "sessionBreakDurationMax": "session_break_duration_max",
        "typingSpeedMin": "typing_speed_min",
        "typingSpeedMax": "typing_speed_max",
        "enableTypoSimulation": "enable_typo_simulation"
    }

    for api_key, db_key in field_mapping.items():
        if api_key in data:
            db_data[db_key] = data[api_key]

    return db_data


async def get_automation_settings() -> Optional[Dict[str, Any]]:
    """Get automation settings (returns first/only row or defaults)"""
    client = get_client()
    if not client:
        return _get_defaults()

    try:
        result = client.table("automation_settings").select("*").limit(1).execute()

        if result.data and len(result.data) > 0:
            return _transform_from_db(result.data[0])

        # Return defaults if no settings exist
        return _get_defaults()
    except Exception as e:
        print(f"Failed to get automation settings: {e}")
        return _get_defaults()


async def save_automation_settings(data: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    """Save automation settings (upsert)"""
    client = get_client()
    if not client:
        print("Supabase not configured - cannot save automation settings")
        return None

    try:
        existing = await get_automation_settings()
        db_data = _transform_to_db(data)
        db_data["updated_at"] = datetime.utcnow().isoformat()

        if existing and existing.get("id"):
            # Update existing
            result = client.table("automation_settings").update(
                db_data
            ).eq("id", existing["id"]).execute()
        else:
            # Insert new
            result = client.table("automation_settings").insert(db_data).execute()

        if result.data and len(result.data) > 0:
            return _transform_from_db(result.data[0])
        return None
    except Exception as e:
        print(f"Failed to save automation settings: {e}")
        return None


def _get_defaults() -> Dict[str, Any]:
    """Return default automation settings"""
    return {
        "id": None,
        "defaultQueueMode": "review",
        "minRelevanceScore": 40,
        "allowWeakMatches": True,
        "minAccountAgeDays": 30,
        "minKarma": 100,
        "blockSuspectedBots": True,
        "globalDailyLimit": 100,
        "delayBetweenDmsMin": 30,
        "delayBetweenDmsMax": 180,
        "enableSessionBreaks": True,
        "sessionBreakAfterMin": 5,
        "sessionBreakAfterMax": 15,
        "sessionBreakDurationMin": 300,
        "sessionBreakDurationMax": 1800,
        "typingSpeedMin": 50,
        "typingSpeedMax": 150,
        "enableTypoSimulation": False,
        "createdAt": None,
        "updatedAt": None
    }
