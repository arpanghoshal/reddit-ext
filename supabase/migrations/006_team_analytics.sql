-- =====================================================
-- 006: Team Analytics Tables
-- =====================================================

-- Aggregated daily stats for performance
CREATE TABLE IF NOT EXISTS team_daily_stats (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  team_id UUID REFERENCES teams ON DELETE CASCADE,
  date DATE NOT NULL,

  -- DM metrics
  dms_sent INT DEFAULT 0,
  dms_delivered INT DEFAULT 0,
  dms_failed INT DEFAULT 0,
  response_count INT DEFAULT 0,
  avg_response_time_mins FLOAT,

  -- Conversion metrics
  leads_generated INT DEFAULT 0,
  positive_responses INT DEFAULT 0,
  negative_responses INT DEFAULT 0,

  -- Account metrics
  active_accounts INT DEFAULT 0,

  -- Engagement
  unique_recipients INT DEFAULT 0,

  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),

  UNIQUE(team_id, date)
);

-- Hourly breakdown for heatmaps
CREATE TABLE IF NOT EXISTS team_hourly_activity (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  team_id UUID REFERENCES teams ON DELETE CASCADE,
  date DATE NOT NULL,
  hour INT NOT NULL CHECK (hour >= 0 AND hour < 24),
  dms_sent INT DEFAULT 0,
  responses INT DEFAULT 0,
  UNIQUE(team_id, date, hour)
);

-- Per-member stats
CREATE TABLE IF NOT EXISTS member_stats (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  team_id UUID REFERENCES teams ON DELETE CASCADE,
  user_id UUID REFERENCES auth.users,
  date DATE NOT NULL,
  dms_sent INT DEFAULT 0,
  dms_approved INT DEFAULT 0,
  responses INT DEFAULT 0,
  accounts_managed INT DEFAULT 0,
  UNIQUE(team_id, user_id, date)
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_daily_stats_team_date ON team_daily_stats(team_id, date DESC);
CREATE INDEX IF NOT EXISTS idx_hourly_activity_team_date ON team_hourly_activity(team_id, date DESC);
CREATE INDEX IF NOT EXISTS idx_member_stats_team_date ON member_stats(team_id, date DESC);
CREATE INDEX IF NOT EXISTS idx_member_stats_user ON member_stats(user_id, date DESC);

-- RLS policies
ALTER TABLE team_daily_stats ENABLE ROW LEVEL SECURITY;
ALTER TABLE team_hourly_activity ENABLE ROW LEVEL SECURITY;
ALTER TABLE member_stats ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Team members can view daily stats" ON team_daily_stats;
CREATE POLICY "Team members can view daily stats" ON team_daily_stats
  FOR SELECT USING (public.is_team_member(team_id));

DROP POLICY IF EXISTS "Team members can view hourly activity" ON team_hourly_activity;
CREATE POLICY "Team members can view hourly activity" ON team_hourly_activity
  FOR SELECT USING (public.is_team_member(team_id));

DROP POLICY IF EXISTS "Team members can view member stats" ON member_stats;
CREATE POLICY "Team members can view member stats" ON member_stats
  FOR SELECT USING (public.is_team_member(team_id));

-- System can insert/update stats
DROP POLICY IF EXISTS "System can manage daily stats" ON team_daily_stats;
CREATE POLICY "System can insert daily stats" ON team_daily_stats
  FOR INSERT WITH CHECK (public.is_team_member(team_id));
CREATE POLICY "System can update daily stats" ON team_daily_stats
  FOR UPDATE USING (public.is_team_member(team_id));

DROP POLICY IF EXISTS "System can manage hourly activity" ON team_hourly_activity;
CREATE POLICY "System can insert hourly activity" ON team_hourly_activity
  FOR INSERT WITH CHECK (public.is_team_member(team_id));
CREATE POLICY "System can update hourly activity" ON team_hourly_activity
  FOR UPDATE USING (public.is_team_member(team_id));

DROP POLICY IF EXISTS "System can manage member stats" ON member_stats;
CREATE POLICY "System can insert member stats" ON member_stats
  FOR INSERT WITH CHECK (public.is_team_member(team_id));
CREATE POLICY "System can update member stats" ON member_stats
  FOR UPDATE USING (public.is_team_member(team_id));

-- Function to get or create daily stats record
CREATE OR REPLACE FUNCTION get_or_create_daily_stats(p_team_id UUID, p_date DATE DEFAULT CURRENT_DATE)
RETURNS team_daily_stats AS $$
DECLARE
  stats_record team_daily_stats;
BEGIN
  SELECT * INTO stats_record
  FROM team_daily_stats
  WHERE team_id = p_team_id AND date = p_date;

  IF NOT FOUND THEN
    INSERT INTO team_daily_stats (team_id, date)
    VALUES (p_team_id, p_date)
    ON CONFLICT (team_id, date) DO NOTHING
    RETURNING * INTO stats_record;

    IF stats_record IS NULL THEN
      SELECT * INTO stats_record
      FROM team_daily_stats
      WHERE team_id = p_team_id AND date = p_date;
    END IF;
  END IF;

  RETURN stats_record;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Function to increment daily stat
CREATE OR REPLACE FUNCTION increment_daily_stat(
  p_team_id UUID,
  p_date DATE,
  p_metric TEXT,
  p_amount INT DEFAULT 1
)
RETURNS team_daily_stats AS $$
DECLARE
  stats_record team_daily_stats;
BEGIN
  PERFORM get_or_create_daily_stats(p_team_id, p_date);

  -- Validate metric name
  IF p_metric NOT IN ('dms_sent', 'dms_delivered', 'dms_failed', 'response_count', 'leads_generated', 'positive_responses', 'negative_responses', 'active_accounts', 'unique_recipients') THEN
    RAISE EXCEPTION 'Invalid metric: %', p_metric;
  END IF;

  EXECUTE format(
    'UPDATE team_daily_stats SET %I = %I + $1, updated_at = now() WHERE team_id = $2 AND date = $3 RETURNING *',
    p_metric, p_metric
  ) INTO stats_record USING p_amount, p_team_id, p_date;

  RETURN stats_record;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Function to increment hourly activity
CREATE OR REPLACE FUNCTION increment_hourly_activity(
  p_team_id UUID,
  p_date DATE,
  p_hour INT,
  p_metric TEXT,
  p_amount INT DEFAULT 1
)
RETURNS team_hourly_activity AS $$
DECLARE
  activity_record team_hourly_activity;
BEGIN
  INSERT INTO team_hourly_activity (team_id, date, hour)
  VALUES (p_team_id, p_date, p_hour)
  ON CONFLICT (team_id, date, hour) DO NOTHING;

  -- Validate metric name
  IF p_metric NOT IN ('dms_sent', 'responses') THEN
    RAISE EXCEPTION 'Invalid metric: %', p_metric;
  END IF;

  EXECUTE format(
    'UPDATE team_hourly_activity SET %I = %I + $1 WHERE team_id = $2 AND date = $3 AND hour = $4 RETURNING *',
    p_metric, p_metric
  ) INTO activity_record USING p_amount, p_team_id, p_date, p_hour;

  RETURN activity_record;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Function to increment member stat
CREATE OR REPLACE FUNCTION increment_member_stat(
  p_team_id UUID,
  p_user_id UUID,
  p_date DATE,
  p_metric TEXT,
  p_amount INT DEFAULT 1
)
RETURNS member_stats AS $$
DECLARE
  stats_record member_stats;
BEGIN
  INSERT INTO member_stats (team_id, user_id, date)
  VALUES (p_team_id, p_user_id, p_date)
  ON CONFLICT (team_id, user_id, date) DO NOTHING;

  -- Validate metric name
  IF p_metric NOT IN ('dms_sent', 'dms_approved', 'responses', 'accounts_managed') THEN
    RAISE EXCEPTION 'Invalid metric: %', p_metric;
  END IF;

  EXECUTE format(
    'UPDATE member_stats SET %I = %I + $1 WHERE team_id = $2 AND user_id = $3 AND date = $4 RETURNING *',
    p_metric, p_metric
  ) INTO stats_record USING p_amount, p_team_id, p_user_id, p_date;

  RETURN stats_record;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Updated_at trigger for daily stats
CREATE TRIGGER update_team_daily_stats_updated_at
  BEFORE UPDATE ON team_daily_stats
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- View for team analytics summary
CREATE OR REPLACE VIEW team_analytics_summary AS
SELECT
  team_id,
  SUM(dms_sent) as total_dms_sent,
  SUM(response_count) as total_responses,
  SUM(leads_generated) as total_leads,
  SUM(positive_responses) as total_positive,
  ROUND(AVG(avg_response_time_mins)::numeric, 1) as avg_response_time,
  CASE WHEN SUM(dms_sent) > 0
    THEN ROUND((SUM(response_count)::numeric / SUM(dms_sent)) * 100, 1)
    ELSE 0
  END as response_rate,
  CASE WHEN SUM(response_count) > 0
    THEN ROUND((SUM(positive_responses)::numeric / SUM(response_count)) * 100, 1)
    ELSE 0
  END as positive_rate,
  MIN(date) as first_activity,
  MAX(date) as last_activity,
  COUNT(DISTINCT date) as active_days
FROM team_daily_stats
GROUP BY team_id;

GRANT SELECT ON team_analytics_summary TO authenticated;
