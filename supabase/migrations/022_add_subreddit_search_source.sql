-- Migration 022: Add 'subreddit_search' to discovered_leads source_type
-- This supports the new dual-source discovery pipeline that searches
-- subreddits via ScrapeCreators API alongside SerpAPI.

ALTER TABLE public.discovered_leads
  DROP CONSTRAINT IF EXISTS discovered_leads_source_type_check;

ALTER TABLE public.discovered_leads
  ADD CONSTRAINT discovered_leads_source_type_check
  CHECK (source_type IN ('post', 'comment', 'subreddit_expansion', 'watch', 'subreddit_search'));
