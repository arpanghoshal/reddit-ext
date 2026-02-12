-- Migration 020: Add subreddit watches for monitoring/watch feature
--
-- Allows users to "watch" subreddits and periodically check for new posts.
-- Only processes posts newer than last_checked_at (delta processing).

-- 1. Create subreddit_watches table
CREATE TABLE IF NOT EXISTS public.subreddit_watches (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    team_id uuid NOT NULL REFERENCES public.teams(id),
    subreddit_name text NOT NULL,
    status text NOT NULL DEFAULT 'active'
        CHECK (status IN ('active', 'paused', 'refreshing')),
    last_checked_at timestamptz,
    total_posts_checked integer DEFAULT 0,
    total_leads_found integer DEFAULT 0,
    new_leads_since_last_view integer DEFAULT 0,
    created_at timestamptz DEFAULT now(),
    updated_at timestamptz DEFAULT now(),
    UNIQUE (team_id, subreddit_name)
);

-- 2. RLS policies
ALTER TABLE public.subreddit_watches ENABLE ROW LEVEL SECURITY;

CREATE POLICY "subreddit_watches_select" ON public.subreddit_watches
    FOR SELECT USING (public.is_team_member(team_id));

CREATE POLICY "subreddit_watches_insert" ON public.subreddit_watches
    FOR INSERT WITH CHECK (public.is_team_member(team_id));

CREATE POLICY "subreddit_watches_update" ON public.subreddit_watches
    FOR UPDATE USING (public.is_team_member(team_id));

CREATE POLICY "subreddit_watches_delete" ON public.subreddit_watches
    FOR DELETE USING (public.is_team_member(team_id));

-- 3. Indexes
CREATE INDEX IF NOT EXISTS idx_subreddit_watches_team
    ON public.subreddit_watches (team_id);
CREATE INDEX IF NOT EXISTS idx_subreddit_watches_team_status
    ON public.subreddit_watches (team_id, status);

-- 4. Make session_id nullable (watch leads have no session)
ALTER TABLE public.discovered_leads
    ALTER COLUMN session_id DROP NOT NULL;

-- Drop the existing FK constraint and re-add without NOT NULL enforcement
-- (The FK itself stays, just the column is now nullable)

-- 5. Extend discovered_leads source_type CHECK to allow 'watch'
ALTER TABLE public.discovered_leads
    DROP CONSTRAINT IF EXISTS discovered_leads_source_type_check;
ALTER TABLE public.discovered_leads
    ADD CONSTRAINT discovered_leads_source_type_check
    CHECK (source_type IN ('post', 'comment', 'subreddit_expansion', 'watch'));

-- 6. Add watch_id FK to discovered_leads (nullable)
ALTER TABLE public.discovered_leads
    ADD COLUMN IF NOT EXISTS watch_id uuid REFERENCES public.subreddit_watches(id);

-- 7. Index for fetching leads by watch
CREATE INDEX IF NOT EXISTS idx_discovered_leads_watch
    ON public.discovered_leads (watch_id) WHERE watch_id IS NOT NULL;

-- 8. Unique index for watch leads dedup (separate from session-based dedup)
CREATE UNIQUE INDEX IF NOT EXISTS idx_discovered_leads_watch_author_post
    ON public.discovered_leads (watch_id, author_username, post_url)
    WHERE watch_id IS NOT NULL;
