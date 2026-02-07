-- Add message_type and conversation_id columns to dm_queue
-- Required for reply queue support (distinguishing outreach DMs from conversation replies)

ALTER TABLE public.dm_queue
  ADD COLUMN IF NOT EXISTS message_type text NOT NULL DEFAULT 'outreach',
  ADD COLUMN IF NOT EXISTS conversation_id uuid REFERENCES public.conversations(id);

-- Index for filtering by message_type (used by queue listing and stats)
CREATE INDEX IF NOT EXISTS idx_dm_queue_message_type ON public.dm_queue(message_type);

-- Index for looking up pending replies for a conversation
CREATE INDEX IF NOT EXISTS idx_dm_queue_conversation_id ON public.dm_queue(conversation_id);

-- Composite index for get_next_reply_to_send query
CREATE INDEX IF NOT EXISTS idx_dm_queue_reply_approved
  ON public.dm_queue(status, message_type, approved_at)
  WHERE status = 'approved' AND message_type = 'reply';
