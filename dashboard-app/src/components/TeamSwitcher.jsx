import { useState, useRef, useEffect } from 'react';
import { useAuth } from '../contexts/AuthContext';
import { ChevronDown, Check, Plus, Users, User } from 'lucide-react';
import { useNavigate } from 'react-router-dom';

export default function TeamSwitcher() {
  const { teams, currentTeam, switchTeam, user } = useAuth();
  const [isOpen, setIsOpen] = useState(false);
  const dropdownRef = useRef(null);
  const navigate = useNavigate();

  useEffect(() => {
    const handleClickOutside = (event) => {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target)) {
        setIsOpen(false);
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  if (!user || !currentTeam) return null;

  return (
    <div className="relative" ref={dropdownRef}>
      <button
        onClick={() => setIsOpen(!isOpen)}
        className="flex items-center gap-2 px-3 py-2 bg-[#272729] hover:bg-[#343536] border border-[#343536] rounded-lg transition-colors w-full"
      >
        <div className="w-8 h-8 rounded-lg bg-[#ff4500]/20 flex items-center justify-center">
          {currentTeam.isPersonal ? (
            <User size={16} className="text-[#ff4500]" />
          ) : (
            <Users size={16} className="text-[#ff4500]" />
          )}
        </div>
        <div className="flex-1 text-left min-w-0">
          <p className="text-sm font-medium text-[#d7dadc] truncate">
            {currentTeam.isPersonal ? 'Personal' : currentTeam.name}
          </p>
          <p className="text-xs text-[#818384] truncate capitalize">
            {currentTeam.role}
          </p>
        </div>
        <ChevronDown
          size={16}
          className={`text-[#818384] transition-transform ${isOpen ? 'rotate-180' : ''}`}
        />
      </button>

      {isOpen && (
        <div className="absolute left-0 right-0 mt-2 bg-[#1a1a1b] border border-[#343536] rounded-lg shadow-lg overflow-hidden z-50">
          <div className="p-2">
            <p className="px-3 py-2 text-xs font-medium text-[#818384] uppercase tracking-wide">
              Teams
            </p>
            {teams.map((team) => (
              <button
                key={team.id}
                onClick={() => {
                  switchTeam(team.id);
                  setIsOpen(false);
                }}
                className="w-full flex items-center gap-3 px-3 py-2 rounded-lg hover:bg-[#272729] transition-colors"
              >
                <div className="w-8 h-8 rounded-lg bg-[#272729] flex items-center justify-center">
                  {team.isPersonal ? (
                    <User size={16} className="text-[#818384]" />
                  ) : (
                    <Users size={16} className="text-[#818384]" />
                  )}
                </div>
                <div className="flex-1 text-left min-w-0">
                  <p className="text-sm text-[#d7dadc] truncate">
                    {team.isPersonal ? 'Personal' : team.name}
                  </p>
                  <p className="text-xs text-[#818384] capitalize">{team.role}</p>
                </div>
                {currentTeam.id === team.id && (
                  <Check size={16} className="text-[#ff4500]" />
                )}
              </button>
            ))}
          </div>

          <div className="border-t border-[#343536] p-2">
            <button
              onClick={() => {
                setIsOpen(false);
                navigate('/team-settings');
              }}
              className="w-full flex items-center gap-3 px-3 py-2 rounded-lg hover:bg-[#272729] transition-colors text-[#818384] hover:text-[#d7dadc]"
            >
              <Plus size={16} />
              <span className="text-sm">Create or manage teams</span>
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
