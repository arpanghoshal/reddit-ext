import { useState, useEffect } from 'react';
import {
  BarChart2, TrendingUp, MessageSquare, Users, Clock, Calendar,
  ArrowUp, ArrowDown, RefreshCw, Download
} from 'lucide-react';
import { supabase } from '../lib/supabase';

/**
 * TeamAnalytics Page
 * Comprehensive team analytics dashboard
 */
export default function TeamAnalytics() {
  const [analytics, setAnalytics] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [period, setPeriod] = useState('30d');

  useEffect(() => {
    fetchAnalytics();
  }, [period]);

  const fetchAnalytics = async () => {
    setLoading(true);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      const accessToken = session?.access_token;

      const response = await fetch(`/api/team-analytics?period=${period}`, {
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'X-Team-ID': localStorage.getItem('currentTeamId') || ''
        }
      });

      if (!response.ok) {
        throw new Error('Failed to fetch analytics');
      }

      const data = await response.json();
      setAnalytics(data.data);
    } catch (err) {
      console.error('Error fetching analytics:', err);
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  if (loading) {
    return (
      <div className="p-6 max-w-7xl mx-auto">
        <div className="animate-pulse space-y-6">
          <div className="h-8 bg-[#343536] rounded w-1/4"></div>
          <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
            {[...Array(4)].map((_, i) => (
              <div key={i} className="h-32 bg-[#1a1a1b] rounded-lg"></div>
            ))}
          </div>
          <div className="h-64 bg-[#1a1a1b] rounded-lg"></div>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="p-6 max-w-7xl mx-auto">
        <div className="bg-red-900/20 border border-red-500 rounded-lg p-4 text-red-400">
          {error}
        </div>
      </div>
    );
  }

  const summary = analytics?.summary || {};
  const dailyData = analytics?.daily_breakdown || [];
  const heatmap = analytics?.hourly_heatmap || {};
  const leaderboard = analytics?.member_breakdown || [];

  return (
    <div className="p-6 max-w-7xl mx-auto">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-white">Team Analytics</h1>
          <p className="text-[#818384] mt-1">
            {analytics?.period?.start_date} to {analytics?.period?.end_date}
          </p>
        </div>
        <div className="flex items-center gap-4">
          <select
            value={period}
            onChange={(e) => setPeriod(e.target.value)}
            className="bg-[#272729] border border-[#343536] text-white rounded-lg px-4 py-2"
          >
            <option value="7d">Last 7 days</option>
            <option value="30d">Last 30 days</option>
            <option value="90d">Last 90 days</option>
          </select>
          <button
            onClick={fetchAnalytics}
            className="flex items-center gap-2 px-4 py-2 bg-[#272729] text-white rounded-lg hover:bg-[#343536] transition-colors"
          >
            <RefreshCw className="w-4 h-4" />
            Refresh
          </button>
        </div>
      </div>

      {/* Summary Cards */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
        <SummaryCard
          icon={<MessageSquare className="w-5 h-5" />}
          label="DMs Sent"
          value={summary.total_dms_sent || 0}
          subtext={`${summary.avg_dms_per_day || 0} avg/day`}
        />
        <SummaryCard
          icon={<TrendingUp className="w-5 h-5" />}
          label="Response Rate"
          value={`${summary.response_rate || 0}%`}
          subtext={`${summary.total_responses || 0} responses`}
          isPositive={summary.response_rate > 10}
        />
        <SummaryCard
          icon={<Users className="w-5 h-5" />}
          label="Positive Rate"
          value={`${summary.positive_rate || 0}%`}
          subtext={`${summary.positive_responses || 0} positive`}
          isPositive={summary.positive_rate > 50}
        />
        <SummaryCard
          icon={<Clock className="w-5 h-5" />}
          label="Avg Response Time"
          value={summary.avg_response_time_mins ? `${summary.avg_response_time_mins}m` : 'N/A'}
          subtext="from initial DM"
        />
      </div>

      {/* Charts Row */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 mb-6">
        {/* Daily Activity Chart */}
        <div className="bg-[#1a1a1b] border border-[#343536] rounded-lg p-6">
          <h3 className="text-lg font-semibold text-white mb-4">Daily Activity</h3>
          <div className="h-64">
            {dailyData.length > 0 ? (
              <SimpleBarChart data={dailyData} />
            ) : (
              <div className="h-full flex items-center justify-center text-[#818384]">
                No data available
              </div>
            )}
          </div>
        </div>

        {/* Activity Heatmap */}
        <div className="bg-[#1a1a1b] border border-[#343536] rounded-lg p-6">
          <h3 className="text-lg font-semibold text-white mb-4">Best Times to Send</h3>
          {heatmap.recommendation ? (
            <div className="space-y-4">
              <div className="bg-[#272729] rounded-lg p-4">
                <p className="text-[#ff4500] font-medium">
                  {heatmap.recommendation}
                </p>
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <p className="text-sm text-[#818384] mb-2">By Day of Week</p>
                  {heatmap.by_day_of_week && Object.entries(heatmap.by_day_of_week).map(([day, data]) => (
                    <div key={day} className="flex items-center justify-between py-1">
                      <span className="text-sm text-[#d7dadc]">{day}</span>
                      <span className="text-sm text-[#818384]">{data.responses} responses</span>
                    </div>
                  ))}
                </div>
                <div>
                  <p className="text-sm text-[#818384] mb-2">Peak Hours</p>
                  <div className="text-sm text-[#d7dadc]">
                    Best hour: {heatmap.best_hour}:00
                  </div>
                </div>
              </div>
            </div>
          ) : (
            <div className="h-48 flex items-center justify-center text-[#818384]">
              Not enough data for analysis
            </div>
          )}
        </div>
      </div>

      {/* Member Leaderboard */}
      <div className="bg-[#1a1a1b] border border-[#343536] rounded-lg p-6">
        <h3 className="text-lg font-semibold text-white mb-4">Team Leaderboard</h3>
        {leaderboard.length > 0 ? (
          <table className="w-full">
            <thead>
              <tr className="border-b border-[#343536]">
                <th className="text-left px-4 py-3 text-sm font-medium text-[#818384]">Rank</th>
                <th className="text-left px-4 py-3 text-sm font-medium text-[#818384]">Member</th>
                <th className="text-right px-4 py-3 text-sm font-medium text-[#818384]">DMs Sent</th>
                <th className="text-right px-4 py-3 text-sm font-medium text-[#818384]">DMs Approved</th>
                <th className="text-right px-4 py-3 text-sm font-medium text-[#818384]">Responses</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[#343536]">
              {leaderboard.map((member, index) => (
                <tr key={member.user_id} className="hover:bg-[#272729] transition-colors">
                  <td className="px-4 py-3">
                    <span className={`w-6 h-6 rounded-full flex items-center justify-center text-sm font-bold ${
                      index === 0 ? 'bg-yellow-500 text-black' :
                      index === 1 ? 'bg-gray-400 text-black' :
                      index === 2 ? 'bg-amber-700 text-white' :
                      'bg-[#343536] text-white'
                    }`}>
                      {index + 1}
                    </span>
                  </td>
                  <td className="px-4 py-3">
                    <div>
                      <p className="text-sm text-white">{member.name || 'Unknown'}</p>
                      <p className="text-xs text-[#818384]">{member.email}</p>
                    </div>
                  </td>
                  <td className="px-4 py-3 text-right text-sm text-[#d7dadc]">
                    {member.dms_sent}
                  </td>
                  <td className="px-4 py-3 text-right text-sm text-[#d7dadc]">
                    {member.dms_approved}
                  </td>
                  <td className="px-4 py-3 text-right text-sm text-[#d7dadc]">
                    {member.responses}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <div className="py-8 text-center text-[#818384]">
            No member activity data yet
          </div>
        )}
      </div>
    </div>
  );
}

function SummaryCard({ icon, label, value, subtext, isPositive }) {
  return (
    <div className="bg-[#1a1a1b] border border-[#343536] rounded-lg p-4">
      <div className="flex items-center gap-2 text-[#818384] mb-2">
        {icon}
        <span className="text-sm">{label}</span>
      </div>
      <div className="flex items-baseline gap-2">
        <span className="text-2xl font-bold text-white">{value}</span>
        {isPositive !== undefined && (
          isPositive ? (
            <ArrowUp className="w-4 h-4 text-green-500" />
          ) : (
            <ArrowDown className="w-4 h-4 text-red-500" />
          )
        )}
      </div>
      <p className="text-xs text-[#818384] mt-1">{subtext}</p>
    </div>
  );
}

function SimpleBarChart({ data }) {
  const maxValue = Math.max(...data.map(d => d.dms_sent || 0), 1);

  return (
    <div className="flex items-end justify-between h-full gap-1">
      {data.slice(-14).map((day, index) => {
        const height = ((day.dms_sent || 0) / maxValue) * 100;
        const date = new Date(day.date);
        const dayLabel = date.getDate();

        return (
          <div key={day.date} className="flex flex-col items-center flex-1">
            <div className="w-full bg-[#343536] rounded-t relative" style={{ height: '180px' }}>
              <div
                className="absolute bottom-0 w-full bg-[#ff4500] rounded-t transition-all"
                style={{ height: `${height}%` }}
              />
            </div>
            <span className="text-xs text-[#818384] mt-2">{dayLabel}</span>
          </div>
        );
      })}
    </div>
  );
}
