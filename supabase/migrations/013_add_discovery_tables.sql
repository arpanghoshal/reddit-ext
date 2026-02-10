-- Migration 013: Add discovery tables for AI-powered lead discovery system
-- Tables: discovery_sessions, discovered_subreddits, discovered_leads

-- ============================================================================
-- Table: discovery_sessions
-- Tracks each discovery run (unit of work when user clicks "Start Discovery")
-- ============================================================================
CREATE TABLE IF NOT EXISTS public.discovery_sessions (
    id uuid NOT NULL DEFAULT gen_random_uuid(),
    team_id uuid NOT NULL,
    status text NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'searching', 'scoring', 'completed', 'failed', 'cancelled')),

    -- Input context (snapshot at time of discovery)
    business_desc text NOT NULL,
    target_persona text,
    tone text DEFAULT 'Curious',
    insight_types jsonb DEFAULT '[]'::jsonb,

    -- AI-generated search strategy
    search_strategy jsonb DEFAULT '{}'::jsonb,

    -- Progress tracking
    total_queries_planned integer DEFAULT 0,
    queries_completed integer DEFAULT 0,
    total_posts_found integer DEFAULT 0,
    total_leads_scored integer DEFAULT 0,
    leads_qualified integer DEFAULT 0,

    -- Timing
    started_at timestamptz,
    completed_at timestamptz,
    created_at timestamptz DEFAULT now(),
    updated_at timestamptz DEFAULT now(),

    CONSTRAINT discovery_sessions_pkey PRIMARY KEY (id),
    CONSTRAINT discovery_sessions_team_id_fkey FOREIGN KEY (team_id)
        REFERENCES public.teams(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_discovery_sessions_team_status
    ON public.discovery_sessions (team_id, status);
CREATE INDEX IF NOT EXISTS idx_discovery_sessions_team_created
    ON public.discovery_sessions (team_id, created_at DESC);

-- ============================================================================
-- Table: discovered_subreddits
-- Subreddits found per session with relevance metadata
-- ============================================================================
CREATE TABLE IF NOT EXISTS public.discovered_subreddits (
    id uuid NOT NULL DEFAULT gen_random_uuid(),
    session_id uuid NOT NULL,
    team_id uuid NOT NULL,

    subreddit_name text NOT NULL,
    subscriber_count integer,
    description text,
    relevance_reason text,
    relevance_score integer DEFAULT 50
        CHECK (relevance_score >= 0 AND relevance_score <= 100),

    posts_scanned integer DEFAULT 0,
    leads_found integer DEFAULT 0,
    status text DEFAULT 'discovered'
        CHECK (status IN ('discovered', 'scanning', 'scanned', 'dismissed')),

    created_at timestamptz DEFAULT now(),

    CONSTRAINT discovered_subreddits_pkey PRIMARY KEY (id),
    CONSTRAINT discovered_subreddits_session_id_fkey FOREIGN KEY (session_id)
        REFERENCES public.discovery_sessions(id) ON DELETE CASCADE,
    CONSTRAINT discovered_subreddits_team_id_fkey FOREIGN KEY (team_id)
        REFERENCES public.teams(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_discovered_subreddits_session
    ON public.discovered_subreddits (session_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_discovered_subreddits_session_sub
    ON public.discovered_subreddits (session_id, subreddit_name);

-- ============================================================================
-- Table: discovered_leads
-- Individual leads (post + author) found during discovery
-- ============================================================================
CREATE TABLE IF NOT EXISTS public.discovered_leads (
    id uuid NOT NULL DEFAULT gen_random_uuid(),
    session_id uuid NOT NULL,
    team_id uuid NOT NULL,
    discovered_subreddit_id uuid,

    -- Post data
    post_url text NOT NULL,
    post_title text,
    post_body text,
    subreddit text NOT NULL,
    post_created_utc bigint,

    -- Author data
    author_username text NOT NULL,

    -- Source type
    source_type text NOT NULL DEFAULT 'post'
        CHECK (source_type IN ('post', 'comment')),
    source_comment_body text,

    -- Classification scores
    relevance_score integer,
    buyer_intent integer,
    problem_awareness integer,
    product_fit integer,
    confidence integer,
    classification_category text,
    classification_reasoning text,

    -- Qualification scores
    is_qualified boolean,
    account_quality_score integer,
    engagement_score integer,

    -- Combined lead score
    lead_score numeric(5,1),
    lead_tier text CHECK (lead_tier IN ('hot', 'warm', 'cold')),
    lead_insights jsonb DEFAULT '[]'::jsonb,

    -- Status lifecycle
    status text DEFAULT 'discovered'
        CHECK (status IN ('discovered', 'scoring', 'scored', 'approved', 'queued', 'dismissed', 'already_contacted')),

    -- Generated message
    generated_message text,
    queue_item_id uuid,

    created_at timestamptz DEFAULT now(),
    updated_at timestamptz DEFAULT now(),

    CONSTRAINT discovered_leads_pkey PRIMARY KEY (id),
    CONSTRAINT discovered_leads_session_id_fkey FOREIGN KEY (session_id)
        REFERENCES public.discovery_sessions(id) ON DELETE CASCADE,
    CONSTRAINT discovered_leads_team_id_fkey FOREIGN KEY (team_id)
        REFERENCES public.teams(id) ON DELETE CASCADE,
    CONSTRAINT discovered_leads_subreddit_fkey FOREIGN KEY (discovered_subreddit_id)
        REFERENCES public.discovered_subreddits(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_discovered_leads_session
    ON public.discovered_leads (session_id);
CREATE INDEX IF NOT EXISTS idx_discovered_leads_session_tier
    ON public.discovered_leads (session_id, lead_tier, lead_score DESC);
CREATE INDEX IF NOT EXISTS idx_discovered_leads_team_status
    ON public.discovered_leads (team_id, status);
CREATE UNIQUE INDEX IF NOT EXISTS idx_discovered_leads_session_author_post
    ON public.discovered_leads (session_id, author_username, post_url);

-- ============================================================================
-- RLS Policies
-- ============================================================================

ALTER TABLE public.discovery_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.discovered_subreddits ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.discovered_leads ENABLE ROW LEVEL SECURITY;

-- discovery_sessions policies
CREATE POLICY discovery_sessions_select ON public.discovery_sessions
    FOR SELECT USING (public.is_team_member(team_id));
CREATE POLICY discovery_sessions_insert ON public.discovery_sessions
    FOR INSERT WITH CHECK (public.is_team_member(team_id));
CREATE POLICY discovery_sessions_update ON public.discovery_sessions
    FOR UPDATE USING (public.is_team_member(team_id));
CREATE POLICY discovery_sessions_delete ON public.discovery_sessions
    FOR DELETE USING (public.is_team_member(team_id));

-- discovered_subreddits policies
CREATE POLICY discovered_subreddits_select ON public.discovered_subreddits
    FOR SELECT USING (public.is_team_member(team_id));
CREATE POLICY discovered_subreddits_insert ON public.discovered_subreddits
    FOR INSERT WITH CHECK (public.is_team_member(team_id));
CREATE POLICY discovered_subreddits_update ON public.discovered_subreddits
    FOR UPDATE USING (public.is_team_member(team_id));
CREATE POLICY discovered_subreddits_delete ON public.discovered_subreddits
    FOR DELETE USING (public.is_team_member(team_id));

-- discovered_leads policies
CREATE POLICY discovered_leads_select ON public.discovered_leads
    FOR SELECT USING (public.is_team_member(team_id));
CREATE POLICY discovered_leads_insert ON public.discovered_leads
    FOR INSERT WITH CHECK (public.is_team_member(team_id));
CREATE POLICY discovered_leads_update ON public.discovered_leads
    FOR UPDATE USING (public.is_team_member(team_id));
CREATE POLICY discovered_leads_delete ON public.discovered_leads
    FOR DELETE USING (public.is_team_member(team_id));
