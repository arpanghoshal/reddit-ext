import { useState, useEffect } from 'react';
import { MessageCircle, TrendingUp, CheckCircle, Users, RefreshCw, AlertTriangle, ChevronRight, Activity } from 'lucide-react';
import * as api from '../api/client';
import { logError } from '../lib/logger';

function StatCard({ title, value, subtitle, icon: Icon, accent }) {
  return (
    <div className="group relative bg-[#141416] border border-[#23232a] rounded-2xl p-5 hover:border-[#333] transition-all duration-200">
      <div className="flex items-start justify-between">
        <div className="space-y-1">
          <p className="text-[13px] font-medium text-[#71717a] uppercase tracking-wide">{title}</p>
          <p className="text-3xl font-semibold text-white tracking-tight">{value}</p>
          {subtitle && <p className="text-[13px] text-[#52525b]">{subtitle}</p>}
        </div>
        <div className={`p-2.5 rounded-xl ${accent}`}>
          <Icon className="text-white/90" size={20} />
        </div>
      </div>
    </div>
  );
}

function QueuePill({ label, count, color }) {
  if (!count) return null;
  return (
    <div className="flex items-center gap-2.5 px-4 py-2.5 bg-[#141416] border border-[#23232a] rounded-xl">
      <span className={`w-2 h-2 rounded-full ${color}`} />
      <span className="text-sm text-[#a1a1aa]">{label}</span>
      <span className="text-sm font-semibold text-white ml-auto">{count}</span>
    </div>
  );
}

function FunnelChart({ data }) {
  const stages = [
    { name: 'Qualified', key: 'qualified', color: '#818cf8' },
    { name: 'Messaged', key: 'messaged', color: '#a78bfa' },
    { name: 'Replied', key: 'replied', color: '#c084fc' },
    { name: 'Converted', key: 'converted', color: '#e879f9' },
  ];

  const scanned = data.scanned || 0;
  const maxValue = Math.max(...stages.map(s => data[s.key] || 0)) || 1;
  const hasData = stages.some(s => data[s.key] > 0) || scanned > 0;

  if (!hasData) {
    return (
      <div className="flex items-center justify-center h-40 text-[#52525b] text-sm">
        No funnel data yet
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {stages.map((stage, index) => {
        const value = data[stage.key] || 0;
        const width = Math.max((value / maxValue) * 100, value > 0 ? 4 : 0);
        const prevValue = index > 0 ? data[stages[index - 1].key] || 0 : null;
        const rate = prevValue > 0 ? ((value / prevValue) * 100).toFixed(0) : null;

        return (
          <div key={stage.key} className="flex items-center gap-3">
            <div className="w-20 text-[13px] text-[#71717a] text-right">{stage.name}</div>
            <div className="flex-1 h-7 bg-[#1e1e24] rounded-lg overflow-hidden">
              <div
                className="h-full rounded-lg transition-all duration-700 ease-out"
                style={{
                  width: `${width}%`,
                  background: `linear-gradient(90deg, ${stage.color}, ${stage.color}dd)`,
                }}
              />
            </div>
            <div className="w-20 flex items-center gap-1.5">
              <span className="text-sm font-medium text-white">{value}</span>
              {rate && (
                <span className="text-[11px] text-[#52525b]">{rate}%</span>
              )}
            </div>
          </div>
        );
      })}
      <div className="pt-2 text-[13px] text-[#52525b]">
        Total scanned: <span className="text-[#a1a1aa] font-medium">{scanned.toLocaleString()}</span>
      </div>
    </div>
  );
}

function AccountCard({ account }) {
  const used = account.currentDailyCount || 0;
  const limit = account.effectiveDailyLimit || account.dailyLimit || 20;
  const pct = Math.min((used / limit) * 100, 100);

  const statusConfig = {
    active: { label: 'Active', dot: 'bg-emerald-400', text: 'text-emerald-400' },
    warming_up: { label: 'Warming', dot: 'bg-amber-400', text: 'text-amber-400' },
    paused: { label: 'Paused', dot: 'bg-zinc-500', text: 'text-zinc-400' },
    shadowbanned: { label: 'Banned', dot: 'bg-red-400', text: 'text-red-400' },
    suspended: { label: 'Suspended', dot: 'bg-red-500', text: 'text-red-400' },
  };

  const status = statusConfig[account.status] || statusConfig.paused;
  const barColor = pct >= 90 ? 'bg-red-500' : pct >= 60 ? 'bg-amber-500' : 'bg-emerald-500';

  return (
    <div className="bg-[#141416] border border-[#23232a] rounded-xl p-4 space-y-3">
      <div className="flex items-center justify-between">
        <span className="text-sm font-medium text-white">u/{account.username}</span>
        <div className="flex items-center gap-1.5">
          <span className={`w-1.5 h-1.5 rounded-full ${status.dot}`} />
          <span className={`text-xs ${status.text}`}>{status.label}</span>
        </div>
      </div>
      <div className="space-y-1.5">
        <div className="h-1.5 bg-[#1e1e24] rounded-full overflow-hidden">
          <div
            className={`h-full rounded-full transition-all duration-500 ${barColor}`}
            style={{ width: `${pct}%` }}
          />
        </div>
        <div className="flex justify-between text-[11px] text-[#52525b]">
          <span>{used} sent</span>
          <span>{limit} limit</span>
        </div>
      </div>
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
        api.getRotationStatus().catch(() => null),
      ]);

      setAnalytics(analyticsData);
      setQueueStats(queueData);
      setClassificationStats(classData);
      setConversationStats(convData);
      setRotationStatus(rotData);
    } catch (err) {
      setError('Failed to load dashboard data');
      logError(err.message || 'Failed to load dashboard data', { component: 'Dashboard', errorName: err?.name, errorStack: err?.stack });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadData();
    const interval = setInterval(loadData, 30000);
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
      <div className="flex items-center justify-center h-full bg-[#0a0a0b]">
        <div className="animate-spin h-8 w-8 border-2 border-[#ff4500] border-t-transparent rounded-full" />
      </div>
    );
  }

  const funnelData = {
    scanned: classificationStats?.total || 0,
    qualified: (classificationStats?.strongMatch || 0) + (classificationStats?.weakMatch || 0),
    messaged: analytics?.totalDMs || 0,
    replied: conversationStats?.withReplies || 0,
    converted: conversationStats?.converted || 0,
  };

  const accounts = rotationStatus?.accounts || [];

  return (
    <div className="p-6 lg:p-8 space-y-6 max-w-[1400px] mx-auto">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-white">Dashboard</h1>
          <p className="text-sm text-[#52525b] mt-0.5">Your outreach at a glance</p>
        </div>
        <button
          onClick={loadData}
          disabled={loading}
          className="flex items-center gap-2 px-3.5 py-2 text-sm text-[#a1a1aa] bg-[#141416] border border-[#23232a] rounded-xl hover:border-[#333] hover:text-white transition-all duration-200 disabled:opacity-50"
        >
          <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
          Refresh
        </button>
      </div>

      {error && (
        <div className="flex items-center gap-2.5 px-4 py-3 bg-red-500/10 border border-red-500/20 text-red-400 rounded-xl text-sm">
          <AlertTriangle size={16} />
          {error}
        </div>
      )}

      {/* Stats Grid */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCard
          title="DMs Today"
          value={analytics?.todayCount || 0}
          subtitle="Daily sends"
          icon={MessageCircle}
          accent="bg-blue-600/80"
        />
        <StatCard
          title="This Week"
          value={analytics?.weekCount || 0}
          subtitle={`${analytics?.totalDMs || 0} all time`}
          icon={TrendingUp}
          accent="bg-emerald-600/80"
        />
        <StatCard
          title="Success Rate"
          value={`${analytics?.successRate || 0}%`}
          subtitle="Delivered"
          icon={CheckCircle}
          accent="bg-violet-600/80"
        />
        <StatCard
          title="Reply Rate"
          value={`${conversationStats?.replyRate || 0}%`}
          subtitle={`${conversationStats?.withReplies || 0} replies`}
          icon={Users}
          accent="bg-amber-600/80"
        />
      </div>

      {/* Queue + Accounts Row */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Queue Overview */}
        {queueStats && (
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-medium text-[#71717a] uppercase tracking-wide">Queue</h2>
              <a href="/queue" className="flex items-center gap-1 text-xs text-[#52525b] hover:text-[#a1a1aa] transition-colors">
                View all <ChevronRight size={12} />
              </a>
            </div>
            <div className="grid grid-cols-2 gap-2">
              <QueuePill label="Pending" count={queueStats.pending} color="bg-amber-400" />
              <QueuePill label="Approved" count={queueStats.approved} color="bg-blue-400" />
              <QueuePill label="Sent" count={queueStats.sent} color="bg-emerald-400" />
              <QueuePill label="Failed" count={queueStats.failed} color="bg-red-400" />
            </div>
          </div>
        )}

        {/* Account Health */}
        {accounts.length > 0 && (
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-medium text-[#71717a] uppercase tracking-wide">Accounts</h2>
              <a href="/accounts" className="flex items-center gap-1 text-xs text-[#52525b] hover:text-[#a1a1aa] transition-colors">
                Manage <ChevronRight size={12} />
              </a>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              {accounts.slice(0, 4).map(account => (
                <AccountCard key={account.id} account={account} />
              ))}
            </div>
            {accounts.length > 4 && (
              <p className="text-xs text-[#52525b] text-center">+{accounts.length - 4} more accounts</p>
            )}
          </div>
        )}
      </div>

      {/* Lead Funnel */}
      <div className="bg-[#141416] border border-[#23232a] rounded-2xl p-6">
        <div className="flex items-center justify-between mb-5">
          <div className="flex items-center gap-2.5">
            <Activity size={16} className="text-violet-400" />
            <h2 className="text-sm font-medium text-[#71717a] uppercase tracking-wide">Lead Funnel</h2>
          </div>
        </div>
        <FunnelChart data={funnelData} />
      </div>
    </div>
  );
}
