-- Migration 012: Fix fingerprint unique index for PostgREST compatibility
--
-- The partial unique index (WHERE fingerprint IS NOT NULL) from migration 011
-- cannot be matched by PostgREST's ON CONFLICT (conversation_id, fingerprint)
-- because PostgREST doesn't generate the required WHERE clause.
-- This causes all upsert operations to fail silently.
--
-- Fix: Replace with a full unique index. NULL fingerprints are treated as
-- distinct by PostgreSQL, so multiple NULL rows are still allowed.

-- Drop the partial unique index
DROP INDEX IF EXISTS idx_messages_conversation_fingerprint;

-- Create a full unique index (no WHERE clause)
CREATE UNIQUE INDEX idx_messages_conversation_fingerprint
ON public.messages (conversation_id, fingerprint);

-- Backfill any remaining NULL fingerprints (safety net)
UPDATE public.messages
SET fingerprint = left(encode(sha256(
    (lower(trim(content)) || '|' || direction)::bytea
), 'hex'), 16)
WHERE fingerprint IS NULL;
