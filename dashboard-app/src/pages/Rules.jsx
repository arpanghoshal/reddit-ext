import { useState, useEffect } from 'react';
import { Plus, RefreshCw, Trash2, Edit2, Check, X, Zap } from 'lucide-react';
import * as api from '../api/client';

const RULE_TYPE_LABELS = {
  keyword_skip: 'Skip Keywords',
  keyword_require: 'Require Keywords',
  karma_min: 'Minimum Karma',
  account_age_min: 'Minimum Account Age',
  subreddit_blacklist: 'Subreddit Blacklist',
  subreddit_whitelist: 'Subreddit Whitelist',
  relevance_score_min: 'Minimum Relevance Score'
};

function RuleCard({ rule, onDelete, onToggle }) {
  const getValueDisplay = () => {
    switch (rule.ruleType) {
      case 'keyword_skip':
      case 'keyword_require':
        return rule.value.keywords?.join(', ') || 'No keywords';
      case 'subreddit_blacklist':
      case 'subreddit_whitelist':
        return rule.value.subreddits?.map(s => `r/${s}`).join(', ') || 'No subreddits';
      case 'karma_min':
      case 'account_age_min':
      case 'relevance_score_min':
        return rule.value.threshold;
      default:
        return JSON.stringify(rule.value);
    }
  };

  return (
    <div className={`bg-white rounded-xl shadow-sm p-6 border-l-4 ${
      rule.isActive ? 'border-green-500' : 'border-gray-300'
    }`}>
      <div className="flex items-start justify-between">
        <div className="flex-1">
          <div className="flex items-center gap-3">
            <h3 className="font-semibold">{rule.name}</h3>
            <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${
              rule.isActive
                ? 'bg-green-100 text-green-800'
                : 'bg-gray-100 text-gray-800'
            }`}>
              {rule.isActive ? 'Active' : 'Inactive'}
            </span>
          </div>
          <p className="text-sm text-gray-500 mt-1">
            {RULE_TYPE_LABELS[rule.ruleType] || rule.ruleType}
          </p>
          {rule.description && (
            <p className="text-sm text-gray-400 mt-1">{rule.description}</p>
          )}
        </div>

        <div className="flex gap-2">
          <button
            onClick={() => onToggle(rule.id, !rule.isActive)}
            className={`p-2 rounded-lg ${
              rule.isActive
                ? 'text-green-600 hover:bg-green-50'
                : 'text-gray-400 hover:bg-gray-100'
            }`}
            title={rule.isActive ? 'Disable' : 'Enable'}
          >
            {rule.isActive ? <Check size={18} /> : <X size={18} />}
          </button>
          <button
            onClick={() => onDelete(rule.id)}
            className="p-2 text-red-400 hover:text-red-600 hover:bg-red-50 rounded-lg"
            title="Delete"
          >
            <Trash2 size={18} />
          </button>
        </div>
      </div>

      <div className="mt-4 p-3 bg-gray-50 rounded-lg">
        <p className="text-sm font-medium text-gray-700">Value:</p>
        <p className="text-sm text-gray-600 mt-1">{getValueDisplay()}</p>
      </div>

      {rule.priority > 0 && (
        <p className="text-xs text-gray-400 mt-3">Priority: {rule.priority}</p>
      )}
    </div>
  );
}

function CreateRuleModal({ isOpen, onClose, onCreate, templates }) {
  const [name, setName] = useState('');
  const [ruleType, setRuleType] = useState('keyword_skip');
  const [value, setValue] = useState('');
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!name.trim()) return;

    setLoading(true);
    try {
      let parsedValue;
      switch (ruleType) {
        case 'keyword_skip':
        case 'keyword_require':
          parsedValue = { keywords: value.split(',').map(k => k.trim()).filter(Boolean) };
          break;
        case 'subreddit_blacklist':
        case 'subreddit_whitelist':
          parsedValue = { subreddits: value.split(',').map(s => s.trim().replace(/^r\//, '')).filter(Boolean) };
          break;
        case 'karma_min':
        case 'account_age_min':
        case 'relevance_score_min':
          parsedValue = { threshold: parseInt(value) || 0 };
          break;
        default:
          parsedValue = { value };
      }

      await onCreate({ name, ruleType, value: parsedValue });
      setName('');
      setValue('');
      onClose();
    } catch (err) {
      console.error('Failed to create rule:', err);
    } finally {
      setLoading(false);
    }
  };

  const applyTemplate = (template) => {
    setName(template.name);
    setRuleType(template.ruleType);
    if (template.value.keywords) {
      setValue(template.value.keywords.join(', '));
    } else if (template.value.subreddits) {
      setValue(template.value.subreddits.join(', '));
    } else if (template.value.threshold !== undefined) {
      setValue(template.value.threshold.toString());
    }
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
      <div className="bg-white rounded-xl shadow-xl p-6 w-full max-w-lg">
        <h2 className="text-xl font-bold mb-4">Create Rule</h2>

        {/* Quick Templates */}
        {templates && templates.length > 0 && (
          <div className="mb-4">
            <p className="text-sm font-medium text-gray-700 mb-2">Quick Templates:</p>
            <div className="flex flex-wrap gap-2">
              {templates.map((t, i) => (
                <button
                  key={i}
                  onClick={() => applyTemplate(t)}
                  className="px-3 py-1 bg-gray-100 text-gray-700 rounded-lg text-sm hover:bg-gray-200"
                >
                  {t.name}
                </button>
              ))}
            </div>
          </div>
        )}

        <form onSubmit={handleSubmit}>
          <div className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Rule Name
              </label>
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g., Skip Hiring Posts"
                className="w-full px-3 py-2 border border-gray-300 rounded-lg"
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Rule Type
              </label>
              <select
                value={ruleType}
                onChange={(e) => setRuleType(e.target.value)}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg"
              >
                {Object.entries(RULE_TYPE_LABELS).map(([key, label]) => (
                  <option key={key} value={key}>{label}</option>
                ))}
              </select>
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Value
                <span className="font-normal text-gray-400 ml-2">
                  {ruleType.includes('keyword') || ruleType.includes('subreddit')
                    ? '(comma-separated)'
                    : '(number)'}
                </span>
              </label>
              <input
                type={ruleType.includes('min') ? 'number' : 'text'}
                value={value}
                onChange={(e) => setValue(e.target.value)}
                placeholder={
                  ruleType.includes('keyword') ? 'hiring, job posting, we are hiring' :
                  ruleType.includes('subreddit') ? 'spam, test, bots' :
                  '100'
                }
                className="w-full px-3 py-2 border border-gray-300 rounded-lg"
              />
            </div>
          </div>

          <div className="flex justify-end gap-3 mt-6">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 text-gray-600 hover:text-gray-800"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={loading || !name.trim()}
              className="px-4 py-2 bg-blue-500 text-white rounded-lg hover:bg-blue-600 disabled:opacity-50"
            >
              {loading ? 'Creating...' : 'Create Rule'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

export default function Rules() {
  const [rules, setRules] = useState([]);
  const [templates, setTemplates] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showCreateModal, setShowCreateModal] = useState(false);

  const loadData = async () => {
    setLoading(true);
    try {
      const [ruleList, templateList] = await Promise.all([
        api.getRules(),
        api.getRuleTemplates()
      ]);
      setRules(ruleList || []);
      setTemplates(templateList || []);
    } catch (err) {
      console.error('Failed to load rules:', err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadData();
  }, []);

  const handleCreateRule = async (data) => {
    await api.createRule(data);
    loadData();
  };

  const handleDeleteRule = async (id) => {
    if (!confirm('Are you sure you want to delete this rule?')) return;
    await api.deleteRule(id);
    loadData();
  };

  const handleToggleRule = async (id, isActive) => {
    await api.updateRule(id, { isActive });
    loadData();
  };

  const activeRules = rules.filter(r => r.isActive);
  const inactiveRules = rules.filter(r => !r.isActive);

  return (
    <div className="p-6">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Filter Rules</h1>
          <p className="text-gray-500">Configure rules to filter posts and users</p>
        </div>
        <button
          onClick={() => setShowCreateModal(true)}
          className="flex items-center gap-2 px-4 py-2 bg-blue-500 text-white rounded-lg hover:bg-blue-600"
        >
          <Plus size={18} />
          Create Rule
        </button>
      </div>

      {/* Rules */}
      {loading ? (
        <div className="text-center py-12 text-gray-400">
          <RefreshCw className="animate-spin mx-auto mb-4" size={32} />
          Loading...
        </div>
      ) : rules.length === 0 ? (
        <div className="text-center py-12 bg-white rounded-xl">
          <Zap className="mx-auto text-gray-300 mb-4" size={48} />
          <p className="text-gray-400 mb-4">No rules configured yet</p>
          <button
            onClick={() => setShowCreateModal(true)}
            className="text-blue-500 hover:text-blue-600"
          >
            Create your first rule
          </button>
        </div>
      ) : (
        <div className="space-y-6">
          {/* Active Rules */}
          {activeRules.length > 0 && (
            <div>
              <h2 className="text-lg font-semibold mb-3 flex items-center gap-2">
                <Check className="text-green-500" size={20} />
                Active Rules ({activeRules.length})
              </h2>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                {activeRules.map(rule => (
                  <RuleCard
                    key={rule.id}
                    rule={rule}
                    onDelete={handleDeleteRule}
                    onToggle={handleToggleRule}
                  />
                ))}
              </div>
            </div>
          )}

          {/* Inactive Rules */}
          {inactiveRules.length > 0 && (
            <div>
              <h2 className="text-lg font-semibold mb-3 flex items-center gap-2 text-gray-500">
                <X size={20} />
                Inactive Rules ({inactiveRules.length})
              </h2>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                {inactiveRules.map(rule => (
                  <RuleCard
                    key={rule.id}
                    rule={rule}
                    onDelete={handleDeleteRule}
                    onToggle={handleToggleRule}
                  />
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {/* Create Modal */}
      <CreateRuleModal
        isOpen={showCreateModal}
        onClose={() => setShowCreateModal(false)}
        onCreate={handleCreateRule}
        templates={templates}
      />
    </div>
  );
}
