-- Migration: Create teams, team_members, and team_invitations tables

-- Create teams table
create table if not exists public.teams (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  slug text unique not null,
  owner_id uuid references auth.users on delete cascade not null,
  settings jsonb default '{}',
  is_personal boolean default false,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

-- Create team_members table
create table if not exists public.team_members (
  id uuid primary key default gen_random_uuid(),
  team_id uuid references public.teams on delete cascade not null,
  user_id uuid references auth.users on delete cascade not null,
  role text default 'member' check (role in ('owner', 'admin', 'member')),
  invited_by uuid references auth.users,
  joined_at timestamptz default now(),
  unique(team_id, user_id)
);

-- Create team_invitations table
create table if not exists public.team_invitations (
  id uuid primary key default gen_random_uuid(),
  team_id uuid references public.teams on delete cascade not null,
  email text not null,
  role text default 'member' check (role in ('admin', 'member')),
  token text unique not null default encode(gen_random_bytes(32), 'hex'),
  expires_at timestamptz not null default (now() + interval '7 days'),
  created_by uuid references auth.users,
  created_at timestamptz default now()
);

-- Create index for faster lookups
create index if not exists idx_team_members_user_id on public.team_members(user_id);
create index if not exists idx_team_members_team_id on public.team_members(team_id);
create index if not exists idx_team_invitations_email on public.team_invitations(email);
create index if not exists idx_team_invitations_token on public.team_invitations(token);
create index if not exists idx_teams_owner_id on public.teams(owner_id);
create index if not exists idx_teams_slug on public.teams(slug);

-- Enable RLS
alter table public.teams enable row level security;
alter table public.team_members enable row level security;
alter table public.team_invitations enable row level security;

-- Teams policies
drop policy if exists "Team members can view their teams" on public.teams;
create policy "Team members can view their teams"
  on public.teams for select
  using (
    id in (select team_id from public.team_members where user_id = auth.uid())
  );

drop policy if exists "Users can create teams" on public.teams;
create policy "Users can create teams"
  on public.teams for insert
  with check (auth.uid() = owner_id);

drop policy if exists "Team owners and admins can update team" on public.teams;
create policy "Team owners and admins can update team"
  on public.teams for update
  using (
    id in (
      select team_id from public.team_members
      where user_id = auth.uid() and role in ('owner', 'admin')
    )
  );

drop policy if exists "Team owners can delete team" on public.teams;
create policy "Team owners can delete team"
  on public.teams for delete
  using (owner_id = auth.uid() and is_personal = false);

-- Team members policies
drop policy if exists "Team members can view team members" on public.team_members;
create policy "Team members can view team members"
  on public.team_members for select
  using (
    team_id in (select team_id from public.team_members where user_id = auth.uid())
  );

drop policy if exists "Team owners and admins can add members" on public.team_members;
create policy "Team owners and admins can add members"
  on public.team_members for insert
  with check (
    team_id in (
      select team_id from public.team_members
      where user_id = auth.uid() and role in ('owner', 'admin')
    )
  );

drop policy if exists "Team owners and admins can update members" on public.team_members;
create policy "Team owners and admins can update members"
  on public.team_members for update
  using (
    team_id in (
      select team_id from public.team_members
      where user_id = auth.uid() and role in ('owner', 'admin')
    )
  );

drop policy if exists "Team owners and admins can remove members" on public.team_members;
create policy "Team owners and admins can remove members"
  on public.team_members for delete
  using (
    team_id in (
      select team_id from public.team_members
      where user_id = auth.uid() and role in ('owner', 'admin')
    )
    or user_id = auth.uid() -- Users can leave teams
  );

-- Team invitations policies
drop policy if exists "Team members can view invitations" on public.team_invitations;
create policy "Team members can view invitations"
  on public.team_invitations for select
  using (
    team_id in (select team_id from public.team_members where user_id = auth.uid())
    or email = (select email from auth.users where id = auth.uid())
  );

drop policy if exists "Team owners and admins can create invitations" on public.team_invitations;
create policy "Team owners and admins can create invitations"
  on public.team_invitations for insert
  with check (
    team_id in (
      select team_id from public.team_members
      where user_id = auth.uid() and role in ('owner', 'admin')
    )
  );

drop policy if exists "Team owners and admins can delete invitations" on public.team_invitations;
create policy "Team owners and admins can delete invitations"
  on public.team_invitations for delete
  using (
    team_id in (
      select team_id from public.team_members
      where user_id = auth.uid() and role in ('owner', 'admin')
    )
  );

-- Function to auto-create personal team on user signup
create or replace function public.handle_new_user_team()
returns trigger
language plpgsql
security definer set search_path = ''
as $$
declare
  new_team_id uuid;
  user_slug text;
begin
  -- Generate a unique slug from email
  user_slug := lower(regexp_replace(split_part(new.email, '@', 1), '[^a-z0-9]', '-', 'g'));
  user_slug := user_slug || '-' || substr(new.id::text, 1, 8);

  -- Create personal team
  insert into public.teams (name, slug, owner_id, is_personal)
  values ('Personal', user_slug, new.id, true)
  returning id into new_team_id;

  -- Add user as owner of their personal team
  insert into public.team_members (team_id, user_id, role)
  values (new_team_id, new.id, 'owner');

  return new;
end;
$$;

-- Trigger to auto-create personal team
drop trigger if exists on_auth_user_created_team on auth.users;
create trigger on_auth_user_created_team
  after insert on auth.users
  for each row execute procedure public.handle_new_user_team();

-- Triggers for updated_at
drop trigger if exists update_teams_updated_at on public.teams;
create trigger update_teams_updated_at
  before update on public.teams
  for each row execute procedure public.update_updated_at_column();
