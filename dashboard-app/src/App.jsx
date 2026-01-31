import { BrowserRouter, Routes, Route, NavLink } from 'react-router-dom';
import { LayoutDashboard, MessageSquare, Filter, Users, Shield, Settings } from 'lucide-react';
import Dashboard from './pages/Dashboard';
import Queue from './pages/Queue';
import Inbox from './pages/Inbox';
import Accounts from './pages/Accounts';
import Rules from './pages/Rules';

function App() {
  const navItems = [
    { to: '/', icon: LayoutDashboard, label: 'Dashboard' },
    { to: '/queue', icon: MessageSquare, label: 'Queue' },
    { to: '/inbox', icon: MessageSquare, label: 'Inbox' },
    { to: '/accounts', icon: Users, label: 'Accounts' },
    { to: '/rules', icon: Filter, label: 'Rules' },
  ];

  return (
    <BrowserRouter>
      <div className="min-h-screen flex">
        {/* Sidebar */}
        <aside className="w-64 bg-gray-900 text-white flex flex-col">
          <div className="p-4 border-b border-gray-700">
            <h1 className="text-xl font-bold text-reddit-orange">
              Reddit Automation
            </h1>
            <p className="text-sm text-gray-400">Dashboard</p>
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
                          ? 'bg-reddit-orange text-white'
                          : 'text-gray-300 hover:bg-gray-800'
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

          <div className="p-4 border-t border-gray-700">
            <div className="flex items-center gap-2 text-sm text-gray-400">
              <Shield size={16} />
              <span>v1.0.0</span>
            </div>
          </div>
        </aside>

        {/* Main Content */}
        <main className="flex-1 overflow-auto">
          <Routes>
            <Route path="/" element={<Dashboard />} />
            <Route path="/queue" element={<Queue />} />
            <Route path="/inbox" element={<Inbox />} />
            <Route path="/accounts" element={<Accounts />} />
            <Route path="/rules" element={<Rules />} />
          </Routes>
        </main>
      </div>
    </BrowserRouter>
  );
}

export default App;
