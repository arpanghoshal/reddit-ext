"""
Authentication Routes
Handles user signup, login, and token refresh using Supabase Auth
"""

import os
import logging
from datetime import datetime
from fastapi import APIRouter, HTTPException, Request, Query
from pydantic import BaseModel, EmailStr
from typing import Optional
from supabase import create_client, Client

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/auth", tags=["authentication"])


def get_supabase_client() -> Client:
    """Get Supabase client for auth operations (anon key)"""
    url = os.getenv("SUPABASE_URL")
    key = os.getenv("SUPABASE_ANON_KEY") or os.getenv("SUPABASE_KEY")

    if not url or not key:
        raise HTTPException(
            status_code=500,
            detail="Supabase not configured"
        )

    return create_client(url, key)


def get_service_client() -> Client:
    """Get Supabase client with service role key (bypasses RLS)"""
    url = os.getenv("SUPABASE_URL")
    key = os.getenv("SUPABASE_SERVICE_ROLE_KEY") or os.getenv("SUPABASE_KEY")

    if not url or not key:
        raise HTTPException(
            status_code=500,
            detail="Supabase not configured"
        )

    return create_client(url, key)


class SignupRequest(BaseModel):
    email: EmailStr
    password: str
    full_name: Optional[str] = None


class LoginRequest(BaseModel):
    email: EmailStr
    password: str


class RefreshRequest(BaseModel):
    refresh_token: str


class AcceptInviteRequest(BaseModel):
    token: str
    email: Optional[EmailStr] = None
    password: Optional[str] = None
    full_name: Optional[str] = None


@router.post("/signup")
async def signup(request: SignupRequest):
    """
    Register a new user.
    Creates user in Supabase Auth, profile and personal team are auto-created via triggers.
    """
    try:
        client = get_supabase_client()

        # Sign up user with Supabase Auth
        redirect_url = os.getenv("SITE_URL", "http://localhost:5173")
        response = client.auth.sign_up({
            "email": request.email,
            "password": request.password,
            "options": {
                "data": {
                    "full_name": request.full_name or request.email.split("@")[0]
                },
                "email_redirect_to": redirect_url
            }
        })

        if response.user is None:
            raise HTTPException(
                status_code=400,
                detail="Failed to create user"
            )

        return {
            "message": "Signup successful. Please check your email to verify your account.",
            "user": {
                "id": response.user.id,
                "email": response.user.email,
                "email_confirmed": response.user.email_confirmed_at is not None
            }
        }

    except Exception as e:
        error_msg = str(e)
        if "User already registered" in error_msg:
            raise HTTPException(status_code=400, detail="Email already registered")
        raise HTTPException(status_code=400, detail=error_msg)


@router.post("/login")
async def login(request: LoginRequest):
    """
    Login user and return access/refresh tokens.
    """
    try:
        client = get_supabase_client()

        response = client.auth.sign_in_with_password({
            "email": request.email,
            "password": request.password
        })

        if response.user is None or response.session is None:
            raise HTTPException(
                status_code=401,
                detail="Invalid email or password"
            )

        # Get user's teams
        teams = client.table("team_members").select(
            "team_id, role, teams(id, name, slug, is_personal)"
        ).eq("user_id", response.user.id).execute()

        # Find personal team as default
        personal_team = None
        team_list = []
        for membership in teams.data or []:
            team = membership.get("teams", {})
            team_data = {
                "id": team.get("id"),
                "name": team.get("name"),
                "slug": team.get("slug"),
                "is_personal": team.get("is_personal"),
                "role": membership.get("role")
            }
            team_list.append(team_data)
            if team.get("is_personal"):
                personal_team = team_data

        return {
            "user": {
                "id": response.user.id,
                "email": response.user.email,
                "full_name": response.user.user_metadata.get("full_name")
            },
            "session": {
                "access_token": response.session.access_token,
                "refresh_token": response.session.refresh_token,
                "expires_at": response.session.expires_at
            },
            "teams": team_list,
            "current_team": personal_team
        }

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=401, detail="Invalid email or password")


@router.post("/refresh")
async def refresh_token(request: RefreshRequest):
    """
    Refresh access token using refresh token.
    """
    try:
        client = get_supabase_client()

        response = client.auth.refresh_session(request.refresh_token)

        if response.session is None:
            raise HTTPException(
                status_code=401,
                detail="Invalid or expired refresh token"
            )

        return {
            "session": {
                "access_token": response.session.access_token,
                "refresh_token": response.session.refresh_token,
                "expires_at": response.session.expires_at
            }
        }

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=401, detail="Failed to refresh token")


@router.post("/logout")
async def logout(request: Request):
    """
    Logout user (invalidate session).
    """
    try:
        client = get_supabase_client()
        client.auth.sign_out()
        return {"message": "Logged out successfully"}
    except Exception as e:
        # Even if logout fails on server, client should clear tokens
        return {"message": "Logged out"}


@router.get("/me")
async def get_current_user(request: Request):
    """
    Get current authenticated user info.
    """
    user = getattr(request.state, "user", None)
    user_id = getattr(request.state, "user_id", None)

    if not user_id:
        raise HTTPException(status_code=401, detail="Not authenticated")

    try:
        client = get_supabase_client()

        # Get profile
        profile = client.table("profiles").select("*").eq(
            "id", user_id
        ).single().execute()

        # Get teams
        teams = client.table("team_members").select(
            "team_id, role, teams(id, name, slug, is_personal)"
        ).eq("user_id", user_id).execute()

        team_list = []
        for membership in teams.data or []:
            team = membership.get("teams", {})
            team_list.append({
                "id": team.get("id"),
                "name": team.get("name"),
                "slug": team.get("slug"),
                "is_personal": team.get("is_personal"),
                "role": membership.get("role")
            })

        return {
            "user": {
                "id": user_id,
                "email": user.get("email") if user else None,
                "full_name": profile.data.get("full_name") if profile.data else None,
                "avatar_url": profile.data.get("avatar_url") if profile.data else None
            },
            "teams": team_list
        }

    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to get user info: {e}")


@router.get("/invite-info")
async def get_invite_info(token: str = Query(...)):
    """
    Get invitation details by token. Public endpoint - no auth required.
    """
    try:
        client = get_service_client()

        invite = client.table("team_invitations").select(
            "email, role, expires_at, created_at, teams(id, name)"
        ).eq("token", token).single().execute()

        if not invite.data:
            raise HTTPException(status_code=404, detail="Invitation not found or expired")

        expires_at = datetime.fromisoformat(invite.data["expires_at"].replace("Z", "+00:00"))
        if datetime.now(expires_at.tzinfo) > expires_at:
            raise HTTPException(status_code=400, detail="Invitation has expired")

        team = invite.data.get("teams", {})

        return {
            "email": invite.data["email"],
            "role": invite.data["role"],
            "team_name": team.get("name", "Unknown"),
            "team_id": team.get("id"),
            "expires_at": invite.data["expires_at"],
        }

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.post("/accept-invite")
async def accept_invite(request: Request, data: AcceptInviteRequest):
    """
    Accept a team invitation.
    Supports both authenticated (JWT/magic link) and unauthenticated (email+password) flows.
    """
    try:
        client = get_service_client()

        # Look up invitation by token
        query = client.table("team_invitations").select(
            "*, teams(id, name, slug)"
        ).eq("token", data.token)

        if data.email:
            query = query.eq("email", data.email)

        invite = query.single().execute()

        if not invite.data:
            raise HTTPException(status_code=400, detail="Invalid or expired invitation")

        expires_at = datetime.fromisoformat(invite.data["expires_at"].replace("Z", "+00:00"))
        if datetime.now(expires_at.tzinfo) > expires_at:
            raise HTTPException(status_code=400, detail="Invitation has expired")

        team_id = invite.data["team_id"]
        role = invite.data["role"]
        invite_email = invite.data["email"]

        # Determine user_id: check if request has a valid JWT
        user_id = None
        auth_header = request.headers.get("Authorization", "")
        if auth_header.startswith("Bearer "):
            from ..middleware.supabase_auth import decode_supabase_jwt
            token_str = auth_header.replace("Bearer ", "")
            payload = decode_supabase_jwt(token_str)
            if payload:
                user_id = payload.get("sub")

        if not user_id:
            # Unauthenticated flow: require email and password
            if not data.email or not data.password:
                raise HTTPException(
                    status_code=400,
                    detail="Email and password are required when not authenticated"
                )

            anon_client = get_supabase_client()
            try:
                signup_response = anon_client.auth.sign_up({
                    "email": data.email,
                    "password": data.password,
                    "options": {
                        "data": {
                            "full_name": data.full_name or data.email.split("@")[0]
                        }
                    }
                })
                user_id = signup_response.user.id if signup_response.user else None
            except Exception:
                login_response = anon_client.auth.sign_in_with_password({
                    "email": data.email,
                    "password": data.password
                })
                user_id = login_response.user.id if login_response.user else None

        if not user_id:
            raise HTTPException(status_code=400, detail="Failed to authenticate")

        # Verify the authenticated user's email matches the invitation
        try:
            user_info = client.auth.admin.get_user_by_id(user_id)
            if user_info and user_info.user and user_info.user.email != invite_email:
                raise HTTPException(
                    status_code=403,
                    detail="Your email does not match this invitation"
                )
        except HTTPException:
            raise
        except Exception:
            pass  # If we can't verify, proceed (edge case)

        # Check if already a member
        existing_member = client.table("team_members").select("id").eq(
            "team_id", team_id
        ).eq("user_id", user_id).execute()

        team_data = invite.data.get("teams", {})

        if existing_member.data:
            # Already a member - clean up invitation and return success
            client.table("team_invitations").delete().eq(
                "id", invite.data["id"]
            ).execute()
            return {
                "message": "You are already a member of this team",
                "team": team_data,
                "team_id": team_data.get("id"),
            }

        # Add user to team
        client.table("team_members").insert({
            "team_id": team_id,
            "user_id": user_id,
            "role": role,
            "invited_by": invite.data.get("created_by")
        }).execute()

        # Delete the invitation
        client.table("team_invitations").delete().eq(
            "id", invite.data["id"]
        ).execute()

        return {
            "message": "Successfully joined team",
            "team": team_data,
            "team_id": team_data.get("id"),
        }

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))
