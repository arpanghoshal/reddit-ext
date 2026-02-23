import { useState, useEffect } from 'react';
import { Plus, RefreshCw, Shield, AlertTriangle, Trash2, Settings } from 'lucide-react';
import * as api from '../api/client';
import { logError } from '../lib/logger';

const STATUS_COLORS = {
  active: 'bg-green-500/15 text-green-400',
  warming_up: 'bg-yellow-500/15 text-yellow-400',
  paused: 'bg-gray-500/15 text-gray-400',
  shadowbanned: 'bg-red-500/15 text-red-400',
  suspended: 'bg-red-500/20 text-red-400'
};

function AccountCard({ account, onCheckShadowban, onDelete, onUpdate }) {
  const [checking, setChecking] = useState(false);
  const [editing, setEditing] = useState(false);
  const [editDailyLimit, setEditDailyLimit] = useState(account.dailyLimit);
  const [saving, setSaving] = useState(false);

  const handleCheckShadowban = async () => {
    setChecking(true);
    try {
      await onCheckShadowban(account.id);
    } finally {
      setChecking(false);
    }
  };

  const handleToggleWarmup = async () => {
    setSaving(true);
    try {
      await api.updateAccount(account.id, { warmupMode: !account.warmupMode });
      onUpdate();
    } catch (err) {
      logError('Failed to update warmup mode', { component: 'AccountCard', errorName: err?.name, errorStack: err?.stack });
    } finally {
      setSaving(false);
    }
  };

  const handleSaveDailyLimit = async () => {
    setSaving(true);
    try {
      await api.updateAccount(account.id, { dailyLimit: editDailyLimit });
      setEditing(false);
      onUpdate();
    } catch (err) {
      logError('Failed to update daily limit', { component: 'AccountCard', errorName: err?.name, errorStack: err?.stack });
    } finally {
      setSaving(false);
    }
  };

  const progressPercent = account.effectiveDailyLimit > 0
    ? Math.round((account.currentDailyCount / account.effectiveDailyLimit) * 100)
    : 0;

  return (
    <div className="bg-[#141416] rounded-xl p-6">
      <div className="flex items-start justify-between">
        <div>
          <div className="flex items-center gap-3">
            <h3 className="font-semibold text-lg text-white">u/{account.username}</h3>
            <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${STATUS_COLORS[account.status]}`}>
              {account.status}
            </span>
          </div>
          {account.displayName && account.displayName !== account.username && (
            <p className="text-sm text-[#71717a]">{account.displayName}</p>
          )}
        </div>

        <div className="flex gap-2">
          <button
            onClick={handleCheckShadowban}
            disabled={checking}
            className="p-2 text-[#52525b] hover:text-[#a1a1aa] hover:bg-[#1e1e24] rounded-lg"
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
            className="p-2 text-red-400 hover:text-red-400 hover:bg-red-500/10 rounded-lg"
            title="Delete account"
          >
            <Trash2 size={18} />
          </button>
        </div>
      </div>

      {/* Daily Progress */}
      <div className="mt-4">
        <div className="flex items-center justify-between text-sm mb-1">
          <span className="text-[#71717a]">Daily DMs</span>
          <span className="font-medium text-white">
            {account.currentDailyCount} / {account.effectiveDailyLimit}
          </span>
        </div>
        <div className="h-2 bg-[#1e1e24] rounded-full overflow-hidden">
          <div
            className={`h-full rounded-full transition-all ${
              progressPercent >= 90 ? 'bg-red-500' :
              progressPercent >= 70 ? 'bg-yellow-500' : 'bg-green-500'
            }`}
            style={{ width: `${progressPercent}%` }}
          />
        </div>
      </div>

      {/* Warmup Status Toggle */}
      <div className="mt-3 flex items-center justify-between">
        <div className="flex items-center gap-2 text-sm">
          {account.warmupMode ? (
            <>
              <AlertTriangle size={14} className="text-yellow-400" />
              <span className="text-yellow-400">Warmup mode active</span>
            </>
          ) : (
            <span className="text-green-400 font-medium">Fully warmed up</span>
          )}
        </div>
        <button
          onClick={handleToggleWarmup}
          disabled={saving}
          className={`px-3 py-1 text-xs font-medium rounded-full transition-colors ${
            account.warmupMode
              ? 'bg-green-500/15 text-green-400 hover:bg-green-500/25'
              : 'bg-yellow-500/15 text-yellow-400 hover:bg-yellow-500/25'
          }`}
        >
          {saving ? '...' : account.warmupMode ? 'Mark Warmed Up' : 'Set Warming Up'}
        </button>
      </div>

      {/* Stats */}
      <div className="mt-4 pt-4 border-t border-[#23232a] grid grid-cols-2 gap-4 text-sm">
        <div>
          <span className="text-[#71717a]">Daily Limit</span>
          {editing ? (
            <div className="flex items-center gap-1 mt-1">
              <input
                type="number"
                value={editDailyLimit}
                onChange={(e) => setEditDailyLimit(Math.min(50, Math.max(1, parseInt(e.target.value) || 1)))}
                min="1"
                max="50"
                className="w-16 px-2 py-1 bg-[#1e1e24] border border-[#23232a] rounded text-sm text-white focus:ring-2 focus:ring-[#ff4500]/50 focus:border-[#ff4500]"
              />
              <button
                onClick={handleSaveDailyLimit}
                disabled={saving}
                className="px-2 py-1 bg-blue-500 text-white text-xs rounded hover:bg-blue-600"
              >
                Save
              </button>
              <button
                onClick={() => { setEditing(false); setEditDailyLimit(account.dailyLimit); }}
                className="px-2 py-1 text-[#52525b] text-xs hover:text-[#a1a1aa]"
              >
                Cancel
              </button>
            </div>
          ) : (
            <p className="font-medium text-white cursor-pointer hover:text-[#ff4500]" onClick={() => setEditing(true)}>
              {account.dailyLimit} <Settings size={12} className="inline text-[#52525b]" />
            </p>
          )}
        </div>
        <div>
          <span className="text-[#71717a]">Last DM</span>
          <p className="font-medium text-white">
            {account.lastDmAt
              ? new Date(account.lastDmAt).toLocaleTimeString()
              : 'Never'}
          </p>
        </div>
      </div>

      {/* Shadowban Warning */}
      {account.isShadowbanned && (
        <div className="mt-4 p-3 bg-red-500/10 rounded-lg flex items-center gap-2 text-red-400">
          <AlertTriangle size={18} />
          <span className="text-sm font-medium">Shadowban detected!</span>
        </div>
      )}
    </div>
  );
}

function AddAccountModal({ isOpen, onClose, onAdd, onRefresh }) {
  const [username, setUsername] = useState('');
  const [warmupMode, setWarmupMode] = useState(true);
  const [dailyLimit, setDailyLimit] = useState(50);
  const [loading, setLoading] = useState(false);
  const [capturing, setCapturing] = useState(false);
  const [captureStatus, setCaptureStatus] = useState(null);

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!username.trim()) return;

    setLoading(true);
    try {
      await onAdd({ username: username.trim(), warmupMode, dailyLimit });
      setUsername('');
      setWarmupMode(true);
      setDailyLimit(50);
      onClose();
    } catch (err) {
      logError('Failed to add account', { component: 'AddAccountModal', errorName: err?.name, errorStack: err?.stack });
    } finally {
      setLoading(false);
    }
  };

  const handleCapture = async () => {
    setCapturing(true);
    setCaptureStatus('Opening Reddit... The extension will capture cookies and register the account automatically.');

    // Snapshot current account usernames so we can detect new ones
    let existingUsernames = new Set();
    try {
      const current = await api.getAccounts();
      existingUsernames = new Set((current || []).map(a => a.username?.toLowerCase()));
    } catch {}

    // Open Reddit with capture hash — the extension will capture cookies and call the API
    window.open('https://www.reddit.com/#__rdm_capture_cookies', '_blank');

    // Poll the backend for a newly added account
    let pollCount = 0;
    const pollInterval = setInterval(async () => {
      pollCount++;
      if (pollCount > 30) { // 30 seconds timeout
        clearInterval(pollInterval);
        setCapturing(false);
        setCaptureStatus('Capture timed out. Make sure the extension is installed and you are logged into Reddit.');
        return;
      }

      try {
        const accounts = await api.getAccounts();
        const newAccount = (accounts || []).find(
          a => !existingUsernames.has(a.username?.toLowerCase())
        );
        if (newAccount) {
          clearInterval(pollInterval);
          setCapturing(false);
          setCaptureStatus(`Account u/${newAccount.username} added successfully!`);
          if (onRefresh) onRefresh();
          setTimeout(() => onClose(), 1500);
        }
      } catch {
        // Continue polling
      }
    }, 2000);
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
      <div className="bg-[#141416] rounded-xl border border-[#23232a] p-6 w-full max-w-md">
        <h2 className="text-xl font-bold text-white mb-4">Add Reddit Account</h2>

        {/* Capture from Browser */}
        <div className="mb-6 p-4 bg-blue-500/10 border border-blue-500/20 rounded-lg">
          <p className="text-sm font-medium text-blue-400 mb-2">Quick Add (Recommended)</p>
          <p className="text-xs text-blue-400 mb-3">
            Log into the Reddit account you want to add, then click below. The extension will automatically capture the session cookies.
          </p>
          <button
            onClick={handleCapture}
            disabled={capturing}
            className="w-full px-4 py-2 bg-blue-500 text-white rounded-lg hover:bg-blue-600 disabled:opacity-50 text-sm font-medium"
          >
            {capturing ? 'Capturing...' : 'Capture from Browser'}
          </button>
          {captureStatus && (
            <p className="text-xs text-blue-400 mt-2">{captureStatus}</p>
          )}
        </div>

        <div className="relative mb-4">
          <div className="absolute inset-0 flex items-center">
            <div className="w-full border-t border-[#23232a]" />
          </div>
          <div className="relative flex justify-center text-xs">
            <span className="px-2 bg-[#141416] text-[#52525b]">or add manually</span>
          </div>
        </div>

        <form onSubmit={handleSubmit}>
          <div className="mb-4">
            <label className="block text-sm font-medium text-[#d7dadc] mb-1">
              Reddit Username
            </label>
            <input
              type="text"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              placeholder="username"
              className="w-full px-3 py-2 bg-[#1e1e24] border border-[#23232a] rounded-lg text-white focus:ring-2 focus:ring-[#ff4500]/50 focus:border-[#ff4500]"
            />
          </div>
          {/* Warmup Status */}
          <div className="mb-4">
            <label className="block text-sm font-medium text-[#d7dadc] mb-2">
              Warmup Status
            </label>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => setWarmupMode(true)}
                className={`flex-1 px-3 py-2 rounded-lg text-sm font-medium border transition-colors ${
                  warmupMode
                    ? 'bg-yellow-500/15 border-yellow-500/30 text-yellow-400'
                    : 'bg-[#141416] border-[#23232a] text-[#71717a] hover:bg-[#1e1e24]'
                }`}
              >
                Warming Up
              </button>
              <button
                type="button"
                onClick={() => setWarmupMode(false)}
                className={`flex-1 px-3 py-2 rounded-lg text-sm font-medium border transition-colors ${
                  !warmupMode
                    ? 'bg-green-500/15 border-green-500/30 text-green-400'
                    : 'bg-[#141416] border-[#23232a] text-[#71717a] hover:bg-[#1e1e24]'
                }`}
              >
                Already Warmed Up
              </button>
            </div>
            <p className="text-xs text-[#52525b] mt-1">
              {warmupMode
                ? 'DM limits will increase gradually over 8 days.'
                : 'Account will start at full daily limit immediately.'}
            </p>
          </div>

          {/* Daily Limit */}
          <div className="mb-4">
            <label className="block text-sm font-medium text-[#d7dadc] mb-1">
              Daily DM Limit
            </label>
            <input
              type="number"
              value={dailyLimit}
              onChange={(e) => setDailyLimit(Math.min(50, Math.max(1, parseInt(e.target.value) || 1)))}
              min="1"
              max="50"
              className="w-full px-3 py-2 bg-[#1e1e24] border border-[#23232a] rounded-lg text-white focus:ring-2 focus:ring-[#ff4500]/50 focus:border-[#ff4500]"
            />
            <p className="text-xs text-[#52525b] mt-1">Max 50 DMs per day.</p>
          </div>

          <p className="text-xs text-[#52525b] mb-4">
            Manual accounts won't have cookies — you'll need to capture them later for automation to work.
          </p>
          <div className="flex justify-end gap-3">
            <button
              type="button"
              onClick={() => { onClose(); setCaptureStatus(null); }}
              className="px-4 py-2 text-[#a1a1aa] hover:text-white"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={loading || !username.trim()}
              className="px-4 py-2 bg-[#23232a] text-[#d7dadc] rounded-lg hover:bg-[#2a2a31] disabled:opacity-50"
            >
              {loading ? 'Adding...' : 'Add Manually'}
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
      logError('Failed to load accounts', { component: 'Accounts', errorName: err?.name, errorStack: err?.stack });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadData();
    const interval = setInterval(loadData, 15000);
    const onVisible = () => {
      if (document.visibilityState === 'visible') loadData();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      clearInterval(interval);
      document.removeEventListener('visibilitychange', onVisible);
    };
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
      {/* Multi-account notice */}
      <div className="mb-4 p-3 bg-blue-500/10 border border-blue-500/20 rounded-lg text-sm text-blue-400">
        The extension detects which Reddit account is logged in and tags DMs accordingly. To send from a different account, log into it on Reddit first. Reply queue items assigned to another account will be skipped until you switch.
      </div>

      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-white">Accounts</h1>
          <p className="text-[#71717a]">Manage your Reddit accounts</p>
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
        <div className="bg-[#141416] rounded-xl p-6 mb-6">
          <h2 className="text-lg font-semibold text-white mb-4">Rotation Status</h2>
          <div className="grid grid-cols-5 gap-4 text-center">
            <div>
              <p className="text-2xl font-bold text-white">{rotationStatus.total}</p>
              <p className="text-sm text-[#71717a]">Total</p>
            </div>
            <div>
              <p className="text-2xl font-bold text-green-400">{rotationStatus.available}</p>
              <p className="text-sm text-[#71717a]">Available</p>
            </div>
            <div>
              <p className="text-2xl font-bold text-red-400">{rotationStatus.atLimit}</p>
              <p className="text-sm text-[#71717a]">At Limit</p>
            </div>
            <div>
              <p className="text-2xl font-bold text-yellow-400">{rotationStatus.onCooldown}</p>
              <p className="text-sm text-[#71717a]">Cooldown</p>
            </div>
            <div>
              <p className="text-2xl font-bold text-purple-400">{rotationStatus.warmingUp}</p>
              <p className="text-sm text-[#71717a]">Warming Up</p>
            </div>
          </div>
        </div>
      )}

      {/* Accounts Grid */}
      {loading ? (
        <div className="text-center py-12 text-[#52525b]">
          <RefreshCw className="animate-spin mx-auto mb-4" size={32} />
          Loading...
        </div>
      ) : accounts.length === 0 ? (
        <div className="text-center py-12 bg-[#141416] rounded-xl">
          <p className="text-[#52525b] mb-4">No accounts added yet</p>
          <button
            onClick={() => setShowAddModal(true)}
            className="text-[#ff4500] hover:text-[#ff5414]"
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
        onRefresh={loadData}
      />
    </div>
  );
}
