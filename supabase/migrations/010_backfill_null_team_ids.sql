-- Migration 010: Backfill NULL team_id rows
-- Assigns orphaned records (team_id IS NULL) to the owner's personal team.
-- This fixes data that was inserted before team_id was consistently sent from the frontend.

-- For each table with nullable team_id, assign orphaned rows to the first
-- personal team found (there should only be one team in most single-user setups).
-- If multiple teams exist, this picks the personal team; if none, the first team.

DO $$
DECLARE
    v_default_team_id uuid;
BEGIN
    -- Find a default team to assign orphaned data to.
    -- Prefer the personal team; fall back to the first team created.
    SELECT id INTO v_default_team_id
    FROM public.teams
    WHERE is_personal = true
    ORDER BY created_at ASC
    LIMIT 1;

    IF v_default_team_id IS NULL THEN
        SELECT id INTO v_default_team_id
        FROM public.teams
        ORDER BY created_at ASC
        LIMIT 1;
    END IF;

    -- If no teams exist at all, skip the migration
    IF v_default_team_id IS NULL THEN
        RAISE NOTICE 'No teams found — skipping backfill';
        RETURN;
    END IF;

    RAISE NOTICE 'Backfilling NULL team_id rows with team %', v_default_team_id;

    -- Core data tables
    UPDATE public.dm_history SET team_id = v_default_team_id WHERE team_id IS NULL;
    UPDATE public.dm_queue SET team_id = v_default_team_id WHERE team_id IS NULL;
    UPDATE public.conversations SET team_id = v_default_team_id WHERE team_id IS NULL;
    UPDATE public.messages SET team_id = v_default_team_id WHERE team_id IS NULL;
    UPDATE public.reddit_accounts SET team_id = v_default_team_id WHERE team_id IS NULL;
    UPDATE public.automation_logs SET team_id = v_default_team_id WHERE team_id IS NULL;
    UPDATE public.user_settings SET team_id = v_default_team_id WHERE team_id IS NULL;
    UPDATE public.automation_settings SET team_id = v_default_team_id WHERE team_id IS NULL;
    UPDATE public.skipped_posts SET team_id = v_default_team_id WHERE team_id IS NULL;
    UPDATE public.safety_events SET team_id = v_default_team_id WHERE team_id IS NULL;
    UPDATE public.account_subreddit_assignments SET team_id = v_default_team_id WHERE team_id IS NULL;

    RAISE NOTICE 'Backfill complete';
END $$;
