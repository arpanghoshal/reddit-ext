-- Migration 021: Sustainable Discovery
-- Adds timeframe control, yield tracking, query history, URL dedup index,
-- and unblocks the watch system by making session_id nullable.

-- 1. Allow watch-sourced leads (watch.py inserts without session_id)
ALTER TABLE public.discovered_leads ALTER COLUMN session_id DROP NOT NULL;

-- 2. Timeframe control on discovery sessions
ALTER TABLE public.discovery_sessions
  ADD COLUMN IF NOT EXISTS timeframe text DEFAULT 'w',
  ADD COLUMN IF NOT EXISTS timeframe_start date,
  ADD COLUMN IF NOT EXISTS timeframe_end date;

-- 3. Yield tracking on sessions
ALTER TABLE public.discovery_sessions
  ADD COLUMN IF NOT EXISTS duplicate_posts_skipped integer DEFAULT 0,
  ADD COLUMN IF NOT EXISTS yield_rate numeric(5,2);

-- 4. Query history table for query evolution
CREATE TABLE IF NOT EXISTS public.discovery_query_history (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    team_id uuid NOT NULL REFERENCES public.teams(id),
    query_text text NOT NULL,
    times_used integer DEFAULT 1,
    total_leads_found integer DEFAULT 0,
    last_used_at timestamptz DEFAULT now(),
    created_at timestamptz DEFAULT now(),
    UNIQUE (team_id, query_text)
);

ALTER TABLE public.discovery_query_history ENABLE ROW LEVEL SECURITY;

CREATE POLICY "dqh_select" ON public.discovery_query_history
    FOR SELECT USING (public.is_team_member(team_id));
CREATE POLICY "dqh_insert" ON public.discovery_query_history
    FOR INSERT WITH CHECK (public.is_team_member(team_id));
CREATE POLICY "dqh_update" ON public.discovery_query_history
    FOR UPDATE USING (public.is_team_member(team_id));
CREATE POLICY "dqh_delete" ON public.discovery_query_history
    FOR DELETE USING (public.is_team_member(team_id));

CREATE INDEX IF NOT EXISTS idx_dqh_team
    ON public.discovery_query_history(team_id);

-- 5. Index for cross-session URL dedup lookups
CREATE INDEX IF NOT EXISTS idx_discovered_leads_team_post_url
    ON public.discovered_leads(team_id, post_url);
