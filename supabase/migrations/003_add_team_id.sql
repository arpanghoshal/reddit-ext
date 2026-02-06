-- Migration: Add team_id to existing tables for multi-tenancy
-- This migration adds team_id column and RLS policies to existing data tables
-- Updated to match actual schema (dm_queue, filter_rules, etc.)

-- =====================================================
-- Add team_id to all data tables
-- =====================================================

-- Add team_id to dm_history
ALTER TABLE public.dm_history ADD COLUMN IF NOT EXISTS team_id uuid REFERENCES public.teams(id);
CREATE INDEX IF NOT EXISTS idx_dm_history_team_id ON public.dm_history(team_id);

-- Add team_id to automation_logs
ALTER TABLE public.automation_logs ADD COLUMN IF NOT EXISTS team_id uuid REFERENCES public.teams(id);
CREATE INDEX IF NOT EXISTS idx_automation_logs_team_id ON public.automation_logs(team_id);

-- Add team_id to automation_settings
ALTER TABLE public.automation_settings ADD COLUMN IF NOT EXISTS team_id uuid REFERENCES public.teams(id);
CREATE INDEX IF NOT EXISTS idx_automation_settings_team_id ON public.automation_settings(team_id);

-- Add team_id to user_settings
ALTER TABLE public.user_settings ADD COLUMN IF NOT EXISTS team_id uuid REFERENCES public.teams(id);
CREATE INDEX IF NOT EXISTS idx_user_settings_team_id ON public.user_settings(team_id);

-- Add team_id to conversations
ALTER TABLE public.conversations ADD COLUMN IF NOT EXISTS team_id uuid REFERENCES public.teams(id);
CREATE INDEX IF NOT EXISTS idx_conversations_team_id ON public.conversations(team_id);

-- Add team_id to messages
ALTER TABLE public.messages ADD COLUMN IF NOT EXISTS team_id uuid REFERENCES public.teams(id);
CREATE INDEX IF NOT EXISTS idx_messages_team_id ON public.messages(team_id);

-- Add team_id to reddit_accounts
ALTER TABLE public.reddit_accounts ADD COLUMN IF NOT EXISTS team_id uuid REFERENCES public.teams(id);
CREATE INDEX IF NOT EXISTS idx_reddit_accounts_team_id ON public.reddit_accounts(team_id);

-- Add team_id to dm_queue (your queue table)
ALTER TABLE public.dm_queue ADD COLUMN IF NOT EXISTS team_id uuid REFERENCES public.teams(id);
CREATE INDEX IF NOT EXISTS idx_dm_queue_team_id ON public.dm_queue(team_id);

-- Add team_id to filter_rules (your rules table)
ALTER TABLE public.filter_rules ADD COLUMN IF NOT EXISTS team_id uuid REFERENCES public.teams(id);
CREATE INDEX IF NOT EXISTS idx_filter_rules_team_id ON public.filter_rules(team_id);

-- Add team_id to campaigns
ALTER TABLE public.campaigns ADD COLUMN IF NOT EXISTS team_id uuid REFERENCES public.teams(id);
CREATE INDEX IF NOT EXISTS idx_campaigns_team_id ON public.campaigns(team_id);

-- Add team_id to post_classifications
ALTER TABLE public.post_classifications ADD COLUMN IF NOT EXISTS team_id uuid REFERENCES public.teams(id);
CREATE INDEX IF NOT EXISTS idx_post_classifications_team_id ON public.post_classifications(team_id);

-- Add team_id to account_subreddit_assignments
ALTER TABLE public.account_subreddit_assignments ADD COLUMN IF NOT EXISTS team_id uuid REFERENCES public.teams(id);
CREATE INDEX IF NOT EXISTS idx_account_subreddit_assignments_team_id ON public.account_subreddit_assignments(team_id);

-- Add team_id to skipped_posts
ALTER TABLE public.skipped_posts ADD COLUMN IF NOT EXISTS team_id uuid REFERENCES public.teams(id);
CREATE INDEX IF NOT EXISTS idx_skipped_posts_team_id ON public.skipped_posts(team_id);

-- Add team_id to lead_funnel
ALTER TABLE public.lead_funnel ADD COLUMN IF NOT EXISTS team_id uuid REFERENCES public.teams(id);
CREATE INDEX IF NOT EXISTS idx_lead_funnel_team_id ON public.lead_funnel(team_id);

-- Add team_id to safety_events
ALTER TABLE public.safety_events ADD COLUMN IF NOT EXISTS team_id uuid REFERENCES public.teams(id);
CREATE INDEX IF NOT EXISTS idx_safety_events_team_id ON public.safety_events(team_id);

-- Add team_id to user_profiles
ALTER TABLE public.user_profiles ADD COLUMN IF NOT EXISTS team_id uuid REFERENCES public.teams(id);
CREATE INDEX IF NOT EXISTS idx_user_profiles_team_id ON public.user_profiles(team_id);

-- Add team_id to user_qualifications
ALTER TABLE public.user_qualifications ADD COLUMN IF NOT EXISTS team_id uuid REFERENCES public.teams(id);
CREATE INDEX IF NOT EXISTS idx_user_qualifications_team_id ON public.user_qualifications(team_id);

-- =====================================================
-- Enable RLS on all tables
-- =====================================================
ALTER TABLE public.dm_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.automation_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.automation_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.conversations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.reddit_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.dm_queue ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.filter_rules ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.campaigns ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.post_classifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.account_subreddit_assignments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.skipped_posts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.lead_funnel ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.safety_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_qualifications ENABLE ROW LEVEL SECURITY;

-- =====================================================
-- Helper function to check if user is team member
-- =====================================================
CREATE OR REPLACE FUNCTION public.is_team_member(check_team_id uuid)
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
STABLE
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.team_members
    WHERE team_id = check_team_id AND user_id = auth.uid()
  );
$$;

-- =====================================================
-- RLS Policies for dm_history
-- =====================================================
DROP POLICY IF EXISTS "Team members can view dm_history" ON public.dm_history;
CREATE POLICY "Team members can view dm_history"
  ON public.dm_history FOR SELECT
  USING (public.is_team_member(team_id));

DROP POLICY IF EXISTS "Team members can insert dm_history" ON public.dm_history;
CREATE POLICY "Team members can insert dm_history"
  ON public.dm_history FOR INSERT
  WITH CHECK (public.is_team_member(team_id));

DROP POLICY IF EXISTS "Team members can manage dm_history" ON public.dm_history;
CREATE POLICY "Team members can manage dm_history"
  ON public.dm_history FOR ALL
  USING (public.is_team_member(team_id));

-- =====================================================
-- RLS Policies for automation_logs
-- =====================================================
DROP POLICY IF EXISTS "Team members can view automation_logs" ON public.automation_logs;
CREATE POLICY "Team members can view automation_logs"
  ON public.automation_logs FOR SELECT
  USING (public.is_team_member(team_id));

DROP POLICY IF EXISTS "Team members can manage automation_logs" ON public.automation_logs;
CREATE POLICY "Team members can manage automation_logs"
  ON public.automation_logs FOR ALL
  USING (public.is_team_member(team_id));

-- =====================================================
-- RLS Policies for automation_settings
-- =====================================================
DROP POLICY IF EXISTS "Team members can view automation_settings" ON public.automation_settings;
CREATE POLICY "Team members can view automation_settings"
  ON public.automation_settings FOR SELECT
  USING (public.is_team_member(team_id));

DROP POLICY IF EXISTS "Team members can manage automation_settings" ON public.automation_settings;
CREATE POLICY "Team members can manage automation_settings"
  ON public.automation_settings FOR ALL
  USING (public.is_team_member(team_id));

-- =====================================================
-- RLS Policies for user_settings
-- =====================================================
DROP POLICY IF EXISTS "Team members can view user_settings" ON public.user_settings;
CREATE POLICY "Team members can view user_settings"
  ON public.user_settings FOR SELECT
  USING (public.is_team_member(team_id));

DROP POLICY IF EXISTS "Team members can manage user_settings" ON public.user_settings;
CREATE POLICY "Team members can manage user_settings"
  ON public.user_settings FOR ALL
  USING (public.is_team_member(team_id));

-- =====================================================
-- RLS Policies for conversations
-- =====================================================
DROP POLICY IF EXISTS "Team members can view conversations" ON public.conversations;
CREATE POLICY "Team members can view conversations"
  ON public.conversations FOR SELECT
  USING (public.is_team_member(team_id));

DROP POLICY IF EXISTS "Team members can manage conversations" ON public.conversations;
CREATE POLICY "Team members can manage conversations"
  ON public.conversations FOR ALL
  USING (public.is_team_member(team_id));

-- =====================================================
-- RLS Policies for messages
-- =====================================================
DROP POLICY IF EXISTS "Team members can view messages" ON public.messages;
CREATE POLICY "Team members can view messages"
  ON public.messages FOR SELECT
  USING (public.is_team_member(team_id));

DROP POLICY IF EXISTS "Team members can manage messages" ON public.messages;
CREATE POLICY "Team members can manage messages"
  ON public.messages FOR ALL
  USING (public.is_team_member(team_id));

-- =====================================================
-- RLS Policies for reddit_accounts
-- =====================================================
DROP POLICY IF EXISTS "Team members can view reddit_accounts" ON public.reddit_accounts;
CREATE POLICY "Team members can view reddit_accounts"
  ON public.reddit_accounts FOR SELECT
  USING (public.is_team_member(team_id));

DROP POLICY IF EXISTS "Team members can manage reddit_accounts" ON public.reddit_accounts;
CREATE POLICY "Team members can manage reddit_accounts"
  ON public.reddit_accounts FOR ALL
  USING (public.is_team_member(team_id));

-- =====================================================
-- RLS Policies for dm_queue
-- =====================================================
DROP POLICY IF EXISTS "Team members can view dm_queue" ON public.dm_queue;
CREATE POLICY "Team members can view dm_queue"
  ON public.dm_queue FOR SELECT
  USING (public.is_team_member(team_id));

DROP POLICY IF EXISTS "Team members can manage dm_queue" ON public.dm_queue;
CREATE POLICY "Team members can manage dm_queue"
  ON public.dm_queue FOR ALL
  USING (public.is_team_member(team_id));

-- =====================================================
-- RLS Policies for filter_rules
-- =====================================================
DROP POLICY IF EXISTS "Team members can view filter_rules" ON public.filter_rules;
CREATE POLICY "Team members can view filter_rules"
  ON public.filter_rules FOR SELECT
  USING (public.is_team_member(team_id));

DROP POLICY IF EXISTS "Team members can manage filter_rules" ON public.filter_rules;
CREATE POLICY "Team members can manage filter_rules"
  ON public.filter_rules FOR ALL
  USING (public.is_team_member(team_id));

-- =====================================================
-- RLS Policies for campaigns
-- =====================================================
DROP POLICY IF EXISTS "Team members can view campaigns" ON public.campaigns;
CREATE POLICY "Team members can view campaigns"
  ON public.campaigns FOR SELECT
  USING (public.is_team_member(team_id));

DROP POLICY IF EXISTS "Team members can manage campaigns" ON public.campaigns;
CREATE POLICY "Team members can manage campaigns"
  ON public.campaigns FOR ALL
  USING (public.is_team_member(team_id));

-- =====================================================
-- RLS Policies for post_classifications
-- =====================================================
DROP POLICY IF EXISTS "Team members can view post_classifications" ON public.post_classifications;
CREATE POLICY "Team members can view post_classifications"
  ON public.post_classifications FOR SELECT
  USING (public.is_team_member(team_id));

DROP POLICY IF EXISTS "Team members can manage post_classifications" ON public.post_classifications;
CREATE POLICY "Team members can manage post_classifications"
  ON public.post_classifications FOR ALL
  USING (public.is_team_member(team_id));

-- =====================================================
-- RLS Policies for account_subreddit_assignments
-- =====================================================
DROP POLICY IF EXISTS "Team members can view account_subreddit_assignments" ON public.account_subreddit_assignments;
CREATE POLICY "Team members can view account_subreddit_assignments"
  ON public.account_subreddit_assignments FOR SELECT
  USING (public.is_team_member(team_id));

DROP POLICY IF EXISTS "Team members can manage account_subreddit_assignments" ON public.account_subreddit_assignments;
CREATE POLICY "Team members can manage account_subreddit_assignments"
  ON public.account_subreddit_assignments FOR ALL
  USING (public.is_team_member(team_id));

-- =====================================================
-- RLS Policies for skipped_posts
-- =====================================================
DROP POLICY IF EXISTS "Team members can view skipped_posts" ON public.skipped_posts;
CREATE POLICY "Team members can view skipped_posts"
  ON public.skipped_posts FOR SELECT
  USING (public.is_team_member(team_id));

DROP POLICY IF EXISTS "Team members can manage skipped_posts" ON public.skipped_posts;
CREATE POLICY "Team members can manage skipped_posts"
  ON public.skipped_posts FOR ALL
  USING (public.is_team_member(team_id));

-- =====================================================
-- RLS Policies for lead_funnel
-- =====================================================
DROP POLICY IF EXISTS "Team members can view lead_funnel" ON public.lead_funnel;
CREATE POLICY "Team members can view lead_funnel"
  ON public.lead_funnel FOR SELECT
  USING (public.is_team_member(team_id));

DROP POLICY IF EXISTS "Team members can manage lead_funnel" ON public.lead_funnel;
CREATE POLICY "Team members can manage lead_funnel"
  ON public.lead_funnel FOR ALL
  USING (public.is_team_member(team_id));

-- =====================================================
-- RLS Policies for safety_events
-- =====================================================
DROP POLICY IF EXISTS "Team members can view safety_events" ON public.safety_events;
CREATE POLICY "Team members can view safety_events"
  ON public.safety_events FOR SELECT
  USING (public.is_team_member(team_id));

DROP POLICY IF EXISTS "Team members can manage safety_events" ON public.safety_events;
CREATE POLICY "Team members can manage safety_events"
  ON public.safety_events FOR ALL
  USING (public.is_team_member(team_id));

-- =====================================================
-- RLS Policies for user_profiles
-- =====================================================
DROP POLICY IF EXISTS "Team members can view user_profiles" ON public.user_profiles;
CREATE POLICY "Team members can view user_profiles"
  ON public.user_profiles FOR SELECT
  USING (public.is_team_member(team_id));

DROP POLICY IF EXISTS "Team members can manage user_profiles" ON public.user_profiles;
CREATE POLICY "Team members can manage user_profiles"
  ON public.user_profiles FOR ALL
  USING (public.is_team_member(team_id));

-- =====================================================
-- RLS Policies for user_qualifications
-- =====================================================
DROP POLICY IF EXISTS "Team members can view user_qualifications" ON public.user_qualifications;
CREATE POLICY "Team members can view user_qualifications"
  ON public.user_qualifications FOR SELECT
  USING (public.is_team_member(team_id));

DROP POLICY IF EXISTS "Team members can manage user_qualifications" ON public.user_qualifications;
CREATE POLICY "Team members can manage user_qualifications"
  ON public.user_qualifications FOR ALL
  USING (public.is_team_member(team_id));
