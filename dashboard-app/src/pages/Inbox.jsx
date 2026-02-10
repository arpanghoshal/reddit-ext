import { useState, useEffect } from 'react';
import { MessageSquare, RefreshCw, Sparkles, Tag, ChevronRight, Send, Clock, Edit3, Check } from 'lucide-react';
import * as api from '../api/client';

const STATUS_OPTIONS = ['active', 'interested', 'cold', 'closed', 'converted'];

const STATUS_COLORS = {
  active: 'bg-blue-100 text-blue-800',
  interested: 'bg-green-100 text-green-800',
  cold: 'bg-gray-100 text-gray-800',
  closed: 'bg-gray-200 text-gray-600',
  converted: 'bg-purple-100 text-purple-800'
};

function ConversationList({ conversations, selected, onSelect }) {
  return (
    <div className="divide-y divide-gray-100">
      {conversations.map(conv => (
        <button
          key={conv.id}
          onClick={() => onSelect(conv)}
          className={`w-full p-4 text-left hover:bg-gray-50 transition-colors ${
            selected?.id === conv.id ? 'bg-blue-50' : ''
          }`}
        >
          <div className="flex items-center justify-between">
            <span className="font-semibold text-gray-900">
              u/{conv.participantUsername}
            </span>
            <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${STATUS_COLORS[conv.status]}`}>
              {conv.status}
            </span>
          </div>
          <div className="flex items-center gap-2 mt-1 text-sm text-gray-500">
            <span>{conv.totalMessages} messages</span>
            {conv.hasReply && (
              <span className="text-green-600">Has reply</span>
            )}
          </div>
          <div className="mt-1">
            {conv.accountUsername ? (
              <span className="inline-flex items-center px-1.5 py-0.5 rounded text-xs font-medium bg-indigo-50 text-indigo-600 border border-indigo-100">
                u/{conv.accountUsername}
              </span>
            ) : (
              <span className="inline-flex items-center px-1.5 py-0.5 rounded text-xs font-medium bg-red-50 text-red-500 border border-red-100">
                No account
              </span>
            )}
          </div>
          {conv.sourceSubreddit && (
            <p className="text-xs text-gray-500 mt-1 truncate">
              r/{conv.sourceSubreddit}
              {conv.sourcePostTitle && (
                <span className="text-gray-400"> &middot; {conv.sourcePostTitle}</span>
              )}
            </p>
          )}
          {conv.lastMessageAt && (
            <p className="text-xs text-gray-400 mt-1">
              Last: {new Date(conv.lastMessageAt).toLocaleDateString()}
            </p>
          )}
        </button>
      ))}
    </div>
  );
}

function ConversationDetail({ conversation, onUpdate, accounts = [] }) {
  const [messages, setMessages] = useState([]);
  const [suggestion, setSuggestion] = useState('');
  const [loading, setLoading] = useState(false);
  const [generatingSuggestion, setGeneratingSuggestion] = useState(false);
  const [replyText, setReplyText] = useState('');
  const [isQueueing, setIsQueueing] = useState(false);
  const [queuedReply, setQueuedReply] = useState(null);
  const [toast, setToast] = useState(null);

  useEffect(() => {
    if (conversation) {
      loadConversation(true);
      checkQueuedReply();

      // Auto-refresh messages and queue status every 10s
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
      console.error('Failed to load conversation:', err);
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
      console.error('Failed to check queued reply:', err);
    }
  };

  const generateSuggestion = async () => {
    setGeneratingSuggestion(true);
    try {
      const reply = await api.getReplySuggestion(conversation.id);
      setSuggestion(reply);
    } catch (err) {
      console.error('Failed to generate suggestion:', err);
    } finally {
      setGeneratingSuggestion(false);
    }
  };

  const assignAccount = async (accountId) => {
    try {
      await api.updateConversation(conversation.id, { accountId: accountId || null });
      onUpdate();
    } catch (err) {
      console.error('Failed to assign account:', err);
    }
  };

  const updateStatus = async (newStatus) => {
    try {
      await api.updateConversation(conversation.id, { status: newStatus });
      onUpdate();
    } catch (err) {
      console.error('Failed to update status:', err);
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
      console.error('Failed to add to queue:', err);
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
      <div className="flex items-center justify-center h-full text-gray-400">
        <p>Select a conversation to view</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      {/* Toast */}
      {toast && (
        <div className={`absolute top-4 right-4 px-4 py-2 rounded-lg text-sm font-medium z-50 ${
          toast.type === 'error' ? 'bg-red-100 text-red-800' : 'bg-green-100 text-green-800'
        }`}>
          {toast.message}
        </div>
      )}

      {/* Header */}
      <div className="p-4 border-b border-gray-200">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-lg font-semibold">u/{conversation.participantUsername}</h2>
            <div className="flex items-center gap-2 mt-0.5">
              <span className="text-sm text-gray-500">{conversation.totalMessages} messages</span>
              <select
                value={conversation.accountId || ''}
                onChange={(e) => assignAccount(e.target.value)}
                className={`px-2 py-0.5 rounded text-xs font-medium border ${
                  conversation.accountId
                    ? 'bg-indigo-50 text-indigo-600 border-indigo-100'
                    : 'bg-red-50 text-red-500 border-red-200'
                }`}
              >
                <option value="">No account</option>
                {accounts.map(a => (
                  <option key={a.id} value={a.id}>u/{a.username}</option>
                ))}
              </select>
            </div>
            {conversation.sourceSubreddit && (
              <div className="flex items-center gap-1.5 mt-1 text-sm text-gray-500">
                <span className="font-medium text-orange-600">r/{conversation.sourceSubreddit}</span>
                {conversation.sourcePostTitle && (
                  conversation.sourcePostUrl ? (
                    <a
                      href={conversation.sourcePostUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-blue-600 hover:underline truncate max-w-md"
                      title={conversation.sourcePostTitle}
                    >
                      {conversation.sourcePostTitle}
                    </a>
                  ) : (
                    <span className="text-gray-400 truncate max-w-md">{conversation.sourcePostTitle}</span>
                  )
                )}
              </div>
            )}
          </div>
          <select
            value={conversation.status}
            onChange={(e) => updateStatus(e.target.value)}
            className="px-3 py-1 border border-gray-200 rounded-lg text-sm"
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
          <div className="text-center text-gray-400">
            <RefreshCw className="animate-spin mx-auto" />
          </div>
        ) : messages.length === 0 ? (
          <p className="text-center text-gray-400">No messages yet</p>
        ) : (
          messages.map(msg => (
            <div
              key={msg.id}
              className={`max-w-[80%] p-3 rounded-lg ${
                msg.direction === 'outbound'
                  ? 'ml-auto bg-blue-500 text-white'
                  : 'bg-gray-100 text-gray-900'
              }`}
            >
              <p className="text-sm">{msg.content}</p>
              <p className={`text-xs mt-1 ${
                msg.direction === 'outbound' ? 'text-blue-100' : 'text-gray-400'
              }`}>
                {new Date(msg.sentAt).toLocaleString()}
              </p>
            </div>
          ))
        )}
      </div>

      {/* Queued Reply Indicator */}
      {queuedReply && (
        <div className="mx-4 mb-2 p-3 bg-yellow-50 border border-yellow-200 rounded-lg">
          <div className="flex items-center gap-2 text-yellow-800">
            <Clock size={16} />
            <span className="text-sm font-medium">
              Reply {queuedReply.status === 'approved' ? 'approved & ready to send' : 'pending approval'}
            </span>
          </div>
          <p className="text-xs text-yellow-700 mt-1 truncate">
            {queuedReply.finalMessage}
          </p>
        </div>
      )}

      {/* Account notice for reply */}
      {conversation.accountUsername && (
        <div className="mx-4 mb-2 px-3 py-2 bg-blue-50 border border-blue-200 rounded-lg text-xs text-blue-700">
          This reply will be sent from <span className="font-semibold">u/{conversation.accountUsername}</span>. Make sure that account is logged in on Reddit before sending.
        </div>
      )}

      {/* Reply Composer */}
      <div className="p-4 border-t border-gray-200 space-y-3">
        {/* AI Suggestion Section */}
        <div className="flex items-center gap-2">
          <button
            onClick={generateSuggestion}
            disabled={generatingSuggestion}
            className="flex items-center gap-2 px-3 py-1.5 bg-purple-100 text-purple-700 rounded-lg hover:bg-purple-200 disabled:opacity-50 text-sm"
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
              className="flex items-center gap-1 px-3 py-1.5 bg-purple-50 text-purple-600 rounded-lg hover:bg-purple-100 text-sm"
            >
              <Edit3 size={14} />
              Use Suggestion
            </button>
          )}
        </div>

        {/* AI Suggestion Preview */}
        {suggestion && !replyText && (
          <div className="p-3 bg-purple-50 rounded-lg">
            <p className="text-sm text-purple-900">{suggestion}</p>
            <div className="flex gap-2 mt-2">
              <button
                onClick={useSuggestion}
                className="text-xs text-purple-600 hover:text-purple-800 font-medium"
              >
                Edit & Use
              </button>
              <button
                onClick={generateSuggestion}
                className="text-xs text-purple-600 hover:text-purple-800"
              >
                Regenerate
              </button>
            </div>
          </div>
        )}

        {/* Reply Textarea */}
        <textarea
          value={replyText}
          onChange={(e) => setReplyText(e.target.value)}
          placeholder="Write your reply or use AI suggestion..."
          className="w-full p-3 border border-gray-200 rounded-lg text-sm resize-none focus:outline-none focus:ring-2 focus:ring-blue-500"
          rows={3}
        />

        {/* Action Buttons */}
        <div className="flex items-center gap-2">
          <button
            onClick={() => handleAddToQueue(false)}
            disabled={isQueueing || !replyText.trim()}
            className="flex items-center gap-2 px-4 py-2 bg-gray-100 text-gray-700 rounded-lg hover:bg-gray-200 disabled:opacity-50 text-sm"
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
              className="px-3 py-2 text-gray-500 hover:text-gray-700 text-sm"
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
    } catch (err) {
      console.error('Failed to load conversations:', err);
    } finally {
      if (showSpinner) setLoading(false);
    }
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
      <div className="w-80 border-r border-gray-200 flex flex-col bg-white">
        <div className="p-4 border-b border-gray-200">
          <h1 className="text-xl font-bold text-gray-900">Inbox</h1>
          <p className="text-sm text-gray-500">
            {stats?.total || 0} conversations, {stats?.withReplies || 0} with replies
          </p>
        </div>

        {/* Filters */}
        <div className="p-2 border-b border-gray-100 flex gap-1 overflow-x-auto">
          {filters.map(f => (
            <button
              key={f.value}
              onClick={() => setFilter(f.value)}
              className={`px-2 py-1 rounded text-xs font-medium whitespace-nowrap ${
                filter === f.value
                  ? 'bg-gray-900 text-white'
                  : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
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
          <div className="px-3 py-2 border-b border-gray-100">
            <select
              value={accountFilter}
              onChange={(e) => setAccountFilter(e.target.value)}
              className="w-full px-2 py-1 border border-gray-200 rounded text-xs text-gray-600"
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
            <div className="p-4 text-center text-gray-400">
              <RefreshCw className="animate-spin mx-auto" />
            </div>
          ) : conversations.length === 0 ? (
            <p className="p-4 text-center text-gray-400">No conversations</p>
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
      <div className="flex-1 bg-gray-50">
        <ConversationDetail
          conversation={selected}
          onUpdate={loadData}
          accounts={accounts}
        />
      </div>
    </div>
  );
}
