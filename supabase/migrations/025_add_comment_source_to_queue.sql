-- Migration 025: Add source_type and source_comment_body to dm_queue
-- Ensures comment-sourced leads preserve the original comment text through the queue pipeline

ALTER TABLE public.dm_queue
    ADD COLUMN IF NOT EXISTS source_type text NOT NULL DEFAULT 'post'
        CHECK (source_type IN ('post', 'comment')),
    ADD COLUMN IF NOT EXISTS source_comment_body text;
