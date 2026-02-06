"""
Filter Rules Service
Manages custom rules for filtering posts and users
"""

import os
from datetime import datetime
from typing import Dict, Any, List, Optional
from supabase import create_client, Client

_supabase: Optional[Client] = None

# Rule types
RULE_TYPES = {
    "KEYWORD_SKIP": "keyword_skip",           # Skip posts containing these keywords
    "KEYWORD_REQUIRE": "keyword_require",     # Require posts to contain these keywords
    "KARMA_MIN": "karma_min",                 # Minimum karma threshold
    "ACCOUNT_AGE_MIN": "account_age_min",     # Minimum account age in days
    "SUBREDDIT_BLACKLIST": "subreddit_blacklist",   # Skip these subreddits
    "SUBREDDIT_WHITELIST": "subreddit_whitelist",   # Only allow these subreddits
    "RELEVANCE_SCORE_MIN": "relevance_score_min"    # Minimum classification score
}


def get_client() -> Optional[Client]:
    """Get or create Supabase client"""
    global _supabase
    if _supabase is None:
        url = os.getenv("SUPABASE_URL")
        key = os.getenv("SUPABASE_KEY")
        if url and key:
            _supabase = create_client(url, key)
    return _supabase


def transform_rule(row: Optional[Dict[str, Any]]) -> Optional[Dict[str, Any]]:
    """Transform database row to API format"""
    if not row:
        return None

    return {
        "id": row.get("id"),
        "name": row.get("name"),
        "description": row.get("description"),
        "ruleType": row.get("rule_type"),
        "value": row.get("value"),
        "isActive": row.get("is_active"),
        "priority": row.get("priority"),
        "createdAt": row.get("created_at"),
        "updatedAt": row.get("updated_at")
    }


async def create_rule(rule_data: Dict[str, Any], team_id: Optional[str] = None) -> Optional[Dict[str, Any]]:
    """Create a new rule"""
    client = get_client()
    if not client:
        print("Supabase not configured")
        return None

    try:
        insert_data = {
            "name": rule_data.get("name"),
            "description": rule_data.get("description"),
            "rule_type": rule_data.get("ruleType"),
            "value": rule_data.get("value"),
            "is_active": rule_data.get("isActive", True),
            "priority": rule_data.get("priority", 0)
        }

        # Add team_id if provided
        if team_id:
            insert_data["team_id"] = team_id

        result = client.table("filter_rules").insert(insert_data).execute()

        return transform_rule(result.data[0]) if result.data else None
    except Exception as e:
        print(f"Error creating rule: {e}")
        return None


async def get_rules(filters: Dict[str, Any] = None, team_id: Optional[str] = None) -> List[Dict[str, Any]]:
    """Get all rules for a team"""
    client = get_client()
    if not client:
        return []

    filters = filters or {}

    try:
        query = client.table("filter_rules").select("*").order(
            "priority", desc=True
        ).order("created_at")

        # Filter by team_id (required for multi-tenancy)
        if team_id:
            query = query.eq("team_id", team_id)

        if filters.get("activeOnly"):
            query = query.eq("is_active", True)

        if filters.get("ruleType"):
            query = query.eq("rule_type", filters["ruleType"])

        result = query.execute()
        return [transform_rule(row) for row in result.data] if result.data else []
    except Exception as e:
        print(f"Error fetching rules: {e}")
        return []


async def get_active_rules(team_id: Optional[str] = None) -> List[Dict[str, Any]]:
    """Get active rules (for evaluation)"""
    return await get_rules({"activeOnly": True}, team_id=team_id)


async def update_rule(rule_id: str, updates: Dict[str, Any], team_id: Optional[str] = None) -> Optional[Dict[str, Any]]:
    """Update a rule"""
    client = get_client()
    if not client:
        return None

    try:
        update_data = {"updated_at": datetime.utcnow().isoformat()}

        if "name" in updates:
            update_data["name"] = updates["name"]
        if "description" in updates:
            update_data["description"] = updates["description"]
        if "value" in updates:
            update_data["value"] = updates["value"]
        if "isActive" in updates:
            update_data["is_active"] = updates["isActive"]
        if "priority" in updates:
            update_data["priority"] = updates["priority"]

        query = client.table("filter_rules").update(update_data).eq("id", rule_id)
        if team_id:
            query = query.eq("team_id", team_id)
        result = query.execute()
        return transform_rule(result.data[0]) if result.data else None
    except Exception as e:
        print(f"Error updating rule: {e}")
        return None


async def delete_rule(rule_id: str, team_id: Optional[str] = None) -> bool:
    """Delete a rule"""
    client = get_client()
    if not client:
        return False

    try:
        query = client.table("filter_rules").delete().eq("id", rule_id)
        if team_id:
            query = query.eq("team_id", team_id)
        query.execute()
        return True
    except Exception as e:
        print(f"Error deleting rule: {e}")
        return False


def evaluate_single_rule(
    rule: Dict[str, Any],
    post: Dict[str, Any],
    user_profile: Optional[Dict[str, Any]] = None
) -> Dict[str, Any]:
    """Evaluate a single rule against a post/user"""
    value = rule.get("value", {})
    rule_type = rule.get("ruleType")

    if rule_type == RULE_TYPES["KEYWORD_SKIP"]:
        keywords = value.get("keywords", [])
        content = f"{post.get('title', '')} {post.get('body', '')}".lower()

        for keyword in keywords:
            if keyword.lower() in content:
                return {
                    "passed": False,
                    "reason": f'Contains skip keyword: "{keyword}"'
                }
        return {"passed": True}

    elif rule_type == RULE_TYPES["KEYWORD_REQUIRE"]:
        keywords = value.get("keywords", [])
        content = f"{post.get('title', '')} {post.get('body', '')}".lower()

        has_required = any(k.lower() in content for k in keywords)
        return {
            "passed": has_required,
            "reason": None if has_required else "Missing required keywords"
        }

    elif rule_type == RULE_TYPES["KARMA_MIN"]:
        if not user_profile:
            return {"passed": True}  # Skip if no user data

        min_karma = value.get("threshold", 100)
        user_karma = user_profile.get("totalKarma") or user_profile.get("karma", 0)

        passed = user_karma >= min_karma
        return {
            "passed": passed,
            "reason": None if passed else f"Karma {user_karma} below minimum {min_karma}"
        }

    elif rule_type == RULE_TYPES["ACCOUNT_AGE_MIN"]:
        if not user_profile:
            return {"passed": True}  # Skip if no user data

        min_days = value.get("threshold", 30)
        account_age_days = user_profile.get("accountAgeDays", 0)

        passed = account_age_days >= min_days
        return {
            "passed": passed,
            "reason": None if passed else f"Account age {account_age_days} days below minimum {min_days}"
        }

    elif rule_type == RULE_TYPES["SUBREDDIT_BLACKLIST"]:
        blacklist = [s.lower() for s in value.get("subreddits", [])]
        subreddit = (post.get("subreddit") or "").lower()

        is_blacklisted = subreddit in blacklist
        return {
            "passed": not is_blacklisted,
            "reason": f"Subreddit r/{subreddit} is blacklisted" if is_blacklisted else None
        }

    elif rule_type == RULE_TYPES["SUBREDDIT_WHITELIST"]:
        whitelist = [s.lower() for s in value.get("subreddits", [])]

        # If whitelist is empty, allow all
        if not whitelist:
            return {"passed": True}

        subreddit = (post.get("subreddit") or "").lower()
        is_whitelisted = subreddit in whitelist

        return {
            "passed": is_whitelisted,
            "reason": None if is_whitelisted else f"Subreddit r/{subreddit} not in whitelist"
        }

    elif rule_type == RULE_TYPES["RELEVANCE_SCORE_MIN"]:
        min_score = value.get("threshold", 50)
        score = post.get("classificationScore") or post.get("relevanceScore", 0)

        passed = score >= min_score
        return {
            "passed": passed,
            "reason": None if passed else f"Relevance score {score} below minimum {min_score}",
            "score": score
        }

    else:
        print(f"Unknown rule type: {rule_type}")
        return {"passed": True}


async def evaluate_rules(
    post: Dict[str, Any],
    user_profile: Optional[Dict[str, Any]] = None,
    team_id: Optional[str] = None
) -> Dict[str, Any]:
    """Evaluate all active rules against a post/user"""
    rules = await get_active_rules(team_id=team_id)

    result = {
        "passed": True,
        "score": 100,
        "failedRules": [],
        "appliedRules": []
    }

    for rule in rules:
        evaluation = evaluate_single_rule(rule, post, user_profile)

        result["appliedRules"].append({
            "id": rule.get("id"),
            "name": rule.get("name"),
            "type": rule.get("ruleType"),
            "passed": evaluation.get("passed")
        })

        if not evaluation.get("passed"):
            result["passed"] = False
            result["failedRules"].append({
                "id": rule.get("id"),
                "name": rule.get("name"),
                "reason": evaluation.get("reason")
            })

        if evaluation.get("score") is not None:
            result["score"] = min(result["score"], evaluation["score"])

    return result


def test_rule(rule: Dict[str, Any], test_data: Dict[str, Any]) -> Dict[str, Any]:
    """Test a rule against sample data"""
    return evaluate_single_rule(rule, test_data.get("post", {}), test_data.get("userProfile"))


def get_default_rule_templates() -> List[Dict[str, Any]]:
    """Get default rules templates"""
    return [
        {
            "name": "Skip Hiring Posts",
            "description": "Skip posts that appear to be job listings or hiring announcements",
            "ruleType": RULE_TYPES["KEYWORD_SKIP"],
            "value": {
                "keywords": ["hiring", "looking for", "job posting", "we are hiring", "join our team", "apply now"]
            }
        },
        {
            "name": "Minimum Karma",
            "description": "Require users to have at least 100 karma",
            "ruleType": RULE_TYPES["KARMA_MIN"],
            "value": {"threshold": 100}
        },
        {
            "name": "Minimum Account Age",
            "description": "Require accounts to be at least 30 days old",
            "ruleType": RULE_TYPES["ACCOUNT_AGE_MIN"],
            "value": {"threshold": 30}
        },
        {
            "name": "Skip Spam Subreddits",
            "description": "Skip known spam or test subreddits",
            "ruleType": RULE_TYPES["SUBREDDIT_BLACKLIST"],
            "value": {
                "subreddits": ["spam", "test", "testingground4bots", "u_testuser"]
            }
        },
        {
            "name": "Minimum Relevance Score",
            "description": "Require posts to have at least 50% relevance score",
            "ruleType": RULE_TYPES["RELEVANCE_SCORE_MIN"],
            "value": {"threshold": 50}
        }
    ]
