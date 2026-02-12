"""
Subreddit Watch Service
Lightweight monitoring pipeline that checks watched subreddits for new posts.
Only processes posts newer than last_checked_at (delta processing).
Uses ScrapeCreators API exclusively — no public Reddit JSON.
"""

import logging
from datetime import datetime
from typing import Dict, Any, List, Optional

from .supabase_service import get_client
from . import reddit_search
from . import classification as classification_service
from . import dedup

logger = logging.getLogger(__name__)


# ============================================================================
# CRUD Operations
# ============================================================================

async def get_watches(team_id: str) -> List[Dict[str, Any]]:
    """Get all watches for a team."""
    client = get_client()
    if not client:
        return []

    result = client.table("subreddit_watches").select("*").eq(
        "team_id", team_id
    ).order("created_at", desc=True).execute()

    return result.data or []


async def get_watch(watch_id: str, team_id: str) -> Optional[Dict[str, Any]]:
    """Get a single watch by ID."""
    client = get_client()
    if not client:
        return None

    result = client.table("subreddit_watches").select("*").eq(
        "id", watch_id
    ).eq("team_id", team_id).execute()

    return result.data[0] if result.data else None


async def create_watch(team_id: str, subreddit_name: str) -> Optional[Dict[str, Any]]:
    """Create a new subreddit watch."""
    client = get_client()
    if not client:
        return None

    # Strip r/ prefix if present
    subreddit_name = subreddit_name.strip()
    if subreddit_name.startswith("r/"):
        subreddit_name = subreddit_name[2:]

    try:
        result = client.table("subreddit_watches").insert({
            "team_id": team_id,
            "subreddit_name": subreddit_name,
            "status": "active",
        }).execute()
        return result.data[0] if result.data else None
    except Exception as e:
        if "duplicate" in str(e).lower() or "unique" in str(e).lower():
            logger.info(f"Watch already exists for r/{subreddit_name}")
            # Return existing watch
            existing = client.table("subreddit_watches").select("*").eq(
                "team_id", team_id
            ).eq("subreddit_name", subreddit_name).execute()
            return existing.data[0] if existing.data else None
        logger.error(f"Failed to create watch for r/{subreddit_name}: {e}")
        return None


async def update_watch(watch_id: str, team_id: str, updates: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    """Update a watch (e.g., pause/resume)."""
    client = get_client()
    if not client:
        return None

    updates["updated_at"] = datetime.utcnow().isoformat()

    result = client.table("subreddit_watches").update(updates).eq(
        "id", watch_id
    ).eq("team_id", team_id).execute()

    return result.data[0] if result.data else None


async def delete_watch(watch_id: str, team_id: str):
    """Delete a watch and its associated leads."""
    client = get_client()
    if not client:
        return

    # Delete associated leads first
    client.table("discovered_leads").delete().eq(
        "watch_id", watch_id
    ).eq("team_id", team_id).execute()

    # Delete the watch
    client.table("subreddit_watches").delete().eq(
        "id", watch_id
    ).eq("team_id", team_id).execute()


# ============================================================================
# Watch Leads
# ============================================================================

async def get_watch_leads(
    watch_id: str, team_id: str,
    tier: str = None, relevance: str = None,
    limit: int = 50, offset: int = 0
) -> List[Dict[str, Any]]:
    """Get leads found by a specific watch."""
    client = get_client()
    if not client:
        return []

    query = client.table("discovered_leads").select("*").eq(
        "watch_id", watch_id
    ).eq("team_id", team_id)

    if tier:
        query = query.eq("lead_tier", tier)

    if relevance == "relevant":
        query = query.neq("lead_tier", "irrelevant")
    elif relevance == "irrelevant":
        query = query.eq("lead_tier", "irrelevant")

    query = query.order("created_at", desc=True).range(offset, offset + limit - 1)
    result = query.execute()

    return result.data or []


async def reset_new_leads_count(watch_id: str, team_id: str):
    """Reset the new_leads_since_last_view counter (called when user views leads)."""
    client = get_client()
    if not client:
        return

    client.table("subreddit_watches").update({
        "new_leads_since_last_view": 0,
        "updated_at": datetime.utcnow().isoformat(),
    }).eq("id", watch_id).eq("team_id", team_id).execute()


# ============================================================================
# Refresh Pipeline
# ============================================================================

async def refresh_watch(watch_id: str, team_id: str):
    """
    Refresh a single watch — fetch new posts, classify, store leads.
    This is the lightweight alternative to the full discovery pipeline.
    """
    client = get_client()
    if not client:
        logger.error("No database client available")
        return

    # 1. Load watch record
    watch = await get_watch(watch_id, team_id)
    if not watch:
        logger.error(f"Watch {watch_id} not found")
        return

    if watch["status"] == "paused":
        logger.info(f"Watch {watch_id} is paused, skipping refresh")
        return

    subreddit = watch["subreddit_name"]
    last_checked_at = watch.get("last_checked_at")

    # Convert last_checked_at to epoch for comparison
    last_checked_epoch = 0
    if last_checked_at:
        try:
            if isinstance(last_checked_at, str):
                dt = datetime.fromisoformat(last_checked_at.replace("Z", "+00:00"))
                last_checked_epoch = int(dt.timestamp())
            else:
                last_checked_epoch = int(last_checked_at.timestamp())
        except Exception:
            last_checked_epoch = 0

    # Mark as refreshing
    await update_watch(watch_id, team_id, {"status": "refreshing"})

    try:
        logger.info(f"Refreshing watch for r/{subreddit} (last checked: {last_checked_at or 'never'})")

        # 2. Load business settings for classification
        settings_result = client.table("user_settings").select("*").eq(
            "team_id", team_id
        ).execute()
        settings = {}
        if settings_result.data:
            s = settings_result.data[0]
            settings = {
                "businessDesc": s.get("business_desc", ""),
                "persona": s.get("persona", ""),
                "tone": s.get("tone", "Curious"),
                "insightTypes": s.get("insight_types", []),
            }

        if not settings.get("businessDesc"):
            logger.warning(f"No business settings for team {team_id}, skipping classification")
            await update_watch(watch_id, team_id, {"status": "active"})
            return

        # 3. Fetch recent posts via ScrapeCreators
        raw_posts = await reddit_search.get_subreddit_posts(
            subreddit=subreddit,
            sort="new",
            timeframe="week",
        )

        if not raw_posts:
            logger.info(f"No posts returned for r/{subreddit}")
            await update_watch(watch_id, team_id, {
                "status": "active",
                "last_checked_at": datetime.utcnow().isoformat(),
            })
            return

        # 4. Normalize and filter by time (only new posts since last check)
        new_posts = []
        seen_authors = set()

        # Pre-load own account usernames to exclude
        own_accounts_result = client.table("reddit_accounts").select(
            "username"
        ).eq("team_id", team_id).execute()
        own_usernames = set()
        for acc in (own_accounts_result.data or []):
            if acc.get("username"):
                own_usernames.add(acc["username"].lower())
        seen_authors.update(own_usernames)

        for raw_post in raw_posts:
            normalized = reddit_search.normalize_post(raw_post)
            post_url = normalized.get("url", "")
            author = normalized.get("author", "")
            created_utc = normalized.get("created_utc", 0)

            # Skip if no URL, no author, or deleted
            if not post_url or not author or author == "[deleted]":
                continue

            # Skip if older than last check
            if last_checked_epoch and created_utc and created_utc <= last_checked_epoch:
                continue

            # Skip duplicate authors within this batch
            if author.lower() in seen_authors:
                continue
            seen_authors.add(author.lower())

            new_posts.append(normalized)

        logger.info(f"r/{subreddit}: {len(new_posts)} new posts (from {len(raw_posts)} total)")

        if not new_posts:
            await update_watch(watch_id, team_id, {
                "status": "active",
                "last_checked_at": datetime.utcnow().isoformat(),
            })
            return

        # 5. Dedup against contacted users
        all_authors = [p["author"] for p in new_posts]
        contacted_set = await dedup.batch_check_contacted(all_authors, team_id)
        contacted_set.update(own_usernames)

        posts_to_classify = [
            p for p in new_posts
            if p["author"].lower().strip() not in contacted_set
        ]

        logger.info(
            f"r/{subreddit}: {len(posts_to_classify)} posts to classify "
            f"(skipped {len(new_posts) - len(posts_to_classify)} already contacted)"
        )

        if not posts_to_classify:
            await update_watch(watch_id, team_id, {
                "status": "active",
                "last_checked_at": datetime.utcnow().isoformat(),
                "total_posts_checked": (watch.get("total_posts_checked") or 0) + len(new_posts),
            })
            return

        # 6. Classify posts
        classifications = await classification_service.batch_classify_posts(
            posts_to_classify, settings
        )

        # 7. Score and store ALL leads (including irrelevant)
        leads_stored = 0
        relevant_leads = 0

        for i, post in enumerate(posts_to_classify):
            classification = classifications[i] if i < len(classifications) else {}
            is_irrelevant = (not classification or classification.get("category") == "not_relevant")

            relevance = classification.get("relevanceScore", 0) if classification else 0
            buyer_intent = classification.get("buyerIntent", 0) if classification else 0
            product_fit = classification.get("productFit", 0) if classification else 0
            confidence = classification.get("confidence", 0) if classification else 0
            score = round((relevance * 0.4) + (buyer_intent * 0.3) + (product_fit * 0.2) + (confidence * 0.1))

            if is_irrelevant:
                tier = "irrelevant"
            elif relevance >= 70 and buyer_intent >= 60:
                tier = "hot"
            elif relevance >= 50 or buyer_intent >= 40:
                tier = "warm"
            else:
                tier = "cold"

            try:
                # Store lead with watch_id (no session_id)
                insert_data = {
                    "team_id": team_id,
                    "watch_id": watch_id,
                    "post_url": post["url"],
                    "post_title": post.get("title", ""),
                    "post_body": post.get("body", "")[:2000],
                    "subreddit": subreddit,
                    "post_created_utc": post.get("created_utc", 0),
                    "author_username": post["author"],
                    "source_type": "watch",
                    "relevance_score": relevance,
                    "buyer_intent": buyer_intent,
                    "problem_awareness": classification.get("problemAwareness", 0) if classification else 0,
                    "product_fit": product_fit,
                    "confidence": confidence,
                    "classification_category": classification.get("category", "not_relevant") if classification else "not_relevant",
                    "classification_reasoning": classification.get("reasoning", "") if classification else "",
                    "is_qualified": not is_irrelevant and score >= 50,
                    "lead_score": score,
                    "lead_tier": tier,
                    "lead_insights": [{"type": "classification", "message": classification.get("reasoning", "") if classification else ""}],
                    "status": "scored",
                }

                client.table("discovered_leads").upsert(
                    insert_data,
                    on_conflict="watch_id,author_username,post_url"
                ).execute()

                leads_stored += 1
                if not is_irrelevant:
                    relevant_leads += 1
            except Exception as e:
                logger.warning(f"Failed to store watch lead u/{post['author']}: {e}")

        logger.info(f"r/{subreddit}: Stored {leads_stored} leads ({relevant_leads} relevant)")

        # 8. Update watch stats
        await update_watch(watch_id, team_id, {
            "status": "active",
            "last_checked_at": datetime.utcnow().isoformat(),
            "total_posts_checked": (watch.get("total_posts_checked") or 0) + len(new_posts),
            "total_leads_found": (watch.get("total_leads_found") or 0) + relevant_leads,
            "new_leads_since_last_view": (watch.get("new_leads_since_last_view") or 0) + relevant_leads,
        })

    except Exception as e:
        logger.error(f"Watch refresh failed for r/{subreddit}: {e}", exc_info=True)
        await update_watch(watch_id, team_id, {"status": "active"})


async def refresh_all_watches(team_id: str):
    """Refresh all active watches for a team."""
    watches = await get_watches(team_id)
    active_watches = [w for w in watches if w["status"] == "active"]

    logger.info(f"Refreshing {len(active_watches)} active watches for team {team_id}")

    for watch in active_watches:
        await refresh_watch(watch["id"], team_id)
