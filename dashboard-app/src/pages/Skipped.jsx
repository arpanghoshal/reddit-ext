import { useState, useEffect } from 'react';
import { XCircle, RefreshCw, ExternalLink, Filter } from 'lucide-react';
import { PieChart, Pie, Cell, ResponsiveContainer, Legend, Tooltip } from 'recharts';
import * as api from '../api/client';

const REASON_COLORS = {
  'not_relevant': '#6b7280',
  'below_threshold': '#f59e0b',
  'user_not_qualified': '#ef4444',
  'already_contacted': '#8b5cf6',
  'bot_detected': '#ec4899',
  'low_karma': '#f97316',
  'account_too_new': '#14b8a6',
  'blocked_subreddit': '#64748b',
  'unknown': '#374151'
};

const REASON_LABELS = {
  'not_relevant': 'Not Relevant',
  'below_threshold': 'Below Threshold',
  'user_not_qualified': 'User Not Qualified',
  'already_contacted': 'Already Contacted',
  'bot_detected': 'Bot Detected',
  'low_karma': 'Low Karma',
  'account_too_new': 'Account Too New',
  'blocked_subreddit': 'Blocked Subreddit',
  'unknown': 'Unknown'
};

function SkippedPostCard({ post }) {
  return (
    <div className="bg-[#1a1a1b] rounded-lg p-4 border border-[#343536] hover:border-[#ff4500]/50 transition-colors">
      <div className="flex items-start justify-between gap-4">
        <div className="flex-1 min-w-0">
          <h4 className="text-white font-medium truncate">
            {post.postTitle || 'Untitled Post'}
          </h4>
          <div className="flex items-center gap-2 mt-1 text-sm text-[#818384]">
            {post.subreddit && (
              <span className="text-[#ff4500]">r/{post.subreddit}</span>
            )}
            {post.author && (
              <>
                <span>•</span>
                <span>u/{post.author}</span>
              </>
            )}
          </div>
        </div>

        <div className="flex flex-col items-end gap-2">
          <span
            className="px-2 py-1 rounded text-xs font-medium"
            style={{
              backgroundColor: `${REASON_COLORS[post.skipReason] || REASON_COLORS.unknown}20`,
              color: REASON_COLORS[post.skipReason] || REASON_COLORS.unknown
            }}
          >
            {REASON_LABELS[post.skipReason] || post.skipReason || 'Unknown'}
          </span>

          {post.postUrl && (
            <a
              href={post.postUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="text-[#818384] hover:text-[#ff4500] transition-colors"
            >
              <ExternalLink size={16} />
            </a>
          )}
        </div>
      </div>

      {/* Skip Details */}
      {post.skipDetails && Object.keys(post.skipDetails).length > 0 && (
        <div className="mt-3 pt-3 border-t border-[#343536]">
          <div className="text-xs text-[#818384] space-y-1">
            {post.skipDetails.score !== undefined && (
              <div>Score: {post.skipDetails.score}</div>
            )}
            {post.skipDetails.reason && (
              <div className="text-[#d7dadc]">{post.skipDetails.reason}</div>
            )}
          </div>
        </div>
      )}

      {/* Timestamp */}
      <div className="mt-2 text-xs text-[#818384]">
        {post.createdAt && new Date(post.createdAt).toLocaleString()}
      </div>
    </div>
  );
}

export default function Skipped() {
  const [posts, setPosts] = useState([]);
  const [stats, setStats] = useState({ total: 0, byReason: {}, bySubreddit: {} });
  const [loading, setLoading] = useState(true);
  const [reasonFilter, setReasonFilter] = useState('');
  const [subredditFilter, setSubredditFilter] = useState('');

  useEffect(() => {
    loadData();
  }, [reasonFilter, subredditFilter]);

  const loadData = async () => {
    setLoading(true);
    try {
      const filters = {};
      if (reasonFilter) filters.skipReason = reasonFilter;
      if (subredditFilter) filters.subreddit = subredditFilter;

      const [postsData, statsData] = await Promise.all([
        api.getSkippedPosts(filters),
        api.getSkipStats()
      ]);

      setPosts(postsData || []);
      setStats(statsData || { total: 0, byReason: {}, bySubreddit: {} });
    } catch (err) {
      console.error('Failed to load skipped posts:', err);
    } finally {
      setLoading(false);
    }
  };

  // Prepare chart data
  const chartData = Object.entries(stats.byReason || {}).map(([reason, count]) => ({
    name: REASON_LABELS[reason] || reason,
    value: count,
    color: REASON_COLORS[reason] || REASON_COLORS.unknown
  }));

  const subreddits = Object.keys(stats.bySubreddit || {});
  const reasons = Object.keys(stats.byReason || {});

  return (
    <div className="p-6">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-3">
          <XCircle className="text-[#ff4500]" size={28} />
          <div>
            <h1 className="text-2xl font-bold text-white">Skipped Posts</h1>
            <p className="text-[#818384] text-sm">View posts that were skipped and why</p>
          </div>
        </div>
        <button
          onClick={loadData}
          className="p-2 text-[#818384] hover:text-white hover:bg-[#272729] rounded-lg transition-colors"
        >
          <RefreshCw size={20} className={loading ? 'animate-spin' : ''} />
        </button>
      </div>

      {/* Stats Overview */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 mb-6">
        {/* Total */}
        <div className="bg-[#1a1a1b] rounded-xl p-6 border border-[#343536]">
          <div className="text-4xl font-bold text-white mb-2">{stats.total}</div>
          <div className="text-[#818384]">Total Skipped Posts</div>
        </div>

        {/* Pie Chart */}
        <div className="bg-[#1a1a1b] rounded-xl p-6 border border-[#343536] lg:col-span-2">
          <h3 className="text-lg font-semibold text-white mb-4">Skip Reasons</h3>
          {chartData.length > 0 ? (
            <div className="h-48">
              <ResponsiveContainer width="100%" height="100%">
                <PieChart>
                  <Pie
                    data={chartData}
                    cx="50%"
                    cy="50%"
                    innerRadius={40}
                    outerRadius={70}
                    paddingAngle={2}
                    dataKey="value"
                  >
                    {chartData.map((entry, index) => (
                      <Cell key={`cell-${index}`} fill={entry.color} />
                    ))}
                  </Pie>
                  <Tooltip
                    contentStyle={{
                      backgroundColor: '#1a1a1b',
                      border: '1px solid #343536',
                      borderRadius: '8px',
                      color: '#fff'
                    }}
                  />
                  <Legend
                    layout="vertical"
                    align="right"
                    verticalAlign="middle"
                    wrapperStyle={{ color: '#d7dadc', fontSize: '12px' }}
                  />
                </PieChart>
              </ResponsiveContainer>
            </div>
          ) : (
            <div className="h-48 flex items-center justify-center text-[#818384]">
              No data available
            </div>
          )}
        </div>
      </div>

      {/* Filters */}
      <div className="flex flex-wrap gap-4 mb-6">
        <div className="flex items-center gap-2">
          <Filter size={18} className="text-[#818384]" />
          <span className="text-[#818384] text-sm">Filters:</span>
        </div>

        <select
          value={reasonFilter}
          onChange={e => setReasonFilter(e.target.value)}
          className="px-3 py-2 bg-[#272729] border border-[#343536] rounded-lg text-white focus:border-[#ff4500] focus:outline-none"
        >
          <option value="">All Reasons</option>
          {reasons.map(reason => (
            <option key={reason} value={reason}>
              {REASON_LABELS[reason] || reason} ({stats.byReason[reason]})
            </option>
          ))}
        </select>

        <select
          value={subredditFilter}
          onChange={e => setSubredditFilter(e.target.value)}
          className="px-3 py-2 bg-[#272729] border border-[#343536] rounded-lg text-white focus:border-[#ff4500] focus:outline-none"
        >
          <option value="">All Subreddits</option>
          {subreddits.map(sub => (
            <option key={sub} value={sub}>
              r/{sub} ({stats.bySubreddit[sub]})
            </option>
          ))}
        </select>

        {(reasonFilter || subredditFilter) && (
          <button
            onClick={() => {
              setReasonFilter('');
              setSubredditFilter('');
            }}
            className="px-3 py-2 bg-[#343536] text-[#d7dadc] rounded-lg hover:bg-[#424244] transition-colors"
          >
            Clear Filters
          </button>
        )}
      </div>

      {/* Posts List */}
      {loading && posts.length === 0 ? (
        <div className="text-center py-12">
          <RefreshCw className="animate-spin mx-auto text-[#818384] mb-4" size={32} />
          <p className="text-[#818384]">Loading skipped posts...</p>
        </div>
      ) : posts.length === 0 ? (
        <div className="text-center py-12 bg-[#1a1a1b] rounded-xl border border-[#343536]">
          <XCircle className="mx-auto text-[#818384] mb-4" size={48} />
          <h3 className="text-lg font-semibold text-white mb-2">No skipped posts</h3>
          <p className="text-[#818384]">
            {reasonFilter || subredditFilter
              ? 'No posts match your filters'
              : 'Skipped posts will appear here during automation'}
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          <div className="text-sm text-[#818384] mb-2">
            Showing {posts.length} posts
          </div>
          {posts.map(post => (
            <SkippedPostCard key={post.id} post={post} />
          ))}
        </div>
      )}
    </div>
  );
}
