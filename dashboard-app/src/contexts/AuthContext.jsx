import { createContext, useContext, useEffect, useState, useMemo, useCallback, useRef } from 'react';
import { supabase } from '../lib/supabase';

const AuthContext = createContext({});

export const useAuth = () => useContext(AuthContext);

// Post auth events to window so the Chrome extension's content script
// (dashboard_auth_bridge.js) can pick them up and sync to chrome.storage.
function broadcastToExtension(action, payload = null) {
  try {
    window.postMessage({ type: 'RDM_AUTH_EVENT', action, payload }, window.location.origin);
  } catch (e) {
    // Silently fail if postMessage is unavailable
  }
}

// Track whether the extension has acknowledged auth sync so we can stop retrying.
let _extensionSyncAcked = false;
let _syncRetryTimer = null;

function clearSyncRetry() {
  if (_syncRetryTimer) {
    clearTimeout(_syncRetryTimer);
    _syncRetryTimer = null;
  }
}

// Broadcast auth state to the extension with retries until acknowledged.
// This handles cases where the service worker is asleep or the bridge hasn't
// connected yet when the first broadcast fires.
function broadcastAuthWithRetry(payload, attempt = 0) {
  const MAX_ATTEMPTS = 5;
  const DELAYS = [0, 300, 800, 2000, 4000];

  clearSyncRetry();
  _extensionSyncAcked = false;

  const send = (n) => {
    if (_extensionSyncAcked || n >= MAX_ATTEMPTS) return;
    broadcastToExtension('SESSION_RESTORE', payload);
    _syncRetryTimer = setTimeout(() => send(n + 1), DELAYS[Math.min(n + 1, DELAYS.length - 1)]);
  };

  send(attempt);
}

// Listen for the bridge's acknowledgment so we stop retrying.
if (typeof window !== 'undefined') {
  window.addEventListener('message', (event) => {
    if (
      event.data?.type === 'RDM_AUTH_RESPONSE' &&
      event.data?.action === 'SESSION_RESTORE' &&
      event.data?.success
    ) {
      _extensionSyncAcked = true;
      clearSyncRetry();
    }
  });
}

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [session, setSession] = useState(null);
  const sessionRef = useRef(null);
  const [teams, setTeams] = useState([]);
  const [currentTeam, setCurrentTeam] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let mounted = true;

    // Safety timeout - never stay loading forever
    const timeout = setTimeout(() => {
      if (mounted && loading) {
        console.warn('[AuthContext] Init timeout - forcing loading=false');
        setLoading(false);
      }
    }, 5000);

    // Listen for auth changes (including INITIAL_SESSION)
    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange(async (event, session) => {
      if (!mounted) return;

      setSession(session);
      sessionRef.current = session;
      setUser(session?.user ?? null);

      if (event === 'TOKEN_REFRESHED' && session) {
        broadcastToExtension('TOKEN_REFRESH', {
          accessToken: session.access_token,
          refreshToken: session.refresh_token,
          expiresAt: session.expires_at,
        });
      }

      if (session?.user) {
        await fetchUserTeams(session.user.id);
      } else {
        setTeams([]);
        setCurrentTeam(null);
        broadcastToExtension('LOGOUT');
        setLoading(false);
      }
    });

    // Also try getSession as fallback
    supabase.auth.getSession().then(({ data: { session } }) => {
      if (!mounted) return;
      setSession(session);
      sessionRef.current = session;
      setUser(session?.user ?? null);
      if (session?.user) {
        fetchUserTeams(session.user.id);
      } else {
        setLoading(false);
      }
    }).catch(() => {
      if (mounted) setLoading(false);
    });

    return () => {
      mounted = false;
      clearTimeout(timeout);
      subscription.unsubscribe();
    };
  }, []);

  // When the extension content script loads (or reloads), it posts RDM_BRIDGE_READY.
  // Respond by re-broadcasting the current auth state so the extension picks it up.
  // The bridge retries this announcement several times, so we'll catch it even if
  // React mounted after the first announcement.
  useEffect(() => {
    const handleBridgeReady = (event) => {
      if (event.data?.type !== 'RDM_BRIDGE_READY') return;
      const s = sessionRef.current;
      if (!s) return;
      // Broadcast even without currentTeam — the extension can still use the tokens
      broadcastAuthWithRetry({
        accessToken: s.access_token,
        refreshToken: s.refresh_token,
        expiresAt: s.expires_at,
        teamId: currentTeam?.id || null,
        teams: teams.map(t => ({ id: t.id, name: t.name, is_personal: t.isPersonal })),
        userEmail: s.user?.email || '',
        userName: s.user?.user_metadata?.full_name || '',
      });
    };
    window.addEventListener('message', handleBridgeReady);
    return () => window.removeEventListener('message', handleBridgeReady);
  }, [currentTeam, teams]);

  const fetchUserTeams = async (userId, preferredTeamId = null) => {
    try {
      const { data, error } = await supabase
        .from('team_members')
        .select(`
          team_id,
          role,
          teams (
            id,
            name,
            slug,
            is_personal,
            settings
          )
        `)
        .eq('user_id', userId);

      if (error) throw error;

      const teamList = data.map((membership) => ({
        id: membership.teams.id,
        name: membership.teams.name,
        slug: membership.teams.slug,
        isPersonal: membership.teams.is_personal,
        settings: membership.teams.settings,
        role: membership.role,
      }));

      setTeams(teamList);

      // Set current team: prefer the explicit team, then localStorage, then personal
      const targetTeamId = preferredTeamId || localStorage.getItem('currentTeamId');
      const targetTeam = teamList.find((t) => t.id === targetTeamId);
      const personalTeam = teamList.find((t) => t.isPersonal);

      const selectedTeam = targetTeam || personalTeam || teamList[0] || null;
      setCurrentTeam(selectedTeam);

      // Always persist the selected team to localStorage so the API client
      // sends the correct X-Team-ID header on subsequent requests and after restarts
      if (selectedTeam) {
        localStorage.setItem('currentTeamId', selectedTeam.id);
      }

      // Broadcast auth state to Chrome extension (with retries)
      const s = sessionRef.current;
      if (s) {
        broadcastAuthWithRetry({
          accessToken: s.access_token,
          refreshToken: s.refresh_token,
          expiresAt: s.expires_at,
          teamId: selectedTeam?.id || null,
          teams: teamList.map(t => ({ id: t.id, name: t.name, is_personal: t.isPersonal })),
          userEmail: s.user?.email || '',
          userName: s.user?.user_metadata?.full_name || '',
        });
      }
    } catch (error) {
      console.error('Error fetching teams:', error);
      // Still broadcast auth tokens even if team fetch failed, so the
      // extension at least gets authenticated (without team context).
      const s = sessionRef.current;
      if (s) {
        broadcastAuthWithRetry({
          accessToken: s.access_token,
          refreshToken: s.refresh_token,
          expiresAt: s.expires_at,
          teamId: null,
          teams: [],
          userEmail: s.user?.email || '',
          userName: s.user?.user_metadata?.full_name || '',
        });
      }
    } finally {
      setLoading(false);
    }
  };

  const switchTeam = useCallback((teamId) => {
    const team = teams.find((t) => t.id === teamId);
    if (team) {
      setCurrentTeam(team);
      localStorage.setItem('currentTeamId', teamId);
      broadcastToExtension('TEAM_SWITCH', { teamId });
    }
  }, [teams]);

  const signUp = useCallback(async (email, password, fullName) => {
    const { data, error } = await supabase.auth.signUp({
      email,
      password,
      options: {
        data: {
          full_name: fullName,
        },
      },
    });

    if (error) throw error;
    return data;
  }, []);

  const signIn = useCallback(async (email, password) => {
    const { data, error } = await supabase.auth.signInWithPassword({
      email,
      password,
    });

    if (error) throw error;

    // Set state directly to avoid race condition with onAuthStateChange
    setSession(data.session);
    sessionRef.current = data.session;
    setUser(data.user);
    if (data.user) {
      await fetchUserTeams(data.user.id);
    }

    return data;
  }, []);

  const signOut = useCallback(async () => {
    const { error } = await supabase.auth.signOut();
    if (error) throw error;

    setUser(null);
    setSession(null);
    sessionRef.current = null;
    setTeams([]);
    setCurrentTeam(null);
    localStorage.removeItem('currentTeamId');
    broadcastToExtension('LOGOUT');
  }, []);

  const getAccessToken = useCallback(() => {
    return session?.access_token;
  }, [session]);

  const refreshTeams = useCallback(async (preferredTeamId = null) => {
    if (user) return fetchUserTeams(user.id, preferredTeamId);
  }, [user]);

  const value = useMemo(() => ({
    user,
    session,
    teams,
    currentTeam,
    loading,
    signUp,
    signIn,
    signOut,
    switchTeam,
    getAccessToken,
    refreshTeams,
  }), [user, session, teams, currentTeam, loading, signUp, signIn, signOut, switchTeam, getAccessToken, refreshTeams]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export default AuthContext;
