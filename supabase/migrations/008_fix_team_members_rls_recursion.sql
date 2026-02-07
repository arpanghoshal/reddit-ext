-- Fix infinite recursion in team_members RLS policy (error 42P17)
--
-- Root cause: Old SELECT policy "Team members can view team members" had a
-- subquery on team_members itself, triggering its own RLS in an infinite loop.
--
-- Fix:
-- 1. Drop old recursive policies
-- 2. Make is_team_member() SECURITY DEFINER so it bypasses RLS on team_members
-- 3. New team_members SELECT policy uses direct auth.uid() check (no subquery)

-- Drop old recursive policies
DROP POLICY IF EXISTS "Team members can view team members" ON public.team_members;
DROP POLICY IF EXISTS "Team owners and admins can add members" ON public.team_members;
DROP POLICY IF EXISTS "Team owners and admins can update members" ON public.team_members;
DROP POLICY IF EXISTS "Team owners and admins can remove members" ON public.team_members;

-- Make is_team_member SECURITY DEFINER so it bypasses RLS on team_members
CREATE OR REPLACE FUNCTION public.is_team_member(check_team_id uuid)
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.team_members
    WHERE team_id = check_team_id AND user_id = auth.uid()
  );
$$;

ALTER TABLE public.team_members ENABLE ROW LEVEL SECURITY;

-- New policies: SELECT uses direct auth.uid(), others use SECURITY DEFINER function
CREATE POLICY "team_members_select" ON public.team_members
  FOR SELECT USING (user_id = auth.uid());

CREATE POLICY "team_members_insert" ON public.team_members
  FOR INSERT WITH CHECK (
    user_id = auth.uid()
    OR public.is_team_member(team_id)
  );

CREATE POLICY "team_members_update" ON public.team_members
  FOR UPDATE USING (
    public.is_team_member(team_id)
  );

CREATE POLICY "team_members_delete" ON public.team_members
  FOR DELETE USING (
    user_id = auth.uid()
    OR public.is_team_member(team_id)
  );
