import { useState, useEffect } from 'react';
import { useAuth } from '../contexts/AuthContext';
import {
  Users,
  Plus,
  Trash2,
  UserPlus,
  Settings,
  Crown,
  Shield,
  User,
  Mail,
  Copy,
  Check,
  AlertCircle,
  X,
} from 'lucide-react';

export default function TeamSettings() {
  const { user, teams, currentTeam, switchTeam, refreshTeams, getAccessToken } = useAuth();
  const [activeTab, setActiveTab] = useState('members');
  const [members, setMembers] = useState([]);
  const [invitations, setInvitations] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');

  // Create team form
  const [showCreateTeam, setShowCreateTeam] = useState(false);
  const [newTeamName, setNewTeamName] = useState('');
  const [creatingTeam, setCreatingTeam] = useState(false);

  // Invite form
  const [showInvite, setShowInvite] = useState(false);
  const [inviteEmail, setInviteEmail] = useState('');
  const [inviteRole, setInviteRole] = useState('member');
  const [inviting, setInviting] = useState(false);
  const [inviteLink, setInviteLink] = useState('');

  // Team settings
  const [teamName, setTeamName] = useState('');
  const [saving, setSaving] = useState(false);

  const isOwner = currentTeam?.role === 'owner';
  const isAdmin = currentTeam?.role === 'admin' || isOwner;

  useEffect(() => {
    if (currentTeam) {
      setTeamName(currentTeam.name);
      fetchMembers();
      fetchInvitations();
    }
  }, [currentTeam]);

  const fetchMembers = async () => {
    if (!currentTeam) return;

    try {
      const token = getAccessToken();
      const response = await fetch(`/api/teams/${currentTeam.id}/members`, {
        headers: { Authorization: `Bearer ${token}` },
      });

      if (!response.ok) {
        const errData = await response.json();
        throw new Error(errData.detail || 'Failed to fetch members');
      }

      const { members: memberList } = await response.json();
      setMembers(
        (memberList || []).map((m) => ({
          id: m.id,
          userId: m.user_id,
          role: m.role,
          joinedAt: m.joined_at,
          email: m.email,
          fullName: m.full_name,
          avatarUrl: m.avatar_url,
        }))
      );
    } catch (err) {
      console.error('Error fetching members:', err);
    } finally {
      setLoading(false);
    }
  };

  const fetchInvitations = async () => {
    if (!currentTeam) return;

    try {
      const token = getAccessToken();
      const response = await fetch(`/api/teams/${currentTeam.id}/invitations`, {
        headers: { Authorization: `Bearer ${token}` },
      });

      if (!response.ok) return;

      const { invitations: inviteList } = await response.json();
      setInvitations(inviteList || []);
    } catch (err) {
      console.error('Error fetching invitations:', err);
    }
  };

  const handleCreateTeam = async (e) => {
    e.preventDefault();
    if (!newTeamName.trim()) return;

    setCreatingTeam(true);
    setError('');

    try {
      const response = await fetch('/api/teams', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${getAccessToken()}`,
        },
        body: JSON.stringify({ name: newTeamName }),
      });

      const data = await response.json();
      if (!response.ok) throw new Error(data.detail || 'Failed to create team');

      setShowCreateTeam(false);
      setNewTeamName('');
      await refreshTeams();

      // Auto-switch to the newly created team
      if (data.team?.id) {
        switchTeam(data.team.id);
      }
      setSuccess('Team created successfully!');
    } catch (err) {
      setError(err.message);
    } finally {
      setCreatingTeam(false);
    }
  };

  const handleInvite = async (e) => {
    e.preventDefault();
    if (!inviteEmail.trim()) return;

    setInviting(true);
    setError('');
    setInviteLink('');

    try {
      const response = await fetch(`/api/teams/${currentTeam.id}/invitations`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${getAccessToken()}`,
        },
        body: JSON.stringify({ email: inviteEmail, role: inviteRole }),
      });

      const data = await response.json();
      if (!response.ok) throw new Error(data.detail || 'Failed to send invitation');

      setSuccess(`Invitation sent to ${inviteEmail}`);
      setInviteLink(window.location.origin + data.invite_url);
      setInviteEmail('');
      fetchInvitations();
    } catch (err) {
      setError(err.message);
    } finally {
      setInviting(false);
    }
  };

  const handleUpdateMemberRole = async (memberId, newRole) => {
    try {
      const response = await fetch(
        `/api/teams/${currentTeam.id}/members/${memberId}`,
        {
          method: 'PATCH',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${getAccessToken()}`,
          },
          body: JSON.stringify({ role: newRole }),
        }
      );

      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.detail || 'Failed to update role');
      }

      setSuccess('Member role updated');
      fetchMembers();
    } catch (err) {
      setError(err.message);
    }
  };

  const handleRemoveMember = async (memberId) => {
    if (!confirm('Are you sure you want to remove this member?')) return;

    try {
      const response = await fetch(
        `/api/teams/${currentTeam.id}/members/${memberId}`,
        {
          method: 'DELETE',
          headers: {
            Authorization: `Bearer ${getAccessToken()}`,
          },
        }
      );

      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.detail || 'Failed to remove member');
      }

      setSuccess('Member removed');
      fetchMembers();
    } catch (err) {
      setError(err.message);
    }
  };

  const handleCancelInvitation = async (invitationId) => {
    try {
      const response = await fetch(
        `/api/teams/${currentTeam.id}/invitations/${invitationId}`,
        {
          method: 'DELETE',
          headers: {
            Authorization: `Bearer ${getAccessToken()}`,
          },
        }
      );

      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.detail || 'Failed to cancel invitation');
      }

      setSuccess('Invitation cancelled');
      fetchInvitations();
    } catch (err) {
      setError(err.message);
    }
  };

  const handleUpdateTeam = async (e) => {
    e.preventDefault();
    if (!teamName.trim()) return;

    setSaving(true);
    setError('');

    try {
      const response = await fetch(`/api/teams/${currentTeam.id}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${getAccessToken()}`,
        },
        body: JSON.stringify({ name: teamName }),
      });

      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.detail || 'Failed to update team');
      }

      setSuccess('Team updated');
      await refreshTeams();
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  };

  const copyToClipboard = (text) => {
    navigator.clipboard.writeText(text);
    setSuccess('Link copied to clipboard!');
  };

  const getRoleIcon = (role) => {
    switch (role) {
      case 'owner':
        return <Crown size={14} className="text-yellow-500" />;
      case 'admin':
        return <Shield size={14} className="text-blue-500" />;
      default:
        return <User size={14} className="text-[#818384]" />;
    }
  };

  // Clear messages after 5 seconds
  useEffect(() => {
    if (success || error) {
      const timer = setTimeout(() => {
        setSuccess('');
        setError('');
      }, 5000);
      return () => clearTimeout(timer);
    }
  }, [success, error]);

  return (
    <div className="p-6 max-w-4xl mx-auto">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-[#d7dadc]">Team Settings</h1>
          <p className="text-[#818384]">Manage your teams and members</p>
        </div>
        <button
          onClick={() => setShowCreateTeam(true)}
          className="flex items-center gap-2 px-4 py-2 bg-[#ff4500] hover:bg-[#ff5414] text-white rounded-lg transition-colors"
        >
          <Plus size={18} />
          Create Team
        </button>
      </div>

      {/* Alerts */}
      {error && (
        <div className="mb-4 p-4 bg-red-900/20 border border-red-500/50 rounded-lg flex items-center gap-3 text-red-400">
          <AlertCircle size={20} />
          <span>{error}</span>
        </div>
      )}
      {success && (
        <div className="mb-4 p-4 bg-green-900/20 border border-green-500/50 rounded-lg flex items-center gap-3 text-green-400">
          <Check size={20} />
          <span>{success}</span>
        </div>
      )}

      {/* Team Selector */}
      <div className="mb-6">
        <label className="block text-sm font-medium text-[#818384] mb-2">
          Select Team
        </label>
        <div className="flex flex-wrap gap-2">
          {teams.map((team) => (
            <button
              key={team.id}
              onClick={() => switchTeam(team.id)}
              className={`px-4 py-2 rounded-lg border transition-colors ${
                currentTeam?.id === team.id
                  ? 'bg-[#ff4500]/20 border-[#ff4500] text-[#ff4500]'
                  : 'bg-[#1a1a1b] border-[#343536] text-[#d7dadc] hover:border-[#818384]'
              }`}
            >
              {team.isPersonal ? 'Personal' : team.name}
            </button>
          ))}
        </div>
      </div>

      {currentTeam && !currentTeam.isPersonal && (
        <div className="bg-[#1a1a1b] border border-[#343536] rounded-lg">
          {/* Tabs */}
          <div className="flex border-b border-[#343536]">
            <button
              onClick={() => setActiveTab('members')}
              className={`px-6 py-3 text-sm font-medium transition-colors ${
                activeTab === 'members'
                  ? 'text-[#ff4500] border-b-2 border-[#ff4500]'
                  : 'text-[#818384] hover:text-[#d7dadc]'
              }`}
            >
              <div className="flex items-center gap-2">
                <Users size={16} />
                Members
              </div>
            </button>
            {isAdmin && (
              <button
                onClick={() => setActiveTab('settings')}
                className={`px-6 py-3 text-sm font-medium transition-colors ${
                  activeTab === 'settings'
                    ? 'text-[#ff4500] border-b-2 border-[#ff4500]'
                    : 'text-[#818384] hover:text-[#d7dadc]'
                }`}
              >
                <div className="flex items-center gap-2">
                  <Settings size={16} />
                  Settings
                </div>
              </button>
            )}
          </div>

          {/* Members Tab */}
          {activeTab === 'members' && (
            <div className="p-6">
              {isAdmin && (
                <div className="mb-6">
                  <button
                    onClick={() => setShowInvite(!showInvite)}
                    className="flex items-center gap-2 px-4 py-2 bg-[#272729] hover:bg-[#343536] border border-[#343536] rounded-lg transition-colors text-[#d7dadc]"
                  >
                    <UserPlus size={18} />
                    Invite Member
                  </button>

                  {showInvite && (
                    <form
                      onSubmit={handleInvite}
                      className="mt-4 p-4 bg-[#272729] rounded-lg"
                    >
                      <div className="flex gap-3">
                        <input
                          type="email"
                          value={inviteEmail}
                          onChange={(e) => setInviteEmail(e.target.value)}
                          placeholder="Email address"
                          className="flex-1 px-4 py-2 bg-[#1a1a1b] border border-[#343536] rounded-lg text-[#d7dadc] focus:outline-none focus:border-[#ff4500]"
                        />
                        <select
                          value={inviteRole}
                          onChange={(e) => setInviteRole(e.target.value)}
                          className="px-4 py-2 bg-[#1a1a1b] border border-[#343536] rounded-lg text-[#d7dadc] focus:outline-none focus:border-[#ff4500]"
                        >
                          <option value="member">Member</option>
                          <option value="admin">Admin</option>
                        </select>
                        <button
                          type="submit"
                          disabled={inviting}
                          className="px-4 py-2 bg-[#ff4500] hover:bg-[#ff5414] text-white rounded-lg transition-colors disabled:opacity-50"
                        >
                          {inviting ? 'Sending...' : 'Send Invite'}
                        </button>
                      </div>

                      {inviteLink && (
                        <div className="mt-3 p-3 bg-[#1a1a1b] rounded-lg">
                          <p className="text-sm text-[#818384] mb-2">
                            Share this invite link:
                          </p>
                          <div className="flex items-center gap-2">
                            <code className="flex-1 text-xs text-[#d7dadc] bg-[#272729] p-2 rounded overflow-x-auto">
                              {inviteLink}
                            </code>
                            <button
                              type="button"
                              onClick={() => copyToClipboard(inviteLink)}
                              className="p-2 hover:bg-[#343536] rounded transition-colors"
                            >
                              <Copy size={16} className="text-[#818384]" />
                            </button>
                          </div>
                        </div>
                      )}
                    </form>
                  )}
                </div>
              )}

              {/* Members List */}
              <div className="space-y-3">
                <h3 className="text-sm font-medium text-[#818384] uppercase tracking-wide">
                  Team Members ({members.length})
                </h3>
                {members.map((member) => (
                  <div
                    key={member.id}
                    className="flex items-center justify-between p-4 bg-[#272729] rounded-lg"
                  >
                    <div className="flex items-center gap-3">
                      <div className="w-10 h-10 rounded-full bg-[#343536] flex items-center justify-center">
                        {member.avatarUrl ? (
                          <img
                            src={member.avatarUrl}
                            alt=""
                            className="w-10 h-10 rounded-full"
                          />
                        ) : (
                          <User size={20} className="text-[#818384]" />
                        )}
                      </div>
                      <div>
                        <p className="text-[#d7dadc] font-medium">
                          {member.fullName || member.email}
                          {member.userId === user?.id && (
                            <span className="ml-2 text-xs text-[#818384]">
                              (you)
                            </span>
                          )}
                        </p>
                        <p className="text-sm text-[#818384]">{member.email}</p>
                      </div>
                    </div>
                    <div className="flex items-center gap-3">
                      <div className="flex items-center gap-1 px-2 py-1 bg-[#1a1a1b] rounded-full">
                        {getRoleIcon(member.role)}
                        <span className="text-xs text-[#818384] capitalize">
                          {member.role}
                        </span>
                      </div>
                      {isAdmin &&
                        member.role !== 'owner' &&
                        member.userId !== user?.id && (
                          <div className="flex gap-2">
                            <select
                              value={member.role}
                              onChange={(e) =>
                                handleUpdateMemberRole(member.id, e.target.value)
                              }
                              className="text-xs px-2 py-1 bg-[#1a1a1b] border border-[#343536] rounded text-[#d7dadc]"
                            >
                              <option value="member">Member</option>
                              <option value="admin">Admin</option>
                            </select>
                            <button
                              onClick={() => handleRemoveMember(member.id)}
                              className="p-1 hover:bg-[#1a1a1b] rounded text-red-500"
                            >
                              <Trash2 size={16} />
                            </button>
                          </div>
                        )}
                    </div>
                  </div>
                ))}
              </div>

              {/* Pending Invitations */}
              {invitations.length > 0 && (
                <div className="mt-6 space-y-3">
                  <h3 className="text-sm font-medium text-[#818384] uppercase tracking-wide">
                    Pending Invitations ({invitations.length})
                  </h3>
                  {invitations.map((invite) => (
                    <div
                      key={invite.id}
                      className="flex items-center justify-between p-4 bg-[#272729] rounded-lg border border-dashed border-[#343536]"
                    >
                      <div className="flex items-center gap-3">
                        <div className="w-10 h-10 rounded-full bg-[#343536] flex items-center justify-center">
                          <Mail size={20} className="text-[#818384]" />
                        </div>
                        <div>
                          <p className="text-[#d7dadc]">{invite.email}</p>
                          <p className="text-xs text-[#818384]">
                            Invited as {invite.role} - Expires{' '}
                            {new Date(invite.expires_at).toLocaleDateString()}
                          </p>
                        </div>
                      </div>
                      {isAdmin && (
                        <button
                          onClick={() => handleCancelInvitation(invite.id)}
                          className="p-2 hover:bg-[#1a1a1b] rounded text-[#818384] hover:text-red-500"
                        >
                          <X size={18} />
                        </button>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* Settings Tab */}
          {activeTab === 'settings' && isAdmin && (
            <div className="p-6">
              <form onSubmit={handleUpdateTeam} className="space-y-4">
                <div>
                  <label className="block text-sm font-medium text-[#d7dadc] mb-2">
                    Team Name
                  </label>
                  <input
                    type="text"
                    value={teamName}
                    onChange={(e) => setTeamName(e.target.value)}
                    className="w-full px-4 py-3 bg-[#272729] border border-[#343536] rounded-lg text-[#d7dadc] focus:outline-none focus:border-[#ff4500]"
                  />
                </div>
                <button
                  type="submit"
                  disabled={saving}
                  className="px-4 py-2 bg-[#ff4500] hover:bg-[#ff5414] text-white rounded-lg transition-colors disabled:opacity-50"
                >
                  {saving ? 'Saving...' : 'Save Changes'}
                </button>
              </form>

              {isOwner && (
                <div className="mt-8 pt-6 border-t border-[#343536]">
                  <h3 className="text-lg font-medium text-red-500 mb-2">
                    Danger Zone
                  </h3>
                  <p className="text-sm text-[#818384] mb-4">
                    Once you delete a team, there is no going back. Please be
                    certain.
                  </p>
                  <button className="px-4 py-2 bg-red-500/20 hover:bg-red-500/30 text-red-500 border border-red-500/50 rounded-lg transition-colors">
                    Delete Team
                  </button>
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {currentTeam?.isPersonal && (
        <div className="bg-[#1a1a1b] border border-[#343536] rounded-lg p-8 text-center">
          <div className="w-16 h-16 bg-[#272729] rounded-full flex items-center justify-center mx-auto mb-4">
            <User size={32} className="text-[#818384]" />
          </div>
          <h3 className="text-lg font-medium text-[#d7dadc] mb-2">
            Personal Account
          </h3>
          <p className="text-[#818384] mb-4">
            This is your personal workspace. Create a team to collaborate with
            others.
          </p>
          <button
            onClick={() => setShowCreateTeam(true)}
            className="px-4 py-2 bg-[#ff4500] hover:bg-[#ff5414] text-white rounded-lg transition-colors"
          >
            Create a Team
          </button>
        </div>
      )}

      {/* Create Team Modal */}
      {showCreateTeam && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <div className="bg-[#1a1a1b] rounded-lg border border-[#343536] p-6 w-full max-w-md">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-xl font-bold text-[#d7dadc]">Create Team</h2>
              <button
                onClick={() => setShowCreateTeam(false)}
                className="p-1 hover:bg-[#272729] rounded"
              >
                <X size={20} className="text-[#818384]" />
              </button>
            </div>
            <form onSubmit={handleCreateTeam}>
              <div className="mb-4">
                <label className="block text-sm font-medium text-[#d7dadc] mb-2">
                  Team Name
                </label>
                <input
                  type="text"
                  value={newTeamName}
                  onChange={(e) => setNewTeamName(e.target.value)}
                  placeholder="My Awesome Team"
                  className="w-full px-4 py-3 bg-[#272729] border border-[#343536] rounded-lg text-[#d7dadc] placeholder-[#818384] focus:outline-none focus:border-[#ff4500]"
                  autoFocus
                />
              </div>
              <div className="flex gap-3">
                <button
                  type="button"
                  onClick={() => setShowCreateTeam(false)}
                  className="flex-1 px-4 py-2 bg-[#272729] hover:bg-[#343536] text-[#d7dadc] rounded-lg transition-colors"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={creatingTeam || !newTeamName.trim()}
                  className="flex-1 px-4 py-2 bg-[#ff4500] hover:bg-[#ff5414] text-white rounded-lg transition-colors disabled:opacity-50"
                >
                  {creatingTeam ? 'Creating...' : 'Create Team'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
