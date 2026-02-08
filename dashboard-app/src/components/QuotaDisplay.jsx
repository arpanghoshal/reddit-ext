import { useState, useEffect } from 'react';
import { AlertTriangle, CheckCircle, XCircle, BarChart2, Users, MessageSquare } from 'lucide-react';
import { getQuotaStatus } from '../api/client';

/**
 * QuotaDisplay Component
 * Shows team quota usage with progress bars and warnings
 */
export default function QuotaDisplay({ compact = false }) {
  const [quotaStatus, setQuotaStatus] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    fetchQuotaStatus();
  }, []);

  const fetchQuotaStatus = async () => {
    try {
      const data = await getQuotaStatus();
      setQuotaStatus(data);
    } catch (err) {
      console.error('Error fetching quota status:', err);
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  if (loading) {
    return (
      <div className="animate-pulse bg-[#1a1a1b] rounded-lg p-4">
        <div className="h-4 bg-[#343536] rounded w-1/4 mb-4"></div>
        <div className="space-y-3">
          <div className="h-2 bg-[#343536] rounded"></div>
          <div className="h-2 bg-[#343536] rounded"></div>
          <div className="h-2 bg-[#343536] rounded"></div>
        </div>
      </div>
    );
  }

  if (error) {
    return null; // Silently fail - quota display is optional
  }

  if (!quotaStatus) {
    return null;
  }

  const quotaItems = [
    {
      key: 'dms_today',
      label: 'DMs Today',
      icon: MessageSquare,
      ...quotaStatus.dms_today
    },
    {
      key: 'accounts',
      label: 'Accounts',
      icon: Users,
      ...quotaStatus.accounts
    },
    {
      key: 'members',
      label: 'Members',
      icon: Users,
      ...quotaStatus.members
    }
  ];

  const getStatusColor = (percentage) => {
    if (percentage >= 100) return 'bg-red-500';
    if (percentage >= 80) return 'bg-yellow-500';
    return 'bg-green-500';
  };

  const getStatusIcon = (percentage) => {
    if (percentage >= 100) return <XCircle className="w-4 h-4 text-red-500" />;
    if (percentage >= 80) return <AlertTriangle className="w-4 h-4 text-yellow-500" />;
    return <CheckCircle className="w-4 h-4 text-green-500" />;
  };

  // Compact view for sidebar
  if (compact) {
    const criticalQuotas = quotaItems.filter(q => q.percentage >= 80);

    if (criticalQuotas.length === 0) {
      return null; // Don't show if all quotas are fine
    }

    return (
      <div className="bg-[#272729] rounded-lg p-3 space-y-2">
        <div className="flex items-center gap-2 text-sm text-yellow-500">
          <AlertTriangle className="w-4 h-4" />
          <span>Quota Warning</span>
        </div>
        {criticalQuotas.map((item) => (
          <div key={item.key} className="flex items-center justify-between text-xs">
            <span className="text-[#818384]">{item.label}</span>
            <span className={item.percentage >= 100 ? 'text-red-500' : 'text-yellow-500'}>
              {item.current}/{item.limit}
            </span>
          </div>
        ))}
      </div>
    );
  }

  // Full view
  return (
    <div className="bg-[#1a1a1b] rounded-lg border border-[#343536] p-6">
      <div className="flex items-center gap-3 mb-6">
        <BarChart2 className="w-5 h-5 text-[#ff4500]" />
        <h3 className="text-lg font-semibold text-white">Usage & Quotas</h3>
      </div>

      <div className="space-y-6">
        {quotaItems.map((item) => {
          const Icon = item.icon;
          return (
            <div key={item.key} className="space-y-2">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Icon className="w-4 h-4 text-[#818384]" />
                  <span className="text-sm text-[#d7dadc]">{item.label}</span>
                </div>
                <div className="flex items-center gap-2">
                  {getStatusIcon(item.percentage)}
                  <span className="text-sm text-[#818384]">
                    {item.current} / {item.limit}
                  </span>
                </div>
              </div>

              {/* Progress bar */}
              <div className="h-2 bg-[#343536] rounded-full overflow-hidden">
                <div
                  className={`h-full rounded-full transition-all duration-300 ${getStatusColor(item.percentage)}`}
                  style={{ width: `${Math.min(item.percentage, 100)}%` }}
                />
              </div>

              {/* Warning message */}
              {item.percentage >= 100 && (
                <p className="text-xs text-red-400">
                  Limit reached. Upgrade your plan or remove unused items.
                </p>
              )}
              {item.percentage >= 80 && item.percentage < 100 && (
                <p className="text-xs text-yellow-400">
                  Approaching limit ({100 - item.percentage}% remaining)
                </p>
              )}
            </div>
          );
        })}
      </div>

      {/* Refresh button */}
      <button
        onClick={fetchQuotaStatus}
        className="mt-6 text-sm text-[#818384] hover:text-white transition-colors"
      >
        Refresh usage data
      </button>
    </div>
  );
}
