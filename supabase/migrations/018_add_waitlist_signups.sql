-- Migration 018: Add waitlist_signups table for QualyDM launch waitlist

CREATE TABLE IF NOT EXISTS public.waitlist_signups (
    id uuid NOT NULL DEFAULT gen_random_uuid(),
    email text NOT NULL,
    source text DEFAULT 'landing_page',
    referrer text,
    created_at timestamptz DEFAULT now(),

    CONSTRAINT waitlist_signups_pkey PRIMARY KEY (id)
);

-- Prevent duplicate emails (case-insensitive)
CREATE UNIQUE INDEX IF NOT EXISTS idx_waitlist_signups_email
    ON public.waitlist_signups (lower(email));

-- Enable RLS
ALTER TABLE public.waitlist_signups ENABLE ROW LEVEL SECURITY;

-- Public INSERT-only policy (anon key can insert, no read/update/delete)
CREATE POLICY waitlist_signups_insert ON public.waitlist_signups
    FOR INSERT WITH CHECK (true);
