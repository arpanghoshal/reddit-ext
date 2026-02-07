import { useState, useEffect } from 'react';
import { Check, X, Edit2, RefreshCw, ChevronDown, ChevronUp, MessageSquare, Send, Inbox } from 'lucide-react';
import { Link } from 'react-router-dom';
import * as api from '../api/client';

function QueueItem({ item, onApprove, onReject, onSelect, isSelected, isReplyQueue, onSend }) {
  const [expanded, setExpanded] = useState(false);

  const statusColors = {
    pending: 'bg-yellow-100 text-yellow-800',
    approved: 'bg-blue-100 text-blue-800',
    sent: 'bg-green-100 text-green-800',
    failed: 'bg-red-100 text-red-800',
    rejected: 'bg-gray-100 text-gray-800'
  };

  const scoreColor = item.classificationScore >= 70
    ? 'text-green-600'
    : item.classificationScore >= 40
    ? 'text-yellow-600'
    : 'text-red-600';

  return (
    <div className="bg-white rounded-lg shadow-sm border border-gray-100 overflow-hidden">
      <div className="p-4">
        <div className="flex items-start gap-4">
          {/* Checkbox */}
          {item.status === 'pending' && (
            <input
              type="checkbox"
              checked={isSelected}
              onChange={() => onSelect(item.id)}
              className="mt-1 h-4 w-4 rounded border-gray-300"
            />
          )}

          {/* Content */}
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-3 flex-wrap">
              <a
                href={`https://reddit.com/user/${item.recipientUsername}`}
                target="_blank"
                rel="noopener noreferrer"
                className="font-semibold text-blue-600 hover:underline"
              >
                u/{item.recipientUsername}
              </a>
              {!isReplyQueue && item.subreddit && (
                <>
                  <span className="text-gray-400">in</span>
                  <span className="text-gray-600">r/{item.subreddit}</span>
                </>
              )}
              {isReplyQueue && (
                <span className="px-2 py-0.5 rounded-full text-xs font-medium bg-purple-100 text-purple-800">
                  Reply
                </span>
              )}
              <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${statusColors[item.status]}`}>
                {item.status}
              </span>
              {item.accountUsername ? (
                <span className="inline-flex items-center px-1.5 py-0.5 rounded text-xs font-medium bg-indigo-50 text-indigo-600 border border-indigo-100">
                  u/{item.accountUsername}
                </span>
              ) : (
                <span className="inline-flex items-center px-1.5 py-0.5 rounded text-xs font-medium bg-amber-50 text-amber-600 border border-amber-100">
                  No account
                </span>
              )}
              {item.classificationScore && !isReplyQueue && (
                <span className={`text-sm font-medium ${scoreColor}`}>
                  {Math.round(item.classificationScore)}% match
                </span>
              )}
            </div>

            {!isReplyQueue && item.postTitle && (
              <p className="text-sm text-gray-500 mt-1 truncate">
                Post: {item.postTitle}
              </p>
            )}

            {isReplyQueue && item.conversationId && (
              <Link
                to={`/inbox?conversation=${item.conversationId}`}
                className="flex items-center gap-1 text-sm text-purple-600 mt-1 hover:text-purple-800"
              >
                <Inbox size={14} />
                View Conversation
              </Link>
            )}

            <button
              onClick={() => setExpanded(!expanded)}
              className="flex items-center gap-1 text-sm text-gray-400 mt-2 hover:text-gray-600"
            >
              {expanded ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
              {expanded ? 'Hide message' : 'Show message'}
            </button>

            {expanded && (
              <div className="mt-3 p-3 bg-gray-50 rounded-lg">
                <p className="text-sm text-gray-700 whitespace-pre-wrap">
                  {item.editedMessage || item.generatedMessage}
                </p>
              </div>
            )}
          </div>

          {/* Actions */}
          {item.status === 'pending' && (
            <div className="flex gap-2">
              <button
                onClick={() => onApprove(item.id)}
                className="p-2 bg-green-100 text-green-600 rounded-lg hover:bg-green-200"
                title="Approve"
              >
                <Check size={18} />
              </button>
              <button
                onClick={() => onReject(item.id)}
                className="p-2 bg-red-100 text-red-600 rounded-lg hover:bg-red-200"
                title="Reject"
              >
                <X size={18} />
              </button>
            </div>
          )}
          {item.status === 'approved' && isReplyQueue && onSend && (
            <button
              onClick={() => onSend(item)}
              className="flex items-center gap-1 px-3 py-2 bg-blue-500 text-white rounded-lg hover:bg-blue-600 text-sm"
              title="Send via Reddit"
            >
              <Send size={16} />
              Send
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

export default function Queue() {
  const [items, setItems] = useState([]);
  const [stats, setStats] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [filter, setFilter] = useState('pending');
  const [messageType, setMessageType] = useState('outreach');
  const [accountFilter, setAccountFilter] = useState('all');
  const [accounts, setAccounts] = useState([]);
  const [selectedIds, setSelectedIds] = useState(new Set());

  // Load accounts list for filter dropdown
  useEffect(() => {
    api.getAccountsSummary().then(setAccounts).catch(() => {});
  }, []);

  const loadData = async (showSpinner = false) => {
    if (showSpinner) setLoading(true);
    setError(null);
    try {
      const [queueItems, queueStats] = await Promise.all([
        api.getQueue({
          status: filter !== 'all' ? filter : undefined,
          messageType: messageType,
          accountId: accountFilter !== 'all' ? accountFilter : undefined,
          limit: 100
        }),
        api.getQueueStats({ messageType })
      ]);
      setItems(queueItems || []);
      setStats(queueStats);
    } catch (err) {
      console.error('Failed to load queue:', err);
      setError('Failed to load queue data');
    } finally {
      if (showSpinner) setLoading(false);
    }
  };

  useEffect(() => {
    loadData(true);
    setSelectedIds(new Set());
    const interval = setInterval(() => loadData(), 15000);
    const onVisible = () => {
      if (document.visibilityState === 'visible') loadData();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      clearInterval(interval);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [filter, messageType, accountFilter]);

  const handleApprove = async (id) => {
    try {
      await api.approveQueueItem(id);
      loadData();
    } catch (err) {
      console.error('Failed to approve:', err);
      setError('Failed to approve item');
    }
  };

  const handleReject = async (id) => {
    try {
      await api.rejectQueueItem(id);
      loadData();
    } catch (err) {
      console.error('Failed to reject:', err);
      setError('Failed to reject item');
    }
  };

  const handleBulkApprove = async () => {
    if (selectedIds.size === 0) return;
    try {
      await api.bulkApprove([...selectedIds]);
      setSelectedIds(new Set());
      loadData();
    } catch (err) {
      console.error('Failed to bulk approve:', err);
      setError('Failed to bulk approve');
    }
  };

  const handleBulkReject = async () => {
    if (selectedIds.size === 0) return;
    try {
      await api.bulkReject([...selectedIds]);
      setSelectedIds(new Set());
      loadData();
    } catch (err) {
      console.error('Failed to bulk reject:', err);
      setError('Failed to bulk reject');
    }
  };

  const toggleSelect = (id) => {
    const newSelected = new Set(selectedIds);
    if (newSelected.has(id)) {
      newSelected.delete(id);
    } else {
      newSelected.add(id);
    }
    setSelectedIds(newSelected);
  };

  const handleSend = (item) => {
    const message = item.editedMessage || item.generatedMessage;
    api.triggerExtensionSend(
      item.recipientUsername,
      message,
      item.id,
      item.conversationId || null,
      item.accountId || null
    );
  };

  const selectAll = () => {
    const pendingIds = items.filter(i => i.status === 'pending').map(i => i.id);
    setSelectedIds(new Set(pendingIds));
  };

  const filters = [
    { value: 'pending', label: 'Pending', count: stats?.pending },
    { value: 'approved', label: 'Approved', count: stats?.approved },
    { value: 'sent', label: 'Sent', count: stats?.sent },
    { value: 'failed', label: 'Failed', count: stats?.failed },
    { value: 'rejected', label: 'Rejected', count: stats?.rejected },
    { value: 'all', label: 'All', count: stats?.total }
  ];

  return (
    <div className="p-6">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">DM Queue</h1>
          <p className="text-gray-500">Review and manage pending messages</p>
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
        <div className="mb-4 bg-red-50 text-red-700 px-4 py-3 rounded-lg flex items-center justify-between">
          <span>{error}</span>
          <button onClick={() => setError(null)} className="text-red-500 hover:text-red-700">
            <X size={16} />
          </button>
        </div>
      )}

      {/* Message Type Toggle */}
      <div className="flex items-center gap-2 mb-4 p-1 bg-gray-100 rounded-lg w-fit">
        <button
          onClick={() => setMessageType('outreach')}
          className={`flex items-center gap-2 px-4 py-2 rounded-md text-sm font-medium transition-colors ${
            messageType === 'outreach'
              ? 'bg-white text-gray-900 shadow-sm'
              : 'text-gray-600 hover:text-gray-900'
          }`}
        >
          <Send size={16} />
          Outreach
        </button>
        <button
          onClick={() => setMessageType('reply')}
          className={`flex items-center gap-2 px-4 py-2 rounded-md text-sm font-medium transition-colors ${
            messageType === 'reply'
              ? 'bg-white text-gray-900 shadow-sm'
              : 'text-gray-600 hover:text-gray-900'
          }`}
        >
          <MessageSquare size={16} />
          Replies
        </button>
      </div>

      {/* Status Filters */}
      <div className="flex items-center gap-2 mb-4 overflow-x-auto">
        {filters.map(f => (
          <button
            key={f.value}
            onClick={() => setFilter(f.value)}
            className={`px-4 py-2 rounded-lg text-sm font-medium whitespace-nowrap ${
              filter === f.value
                ? 'bg-gray-900 text-white'
                : 'bg-white text-gray-600 hover:bg-gray-50'
            }`}
          >
            {f.label}
            {f.count !== undefined && (
              <span className="ml-2 px-2 py-0.5 rounded-full bg-gray-200 text-gray-600 text-xs">
                {f.count}
              </span>
            )}
          </button>
        ))}
        {accounts.length > 1 && (
          <select
            value={accountFilter}
            onChange={(e) => setAccountFilter(e.target.value)}
            className="ml-2 px-3 py-2 border border-gray-200 rounded-lg text-sm text-gray-600 bg-white"
          >
            <option value="all">All accounts</option>
            {accounts.map(a => (
              <option key={a.id} value={a.id}>u/{a.username}</option>
            ))}
          </select>
        )}
      </div>

      {/* Bulk Actions */}
      {filter === 'pending' && selectedIds.size > 0 && (
        <div className="flex items-center gap-4 mb-4 p-3 bg-blue-50 rounded-lg">
          <span className="text-sm text-blue-700">
            {selectedIds.size} selected
          </span>
          <button
            onClick={handleBulkApprove}
            className="px-3 py-1 bg-green-500 text-white rounded-lg text-sm hover:bg-green-600"
          >
            Approve All
          </button>
          <button
            onClick={handleBulkReject}
            className="px-3 py-1 bg-red-500 text-white rounded-lg text-sm hover:bg-red-600"
          >
            Reject All
          </button>
          <button
            onClick={() => setSelectedIds(new Set())}
            className="text-sm text-gray-600 hover:text-gray-800"
          >
            Clear Selection
          </button>
        </div>
      )}

      {filter === 'pending' && items.some(i => i.status === 'pending') && (
        <button
          onClick={selectAll}
          className="text-sm text-blue-600 hover:text-blue-800 mb-4"
        >
          Select all pending
        </button>
      )}

      {/* Queue Items */}
      {loading && items.length === 0 ? (
        <div className="text-center py-12 text-gray-400">
          <RefreshCw className="animate-spin mx-auto mb-4" size={32} />
          Loading...
        </div>
      ) : items.length === 0 ? (
        <div className="text-center py-12 bg-white rounded-xl">
          <p className="text-gray-400">No items in queue</p>
        </div>
      ) : (
        <div className="space-y-3">
          {items.map(item => (
            <QueueItem
              key={item.id}
              item={item}
              onApprove={handleApprove}
              onReject={handleReject}
              onSelect={toggleSelect}
              isSelected={selectedIds.has(item.id)}
              isReplyQueue={messageType === 'reply'}
              onSend={messageType === 'reply' ? handleSend : undefined}
            />
          ))}
        </div>
      )}
    </div>
  );
}
