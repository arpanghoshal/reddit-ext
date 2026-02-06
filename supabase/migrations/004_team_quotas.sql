-- =====================================================
-- 004: Team Quotas and Usage Tracking
-- =====================================================

-- Team quota definitions
CREATE TABLE IF NOT EXISTS public.team_quotas (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  team_id UUID REFERENCES public.teams ON DELETE CASCADE UNIQUE,
  max_accounts INT DEFAULT 5,           -- Max Reddit accounts
  max_dms_per_day INT DEFAULT 100,      -- Daily DM limit
  max_members INT DEFAULT 10,           -- Max team members
  max_campaigns INT DEFAULT 10,         -- Max active campaigns
  max_rules INT DEFAULT 50,             -- Max automation rules
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- Daily usage tracking
CREATE TABLE IF NOT EXISTS public.team_usage (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  team_id UUID REFERENCES public.teams ON DELETE CASCADE,
  date DATE DEFAULT CURRENT_DATE,
  dms_sent INT DEFAULT 0,
  dms_received INT DEFAULT 0,
  accounts_active INT DEFAULT 0,
  api_calls INT DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(team_id, date)
);

-- Create indexes
CREATE INDEX IF NOT EXISTS idx_team_quotas_team ON team_quotas(team_id);
CREATE INDEX IF NOT EXISTS idx_team_usage_team_date ON team_usage(team_id, date);

-- RLS policies for team_quotas
ALTER TABLE team_quotas ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Team members can view quotas" ON team_quotas;
CREATE POLICY "Team members can view quotas" ON team_quotas
  FOR SELECT USING (public.is_team_member(team_id));

DROP POLICY IF EXISTS "Only admins can update quotas" ON team_quotas;
CREATE POLICY "Only admins can update quotas" ON team_quotas
  FOR UPDATE USING (
    EXISTS (
      SELECT 1 FROM team_members
      WHERE team_id = team_quotas.team_id
      AND user_id = auth.uid()
      AND role IN ('owner', 'admin')
    )
  );

-- RLS policies for team_usage
ALTER TABLE team_usage ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Team members can view usage" ON team_usage;
CREATE POLICY "Team members can view usage" ON team_usage
  FOR SELECT USING (public.is_team_member(team_id));

DROP POLICY IF EXISTS "System can insert/update usage" ON public.team_usage;
CREATE POLICY "Team members can insert usage" ON public.team_usage
  FOR INSERT WITH CHECK (public.is_team_member(team_id));

CREATE POLICY "Team members can update usage" ON public.team_usage
  FOR UPDATE USING (public.is_team_member(team_id));

-- Function to auto-create quota record for new teams
CREATE OR REPLACE FUNCTION create_team_quota()
RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO team_quotas (team_id)
  VALUES (NEW.id)
  ON CONFLICT (team_id) DO NOTHING;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Trigger to create quota on team creation
DROP TRIGGER IF EXISTS on_team_created_quota ON teams;
CREATE TRIGGER on_team_created_quota
  AFTER INSERT ON teams
  FOR EACH ROW EXECUTE FUNCTION create_team_quota();

-- Create quota records for existing teams
INSERT INTO team_quotas (team_id)
SELECT id FROM teams
ON CONFLICT (team_id) DO NOTHING;

-- Function to get or create today's usage record
CREATE OR REPLACE FUNCTION get_or_create_daily_usage(p_team_id UUID)
RETURNS team_usage AS $$
DECLARE
  usage_record team_usage;
BEGIN
  -- Try to get existing record
  SELECT * INTO usage_record
  FROM team_usage
  WHERE team_id = p_team_id AND date = CURRENT_DATE;

  -- Create if not exists
  IF NOT FOUND THEN
    INSERT INTO team_usage (team_id, date)
    VALUES (p_team_id, CURRENT_DATE)
    ON CONFLICT (team_id, date) DO NOTHING
    RETURNING * INTO usage_record;

    -- If insert didn't return (conflict), fetch it
    IF usage_record IS NULL THEN
      SELECT * INTO usage_record
      FROM team_usage
      WHERE team_id = p_team_id AND date = CURRENT_DATE;
    END IF;
  END IF;

  RETURN usage_record;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Function to increment daily usage
CREATE OR REPLACE FUNCTION increment_daily_usage(
  p_team_id UUID,
  p_metric TEXT,
  p_amount INT DEFAULT 1
)
RETURNS team_usage AS $$
DECLARE
  usage_record team_usage;
BEGIN
  -- Ensure record exists
  PERFORM get_or_create_daily_usage(p_team_id);

  -- Validate metric name to prevent SQL injection
  IF p_metric NOT IN ('dms_sent', 'dms_received', 'accounts_active', 'api_calls') THEN
    RAISE EXCEPTION 'Invalid metric: %', p_metric;
  END IF;

  -- Update the specific metric
  EXECUTE format(
    'UPDATE team_usage SET %I = %I + $1, updated_at = now() WHERE team_id = $2 AND date = CURRENT_DATE RETURNING *',
    p_metric, p_metric
  ) INTO usage_record USING p_amount, p_team_id;

  RETURN usage_record;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Function to check if team is within quota
CREATE OR REPLACE FUNCTION check_team_quota(
  p_team_id UUID,
  p_resource TEXT
)
RETURNS BOOLEAN AS $$
DECLARE
  quota_record team_quotas;
  usage_record team_usage;
  current_count INT;
  max_limit INT;
BEGIN
  -- Get quota
  SELECT * INTO quota_record FROM team_quotas WHERE team_id = p_team_id;
  IF NOT FOUND THEN
    RETURN TRUE; -- No quota = unlimited
  END IF;

  -- Get today's usage
  SELECT * INTO usage_record FROM team_usage WHERE team_id = p_team_id AND date = CURRENT_DATE;

  -- Check based on resource type
  CASE p_resource
    WHEN 'dms' THEN
      current_count := COALESCE(usage_record.dms_sent, 0);
      max_limit := quota_record.max_dms_per_day;
    WHEN 'accounts' THEN
      SELECT COUNT(*) INTO current_count FROM public.reddit_accounts WHERE team_id = p_team_id;
      max_limit := quota_record.max_accounts;
    WHEN 'members' THEN
      SELECT COUNT(*) INTO current_count FROM public.team_members WHERE team_id = p_team_id;
      max_limit := quota_record.max_members;
    WHEN 'campaigns' THEN
      SELECT COUNT(*) INTO current_count FROM public.campaigns WHERE team_id = p_team_id AND status = 'active';
      max_limit := quota_record.max_campaigns;
    WHEN 'rules' THEN
      SELECT COUNT(*) INTO current_count FROM public.filter_rules WHERE team_id = p_team_id;
      max_limit := quota_record.max_rules;
    ELSE
      RETURN TRUE; -- Unknown resource = no limit
  END CASE;

  RETURN current_count < max_limit;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Updated_at triggers
CREATE TRIGGER update_team_quotas_updated_at
  BEFORE UPDATE ON public.team_quotas
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE TRIGGER update_team_usage_updated_at
  BEFORE UPDATE ON public.team_usage
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
