import { useState, useEffect, useRef } from 'react';
import { MessageSquare, RefreshCw, Sparkles, Tag, ChevronRight, Send, Clock, Edit3, Check, Wand2 } from 'lucide-react';
import * as api from '../api/client';
import { logError } from '../lib/logger';

const STATUS_OPTIONS = ['active', 'interested', 'cold', 'closed', 'converted'];

const STATUS_COLORS = {
  active: 'bg-blue-500/15 text-blue-400',
  interested: 'bg-green-500/15 text-green-400',
  cold: 'bg-[#1e1e24] text-[#a1a1aa]',
  closed: 'bg-[#23232a] text-[#71717a]',
  converted: 'bg-purple-500/15 text-purple-400'
};

function ConversationList({ conversations, selected, onSelect }) {
  return (
    <div className="divide-y divide-[#23232a]">
      {conversations.map(conv => (
        <button
          key={conv.id}
          onClick={() => onSelect(conv)}
          className={`w-full p-4 text-left hover:bg-[#1e1e24] transition-colors ${
            selected?.id === conv.id ? 'bg-[#1e1e24]' : ''
          }`}
        >
          <div className="flex items-center justify-between">
            <span className="font-semibold text-white">
              u/{conv.participantUsername}
            </span>
            <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${STATUS_COLORS[conv.status]}`}>
              {conv.status}
            </span>
          </div>
          <div className="flex items-center gap-2 mt-1 text-sm text-[#71717a]">
            <span>{conv.totalMessages} messages</span>
            {conv.hasReply && (
              <span className="text-green-400">Has reply</span>
            )}
          </div>
          <div className="mt-1">
            {conv.accountUsername ? (
              <span className="inline-flex items-center px-1.5 py-0.5 rounded text-xs font-medium bg-indigo-500/15 text-indigo-400 border border-indigo-500/20">
                u/{conv.accountUsername}
              </span>
            ) : (
              <span className="inline-flex items-center px-1.5 py-0.5 rounded text-xs font-medium bg-red-500/15 text-red-400 border border-red-500/20">
                No account
              </span>
            )}
          </div>
          {conv.sourceSubreddit && (
            <p className="text-xs text-[#71717a] mt-1 truncate">
              r/{conv.sourceSubreddit}
              {conv.sourcePostTitle && (
                <span className="text-[#52525b]"> &middot; {conv.sourcePostTitle}</span>
              )}
            </p>
          )}
          {conv.lastMessageAt && (
            <p className="text-xs text-[#52525b] mt-1">
              Last: {new Date(conv.lastMessageAt).toLocaleDateString()}
            </p>
          )}
        </button>
      ))}
    </div>
  );
}

function ConversationDetail({ conversation, onUpdate, onStatusChange, accounts = [] }) {
  const [messages, setMessages] = useState([]);
  const [suggestion, setSuggestion] = useState('');
  const [loading, setLoading] = useState(false);
  const [generatingSuggestion, setGeneratingSuggestion] = useState(false);
  const [replyText, setReplyText] = useState('');
  const [isQueueing, setIsQueueing] = useState(false);
  const [queuedReply, setQueuedReply] = useState(null);
  const [toast, setToast] = useState(null);
  const [improvementInstructions, setImprovementInstructions] = useState('');
  const [improvingSuggestion, setImprovingSuggestion] = useState(false);

  const conversationIdRef = useRef(conversation?.id);

  useEffect(() => {
    conversationIdRef.current = conversation?.id;

    // Reset AI and reply state when switching conversations
    setSuggestion('');
    setReplyText('');
    setImprovementInstructions('');
    setGeneratingSuggestion(false);
    setImprovingSuggestion(false);

    if (conversation) {
      loadConversation(true);
      checkQueuedReply();

      const interval = setInterval(() => {
        loadConversation();
        checkQueuedReply();
      }, 10000);

      return () => clearInterval(interval);
    }
  }, [conversation?.id]);

  const loadConversation = async (showSpinner = false) => {
    if (!conversation) return;
    if (showSpinner) setLoading(true);
    try {
      const data = await api.getConversation(conversation.id);
      setMessages(data.messages || []);
    } catch (err) {
      logError('Failed to load conversation', { component: 'ConversationDetail', errorName: err?.name, errorStack: err?.stack });
    } finally {
      if (showSpinner) setLoading(false);
    }
  };

  const checkQueuedReply = async () => {
    if (!conversation) return;
    try {
      const pending = await api.getPendingReplyForConversation(conversation.id);
      setQueuedReply(pending);
    } catch (err) {
      logError('Failed to check queued reply', { component: 'ConversationDetail', errorName: err?.name, errorStack: err?.stack });
    }
  };

  const generateSuggestion = async () => {
    const targetId = conversation.id;
    setGeneratingSuggestion(true);
    try {
      const reply = await api.getReplySuggestion(targetId);
      if (conversationIdRef.current !== targetId) return;
      setSuggestion(reply);
    } catch (err) {
      if (conversationIdRef.current !== targetId) return;
      logError('Failed to generate suggestion', { component: 'ConversationDetail', errorName: err?.name, errorStack: err?.stack });
    } finally {
      if (conversationIdRef.current === targetId) {
        setGeneratingSuggestion(false);
      }
    }
  };

  const handleImproveSuggestion = async () => {
    if (!improvementInstructions.trim()) return;
    const targetId = conversation.id;
    setImprovingSuggestion(true);
    try {
      const currentText = replyText || suggestion;
      const improved = await api.improveSuggestion(
        targetId,
        currentText,
        improvementInstructions.trim()
      );
      if (conversationIdRef.current !== targetId) return;
      setSuggestion(improved);
      if (replyText) {
        setReplyText(improved);
      }
      setImprovementInstructions('');
    } catch (err) {
      if (conversationIdRef.current !== targetId) return;
      logError('Failed to improve suggestion', { component: 'ConversationDetail', errorName: err?.name, errorStack: err?.stack });
    } finally {
      if (conversationIdRef.current === targetId) {
        setImprovingSuggestion(false);
      }
    }
  };

  const assignAccount = async (accountId) => {
    try {
      await api.updateConversation(conversation.id, { accountId: accountId || null });
      onUpdate();
    } catch (err) {
      logError('Failed to assign account', { component: 'ConversationDetail', errorName: err?.name, errorStack: err?.stack });
    }
  };

  const updateStatus = async (newStatus) => {
    try {
      await api.updateConversation(conversation.id, { status: newStatus });
      onStatusChange(conversation.id, newStatus);
    } catch (err) {
      logError('Failed to update status', { component: 'ConversationDetail', errorName: err?.name, errorStack: err?.stack });
    }
  };

  const showToast = (message, type = 'success') => {
    setToast({ message, type });
    setTimeout(() => setToast(null), 3000);
  };

  const handleAddToQueue = async (autoApprove = false) => {
    if (!replyText.trim()) {
      showToast('Please enter a reply message', 'error');
      return;
    }
    setIsQueueing(true);
    try {
      const queueItem = await api.addReplyToQueue({
        conversationId: conversation.id,
        recipientUsername: conversation.participantUsername,
        generatedMessage: suggestion || replyText,
        editedMessage: replyText !== suggestion ? replyText : null,
        status: autoApprove ? 'approved' : 'pending',
        accountId: conversation.accountId || null
      });

      if (autoApprove) {
        // "Send Now": open Reddit profile tab so the extension sends the message
        api.triggerExtensionSend(
          conversation.participantUsername,
          replyText,
          queueItem?.id || null,
          conversation.id,
          conversation.accountId || null
        );
        showToast('Opening Reddit to send reply... Make sure the extension is installed.');
      } else {
        showToast('Reply added to queue. Approve it in the Queue page, then click Send.');
      }

      setReplyText('');
      setSuggestion('');
      await checkQueuedReply();
    } catch (err) {
      logError('Failed to add to queue', { component: 'ConversationDetail', errorName: err?.name, errorStack: err?.stack });
      showToast('Failed to add to queue', 'error');
    } finally {
      setIsQueueing(false);
    }
  };

  const useSuggestion = () => {
    if (suggestion) {
      setReplyText(suggestion);
    }
  };

  if (!conversation) {
    return (
      <div className="flex items-center justify-center h-full text-[#52525b]">
        <p>Select a conversation to view</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      {/* Toast */}
      {toast && (
        <div className={`absolute top-4 right-4 px-4 py-2 rounded-lg text-sm font-medium z-50 ${
          toast.type === 'error' ? 'bg-red-500/15 text-red-400' : 'bg-green-500/15 text-green-400'
        }`}>
          {toast.message}
        </div>
      )}

      {/* Header */}
      <div className="p-4 border-b border-[#23232a]">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-lg font-semibold text-white">u/{conversation.participantUsername}</h2>
            <div className="flex items-center gap-2 mt-0.5">
              <span className="text-sm text-[#71717a]">{messages.length || conversation.totalMessages} messages</span>
              <select
                value={conversation.accountId || ''}
                onChange={(e) => assignAccount(e.target.value)}
                className={`px-2 py-0.5 rounded text-xs font-medium border ${
                  conversation.accountId
                    ? 'bg-indigo-500/15 text-indigo-400 border-indigo-500/20'
                    : 'bg-red-500/15 text-red-400 border-red-500/20'
                }`}
              >
                <option value="">No account</option>
                {accounts.map(a => (
                  <option key={a.id} value={a.id}>u/{a.username}</option>
                ))}
              </select>
            </div>
            {conversation.sourceSubreddit && (
              <div className="flex items-center gap-1.5 mt-1 text-sm text-[#71717a]">
                <span className="font-medium text-[#ff4500]">r/{conversation.sourceSubreddit}</span>
                {conversation.sourcePostTitle && (
                  conversation.sourcePostUrl ? (
                    <a
                      href={conversation.sourcePostUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-[#4d9fff] hover:underline truncate max-w-md"
                      title={conversation.sourcePostTitle}
                    >
                      {conversation.sourcePostTitle}
                    </a>
                  ) : (
                    <span className="text-[#52525b] truncate max-w-md">{conversation.sourcePostTitle}</span>
                  )
                )}
              </div>
            )}
          </div>
          <select
            value={conversation.status}
            onChange={(e) => updateStatus(e.target.value)}
            className="px-3 py-1 bg-[#1e1e24] border border-[#23232a] text-white rounded-lg text-sm"
          >
            {STATUS_OPTIONS.map(status => (
              <option key={status} value={status}>
                {status.charAt(0).toUpperCase() + status.slice(1)}
              </option>
            ))}
          </select>
        </div>
      </div>

      {/* Messages */}
      <div className="flex-1 overflow-auto p-4 space-y-4">
        {loading ? (
          <div className="text-center text-[#52525b]">
            <RefreshCw className="animate-spin mx-auto" />
          </div>
        ) : messages.length === 0 ? (
          <p className="text-center text-[#52525b]">No messages yet</p>
        ) : (
          messages.map(msg => (
            <div
              key={msg.id}
              className={`max-w-[80%] p-3 rounded-lg ${
                msg.direction === 'outbound'
                  ? 'ml-auto bg-blue-500 text-white'
                  : 'bg-[#1e1e24] text-[#d7dadc]'
              }`}
            >
              <p className="text-sm">{msg.content}</p>
              <p className={`text-xs mt-1 ${
                msg.direction === 'outbound' ? 'text-blue-100' : 'text-[#52525b]'
              }`}>
                {new Date(msg.sentAt).toLocaleString()}
              </p>
            </div>
          ))
        )}
      </div>

      {/* Queued Reply Indicator */}
      {queuedReply && (
        <div className="mx-4 mb-2 p-3 bg-yellow-500/10 border border-yellow-500/20 rounded-lg">
          <div className="flex items-center gap-2 text-yellow-400">
            <Clock size={16} />
            <span className="text-sm font-medium">
              Reply {queuedReply.status === 'approved' ? 'approved & ready to send' : 'pending approval'}
            </span>
          </div>
          <p className="text-xs text-yellow-400 mt-1 truncate">
            {queuedReply.finalMessage}
          </p>
        </div>
      )}

      {/* Account notice for reply */}
      {conversation.accountUsername && (
        <div className="mx-4 mb-2 px-3 py-2 bg-blue-500/10 border border-blue-500/20 rounded-lg text-xs text-blue-400">
          This reply will be sent from <span className="font-semibold">u/{conversation.accountUsername}</span>. Make sure that account is logged in on Reddit before sending.
        </div>
      )}

      {/* Reply Composer */}
      <div className="p-4 border-t border-[#23232a] space-y-3">
        {/* AI Suggestion Section */}
        <div className="flex items-center gap-2">
          <button
            onClick={generateSuggestion}
            disabled={generatingSuggestion}
            className="flex items-center gap-2 px-3 py-1.5 bg-purple-500/15 text-purple-400 rounded-lg hover:bg-purple-500/25 disabled:opacity-50 text-sm"
          >
            {generatingSuggestion ? (
              <RefreshCw size={14} className="animate-spin" />
            ) : (
              <Sparkles size={14} />
            )}
            Generate AI Reply
          </button>
          {suggestion && (
            <button
              onClick={useSuggestion}
              className="flex items-center gap-1 px-3 py-1.5 bg-purple-500/10 text-purple-400 rounded-lg hover:bg-purple-500/15 text-sm"
            >
              <Edit3 size={14} />
              Use Suggestion
            </button>
          )}
        </div>

        {/* AI Suggestion Preview */}
        {suggestion && !replyText && (
          <div className="p-3 bg-purple-500/10 rounded-lg">
            <p className="text-sm text-purple-300">{suggestion}</p>
            <div className="flex gap-2 mt-2">
              <button
                onClick={useSuggestion}
                className="text-xs text-purple-400 hover:text-purple-300 font-medium"
              >
                Edit & Use
              </button>
              <button
                onClick={generateSuggestion}
                className="text-xs text-purple-400 hover:text-purple-300"
              >
                Regenerate
              </button>
            </div>
          </div>
        )}

        {/* Improve Suggestion */}
        {(suggestion || replyText) && (
          <div className="flex items-center gap-2">
            <input
              type="text"
              value={improvementInstructions}
              onChange={(e) => setImprovementInstructions(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  handleImproveSuggestion();
                }
              }}
              placeholder="Improve: e.g. 'make it shorter', 'more casual', 'ask about pricing'..."
              className="flex-1 px-3 py-1.5 bg-[#1e1e24] border border-[#23232a] text-white placeholder-[#52525b] rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-purple-500/50"
              disabled={improvingSuggestion}
            />
            <button
              onClick={handleImproveSuggestion}
              disabled={improvingSuggestion || !improvementInstructions.trim()}
              className="flex items-center gap-1 px-3 py-1.5 bg-purple-500/15 text-purple-400 rounded-lg hover:bg-purple-500/25 disabled:opacity-50 text-sm whitespace-nowrap"
            >
              {improvingSuggestion ? (
                <RefreshCw size={14} className="animate-spin" />
              ) : (
                <Wand2 size={14} />
              )}
              Improve
            </button>
          </div>
        )}

        {/* Reply Textarea */}
        <textarea
          value={replyText}
          onChange={(e) => setReplyText(e.target.value)}
          placeholder="Write your reply or use AI suggestion..."
          className="w-full p-3 bg-[#1e1e24] border border-[#23232a] text-white placeholder-[#52525b] rounded-lg text-sm resize-none focus:outline-none focus:ring-2 focus:ring-[#ff4500]/50"
          rows={3}
        />

        {/* Action Buttons */}
        <div className="flex items-center gap-2">
          <button
            onClick={() => handleAddToQueue(false)}
            disabled={isQueueing || !replyText.trim()}
            className="flex items-center gap-2 px-4 py-2 bg-[#1e1e24] text-[#d7dadc] rounded-lg hover:bg-[#23232a] disabled:opacity-50 text-sm"
          >
            {isQueueing ? (
              <RefreshCw size={14} className="animate-spin" />
            ) : (
              <Clock size={14} />
            )}
            Add to Queue
          </button>
          <button
            onClick={() => handleAddToQueue(true)}
            disabled={isQueueing || !replyText.trim()}
            className="flex items-center gap-2 px-4 py-2 bg-blue-500 text-white rounded-lg hover:bg-blue-600 disabled:opacity-50 text-sm"
          >
            {isQueueing ? (
              <RefreshCw size={14} className="animate-spin" />
            ) : (
              <Send size={14} />
            )}
            Send Now
          </button>
          {replyText && (
            <button
              onClick={() => { setReplyText(''); setSuggestion(''); }}
              className="px-3 py-2 text-[#71717a] hover:text-white text-sm"
            >
              Clear
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

export default function Inbox() {
  const [conversations, setConversations] = useState([]);
  const [stats, setStats] = useState(null);
  const [selected, setSelected] = useState(null);
  const [filter, setFilter] = useState('all');
  const [accountFilter, setAccountFilter] = useState('all');
  const [accounts, setAccounts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [syncState, setSyncState] = useState(null); // null | 'syncing' | 'completed'
  const [syncProgress, setSyncProgress] = useState(null);

  // Load accounts list for filter dropdown
  useEffect(() => {
    api.getAccountsSummary().then(setAccounts).catch(() => {});
  }, []);

  const loadData = async (showSpinner = false) => {
    if (showSpinner) setLoading(true);
    try {
      const [convList, convStats] = await Promise.all([
        api.getConversations({
          status: filter !== 'all' ? filter : undefined,
          accountId: accountFilter !== 'all' ? accountFilter : undefined,
          limit: 100
        }),
        api.getConversationStats()
      ]);
      setConversations(convList || []);
      setStats(convStats);
      // Sync selected conversation with updated data so detail view reflects changes
      setSelected(prev => {
        if (!prev) return prev;
        const updated = (convList || []).find(c => c.id === prev.id);
        return updated || prev;
      });
    } catch (err) {
      logError('Failed to load conversations', { component: 'Inbox', errorName: err?.name, errorStack: err?.stack });
    } finally {
      if (showSpinner) setLoading(false);
    }
  };

  const handleStatusChange = async (conversationId, newStatus) => {
    setSelected(prev => prev && prev.id === conversationId ? { ...prev, status: newStatus } : prev);
    setConversations(prev => prev.map(c => c.id === conversationId ? { ...c, status: newStatus } : c));
    await loadData();
  };

  useEffect(() => {
    loadData(true);
    const interval = setInterval(() => loadData(), 15000);
    const onVisible = () => {
      if (document.visibilityState === 'visible') loadData();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      clearInterval(interval);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [filter, accountFilter]);

  // Listen for bulk sync progress from extension bridge
  useEffect(() => {
    const handleSyncProgress = (event) => {
      if (event.data?.type === 'RDM_SYNC_PROGRESS' && event.data.action === 'BULK_SYNC_PROGRESS') {
        const data = event.data.data;
        setSyncProgress(data);
        if (data.status === 'completed') {
          setSyncState('completed');
          loadData(); // Refresh conversations on completion
        } else if (data.status === 'started' || data.status === 'syncing') {
          setSyncState('syncing');
          // Refresh periodically during sync (every 3 chats)
          if (data.synced > 0 && data.current % 3 === 0) loadData();
        } else if (data.status === 'error') {
          setSyncState(null);
          setSyncProgress(null);
        }
      }
    };
    window.addEventListener('message', handleSyncProgress);
    return () => window.removeEventListener('message', handleSyncProgress);
  }, []);

  const handleSyncAllChats = () => {
    setSyncState('syncing');
    setSyncProgress(null);
    api.triggerBulkSync();
  };

  const handleCancelSync = () => {
    api.cancelBulkSync();
    setSyncState(null);
    setSyncProgress(null);
  };

  const filters = [
    { value: 'all', label: 'All' },
    { value: 'active', label: 'Active', count: stats?.active },
    { value: 'interested', label: 'Interested', count: stats?.interested },
    { value: 'cold', label: 'Cold', count: stats?.cold },
    { value: 'closed', label: 'Closed', count: stats?.closed },
    { value: 'converted', label: 'Converted', count: stats?.converted }
  ];

  return (
    <div className="flex h-full">
      {/* Left Panel - List */}
      <div className="w-80 border-r border-[#23232a] flex flex-col bg-[#141416]">
        <div className="p-4 border-b border-[#23232a]">
          <div className="flex items-center justify-between">
            <div>
              <h1 className="text-xl font-bold text-white">Inbox</h1>
              <p className="text-sm text-[#71717a]">
                {stats?.total || 0} conversations, {stats?.withReplies || 0} with replies
              </p>
            </div>
            <button
              onClick={handleSyncAllChats}
              disabled={syncState === 'syncing'}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium transition-colors ${
                syncState === 'syncing'
                  ? 'bg-orange-500/15 text-orange-400 cursor-wait'
                  : 'bg-[#ff4500]/15 text-[#ff4500] hover:bg-[#ff4500]/25'
              }`}
            >
              <RefreshCw size={14} className={syncState === 'syncing' ? 'animate-spin' : ''} />
              {syncState === 'syncing' ? 'Syncing...' : 'Sync Chats'}
            </button>
          </div>
        </div>

        {/* Sync Progress Banner */}
        {syncState === 'syncing' && syncProgress && (
          <div className="px-4 py-2 border-b border-[#23232a] bg-orange-500/5">
            <div className="flex items-center justify-between text-sm">
              <span className="text-orange-400">
                Syncing {syncProgress.currentUser ? `u/${syncProgress.currentUser}` : '...'}{' '}
                ({syncProgress.current}/{syncProgress.total})
              </span>
              <button
                onClick={handleCancelSync}
                className="text-xs text-red-400 hover:text-red-300"
              >
                Cancel
              </button>
            </div>
            <div className="mt-1 h-1 bg-[#23232a] rounded-full overflow-hidden">
              <div
                className="h-full bg-orange-500 transition-all duration-300"
                style={{ width: `${syncProgress.total ? (syncProgress.current / syncProgress.total) * 100 : 0}%` }}
              />
            </div>
            <div className="flex gap-3 mt-1 text-xs text-[#71717a]">
              <span>{syncProgress.synced} synced</span>
              <span>{syncProgress.skipped} up-to-date</span>
              {syncProgress.failed > 0 && <span className="text-red-400">{syncProgress.failed} failed</span>}
            </div>
          </div>
        )}

        {syncState === 'completed' && syncProgress && (
          <div className="px-4 py-2 border-b border-[#23232a] bg-green-500/5">
            <div className="flex items-center justify-between text-sm text-green-400">
              <span>
                Sync complete: {syncProgress.synced} updated, {syncProgress.skipped} up-to-date
                {syncProgress.failed > 0 && `, ${syncProgress.failed} failed`}
              </span>
              <button
                onClick={() => { setSyncState(null); setSyncProgress(null); }}
                className="text-xs text-[#71717a] hover:text-white"
              >
                Dismiss
              </button>
            </div>
          </div>
        )}

        {/* Filters */}
        <div className="p-2 border-b border-[#23232a] flex gap-1 overflow-x-auto">
          {filters.map(f => (
            <button
              key={f.value}
              onClick={() => setFilter(f.value)}
              className={`px-2 py-1 rounded text-xs font-medium whitespace-nowrap ${
                filter === f.value
                  ? 'bg-white/10 text-white'
                  : 'bg-[#1e1e24] text-[#a1a1aa] hover:bg-[#23232a]'
              }`}
            >
              {f.label}
              {f.count !== undefined && (
                <span className="ml-1">({f.count})</span>
              )}
            </button>
          ))}
        </div>

        {/* Account Filter */}
        {accounts.length > 1 && (
          <div className="px-3 py-2 border-b border-[#23232a]">
            <select
              value={accountFilter}
              onChange={(e) => setAccountFilter(e.target.value)}
              className="w-full px-2 py-1 bg-[#1e1e24] border border-[#23232a] text-white rounded text-xs"
            >
              <option value="all">All accounts</option>
              {accounts.map(a => (
                <option key={a.id} value={a.id}>u/{a.username}</option>
              ))}
            </select>
          </div>
        )}

        {/* Conversation List */}
        <div className="flex-1 overflow-auto">
          {loading ? (
            <div className="p-4 text-center text-[#52525b]">
              <RefreshCw className="animate-spin mx-auto" />
            </div>
          ) : conversations.length === 0 ? (
            <p className="p-4 text-center text-[#52525b]">No conversations</p>
          ) : (
            <ConversationList
              conversations={conversations}
              selected={selected}
              onSelect={setSelected}
            />
          )}
        </div>
      </div>

      {/* Right Panel - Detail */}
      <div className="flex-1 bg-[#0a0a0b]">
        <ConversationDetail
          conversation={selected}
          onUpdate={loadData}
          onStatusChange={handleStatusChange}
          accounts={accounts}
        />
      </div>
    </div>
  );
}
