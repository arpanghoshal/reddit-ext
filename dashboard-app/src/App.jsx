import { useState } from 'react';
import { BrowserRouter, Routes, Route, NavLink } from 'react-router-dom';
import { LayoutDashboard, MessageSquare, Filter, Users, Shield, Settings as SettingsIcon } from 'lucide-react';
import Dashboard from './pages/Dashboard';
import Queue from './pages/Queue';
import Inbox from './pages/Inbox';
import Accounts from './pages/Accounts';
import Rules from './pages/Rules';
import Settings from './components/Settings';

function App() {
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [authKey, setAuthKey] = useState(0); // Used to trigger re-renders on auth change

  const navItems = [
    { to: '/', icon: LayoutDashboard, label: 'Dashboard' },
    { to: '/queue', icon: MessageSquare, label: 'Queue' },
    { to: '/inbox', icon: MessageSquare, label: 'Inbox' },
    { to: '/accounts', icon: Users, label: 'Accounts' },
    { to: '/rules', icon: Filter, label: 'Rules' },
  ];

  const handleAuthChange = () => {
    setAuthKey(prev => prev + 1);
  };

  return (
    <BrowserRouter>
      <div className="min-h-screen flex bg-[#030303]">
        {/* Sidebar */}
        <aside className="w-64 bg-[#1a1a1b] text-white flex flex-col border-r border-[#343536]">
          <div className="p-4 border-b border-[#343536]">
            <h1 className="text-xl font-bold text-[#ff4500]">
              Reddit Insight
            </h1>
            <p className="text-sm text-[#818384]">Automation Dashboard</p>
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
            <button
              onClick={() => setSettingsOpen(true)}
              className="flex items-center gap-2 w-full px-4 py-2 text-[#818384] hover:text-white hover:bg-[#272729] rounded-lg transition-colors"
            >
              <SettingsIcon size={16} />
              <span>Settings</span>
            </button>
            <div className="flex items-center gap-2 text-sm text-[#818384] px-4">
              <Shield size={16} />
              <span>v1.1.0</span>
            </div>
          </div>
        </aside>

        {/* Main Content */}
        <main className="flex-1 overflow-auto bg-[#030303]" key={authKey}>
          <Routes>
            <Route path="/" element={<Dashboard />} />
            <Route path="/queue" element={<Queue />} />
            <Route path="/inbox" element={<Inbox />} />
            <Route path="/accounts" element={<Accounts />} />
            <Route path="/rules" element={<Rules />} />
          </Routes>
        </main>

        {/* Settings Modal */}
        <Settings
          isOpen={settingsOpen}
          onClose={() => setSettingsOpen(false)}
          onAuthChange={handleAuthChange}
        />
      </div>
    </BrowserRouter>
  );
}

export default App;
