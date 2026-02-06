"""
Campaigns Service
CRUD operations for campaigns table
"""

from datetime import datetime
from typing import Optional, Dict, List, Any
from .supabase_service import get_client


def _transform_from_db(row: Dict[str, Any]) -> Dict[str, Any]:
    """Transform database row to API format"""
    return {
        "id": row.get("id"),
        "name": row.get("name"),
        "description": row.get("description"),
        "subreddits": row.get("subreddits", []),
        "messageTone": row.get("message_tone"),
        "targetPersona": row.get("target_persona"),
        "businessContext": row.get("business_context"),
        "status": row.get("status", "draft"),
        "totalScanned": row.get("total_scanned", 0),
        "totalQualified": row.get("total_qualified", 0),
        "totalDms": row.get("total_dms", 0),
        "repliesReceived": row.get("replies_received", 0),
        "conversions": row.get("conversions", 0),
        "startDate": row.get("start_date"),
        "endDate": row.get("end_date"),
        "createdAt": row.get("created_at"),
        "updatedAt": row.get("updated_at")
    }


def _transform_to_db(data: Dict[str, Any]) -> Dict[str, Any]:
    """Transform API format to database format"""
    db_data = {}

    field_mapping = {
        "name": "name",
        "description": "description",
        "subreddits": "subreddits",
        "messageTone": "message_tone",
        "targetPersona": "target_persona",
        "businessContext": "business_context",
        "status": "status",
        "totalScanned": "total_scanned",
        "totalQualified": "total_qualified",
        "totalDms": "total_dms",
        "repliesReceived": "replies_received",
        "conversions": "conversions",
        "startDate": "start_date",
        "endDate": "end_date"
    }

    for api_key, db_key in field_mapping.items():
        if api_key in data:
            db_data[db_key] = data[api_key]

    return db_data


async def get_campaigns(filters: Dict[str, Any] = None, team_id: Optional[str] = None) -> List[Dict[str, Any]]:
    """Get all campaigns with optional filtering"""
    client = get_client()
    if not client:
        return []

    filters = filters or {}

    try:
        query = client.table("campaigns").select("*")

        # Filter by team_id (required for multi-tenancy)
        if team_id:
            query = query.eq("team_id", team_id)

        if filters.get("status"):
            query = query.eq("status", filters["status"])

        query = query.order("created_at", desc=True)

        if filters.get("limit"):
            query = query.limit(filters["limit"])

        result = query.execute()

        return [_transform_from_db(row) for row in (result.data or [])]
    except Exception as e:
        print(f"Failed to get campaigns: {e}")
        return []


async def get_campaign(campaign_id: str, team_id: Optional[str] = None) -> Optional[Dict[str, Any]]:
    """Get a single campaign by ID"""
    client = get_client()
    if not client:
        return None

    try:
        query = client.table("campaigns").select("*").eq("id", campaign_id)
        if team_id:
            query = query.eq("team_id", team_id)
        result = query.single().execute()

        if result.data:
            return _transform_from_db(result.data)
        return None
    except Exception as e:
        print(f"Failed to get campaign {campaign_id}: {e}")
        return None


async def create_campaign(data: Dict[str, Any], team_id: Optional[str] = None) -> Optional[Dict[str, Any]]:
    """Create a new campaign"""
    client = get_client()
    if not client:
        return None

    try:
        db_data = _transform_to_db(data)

        # Add team_id if provided
        if team_id:
            db_data["team_id"] = team_id

        result = client.table("campaigns").insert(db_data).execute()

        if result.data and len(result.data) > 0:
            return _transform_from_db(result.data[0])
        return None
    except Exception as e:
        print(f"Failed to create campaign: {e}")
        return None


async def update_campaign(campaign_id: str, data: Dict[str, Any], team_id: Optional[str] = None) -> Optional[Dict[str, Any]]:
    """Update an existing campaign"""
    client = get_client()
    if not client:
        return None

    try:
        db_data = _transform_to_db(data)
        db_data["updated_at"] = datetime.utcnow().isoformat()

        query = client.table("campaigns").update(db_data).eq("id", campaign_id)
        if team_id:
            query = query.eq("team_id", team_id)
        result = query.execute()

        if result.data and len(result.data) > 0:
            return _transform_from_db(result.data[0])
        return None
    except Exception as e:
        print(f"Failed to update campaign {campaign_id}: {e}")
        return None


async def delete_campaign(campaign_id: str, team_id: Optional[str] = None) -> bool:
    """Delete a campaign"""
    client = get_client()
    if not client:
        return False

    try:
        query = client.table("campaigns").delete().eq("id", campaign_id)
        if team_id:
            query = query.eq("team_id", team_id)
        query.execute()
        return True
    except Exception as e:
        print(f"Failed to delete campaign {campaign_id}: {e}")
        return False


async def get_campaign_stats(campaign_id: str, team_id: Optional[str] = None) -> Dict[str, Any]:
    """Get detailed stats for a campaign"""
    client = get_client()
    if not client:
        return {}

    try:
        campaign = await get_campaign(campaign_id, team_id=team_id)
        if not campaign:
            return {}

        # Calculate conversion rates
        reply_rate = 0
        conversion_rate = 0

        if campaign.get("totalDms", 0) > 0:
            reply_rate = round((campaign.get("repliesReceived", 0) / campaign["totalDms"]) * 100, 1)
            conversion_rate = round((campaign.get("conversions", 0) / campaign["totalDms"]) * 100, 1)

        qualification_rate = 0
        if campaign.get("totalScanned", 0) > 0:
            qualification_rate = round((campaign.get("totalQualified", 0) / campaign["totalScanned"]) * 100, 1)

        return {
            "campaignId": campaign_id,
            "totalScanned": campaign.get("totalScanned", 0),
            "totalQualified": campaign.get("totalQualified", 0),
            "totalDms": campaign.get("totalDms", 0),
            "repliesReceived": campaign.get("repliesReceived", 0),
            "conversions": campaign.get("conversions", 0),
            "qualificationRate": qualification_rate,
            "replyRate": reply_rate,
            "conversionRate": conversion_rate
        }
    except Exception as e:
        print(f"Failed to get campaign stats: {e}")
        return {}


async def increment_campaign_stats(campaign_id: str, field: str, amount: int = 1, team_id: Optional[str] = None) -> bool:
    """Increment a campaign stat field"""
    client = get_client()
    if not client:
        return False

    field_mapping = {
        "scanned": "total_scanned",
        "qualified": "total_qualified",
        "dms": "total_dms",
        "replies": "replies_received",
        "conversions": "conversions"
    }

    db_field = field_mapping.get(field)
    if not db_field:
        return False

    try:
        # Try to use RPC for atomic increment if available
        try:
            result = client.rpc("increment_campaign_stat", {
                "p_campaign_id": campaign_id,
                "p_field": db_field,
                "p_amount": amount
            }).execute()
            return True
        except Exception:
            pass

        # Fallback: read then write (acceptable for low-frequency stat updates)
        campaign = await get_campaign(campaign_id, team_id=team_id)
        if not campaign:
            return False

        api_field_mapping = {
            "total_scanned": "totalScanned",
            "total_qualified": "totalQualified",
            "total_dms": "totalDms",
            "replies_received": "repliesReceived",
            "conversions": "conversions"
        }

        api_field = api_field_mapping.get(db_field)
        current_value = campaign.get(api_field, 0)

        query = client.table("campaigns").update({
            db_field: current_value + amount,
            "updated_at": datetime.utcnow().isoformat()
        }).eq("id", campaign_id)
        if team_id:
            query = query.eq("team_id", team_id)
        query.execute()

        return True
    except Exception as e:
        print(f"Failed to increment campaign stat: {e}")
        return False
