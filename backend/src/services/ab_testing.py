"""
A/B Testing Service
Systematic experimentation framework for message optimization
"""

import os
import uuid
import math
import random
from datetime import datetime, timedelta
from typing import Dict, Any, List, Optional, Tuple
from supabase import create_client, Client

_supabase: Optional[Client] = None


def get_client() -> Optional[Client]:
    """Get or create Supabase client"""
    global _supabase
    if _supabase is None:
        url = os.getenv("SUPABASE_URL")
        key = os.getenv("SUPABASE_KEY")
        if url and key:
            _supabase = create_client(url, key)
    return _supabase


# =============================================================================
# EXPERIMENT MANAGEMENT
# =============================================================================

async def create_experiment(
    name: str,
    variants: List[Dict[str, Any]],
    target_metric: str = "reply_rate",
    minimum_sample: int = 100,
    confidence_level: float = 0.95,
    description: str = ""
) -> Dict[str, Any]:
    """
    Create a new A/B test experiment

    Args:
        name: Experiment name
        variants: List of message variants (each with id, name, template)
        target_metric: Metric to optimize (reply_rate, positive_sentiment, conversion)
        minimum_sample: Minimum samples per variant before analysis
        confidence_level: Required confidence level for significance
        description: Optional description

    Returns:
        Created experiment
    """
    client = get_client()

    experiment_id = str(uuid.uuid4())

    # Initialize variants with tracking data
    initialized_variants = []
    for i, v in enumerate(variants):
        initialized_variants.append({
            "id": v.get("id") or str(uuid.uuid4()),
            "name": v.get("name", f"Variant {chr(65 + i)}"),  # A, B, C...
            "template": v.get("template", ""),
            "weight": 1 / len(variants),  # Equal split initially
            "impressions": 0,
            "successes": 0,
            "failures": 0
        })

    experiment = {
        "id": experiment_id,
        "name": name,
        "description": description,
        "status": "running",
        "target_metric": target_metric,
        "minimum_sample": minimum_sample,
        "confidence_level": confidence_level,
        "variants": initialized_variants,
        "winner_variant_id": None,
        "created_at": datetime.utcnow().isoformat(),
        "completed_at": None
    }

    if client:
        try:
            result = client.table("ab_experiments").insert(experiment).execute()
            return result.data[0] if result.data else experiment
        except Exception as e:
            print(f"Error creating experiment: {e}")
            return experiment

    return experiment


async def get_experiment(experiment_id: str) -> Optional[Dict[str, Any]]:
    """Get an experiment by ID"""
    client = get_client()
    if not client:
        return None

    try:
        result = client.table("ab_experiments").select("*").eq(
            "id", experiment_id
        ).execute()

        return result.data[0] if result.data else None
    except Exception as e:
        print(f"Error fetching experiment: {e}")
        return None


async def get_active_experiments() -> List[Dict[str, Any]]:
    """Get all active experiments"""
    client = get_client()
    if not client:
        return []

    try:
        result = client.table("ab_experiments").select("*").eq(
            "status", "running"
        ).execute()

        return result.data if result.data else []
    except Exception as e:
        print(f"Error fetching active experiments: {e}")
        return []


async def update_experiment(
    experiment_id: str,
    updates: Dict[str, Any]
) -> Optional[Dict[str, Any]]:
    """Update an experiment"""
    client = get_client()
    if not client:
        return None

    try:
        result = client.table("ab_experiments").update(updates).eq(
            "id", experiment_id
        ).execute()

        return result.data[0] if result.data else None
    except Exception as e:
        print(f"Error updating experiment: {e}")
        return None


# =============================================================================
# VARIANT SELECTION - THOMPSON SAMPLING
# =============================================================================

def beta_sample(successes: int, failures: int) -> float:
    """
    Sample from Beta distribution for Thompson Sampling

    Uses the conjugate prior Beta(1,1) = Uniform(0,1)
    """
    alpha = successes + 1
    beta = failures + 1

    # Box-Muller approximation for Beta distribution
    # For larger samples, this is more efficient than direct sampling
    if alpha > 1 and beta > 1:
        # Use normal approximation for large alpha, beta
        mean = alpha / (alpha + beta)
        variance = (alpha * beta) / ((alpha + beta) ** 2 * (alpha + beta + 1))
        std = math.sqrt(variance)

        # Sample from normal and clamp to [0, 1]
        sample = random.gauss(mean, std)
        return max(0.0, min(1.0, sample))
    else:
        # Direct sampling for small alpha, beta
        # Using the ratio of gamma variates method
        x = sum(random.random() ** (1/alpha) for _ in range(int(alpha))) if alpha >= 1 else random.random() ** (1/max(alpha, 0.1))
        y = sum(random.random() ** (1/beta) for _ in range(int(beta))) if beta >= 1 else random.random() ** (1/max(beta, 0.1))

        if x + y > 0:
            return x / (x + y)
        return 0.5


async def select_variant(
    experiment_id: str,
    context: Dict[str, Any] = None
) -> Dict[str, Any]:
    """
    Select a variant using Thompson Sampling

    Args:
        experiment_id: Experiment ID
        context: Optional context for contextual bandits (future)

    Returns:
        Selected variant with template
    """
    experiment = await get_experiment(experiment_id)

    if not experiment:
        return {"error": "Experiment not found"}

    if experiment.get("status") != "running":
        return {"error": f"Experiment is {experiment.get('status')}"}

    variants = experiment.get("variants", [])

    if not variants:
        return {"error": "No variants in experiment"}

    # Thompson Sampling: sample from posterior for each variant
    samples = []
    for variant in variants:
        impressions = variant.get("impressions", 0)
        successes = variant.get("successes", 0)
        failures = impressions - successes

        sample = beta_sample(successes, failures)
        samples.append((variant, sample))

    # Select variant with highest sample
    selected_variant, _ = max(samples, key=lambda x: x[1])

    # Record impression
    await record_impression(experiment_id, selected_variant["id"])

    return {
        "variant_id": selected_variant["id"],
        "variant_name": selected_variant["name"],
        "template": selected_variant["template"],
        "experiment_id": experiment_id,
        "experiment_name": experiment.get("name")
    }


async def record_impression(experiment_id: str, variant_id: str) -> bool:
    """Record that a variant was shown"""
    client = get_client()
    if not client:
        return False

    try:
        experiment = await get_experiment(experiment_id)
        if not experiment:
            return False

        variants = experiment.get("variants", [])

        # Update the variant's impression count
        for v in variants:
            if v["id"] == variant_id:
                v["impressions"] = v.get("impressions", 0) + 1
                break

        await update_experiment(experiment_id, {"variants": variants})

        # Also log the event
        client.table("experiment_events").insert({
            "id": str(uuid.uuid4()),
            "experiment_id": experiment_id,
            "variant_id": variant_id,
            "event_type": "impression",
            "created_at": datetime.utcnow().isoformat()
        }).execute()

        return True
    except Exception as e:
        print(f"Error recording impression: {e}")
        return False


async def record_outcome(
    experiment_id: str,
    variant_id: str,
    success: bool,
    dm_id: str = None
) -> bool:
    """
    Record the outcome of a variant (success/failure)

    Args:
        experiment_id: Experiment ID
        variant_id: Variant ID
        success: Whether the variant was successful
        dm_id: Optional DM ID for tracking

    Returns:
        Success status
    """
    client = get_client()
    if not client:
        return False

    try:
        experiment = await get_experiment(experiment_id)
        if not experiment:
            return False

        variants = experiment.get("variants", [])

        # Update the variant's success/failure count
        for v in variants:
            if v["id"] == variant_id:
                if success:
                    v["successes"] = v.get("successes", 0) + 1
                else:
                    v["failures"] = v.get("failures", 0) + 1
                break

        await update_experiment(experiment_id, {"variants": variants})

        # Log the event
        client.table("experiment_events").insert({
            "id": str(uuid.uuid4()),
            "experiment_id": experiment_id,
            "variant_id": variant_id,
            "event_type": "success" if success else "failure",
            "dm_id": dm_id,
            "created_at": datetime.utcnow().isoformat()
        }).execute()

        # Check for statistical significance
        await check_and_complete_experiment(experiment_id)

        return True
    except Exception as e:
        print(f"Error recording outcome: {e}")
        return False


# =============================================================================
# STATISTICAL SIGNIFICANCE
# =============================================================================

def calculate_z_score(p1: float, p2: float, n1: int, n2: int) -> float:
    """Calculate Z-score for two proportions"""
    if n1 == 0 or n2 == 0:
        return 0

    # Pooled proportion
    p_pool = (p1 * n1 + p2 * n2) / (n1 + n2)

    if p_pool == 0 or p_pool == 1:
        return 0

    # Standard error
    se = math.sqrt(p_pool * (1 - p_pool) * (1/n1 + 1/n2))

    if se == 0:
        return 0

    return (p1 - p2) / se


def z_to_p_value(z: float) -> float:
    """Convert Z-score to p-value (two-tailed)"""
    # Approximation of the cumulative normal distribution
    def norm_cdf(x):
        # Approximation from Abramowitz and Stegun
        a1, a2, a3, a4, a5 = 0.254829592, -0.284496736, 1.421413741, -1.453152027, 1.061405429
        p = 0.3275911
        sign = 1 if x >= 0 else -1
        x = abs(x) / math.sqrt(2)
        t = 1.0 / (1.0 + p * x)
        y = 1.0 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * math.exp(-x * x)
        return 0.5 * (1.0 + sign * y)

    return 2 * (1 - norm_cdf(abs(z)))


async def check_statistical_significance(experiment_id: str) -> Dict[str, Any]:
    """
    Check if experiment has reached statistical significance

    Args:
        experiment_id: Experiment ID

    Returns:
        Significance analysis result
    """
    experiment = await get_experiment(experiment_id)

    if not experiment:
        return {"error": "Experiment not found"}

    variants = experiment.get("variants", [])
    minimum_sample = experiment.get("minimum_sample", 100)
    confidence_level = experiment.get("confidence_level", 0.95)

    if len(variants) < 2:
        return {"significant": False, "reason": "Need at least 2 variants"}

    # Check if minimum samples reached
    min_impressions = min(v.get("impressions", 0) for v in variants)

    if min_impressions < minimum_sample:
        samples_needed = minimum_sample - min_impressions
        return {
            "significant": False,
            "reason": "Minimum sample size not reached",
            "samples_needed": samples_needed,
            "current_min_samples": min_impressions
        }

    # Calculate conversion rates
    results = []
    for v in variants:
        impressions = v.get("impressions", 0)
        successes = v.get("successes", 0)
        rate = successes / max(impressions, 1)
        results.append({
            "variant_id": v["id"],
            "variant_name": v["name"],
            "impressions": impressions,
            "successes": successes,
            "conversion_rate": rate
        })

    # Sort by conversion rate (highest first)
    results.sort(key=lambda x: x["conversion_rate"], reverse=True)

    # Compare top two variants
    if len(results) >= 2:
        best = results[0]
        second = results[1]

        z_score = calculate_z_score(
            best["conversion_rate"],
            second["conversion_rate"],
            best["impressions"],
            second["impressions"]
        )

        p_value = z_to_p_value(z_score)
        significant = p_value < (1 - confidence_level)

        # Calculate lift
        if second["conversion_rate"] > 0:
            lift = (best["conversion_rate"] - second["conversion_rate"]) / second["conversion_rate"]
        else:
            lift = float('inf') if best["conversion_rate"] > 0 else 0

        return {
            "significant": significant,
            "p_value": round(p_value, 4),
            "z_score": round(z_score, 2),
            "confidence_level": confidence_level,
            "winner": best if significant else None,
            "lift": round(lift * 100, 2) if lift != float('inf') else "∞",
            "results": results
        }

    return {"significant": False, "reason": "Insufficient data"}


async def check_and_complete_experiment(experiment_id: str) -> bool:
    """Check significance and complete experiment if reached"""
    significance = await check_statistical_significance(experiment_id)

    if significance.get("significant"):
        winner = significance.get("winner")

        if winner:
            await update_experiment(experiment_id, {
                "status": "completed",
                "winner_variant_id": winner["variant_id"],
                "completed_at": datetime.utcnow().isoformat()
            })

            print(f"Experiment {experiment_id} completed. Winner: {winner['variant_name']}")
            return True

    return False


# =============================================================================
# EXPERIMENT ANALYTICS
# =============================================================================

async def get_experiment_stats(experiment_id: str) -> Dict[str, Any]:
    """Get detailed statistics for an experiment"""
    experiment = await get_experiment(experiment_id)

    if not experiment:
        return {"error": "Experiment not found"}

    variants = experiment.get("variants", [])

    # Calculate stats for each variant
    variant_stats = []
    total_impressions = sum(v.get("impressions", 0) for v in variants)

    for v in variants:
        impressions = v.get("impressions", 0)
        successes = v.get("successes", 0)
        failures = v.get("failures", 0)

        rate = successes / max(impressions, 1)

        # Calculate confidence interval (Wilson score interval)
        if impressions > 0:
            z = 1.96  # 95% confidence
            phat = successes / impressions
            denominator = 1 + z*z/impressions
            center = (phat + z*z/(2*impressions)) / denominator
            margin = z * math.sqrt((phat*(1-phat) + z*z/(4*impressions))/impressions) / denominator
            ci_lower = max(0, center - margin)
            ci_upper = min(1, center + margin)
        else:
            ci_lower, ci_upper = 0, 1

        variant_stats.append({
            "id": v["id"],
            "name": v["name"],
            "impressions": impressions,
            "successes": successes,
            "failures": failures,
            "conversion_rate": round(rate * 100, 2),
            "confidence_interval": [round(ci_lower * 100, 2), round(ci_upper * 100, 2)],
            "traffic_percentage": round(impressions / max(total_impressions, 1) * 100, 1)
        })

    # Sort by conversion rate
    variant_stats.sort(key=lambda x: x["conversion_rate"], reverse=True)

    # Check significance
    significance = await check_statistical_significance(experiment_id)

    return {
        "experiment": {
            "id": experiment.get("id"),
            "name": experiment.get("name"),
            "status": experiment.get("status"),
            "target_metric": experiment.get("target_metric"),
            "created_at": experiment.get("created_at")
        },
        "total_impressions": total_impressions,
        "variant_stats": variant_stats,
        "significance": significance,
        "winner": significance.get("winner") if significance.get("significant") else None
    }


async def pause_experiment(experiment_id: str) -> Dict[str, Any]:
    """Pause a running experiment"""
    result = await update_experiment(experiment_id, {"status": "paused"})
    return {"success": result is not None, "status": "paused"}


async def resume_experiment(experiment_id: str) -> Dict[str, Any]:
    """Resume a paused experiment"""
    result = await update_experiment(experiment_id, {"status": "running"})
    return {"success": result is not None, "status": "running"}


async def archive_experiment(experiment_id: str) -> Dict[str, Any]:
    """Archive a completed experiment"""
    result = await update_experiment(experiment_id, {"status": "archived"})
    return {"success": result is not None, "status": "archived"}


# =============================================================================
# AUTO-PROMOTION
# =============================================================================

async def promote_winner_to_template(experiment_id: str) -> Dict[str, Any]:
    """
    Promote winning variant to a new template

    Args:
        experiment_id: Experiment ID

    Returns:
        Promotion result
    """
    experiment = await get_experiment(experiment_id)

    if not experiment:
        return {"error": "Experiment not found"}

    if experiment.get("status") != "completed":
        return {"error": "Experiment not completed yet"}

    winner_id = experiment.get("winner_variant_id")
    if not winner_id:
        return {"error": "No winner declared"}

    # Find winner variant
    winner = None
    for v in experiment.get("variants", []):
        if v["id"] == winner_id:
            winner = v
            break

    if not winner:
        return {"error": "Winner variant not found"}

    # Calculate performance metrics
    impressions = winner.get("impressions", 0)
    successes = winner.get("successes", 0)
    rate = successes / max(impressions, 1)

    # In a real implementation, this would create a new template
    # For now, return the promotion data
    return {
        "promoted": True,
        "template": {
            "name": f"Winner: {experiment.get('name')}",
            "content": winner.get("template"),
            "source_experiment": experiment_id,
            "performance": {
                "conversion_rate": round(rate * 100, 2),
                "sample_size": impressions,
                "successes": successes
            }
        }
    }
