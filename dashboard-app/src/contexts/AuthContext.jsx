import { createContext, useContext, useEffect, useState, useMemo, useCallback } from 'react';
import { supabase } from '../lib/supabase';

const AuthContext = createContext({});

export const useAuth = () => useContext(AuthContext);

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [session, setSession] = useState(null);
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
      setUser(session?.user ?? null);

      if (session?.user) {
        await fetchUserTeams(session.user.id);
      } else {
        setTeams([]);
        setCurrentTeam(null);
        setLoading(false);
      }
    });

    // Also try getSession as fallback
    supabase.auth.getSession().then(({ data: { session } }) => {
      if (!mounted) return;
      setSession(session);
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
    } catch (error) {
      console.error('Error fetching teams:', error);
    } finally {
      setLoading(false);
    }
  };

  const switchTeam = useCallback((teamId) => {
    const team = teams.find((t) => t.id === teamId);
    if (team) {
      setCurrentTeam(team);
      localStorage.setItem('currentTeamId', teamId);
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
    setTeams([]);
    setCurrentTeam(null);
    localStorage.removeItem('currentTeamId');
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
