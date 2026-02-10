-- Add message_reasoning column to discovered_leads
ALTER TABLE public.discovered_leads
ADD COLUMN IF NOT EXISTS message_reasoning text;
