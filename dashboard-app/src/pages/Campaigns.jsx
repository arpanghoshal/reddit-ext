import { useState, useEffect } from 'react';
import { Target, Plus, Edit2, Trash2, Play, Pause, RefreshCw, X, TrendingUp, MessageSquare, Users, CheckCircle } from 'lucide-react';
import * as api from '../api/client';

const STATUS_COLORS = {
  draft: 'bg-gray-500/20 text-gray-400',
  active: 'bg-green-500/20 text-green-400',
  paused: 'bg-yellow-500/20 text-yellow-400',
  completed: 'bg-blue-500/20 text-blue-400',
  archived: 'bg-[#343536] text-[#818384]'
};

const TONE_OPTIONS = ['Curious', 'Helpful', 'Casual', 'Professional', 'Friendly', 'Direct'];

function CampaignCard({ campaign, onEdit, onDelete, onToggleStatus }) {
  const replyRate = campaign.totalDms > 0
    ? Math.round((campaign.repliesReceived / campaign.totalDms) * 100)
    : 0;

  return (
    <div className="bg-[#1a1a1b] rounded-xl p-6 border border-[#343536] hover:border-[#ff4500]/50 transition-colors">
      <div className="flex items-start justify-between mb-4">
        <div>
          <h3 className="text-lg font-semibold text-white">{campaign.name}</h3>
          {campaign.description && (
            <p className="text-[#818384] text-sm mt-1">{campaign.description}</p>
          )}
        </div>
        <span className={`px-2 py-1 rounded-full text-xs font-medium ${STATUS_COLORS[campaign.status] || STATUS_COLORS.draft}`}>
          {campaign.status}
        </span>
      </div>

      {/* Subreddits */}
      {campaign.subreddits && campaign.subreddits.length > 0 && (
        <div className="flex flex-wrap gap-1 mb-4">
          {campaign.subreddits.slice(0, 5).map(sub => (
            <span key={sub} className="px-2 py-0.5 bg-[#ff4500]/20 text-[#ff4500] rounded text-xs">
              r/{sub}
            </span>
          ))}
          {campaign.subreddits.length > 5 && (
            <span className="px-2 py-0.5 bg-[#343536] text-[#818384] rounded text-xs">
              +{campaign.subreddits.length - 5} more
            </span>
          )}
        </div>
      )}

      {/* Stats */}
      <div className="grid grid-cols-4 gap-4 mb-4">
        <div className="text-center">
          <div className="text-xl font-bold text-white">{campaign.totalScanned || 0}</div>
          <div className="text-xs text-[#818384]">Scanned</div>
        </div>
        <div className="text-center">
          <div className="text-xl font-bold text-white">{campaign.totalDms || 0}</div>
          <div className="text-xs text-[#818384]">DMs Sent</div>
        </div>
        <div className="text-center">
          <div className="text-xl font-bold text-white">{campaign.repliesReceived || 0}</div>
          <div className="text-xs text-[#818384]">Replies</div>
        </div>
        <div className="text-center">
          <div className="text-xl font-bold text-green-400">{replyRate}%</div>
          <div className="text-xs text-[#818384]">Reply Rate</div>
        </div>
      </div>

      {/* Actions */}
      <div className="flex gap-2 pt-4 border-t border-[#343536]">
        {campaign.status === 'active' ? (
          <button
            onClick={() => onToggleStatus(campaign.id, 'paused')}
            className="flex-1 flex items-center justify-center gap-2 px-3 py-2 bg-yellow-500/20 text-yellow-400 rounded-lg hover:bg-yellow-500/30 transition-colors"
          >
            <Pause size={16} />
            Pause
          </button>
        ) : campaign.status !== 'completed' && campaign.status !== 'archived' && (
          <button
            onClick={() => onToggleStatus(campaign.id, 'active')}
            className="flex-1 flex items-center justify-center gap-2 px-3 py-2 bg-green-500/20 text-green-400 rounded-lg hover:bg-green-500/30 transition-colors"
          >
            <Play size={16} />
            Activate
          </button>
        )}
        <button
          onClick={() => onEdit(campaign)}
          className="flex items-center justify-center gap-2 px-3 py-2 bg-[#272729] text-[#d7dadc] rounded-lg hover:bg-[#343536] transition-colors"
        >
          <Edit2 size={16} />
        </button>
        <button
          onClick={() => onDelete(campaign.id)}
          className="flex items-center justify-center gap-2 px-3 py-2 bg-red-500/20 text-red-400 rounded-lg hover:bg-red-500/30 transition-colors"
        >
          <Trash2 size={16} />
        </button>
      </div>
    </div>
  );
}

function CreateCampaignModal({ isOpen, onClose, onSave, editingCampaign }) {
  const [formData, setFormData] = useState({
    name: '',
    description: '',
    subreddits: [],
    messageTone: 'Curious',
    targetPersona: '',
    businessContext: ''
  });
  const [subredditInput, setSubredditInput] = useState('');
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (editingCampaign) {
      setFormData({
        name: editingCampaign.name || '',
        description: editingCampaign.description || '',
        subreddits: editingCampaign.subreddits || [],
        messageTone: editingCampaign.messageTone || 'Curious',
        targetPersona: editingCampaign.targetPersona || '',
        businessContext: editingCampaign.businessContext || ''
      });
    } else {
      setFormData({
        name: '',
        description: '',
        subreddits: [],
        messageTone: 'Curious',
        targetPersona: '',
        businessContext: ''
      });
    }
  }, [editingCampaign, isOpen]);

  const handleAddSubreddit = () => {
    const sub = subredditInput.trim().replace(/^r\//, '');
    if (sub && !formData.subreddits.includes(sub)) {
      setFormData(prev => ({
        ...prev,
        subreddits: [...prev.subreddits, sub]
      }));
      setSubredditInput('');
    }
  };

  const handleRemoveSubreddit = (sub) => {
    setFormData(prev => ({
      ...prev,
      subreddits: prev.subreddits.filter(s => s !== sub)
    }));
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!formData.name.trim()) return;

    setLoading(true);
    try {
      await onSave(formData, editingCampaign?.id);
      onClose();
    } finally {
      setLoading(false);
    }
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4">
      <div className="bg-[#1a1a1b] rounded-xl w-full max-w-lg max-h-[90vh] overflow-y-auto border border-[#343536]">
        <div className="flex items-center justify-between p-4 border-b border-[#343536]">
          <h2 className="text-lg font-semibold text-white">
            {editingCampaign ? 'Edit Campaign' : 'Create Campaign'}
          </h2>
          <button onClick={onClose} className="text-[#818384] hover:text-white">
            <X size={20} />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="p-4 space-y-4">
          <div>
            <label className="block text-sm font-medium text-[#d7dadc] mb-1">
              Campaign Name *
            </label>
            <input
              type="text"
              value={formData.name}
              onChange={e => setFormData(prev => ({ ...prev, name: e.target.value }))}
              placeholder="e.g., SaaS Founders Outreach"
              required
              className="w-full px-4 py-2 bg-[#272729] border border-[#343536] rounded-lg text-white placeholder-[#818384] focus:border-[#ff4500] focus:outline-none"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-[#d7dadc] mb-1">
              Description
            </label>
            <textarea
              value={formData.description}
              onChange={e => setFormData(prev => ({ ...prev, description: e.target.value }))}
              placeholder="Brief description of this campaign..."
              rows={2}
              className="w-full px-4 py-2 bg-[#272729] border border-[#343536] rounded-lg text-white placeholder-[#818384] focus:border-[#ff4500] focus:outline-none resize-none"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-[#d7dadc] mb-1">
              Target Subreddits
            </label>
            <div className="flex gap-2 mb-2">
              <input
                type="text"
                value={subredditInput}
                onChange={e => setSubredditInput(e.target.value)}
                onKeyPress={e => e.key === 'Enter' && (e.preventDefault(), handleAddSubreddit())}
                placeholder="e.g., startups"
                className="flex-1 px-4 py-2 bg-[#272729] border border-[#343536] rounded-lg text-white placeholder-[#818384] focus:border-[#ff4500] focus:outline-none"
              />
              <button
                type="button"
                onClick={handleAddSubreddit}
                className="px-4 py-2 bg-[#ff4500] text-white rounded-lg hover:bg-[#ff5414]"
              >
                Add
              </button>
            </div>
            {formData.subreddits.length > 0 && (
              <div className="flex flex-wrap gap-2">
                {formData.subreddits.map(sub => (
                  <span
                    key={sub}
                    className="flex items-center gap-1 px-2 py-1 bg-[#ff4500]/20 text-[#ff4500] rounded text-sm"
                  >
                    r/{sub}
                    <button
                      type="button"
                      onClick={() => handleRemoveSubreddit(sub)}
                      className="hover:text-white"
                    >
                      <X size={14} />
                    </button>
                  </span>
                ))}
              </div>
            )}
          </div>

          <div>
            <label className="block text-sm font-medium text-[#d7dadc] mb-1">
              Message Tone
            </label>
            <div className="flex flex-wrap gap-2">
              {TONE_OPTIONS.map(tone => (
                <button
                  key={tone}
                  type="button"
                  onClick={() => setFormData(prev => ({ ...prev, messageTone: tone }))}
                  className={`px-3 py-1 rounded text-sm font-medium transition-colors ${
                    formData.messageTone === tone
                      ? 'bg-[#ff4500] text-white'
                      : 'bg-[#272729] text-[#d7dadc] hover:bg-[#343536]'
                  }`}
                >
                  {tone}
                </button>
              ))}
            </div>
          </div>

          <div>
            <label className="block text-sm font-medium text-[#d7dadc] mb-1">
              Target Persona
            </label>
            <textarea
              value={formData.targetPersona}
              onChange={e => setFormData(prev => ({ ...prev, targetPersona: e.target.value }))}
              placeholder="Describe who you're trying to reach..."
              rows={2}
              className="w-full px-4 py-2 bg-[#272729] border border-[#343536] rounded-lg text-white placeholder-[#818384] focus:border-[#ff4500] focus:outline-none resize-none"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-[#d7dadc] mb-1">
              Business Context
            </label>
            <textarea
              value={formData.businessContext}
              onChange={e => setFormData(prev => ({ ...prev, businessContext: e.target.value }))}
              placeholder="What are you offering or promoting?"
              rows={2}
              className="w-full px-4 py-2 bg-[#272729] border border-[#343536] rounded-lg text-white placeholder-[#818384] focus:border-[#ff4500] focus:outline-none resize-none"
            />
          </div>

          <div className="flex gap-3 pt-4">
            <button
              type="button"
              onClick={onClose}
              className="flex-1 px-4 py-2 bg-[#272729] text-[#d7dadc] rounded-lg hover:bg-[#343536] transition-colors"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={loading || !formData.name.trim()}
              className="flex-1 px-4 py-2 bg-[#ff4500] text-white rounded-lg hover:bg-[#ff5414] disabled:opacity-50 transition-colors"
            >
              {loading ? 'Saving...' : editingCampaign ? 'Update Campaign' : 'Create Campaign'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

export default function Campaigns() {
  const [campaigns, setCampaigns] = useState([]);
  const [loading, setLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState('');
  const [modalOpen, setModalOpen] = useState(false);
  const [editingCampaign, setEditingCampaign] = useState(null);

  useEffect(() => {
    loadCampaigns();
  }, [statusFilter]);

  const loadCampaigns = async () => {
    setLoading(true);
    try {
      const filters = statusFilter ? { status: statusFilter } : {};
      const data = await api.getCampaigns(filters);
      setCampaigns(data || []);
    } catch (err) {
      console.error('Failed to load campaigns:', err);
    } finally {
      setLoading(false);
    }
  };

  const handleSave = async (formData, campaignId) => {
    try {
      if (campaignId) {
        await api.updateCampaign(campaignId, formData);
      } else {
        await api.createCampaign(formData);
      }
      loadCampaigns();
    } catch (err) {
      console.error('Failed to save campaign:', err);
    }
  };

  const handleDelete = async (id) => {
    if (!confirm('Are you sure you want to delete this campaign?')) return;

    try {
      await api.deleteCampaign(id);
      loadCampaigns();
    } catch (err) {
      console.error('Failed to delete campaign:', err);
    }
  };

  const handleToggleStatus = async (id, newStatus) => {
    try {
      await api.updateCampaign(id, { status: newStatus });
      loadCampaigns();
    } catch (err) {
      console.error('Failed to update campaign status:', err);
    }
  };

  const handleEdit = (campaign) => {
    setEditingCampaign(campaign);
    setModalOpen(true);
  };

  const handleCloseModal = () => {
    setModalOpen(false);
    setEditingCampaign(null);
  };

  // Calculate totals
  const totals = campaigns.reduce((acc, c) => ({
    scanned: acc.scanned + (c.totalScanned || 0),
    dms: acc.dms + (c.totalDms || 0),
    replies: acc.replies + (c.repliesReceived || 0),
    conversions: acc.conversions + (c.conversions || 0)
  }), { scanned: 0, dms: 0, replies: 0, conversions: 0 });

  return (
    <div className="p-6">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-3">
          <Target className="text-[#ff4500]" size={28} />
          <div>
            <h1 className="text-2xl font-bold text-white">Campaigns</h1>
            <p className="text-[#818384] text-sm">Organize and track your outreach campaigns</p>
          </div>
        </div>
        <div className="flex items-center gap-3">
          <button
            onClick={loadCampaigns}
            className="p-2 text-[#818384] hover:text-white hover:bg-[#272729] rounded-lg transition-colors"
          >
            <RefreshCw size={20} className={loading ? 'animate-spin' : ''} />
          </button>
          <button
            onClick={() => setModalOpen(true)}
            className="flex items-center gap-2 px-4 py-2 bg-[#ff4500] text-white rounded-lg hover:bg-[#ff5414] transition-colors"
          >
            <Plus size={18} />
            New Campaign
          </button>
        </div>
      </div>

      {/* Summary Stats */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6">
        <div className="bg-[#1a1a1b] rounded-xl p-4 border border-[#343536]">
          <div className="flex items-center gap-3">
            <div className="p-2 bg-blue-500/20 rounded-lg">
              <Users className="text-blue-400" size={20} />
            </div>
            <div>
              <div className="text-2xl font-bold text-white">{totals.scanned}</div>
              <div className="text-sm text-[#818384]">Total Scanned</div>
            </div>
          </div>
        </div>
        <div className="bg-[#1a1a1b] rounded-xl p-4 border border-[#343536]">
          <div className="flex items-center gap-3">
            <div className="p-2 bg-[#ff4500]/20 rounded-lg">
              <MessageSquare className="text-[#ff4500]" size={20} />
            </div>
            <div>
              <div className="text-2xl font-bold text-white">{totals.dms}</div>
              <div className="text-sm text-[#818384]">DMs Sent</div>
            </div>
          </div>
        </div>
        <div className="bg-[#1a1a1b] rounded-xl p-4 border border-[#343536]">
          <div className="flex items-center gap-3">
            <div className="p-2 bg-green-500/20 rounded-lg">
              <TrendingUp className="text-green-400" size={20} />
            </div>
            <div>
              <div className="text-2xl font-bold text-white">{totals.replies}</div>
              <div className="text-sm text-[#818384]">Replies</div>
            </div>
          </div>
        </div>
        <div className="bg-[#1a1a1b] rounded-xl p-4 border border-[#343536]">
          <div className="flex items-center gap-3">
            <div className="p-2 bg-purple-500/20 rounded-lg">
              <CheckCircle className="text-purple-400" size={20} />
            </div>
            <div>
              <div className="text-2xl font-bold text-white">{totals.conversions}</div>
              <div className="text-sm text-[#818384]">Conversions</div>
            </div>
          </div>
        </div>
      </div>

      {/* Filters */}
      <div className="flex gap-2 mb-6">
        {['', 'draft', 'active', 'paused', 'completed'].map(status => (
          <button
            key={status}
            onClick={() => setStatusFilter(status)}
            className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
              statusFilter === status
                ? 'bg-[#ff4500] text-white'
                : 'bg-[#272729] text-[#d7dadc] hover:bg-[#343536]'
            }`}
          >
            {status || 'All'}
          </button>
        ))}
      </div>

      {/* Campaign Grid */}
      {loading && campaigns.length === 0 ? (
        <div className="text-center py-12">
          <RefreshCw className="animate-spin mx-auto text-[#818384] mb-4" size={32} />
          <p className="text-[#818384]">Loading campaigns...</p>
        </div>
      ) : campaigns.length === 0 ? (
        <div className="text-center py-12 bg-[#1a1a1b] rounded-xl border border-[#343536]">
          <Target className="mx-auto text-[#818384] mb-4" size={48} />
          <h3 className="text-lg font-semibold text-white mb-2">No campaigns yet</h3>
          <p className="text-[#818384] mb-4">Create your first campaign to start organizing your outreach</p>
          <button
            onClick={() => setModalOpen(true)}
            className="px-4 py-2 bg-[#ff4500] text-white rounded-lg hover:bg-[#ff5414] transition-colors"
          >
            Create Campaign
          </button>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {campaigns.map(campaign => (
            <CampaignCard
              key={campaign.id}
              campaign={campaign}
              onEdit={handleEdit}
              onDelete={handleDelete}
              onToggleStatus={handleToggleStatus}
            />
          ))}
        </div>
      )}

      {/* Create/Edit Modal */}
      <CreateCampaignModal
        isOpen={modalOpen}
        onClose={handleCloseModal}
        onSave={handleSave}
        editingCampaign={editingCampaign}
      />
    </div>
  );
}
