-- Migration 011: Add fingerprint column to messages for deduplication
-- Prevents duplicate messages from concurrent sync operations

-- Add fingerprint column
ALTER TABLE public.messages ADD COLUMN IF NOT EXISTS fingerprint text;

-- Backfill fingerprints for existing messages using content + direction
UPDATE public.messages
SET fingerprint = left(encode(sha256(
    (lower(trim(content)) || '|' || direction)::bytea
), 'hex'), 16)
WHERE fingerprint IS NULL;

-- Clean up existing duplicates BEFORE adding the unique constraint
-- Keep the earliest message for each (conversation_id, fingerprint) pair
DELETE FROM public.messages a
USING public.messages b
WHERE a.conversation_id = b.conversation_id
  AND a.fingerprint = b.fingerprint
  AND a.fingerprint IS NOT NULL
  AND a.created_at > b.created_at;

-- Add unique index per conversation to prevent duplicate inserts
CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_conversation_fingerprint
ON public.messages (conversation_id, fingerprint)
WHERE fingerprint IS NOT NULL;
