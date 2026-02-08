import { useState, useEffect, useRef } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import { supabase } from '../lib/supabase';
import { CheckCircle, AlertCircle, Users, LogIn, Eye, EyeOff } from 'lucide-react';

const API_BASE_URL = import.meta.env.VITE_API_URL || 'http://localhost:3000/api';

export default function AcceptInvite() {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const { user, session, refreshTeams, switchTeam } = useAuth();

  const token = searchParams.get('token');

  const [inviteInfo, setInviteInfo] = useState(null);
  const [loadingInfo, setLoadingInfo] = useState(true);
  const [accepting, setAccepting] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState(false);
  const [joinedTeam, setJoinedTeam] = useState(null);

  // Login form state
  const [showLoginForm, setShowLoginForm] = useState(false);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [loggingIn, setLoggingIn] = useState(false);

  // Prevent duplicate accept calls
  const acceptedRef = useRef(false);

  // 1. On mount: check for hash tokens from Supabase magic link redirect
  useEffect(() => {
    const processHashTokens = async () => {
      const hash = window.location.hash;
      if (hash && hash.includes('access_token')) {
        const params = new URLSearchParams(hash.substring(1));
        const accessToken = params.get('access_token');
        const refreshToken = params.get('refresh_token');

        if (accessToken && refreshToken) {
          try {
            const { error: sessionError } = await supabase.auth.setSession({
              access_token: accessToken,
              refresh_token: refreshToken,
            });

            if (sessionError) {
              console.error('Failed to set session from hash:', sessionError);
              setError('Failed to authenticate from email link. Please try logging in.');
            }

            // Clean the URL hash
            window.history.replaceState(
              null, '',
              window.location.pathname + window.location.search
            );
          } catch (err) {
            console.error('Error processing hash tokens:', err);
            setError('Failed to process authentication. Please try logging in.');
          }
        }
      }
    };

    processHashTokens();
  }, []);

  // 2. Fetch invite info
  useEffect(() => {
    if (!token) {
      setError('No invitation token provided');
      setLoadingInfo(false);
      return;
    }

    const fetchInviteInfo = async () => {
      try {
        const response = await fetch(
          `${API_BASE_URL}/auth/invite-info?token=${encodeURIComponent(token)}`
        );
        const data = await response.json();

        if (!response.ok) {
          throw new Error(data.detail || 'Invalid invitation');
        }

        setInviteInfo(data);
        setEmail(data.email);
      } catch (err) {
        setError(err.message || 'Failed to load invitation details');
      } finally {
        setLoadingInfo(false);
      }
    };

    fetchInviteInfo();
  }, [token]);

  // 3. Auto-accept when user is authenticated and invite info is loaded
  useEffect(() => {
    if (user && session && inviteInfo && !success && !accepting && !acceptedRef.current) {
      handleAcceptInvite();
    }
  }, [user, session, inviteInfo]);

  const handleAcceptInvite = async () => {
    if (accepting || success || acceptedRef.current) return;
    acceptedRef.current = true;
    setAccepting(true);
    setError('');

    try {
      const headers = { 'Content-Type': 'application/json' };

      // Attach JWT if we have a session
      const currentSession = session || (await supabase.auth.getSession()).data?.session;
      if (currentSession?.access_token) {
        headers['Authorization'] = `Bearer ${currentSession.access_token}`;
      }

      const body = { token };
      if (!currentSession) {
        body.email = email;
        body.password = password;
      }

      const response = await fetch(`${API_BASE_URL}/auth/accept-invite`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
      });

      const data = await response.json();

      if (!response.ok) {
        acceptedRef.current = false;
        throw new Error(data.detail || 'Failed to accept invitation');
      }

      setSuccess(true);
      setJoinedTeam(data.team);

      // Switch to the invited team
      const teamId = data.team_id || data.team?.id;
      if (teamId) {
        localStorage.setItem('currentTeamId', teamId);
        await refreshTeams(teamId);
      }

      // Navigate to dashboard after a short delay
      setTimeout(() => {
        navigate('/', { replace: true });
      }, 2000);
    } catch (err) {
      setError(err.message || 'Failed to accept invitation');
    } finally {
      setAccepting(false);
    }
  };

  const handleLoginAndAccept = async (e) => {
    e.preventDefault();
    setLoggingIn(true);
    setError('');

    try {
      const { error: signInError } = await supabase.auth.signInWithPassword({
        email,
        password,
      });

      if (signInError) throw signInError;

      // The useEffect watching user/session will trigger auto-accept
    } catch (err) {
      setError(err.message || 'Failed to sign in');
    } finally {
      setLoggingIn(false);
    }
  };

  // --- RENDER ---

  if (loadingInfo) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-[#030303]">
        <div className="animate-spin h-8 w-8 border-2 border-[#ff4500] border-t-transparent rounded-full" />
      </div>
    );
  }

  if (!token) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-[#030303] px-4">
        <div className="max-w-md w-full bg-[#1a1a1b] rounded-lg border border-[#343536] p-8 text-center">
          <AlertCircle size={48} className="text-red-500 mx-auto mb-4" />
          <h2 className="text-xl font-bold text-[#d7dadc] mb-2">Invalid Invitation</h2>
          <p className="text-[#818384]">No invitation token was provided.</p>
          <button
            onClick={() => navigate('/login')}
            className="mt-6 px-6 py-2 bg-[#ff4500] hover:bg-[#ff5414] text-white rounded-lg transition-colors"
          >
            Go to Login
          </button>
        </div>
      </div>
    );
  }

  if (success) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-[#030303] px-4">
        <div className="max-w-md w-full bg-[#1a1a1b] rounded-lg border border-[#343536] p-8 text-center">
          <div className="w-16 h-16 bg-green-500/20 rounded-full flex items-center justify-center mx-auto mb-6">
            <CheckCircle size={32} className="text-green-500" />
          </div>
          <h2 className="text-2xl font-bold text-[#d7dadc] mb-2">
            Welcome to {joinedTeam?.name || 'the team'}!
          </h2>
          <p className="text-[#818384]">
            You have successfully joined the team. Redirecting to dashboard...
          </p>
        </div>
      </div>
    );
  }

  if (error && !inviteInfo) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-[#030303] px-4">
        <div className="max-w-md w-full bg-[#1a1a1b] rounded-lg border border-[#343536] p-8 text-center">
          <AlertCircle size={48} className="text-red-500 mx-auto mb-4" />
          <h2 className="text-xl font-bold text-[#d7dadc] mb-2">Invalid Invitation</h2>
          <p className="text-[#818384]">{error}</p>
          <button
            onClick={() => navigate('/login')}
            className="mt-6 px-6 py-2 bg-[#ff4500] hover:bg-[#ff5414] text-white rounded-lg transition-colors"
          >
            Go to Login
          </button>
        </div>
      </div>
    );
  }

  if (accepting) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-[#030303] px-4">
        <div className="max-w-md w-full bg-[#1a1a1b] rounded-lg border border-[#343536] p-8 text-center">
          <div className="animate-spin h-8 w-8 border-2 border-[#ff4500] border-t-transparent rounded-full mx-auto mb-4" />
          <h2 className="text-xl font-bold text-[#d7dadc]">Joining team...</h2>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-[#030303] px-4">
      <div className="max-w-md w-full">
        <div className="text-center mb-8">
          <h1 className="text-3xl font-bold text-[#ff4500]">Reddit Automated DM</h1>
          <p className="text-[#818384] mt-2">Team Invitation</p>
        </div>

        <div className="bg-[#1a1a1b] rounded-lg border border-[#343536] p-8">
          {error && (
            <div className="mb-6 p-4 bg-red-900/20 border border-red-500/50 rounded-lg flex items-center gap-3 text-red-400">
              <AlertCircle size={20} />
              <span>{error}</span>
            </div>
          )}

          {/* Invitation Details */}
          <div className="text-center mb-6">
            <div className="w-16 h-16 bg-[#ff4500]/20 rounded-full flex items-center justify-center mx-auto mb-4">
              <Users size={32} className="text-[#ff4500]" />
            </div>
            <h2 className="text-xl font-bold text-[#d7dadc] mb-1">
              Join {inviteInfo?.team_name}
            </h2>
            <p className="text-[#818384]">
              You've been invited as{' '}
              <span className="text-[#d7dadc] font-medium capitalize">{inviteInfo?.role}</span>
            </p>
            <p className="text-sm text-[#818384] mt-1">
              Invitation for {inviteInfo?.email}
            </p>
          </div>

          {/* If user is already logged in, show accept button */}
          {user ? (
            <button
              onClick={handleAcceptInvite}
              disabled={accepting}
              className="w-full flex items-center justify-center gap-2 px-4 py-3 bg-[#ff4500] hover:bg-[#ff5414] text-white rounded-lg font-medium transition-colors disabled:opacity-50"
            >
              <CheckCircle size={20} />
              Accept Invitation
            </button>
          ) : (
            <>
              {!showLoginForm ? (
                <div className="space-y-3">
                  <button
                    onClick={() => setShowLoginForm(true)}
                    className="w-full flex items-center justify-center gap-2 px-4 py-3 bg-[#ff4500] hover:bg-[#ff5414] text-white rounded-lg font-medium transition-colors"
                  >
                    <LogIn size={20} />
                    Sign In to Accept
                  </button>
                  <p className="text-center text-sm text-[#818384]">
                    Don't have an account?{' '}
                    <button
                      onClick={() => navigate('/signup')}
                      className="text-[#ff4500] hover:underline font-medium"
                    >
                      Sign up first
                    </button>
                    , then come back to this link.
                  </p>
                </div>
              ) : (
                <form onSubmit={handleLoginAndAccept} className="space-y-4">
                  <div>
                    <label className="block text-sm font-medium text-[#d7dadc] mb-2">
                      Email
                    </label>
                    <input
                      type="email"
                      value={email}
                      onChange={(e) => setEmail(e.target.value)}
                      required
                      className="w-full px-4 py-3 bg-[#272729] border border-[#343536] rounded-lg text-[#d7dadc] placeholder-[#818384] focus:outline-none focus:border-[#ff4500] transition-colors"
                      placeholder="you@example.com"
                    />
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-[#d7dadc] mb-2">
                      Password
                    </label>
                    <div className="relative">
                      <input
                        type={showPassword ? 'text' : 'password'}
                        value={password}
                        onChange={(e) => setPassword(e.target.value)}
                        required
                        className="w-full px-4 py-3 bg-[#272729] border border-[#343536] rounded-lg text-[#d7dadc] placeholder-[#818384] focus:outline-none focus:border-[#ff4500] transition-colors pr-12"
                        placeholder="Your password"
                      />
                      <button
                        type="button"
                        onClick={() => setShowPassword(!showPassword)}
                        className="absolute right-3 top-1/2 -translate-y-1/2 text-[#818384] hover:text-[#d7dadc]"
                      >
                        {showPassword ? <EyeOff size={20} /> : <Eye size={20} />}
                      </button>
                    </div>
                  </div>
                  <button
                    type="submit"
                    disabled={loggingIn}
                    className="w-full flex items-center justify-center gap-2 px-4 py-3 bg-[#ff4500] hover:bg-[#ff5414] text-white rounded-lg font-medium transition-colors disabled:opacity-50"
                  >
                    {loggingIn ? (
                      <span className="animate-spin h-5 w-5 border-2 border-white border-t-transparent rounded-full" />
                    ) : (
                      <>
                        <LogIn size={20} />
                        Sign In & Accept
                      </>
                    )}
                  </button>
                </form>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
