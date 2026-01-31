import { useState, useEffect } from 'react';
import { Settings as SettingsIcon, X, Check, AlertCircle } from 'lucide-react';
import { validateApiKey, setApiKey, getStatus } from '../api/client';

export default function Settings({ isOpen, onClose, onAuthChange }) {
    const [apiKeyInput, setApiKeyInput] = useState('');
    const [status, setStatus] = useState({ loading: true, connected: false, user: null });
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState('');

    useEffect(() => {
        if (isOpen) {
            // Load current API key from localStorage
            const currentKey = localStorage.getItem('apiKey') || '';
            setApiKeyInput(currentKey);
            checkConnection(currentKey);
        }
    }, [isOpen]);

    async function checkConnection(key) {
        setStatus({ loading: true, connected: false, user: null });
        setError('');

        try {
            // Check server status
            const serverStatus = await getStatus();

            if (key) {
                // Validate API key
                const validation = await validateApiKey(key);
                if (validation.valid) {
                    setStatus({
                        loading: false,
                        connected: true,
                        user: validation.user,
                        server: serverStatus
                    });
                } else {
                    setStatus({
                        loading: false,
                        connected: false,
                        user: null,
                        server: serverStatus
                    });
                    setError('Invalid API key');
                }
            } else {
                setStatus({
                    loading: false,
                    connected: true,
                    user: null,
                    server: serverStatus
                });
            }
        } catch (err) {
            setStatus({ loading: false, connected: false, user: null });
            setError('Cannot connect to backend server');
        }
    }

    async function handleSave() {
        setSaving(true);
        setError('');

        try {
            if (apiKeyInput) {
                const validation = await validateApiKey(apiKeyInput);
                if (!validation.valid) {
                    setError('Invalid API key');
                    setSaving(false);
                    return;
                }
            }

            setApiKey(apiKeyInput);
            await checkConnection(apiKeyInput);
            onAuthChange?.();
            onClose();
        } catch (err) {
            setError('Failed to save settings');
        } finally {
            setSaving(false);
        }
    }

    if (!isOpen) return null;

    return (
        <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50">
            <div className="bg-[#1a1a1b] border border-[#343536] rounded-xl w-[400px] max-h-[90vh] overflow-y-auto">
                {/* Header */}
                <div className="flex items-center justify-between p-4 border-b border-[#343536]">
                    <div className="flex items-center gap-2">
                        <SettingsIcon size={20} className="text-[#ff4500]" />
                        <h2 className="text-lg font-semibold text-white">Settings</h2>
                    </div>
                    <button
                        onClick={onClose}
                        className="text-[#818384] hover:text-white transition-colors"
                    >
                        <X size={20} />
                    </button>
                </div>

                {/* Content */}
                <div className="p-4 space-y-4">
                    {/* Connection Status */}
                    <div className="bg-[#272729] rounded-lg p-3">
                        <div className="text-sm text-[#818384] mb-2">Connection Status</div>
                        {status.loading ? (
                            <div className="text-[#818384]">Checking...</div>
                        ) : status.connected ? (
                            <div className="space-y-1">
                                <div className="flex items-center gap-2 text-green-500">
                                    <Check size={16} />
                                    <span>Connected to backend</span>
                                </div>
                                {status.server && (
                                    <div className="text-xs text-[#818384] ml-6">
                                        Database: {status.server.supabaseConfigured ? '✓' : '✗'} |
                                        LLM: {status.server.openrouterConfigured ? '✓' : '✗'}
                                    </div>
                                )}
                                {status.user && (
                                    <div className="text-xs text-[#818384] ml-6">
                                        Logged in as: {status.user.name} ({status.user.role})
                                    </div>
                                )}
                            </div>
                        ) : (
                            <div className="flex items-center gap-2 text-red-500">
                                <AlertCircle size={16} />
                                <span>{error || 'Not connected'}</span>
                            </div>
                        )}
                    </div>

                    {/* API Key Input */}
                    <div>
                        <label className="block text-sm font-medium text-[#d7dadc] mb-2">
                            API Key
                        </label>
                        <input
                            type="password"
                            value={apiKeyInput}
                            onChange={(e) => setApiKeyInput(e.target.value)}
                            placeholder="Enter your API key"
                            className="w-full px-3 py-2 bg-[#272729] border border-[#343536] rounded-lg text-[#d7dadc] placeholder-[#818384] focus:outline-none focus:border-[#ff4500]"
                        />
                        <p className="text-xs text-[#818384] mt-1">
                            Available keys: rig-dev-local-testing-key, rig-demo-key-try-it-out-2024
                        </p>
                    </div>

                    {/* Error Message */}
                    {error && (
                        <div className="text-red-500 text-sm flex items-center gap-2">
                            <AlertCircle size={14} />
                            {error}
                        </div>
                    )}
                </div>

                {/* Footer */}
                <div className="flex justify-end gap-2 p-4 border-t border-[#343536]">
                    <button
                        onClick={onClose}
                        className="px-4 py-2 text-[#818384] hover:text-white transition-colors"
                    >
                        Cancel
                    </button>
                    <button
                        onClick={handleSave}
                        disabled={saving}
                        className="px-4 py-2 bg-[#ff4500] hover:bg-[#ff5722] text-white rounded-lg font-medium transition-colors disabled:opacity-50"
                    >
                        {saving ? 'Saving...' : 'Save'}
                    </button>
                </div>
            </div>
        </div>
    );
}
