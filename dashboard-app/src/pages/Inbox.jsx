import { useState, useEffect } from 'react';
import { MessageSquare, RefreshCw, Sparkles, Tag, ChevronRight } from 'lucide-react';
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

function ConversationDetail({ conversation, onUpdate }) {
  const [messages, setMessages] = useState([]);
  const [suggestion, setSuggestion] = useState('');
  const [loading, setLoading] = useState(false);
  const [generatingSuggestion, setGeneratingSuggestion] = useState(false);

  useEffect(() => {
    if (conversation) {
      loadConversation();
    }
  }, [conversation?.id]);

  const loadConversation = async () => {
    if (!conversation) return;
    setLoading(true);
    try {
      const data = await api.getConversation(conversation.id);
      setMessages(data.messages || []);
    } catch (err) {
      console.error('Failed to load conversation:', err);
    } finally {
      setLoading(false);
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

  const updateStatus = async (newStatus) => {
    try {
      await api.updateConversation(conversation.id, { status: newStatus });
      onUpdate();
    } catch (err) {
      console.error('Failed to update status:', err);
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
      {/* Header */}
      <div className="p-4 border-b border-gray-200">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-lg font-semibold">u/{conversation.participantUsername}</h2>
            <p className="text-sm text-gray-500">{conversation.totalMessages} messages</p>
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

      {/* AI Suggestion */}
      <div className="p-4 border-t border-gray-200">
        <button
          onClick={generateSuggestion}
          disabled={generatingSuggestion}
          className="flex items-center gap-2 px-4 py-2 bg-purple-100 text-purple-700 rounded-lg hover:bg-purple-200 disabled:opacity-50"
        >
          {generatingSuggestion ? (
            <RefreshCw size={16} className="animate-spin" />
          ) : (
            <Sparkles size={16} />
          )}
          Generate Reply Suggestion
        </button>

        {suggestion && (
          <div className="mt-3 p-3 bg-purple-50 rounded-lg">
            <p className="text-sm text-purple-900">{suggestion}</p>
            <div className="flex gap-2 mt-2">
              <button
                onClick={() => navigator.clipboard.writeText(suggestion)}
                className="text-xs text-purple-600 hover:text-purple-800"
              >
                Copy to clipboard
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
      </div>
    </div>
  );
}

export default function Inbox() {
  const [conversations, setConversations] = useState([]);
  const [stats, setStats] = useState(null);
  const [selected, setSelected] = useState(null);
  const [filter, setFilter] = useState('all');
  const [loading, setLoading] = useState(true);

  const loadData = async () => {
    setLoading(true);
    try {
      const [convList, convStats] = await Promise.all([
        api.getConversations({
          status: filter !== 'all' ? filter : undefined,
          limit: 100
        }),
        api.getConversationStats()
      ]);
      setConversations(convList || []);
      setStats(convStats);
    } catch (err) {
      console.error('Failed to load conversations:', err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadData();
  }, [filter]);

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
        />
      </div>
    </div>
  );
}
