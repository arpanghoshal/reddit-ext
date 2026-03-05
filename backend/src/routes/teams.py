"""
Teams Routes
CRUD operations for teams, members, and invitations
"""

import os
import re
import secrets
import logging
from datetime import datetime, timedelta
from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, EmailStr
from typing import Optional, List

logger = logging.getLogger(__name__)
from supabase import create_client, Client

from ..middleware.supabase_auth import get_current_user_id, get_current_team_id

router = APIRouter(prefix="/teams", tags=["teams"])


def get_supabase_client() -> Client:
    """Get Supabase client"""
    url = os.getenv("SUPABASE_URL")
    key = os.getenv("SUPABASE_SERVICE_ROLE_KEY") or os.getenv("SUPABASE_KEY")

    if not url or not key:
        raise HTTPException(status_code=500, detail="Supabase not configured")

    return create_client(url, key)


def generate_slug(name: str, unique_suffix: str = None) -> str:
    """Generate URL-friendly slug from team name"""
    slug = re.sub(r'[^a-z0-9]+', '-', name.lower()).strip('-')
    if unique_suffix:
        slug = f"{slug}-{unique_suffix}"
    return slug


class CreateTeamRequest(BaseModel):
    name: str


class UpdateTeamRequest(BaseModel):
    name: Optional[str] = None
    settings: Optional[dict] = None


class InviteMemberRequest(BaseModel):
    email: EmailStr
    role: str = "member"


class UpdateMemberRoleRequest(BaseModel):
    role: str


@router.get("")
async def list_teams(request: Request):
    """
    List all teams the current user belongs to.
    """
    user_id = get_current_user_id(request)
    if not user_id:
        raise HTTPException(status_code=401, detail="Not authenticated")

    try:
        client = get_supabase_client()

        result = client.table("team_members").select(
            "team_id, role, joined_at, teams(id, name, slug, is_personal, settings, created_at)"
        ).eq("user_id", user_id).execute()

        teams = []
        for membership in result.data or []:
            team = membership.get("teams", {})
            teams.append({
                "id": team.get("id"),
                "name": team.get("name"),
                "slug": team.get("slug"),
                "is_personal": team.get("is_personal"),
                "settings": team.get("settings"),
                "role": membership.get("role"),
                "joined_at": membership.get("joined_at"),
                "created_at": team.get("created_at")
            })

        return {"teams": teams}

    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.post("")
async def create_team(request: Request, data: CreateTeamRequest):
    """
    Create a new team.
    """
    user_id = get_current_user_id(request)
    if not user_id:
        raise HTTPException(status_code=401, detail="Not authenticated")

    try:
        client = get_supabase_client()

        # Generate unique slug with random suffix
        base_slug = generate_slug(data.name)
        slug = f"{base_slug}-{secrets.token_hex(4)}"

        # Create team
        team_result = client.table("teams").insert({
            "name": data.name,
            "slug": slug,
            "owner_id": user_id,
            "is_personal": False
        }).execute()

        if not team_result.data:
            raise HTTPException(status_code=500, detail="Failed to create team")

        team = team_result.data[0]

        # Add creator as owner
        client.table("team_members").insert({
            "team_id": team["id"],
            "user_id": user_id,
            "role": "owner"
        }).execute()

        return {
            "team": team,
            "message": "Team created successfully"
        }

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/{team_id}")
async def get_team(request: Request, team_id: str):
    """
    Get team details.
    """
    user_id = get_current_user_id(request)
    if not user_id:
        raise HTTPException(status_code=401, detail="Not authenticated")

    try:
        client = get_supabase_client()

        # Verify user is team member
        membership = client.table("team_members").select("role").eq(
            "team_id", team_id
        ).eq("user_id", user_id).single().execute()

        if not membership.data:
            raise HTTPException(status_code=403, detail="Not a member of this team")

        # Get team details
        team = client.table("teams").select("*").eq("id", team_id).single().execute()

        if not team.data:
            raise HTTPException(status_code=404, detail="Team not found")

        return {
            "team": team.data,
            "role": membership.data["role"]
        }

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.patch("/{team_id}")
async def update_team(request: Request, team_id: str, data: UpdateTeamRequest):
    """
    Update team details. Requires admin or owner role.
    """
    user_id = get_current_user_id(request)
    if not user_id:
        raise HTTPException(status_code=401, detail="Not authenticated")

    try:
        client = get_supabase_client()

        # Verify user is admin/owner
        membership = client.table("team_members").select("role").eq(
            "team_id", team_id
        ).eq("user_id", user_id).single().execute()

        if not membership.data or membership.data["role"] not in ["owner", "admin"]:
            raise HTTPException(status_code=403, detail="Insufficient permissions")

        # Build update data
        update_data = {"updated_at": datetime.utcnow().isoformat()}
        if data.name:
            update_data["name"] = data.name
        if data.settings is not None:
            update_data["settings"] = data.settings

        # Update team
        result = client.table("teams").update(update_data).eq("id", team_id).execute()

        return {"team": result.data[0] if result.data else None}

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.delete("/{team_id}")
async def delete_team(request: Request, team_id: str):
    """
    Delete a team. Only owners can delete. Cannot delete personal teams.
    """
    user_id = get_current_user_id(request)
    if not user_id:
        raise HTTPException(status_code=401, detail="Not authenticated")

    try:
        client = get_supabase_client()

        # Get team and verify ownership
        team = client.table("teams").select("*").eq("id", team_id).single().execute()

        if not team.data:
            raise HTTPException(status_code=404, detail="Team not found")

        if team.data["is_personal"]:
            raise HTTPException(status_code=400, detail="Cannot delete personal team")

        if team.data["owner_id"] != user_id:
            raise HTTPException(status_code=403, detail="Only owner can delete team")

        # Delete team (cascade will remove members and invitations)
        client.table("teams").delete().eq("id", team_id).execute()

        return {"message": "Team deleted successfully"}

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


# --- Team Members ---

@router.get("/{team_id}/members")
async def list_members(request: Request, team_id: str):
    """
    List all members of a team.
    """
    user_id = get_current_user_id(request)
    if not user_id:
        raise HTTPException(status_code=401, detail="Not authenticated")

    try:
        client = get_supabase_client()

        # Verify user is team member
        membership = client.table("team_members").select("role").eq(
            "team_id", team_id
        ).eq("user_id", user_id).single().execute()

        if not membership.data:
            raise HTTPException(status_code=403, detail="Not a member of this team")

        # Get all members
        members = client.table("team_members").select(
            "id, user_id, role, joined_at"
        ).eq("team_id", team_id).execute()

        # Fetch profiles separately (no FK between team_members and profiles)
        user_ids = [m["user_id"] for m in (members.data or [])]
        profiles_map = {}
        if user_ids:
            profiles_result = client.table("profiles").select(
                "id, email, full_name, avatar_url"
            ).in_("id", user_ids).execute()
            for p in (profiles_result.data or []):
                profiles_map[p["id"]] = p

        member_list = []
        for member in members.data or []:
            profile = profiles_map.get(member["user_id"], {})
            member_list.append({
                "id": member["id"],
                "user_id": member["user_id"],
                "role": member["role"],
                "joined_at": member["joined_at"],
                "email": profile.get("email"),
                "full_name": profile.get("full_name"),
                "avatar_url": profile.get("avatar_url")
            })

        return {"members": member_list}

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.patch("/{team_id}/members/{member_id}")
async def update_member_role(
    request: Request,
    team_id: str,
    member_id: str,
    data: UpdateMemberRoleRequest
):
    """
    Update a member's role. Requires admin or owner role.
    """
    user_id = get_current_user_id(request)
    if not user_id:
        raise HTTPException(status_code=401, detail="Not authenticated")

    if data.role not in ["admin", "member"]:
        raise HTTPException(status_code=400, detail="Invalid role. Use 'admin' or 'member'")

    try:
        client = get_supabase_client()

        # Verify user is admin/owner
        membership = client.table("team_members").select("role").eq(
            "team_id", team_id
        ).eq("user_id", user_id).single().execute()

        if not membership.data or membership.data["role"] not in ["owner", "admin"]:
            raise HTTPException(status_code=403, detail="Insufficient permissions")

        # Get target member
        target = client.table("team_members").select("*").eq(
            "id", member_id
        ).eq("team_id", team_id).single().execute()

        if not target.data:
            raise HTTPException(status_code=404, detail="Member not found")

        # Cannot change owner role
        if target.data["role"] == "owner":
            raise HTTPException(status_code=400, detail="Cannot change owner's role")

        # Update role
        result = client.table("team_members").update({
            "role": data.role
        }).eq("id", member_id).execute()

        return {"member": result.data[0] if result.data else None}

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.delete("/{team_id}/members/{member_id}")
async def remove_member(request: Request, team_id: str, member_id: str):
    """
    Remove a member from team. Admins/owners can remove others, anyone can leave.
    """
    user_id = get_current_user_id(request)
    if not user_id:
        raise HTTPException(status_code=401, detail="Not authenticated")

    try:
        client = get_supabase_client()

        # Get target member
        target = client.table("team_members").select("*").eq(
            "id", member_id
        ).eq("team_id", team_id).single().execute()

        if not target.data:
            raise HTTPException(status_code=404, detail="Member not found")

        # Check if user is removing themselves (leaving)
        is_self = target.data["user_id"] == user_id

        if not is_self:
            # Verify user is admin/owner
            membership = client.table("team_members").select("role").eq(
                "team_id", team_id
            ).eq("user_id", user_id).single().execute()

            if not membership.data or membership.data["role"] not in ["owner", "admin"]:
                raise HTTPException(status_code=403, detail="Insufficient permissions")

        # Cannot remove owner
        if target.data["role"] == "owner":
            raise HTTPException(status_code=400, detail="Cannot remove team owner")

        # Remove member
        client.table("team_members").delete().eq("id", member_id).execute()

        return {"message": "Member removed successfully"}

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


# --- Team Invitations ---

@router.get("/{team_id}/invitations")
async def list_invitations(request: Request, team_id: str):
    """
    List pending invitations for a team.
    """
    user_id = get_current_user_id(request)
    if not user_id:
        raise HTTPException(status_code=401, detail="Not authenticated")

    try:
        client = get_supabase_client()

        # Verify user is team member
        membership = client.table("team_members").select("role").eq(
            "team_id", team_id
        ).eq("user_id", user_id).single().execute()

        if not membership.data:
            raise HTTPException(status_code=403, detail="Not a member of this team")

        # Get invitations
        invitations = client.table("team_invitations").select(
            "id, email, role, expires_at, created_at"
        ).eq("team_id", team_id).execute()

        return {"invitations": invitations.data or []}

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/{team_id}/invitations")
async def invite_member(request: Request, team_id: str, data: InviteMemberRequest):
    """
    Invite a user to join the team via email.
    """
    user_id = get_current_user_id(request)
    if not user_id:
        raise HTTPException(status_code=401, detail="Not authenticated")

    if data.role not in ["admin", "member"]:
        raise HTTPException(status_code=400, detail="Invalid role. Use 'admin' or 'member'")

    try:
        client = get_supabase_client()

        # Verify user is admin/owner
        membership = client.table("team_members").select("role").eq(
            "team_id", team_id
        ).eq("user_id", user_id).single().execute()

        if not membership.data or membership.data["role"] not in ["owner", "admin"]:
            raise HTTPException(status_code=403, detail="Insufficient permissions")

        # Check if email already invited
        existing = client.table("team_invitations").select("id").eq(
            "team_id", team_id
        ).eq("email", data.email).execute()

        if existing.data:
            raise HTTPException(status_code=400, detail="Email already invited")

        # Check if user is already a member by looking up their profile first
        profile_check = client.table("profiles").select("id").eq(
            "email", data.email
        ).execute()

        if profile_check.data:
            target_user_id = profile_check.data[0]["id"]
            existing_member = client.table("team_members").select("id").eq(
                "team_id", team_id
            ).eq("user_id", target_user_id).execute()

            if existing_member.data:
                raise HTTPException(status_code=400, detail="User is already a team member")

        # Create invitation
        token = secrets.token_urlsafe(32)
        expires_at = (datetime.utcnow() + timedelta(days=7)).isoformat()

        result = client.table("team_invitations").insert({
            "team_id": team_id,
            "email": data.email,
            "role": data.role,
            "token": token,
            "expires_at": expires_at,
            "created_by": user_id
        }).execute()

        if not result.data:
            raise HTTPException(status_code=500, detail="Failed to create invitation")

        # Build the full invite URL
        frontend_url = os.getenv("SITE_URL", "http://localhost:5173")
        invite_url = f"/accept-invite?token={token}"
        full_invite_url = f"{frontend_url}{invite_url}"

        # Send invitation email via Supabase Auth
        is_new_user = not bool(profile_check.data)

        if is_new_user:
            # New user: Supabase creates the user and sends an invite email with magic link
            try:
                client.auth.admin.invite_user_by_email(
                    data.email,
                    {
                        "redirect_to": full_invite_url,
                        "data": {
                            "full_name": data.email.split("@")[0],
                        }
                    }
                )
            except Exception as invite_err:
                logger.warning(f"Failed to send invite email to {data.email}: {invite_err}")
        else:
            # Existing user: send a magic link email for authentication
            try:
                client.auth.admin.generate_link({
                    "type": "magiclink",
                    "email": data.email,
                    "options": {
                        "redirect_to": full_invite_url,
                    }
                })
            except Exception as link_err:
                logger.warning(f"Failed to send magic link to {data.email}: {link_err}")

        return {
            "invitation": result.data[0],
            "invite_url": invite_url,
            "full_invite_url": full_invite_url,
            "message": f"Invitation created for {data.email}"
        }

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.delete("/{team_id}/invitations/{invitation_id}")
async def cancel_invitation(request: Request, team_id: str, invitation_id: str):
    """
    Cancel a pending invitation.
    """
    user_id = get_current_user_id(request)
    if not user_id:
        raise HTTPException(status_code=401, detail="Not authenticated")

    try:
        client = get_supabase_client()

        # Verify user is admin/owner
        membership = client.table("team_members").select("role").eq(
            "team_id", team_id
        ).eq("user_id", user_id).single().execute()

        if not membership.data or membership.data["role"] not in ["owner", "admin"]:
            raise HTTPException(status_code=403, detail="Insufficient permissions")

        # Delete invitation
        client.table("team_invitations").delete().eq(
            "id", invitation_id
        ).eq("team_id", team_id).execute()

        return {"message": "Invitation cancelled"}

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
