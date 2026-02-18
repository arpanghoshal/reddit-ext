-- Migration 023: Backfill NULL team_id on messages from their parent conversation
-- Fixes orphaned messages created by extension sync when X-Team-ID header was missing

UPDATE public.messages m
SET team_id = c.team_id
FROM public.conversations c
WHERE m.conversation_id = c.id
  AND m.team_id IS NULL
  AND c.team_id IS NOT NULL;
