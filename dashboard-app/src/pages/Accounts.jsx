import { useState, useEffect } from 'react';
import { Plus, RefreshCw, Shield, AlertTriangle, Trash2, Settings } from 'lucide-react';
import * as api from '../api/client';

const STATUS_COLORS = {
  active: 'bg-green-100 text-green-800',
  warming_up: 'bg-yellow-100 text-yellow-800',
  paused: 'bg-gray-100 text-gray-800',
  shadowbanned: 'bg-red-100 text-red-800',
  suspended: 'bg-red-200 text-red-900'
};

function AccountCard({ account, onCheckShadowban, onDelete, onUpdate }) {
  const [checking, setChecking] = useState(false);

  const handleCheckShadowban = async () => {
    setChecking(true);
    try {
      await onCheckShadowban(account.id);
    } finally {
      setChecking(false);
    }
  };

  const progressPercent = account.effectiveDailyLimit > 0
    ? Math.round((account.currentDailyCount / account.effectiveDailyLimit) * 100)
    : 0;

  return (
    <div className="bg-white rounded-xl shadow-sm p-6">
      <div className="flex items-start justify-between">
        <div>
          <div className="flex items-center gap-3">
            <h3 className="font-semibold text-lg">u/{account.username}</h3>
            <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${STATUS_COLORS[account.status]}`}>
              {account.status}
            </span>
          </div>
          {account.displayName && account.displayName !== account.username && (
            <p className="text-sm text-gray-500">{account.displayName}</p>
          )}
        </div>

        <div className="flex gap-2">
          <button
            onClick={handleCheckShadowban}
            disabled={checking}
            className="p-2 text-gray-400 hover:text-gray-600 hover:bg-gray-100 rounded-lg"
            title="Check shadowban"
          >
            {checking ? (
              <RefreshCw size={18} className="animate-spin" />
            ) : (
              <Shield size={18} />
            )}
          </button>
          <button
            onClick={() => onDelete(account.id)}
            className="p-2 text-red-400 hover:text-red-600 hover:bg-red-50 rounded-lg"
            title="Delete account"
          >
            <Trash2 size={18} />
          </button>
        </div>
      </div>

      {/* Daily Progress */}
      <div className="mt-4">
        <div className="flex items-center justify-between text-sm mb-1">
          <span className="text-gray-500">Daily DMs</span>
          <span className="font-medium">
            {account.currentDailyCount} / {account.effectiveDailyLimit}
          </span>
        </div>
        <div className="h-2 bg-gray-100 rounded-full overflow-hidden">
          <div
            className={`h-full rounded-full transition-all ${
              progressPercent >= 90 ? 'bg-red-500' :
              progressPercent >= 70 ? 'bg-yellow-500' : 'bg-green-500'
            }`}
            style={{ width: `${progressPercent}%` }}
          />
        </div>
      </div>

      {/* Warmup Status */}
      {account.warmupMode && (
        <div className="mt-3 flex items-center gap-2 text-sm text-yellow-600">
          <AlertTriangle size={14} />
          <span>Warmup mode active</span>
        </div>
      )}

      {/* Stats */}
      <div className="mt-4 pt-4 border-t border-gray-100 grid grid-cols-2 gap-4 text-sm">
        <div>
          <span className="text-gray-500">Daily Limit</span>
          <p className="font-medium">{account.dailyLimit}</p>
        </div>
        <div>
          <span className="text-gray-500">Last DM</span>
          <p className="font-medium">
            {account.lastDmAt
              ? new Date(account.lastDmAt).toLocaleTimeString()
              : 'Never'}
          </p>
        </div>
      </div>

      {/* Shadowban Warning */}
      {account.isShadowbanned && (
        <div className="mt-4 p-3 bg-red-50 rounded-lg flex items-center gap-2 text-red-700">
          <AlertTriangle size={18} />
          <span className="text-sm font-medium">Shadowban detected!</span>
        </div>
      )}
    </div>
  );
}

function AddAccountModal({ isOpen, onClose, onAdd }) {
  const [username, setUsername] = useState('');
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!username.trim()) return;

    setLoading(true);
    try {
      await onAdd({ username: username.trim() });
      setUsername('');
      onClose();
    } catch (err) {
      console.error('Failed to add account:', err);
    } finally {
      setLoading(false);
    }
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
      <div className="bg-white rounded-xl shadow-xl p-6 w-full max-w-md">
        <h2 className="text-xl font-bold mb-4">Add Reddit Account</h2>
        <form onSubmit={handleSubmit}>
          <div className="mb-4">
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Reddit Username
            </label>
            <input
              type="text"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              placeholder="username"
              className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
            />
          </div>
          <p className="text-sm text-gray-500 mb-4">
            Note: For full automation, you'll need to capture cookies from the extension while logged into this Reddit account.
          </p>
          <div className="flex justify-end gap-3">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 text-gray-600 hover:text-gray-800"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={loading || !username.trim()}
              className="px-4 py-2 bg-blue-500 text-white rounded-lg hover:bg-blue-600 disabled:opacity-50"
            >
              {loading ? 'Adding...' : 'Add Account'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

export default function Accounts() {
  const [accounts, setAccounts] = useState([]);
  const [rotationStatus, setRotationStatus] = useState(null);
  const [loading, setLoading] = useState(true);
  const [showAddModal, setShowAddModal] = useState(false);

  const loadData = async () => {
    setLoading(true);
    try {
      const [accountList, rotation] = await Promise.all([
        api.getAccounts(),
        api.getRotationStatus()
      ]);
      setAccounts(accountList || []);
      setRotationStatus(rotation);
    } catch (err) {
      console.error('Failed to load accounts:', err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadData();
  }, []);

  const handleAddAccount = async (data) => {
    await api.addAccount(data);
    loadData();
  };

  const handleDeleteAccount = async (id) => {
    if (!confirm('Are you sure you want to delete this account?')) return;
    await api.deleteAccount(id);
    loadData();
  };

  const handleCheckShadowban = async (id) => {
    await api.checkShadowban(id);
    loadData();
  };

  return (
    <div className="p-6">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Accounts</h1>
          <p className="text-gray-500">Manage your Reddit accounts</p>
        </div>
        <button
          onClick={() => setShowAddModal(true)}
          className="flex items-center gap-2 px-4 py-2 bg-blue-500 text-white rounded-lg hover:bg-blue-600"
        >
          <Plus size={18} />
          Add Account
        </button>
      </div>

      {/* Rotation Status */}
      {rotationStatus && (
        <div className="bg-white rounded-xl shadow-sm p-6 mb-6">
          <h2 className="text-lg font-semibold mb-4">Rotation Status</h2>
          <div className="grid grid-cols-5 gap-4 text-center">
            <div>
              <p className="text-2xl font-bold text-gray-900">{rotationStatus.total}</p>
              <p className="text-sm text-gray-500">Total</p>
            </div>
            <div>
              <p className="text-2xl font-bold text-green-600">{rotationStatus.available}</p>
              <p className="text-sm text-gray-500">Available</p>
            </div>
            <div>
              <p className="text-2xl font-bold text-red-600">{rotationStatus.atLimit}</p>
              <p className="text-sm text-gray-500">At Limit</p>
            </div>
            <div>
              <p className="text-2xl font-bold text-yellow-600">{rotationStatus.onCooldown}</p>
              <p className="text-sm text-gray-500">Cooldown</p>
            </div>
            <div>
              <p className="text-2xl font-bold text-purple-600">{rotationStatus.warmingUp}</p>
              <p className="text-sm text-gray-500">Warming Up</p>
            </div>
          </div>
        </div>
      )}

      {/* Accounts Grid */}
      {loading ? (
        <div className="text-center py-12 text-gray-400">
          <RefreshCw className="animate-spin mx-auto mb-4" size={32} />
          Loading...
        </div>
      ) : accounts.length === 0 ? (
        <div className="text-center py-12 bg-white rounded-xl">
          <p className="text-gray-400 mb-4">No accounts added yet</p>
          <button
            onClick={() => setShowAddModal(true)}
            className="text-blue-500 hover:text-blue-600"
          >
            Add your first account
          </button>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {accounts.map(account => (
            <AccountCard
              key={account.id}
              account={account}
              onCheckShadowban={handleCheckShadowban}
              onDelete={handleDeleteAccount}
              onUpdate={loadData}
            />
          ))}
        </div>
      )}

      {/* Add Modal */}
      <AddAccountModal
        isOpen={showAddModal}
        onClose={() => setShowAddModal(false)}
        onAdd={handleAddAccount}
      />
    </div>
  );
}
