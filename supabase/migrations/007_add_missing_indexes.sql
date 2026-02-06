-- Migration 007: Add missing foreign key indexes and composite indexes
-- These indexes improve query performance for common access patterns

-- =============================================================================
-- MISSING FOREIGN KEY INDEXES
-- Foreign keys without indexes cause slow JOINs and cascade operations
-- =============================================================================

-- conversations
CREATE INDEX IF NOT EXISTS idx_conversations_account_id
  ON public.conversations (account_id);

-- dm_history
CREATE INDEX IF NOT EXISTS idx_dm_history_account_id
  ON public.dm_history (account_id);
CREATE INDEX IF NOT EXISTS idx_dm_history_campaign_id
  ON public.dm_history (campaign_id);

-- dm_queue
CREATE INDEX IF NOT EXISTS idx_dm_queue_account_id
  ON public.dm_queue (account_id);

-- messages
CREATE INDEX IF NOT EXISTS idx_messages_conversation_id
  ON public.messages (conversation_id);

-- lead_funnel
CREATE INDEX IF NOT EXISTS idx_lead_funnel_campaign_id
  ON public.lead_funnel (campaign_id);
CREATE INDEX IF NOT EXISTS idx_lead_funnel_account_id
  ON public.lead_funnel (account_id);

-- safety_events
CREATE INDEX IF NOT EXISTS idx_safety_events_account_id
  ON public.safety_events (account_id);

-- skipped_posts
CREATE INDEX IF NOT EXISTS idx_skipped_posts_campaign_id
  ON public.skipped_posts (campaign_id);

-- account_subreddit_assignments
CREATE INDEX IF NOT EXISTS idx_account_subreddit_assignments_account_id
  ON public.account_subreddit_assignments (account_id);

-- =============================================================================
-- COMPOSITE INDEXES FOR COMMON QUERY PATTERNS
-- =============================================================================

-- Queue: "Get pending DMs for team ordered by schedule time"
CREATE INDEX IF NOT EXISTS idx_dm_queue_team_status_scheduled
  ON public.dm_queue (team_id, status, scheduled_at)
  WHERE status IN ('pending', 'approved');

-- DM History: "Get recent DMs for team"
CREATE INDEX IF NOT EXISTS idx_dm_history_team_created
  ON public.dm_history (team_id, created_at DESC);

-- Conversations: "Get active conversations sorted by recent activity"
CREATE INDEX IF NOT EXISTS idx_conversations_team_status_last_msg
  ON public.conversations (team_id, status, last_message_at DESC);

-- Campaigns: "Get active campaigns for team"
CREATE INDEX IF NOT EXISTS idx_campaigns_team_status
  ON public.campaigns (team_id, status);

-- Messages: "Get messages for a conversation in order"
CREATE INDEX IF NOT EXISTS idx_messages_conversation_sent
  ON public.messages (conversation_id, sent_at);

-- Skipped Posts: "Get recent skipped posts for team"
CREATE INDEX IF NOT EXISTS idx_skipped_posts_team_created
  ON public.skipped_posts (team_id, created_at DESC);

-- =============================================================================
-- ADD NOT NULL CONSTRAINTS TO team_id COLUMNS
-- All multi-tenant tables should require team_id
-- =============================================================================

-- Only add NOT NULL where data already has team_id populated
-- Use ALTER TABLE ... ALTER COLUMN ... SET NOT NULL
-- NOTE: Run these only after backfilling any NULL team_id values

-- These are commented out for safety - uncomment after verifying no NULL values exist:
-- ALTER TABLE public.dm_history ALTER COLUMN team_id SET NOT NULL;
-- ALTER TABLE public.dm_queue ALTER COLUMN team_id SET NOT NULL;
-- ALTER TABLE public.conversations ALTER COLUMN team_id SET NOT NULL;
-- ALTER TABLE public.messages ALTER COLUMN team_id SET NOT NULL;
-- ALTER TABLE public.campaigns ALTER COLUMN team_id SET NOT NULL;
-- ALTER TABLE public.filter_rules ALTER COLUMN team_id SET NOT NULL;
-- ALTER TABLE public.reddit_accounts ALTER COLUMN team_id SET NOT NULL;
-- ALTER TABLE public.automation_settings ALTER COLUMN team_id SET NOT NULL;
-- ALTER TABLE public.automation_logs ALTER COLUMN team_id SET NOT NULL;
-- ALTER TABLE public.safety_events ALTER COLUMN team_id SET NOT NULL;
-- ALTER TABLE public.skipped_posts ALTER COLUMN team_id SET NOT NULL;
-- ALTER TABLE public.post_classifications ALTER COLUMN team_id SET NOT NULL;
-- ALTER TABLE public.user_profiles ALTER COLUMN team_id SET NOT NULL;
-- ALTER TABLE public.user_qualifications ALTER COLUMN team_id SET NOT NULL;
-- ALTER TABLE public.user_settings ALTER COLUMN team_id SET NOT NULL;
-- ALTER TABLE public.lead_funnel ALTER COLUMN team_id SET NOT NULL;
-- ALTER TABLE public.account_subreddit_assignments ALTER COLUMN team_id SET NOT NULL;
