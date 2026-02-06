import { createContext, useContext, useEffect, useState } from 'react';
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
    // Get initial session
    supabase.auth.getSession().then(({ data: { session } }) => {
      setSession(session);
      setUser(session?.user ?? null);
      if (session?.user) {
        fetchUserTeams(session.user.id);
      } else {
        setLoading(false);
      }
    });

    // Listen for auth changes
    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange(async (event, session) => {
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

    return () => subscription.unsubscribe();
  }, []);

  const fetchUserTeams = async (userId) => {
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

      // Set current team from localStorage or default to personal
      const savedTeamId = localStorage.getItem('currentTeamId');
      const savedTeam = teamList.find((t) => t.id === savedTeamId);
      const personalTeam = teamList.find((t) => t.isPersonal);

      setCurrentTeam(savedTeam || personalTeam || teamList[0] || null);
    } catch (error) {
      console.error('Error fetching teams:', error);
    } finally {
      setLoading(false);
    }
  };

  const switchTeam = (teamId) => {
    const team = teams.find((t) => t.id === teamId);
    if (team) {
      setCurrentTeam(team);
      localStorage.setItem('currentTeamId', teamId);
    }
  };

  const signUp = async (email, password, fullName) => {
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
  };

  const signIn = async (email, password) => {
    const { data, error } = await supabase.auth.signInWithPassword({
      email,
      password,
    });

    if (error) throw error;
    return data;
  };

  const signOut = async () => {
    const { error } = await supabase.auth.signOut();
    if (error) throw error;

    setUser(null);
    setSession(null);
    setTeams([]);
    setCurrentTeam(null);
    localStorage.removeItem('currentTeamId');
  };

  const getAccessToken = () => {
    return session?.access_token;
  };

  const value = {
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
    refreshTeams: () => user && fetchUserTeams(user.id),
  };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export default AuthContext;
