import { useState, useEffect, useCallback, useRef } from 'react';
import { Search, RefreshCw, X, ChevronDown, ChevronUp, MessageSquare, Send, ExternalLink, Clock, Users, TrendingUp, AlertTriangle, Flame, Thermometer, Snowflake, History, Play, Square, Zap, Wifi, WifiOff } from 'lucide-react';
import * as api from '../api/client';

// ============================================================================
// Tier badge component
// ============================================================================
function TierBadge({ tier }) {
  const config = {
    hot: { bg: 'bg-red-100 text-red-800', icon: Flame, label: 'HOT' },
    warm: { bg: 'bg-orange-100 text-orange-800', icon: Thermometer, label: 'WARM' },
    cold: { bg: 'bg-blue-100 text-blue-800', icon: Snowflake, label: 'COLD' },
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
function LeadCard({ lead, onQueue, onDismiss, onGenerateMessage, accounts, sessionId }) {
  const [expanded, setExpanded] = useState(false);
  const [message, setMessage] = useState(lead.generated_message || '');
  const [reasoning, setReasoning] = useState(lead.message_reasoning || '');
  const [showReasoning, setShowReasoning] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [queueing, setQueueing] = useState(false);
  const [selectedAccount, setSelectedAccount] = useState(accounts[0]?.id || '');

  const scoreColor = lead.lead_score >= 70
    ? 'text-green-600'
    : lead.lead_score >= 45
    ? 'text-yellow-600'
    : 'text-red-600';

  const timeAgo = lead.post_created_utc
    ? formatTimeAgo(lead.post_created_utc)
    : '';

  const handleGenerate = async () => {
    setGenerating(true);
    try {
      const result = await api.generateLeadMessage(sessionId, lead.id);
      if (result?.message) {
        setMessage(result.message);
        if (result.reasoning) {
          setReasoning(result.reasoning);
          setShowReasoning(true);
        }
      }
    } catch (err) {
      console.error('Failed to generate message:', err);
    }
    setGenerating(false);
  };

  const handleQueue = async () => {
    if (!selectedAccount) return;
    setQueueing(true);
    try {
      await api.queueLead(sessionId, lead.id, {
        accountId: selectedAccount,
        editedMessage: message || undefined,
      });
      onQueue(lead.id);
    } catch (err) {
      console.error('Failed to queue lead:', err);
    }
    setQueueing(false);
  };

  return (
    <div className={`bg-white rounded-lg shadow-sm border overflow-hidden ${
      lead.status === 'queued' ? 'border-green-200 opacity-60' :
      lead.status === 'dismissed' ? 'border-gray-200 opacity-40' :
      lead.status === 'already_contacted' ? 'border-yellow-200 opacity-60' :
      'border-gray-100'
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
                className="font-semibold text-blue-600 hover:underline"
              >
                u/{lead.author_username}
              </a>
              <span className="text-gray-400">in</span>
              <span className="text-gray-600 text-sm">r/{lead.subreddit}</span>
              {timeAgo && <span className="text-gray-400 text-xs">{timeAgo}</span>}
              {lead.source_type === 'comment' && (
                <span className="px-2 py-0.5 rounded-full text-xs font-medium bg-purple-100 text-purple-800">
                  Comment
                </span>
              )}
              {lead.status === 'queued' && (
                <span className="px-2 py-0.5 rounded-full text-xs font-medium bg-green-100 text-green-800">Queued</span>
              )}
              {lead.status === 'already_contacted' && (
                <span className="px-2 py-0.5 rounded-full text-xs font-medium bg-yellow-100 text-yellow-800">Already Contacted</span>
              )}
              {lead.status === 'dismissed' && (
                <span className="px-2 py-0.5 rounded-full text-xs font-medium bg-gray-100 text-gray-800">Dismissed</span>
              )}
            </div>

            <p className="text-sm text-gray-700 mt-1 line-clamp-2">
              {lead.post_title}
            </p>

            {lead.source_type === 'comment' && lead.source_comment_body && (
              <p className="text-xs text-gray-500 mt-1 italic line-clamp-2">
                "{lead.source_comment_body}"
              </p>
            )}

            {/* Score breakdown chips */}
            <div className="flex gap-2 mt-2 flex-wrap">
              {lead.relevance_score != null && (
                <span className="text-xs px-1.5 py-0.5 rounded bg-gray-100 text-gray-600">
                  Relevance: {lead.relevance_score}
                </span>
              )}
              {lead.buyer_intent != null && (
                <span className="text-xs px-1.5 py-0.5 rounded bg-gray-100 text-gray-600">
                  Intent: {lead.buyer_intent}
                </span>
              )}
              {lead.is_qualified && (
                <span className="text-xs px-1.5 py-0.5 rounded bg-green-50 text-green-700">
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
                className="p-1.5 rounded hover:bg-gray-100 text-gray-400 hover:text-gray-600"
                title="View post"
              >
                <ExternalLink className="w-4 h-4" />
              </a>
            )}
            <button
              onClick={() => setExpanded(!expanded)}
              className="p-1.5 rounded hover:bg-gray-100 text-gray-400"
            >
              {expanded ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
            </button>
          </div>
        </div>
      </div>

      {/* Expanded detail */}
      {expanded && (
        <div className="border-t border-gray-100 bg-gray-50 p-4 space-y-4">
          {/* Post body */}
          {lead.post_body && (
            <div>
              <h4 className="text-xs font-semibold text-gray-500 uppercase mb-1">Post Content</h4>
              <p className="text-sm text-gray-700 whitespace-pre-wrap max-h-40 overflow-y-auto">
                {lead.post_body.slice(0, 1000)}
                {lead.post_body.length > 1000 && '...'}
              </p>
            </div>
          )}

          {/* Insights */}
          {lead.lead_insights && lead.lead_insights.length > 0 && (
            <div>
              <h4 className="text-xs font-semibold text-gray-500 uppercase mb-1">Insights</h4>
              <div className="space-y-1">
                {lead.lead_insights.map((insight, i) => (
                  <div key={i} className={`text-xs px-2 py-1 rounded ${
                    insight.type === 'strength' ? 'bg-green-50 text-green-700' :
                    insight.type === 'concern' ? 'bg-red-50 text-red-700' :
                    'bg-blue-50 text-blue-700'
                  }`}>
                    {insight.message}
                  </div>
                ))}
              </div>
            </div>
          )}

          {lead.classification_reasoning && (
            <p className="text-xs text-gray-500 italic">
              {lead.classification_reasoning}
            </p>
          )}

          {/* Message generation & queue */}
          {lead.status === 'scored' && (
            <div className="space-y-3 pt-2 border-t border-gray-200">
              <div>
                <div className="flex items-center justify-between mb-1">
                  <h4 className="text-xs font-semibold text-gray-500 uppercase">Outreach Message</h4>
                  <button
                    onClick={handleGenerate}
                    disabled={generating}
                    className="text-xs text-blue-600 hover:text-blue-800 disabled:opacity-50"
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
                      className="w-full text-sm border border-gray-200 rounded-lg p-2 focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                    />
                    {reasoning && (
                      <div className="mt-1">
                        <button
                          onClick={() => setShowReasoning(!showReasoning)}
                          className="text-xs text-gray-400 hover:text-gray-600 flex items-center gap-1"
                        >
                          {showReasoning ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
                          {showReasoning ? 'Hide reasoning' : 'Show reasoning'}
                        </button>
                        {showReasoning && (
                          <p className="mt-1 text-xs text-gray-500 bg-gray-100 rounded p-2 italic">
                            {reasoning}
                          </p>
                        )}
                      </div>
                    )}
                  </>
                ) : (
                  <p className="text-xs text-gray-400">Click "Generate" to create an outreach message</p>
                )}
              </div>

              <div className="flex items-center gap-3">
                {accounts.length > 0 && (
                  <select
                    value={selectedAccount}
                    onChange={(e) => setSelectedAccount(e.target.value)}
                    className="text-sm border border-gray-200 rounded-lg px-2 py-1.5"
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
                  className="px-3 py-1.5 text-sm text-gray-500 hover:text-red-600 hover:bg-red-50 rounded-lg"
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
function DiscoveryInput({ onStart, loading }) {
  const [businessDesc, setBusinessDesc] = useState('');
  const [persona, setPersona] = useState('');
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
      console.error('Failed to load settings:', err);
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
    onStart({ businessDesc, persona });
  };

  return (
    <form onSubmit={handleSubmit} className="bg-white rounded-lg shadow-sm border border-gray-100 p-6 max-w-2xl mx-auto">
      <div className="space-y-5">
        <div>
          <div className="flex items-center justify-between mb-1">
            <label className="block text-sm font-medium text-gray-700">
              Business Context
            </label>
            <button
              type="button"
              onClick={prefillFromSettings}
              disabled={prefilling}
              className="text-xs text-blue-600 hover:text-blue-800"
            >
              {prefilling ? 'Loading...' : 'Load from Settings'}
            </button>
          </div>
          <textarea
            value={businessDesc}
            onChange={(e) => setBusinessDesc(e.target.value)}
            placeholder="Describe your business and the problem you solve. Be specific about your product, target market, and unique value..."
            rows={4}
            className="w-full border border-gray-200 rounded-lg p-3 text-sm focus:ring-2 focus:ring-[#ff4500] focus:border-transparent"
            required
          />
        </div>

        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">
            Target Persona
          </label>
          <textarea
            value={persona}
            onChange={(e) => setPersona(e.target.value)}
            placeholder="Who are your ideal customers? What roles, industries, company sizes?"
            rows={2}
            className="w-full border border-gray-200 rounded-lg p-3 text-sm focus:ring-2 focus:ring-[#ff4500] focus:border-transparent"
          />
        </div>

        <button
          type="submit"
          disabled={loading || !businessDesc.trim()}
          className="w-full flex items-center justify-center gap-2 px-6 py-3 bg-[#ff4500] text-white font-semibold rounded-lg hover:bg-[#e63e00] disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
        >
          <Search className="w-5 h-5" />
          {loading ? 'Starting...' : 'Start Discovery'}
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
    onStart({
      mode: 'automation',
      targetSubreddits: list,
      accountId: selectedAccount,
      autoQueue: true,
      autoApprove,
      minLeadScore: minScore,
    });
  };

  return (
    <form onSubmit={handleSubmit} className="bg-white rounded-lg shadow-sm border border-gray-100 p-6 max-w-2xl mx-auto">
      <div className="space-y-5">
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">
            Target Subreddits
          </label>
          <input
            type="text"
            value={subreddits}
            onChange={(e) => setSubreddits(e.target.value)}
            placeholder="saas, startups, smallbusiness (comma-separated)"
            className="w-full border border-gray-200 rounded-lg p-3 text-sm focus:ring-2 focus:ring-[#ff4500] focus:border-transparent"
            required
          />
          <p className="text-xs text-gray-400 mt-1">Enter subreddit names without r/ prefix, separated by commas</p>
        </div>

        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">
            Send From Account
          </label>
          {loadingAccounts ? (
            <div className="text-sm text-gray-400">Loading accounts...</div>
          ) : accounts.length === 0 ? (
            <div className="text-sm text-red-500">No active accounts. Add one in the Accounts page first.</div>
          ) : (
            <select
              value={selectedAccount}
              onChange={(e) => setSelectedAccount(e.target.value)}
              className="w-full border border-gray-200 rounded-lg p-3 text-sm focus:ring-2 focus:ring-[#ff4500] focus:border-transparent"
            >
              {accounts.map(acc => (
                <option key={acc.id} value={acc.id}>u/{acc.username}</option>
              ))}
            </select>
          )}
        </div>

        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">
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
          <div className="flex justify-between text-xs text-gray-400">
            <span>More leads (lower quality)</span>
            <span>Fewer leads (higher quality)</span>
          </div>
        </div>

        <div className="flex items-center gap-3 p-3 bg-gray-50 rounded-lg">
          <input
            type="checkbox"
            id="autoApprove"
            checked={autoApprove}
            onChange={(e) => setAutoApprove(e.target.checked)}
            className="w-4 h-4 rounded border-gray-300 text-[#ff4500] focus:ring-[#ff4500]"
          />
          <div>
            <label htmlFor="autoApprove" className="text-sm font-medium text-gray-700 cursor-pointer">
              Auto-approve messages
            </label>
            <p className="text-xs text-gray-400">
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
          {loading ? 'Starting...' : 'Start Automation'}
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
      console.error('Failed to load automation stats:', err);
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
    <div className="bg-white rounded-lg shadow-sm border border-gray-100 p-5 mt-4">
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-sm font-semibold text-gray-700 uppercase tracking-wider">Sending Progress</h3>
        {extensionAvailable === false && (
          <div className="flex items-center gap-1.5 text-xs text-red-500">
            <WifiOff className="w-3.5 h-3.5" />
            Extension not detected
          </div>
        )}
        {extensionAvailable === true && (
          <div className="flex items-center gap-1.5 text-xs text-green-600">
            <Wifi className="w-3.5 h-3.5" />
            Extension connected
          </div>
        )}
      </div>

      {/* Progress bar */}
      {total > 0 && (
        <div className="w-full bg-gray-200 rounded-full h-2.5 mb-4">
          <div
            className="bg-green-500 h-2.5 rounded-full transition-all duration-500"
            style={{ width: `${progress}%` }}
          />
        </div>
      )}

      {/* Stats grid */}
      <div className="grid grid-cols-5 gap-2 mb-4">
        <div className="text-center p-2 bg-gray-50 rounded">
          <div className="text-lg font-bold text-gray-800">{total}</div>
          <div className="text-xs text-gray-500">Queued</div>
        </div>
        <div className="text-center p-2 bg-yellow-50 rounded">
          <div className="text-lg font-bold text-yellow-600">{pending}</div>
          <div className="text-xs text-gray-500">Pending</div>
        </div>
        <div className="text-center p-2 bg-blue-50 rounded">
          <div className="text-lg font-bold text-blue-600">{approved}</div>
          <div className="text-xs text-gray-500">Approved</div>
        </div>
        <div className="text-center p-2 bg-green-50 rounded">
          <div className="text-lg font-bold text-green-600">{sent}</div>
          <div className="text-xs text-gray-500">Sent</div>
        </div>
        <div className="text-center p-2 bg-red-50 rounded">
          <div className="text-lg font-bold text-red-600">{failed}</div>
          <div className="text-xs text-gray-500">Failed</div>
        </div>
      </div>

      {/* Send controls */}
      {extensionAvailable === false ? (
        <div className="p-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700">
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
        <p className="text-sm text-gray-500 text-center">
          {pending} items pending review. Go to the <a href="/queue" className="text-blue-600 hover:underline">Queue</a> to approve them.
        </p>
      ) : sent === total && total > 0 ? (
        <p className="text-sm text-green-600 text-center font-medium">All messages sent!</p>
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
    <div className="bg-white rounded-lg shadow-sm border border-gray-100 p-6 max-w-2xl mx-auto">
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-lg font-semibold text-gray-800">
          {statusLabels[session.status] || session.status}
        </h3>
        <button
          onClick={onCancel}
          className="text-sm text-red-500 hover:text-red-700"
        >
          Cancel
        </button>
      </div>

      {/* Progress bar */}
      <div className="w-full bg-gray-200 rounded-full h-3 mb-4">
        <div
          className="bg-[#ff4500] h-3 rounded-full transition-all duration-500"
          style={{ width: `${pct}%` }}
        />
      </div>

      {/* Stats */}
      <div className={`grid ${session.mode === 'automation' ? 'grid-cols-4' : 'grid-cols-3'} gap-4 text-center`}>
        <div className="bg-gray-50 rounded-lg p-3">
          <div className="text-xl font-bold text-gray-800">
            {session.total_posts_found || 0}
          </div>
          <div className="text-xs text-gray-500">Posts Found</div>
        </div>
        <div className="bg-gray-50 rounded-lg p-3">
          <div className="text-xl font-bold text-gray-800">
            {session.total_leads_scored || 0}
          </div>
          <div className="text-xs text-gray-500">Posts Scored</div>
        </div>
        <div className="bg-gray-50 rounded-lg p-3">
          <div className="text-xl font-bold text-[#ff4500]">
            {session.leads_qualified || 0}
          </div>
          <div className="text-xs text-gray-500">Leads Found</div>
        </div>
        {session.mode === 'automation' && (
          <div className="bg-gray-50 rounded-lg p-3">
            <div className="text-xl font-bold text-green-600">
              {session.leads_queued || 0}
            </div>
            <div className="text-xs text-gray-500">Queued</div>
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
  const [subreddits, setSubreddits] = useState([]);

  useEffect(() => {
    loadData();
  }, [sessionId, tierFilter, subredditFilter]);

  const loadData = async () => {
    setLoading(true);
    try {
      const filters = {};
      if (tierFilter !== 'all') filters.tier = tierFilter;
      if (subredditFilter !== 'all') filters.subreddit = subredditFilter;
      filters.limit = 100;

      const [leadsData, accountsData, subredditsData] = await Promise.all([
        api.getDiscoveryLeads(sessionId, filters),
        api.getAccountsSummary().catch(() => []),
        api.getDiscoverySubreddits(sessionId).catch(() => []),
      ]);

      setLeads(leadsData || []);
      setAccounts(accountsData || []);
      setSubreddits(subredditsData || []);
    } catch (err) {
      console.error('Failed to load discovery results:', err);
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
      console.error('Failed to dismiss lead:', err);
    }
  };

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
        <div>
          <h2 className="text-lg font-semibold text-gray-800">
            Discovery Results
          </h2>
          <p className="text-sm text-gray-500">
            {session.leads_qualified || 0} leads found across {subreddits.length} subreddits
          </p>
        </div>
        <button
          onClick={onNewSearch}
          className="flex items-center gap-2 px-4 py-2 bg-[#ff4500] text-white text-sm font-medium rounded-lg hover:bg-[#e63e00]"
        >
          <Search className="w-4 h-4" />
          New Search
        </button>
      </div>

      {/* Tier summary */}
      <div className="grid grid-cols-3 gap-3 mb-4">
        <button
          onClick={() => setTierFilter(tierFilter === 'hot' ? 'all' : 'hot')}
          className={`p-3 rounded-lg border text-center transition-colors ${
            tierFilter === 'hot' ? 'border-red-300 bg-red-50' : 'border-gray-100 bg-white hover:border-red-200'
          }`}
        >
          <div className="flex items-center justify-center gap-1 mb-1">
            <Flame className="w-4 h-4 text-red-500" />
            <span className="text-sm font-medium text-gray-600">Hot</span>
          </div>
          <div className="text-2xl font-bold text-red-600">{tierCounts.hot}</div>
        </button>
        <button
          onClick={() => setTierFilter(tierFilter === 'warm' ? 'all' : 'warm')}
          className={`p-3 rounded-lg border text-center transition-colors ${
            tierFilter === 'warm' ? 'border-orange-300 bg-orange-50' : 'border-gray-100 bg-white hover:border-orange-200'
          }`}
        >
          <div className="flex items-center justify-center gap-1 mb-1">
            <Thermometer className="w-4 h-4 text-orange-500" />
            <span className="text-sm font-medium text-gray-600">Warm</span>
          </div>
          <div className="text-2xl font-bold text-orange-600">{tierCounts.warm}</div>
        </button>
        <button
          onClick={() => setTierFilter(tierFilter === 'cold' ? 'all' : 'cold')}
          className={`p-3 rounded-lg border text-center transition-colors ${
            tierFilter === 'cold' ? 'border-blue-300 bg-blue-50' : 'border-gray-100 bg-white hover:border-blue-200'
          }`}
        >
          <div className="flex items-center justify-center gap-1 mb-1">
            <Snowflake className="w-4 h-4 text-blue-500" />
            <span className="text-sm font-medium text-gray-600">Cold</span>
          </div>
          <div className="text-2xl font-bold text-blue-600">{tierCounts.cold}</div>
        </button>
      </div>

      {/* Subreddit filter */}
      {subreddits.length > 1 && (
        <div className="mb-4">
          <select
            value={subredditFilter}
            onChange={(e) => setSubredditFilter(e.target.value)}
            className="text-sm border border-gray-200 rounded-lg px-3 py-1.5"
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
        <div className="text-center py-12 text-gray-400">
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
        <h2 className="text-lg font-semibold text-gray-800">Past Sessions</h2>
        <button
          onClick={onBack}
          className="text-sm text-blue-600 hover:text-blue-800"
        >
          Back
        </button>
      </div>

      {sessions.length === 0 ? (
        <div className="text-center py-12 text-gray-400">
          No previous discovery sessions
        </div>
      ) : (
        <div className="space-y-2">
          {sessions.map(session => (
            <button
              key={session.id}
              onClick={() => onSelect(session)}
              className="w-full text-left bg-white rounded-lg shadow-sm border border-gray-100 p-4 hover:border-[#ff4500] transition-colors"
            >
              <div className="flex items-center justify-between">
                <div>
                  <div className="text-sm font-medium text-gray-800">
                    {new Date(session.created_at).toLocaleDateString('en-US', {
                      month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit'
                    })}
                  </div>
                  <div className="text-xs text-gray-500 mt-0.5">
                    {session.business_desc?.slice(0, 80)}
                    {session.business_desc?.length > 80 ? '...' : ''}
                  </div>
                </div>
                <div className="text-right">
                  <div className="flex items-center gap-1.5 justify-end">
                    {session.mode === 'automation' && (
                      <span className="px-2 py-0.5 rounded-full text-xs font-medium bg-purple-100 text-purple-800">
                        Auto
                      </span>
                    )}
                    <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${
                      session.status === 'completed' ? 'bg-green-100 text-green-800' :
                      session.status === 'failed' ? 'bg-red-100 text-red-800' :
                      session.status === 'cancelled' ? 'bg-gray-100 text-gray-800' :
                      'bg-yellow-100 text-yellow-800'
                    }`}>
                      {session.status}
                    </span>
                  </div>
                  <div className="text-xs text-gray-500 mt-1">
                    {session.leads_qualified || 0} leads
                    {session.leads_queued > 0 && ` / ${session.leads_queued} queued`}
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
// Helper
// ============================================================================
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
  const [inputMode, setInputMode] = useState('discovery'); // discovery | automation
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
      console.error('Failed to load sessions:', err);
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
        console.error('Polling failed:', err);
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
      console.error('Failed to cancel:', err);
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
          <h1 className="text-2xl font-bold text-gray-800">Discovery</h1>
        </div>
        {view !== 'history' && (
          <button
            onClick={() => setView('history')}
            className="flex items-center gap-1.5 text-sm text-gray-500 hover:text-gray-700"
          >
            <History className="w-4 h-4" />
            Past Sessions
          </button>
        )}
      </div>

      {/* Error banner */}
      {error && (
        <div className="mb-4 flex items-center gap-2 p-3 bg-red-50 border border-red-200 rounded-lg text-red-700 text-sm">
          <AlertTriangle className="w-4 h-4 flex-shrink-0" />
          {error}
          <button onClick={() => setError(null)} className="ml-auto">
            <X className="w-4 h-4" />
          </button>
        </div>
      )}

      {/* Mode tabs (shown on input view) */}
      {view === 'input' && (
        <div className="flex gap-2 mb-5 max-w-2xl mx-auto">
          <button
            onClick={() => setInputMode('discovery')}
            className={`flex items-center gap-1.5 px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
              inputMode === 'discovery'
                ? 'bg-[#ff4500] text-white'
                : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
            }`}
          >
            <Search className="w-4 h-4" />
            Discovery
          </button>
          <button
            onClick={() => setInputMode('automation')}
            className={`flex items-center gap-1.5 px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
              inputMode === 'automation'
                ? 'bg-[#ff4500] text-white'
                : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
            }`}
          >
            <Zap className="w-4 h-4" />
            Automation
          </button>
        </div>
      )}

      {/* Views */}
      {view === 'input' && inputMode === 'discovery' && (
        <DiscoveryInput onStart={handleStart} loading={starting} />
      )}

      {view === 'input' && inputMode === 'automation' && (
        <AutomationInput onStart={handleStart} loading={starting} />
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
