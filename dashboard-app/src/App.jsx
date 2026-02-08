import { useState } from 'react';
import { BrowserRouter, Routes, Route, NavLink, Navigate } from 'react-router-dom';
import { LayoutDashboard, MessageSquare, Users, Shield, Settings as SettingsIcon, XCircle, LogOut, BarChart2, ClipboardList } from 'lucide-react';
import { AuthProvider, useAuth } from './contexts/AuthContext';
import Dashboard from './pages/Dashboard';
import Queue from './pages/Queue';
import Inbox from './pages/Inbox';
import Accounts from './pages/Accounts';
import Settings from './pages/Settings';
import Skipped from './pages/Skipped';
import Login from './pages/Login';
import Signup from './pages/Signup';
import TeamSettings from './pages/TeamSettings';
import TeamAnalytics from './pages/TeamAnalytics';
import AuditLog from './pages/AuditLog';
import TeamSwitcher from './components/TeamSwitcher';

function ProtectedRoute({ children }) {
  const { user, loading } = useAuth();

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-[#030303]">
        <div className="animate-spin h-8 w-8 border-2 border-[#ff4500] border-t-transparent rounded-full" />
      </div>
    );
  }

  if (!user) {
    return <Navigate to="/login" replace />;
  }

  return children;
}

function AppLayout() {
  const [authKey, setAuthKey] = useState(0);
  const { user, signOut, currentTeam } = useAuth();

  const navItems = [
    { to: '/', icon: LayoutDashboard, label: 'Dashboard' },
    { to: '/queue', icon: MessageSquare, label: 'Queue' },
    { to: '/inbox', icon: MessageSquare, label: 'Inbox' },
    { to: '/accounts', icon: Users, label: 'Accounts' },
    { to: '/skipped', icon: XCircle, label: 'Skipped' },
    { to: '/team-settings', icon: Users, label: 'Team' },
    { to: '/analytics', icon: BarChart2, label: 'Analytics' },
    { to: '/audit-log', icon: ClipboardList, label: 'Audit Log' },
    { to: '/settings', icon: SettingsIcon, label: 'Settings' },
  ];

  const handleSignOut = async () => {
    try {
      await signOut();
    } catch (err) {
      console.error('Sign out error:', err);
    }
  };

  return (
    <div className="min-h-screen flex bg-[#030303]">
      {/* Sidebar */}
      <aside className="w-64 bg-[#1a1a1b] text-white flex flex-col border-r border-[#343536]">
        <div className="p-4 border-b border-[#343536]">
          <h1 className="text-xl font-bold text-[#ff4500]">
            Reddit Automated DM
          </h1>
          <p className="text-sm text-[#818384]">Automation Dashboard</p>
        </div>

        {/* Team Switcher */}
        <div className="p-4 border-b border-[#343536]">
          <TeamSwitcher />
        </div>

        <nav className="flex-1 p-4">
          <ul className="space-y-2">
            {navItems.map(({ to, icon: Icon, label }) => (
              <li key={to}>
                <NavLink
                  to={to}
                  className={({ isActive }) =>
                    `flex items-center gap-3 px-4 py-2 rounded-lg transition-colors ${
                      isActive
                        ? 'bg-[#ff4500] text-white'
                        : 'text-[#d7dadc] hover:bg-[#272729]'
                    }`
                  }
                >
                  <Icon size={20} />
                  {label}
                </NavLink>
              </li>
            ))}
          </ul>
        </nav>

        <div className="p-4 border-t border-[#343536] space-y-2">
          {user && (
            <div className="px-4 py-2 text-sm text-[#818384]">
              <p className="truncate">{user.email}</p>
            </div>
          )}
          <button
            onClick={handleSignOut}
            className="flex items-center gap-2 w-full px-4 py-2 text-[#818384] hover:text-white hover:bg-[#272729] rounded-lg transition-colors"
          >
            <LogOut size={16} />
            <span>Sign Out</span>
          </button>
          <div className="flex items-center gap-2 text-sm text-[#818384] px-4">
            <Shield size={16} />
            <span>v1.3.0</span>
          </div>
        </div>
      </aside>

      {/* Main Content */}
      <main className="flex-1 overflow-auto bg-[#dae0e6]" key={`${authKey}-${currentTeam?.id}`}>
        <Routes>
          <Route path="/" element={<Dashboard />} />
          <Route path="/queue" element={<Queue />} />
          <Route path="/inbox" element={<Inbox />} />
          <Route path="/accounts" element={<Accounts />} />
          <Route path="/skipped" element={<Skipped />} />
          <Route path="/analytics" element={<TeamAnalytics />} />
          <Route path="/audit-log" element={<AuditLog />} />
          <Route path="/settings" element={<Settings />} />
          <Route path="/team-settings" element={<TeamSettings />} />
        </Routes>
      </main>

    </div>
  );
}

function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <Routes>
          <Route path="/login" element={<Login />} />
          <Route path="/signup" element={<Signup />} />
          <Route
            path="/*"
            element={
              <ProtectedRoute>
                <AppLayout />
              </ProtectedRoute>
            }
          />
        </Routes>
      </AuthProvider>
    </BrowserRouter>
  );
}

export default App;
