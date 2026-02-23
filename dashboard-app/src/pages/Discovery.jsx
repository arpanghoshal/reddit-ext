import { useState, useEffect, useCallback, useRef } from 'react';
import { Search, RefreshCw, X, ChevronDown, ChevronUp, MessageSquare, Send, ExternalLink, Clock, Users, TrendingUp, AlertTriangle, Flame, Thermometer, Snowflake, History, Play, Square, Zap, Wifi, WifiOff, ListChecks, Ban, Eye, EyeOff, Radar, Plus, Pause, Trash2, ArrowLeft, Calendar, BarChart3 } from 'lucide-react';
import * as api from '../api/client';
import { logError } from '../lib/logger';

// ============================================================================
// Tier badge component
// ============================================================================
function TierBadge({ tier }) {
  const config = {
    hot: { bg: 'bg-red-500/15 text-red-400', icon: Flame, label: 'HOT' },
    warm: { bg: 'bg-orange-500/15 text-orange-400', icon: Thermometer, label: 'WARM' },
    cold: { bg: 'bg-blue-500/15 text-blue-400', icon: Snowflake, label: 'COLD' },
    irrelevant: { bg: 'bg-gray-500/15 text-gray-500', icon: Ban, label: 'IRRELEVANT' },
  };
  const c = config[tier] || config.cold;
  const Icon = c.icon;
  return (
    <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-bold ${c.bg}`}>
      <Icon className="w-3 h-3" />
      {c.label}
    </span>
  );
}

// ============================================================================
// Lead Card component
// ============================================================================
function LeadCard({ lead, onQueue, onDismiss, onGenerateMessage, accounts, sessionId, generateMessageFn, queueLeadFn }) {
  const [expanded, setExpanded] = useState(false);
  const [message, setMessage] = useState(lead.generated_message || '');
  const [reasoning, setReasoning] = useState(lead.message_reasoning || '');
  const [showReasoning, setShowReasoning] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [queueing, setQueueing] = useState(false);
  const [selectedAccount, setSelectedAccount] = useState(accounts[0]?.id || '');

  const scoreColor = lead.lead_score >= 70
    ? 'text-green-400'
    : lead.lead_score >= 45
    ? 'text-yellow-400'
    : 'text-red-400';

  const timeAgo = lead.post_created_utc
    ? formatTimeAgo(lead.post_created_utc)
    : '';

  const handleGenerate = async () => {
    setGenerating(true);
    try {
      const fn = generateMessageFn || ((sid, lid) => api.generateLeadMessage(sid, lid));
      const result = await fn(sessionId, lead.id);
      if (result?.message) {
        setMessage(result.message);
        if (result.reasoning) {
          setReasoning(result.reasoning);
          setShowReasoning(true);
        }
      }
    } catch (err) {
      logError('Failed to generate message', { component: 'LeadCard', errorName: err?.name, errorStack: err?.stack });
    }
    setGenerating(false);
  };

  const handleQueue = async () => {
    if (!selectedAccount) return;
    setQueueing(true);
    try {
      const fn = queueLeadFn || ((sid, lid, data) => api.queueLead(sid, lid, data));
      await fn(sessionId, lead.id, {
        accountId: selectedAccount,
        editedMessage: message || undefined,
      });
      onQueue(lead.id);
    } catch (err) {
      logError('Failed to queue lead', { component: 'LeadCard', errorName: err?.name, errorStack: err?.stack });
    }
    setQueueing(false);
  };

  return (
    <div className={`bg-[#141416] rounded-lg border overflow-hidden ${
      lead.status === 'queued' ? 'border-green-500/30 opacity-60' :
      lead.status === 'dismissed' ? 'border-[#23232a] opacity-40' :
      lead.status === 'already_contacted' ? 'border-yellow-500/30 opacity-60' :
      'border-[#23232a]'
    }`}>
      <div className="p-4">
        <div className="flex items-start gap-3">
          {/* Score */}
          <div className="text-center min-w-[50px]">
            <div className={`text-lg font-bold ${scoreColor}`}>
              {lead.lead_score ? Number(lead.lead_score).toFixed(1) : '—'}
            </div>
            <TierBadge tier={lead.lead_tier} />
          </div>

          {/* Content */}
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <a
                href={`https://reddit.com/user/${lead.author_username}`}
                target="_blank"
                rel="noopener noreferrer"
                className="font-semibold text-[#4d9fff] hover:underline"
              >
                u/{lead.author_username}
              </a>
              <span className="text-[#52525b]">in</span>
              <span className="text-[#a1a1aa] text-sm">r/{lead.subreddit}</span>
              {timeAgo && <span className="text-[#52525b] text-xs">{timeAgo}</span>}
              {lead.source_type === 'comment' && (
                <span className="px-2 py-0.5 rounded-full text-xs font-medium bg-purple-500/15 text-purple-400">
                  Comment
                </span>
              )}
              {lead.source_type === 'subreddit_expansion' && (
                <span className="px-2 py-0.5 rounded-full text-xs font-medium bg-teal-500/15 text-teal-400">
                  Subreddit
                </span>
              )}
              {lead.status === 'queued' && (
                <span className="px-2 py-0.5 rounded-full text-xs font-medium bg-green-500/15 text-green-400">Queued</span>
              )}
              {lead.status === 'already_contacted' && (
                <span className="px-2 py-0.5 rounded-full text-xs font-medium bg-yellow-500/15 text-yellow-400">Already Contacted</span>
              )}
              {lead.status === 'dismissed' && (
                <span className="px-2 py-0.5 rounded-full text-xs font-medium bg-gray-500/15 text-gray-400">Dismissed</span>
              )}
            </div>

            <p className="text-sm text-[#d7dadc] mt-1 line-clamp-2">
              {lead.post_title}
            </p>

            {lead.source_type === 'comment' && lead.source_comment_body && (
              <p className="text-xs text-[#71717a] mt-1 italic line-clamp-2">
                "{lead.source_comment_body}"
              </p>
            )}

            {/* Score breakdown chips */}
            <div className="flex gap-2 mt-2 flex-wrap">
              {lead.relevance_score != null && (
                <span className="text-xs px-1.5 py-0.5 rounded bg-[#1e1e24] text-[#a1a1aa]">
                  Relevance: {lead.relevance_score}
                </span>
              )}
              {lead.buyer_intent != null && (
                <span className="text-xs px-1.5 py-0.5 rounded bg-[#1e1e24] text-[#a1a1aa]">
                  Intent: {lead.buyer_intent}
                </span>
              )}
              {lead.is_qualified && (
                <span className="text-xs px-1.5 py-0.5 rounded bg-green-500/15 text-green-400">
                  Qualified
                </span>
              )}
            </div>
          </div>

          {/* Actions */}
          <div className="flex items-center gap-2">
            {lead.post_url && (
              <a
                href={lead.post_url}
                target="_blank"
                rel="noopener noreferrer"
                className="p-1.5 rounded hover:bg-[#1e1e24] text-[#52525b] hover:text-[#a1a1aa]"
                title="View post"
              >
                <ExternalLink className="w-4 h-4" />
              </a>
            )}
            <button
              onClick={() => setExpanded(!expanded)}
              className="p-1.5 rounded hover:bg-[#1e1e24] text-[#52525b]"
            >
              {expanded ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
            </button>
          </div>
        </div>
      </div>

      {/* Expanded detail */}
      {expanded && (
        <div className="border-t border-[#23232a] bg-[#0a0a0b] p-4 space-y-4">
          {/* Post body */}
          {lead.post_body && (
            <div>
              <h4 className="text-xs font-semibold text-[#71717a] uppercase mb-1">Post Content</h4>
              <p className="text-sm text-[#d7dadc] whitespace-pre-wrap max-h-40 overflow-y-auto">
                {lead.post_body.slice(0, 1000)}
                {lead.post_body.length > 1000 && '...'}
              </p>
            </div>
          )}

          {/* Insights */}
          {lead.lead_insights && lead.lead_insights.length > 0 && (
            <div>
              <h4 className="text-xs font-semibold text-[#71717a] uppercase mb-1">Insights</h4>
              <div className="space-y-1">
                {lead.lead_insights.map((insight, i) => (
                  <div key={i} className={`text-xs px-2 py-1 rounded ${
                    insight.type === 'strength' ? 'bg-green-500/15 text-green-400' :
                    insight.type === 'concern' ? 'bg-red-500/10 text-red-400' :
                    'bg-blue-500/10 text-blue-400'
                  }`}>
                    {insight.message}
                  </div>
                ))}
              </div>
            </div>
          )}

          {lead.classification_reasoning && (
            <p className="text-xs text-[#71717a] italic">
              {lead.classification_reasoning}
            </p>
          )}

          {/* Irrelevant notice */}
          {lead.lead_tier === 'irrelevant' && (
            <div className="pt-2 border-t border-[#23232a] text-xs text-[#52525b] italic">
              This post was classified as not relevant to your business context.
            </div>
          )}

          {/* Message generation & queue */}
          {lead.status === 'scored' && lead.lead_tier !== 'irrelevant' && (
            <div className="space-y-3 pt-2 border-t border-[#23232a]">
              <div>
                <div className="flex items-center justify-between mb-1">
                  <h4 className="text-xs font-semibold text-[#71717a] uppercase">Outreach Message</h4>
                  <button
                    onClick={handleGenerate}
                    disabled={generating}
                    className="text-xs text-blue-400 hover:text-blue-300 disabled:opacity-50"
                  >
                    {generating ? 'Generating...' : message ? 'Regenerate' : 'Generate'}
                  </button>
                </div>
                {message ? (
                  <>
                    <textarea
                      value={message}
                      onChange={(e) => setMessage(e.target.value)}
                      rows={3}
                      className="w-full text-sm bg-[#1e1e24] border border-[#23232a] rounded-lg p-2 text-white placeholder-[#52525b] focus:ring-2 focus:ring-[#ff4500]/50 focus:border-[#ff4500]"
                    />
                    {reasoning && (
                      <div className="mt-1">
                        <button
                          onClick={() => setShowReasoning(!showReasoning)}
                          className="text-xs text-[#52525b] hover:text-[#a1a1aa] flex items-center gap-1"
                        >
                          {showReasoning ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
                          {showReasoning ? 'Hide reasoning' : 'Show reasoning'}
                        </button>
                        {showReasoning && (
                          <p className="mt-1 text-xs text-[#71717a] bg-[#1e1e24] rounded p-2 italic">
                            {reasoning}
                          </p>
                        )}
                      </div>
                    )}
                  </>
                ) : (
                  <p className="text-xs text-[#52525b]">Click "Generate" to create an outreach message</p>
                )}
              </div>

              <div className="flex items-center gap-3">
                {accounts.length > 0 && (
                  <select
                    value={selectedAccount}
                    onChange={(e) => setSelectedAccount(e.target.value)}
                    className="text-sm bg-[#1e1e24] border border-[#23232a] rounded-lg px-2 py-1.5 text-white"
                  >
                    {accounts.map(acc => (
                      <option key={acc.id} value={acc.id}>{acc.username}</option>
                    ))}
                  </select>
                )}
                <button
                  onClick={handleQueue}
                  disabled={queueing || !selectedAccount}
                  className="flex items-center gap-1.5 px-3 py-1.5 bg-[#ff4500] text-white text-sm font-medium rounded-lg hover:bg-[#e63e00] disabled:opacity-50"
                >
                  <Send className="w-3.5 h-3.5" />
                  {queueing ? 'Queueing...' : 'Add to Queue'}
                </button>
                <button
                  onClick={() => onDismiss(lead.id)}
                  className="px-3 py-1.5 text-sm text-[#71717a] hover:text-red-400 hover:bg-red-500/10 rounded-lg"
                >
                  Dismiss
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ============================================================================
// Discovery Input Form
// ============================================================================
const TIMEFRAME_OPTIONS = [
  { value: 'h', label: 'Past Hour' },
  { value: 'd', label: 'Past Day' },
  { value: 'w', label: 'Past Week' },
  { value: 'm', label: 'Past Month' },
  { value: 'y', label: 'Past Year' },
  { value: 'custom', label: 'Custom Range' },
];

function DiscoveryInput({ onStart, loading }) {
  const [businessDesc, setBusinessDesc] = useState('');
  const [persona, setPersona] = useState('');
  const [timeframe, setTimeframe] = useState('w');
  const [timeframeStart, setTimeframeStart] = useState('');
  const [timeframeEnd, setTimeframeEnd] = useState('');
  const [prefilling, setPrefilling] = useState(false);

  const prefillFromSettings = async () => {
    setPrefilling(true);
    try {
      const settings = await api.getUserSettings();
      if (settings) {
        setBusinessDesc(settings.business_desc || settings.businessDesc || '');
        setPersona(settings.persona || '');
      }
    } catch (err) {
      logError('Failed to load settings', { component: 'DiscoveryInput', errorName: err?.name, errorStack: err?.stack });
    }
    setPrefilling(false);
  };

  // Auto-prefill on mount
  useEffect(() => {
    prefillFromSettings();
  }, []);

  const handleSubmit = (e) => {
    e.preventDefault();
    if (!businessDesc.trim()) return;
    const data = { businessDesc, persona, timeframe };
    if (timeframe === 'custom' && timeframeStart && timeframeEnd) {
      data.timeframeStart = timeframeStart;
      data.timeframeEnd = timeframeEnd;
      data.timeframe = 'w'; // fallback preset (custom range takes priority on backend)
    }
    onStart(data);
  };

  return (
    <form onSubmit={handleSubmit} className="bg-[#141416] rounded-lg border border-[#23232a] p-6 max-w-2xl mx-auto">
      <div className="space-y-5">
        <div>
          <div className="flex items-center justify-between mb-1">
            <label className="block text-sm font-medium text-[#d7dadc]">
              Business Context
            </label>
            <button
              type="button"
              onClick={prefillFromSettings}
              disabled={prefilling}
              className="text-xs text-blue-400 hover:text-blue-300"
            >
              {prefilling ? 'Loading...' : 'Load from Settings'}
            </button>
          </div>
          <textarea
            value={businessDesc}
            onChange={(e) => setBusinessDesc(e.target.value)}
            placeholder="Describe your business and the problem you solve. Be specific about your product, target market, and unique value..."
            rows={4}
            className="w-full bg-[#1e1e24] border border-[#23232a] rounded-lg p-3 text-sm text-white placeholder-[#52525b] focus:ring-2 focus:ring-[#ff4500]/50 focus:border-[#ff4500]"
            required
          />
        </div>

        <div>
          <label className="block text-sm font-medium text-[#d7dadc] mb-1">
            Target Persona
          </label>
          <textarea
            value={persona}
            onChange={(e) => setPersona(e.target.value)}
            placeholder="Who are your ideal customers? What roles, industries, company sizes?"
            rows={2}
            className="w-full bg-[#1e1e24] border border-[#23232a] rounded-lg p-3 text-sm text-white placeholder-[#52525b] focus:ring-2 focus:ring-[#ff4500]/50 focus:border-[#ff4500]"
          />
        </div>

        <div>
          <label className="block text-sm font-medium text-[#d7dadc] mb-1">
            <Calendar className="w-3.5 h-3.5 inline mr-1.5" />
            Post Timeframe
          </label>
          <select
            value={timeframe}
            onChange={(e) => setTimeframe(e.target.value)}
            className="w-full bg-[#1e1e24] border border-[#23232a] rounded-lg p-3 text-sm text-white focus:ring-2 focus:ring-[#ff4500]/50 focus:border-[#ff4500]"
          >
            {TIMEFRAME_OPTIONS.map(opt => (
              <option key={opt.value} value={opt.value}>{opt.label}</option>
            ))}
          </select>
          {timeframe === 'custom' && (
            <div className="flex gap-3 mt-2">
              <input
                type="date"
                value={timeframeStart}
                onChange={(e) => setTimeframeStart(e.target.value)}
                className="flex-1 bg-[#1e1e24] border border-[#23232a] rounded-lg p-2.5 text-sm text-white focus:ring-2 focus:ring-[#ff4500]/50 focus:border-[#ff4500]"
                required
              />
              <span className="text-[#71717a] self-center text-sm">to</span>
              <input
                type="date"
                value={timeframeEnd}
                onChange={(e) => setTimeframeEnd(e.target.value)}
                className="flex-1 bg-[#1e1e24] border border-[#23232a] rounded-lg p-2.5 text-sm text-white focus:ring-2 focus:ring-[#ff4500]/50 focus:border-[#ff4500]"
                required
              />
            </div>
          )}
        </div>

        <button
          type="submit"
          disabled={loading || !businessDesc.trim()}
          className="w-full flex items-center justify-center gap-2 px-6 py-3 bg-[#ff4500] text-white font-semibold rounded-lg hover:bg-[#e63e00] disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
        >
          <Search className="w-5 h-5" />
          {loading ? 'Starting...' : 'Start Smart Search'}
        </button>
      </div>
    </form>
  );
}

// ============================================================================
// Automation Input Form
// ============================================================================
function AutomationInput({ onStart, loading }) {
  const [subreddits, setSubreddits] = useState('');
  const [accounts, setAccounts] = useState([]);
  const [selectedAccount, setSelectedAccount] = useState('');
  const [autoApprove, setAutoApprove] = useState(false);
  const [minScore, setMinScore] = useState(50);
  const [timeframe, setTimeframe] = useState('w');
  const [timeframeStart, setTimeframeStart] = useState('');
  const [timeframeEnd, setTimeframeEnd] = useState('');
  const [loadingAccounts, setLoadingAccounts] = useState(true);

  useEffect(() => {
    api.getAccountsSummary()
      .then(data => {
        const active = (data || []).filter(a => a.status === 'active');
        setAccounts(active);
        if (active.length > 0) setSelectedAccount(active[0].id);
      })
      .catch(() => {})
      .finally(() => setLoadingAccounts(false));
  }, []);

  const handleSubmit = (e) => {
    e.preventDefault();
    const list = subreddits
      .split(',')
      .map(s => s.trim().replace(/^r\//, ''))
      .filter(Boolean);
    if (!list.length || !selectedAccount) return;
    const data = {
      mode: 'automation',
      targetSubreddits: list,
      accountId: selectedAccount,
      autoQueue: true,
      autoApprove,
      minLeadScore: minScore,
      timeframe,
    };
    if (timeframe === 'custom' && timeframeStart && timeframeEnd) {
      data.timeframeStart = timeframeStart;
      data.timeframeEnd = timeframeEnd;
      data.timeframe = 'w';
    }
    onStart(data);
  };

  return (
    <form onSubmit={handleSubmit} className="bg-[#141416] rounded-lg border border-[#23232a] p-6 max-w-2xl mx-auto">
      <div className="space-y-5">
        <div>
          <label className="block text-sm font-medium text-[#d7dadc] mb-1">
            Target Subreddits
          </label>
          <input
            type="text"
            value={subreddits}
            onChange={(e) => setSubreddits(e.target.value)}
            placeholder="saas, startups, smallbusiness (comma-separated)"
            className="w-full bg-[#1e1e24] border border-[#23232a] rounded-lg p-3 text-sm text-white placeholder-[#52525b] focus:ring-2 focus:ring-[#ff4500]/50 focus:border-[#ff4500]"
            required
          />
          <p className="text-xs text-[#52525b] mt-1">Enter subreddit names without r/ prefix, separated by commas</p>
        </div>

        <div>
          <label className="block text-sm font-medium text-[#d7dadc] mb-1">
            Send From Account
          </label>
          {loadingAccounts ? (
            <div className="text-sm text-[#52525b]">Loading accounts...</div>
          ) : accounts.length === 0 ? (
            <div className="text-sm text-red-400">No active accounts. Add one in the Accounts page first.</div>
          ) : (
            <select
              value={selectedAccount}
              onChange={(e) => setSelectedAccount(e.target.value)}
              className="w-full bg-[#1e1e24] border border-[#23232a] rounded-lg p-3 text-sm text-white focus:ring-2 focus:ring-[#ff4500]/50 focus:border-[#ff4500]"
            >
              {accounts.map(acc => (
                <option key={acc.id} value={acc.id}>u/{acc.username}</option>
              ))}
            </select>
          )}
        </div>

        <div>
          <label className="block text-sm font-medium text-[#d7dadc] mb-1">
            Min Lead Score: {minScore}
          </label>
          <input
            type="range"
            min={20}
            max={90}
            value={minScore}
            onChange={(e) => setMinScore(Number(e.target.value))}
            className="w-full accent-[#ff4500]"
          />
          <div className="flex justify-between text-xs text-[#52525b]">
            <span>More leads (lower quality)</span>
            <span>Fewer leads (higher quality)</span>
          </div>
        </div>

        <div>
          <label className="block text-sm font-medium text-[#d7dadc] mb-1">
            <Calendar className="w-3.5 h-3.5 inline mr-1.5" />
            Post Timeframe
          </label>
          <select
            value={timeframe}
            onChange={(e) => setTimeframe(e.target.value)}
            className="w-full bg-[#1e1e24] border border-[#23232a] rounded-lg p-3 text-sm text-white focus:ring-2 focus:ring-[#ff4500]/50 focus:border-[#ff4500]"
          >
            {TIMEFRAME_OPTIONS.map(opt => (
              <option key={opt.value} value={opt.value}>{opt.label}</option>
            ))}
          </select>
          {timeframe === 'custom' && (
            <div className="flex gap-3 mt-2">
              <input
                type="date"
                value={timeframeStart}
                onChange={(e) => setTimeframeStart(e.target.value)}
                className="flex-1 bg-[#1e1e24] border border-[#23232a] rounded-lg p-2.5 text-sm text-white focus:ring-2 focus:ring-[#ff4500]/50 focus:border-[#ff4500]"
                required
              />
              <span className="text-[#71717a] self-center text-sm">to</span>
              <input
                type="date"
                value={timeframeEnd}
                onChange={(e) => setTimeframeEnd(e.target.value)}
                className="flex-1 bg-[#1e1e24] border border-[#23232a] rounded-lg p-2.5 text-sm text-white focus:ring-2 focus:ring-[#ff4500]/50 focus:border-[#ff4500]"
                required
              />
            </div>
          )}
        </div>

        <div className="flex items-center gap-3 p-3 bg-[#0a0a0b] rounded-lg">
          <input
            type="checkbox"
            id="autoApprove"
            checked={autoApprove}
            onChange={(e) => setAutoApprove(e.target.checked)}
            className="w-4 h-4 rounded border-[#23232a] text-[#ff4500] focus:ring-[#ff4500]"
          />
          <div>
            <label htmlFor="autoApprove" className="text-sm font-medium text-[#d7dadc] cursor-pointer">
              Auto-approve messages
            </label>
            <p className="text-xs text-[#52525b]">
              Skip manual review. Messages will be sent automatically by the extension.
            </p>
          </div>
        </div>

        <button
          type="submit"
          disabled={loading || !subreddits.trim() || !selectedAccount}
          className="w-full flex items-center justify-center gap-2 px-6 py-3 bg-[#ff4500] text-white font-semibold rounded-lg hover:bg-[#e63e00] disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
        >
          <Zap className="w-5 h-5" />
          {loading ? 'Starting...' : 'Start Autopilot'}
        </button>
      </div>
    </form>
  );
}

// ============================================================================
// Automation Send Controls
// ============================================================================
function AutomationSendControls({ sessionId }) {
  const [stats, setStats] = useState(null);
  const [extensionAvailable, setExtensionAvailable] = useState(null);
  const [queueStatus, setQueueStatus] = useState({ isPolling: false, isProcessing: false });
  const [toggling, setToggling] = useState(false);
  const pollRef = useRef(null);

  useEffect(() => {
    // Check extension and load initial stats
    api.checkExtensionAvailable().then(setExtensionAvailable);
    loadStats();

    // Poll stats every 5s
    pollRef.current = setInterval(loadStats, 5000);
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, [sessionId]);

  const loadStats = async () => {
    try {
      const [s, qs] = await Promise.all([
        api.getAutomationStats(sessionId),
        api.getOutreachQueueStatus(),
      ]);
      setStats(s);
      setQueueStatus(qs);
    } catch (err) {
      logError('Failed to load automation stats', { component: 'AutomationSendControls', errorName: err?.name, errorStack: err?.stack });
    }
  };

  const handleToggleSending = async () => {
    setToggling(true);
    const start = !queueStatus.isPolling;
    await api.triggerOutreachPolling(start);
    // Give the extension a moment to start/stop
    setTimeout(async () => {
      const qs = await api.getOutreachQueueStatus();
      setQueueStatus(qs);
      setToggling(false);
    }, 1500);
  };

  if (!stats) return null;

  const total = stats.total || 0;
  const sent = stats.sent || 0;
  const failed = stats.failed || 0;
  const approved = stats.approved || 0;
  const pending = stats.pending || 0;
  const progress = total > 0 ? Math.round(((sent + failed) / total) * 100) : 0;

  return (
    <div className="bg-[#141416] rounded-lg border border-[#23232a] p-5 mt-4">
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-sm font-semibold text-[#d7dadc] uppercase tracking-wider">Sending Progress</h3>
        {extensionAvailable === false && (
          <div className="flex items-center gap-1.5 text-xs text-red-400">
            <WifiOff className="w-3.5 h-3.5" />
            Extension not detected
          </div>
        )}
        {extensionAvailable === true && (
          <div className="flex items-center gap-1.5 text-xs text-green-400">
            <Wifi className="w-3.5 h-3.5" />
            Extension connected
          </div>
        )}
      </div>

      {/* Progress bar */}
      {total > 0 && (
        <div className="w-full bg-[#1e1e24] rounded-full h-2.5 mb-4">
          <div
            className="bg-green-500 h-2.5 rounded-full transition-all duration-500"
            style={{ width: `${progress}%` }}
          />
        </div>
      )}

      {/* Stats grid */}
      <div className="grid grid-cols-5 gap-2 mb-4">
        <div className="text-center p-2 bg-[#1e1e24] rounded">
          <div className="text-lg font-bold text-white">{total}</div>
          <div className="text-xs text-[#71717a]">Queued</div>
        </div>
        <div className="text-center p-2 bg-yellow-500/15 rounded">
          <div className="text-lg font-bold text-yellow-400">{pending}</div>
          <div className="text-xs text-[#71717a]">Pending</div>
        </div>
        <div className="text-center p-2 bg-blue-500/15 rounded">
          <div className="text-lg font-bold text-blue-400">{approved}</div>
          <div className="text-xs text-[#71717a]">Approved</div>
        </div>
        <div className="text-center p-2 bg-green-500/15 rounded">
          <div className="text-lg font-bold text-green-400">{sent}</div>
          <div className="text-xs text-[#71717a]">Sent</div>
        </div>
        <div className="text-center p-2 bg-red-500/15 rounded">
          <div className="text-lg font-bold text-red-400">{failed}</div>
          <div className="text-xs text-[#71717a]">Failed</div>
        </div>
      </div>

      {/* Send controls */}
      {extensionAvailable === false ? (
        <div className="p-3 bg-red-500/10 border border-red-500/20 rounded-lg text-sm text-red-400">
          Install and enable the Chrome extension to send messages. Make sure you're logged into Reddit in the same browser.
        </div>
      ) : approved > 0 || queueStatus.isPolling ? (
        <button
          onClick={handleToggleSending}
          disabled={toggling}
          className={`w-full flex items-center justify-center gap-2 px-4 py-2.5 font-medium rounded-lg transition-colors ${
            queueStatus.isPolling
              ? 'bg-red-500 text-white hover:bg-red-600'
              : 'bg-green-600 text-white hover:bg-green-700'
          } disabled:opacity-50`}
        >
          {queueStatus.isPolling ? (
            <>
              <Square className="w-4 h-4" />
              {toggling ? 'Stopping...' : 'Stop Sending'}
              {queueStatus.isProcessing && <span className="text-xs opacity-75 ml-1">(sending...)</span>}
            </>
          ) : (
            <>
              <Play className="w-4 h-4" />
              {toggling ? 'Starting...' : `Start Sending (${approved} approved)`}
            </>
          )}
        </button>
      ) : pending > 0 ? (
        <p className="text-sm text-[#71717a] text-center">
          {pending} items pending review. Go to the <a href="/queue" className="text-[#4d9fff] hover:underline">Queue</a> to approve them.
        </p>
      ) : sent === total && total > 0 ? (
        <p className="text-sm text-green-400 text-center font-medium">All messages sent!</p>
      ) : null}
    </div>
  );
}

// ============================================================================
// Discovery Progress View
// ============================================================================
function DiscoveryProgress({ session, onCancel }) {
  const statusLabels = {
    pending: 'Initializing...',
    searching: 'Searching Reddit...',
    scoring: 'Scoring leads...',
    queuing: 'Generating messages & queuing...',
  };

  const total = session.total_queries_planned || 1;
  const done = session.queries_completed || 0;
  const pct = Math.min(100, Math.round((done / total) * 100));

  return (
    <div className="bg-[#141416] rounded-lg border border-[#23232a] p-6 max-w-2xl mx-auto">
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-lg font-semibold text-white">
          {statusLabels[session.status] || session.status}
        </h3>
        <button
          onClick={onCancel}
          className="text-sm text-red-400 hover:text-red-300"
        >
          Cancel
        </button>
      </div>

      {/* Progress bar */}
      <div className="w-full bg-[#1e1e24] rounded-full h-3 mb-4">
        <div
          className="bg-[#ff4500] h-3 rounded-full transition-all duration-500"
          style={{ width: `${pct}%` }}
        />
      </div>

      {/* Stats */}
      <div className={`grid ${session.mode === 'automation' ? 'grid-cols-4' : session.subreddit_posts_fetched > 0 ? 'grid-cols-4' : 'grid-cols-3'} gap-4 text-center`}>
        <div className="bg-[#1e1e24] rounded-lg p-3">
          <div className="text-xl font-bold text-white">
            {session.total_posts_found || 0}
          </div>
          <div className="text-xs text-[#71717a]">Posts Found</div>
        </div>
        <div className="bg-[#1e1e24] rounded-lg p-3">
          <div className="text-xl font-bold text-white">
            {session.total_leads_scored || 0}
          </div>
          <div className="text-xs text-[#71717a]">Posts Scored</div>
        </div>
        <div className="bg-[#1e1e24] rounded-lg p-3">
          <div className="text-xl font-bold text-[#ff4500]">
            {session.leads_qualified || 0}
          </div>
          <div className="text-xs text-[#71717a]">Leads Found</div>
        </div>
        {session.subreddit_posts_fetched > 0 && (
          <div className="bg-[#1e1e24] rounded-lg p-3">
            <div className="text-xl font-bold text-teal-400">
              {session.subreddit_posts_fetched || 0}
            </div>
            <div className="text-xs text-[#71717a]">Subreddit Posts</div>
          </div>
        )}
        {session.mode === 'automation' && (
          <div className="bg-[#1e1e24] rounded-lg p-3">
            <div className="text-xl font-bold text-green-400">
              {session.leads_queued || 0}
            </div>
            <div className="text-xs text-[#71717a]">Queued</div>
          </div>
        )}
      </div>
    </div>
  );
}

// ============================================================================
// Discovery Results View
// ============================================================================
function DiscoveryResults({ session, onNewSearch, sessionId }) {
  const [leads, setLeads] = useState([]);
  const [accounts, setAccounts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [tierFilter, setTierFilter] = useState('all');
  const [subredditFilter, setSubredditFilter] = useState('all');
  const [relevanceFilter, setRelevanceFilter] = useState('relevant');
  const [subreddits, setSubreddits] = useState([]);
  const [bulkAccount, setBulkAccount] = useState('');
  const [bulkQueueing, setBulkQueueing] = useState(false);
  const [bulkProgress, setBulkProgress] = useState(null); // {queued, failed, total}
  const [previouslyFound, setPreviouslyFound] = useState([]);
  const [showPreviouslyFound, setShowPreviouslyFound] = useState(false);

  useEffect(() => {
    loadData();
  }, [sessionId, tierFilter, subredditFilter, relevanceFilter]);

  const loadData = async () => {
    setLoading(true);
    try {
      const filters = {};
      if (tierFilter !== 'all') filters.tier = tierFilter;
      if (subredditFilter !== 'all') filters.subreddit = subredditFilter;
      if (relevanceFilter !== 'all') filters.relevance = relevanceFilter;
      filters.limit = 100;

      const [leadsData, accountsData, subredditsData, prevData] = await Promise.all([
        api.getDiscoveryLeads(sessionId, filters),
        api.getAccountsSummary().catch(() => []),
        api.getDiscoverySubreddits(sessionId).catch(() => []),
        api.getPreviouslyFoundLeads(sessionId).catch(() => []),
      ]);

      setLeads(leadsData || []);
      setAccounts(accountsData || []);
      setSubreddits(subredditsData || []);
      setPreviouslyFound(prevData || []);
      if (accountsData?.length && !bulkAccount) {
        setBulkAccount(accountsData[0].id);
      }
    } catch (err) {
      logError('Failed to load discovery results', { component: 'DiscoveryResults', errorName: err?.name, errorStack: err?.stack });
    }
    setLoading(false);
  };

  const handleQueue = (leadId) => {
    setLeads(prev => prev.map(l => l.id === leadId ? { ...l, status: 'queued' } : l));
  };

  const handleDismiss = async (leadId) => {
    try {
      await api.dismissLead(sessionId, leadId);
      setLeads(prev => prev.map(l => l.id === leadId ? { ...l, status: 'dismissed' } : l));
    } catch (err) {
      logError('Failed to dismiss lead', { component: 'DiscoveryResults', errorName: err?.name, errorStack: err?.stack });
    }
  };

  const eligibleLeads = leads.filter(l => l.status === 'scored' && l.lead_tier !== 'irrelevant');

  const handleBulkQueue = async () => {
    if (!bulkAccount || eligibleLeads.length === 0) return;
    setBulkQueueing(true);
    setBulkProgress({ queued: 0, failed: 0, total: eligibleLeads.length });
    try {
      const leadIds = eligibleLeads.map(l => l.id);
      const result = await api.bulkQueueLeads(sessionId, { leadIds, accountId: bulkAccount });
      setBulkProgress({
        queued: result?.queued || 0,
        failed: result?.failed || 0,
        total: eligibleLeads.length,
      });
      // Refresh leads to update statuses
      await loadData();
    } catch (err) {
      logError('Bulk queue failed', { component: 'DiscoveryResults', errorName: err?.name, errorStack: err?.stack });
      setBulkProgress(prev => prev ? { ...prev, failed: prev.total } : null);
    }
    setBulkQueueing(false);
  };

  const tierCounts = {
    hot: leads.filter(l => l.lead_tier === 'hot').length,
    warm: leads.filter(l => l.lead_tier === 'warm').length,
    cold: leads.filter(l => l.lead_tier === 'cold').length,
    irrelevant: leads.filter(l => l.lead_tier === 'irrelevant').length,
  };

  const activeLeads = leads.filter(l => l.status !== 'dismissed');

  return (
    <div>
      {/* Header */}
      <div className="flex items-center justify-between mb-4">
        <div>
          <h2 className="text-lg font-semibold text-white">
            Discovery Results
          </h2>
          <p className="text-sm text-[#71717a]">
            {session.leads_qualified || 0} leads found across {subreddits.length} subreddits
            {session.subreddit_posts_fetched > 0 && (
              <span> ({session.subreddit_posts_fetched} from subreddit expansion)</span>
            )}
          </p>
          {(session.yield_rate != null || session.duplicate_posts_skipped > 0) && (
            <div className="flex items-center gap-3 mt-1">
              {session.yield_rate != null && (
                <span className={`text-xs font-medium ${
                  session.yield_rate >= 20 ? 'text-green-400' : session.yield_rate >= 10 ? 'text-yellow-400' : 'text-red-400'
                }`}>
                  <BarChart3 className="w-3 h-3 inline mr-1" />
                  Yield: {session.yield_rate}%
                </span>
              )}
              {session.duplicate_posts_skipped > 0 && (
                <span className="text-xs text-[#52525b]">
                  {session.duplicate_posts_skipped} duplicate posts skipped
                </span>
              )}
            </div>
          )}
          {session.yield_rate != null && session.yield_rate < 10 && session.yield_rate > 0 && (
            <p className="text-xs text-yellow-400/80 mt-1">
              <AlertTriangle className="w-3 h-3 inline mr-1" />
              Low yield — try a narrower timeframe or different business context
            </p>
          )}
        </div>
        <button
          onClick={onNewSearch}
          className="flex items-center gap-2 px-4 py-2 bg-[#ff4500] text-white text-sm font-medium rounded-lg hover:bg-[#e63e00]"
        >
          <Search className="w-4 h-4" />
          New Search
        </button>
      </div>

      {/* Bulk Queue All */}
      {eligibleLeads.length > 0 && accounts.length > 0 && (
        <div className="flex items-center gap-3 mb-4 p-3 bg-[#141416] rounded-lg border border-[#23232a]">
          <select
            value={bulkAccount}
            onChange={(e) => setBulkAccount(e.target.value)}
            className="text-sm bg-[#1e1e24] border border-[#23232a] rounded-lg px-2 py-1.5 text-white"
            disabled={bulkQueueing}
          >
            {accounts.map(acc => (
              <option key={acc.id} value={acc.id}>u/{acc.username}</option>
            ))}
          </select>
          <button
            onClick={handleBulkQueue}
            disabled={bulkQueueing || !bulkAccount}
            className="flex items-center gap-2 px-4 py-2 bg-[#ff4500] text-white text-sm font-semibold rounded-lg hover:bg-[#e63e00] disabled:opacity-50 transition-colors"
          >
            {bulkQueueing ? (
              <>
                <RefreshCw className="w-4 h-4 animate-spin" />
                Generating & Queueing...
              </>
            ) : (
              <>
                <ListChecks className="w-4 h-4" />
                Queue All ({eligibleLeads.length})
              </>
            )}
          </button>
          {bulkProgress && !bulkQueueing && (
            <span className="text-sm text-[#a1a1aa]">
              {bulkProgress.queued} queued
              {bulkProgress.failed > 0 && (
                <span className="text-red-400 ml-1">({bulkProgress.failed} failed)</span>
              )}
            </span>
          )}
          {bulkQueueing && (
            <span className="text-xs text-[#71717a]">
              Messages are being generated and queued — this may take a minute...
            </span>
          )}
        </div>
      )}

      {/* Relevance toggle */}
      <div className="flex gap-2 mb-4">
        <button
          onClick={() => setRelevanceFilter('relevant')}
          className={`flex items-center gap-1.5 px-4 py-1.5 rounded-lg text-sm font-medium transition-colors ${
            relevanceFilter === 'relevant'
              ? 'bg-green-500/20 text-green-400 border border-green-500/30'
              : 'bg-[#1e1e24] text-[#71717a] hover:text-[#a1a1aa] border border-transparent'
          }`}
        >
          <Eye className="w-3.5 h-3.5" />
          Relevant
        </button>
        <button
          onClick={() => setRelevanceFilter('irrelevant')}
          className={`flex items-center gap-1.5 px-4 py-1.5 rounded-lg text-sm font-medium transition-colors ${
            relevanceFilter === 'irrelevant'
              ? 'bg-gray-500/20 text-gray-400 border border-gray-500/30'
              : 'bg-[#1e1e24] text-[#71717a] hover:text-[#a1a1aa] border border-transparent'
          }`}
        >
          <EyeOff className="w-3.5 h-3.5" />
          Irrelevant ({session.total_posts_irrelevant || 0})
        </button>
        <button
          onClick={() => setRelevanceFilter('all')}
          className={`flex items-center gap-1.5 px-4 py-1.5 rounded-lg text-sm font-medium transition-colors ${
            relevanceFilter === 'all'
              ? 'bg-blue-500/20 text-blue-400 border border-blue-500/30'
              : 'bg-[#1e1e24] text-[#71717a] hover:text-[#a1a1aa] border border-transparent'
          }`}
        >
          All Posts
        </button>
      </div>

      {/* Tier summary */}
      <div className="grid grid-cols-3 gap-3 mb-4">
        <button
          onClick={() => setTierFilter(tierFilter === 'hot' ? 'all' : 'hot')}
          className={`p-3 rounded-lg border text-center transition-colors ${
            tierFilter === 'hot' ? 'border-red-500/50 bg-red-500/10' : 'border-[#23232a] bg-[#141416] hover:border-red-500/30'
          }`}
        >
          <div className="flex items-center justify-center gap-1 mb-1">
            <Flame className="w-4 h-4 text-red-500" />
            <span className="text-sm font-medium text-[#a1a1aa]">Hot</span>
          </div>
          <div className="text-2xl font-bold text-red-400">{tierCounts.hot}</div>
        </button>
        <button
          onClick={() => setTierFilter(tierFilter === 'warm' ? 'all' : 'warm')}
          className={`p-3 rounded-lg border text-center transition-colors ${
            tierFilter === 'warm' ? 'border-orange-500/50 bg-orange-500/10' : 'border-[#23232a] bg-[#141416] hover:border-orange-500/30'
          }`}
        >
          <div className="flex items-center justify-center gap-1 mb-1">
            <Thermometer className="w-4 h-4 text-orange-500" />
            <span className="text-sm font-medium text-[#a1a1aa]">Warm</span>
          </div>
          <div className="text-2xl font-bold text-orange-400">{tierCounts.warm}</div>
        </button>
        <button
          onClick={() => setTierFilter(tierFilter === 'cold' ? 'all' : 'cold')}
          className={`p-3 rounded-lg border text-center transition-colors ${
            tierFilter === 'cold' ? 'border-blue-500/50 bg-blue-500/10' : 'border-[#23232a] bg-[#141416] hover:border-blue-500/30'
          }`}
        >
          <div className="flex items-center justify-center gap-1 mb-1">
            <Snowflake className="w-4 h-4 text-blue-500" />
            <span className="text-sm font-medium text-[#a1a1aa]">Cold</span>
          </div>
          <div className="text-2xl font-bold text-blue-400">{tierCounts.cold}</div>
        </button>
      </div>

      {/* Subreddit filter */}
      {subreddits.length > 1 && (
        <div className="mb-4">
          <select
            value={subredditFilter}
            onChange={(e) => setSubredditFilter(e.target.value)}
            className="text-sm bg-[#1e1e24] border border-[#23232a] rounded-lg px-3 py-1.5 text-white"
          >
            <option value="all">All subreddits</option>
            {subreddits.map(sr => (
              <option key={sr.subreddit_name} value={sr.subreddit_name}>
                r/{sr.subreddit_name} ({sr.leads_found} leads)
              </option>
            ))}
          </select>
        </div>
      )}

      {/* Leads list */}
      {loading ? (
        <div className="flex justify-center py-12">
          <RefreshCw className="w-6 h-6 animate-spin text-[#ff4500]" />
        </div>
      ) : activeLeads.length === 0 ? (
        <div className="text-center py-12 text-[#52525b]">
          No leads found matching filters
        </div>
      ) : (
        <div className="space-y-3">
          {activeLeads.map(lead => (
            <LeadCard
              key={lead.id}
              lead={lead}
              accounts={accounts}
              sessionId={sessionId}
              onQueue={handleQueue}
              onDismiss={handleDismiss}
              onGenerateMessage={() => {}}
            />
          ))}
        </div>
      )}

      {/* Previously Found leads from past sessions */}
      {previouslyFound.length > 0 && (
        <div className="mt-6 border-t border-[#23232a] pt-4">
          <button
            onClick={() => setShowPreviouslyFound(!showPreviouslyFound)}
            className="flex items-center gap-2 text-sm font-medium text-[#a1a1aa] hover:text-white transition-colors"
          >
            <History className="w-4 h-4" />
            Previously Found ({previouslyFound.length} un-contacted leads from past sessions)
            {showPreviouslyFound ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
          </button>

          {showPreviouslyFound && (
            <div className="space-y-3 mt-3">
              {previouslyFound.map(lead => (
                <div key={lead.id} className="relative">
                  <div className="absolute top-2 right-2 z-10">
                    <span className="px-2 py-0.5 rounded-full text-xs font-medium bg-yellow-500/15 text-yellow-400">
                      Previously Found
                    </span>
                  </div>
                  <LeadCard
                    lead={lead}
                    accounts={accounts}
                    sessionId={lead.session_id}
                    onQueue={(leadId) => {
                      setPreviouslyFound(prev => prev.filter(l => l.id !== leadId));
                    }}
                    onDismiss={async (leadId) => {
                      try {
                        await api.dismissLead(lead.session_id, leadId);
                        setPreviouslyFound(prev => prev.filter(l => l.id !== leadId));
                      } catch (err) {
                        logError('Failed to dismiss lead', { component: 'DiscoveryResults', errorName: err?.name, errorStack: err?.stack });
                      }
                    }}
                    onGenerateMessage={() => {}}
                  />
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ============================================================================
// Session History
// ============================================================================
function SessionHistory({ sessions, onSelect, onBack }) {
  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-lg font-semibold text-white">Past Sessions</h2>
        <button
          onClick={onBack}
          className="text-sm text-blue-400 hover:text-blue-300"
        >
          Back
        </button>
      </div>

      {sessions.length === 0 ? (
        <div className="text-center py-12 text-[#52525b]">
          No previous discovery sessions
        </div>
      ) : (
        <div className="space-y-2">
          {sessions.map(session => (
            <button
              key={session.id}
              onClick={() => onSelect(session)}
              className="w-full text-left bg-[#141416] rounded-lg border border-[#23232a] p-4 hover:border-[#ff4500] transition-colors"
            >
              <div className="flex items-center justify-between">
                <div>
                  <div className="text-sm font-medium text-white">
                    {new Date(session.created_at).toLocaleDateString('en-US', {
                      month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit'
                    })}
                  </div>
                  <div className="text-xs text-[#71717a] mt-0.5">
                    {session.business_desc?.slice(0, 80)}
                    {session.business_desc?.length > 80 ? '...' : ''}
                  </div>
                </div>
                <div className="text-right">
                  <div className="flex items-center gap-1.5 justify-end">
                    {session.mode === 'automation' && (
                      <span className="px-2 py-0.5 rounded-full text-xs font-medium bg-purple-500/15 text-purple-400">
                        Auto
                      </span>
                    )}
                    <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${
                      session.status === 'completed' ? 'bg-green-500/15 text-green-400' :
                      session.status === 'failed' ? 'bg-red-500/15 text-red-400' :
                      session.status === 'cancelled' ? 'bg-gray-500/15 text-gray-400' :
                      'bg-yellow-500/15 text-yellow-400'
                    }`}>
                      {session.status}
                    </span>
                  </div>
                  <div className="text-xs text-[#71717a] mt-1">
                    {session.leads_qualified || 0} leads
                    {session.leads_queued > 0 && ` / ${session.leads_queued} queued`}
                    {session.yield_rate != null && (
                      <span className={`ml-2 ${
                        session.yield_rate >= 20 ? 'text-green-400' : session.yield_rate >= 10 ? 'text-yellow-400' : 'text-red-400'
                      }`}>
                        {session.yield_rate}% yield
                      </span>
                    )}
                    {session.duplicate_posts_skipped > 0 && (
                      <span className="ml-2 text-[#52525b]">
                        ({session.duplicate_posts_skipped} dupes skipped)
                      </span>
                    )}
                  </div>
                </div>
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ============================================================================
// Watch List component
// ============================================================================
function WatchList() {
  const [watches, setWatches] = useState([]);
  const [loading, setLoading] = useState(true);
  const [newSubreddit, setNewSubreddit] = useState('');
  const [adding, setAdding] = useState(false);
  const [refreshingAll, setRefreshingAll] = useState(false);
  const [refreshingId, setRefreshingId] = useState(null);
  const [selectedWatch, setSelectedWatch] = useState(null);

  useEffect(() => {
    loadWatches();
  }, []);

  const loadWatches = async () => {
    setLoading(true);
    try {
      const data = await api.getWatches();
      setWatches(data || []);
    } catch (err) {
      logError('Failed to load watches', { component: 'WatchList', errorName: err?.name, errorStack: err?.stack });
    }
    setLoading(false);
  };

  const handleAdd = async (e) => {
    e.preventDefault();
    if (!newSubreddit.trim()) return;
    setAdding(true);
    try {
      const watch = await api.createWatch(newSubreddit.trim());
      if (watch) {
        setWatches(prev => [watch, ...prev]);
        setNewSubreddit('');
      }
    } catch (err) {
      logError('Failed to create watch', { component: 'WatchList', errorName: err?.name, errorStack: err?.stack });
    }
    setAdding(false);
  };

  const handleRefresh = async (watchId) => {
    setRefreshingId(watchId);
    try {
      await api.refreshWatch(watchId);
      // Update status optimistically
      setWatches(prev => prev.map(w =>
        w.id === watchId ? { ...w, status: 'refreshing' } : w
      ));
      // Poll for completion
      const poll = setInterval(async () => {
        const updated = await api.getWatches();
        const w = (updated || []).find(x => x.id === watchId);
        if (w && w.status !== 'refreshing') {
          setWatches(updated);
          clearInterval(poll);
          setRefreshingId(null);
        }
      }, 3000);
      // Safety timeout
      setTimeout(() => { clearInterval(poll); setRefreshingId(null); loadWatches(); }, 60000);
    } catch (err) {
      logError('Failed to refresh watch', { component: 'WatchList', errorName: err?.name, errorStack: err?.stack });
      setRefreshingId(null);
    }
  };

  const handleRefreshAll = async () => {
    setRefreshingAll(true);
    try {
      await api.refreshAllWatches();
      // Mark all active as refreshing
      setWatches(prev => prev.map(w =>
        w.status === 'active' ? { ...w, status: 'refreshing' } : w
      ));
      // Poll for completion
      const poll = setInterval(async () => {
        const updated = await api.getWatches();
        const stillRefreshing = (updated || []).some(w => w.status === 'refreshing');
        setWatches(updated || []);
        if (!stillRefreshing) {
          clearInterval(poll);
          setRefreshingAll(false);
        }
      }, 5000);
      setTimeout(() => { clearInterval(poll); setRefreshingAll(false); loadWatches(); }, 120000);
    } catch (err) {
      logError('Failed to refresh all', { component: 'WatchList', errorName: err?.name, errorStack: err?.stack });
      setRefreshingAll(false);
    }
  };

  const handleTogglePause = async (watch) => {
    const newStatus = watch.status === 'paused' ? 'active' : 'paused';
    try {
      const updated = await api.updateWatch(watch.id, { status: newStatus });
      if (updated) {
        setWatches(prev => prev.map(w => w.id === watch.id ? updated : w));
      }
    } catch (err) {
      logError('Failed to update watch', { component: 'WatchList', errorName: err?.name, errorStack: err?.stack });
    }
  };

  const handleDelete = async (watchId) => {
    try {
      await api.deleteWatch(watchId);
      setWatches(prev => prev.filter(w => w.id !== watchId));
    } catch (err) {
      logError('Failed to delete watch', { component: 'WatchList', errorName: err?.name, errorStack: err?.stack });
    }
  };

  // If a watch is selected, show its leads
  if (selectedWatch) {
    return (
      <WatchLeads
        watch={selectedWatch}
        onBack={() => { setSelectedWatch(null); loadWatches(); }}
      />
    );
  }

  return (
    <div>
      {/* Add subreddit input */}
      <form onSubmit={handleAdd} className="flex gap-2 mb-4 max-w-xl">
        <input
          type="text"
          value={newSubreddit}
          onChange={(e) => setNewSubreddit(e.target.value)}
          placeholder="Enter subreddit name (e.g. saas, startups)"
          className="flex-1 bg-[#1e1e24] border border-[#23232a] rounded-lg px-3 py-2 text-sm text-white placeholder-[#52525b] focus:ring-2 focus:ring-[#ff4500]/50 focus:border-[#ff4500]"
        />
        <button
          type="submit"
          disabled={adding || !newSubreddit.trim()}
          className="flex items-center gap-1.5 px-4 py-2 bg-[#ff4500] text-white text-sm font-medium rounded-lg hover:bg-[#e63e00] disabled:opacity-50"
        >
          <Plus className="w-4 h-4" />
          {adding ? 'Adding...' : 'Add'}
        </button>
      </form>

      {/* Refresh all button */}
      {watches.length > 0 && (
        <div className="flex items-center justify-between mb-4">
          <p className="text-sm text-[#71717a]">
            {watches.length} watched subreddit{watches.length !== 1 ? 's' : ''}
          </p>
          <button
            onClick={handleRefreshAll}
            disabled={refreshingAll}
            className="flex items-center gap-1.5 px-3 py-1.5 text-sm text-[#a1a1aa] hover:text-white bg-[#1e1e24] hover:bg-[#23232a] rounded-lg disabled:opacity-50"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${refreshingAll ? 'animate-spin' : ''}`} />
            {refreshingAll ? 'Refreshing...' : 'Refresh All'}
          </button>
        </div>
      )}

      {/* Watch list */}
      {loading ? (
        <div className="flex justify-center py-12">
          <RefreshCw className="w-6 h-6 animate-spin text-[#ff4500]" />
        </div>
      ) : watches.length === 0 ? (
        <div className="text-center py-12 bg-[#141416] rounded-lg border border-[#23232a]">
          <Radar className="w-10 h-10 text-[#52525b] mx-auto mb-3" />
          <p className="text-[#71717a] text-sm">No watched subreddits yet</p>
          <p className="text-[#52525b] text-xs mt-1">Add subreddits above to start monitoring for new posts</p>
        </div>
      ) : (
        <div className="space-y-2">
          {watches.map(watch => (
            <div
              key={watch.id}
              className="bg-[#141416] rounded-lg border border-[#23232a] p-4 hover:border-[#ff4500]/30 transition-colors"
            >
              <div className="flex items-center justify-between">
                <button
                  onClick={() => {
                    setSelectedWatch(watch);
                    api.resetWatchNewLeads(watch.id).catch(() => {});
                  }}
                  className="flex-1 text-left"
                >
                  <div className="flex items-center gap-3">
                    <span className="text-base font-semibold text-white">
                      r/{watch.subreddit_name}
                    </span>
                    <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${
                      watch.status === 'active' ? 'bg-green-500/15 text-green-400' :
                      watch.status === 'paused' ? 'bg-yellow-500/15 text-yellow-400' :
                      watch.status === 'refreshing' ? 'bg-blue-500/15 text-blue-400' :
                      'bg-gray-500/15 text-gray-400'
                    }`}>
                      {watch.status === 'refreshing' ? (
                        <span className="flex items-center gap-1">
                          <RefreshCw className="w-3 h-3 animate-spin" />
                          Refreshing
                        </span>
                      ) : watch.status}
                    </span>
                    {(watch.new_leads_since_last_view || 0) > 0 && (
                      <span className="px-2 py-0.5 rounded-full text-xs font-bold bg-[#ff4500] text-white">
                        {watch.new_leads_since_last_view} new
                      </span>
                    )}
                  </div>
                  <div className="flex items-center gap-4 mt-1 text-xs text-[#71717a]">
                    <span>{watch.total_leads_found || 0} leads found</span>
                    <span>{watch.total_posts_checked || 0} posts checked</span>
                    {watch.last_checked_at && (
                      <span>Last checked: {formatTimeAgoISO(watch.last_checked_at)}</span>
                    )}
                  </div>
                </button>

                <div className="flex items-center gap-1 ml-3">
                  <button
                    onClick={() => handleRefresh(watch.id)}
                    disabled={refreshingId === watch.id || watch.status === 'refreshing' || watch.status === 'paused'}
                    className="p-1.5 rounded hover:bg-[#1e1e24] text-[#71717a] hover:text-[#a1a1aa] disabled:opacity-30"
                    title="Refresh now"
                  >
                    <RefreshCw className={`w-4 h-4 ${refreshingId === watch.id ? 'animate-spin' : ''}`} />
                  </button>
                  <button
                    onClick={() => handleTogglePause(watch)}
                    disabled={watch.status === 'refreshing'}
                    className="p-1.5 rounded hover:bg-[#1e1e24] text-[#71717a] hover:text-[#a1a1aa] disabled:opacity-30"
                    title={watch.status === 'paused' ? 'Resume' : 'Pause'}
                  >
                    {watch.status === 'paused' ? (
                      <Play className="w-4 h-4" />
                    ) : (
                      <Pause className="w-4 h-4" />
                    )}
                  </button>
                  <button
                    onClick={() => handleDelete(watch.id)}
                    className="p-1.5 rounded hover:bg-red-500/10 text-[#71717a] hover:text-red-400"
                    title="Delete watch"
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ============================================================================
// Watch Leads component
// ============================================================================
function WatchLeads({ watch, onBack }) {
  const [leads, setLeads] = useState([]);
  const [accounts, setAccounts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [tierFilter, setTierFilter] = useState('all');
  const [relevanceFilter, setRelevanceFilter] = useState('relevant');

  useEffect(() => {
    loadData();
  }, [watch.id, tierFilter, relevanceFilter]);

  const loadData = async () => {
    setLoading(true);
    try {
      const filters = {};
      if (tierFilter !== 'all') filters.tier = tierFilter;
      if (relevanceFilter !== 'all') filters.relevance = relevanceFilter;
      filters.limit = 100;

      const [leadsData, accountsData] = await Promise.all([
        api.getWatchLeads(watch.id, filters),
        api.getAccountsSummary().catch(() => []),
      ]);

      setLeads(leadsData || []);
      setAccounts(accountsData || []);
    } catch (err) {
      logError('Failed to load watch leads', { component: 'WatchLeads', errorName: err?.name, errorStack: err?.stack });
    }
    setLoading(false);
  };

  const handleQueue = (leadId) => {
    setLeads(prev => prev.map(l => l.id === leadId ? { ...l, status: 'queued' } : l));
  };

  const handleDismiss = async (leadId) => {
    try {
      await api.dismissWatchLead(watch.id, leadId);
      setLeads(prev => prev.map(l => l.id === leadId ? { ...l, status: 'dismissed' } : l));
    } catch (err) {
      logError('Failed to dismiss lead', { component: 'WatchLeads', errorName: err?.name, errorStack: err?.stack });
    }
  };

  // Custom API functions for watch leads
  const watchGenerateMessage = (watchId, leadId) => api.generateWatchLeadMessage(watch.id, leadId);
  const watchQueueLead = (watchId, leadId, data) => api.queueWatchLead(watch.id, leadId, data);

  const tierCounts = {
    hot: leads.filter(l => l.lead_tier === 'hot').length,
    warm: leads.filter(l => l.lead_tier === 'warm').length,
    cold: leads.filter(l => l.lead_tier === 'cold').length,
  };

  const activeLeads = leads.filter(l => l.status !== 'dismissed');

  return (
    <div>
      {/* Header */}
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-3">
          <button
            onClick={onBack}
            className="p-1.5 rounded hover:bg-[#1e1e24] text-[#71717a] hover:text-white"
          >
            <ArrowLeft className="w-5 h-5" />
          </button>
          <div>
            <h2 className="text-lg font-semibold text-white">
              r/{watch.subreddit_name}
            </h2>
            <p className="text-sm text-[#71717a]">
              {watch.total_leads_found || 0} leads found from {watch.total_posts_checked || 0} posts
            </p>
          </div>
        </div>
      </div>

      {/* Relevance toggle */}
      <div className="flex gap-2 mb-4">
        <button
          onClick={() => setRelevanceFilter('relevant')}
          className={`flex items-center gap-1.5 px-4 py-1.5 rounded-lg text-sm font-medium transition-colors ${
            relevanceFilter === 'relevant'
              ? 'bg-green-500/20 text-green-400 border border-green-500/30'
              : 'bg-[#1e1e24] text-[#71717a] hover:text-[#a1a1aa] border border-transparent'
          }`}
        >
          <Eye className="w-3.5 h-3.5" />
          Relevant
        </button>
        <button
          onClick={() => setRelevanceFilter('irrelevant')}
          className={`flex items-center gap-1.5 px-4 py-1.5 rounded-lg text-sm font-medium transition-colors ${
            relevanceFilter === 'irrelevant'
              ? 'bg-gray-500/20 text-gray-400 border border-gray-500/30'
              : 'bg-[#1e1e24] text-[#71717a] hover:text-[#a1a1aa] border border-transparent'
          }`}
        >
          <EyeOff className="w-3.5 h-3.5" />
          Irrelevant
        </button>
        <button
          onClick={() => setRelevanceFilter('all')}
          className={`flex items-center gap-1.5 px-4 py-1.5 rounded-lg text-sm font-medium transition-colors ${
            relevanceFilter === 'all'
              ? 'bg-blue-500/20 text-blue-400 border border-blue-500/30'
              : 'bg-[#1e1e24] text-[#71717a] hover:text-[#a1a1aa] border border-transparent'
          }`}
        >
          All Posts
        </button>
      </div>

      {/* Tier summary */}
      <div className="grid grid-cols-3 gap-3 mb-4">
        <button
          onClick={() => setTierFilter(tierFilter === 'hot' ? 'all' : 'hot')}
          className={`p-3 rounded-lg border text-center transition-colors ${
            tierFilter === 'hot' ? 'border-red-500/50 bg-red-500/10' : 'border-[#23232a] bg-[#141416] hover:border-red-500/30'
          }`}
        >
          <div className="flex items-center justify-center gap-1 mb-1">
            <Flame className="w-4 h-4 text-red-500" />
            <span className="text-sm font-medium text-[#a1a1aa]">Hot</span>
          </div>
          <div className="text-2xl font-bold text-red-400">{tierCounts.hot}</div>
        </button>
        <button
          onClick={() => setTierFilter(tierFilter === 'warm' ? 'all' : 'warm')}
          className={`p-3 rounded-lg border text-center transition-colors ${
            tierFilter === 'warm' ? 'border-orange-500/50 bg-orange-500/10' : 'border-[#23232a] bg-[#141416] hover:border-orange-500/30'
          }`}
        >
          <div className="flex items-center justify-center gap-1 mb-1">
            <Thermometer className="w-4 h-4 text-orange-500" />
            <span className="text-sm font-medium text-[#a1a1aa]">Warm</span>
          </div>
          <div className="text-2xl font-bold text-orange-400">{tierCounts.warm}</div>
        </button>
        <button
          onClick={() => setTierFilter(tierFilter === 'cold' ? 'all' : 'cold')}
          className={`p-3 rounded-lg border text-center transition-colors ${
            tierFilter === 'cold' ? 'border-blue-500/50 bg-blue-500/10' : 'border-[#23232a] bg-[#141416] hover:border-blue-500/30'
          }`}
        >
          <div className="flex items-center justify-center gap-1 mb-1">
            <Snowflake className="w-4 h-4 text-blue-500" />
            <span className="text-sm font-medium text-[#a1a1aa]">Cold</span>
          </div>
          <div className="text-2xl font-bold text-blue-400">{tierCounts.cold}</div>
        </button>
      </div>

      {/* Leads list */}
      {loading ? (
        <div className="flex justify-center py-12">
          <RefreshCw className="w-6 h-6 animate-spin text-[#ff4500]" />
        </div>
      ) : activeLeads.length === 0 ? (
        <div className="text-center py-12 text-[#52525b]">
          No leads found matching filters
        </div>
      ) : (
        <div className="space-y-3">
          {activeLeads.map(lead => (
            <LeadCard
              key={lead.id}
              lead={lead}
              accounts={accounts}
              sessionId={watch.id}
              onQueue={handleQueue}
              onDismiss={handleDismiss}
              onGenerateMessage={() => {}}
              generateMessageFn={watchGenerateMessage}
              queueLeadFn={watchQueueLead}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// ============================================================================
// Helper
// ============================================================================
function formatTimeAgoISO(isoString) {
  if (!isoString) return '';
  const ts = new Date(isoString).getTime() / 1000;
  return formatTimeAgo(ts);
}

function formatTimeAgo(utcTimestamp) {
  if (!utcTimestamp) return '';
  const now = Date.now() / 1000;
  const diff = now - utcTimestamp;
  if (diff < 3600) return `${Math.round(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.round(diff / 3600)}h ago`;
  if (diff < 604800) return `${Math.round(diff / 86400)}d ago`;
  return `${Math.round(diff / 604800)}w ago`;
}

// ============================================================================
// Main Discovery Page
// ============================================================================
export default function Discovery() {
  const [view, setView] = useState('input'); // input | progress | results | history
  const [inputMode, setInputMode] = useState('discovery'); // discovery | automation | watch
  const [activeSessionId, setActiveSessionId] = useState(null);
  const [activeSession, setActiveSession] = useState(null);
  const [sessions, setSessions] = useState([]);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState(null);
  const pollRef = useRef(null);

  // Load past sessions on mount
  useEffect(() => {
    loadSessions();
  }, []);

  // Cleanup polling on unmount
  useEffect(() => {
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, []);

  const loadSessions = async () => {
    try {
      const data = await api.getDiscoverySessions();
      setSessions(data || []);

      // If there's a running session, resume polling
      const running = (data || []).find(s =>
        ['pending', 'searching', 'scoring', 'queuing'].includes(s.status)
      );
      if (running) {
        setActiveSessionId(running.id);
        setActiveSession(running);
        setView('progress');
        startPolling(running.id);
      }
    } catch (err) {
      logError('Failed to load sessions', { component: 'Discovery', errorName: err?.name, errorStack: err?.stack });
    }
  };

  const startPolling = (sessionId) => {
    if (pollRef.current) clearInterval(pollRef.current);
    pollRef.current = setInterval(async () => {
      try {
        const session = await api.getDiscoverySession(sessionId);
        setActiveSession(session);

        if (['completed', 'failed', 'cancelled'].includes(session.status)) {
          clearInterval(pollRef.current);
          pollRef.current = null;
          if (session.status === 'completed') {
            setView('results');
          } else if (session.status === 'failed') {
            setError('Discovery failed. Please try again.');
            setView('input');
          }
          loadSessions(); // refresh list
        }
      } catch (err) {
        logError('Polling failed', { component: 'Discovery', errorName: err?.name, errorStack: err?.stack });
      }
    }, 3000);
  };

  const handleStart = async (data) => {
    setStarting(true);
    setError(null);
    try {
      const result = await api.startDiscovery(data);
      const sessionId = result.sessionId;
      setActiveSessionId(sessionId);
      setActiveSession({ id: sessionId, status: 'pending', ...data });
      setView('progress');
      startPolling(sessionId);
    } catch (err) {
      setError(err.message || 'Failed to start discovery');
    }
    setStarting(false);
  };

  const handleCancel = async () => {
    if (!activeSessionId) return;
    try {
      await api.cancelDiscovery(activeSessionId);
      if (pollRef.current) clearInterval(pollRef.current);
      setView('input');
      setActiveSession(null);
      setActiveSessionId(null);
      loadSessions();
    } catch (err) {
      logError('Failed to cancel', { component: 'Discovery', errorName: err?.name, errorStack: err?.stack });
    }
  };

  const handleNewSearch = () => {
    setView('input');
    setActiveSession(null);
    setActiveSessionId(null);
  };

  const handleSelectSession = (session) => {
    setActiveSessionId(session.id);
    setActiveSession(session);
    if (['pending', 'searching', 'scoring', 'queuing'].includes(session.status)) {
      setView('progress');
      startPolling(session.id);
    } else if (session.status === 'completed') {
      setView('results');
    } else {
      setView('input');
    }
  };

  return (
    <div className="p-6 max-w-5xl mx-auto">
      {/* Page header */}
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-3">
          <Search className="w-6 h-6 text-[#ff4500]" />
          <h1 className="text-2xl font-bold text-white">Discovery</h1>
        </div>
        {view !== 'history' && (
          <button
            onClick={() => setView('history')}
            className="flex items-center gap-1.5 text-sm text-[#71717a] hover:text-[#a1a1aa]"
          >
            <History className="w-4 h-4" />
            Past Sessions
          </button>
        )}
      </div>

      {/* Error banner */}
      {error && (
        <div className="mb-4 flex items-center gap-2 p-3 bg-red-500/10 border border-red-500/20 rounded-lg text-red-400 text-sm">
          <AlertTriangle className="w-4 h-4 flex-shrink-0" />
          {error}
          <button onClick={() => setError(null)} className="ml-auto">
            <X className="w-4 h-4" />
          </button>
        </div>
      )}

      {/* Mode tabs (shown on input view) */}
      {view === 'input' && (<>
        <div className="flex gap-2 mb-5 max-w-2xl mx-auto">
          <button
            onClick={() => setInputMode('discovery')}
            className={`flex items-center gap-1.5 px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
              inputMode === 'discovery'
                ? 'bg-[#ff4500] text-white'
                : 'bg-[#1e1e24] text-[#a1a1aa] hover:bg-[#23232a]'
            }`}
          >
            <Search className="w-4 h-4" />
            Smart Search
          </button>
          <button
            onClick={() => setInputMode('automation')}
            className={`flex items-center gap-1.5 px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
              inputMode === 'automation'
                ? 'bg-[#ff4500] text-white'
                : 'bg-[#1e1e24] text-[#a1a1aa] hover:bg-[#23232a]'
            }`}
          >
            <Zap className="w-4 h-4" />
            Subreddit Autopilot
          </button>
          <button
            onClick={() => setInputMode('watch')}
            className={`flex items-center gap-1.5 px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
              inputMode === 'watch'
                ? 'bg-[#ff4500] text-white'
                : 'bg-[#1e1e24] text-[#a1a1aa] hover:bg-[#23232a]'
            }`}
          >
            <Radar className="w-4 h-4" />
            Subreddit Monitor
          </button>
        </div>
        <p className="text-xs text-[#a1a1aa] text-center mb-4 max-w-2xl mx-auto">
          {inputMode === 'discovery' && 'Describe your business and let AI find leads across all of Reddit'}
          {inputMode === 'automation' && 'Auto-scan specific subreddits, filter by quality, and send messages on autopilot'}
          {inputMode === 'watch' && 'Track subreddits for new posts and get notified when relevant leads appear'}
        </p>
      </>)}

      {/* Views */}
      {view === 'input' && inputMode === 'discovery' && (
        <DiscoveryInput onStart={handleStart} loading={starting} />
      )}

      {view === 'input' && inputMode === 'automation' && (
        <AutomationInput onStart={handleStart} loading={starting} />
      )}

      {view === 'input' && inputMode === 'watch' && (
        <WatchList />
      )}

      {view === 'progress' && activeSession && (
        <DiscoveryProgress session={activeSession} onCancel={handleCancel} />
      )}

      {view === 'results' && activeSession && (
        <>
          {activeSession.mode === 'automation' && (
            <AutomationSendControls sessionId={activeSessionId} />
          )}
          <DiscoveryResults
            session={activeSession}
            sessionId={activeSessionId}
            onNewSearch={handleNewSearch}
          />
        </>
      )}

      {view === 'history' && (
        <SessionHistory
          sessions={sessions}
          onSelect={handleSelectSession}
          onBack={() => setView(activeSession?.status === 'completed' ? 'results' : 'input')}
        />
      )}
    </div>
  );
}
