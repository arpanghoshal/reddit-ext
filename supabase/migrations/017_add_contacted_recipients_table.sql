-- Migration 017: Add contacted_recipients table for permanent deduplication
-- Ensures no person is ever messaged twice by any account in the same team

-- 1. Create the contacted_recipients table
CREATE TABLE IF NOT EXISTS public.contacted_recipients (
    id uuid NOT NULL DEFAULT gen_random_uuid(),
    team_id uuid NOT NULL,
    recipient_username text NOT NULL,
    first_contacted_at timestamptz NOT NULL DEFAULT now(),
    first_contact_source text NOT NULL DEFAULT 'dm_queue',
    first_contact_account_id uuid,

    CONSTRAINT contacted_recipients_pkey PRIMARY KEY (id),
    CONSTRAINT contacted_recipients_team_id_fkey
        FOREIGN KEY (team_id) REFERENCES public.teams(id) ON DELETE CASCADE,
    CONSTRAINT contacted_recipients_account_id_fkey
        FOREIGN KEY (first_contact_account_id) REFERENCES public.reddit_accounts(id) ON DELETE SET NULL
);

-- The critical unique constraint: one entry per (team, recipient)
-- Note: all code paths lowercase recipient_username before insert,
-- so a direct column constraint works and is compatible with PostgREST upsert on_conflict.
-- Drop old expression-based index if it exists from a previous partial run
DROP INDEX IF EXISTS idx_contacted_recipients_team_username;
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'contacted_recipients_team_username_unique'
    ) THEN
        ALTER TABLE public.contacted_recipients
            ADD CONSTRAINT contacted_recipients_team_username_unique
            UNIQUE (team_id, recipient_username);
    END IF;
END $$;

-- Index for fast lookups by username (expression index for case-insensitive queries)
CREATE INDEX IF NOT EXISTS idx_contacted_recipients_username
    ON public.contacted_recipients (lower(recipient_username));

-- 2. Enable RLS
ALTER TABLE public.contacted_recipients ENABLE ROW LEVEL SECURITY;

-- Drop existing policies if they exist (idempotent re-run)
DROP POLICY IF EXISTS contacted_recipients_select ON public.contacted_recipients;
DROP POLICY IF EXISTS contacted_recipients_insert ON public.contacted_recipients;
DROP POLICY IF EXISTS contacted_recipients_delete ON public.contacted_recipients;

CREATE POLICY contacted_recipients_select ON public.contacted_recipients
    FOR SELECT USING (public.is_team_member(team_id));
CREATE POLICY contacted_recipients_insert ON public.contacted_recipients
    FOR INSERT WITH CHECK (public.is_team_member(team_id));
CREATE POLICY contacted_recipients_delete ON public.contacted_recipients
    FOR DELETE USING (public.is_team_member(team_id));

-- 3. Backfill from existing data

-- Backfill from dm_history (confirmed sends)
INSERT INTO public.contacted_recipients (team_id, recipient_username, first_contacted_at, first_contact_source, first_contact_account_id)
SELECT DISTINCT ON (team_id, lower(recipient_username))
    team_id, lower(recipient_username), created_at, 'dm_history', account_id
FROM public.dm_history
WHERE team_id IS NOT NULL AND recipient_username IS NOT NULL
ORDER BY team_id, lower(recipient_username), created_at ASC
ON CONFLICT DO NOTHING;

-- Backfill from dm_queue (sent items)
INSERT INTO public.contacted_recipients (team_id, recipient_username, first_contacted_at, first_contact_source, first_contact_account_id)
SELECT DISTINCT ON (team_id, lower(recipient_username))
    team_id, lower(recipient_username), COALESCE(sent_at, created_at), 'dm_queue', account_id
FROM public.dm_queue
WHERE team_id IS NOT NULL AND recipient_username IS NOT NULL AND status = 'sent'
ORDER BY team_id, lower(recipient_username), COALESCE(sent_at, created_at) ASC
ON CONFLICT DO NOTHING;

-- Backfill from conversations (established contact)
INSERT INTO public.contacted_recipients (team_id, recipient_username, first_contacted_at, first_contact_source, first_contact_account_id)
SELECT DISTINCT ON (team_id, lower(participant_username))
    team_id, lower(participant_username), created_at, 'conversations', account_id
FROM public.conversations
WHERE team_id IS NOT NULL AND participant_username IS NOT NULL
ORDER BY team_id, lower(participant_username), created_at ASC
ON CONFLICT DO NOTHING;
