import { useState, useEffect } from 'react';
import {
  Clock, User, Filter, Download, RefreshCw,
  UserPlus, UserMinus, Settings, MessageSquare,
  Target, Shield, ChevronLeft, ChevronRight
} from 'lucide-react';
import { supabase } from '../lib/supabase';

/**
 * AuditLog Page
 * Displays team activity log with filtering and export
 */
export default function AuditLog() {
  const [entries, setEntries] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [filters, setFilters] = useState({
    action: '',
    user_id: '',
    resource_type: '',
    start_date: '',
    end_date: ''
  });
  const [pagination, setPagination] = useState({
    offset: 0,
    limit: 25,
    hasMore: true
  });

  useEffect(() => {
    fetchAuditLog();
  }, [filters, pagination.offset]);

  const fetchAuditLog = async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams();

      if (filters.action) params.append('action', filters.action);
      if (filters.user_id) params.append('user_id', filters.user_id);
      if (filters.resource_type) params.append('resource_type', filters.resource_type);
      if (filters.start_date) params.append('start_date', filters.start_date);
      if (filters.end_date) params.append('end_date', filters.end_date);

      params.append('limit', pagination.limit.toString());
      params.append('offset', pagination.offset.toString());

      const { data: { session } } = await supabase.auth.getSession();
      const accessToken = session?.access_token;

      const response = await fetch(`/api/audit?${params}`, {
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'X-Team-ID': localStorage.getItem('currentTeamId') || ''
        }
      });

      if (!response.ok) {
        if (response.status === 403) {
          throw new Error('You do not have permission to view the audit log');
        }
        throw new Error('Failed to fetch audit log');
      }

      const data = await response.json();
      setEntries(data.data || []);
      setPagination(prev => ({
        ...prev,
        hasMore: (data.data || []).length === prev.limit
      }));
    } catch (err) {
      console.error('Error fetching audit log:', err);
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  const getActionIcon = (action) => {
    if (action.startsWith('member.')) return <User className="w-4 h-4" />;
    if (action.startsWith('account.')) return <Shield className="w-4 h-4" />;
    if (action.startsWith('campaign.')) return <Target className="w-4 h-4" />;
    if (action.startsWith('dm.')) return <MessageSquare className="w-4 h-4" />;
    if (action.startsWith('settings.')) return <Settings className="w-4 h-4" />;
    return <Clock className="w-4 h-4" />;
  };

  const getActionColor = (action) => {
    if (action.includes('removed') || action.includes('deleted') || action.includes('rejected')) {
      return 'text-red-400';
    }
    if (action.includes('added') || action.includes('created') || action.includes('joined') || action.includes('approved')) {
      return 'text-green-400';
    }
    if (action.includes('updated') || action.includes('changed')) {
      return 'text-yellow-400';
    }
    return 'text-[#818384]';
  };

  const formatDate = (dateStr) => {
    const date = new Date(dateStr);
    return date.toLocaleString();
  };

  const formatAction = (action) => {
    return action.split('.').map(word =>
      word.charAt(0).toUpperCase() + word.slice(1)
    ).join(' ');
  };

  const exportToCSV = () => {
    const headers = ['Date', 'User', 'Action', 'Resource Type', 'Details'];
    const rows = entries.map(entry => [
      formatDate(entry.created_at),
      entry.user_email || entry.user_id,
      formatAction(entry.action),
      entry.resource_type || '',
      JSON.stringify(entry.details || {})
    ]);

    const csv = [headers, ...rows]
      .map(row => row.map(cell => `"${cell}"`).join(','))
      .join('\n');

    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `audit-log-${new Date().toISOString().split('T')[0]}.csv`;
    a.click();
  };

  const handleFilterChange = (key, value) => {
    setFilters(prev => ({ ...prev, [key]: value }));
    setPagination(prev => ({ ...prev, offset: 0 }));
  };

  const nextPage = () => {
    setPagination(prev => ({ ...prev, offset: prev.offset + prev.limit }));
  };

  const prevPage = () => {
    setPagination(prev => ({ ...prev, offset: Math.max(0, prev.offset - prev.limit) }));
  };

  if (error === 'You do not have permission to view the audit log') {
    return (
      <div className="p-6 max-w-6xl mx-auto">
        <div className="bg-[#1a1a1b] border border-[#343536] rounded-lg p-8 text-center">
          <Shield className="w-12 h-12 text-[#818384] mx-auto mb-4" />
          <h2 className="text-xl font-semibold text-white mb-2">Access Restricted</h2>
          <p className="text-[#818384]">
            Only team owners and admins can view the audit log.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="p-6 max-w-6xl mx-auto">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-white">Audit Log</h1>
          <p className="text-[#818384] mt-1">Track all team activity and changes</p>
        </div>
        <div className="flex gap-2">
          <button
            onClick={fetchAuditLog}
            className="flex items-center gap-2 px-4 py-2 bg-[#272729] text-white rounded-lg hover:bg-[#343536] transition-colors"
          >
            <RefreshCw className="w-4 h-4" />
            Refresh
          </button>
          <button
            onClick={exportToCSV}
            className="flex items-center gap-2 px-4 py-2 bg-[#ff4500] text-white rounded-lg hover:bg-[#ff5722] transition-colors"
          >
            <Download className="w-4 h-4" />
            Export CSV
          </button>
        </div>
      </div>

      {/* Filters */}
      <div className="bg-[#1a1a1b] border border-[#343536] rounded-lg p-4 mb-6">
        <div className="flex items-center gap-2 mb-4">
          <Filter className="w-4 h-4 text-[#818384]" />
          <span className="text-sm font-medium text-white">Filters</span>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-3 lg:grid-cols-5 gap-4">
          <select
            value={filters.action}
            onChange={(e) => handleFilterChange('action', e.target.value)}
            className="bg-[#272729] border border-[#343536] text-white rounded-lg px-3 py-2 text-sm"
          >
            <option value="">All Actions</option>
            <option value="member.invited">Member Invited</option>
            <option value="member.removed">Member Removed</option>
            <option value="member.role_changed">Role Changed</option>
            <option value="account.added">Account Added</option>
            <option value="account.removed">Account Removed</option>
            <option value="campaign.created">Campaign Created</option>
            <option value="campaign.deleted">Campaign Deleted</option>
            <option value="settings.updated">Settings Updated</option>
            <option value="dm.sent">DM Sent</option>
          </select>

          <select
            value={filters.resource_type}
            onChange={(e) => handleFilterChange('resource_type', e.target.value)}
            className="bg-[#272729] border border-[#343536] text-white rounded-lg px-3 py-2 text-sm"
          >
            <option value="">All Resources</option>
            <option value="member">Members</option>
            <option value="account">Accounts</option>
            <option value="campaign">Campaigns</option>
            <option value="rule">Rules</option>
            <option value="settings">Settings</option>
          </select>

          <input
            type="date"
            value={filters.start_date}
            onChange={(e) => handleFilterChange('start_date', e.target.value)}
            placeholder="Start Date"
            className="bg-[#272729] border border-[#343536] text-white rounded-lg px-3 py-2 text-sm"
          />

          <input
            type="date"
            value={filters.end_date}
            onChange={(e) => handleFilterChange('end_date', e.target.value)}
            placeholder="End Date"
            className="bg-[#272729] border border-[#343536] text-white rounded-lg px-3 py-2 text-sm"
          />

          <button
            onClick={() => {
              setFilters({
                action: '',
                user_id: '',
                resource_type: '',
                start_date: '',
                end_date: ''
              });
              setPagination(prev => ({ ...prev, offset: 0 }));
            }}
            className="px-4 py-2 text-sm text-[#818384] hover:text-white transition-colors"
          >
            Clear Filters
          </button>
        </div>
      </div>

      {/* Audit Log Table */}
      <div className="bg-[#1a1a1b] border border-[#343536] rounded-lg overflow-hidden">
        {loading ? (
          <div className="p-8 text-center">
            <div className="animate-spin h-8 w-8 border-2 border-[#ff4500] border-t-transparent rounded-full mx-auto"></div>
            <p className="mt-4 text-[#818384]">Loading audit log...</p>
          </div>
        ) : entries.length === 0 ? (
          <div className="p-8 text-center">
            <Clock className="w-12 h-12 text-[#343536] mx-auto mb-4" />
            <p className="text-[#818384]">No audit entries found</p>
          </div>
        ) : (
          <table className="w-full">
            <thead>
              <tr className="border-b border-[#343536]">
                <th className="text-left px-4 py-3 text-sm font-medium text-[#818384]">Time</th>
                <th className="text-left px-4 py-3 text-sm font-medium text-[#818384]">User</th>
                <th className="text-left px-4 py-3 text-sm font-medium text-[#818384]">Action</th>
                <th className="text-left px-4 py-3 text-sm font-medium text-[#818384]">Details</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[#343536]">
              {entries.map((entry) => (
                <tr key={entry.id} className="hover:bg-[#272729] transition-colors">
                  <td className="px-4 py-3">
                    <span className="text-sm text-[#818384]">
                      {formatDate(entry.created_at)}
                    </span>
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-2">
                      <div className="w-8 h-8 rounded-full bg-[#343536] flex items-center justify-center">
                        <User className="w-4 h-4 text-[#818384]" />
                      </div>
                      <div>
                        <p className="text-sm text-white">
                          {entry.user_name || 'Unknown'}
                        </p>
                        <p className="text-xs text-[#818384]">
                          {entry.user_email || ''}
                        </p>
                      </div>
                    </div>
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-2">
                      <span className={getActionColor(entry.action)}>
                        {getActionIcon(entry.action)}
                      </span>
                      <span className={`text-sm ${getActionColor(entry.action)}`}>
                        {formatAction(entry.action)}
                      </span>
                    </div>
                    {entry.resource_type && (
                      <p className="text-xs text-[#818384] mt-1">
                        {entry.resource_type}
                      </p>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    {entry.details && Object.keys(entry.details).length > 0 ? (
                      <div className="text-sm text-[#818384]">
                        {Object.entries(entry.details).slice(0, 2).map(([key, value]) => (
                          <p key={key} className="truncate max-w-xs">
                            <span className="text-[#d7dadc]">{key}:</span> {String(value)}
                          </p>
                        ))}
                      </div>
                    ) : (
                      <span className="text-sm text-[#818384]">-</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        {/* Pagination */}
        {entries.length > 0 && (
          <div className="flex items-center justify-between px-4 py-3 border-t border-[#343536]">
            <span className="text-sm text-[#818384]">
              Showing {pagination.offset + 1} - {pagination.offset + entries.length}
            </span>
            <div className="flex gap-2">
              <button
                onClick={prevPage}
                disabled={pagination.offset === 0}
                className="flex items-center gap-1 px-3 py-1 text-sm text-white bg-[#272729] rounded-lg hover:bg-[#343536] disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              >
                <ChevronLeft className="w-4 h-4" />
                Previous
              </button>
              <button
                onClick={nextPage}
                disabled={!pagination.hasMore}
                className="flex items-center gap-1 px-3 py-1 text-sm text-white bg-[#272729] rounded-lg hover:bg-[#343536] disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              >
                Next
                <ChevronRight className="w-4 h-4" />
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
