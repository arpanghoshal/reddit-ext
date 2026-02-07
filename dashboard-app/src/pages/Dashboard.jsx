import { useState, useEffect } from 'react';
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, PieChart, Pie, Cell } from 'recharts';
import { MessageCircle, Users, CheckCircle, TrendingUp, AlertTriangle, RefreshCw } from 'lucide-react';
import * as api from '../api/client';

function StatCard({ title, value, subtitle, icon: Icon, color = 'blue' }) {
  const colors = {
    blue: 'bg-blue-500',
    green: 'bg-green-500',
    orange: 'bg-orange-500',
    red: 'bg-red-500',
    purple: 'bg-purple-500'
  };

  return (
    <div className="bg-white rounded-xl shadow-sm p-6">
      <div className="flex items-start justify-between">
        <div>
          <p className="text-sm text-gray-500">{title}</p>
          <p className="text-3xl font-bold mt-1">{value}</p>
          {subtitle && <p className="text-sm text-gray-400 mt-1">{subtitle}</p>}
        </div>
        <div className={`${colors[color]} p-3 rounded-lg`}>
          <Icon className="text-white" size={24} />
        </div>
      </div>
    </div>
  );
}

function FunnelChart({ data }) {
  const stages = [
    { name: 'Scanned', key: 'scanned', color: '#6366f1' },
    { name: 'Qualified', key: 'qualified', color: '#8b5cf6' },
    { name: 'Messaged', key: 'messaged', color: '#a855f7' },
    { name: 'Replied', key: 'replied', color: '#d946ef' },
    { name: 'Converted', key: 'converted', color: '#ec4899' }
  ];

  const maxValue = Math.max(...stages.map(s => data[s.key] || 0)) || 1;

  return (
    <div className="space-y-3">
      {stages.map((stage, index) => {
        const value = data[stage.key] || 0;
        const width = (value / maxValue) * 100;
        const prevValue = index > 0 ? data[stages[index - 1].key] || 0 : null;
        const rate = prevValue ? ((value / prevValue) * 100).toFixed(1) : null;

        return (
          <div key={stage.key} className="flex items-center gap-4">
            <div className="w-24 text-sm text-gray-600">{stage.name}</div>
            <div className="flex-1 h-8 bg-gray-100 rounded-full overflow-hidden">
              <div
                className="h-full rounded-full transition-all duration-500"
                style={{ width: `${width}%`, backgroundColor: stage.color }}
              />
            </div>
            <div className="w-20 text-right">
              <span className="font-semibold">{value}</span>
              {rate && <span className="text-xs text-gray-400 ml-1">({rate}%)</span>}
            </div>
          </div>
        );
      })}
    </div>
  );
}

export default function Dashboard() {
  const [analytics, setAnalytics] = useState(null);
  const [queueStats, setQueueStats] = useState(null);
  const [classificationStats, setClassificationStats] = useState(null);
  const [conversationStats, setConversationStats] = useState(null);
  const [rotationStatus, setRotationStatus] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const loadData = async () => {
    setLoading(true);
    setError(null);
    try {
      const [analyticsData, queueData, classData, convData, rotData] = await Promise.all([
        api.getAnalytics().catch(() => null),
        api.getQueueStats().catch(() => null),
        api.getClassificationStats().catch(() => null),
        api.getConversationStats().catch(() => null),
        api.getRotationStatus().catch(() => null)
      ]);

      setAnalytics(analyticsData);
      setQueueStats(queueData);
      setClassificationStats(classData);
      setConversationStats(convData);
      setRotationStatus(rotData);
    } catch (err) {
      setError('Failed to load dashboard data');
      console.error(err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadData();
    const interval = setInterval(loadData, 15000);
    const onVisible = () => {
      if (document.visibilityState === 'visible') loadData();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      clearInterval(interval);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, []);

  if (loading && !analytics) {
    return (
      <div className="flex items-center justify-center h-full">
        <RefreshCw className="animate-spin text-gray-400" size={32} />
      </div>
    );
  }

  const funnelData = {
    scanned: classificationStats?.total || 0,
    qualified: (classificationStats?.strongMatch || 0) + (classificationStats?.weakMatch || 0),
    messaged: analytics?.totalDMs || 0,
    replied: conversationStats?.withReplies || 0,
    converted: conversationStats?.converted || 0
  };

  const classificationPieData = classificationStats ? [
    { name: 'Strong Match', value: classificationStats.strongMatch, color: '#22c55e' },
    { name: 'Weak Match', value: classificationStats.weakMatch, color: '#eab308' },
    { name: 'Not Relevant', value: classificationStats.notRelevant, color: '#ef4444' }
  ] : [];

  return (
    <div className="p-6 space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Dashboard</h1>
          <p className="text-gray-500">Overview of your Reddit automation</p>
        </div>
        <button
          onClick={loadData}
          className="flex items-center gap-2 px-4 py-2 bg-white rounded-lg shadow-sm hover:bg-gray-50"
        >
          <RefreshCw size={16} className={loading ? 'animate-spin' : ''} />
          Refresh
        </button>
      </div>

      {error && (
        <div className="bg-red-50 text-red-700 px-4 py-3 rounded-lg flex items-center gap-2">
          <AlertTriangle size={20} />
          {error}
        </div>
      )}

      {/* Stats Grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCard
          title="DMs Today"
          value={analytics?.todayCount || 0}
          subtitle="Daily quota"
          icon={MessageCircle}
          color="blue"
        />
        <StatCard
          title="This Week"
          value={analytics?.weekCount || 0}
          subtitle={`${analytics?.totalDMs || 0} total`}
          icon={TrendingUp}
          color="green"
        />
        <StatCard
          title="Success Rate"
          value={`${analytics?.successRate || 0}%`}
          subtitle="Sent successfully"
          icon={CheckCircle}
          color="purple"
        />
        <StatCard
          title="Reply Rate"
          value={`${conversationStats?.replyRate || 0}%`}
          subtitle={`${conversationStats?.withReplies || 0} replies`}
          icon={Users}
          color="orange"
        />
      </div>

      {/* Queue Stats */}
      {queueStats && (
        <div className="bg-white rounded-xl shadow-sm p-6">
          <h2 className="text-lg font-semibold mb-4">Queue Status</h2>
          <div className="grid grid-cols-5 gap-4 text-center">
            <div>
              <p className="text-2xl font-bold text-yellow-500">{queueStats.pending}</p>
              <p className="text-sm text-gray-500">Pending</p>
            </div>
            <div>
              <p className="text-2xl font-bold text-blue-500">{queueStats.approved}</p>
              <p className="text-sm text-gray-500">Approved</p>
            </div>
            <div>
              <p className="text-2xl font-bold text-green-500">{queueStats.sent}</p>
              <p className="text-sm text-gray-500">Sent</p>
            </div>
            <div>
              <p className="text-2xl font-bold text-red-500">{queueStats.failed}</p>
              <p className="text-sm text-gray-500">Failed</p>
            </div>
            <div>
              <p className="text-2xl font-bold text-gray-500">{queueStats.rejected}</p>
              <p className="text-sm text-gray-500">Rejected</p>
            </div>
          </div>
        </div>
      )}

      {/* Charts Row */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Lead Funnel */}
        <div className="bg-white rounded-xl shadow-sm p-6">
          <h2 className="text-lg font-semibold mb-4">Lead Funnel</h2>
          <FunnelChart data={funnelData} />
        </div>

        {/* Classification Breakdown */}
        <div className="bg-white rounded-xl shadow-sm p-6">
          <h2 className="text-lg font-semibold mb-4">Classification Breakdown</h2>
          {classificationPieData.length > 0 ? (
            <div className="flex items-center gap-8">
              <ResponsiveContainer width={200} height={200}>
                <PieChart>
                  <Pie
                    data={classificationPieData}
                    dataKey="value"
                    nameKey="name"
                    cx="50%"
                    cy="50%"
                    innerRadius={40}
                    outerRadius={80}
                  >
                    {classificationPieData.map((entry, index) => (
                      <Cell key={index} fill={entry.color} />
                    ))}
                  </Pie>
                  <Tooltip />
                </PieChart>
              </ResponsiveContainer>
              <div className="space-y-2">
                {classificationPieData.map((item) => (
                  <div key={item.name} className="flex items-center gap-2">
                    <div
                      className="w-3 h-3 rounded-full"
                      style={{ backgroundColor: item.color }}
                    />
                    <span className="text-sm text-gray-600">{item.name}</span>
                    <span className="font-semibold">{item.value}</span>
                  </div>
                ))}
              </div>
            </div>
          ) : (
            <p className="text-gray-400 text-center py-8">No classification data yet</p>
          )}
        </div>
      </div>

      {/* Conversation Status */}
      {conversationStats && (
        <div className="bg-white rounded-xl shadow-sm p-6">
          <h2 className="text-lg font-semibold mb-4">Conversation Status</h2>
          <div className="grid grid-cols-5 gap-4 text-center">
            <div>
              <p className="text-2xl font-bold text-blue-500">{conversationStats.active}</p>
              <p className="text-sm text-gray-500">Active</p>
            </div>
            <div>
              <p className="text-2xl font-bold text-green-500">{conversationStats.interested}</p>
              <p className="text-sm text-gray-500">Interested</p>
            </div>
            <div>
              <p className="text-2xl font-bold text-gray-500">{conversationStats.cold}</p>
              <p className="text-sm text-gray-500">Cold</p>
            </div>
            <div>
              <p className="text-2xl font-bold text-gray-400">{conversationStats.closed}</p>
              <p className="text-sm text-gray-500">Closed</p>
            </div>
            <div>
              <p className="text-2xl font-bold text-purple-500">{conversationStats.converted}</p>
              <p className="text-sm text-gray-500">Converted</p>
            </div>
          </div>
        </div>
      )}

      {/* Account Health */}
      {rotationStatus?.accounts && rotationStatus.accounts.length > 0 && (
        <div className="bg-white rounded-xl shadow-sm p-6">
          <h2 className="text-lg font-semibold mb-4">Account Health</h2>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {rotationStatus.accounts.map(account => {
              const used = account.currentDailyCount || 0;
              const limit = account.effectiveDailyLimit || account.dailyLimit || 20;
              const pct = Math.min((used / limit) * 100, 100);
              const barColor = account.status === 'shadowbanned' || account.status === 'suspended'
                ? 'bg-red-500'
                : pct >= 90 ? 'bg-orange-500'
                : pct >= 60 ? 'bg-yellow-500'
                : 'bg-green-500';

              const statusBadge = {
                active: 'bg-green-100 text-green-700',
                warming_up: 'bg-yellow-100 text-yellow-700',
                paused: 'bg-gray-100 text-gray-600',
                shadowbanned: 'bg-red-100 text-red-700',
                suspended: 'bg-red-200 text-red-800'
              }[account.status] || 'bg-gray-100 text-gray-600';

              return (
                <div key={account.id} className="border border-gray-100 rounded-lg p-3">
                  <div className="flex items-center justify-between mb-2">
                    <span className="font-medium text-sm text-gray-900">u/{account.username}</span>
                    <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${statusBadge}`}>
                      {account.status}
                    </span>
                  </div>
                  <div className="flex items-center gap-2">
                    <div className="flex-1 h-2 bg-gray-100 rounded-full overflow-hidden">
                      <div className={`h-full rounded-full ${barColor}`} style={{ width: `${pct}%` }} />
                    </div>
                    <span className="text-xs text-gray-500 whitespace-nowrap">{used}/{limit}</span>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
