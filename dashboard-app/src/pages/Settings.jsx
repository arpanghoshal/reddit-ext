import { useState, useEffect } from 'react';
import { Settings as SettingsIcon, Zap, RefreshCw, Save, Check } from 'lucide-react';
import * as api from '../api/client';

const TONE_OPTIONS = ['Curious', 'Helpful', 'Casual', 'Professional', 'Friendly', 'Direct'];

const INSIGHT_TYPE_OPTIONS = [
  { value: 'pain_points', label: 'Pain Points' },
  { value: 'goals', label: 'Goals & Aspirations' },
  { value: 'questions', label: 'Questions Asked' },
  { value: 'frustrations', label: 'Frustrations' },
  { value: 'needs', label: 'Unmet Needs' }
];

const QUEUE_MODE_OPTIONS = [
  { value: 'auto', label: 'Auto', description: 'Send immediately after generation' },
  { value: 'review', label: 'Review', description: 'Queue for manual review before sending' },
  { value: 'manual', label: 'Manual', description: 'Full manual control' }
];

export default function Settings() {
  const [activeTab, setActiveTab] = useState('business');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  // Business settings state
  const [businessSettings, setBusinessSettings] = useState({
    businessDesc: '',
    persona: '',
    tone: 'Curious',
    insightTypes: []
  });

  // Automation settings state
  const [automationSettings, setAutomationSettings] = useState({
    defaultQueueMode: 'review',
    minRelevanceScore: 40,
    allowWeakMatches: true,
    minAccountAgeDays: 30,
    minKarma: 100,
    blockSuspectedBots: true,
    globalDailyLimit: 100,
    delayBetweenDmsMin: 30,
    delayBetweenDmsMax: 180,
    enableSessionBreaks: true,
    sessionBreakAfterMin: 5,
    sessionBreakAfterMax: 15,
    sessionBreakDurationMin: 300,
    sessionBreakDurationMax: 1800,
    typingSpeedMin: 50,
    typingSpeedMax: 150,
    enableTypoSimulation: false
  });

  useEffect(() => {
    loadSettings();
  }, []);

  const loadSettings = async () => {
    setLoading(true);
    try {
      const [userSettings, autoSettings] = await Promise.all([
        api.getUserSettings().catch(() => null),
        api.getAutomationSettings().catch(() => null)
      ]);

      if (userSettings) {
        setBusinessSettings({
          businessDesc: userSettings.business_desc || userSettings.businessDesc || '',
          persona: userSettings.persona || '',
          tone: userSettings.tone || 'Curious',
          insightTypes: userSettings.insight_types || userSettings.insightTypes || []
        });
      }

      if (autoSettings) {
        setAutomationSettings(prev => ({ ...prev, ...autoSettings }));
      }
    } catch (err) {
      console.error('Failed to load settings:', err);
    } finally {
      setLoading(false);
    }
  };

  const handleSave = async () => {
    setSaving(true);
    setSaved(false);
    try {
      if (activeTab === 'business') {
        await api.saveUserSettings(businessSettings);
      } else {
        await api.saveAutomationSettings(automationSettings);
      }
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (err) {
      console.error('Failed to save settings:', err);
    } finally {
      setSaving(false);
    }
  };

  const toggleInsightType = (value) => {
    setBusinessSettings(prev => ({
      ...prev,
      insightTypes: prev.insightTypes.includes(value)
        ? prev.insightTypes.filter(t => t !== value)
        : [...prev.insightTypes, value]
    }));
  };

  if (loading) {
    return (
      <div className="p-6 flex items-center justify-center h-full">
        <RefreshCw className="animate-spin text-gray-400" size={32} />
      </div>
    );
  }

  return (
    <div className="p-6 max-w-4xl mx-auto">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-3">
          <SettingsIcon className="text-[#ff4500]" size={28} />
          <div>
            <h1 className="text-2xl font-bold text-white">Settings</h1>
            <p className="text-[#818384] text-sm">Configure your automation preferences</p>
          </div>
        </div>
        <button
          onClick={handleSave}
          disabled={saving}
          className="flex items-center gap-2 px-4 py-2 bg-[#ff4500] text-white rounded-lg hover:bg-[#ff5414] disabled:opacity-50 transition-colors"
        >
          {saved ? <Check size={18} /> : saving ? <RefreshCw className="animate-spin" size={18} /> : <Save size={18} />}
          {saved ? 'Saved!' : saving ? 'Saving...' : 'Save Changes'}
        </button>
      </div>

      {/* Tabs */}
      <div className="flex gap-2 mb-6 border-b border-[#343536]">
        <button
          onClick={() => setActiveTab('business')}
          className={`px-4 py-3 font-medium transition-colors ${
            activeTab === 'business'
              ? 'text-[#ff4500] border-b-2 border-[#ff4500]'
              : 'text-[#818384] hover:text-white'
          }`}
        >
          <span className="flex items-center gap-2">
            <SettingsIcon size={18} />
            Business Settings
          </span>
        </button>
        <button
          onClick={() => setActiveTab('automation')}
          className={`px-4 py-3 font-medium transition-colors ${
            activeTab === 'automation'
              ? 'text-[#ff4500] border-b-2 border-[#ff4500]'
              : 'text-[#818384] hover:text-white'
          }`}
        >
          <span className="flex items-center gap-2">
            <Zap size={18} />
            Automation Settings
          </span>
        </button>
      </div>

      {/* Business Settings Tab */}
      {activeTab === 'business' && (
        <div className="space-y-6">
          <div className="bg-[#1a1a1b] rounded-xl p-6 border border-[#343536]">
            <h3 className="text-lg font-semibold text-white mb-4">Business Context</h3>

            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-[#d7dadc] mb-2">
                  Business Description
                </label>
                <textarea
                  value={businessSettings.businessDesc}
                  onChange={e => setBusinessSettings(prev => ({ ...prev, businessDesc: e.target.value }))}
                  placeholder="Describe your business, product, or service..."
                  rows={4}
                  className="w-full px-4 py-3 bg-[#272729] border border-[#343536] rounded-lg text-white placeholder-[#818384] focus:border-[#ff4500] focus:outline-none resize-none"
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-[#d7dadc] mb-2">
                  Target Persona
                </label>
                <textarea
                  value={businessSettings.persona}
                  onChange={e => setBusinessSettings(prev => ({ ...prev, persona: e.target.value }))}
                  placeholder="Describe your ideal customer or target audience..."
                  rows={3}
                  className="w-full px-4 py-3 bg-[#272729] border border-[#343536] rounded-lg text-white placeholder-[#818384] focus:border-[#ff4500] focus:outline-none resize-none"
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-[#d7dadc] mb-2">
                  Message Tone
                </label>
                <div className="flex flex-wrap gap-2">
                  {TONE_OPTIONS.map(tone => (
                    <button
                      key={tone}
                      onClick={() => setBusinessSettings(prev => ({ ...prev, tone }))}
                      className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
                        businessSettings.tone === tone
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
                <label className="block text-sm font-medium text-[#d7dadc] mb-2">
                  Insight Types to Extract
                </label>
                <div className="flex flex-wrap gap-2">
                  {INSIGHT_TYPE_OPTIONS.map(option => (
                    <button
                      key={option.value}
                      onClick={() => toggleInsightType(option.value)}
                      className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
                        businessSettings.insightTypes.includes(option.value)
                          ? 'bg-blue-600 text-white'
                          : 'bg-[#272729] text-[#d7dadc] hover:bg-[#343536]'
                      }`}
                    >
                      {option.label}
                    </button>
                  ))}
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Automation Settings Tab */}
      {activeTab === 'automation' && (
        <div className="space-y-6">
          {/* Queue Mode */}
          <div className="bg-[#1a1a1b] rounded-xl p-6 border border-[#343536]">
            <h3 className="text-lg font-semibold text-white mb-4">Queue Mode</h3>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              {QUEUE_MODE_OPTIONS.map(option => (
                <button
                  key={option.value}
                  onClick={() => setAutomationSettings(prev => ({ ...prev, defaultQueueMode: option.value }))}
                  className={`p-4 rounded-lg text-left transition-colors ${
                    automationSettings.defaultQueueMode === option.value
                      ? 'bg-[#ff4500] text-white'
                      : 'bg-[#272729] text-[#d7dadc] hover:bg-[#343536]'
                  }`}
                >
                  <div className="font-semibold">{option.label}</div>
                  <div className={`text-sm mt-1 ${automationSettings.defaultQueueMode === option.value ? 'text-white/80' : 'text-[#818384]'}`}>
                    {option.description}
                  </div>
                </button>
              ))}
            </div>
          </div>

          {/* Filtering */}
          <div className="bg-[#1a1a1b] rounded-xl p-6 border border-[#343536]">
            <h3 className="text-lg font-semibold text-white mb-4">Post & User Filtering</h3>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              <div>
                <label className="block text-sm font-medium text-[#d7dadc] mb-2">
                  Min Relevance Score: {automationSettings.minRelevanceScore}
                </label>
                <input
                  type="range"
                  min="0"
                  max="100"
                  value={automationSettings.minRelevanceScore}
                  onChange={e => setAutomationSettings(prev => ({ ...prev, minRelevanceScore: parseInt(e.target.value) }))}
                  className="w-full accent-[#ff4500]"
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-[#d7dadc] mb-2">
                  Min Account Age (days): {automationSettings.minAccountAgeDays}
                </label>
                <input
                  type="range"
                  min="0"
                  max="365"
                  value={automationSettings.minAccountAgeDays}
                  onChange={e => setAutomationSettings(prev => ({ ...prev, minAccountAgeDays: parseInt(e.target.value) }))}
                  className="w-full accent-[#ff4500]"
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-[#d7dadc] mb-2">
                  Min Karma: {automationSettings.minKarma}
                </label>
                <input
                  type="range"
                  min="0"
                  max="1000"
                  step="10"
                  value={automationSettings.minKarma}
                  onChange={e => setAutomationSettings(prev => ({ ...prev, minKarma: parseInt(e.target.value) }))}
                  className="w-full accent-[#ff4500]"
                />
              </div>

              <div className="flex items-center gap-4">
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={automationSettings.allowWeakMatches}
                    onChange={e => setAutomationSettings(prev => ({ ...prev, allowWeakMatches: e.target.checked }))}
                    className="w-4 h-4 accent-[#ff4500]"
                  />
                  <span className="text-[#d7dadc]">Allow Weak Matches</span>
                </label>

                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={automationSettings.blockSuspectedBots}
                    onChange={e => setAutomationSettings(prev => ({ ...prev, blockSuspectedBots: e.target.checked }))}
                    className="w-4 h-4 accent-[#ff4500]"
                  />
                  <span className="text-[#d7dadc]">Block Suspected Bots</span>
                </label>
              </div>
            </div>
          </div>

          {/* Timing */}
          <div className="bg-[#1a1a1b] rounded-xl p-6 border border-[#343536]">
            <h3 className="text-lg font-semibold text-white mb-4">Timing & Limits</h3>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              <div>
                <label className="block text-sm font-medium text-[#d7dadc] mb-2">
                  Global Daily Limit
                </label>
                <input
                  type="number"
                  value={automationSettings.globalDailyLimit}
                  onChange={e => setAutomationSettings(prev => ({ ...prev, globalDailyLimit: parseInt(e.target.value) || 0 }))}
                  className="w-full px-4 py-2 bg-[#272729] border border-[#343536] rounded-lg text-white focus:border-[#ff4500] focus:outline-none"
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-[#d7dadc] mb-2">
                  Delay Between DMs (seconds)
                </label>
                <div className="flex gap-2 items-center">
                  <input
                    type="number"
                    value={automationSettings.delayBetweenDmsMin}
                    onChange={e => setAutomationSettings(prev => ({ ...prev, delayBetweenDmsMin: parseInt(e.target.value) || 0 }))}
                    className="w-24 px-3 py-2 bg-[#272729] border border-[#343536] rounded-lg text-white focus:border-[#ff4500] focus:outline-none"
                  />
                  <span className="text-[#818384]">to</span>
                  <input
                    type="number"
                    value={automationSettings.delayBetweenDmsMax}
                    onChange={e => setAutomationSettings(prev => ({ ...prev, delayBetweenDmsMax: parseInt(e.target.value) || 0 }))}
                    className="w-24 px-3 py-2 bg-[#272729] border border-[#343536] rounded-lg text-white focus:border-[#ff4500] focus:outline-none"
                  />
                </div>
              </div>
            </div>
          </div>

          {/* Session Breaks */}
          <div className="bg-[#1a1a1b] rounded-xl p-6 border border-[#343536]">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-lg font-semibold text-white">Session Breaks</h3>
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={automationSettings.enableSessionBreaks}
                  onChange={e => setAutomationSettings(prev => ({ ...prev, enableSessionBreaks: e.target.checked }))}
                  className="w-4 h-4 accent-[#ff4500]"
                />
                <span className="text-[#d7dadc]">Enable</span>
              </label>
            </div>

            {automationSettings.enableSessionBreaks && (
              <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                <div>
                  <label className="block text-sm font-medium text-[#d7dadc] mb-2">
                    Break After (DMs)
                  </label>
                  <div className="flex gap-2 items-center">
                    <input
                      type="number"
                      value={automationSettings.sessionBreakAfterMin}
                      onChange={e => setAutomationSettings(prev => ({ ...prev, sessionBreakAfterMin: parseInt(e.target.value) || 0 }))}
                      className="w-20 px-3 py-2 bg-[#272729] border border-[#343536] rounded-lg text-white focus:border-[#ff4500] focus:outline-none"
                    />
                    <span className="text-[#818384]">to</span>
                    <input
                      type="number"
                      value={automationSettings.sessionBreakAfterMax}
                      onChange={e => setAutomationSettings(prev => ({ ...prev, sessionBreakAfterMax: parseInt(e.target.value) || 0 }))}
                      className="w-20 px-3 py-2 bg-[#272729] border border-[#343536] rounded-lg text-white focus:border-[#ff4500] focus:outline-none"
                    />
                  </div>
                </div>

                <div>
                  <label className="block text-sm font-medium text-[#d7dadc] mb-2">
                    Break Duration (seconds)
                  </label>
                  <div className="flex gap-2 items-center">
                    <input
                      type="number"
                      value={automationSettings.sessionBreakDurationMin}
                      onChange={e => setAutomationSettings(prev => ({ ...prev, sessionBreakDurationMin: parseInt(e.target.value) || 0 }))}
                      className="w-24 px-3 py-2 bg-[#272729] border border-[#343536] rounded-lg text-white focus:border-[#ff4500] focus:outline-none"
                    />
                    <span className="text-[#818384]">to</span>
                    <input
                      type="number"
                      value={automationSettings.sessionBreakDurationMax}
                      onChange={e => setAutomationSettings(prev => ({ ...prev, sessionBreakDurationMax: parseInt(e.target.value) || 0 }))}
                      className="w-24 px-3 py-2 bg-[#272729] border border-[#343536] rounded-lg text-white focus:border-[#ff4500] focus:outline-none"
                    />
                  </div>
                </div>
              </div>
            )}
          </div>

          {/* Typing Simulation */}
          <div className="bg-[#1a1a1b] rounded-xl p-6 border border-[#343536]">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-lg font-semibold text-white">Typing Simulation</h3>
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={automationSettings.enableTypoSimulation}
                  onChange={e => setAutomationSettings(prev => ({ ...prev, enableTypoSimulation: e.target.checked }))}
                  className="w-4 h-4 accent-[#ff4500]"
                />
                <span className="text-[#d7dadc]">Enable Typos</span>
              </label>
            </div>

            <div>
              <label className="block text-sm font-medium text-[#d7dadc] mb-2">
                Typing Speed (ms per character)
              </label>
              <div className="flex gap-2 items-center">
                <input
                  type="number"
                  value={automationSettings.typingSpeedMin}
                  onChange={e => setAutomationSettings(prev => ({ ...prev, typingSpeedMin: parseInt(e.target.value) || 0 }))}
                  className="w-24 px-3 py-2 bg-[#272729] border border-[#343536] rounded-lg text-white focus:border-[#ff4500] focus:outline-none"
                />
                <span className="text-[#818384]">to</span>
                <input
                  type="number"
                  value={automationSettings.typingSpeedMax}
                  onChange={e => setAutomationSettings(prev => ({ ...prev, typingSpeedMax: parseInt(e.target.value) || 0 }))}
                  className="w-24 px-3 py-2 bg-[#272729] border border-[#343536] rounded-lg text-white focus:border-[#ff4500] focus:outline-none"
                />
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
