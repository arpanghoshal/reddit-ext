-- Migration 019: Extend discovery for per-subreddit expansion + full post tracking
--
-- Changes:
-- 1. Allow 'irrelevant' as a lead_tier value
-- 2. Allow 'subreddit_expansion' as a source_type value
-- 3. Add expansion tracking columns to discovery_sessions and discovered_subreddits

-- 1. Extend lead_tier CHECK to include 'irrelevant'
ALTER TABLE public.discovered_leads
  DROP CONSTRAINT IF EXISTS discovered_leads_lead_tier_check;
ALTER TABLE public.discovered_leads
  ADD CONSTRAINT discovered_leads_lead_tier_check
  CHECK (lead_tier IN ('hot', 'warm', 'cold', 'irrelevant'));

-- 2. Extend source_type CHECK to include 'subreddit_expansion'
ALTER TABLE public.discovered_leads
  DROP CONSTRAINT IF EXISTS discovered_leads_source_type_check;
ALTER TABLE public.discovered_leads
  ADD CONSTRAINT discovered_leads_source_type_check
  CHECK (source_type IN ('post', 'comment', 'subreddit_expansion'));

-- 3. Add expansion tracking columns to discovery_sessions
ALTER TABLE public.discovery_sessions
  ADD COLUMN IF NOT EXISTS subreddit_posts_fetched integer DEFAULT 0,
  ADD COLUMN IF NOT EXISTS total_posts_irrelevant integer DEFAULT 0;

-- 4. Add expansion tracking column to discovered_subreddits
ALTER TABLE public.discovered_subreddits
  ADD COLUMN IF NOT EXISTS expansion_posts_fetched integer DEFAULT 0;
