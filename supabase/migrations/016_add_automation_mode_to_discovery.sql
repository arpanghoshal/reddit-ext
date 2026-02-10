-- Migration 016: Add automation mode support to discovery_sessions
-- Allows the discovery pipeline to run in "automation" mode where it
-- auto-generates messages and auto-queues qualified leads.

ALTER TABLE public.discovery_sessions
ADD COLUMN IF NOT EXISTS mode text DEFAULT 'discovery' CHECK (mode IN ('discovery', 'automation')),
ADD COLUMN IF NOT EXISTS target_subreddits text[] DEFAULT '{}',
ADD COLUMN IF NOT EXISTS account_id uuid,
ADD COLUMN IF NOT EXISTS auto_queue boolean DEFAULT false,
ADD COLUMN IF NOT EXISTS auto_approve boolean DEFAULT false,
ADD COLUMN IF NOT EXISTS min_lead_score integer DEFAULT 50,
ADD COLUMN IF NOT EXISTS leads_queued integer DEFAULT 0,
ADD COLUMN IF NOT EXISTS leads_auto_approved integer DEFAULT 0;

-- Index for filtering automation sessions
CREATE INDEX IF NOT EXISTS idx_discovery_sessions_mode
ON public.discovery_sessions (mode)
WHERE mode = 'automation';
