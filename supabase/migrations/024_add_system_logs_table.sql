-- System-wide error/event logs from all components (backend, frontend, extension)
CREATE TABLE IF NOT EXISTS public.system_logs (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    created_at timestamptz NOT NULL DEFAULT now(),
    source text NOT NULL CHECK (source IN ('backend', 'frontend', 'extension')),
    level text NOT NULL CHECK (level IN ('debug', 'info', 'warn', 'error', 'fatal')),
    message text NOT NULL,
    -- Structured context
    team_id uuid REFERENCES public.teams(id) ON DELETE SET NULL,
    user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
    request_id text,
    -- Metadata
    component text,        -- e.g., 'background.js', 'Queue.jsx', 'queue.py'
    error_name text,       -- e.g., 'TypeError', 'NetworkError'
    error_stack text,      -- Stack trace if available
    metadata jsonb DEFAULT '{}'::jsonb,
    -- Client info
    browser_info text,
    url text,
    -- For automatic cleanup
    expires_at timestamptz NOT NULL DEFAULT (now() + interval '30 days')
);

-- Indexes for common queries
CREATE INDEX idx_system_logs_created_at ON public.system_logs(created_at DESC);
CREATE INDEX idx_system_logs_team_id ON public.system_logs(team_id) WHERE team_id IS NOT NULL;
CREATE INDEX idx_system_logs_level ON public.system_logs(level);
CREATE INDEX idx_system_logs_source ON public.system_logs(source);
CREATE INDEX idx_system_logs_request_id ON public.system_logs(request_id) WHERE request_id IS NOT NULL;
CREATE INDEX idx_system_logs_expires_at ON public.system_logs(expires_at);

-- RLS policies
ALTER TABLE public.system_logs ENABLE ROW LEVEL SECURITY;

-- Team members can read their team's logs
CREATE POLICY system_logs_select ON public.system_logs
    FOR SELECT USING (
        team_id IS NULL OR public.is_team_member(team_id)
    );

-- Service role (backend) can insert
CREATE POLICY system_logs_insert ON public.system_logs
    FOR INSERT WITH CHECK (true);

-- Cleanup function: delete logs older than their expiration
CREATE OR REPLACE FUNCTION public.cleanup_old_system_logs()
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    deleted_count bigint;
BEGIN
    DELETE FROM public.system_logs WHERE expires_at < now();
    GET DIAGNOSTICS deleted_count = ROW_COUNT;
    RETURN deleted_count;
END;
$$;
