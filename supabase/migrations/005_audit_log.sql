-- =====================================================
-- 005: Team Audit Log
-- =====================================================

-- Audit log table for tracking team actions
CREATE TABLE IF NOT EXISTS team_audit_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  team_id UUID REFERENCES teams ON DELETE CASCADE,
  user_id UUID REFERENCES auth.users,
  action TEXT NOT NULL,           -- 'member.invited', 'member.removed', 'settings.updated', etc.
  resource_type TEXT,             -- 'member', 'account', 'campaign', 'rule', 'dm'
  resource_id UUID,
  details JSONB DEFAULT '{}',     -- Additional context
  ip_address INET,
  user_agent TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- Indexes for efficient querying
CREATE INDEX IF NOT EXISTS idx_audit_team_date ON team_audit_log(team_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_action ON team_audit_log(action);
CREATE INDEX IF NOT EXISTS idx_audit_user ON team_audit_log(user_id);
CREATE INDEX IF NOT EXISTS idx_audit_resource ON team_audit_log(resource_type, resource_id);

-- RLS: Only admins/owners can view audit log
ALTER TABLE team_audit_log ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Admins can view audit log" ON team_audit_log;
CREATE POLICY "Admins can view audit log" ON team_audit_log
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM team_members
      WHERE team_id = team_audit_log.team_id
      AND user_id = auth.uid()
      AND role IN ('owner', 'admin')
    )
  );

-- Allow system to insert audit logs (for any team member action)
DROP POLICY IF EXISTS "Team members can create audit logs" ON team_audit_log;
CREATE POLICY "Team members can create audit logs" ON team_audit_log
  FOR INSERT WITH CHECK (public.is_team_member(team_id));

-- Action constants (for reference)
COMMENT ON TABLE team_audit_log IS '
Action types:
- member.invited: Invited a new member
- member.joined: Member accepted invitation
- member.removed: Removed a team member
- member.left: Member left the team
- member.role_changed: Changed member role
- account.added: Added Reddit account
- account.removed: Removed Reddit account
- account.updated: Updated account settings
- campaign.created: Created campaign
- campaign.updated: Updated campaign
- campaign.deleted: Deleted campaign
- campaign.started: Started campaign
- campaign.paused: Paused campaign
- rule.created: Created automation rule
- rule.updated: Updated rule
- rule.deleted: Deleted rule
- settings.updated: Updated team settings
- dm.sent: Sent DM (can be summarized)
- dm.approved: Approved DM from queue
- dm.rejected: Rejected DM from queue
- quota.exceeded: Quota limit reached
';

-- Function to log an audit event
CREATE OR REPLACE FUNCTION log_audit_event(
  p_team_id UUID,
  p_user_id UUID,
  p_action TEXT,
  p_resource_type TEXT DEFAULT NULL,
  p_resource_id UUID DEFAULT NULL,
  p_details JSONB DEFAULT '{}'::JSONB,
  p_ip_address INET DEFAULT NULL,
  p_user_agent TEXT DEFAULT NULL
)
RETURNS UUID AS $$
DECLARE
  audit_id UUID;
BEGIN
  INSERT INTO team_audit_log (
    team_id, user_id, action, resource_type, resource_id, details, ip_address, user_agent
  ) VALUES (
    p_team_id, p_user_id, p_action, p_resource_type, p_resource_id, p_details, p_ip_address, p_user_agent
  )
  RETURNING id INTO audit_id;

  RETURN audit_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- View for easier audit log access with user info
CREATE OR REPLACE VIEW audit_log_with_users AS
SELECT
  a.id,
  a.team_id,
  a.user_id,
  p.email as user_email,
  p.full_name as user_name,
  a.action,
  a.resource_type,
  a.resource_id,
  a.details,
  a.ip_address,
  a.user_agent,
  a.created_at
FROM team_audit_log a
LEFT JOIN profiles p ON a.user_id = p.id;

-- Grant access to the view
GRANT SELECT ON audit_log_with_users TO authenticated;
