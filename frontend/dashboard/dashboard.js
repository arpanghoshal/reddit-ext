// Dashboard script for Reddit Automated DM
console.log('Dashboard script starting...');

// DOM Elements
const apiWarning = document.getElementById('api-warning');
const configureBtn = document.getElementById('configure-btn');
const settingsBtn = document.getElementById('settings-btn');
const todayCount = document.getElementById('today-count');
const weekCount = document.getElementById('week-count');
const totalCount = document.getElementById('total-count');
const successRate = document.getElementById('success-rate');
const rateLimitText = document.getElementById('rate-limit-text');
const rateLimitFill = document.getElementById('rate-limit-fill');
const subredditsList = document.getElementById('subreddits-list');
const activityList = document.getElementById('activity-list');
const filterStatus = document.getElementById('filter-status');

// Export Modal Elements
const exportBtn = document.getElementById('export-btn');
const exportModal = document.getElementById('export-modal');
const closeModalBtn = document.getElementById('close-modal');
const cancelExportBtn = document.getElementById('cancel-export');
const confirmExportBtn = document.getElementById('confirm-export');
const exportDateRange = document.getElementById('export-date-range');
const customDateRange = document.getElementById('custom-date-range');
const exportStartDate = document.getElementById('export-start-date');
const exportEndDate = document.getElementById('export-end-date');

let dmHistory = [];
let analyticsData = null;

// Initialize dashboard
document.addEventListener('DOMContentLoaded', init);

async function init() {
    console.log('Dashboard init() called');

    // Attach event listeners FIRST so UI is interactive immediately
    settingsBtn.addEventListener('click', openSettings);
    configureBtn.addEventListener('click', openSettings);
    filterStatus.addEventListener('change', filterActivity);

    // Load data in parallel (don't block on each other)
    checkBackendConnection().then(() => console.log('Backend check done'));
    loadStats().then(() => console.log('Stats loaded'));
    loadRateLimitStatus().then(() => console.log('Rate limit loaded'));
    loadSubreddits().then(() => console.log('Subreddits loaded'));
    loadActivity().then(() => console.log('Activity loaded'));

    // Export modal event listeners
    exportBtn.addEventListener('click', openExportModal);
    closeModalBtn.addEventListener('click', closeExportModal);
    cancelExportBtn.addEventListener('click', closeExportModal);
    confirmExportBtn.addEventListener('click', handleExport);
    exportDateRange.addEventListener('change', handleDateRangeChange);

    // Close modal on backdrop click
    exportModal.querySelector('.modal-backdrop').addEventListener('click', closeExportModal);

    // Close modal on Escape key
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && !exportModal.classList.contains('hidden')) {
            closeExportModal();
        }
    });

    // Set default date range for custom inputs
    const today = new Date().toISOString().split('T')[0];
    const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
    exportEndDate.value = today;
    exportStartDate.value = weekAgo;

    // Open full dashboard link
    const openDashboardLink = document.getElementById('open-full-dashboard');
    if (openDashboardLink) {
        openDashboardLink.addEventListener('click', (e) => {
            e.preventDefault();
            chrome.runtime.openOptionsPage();
        });
    }
}

async function checkBackendConnection() {
    try {
        const data = await chrome.storage.local.get(['backendUrl']);
        const backendUrl = data.backendUrl || 'http://localhost:3000';

        // Add 3 second timeout to prevent hanging
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 3000);

        const response = await fetch(`${backendUrl}/api/status`, {
            signal: controller.signal
        });
        clearTimeout(timeoutId);

        if (!response.ok) {
            throw new Error('Backend not reachable');
        }

        const status = await response.json();
        if (!status.openrouterConfigured) {
            apiWarning.classList.remove('hidden');
            apiWarning.querySelector('span').textContent = 'LLM not configured on backend server.';
        }
    } catch (error) {
        console.log('Backend connection failed:', error.message);
        apiWarning.classList.remove('hidden');
        apiWarning.querySelector('span').textContent = 'Cannot connect to backend server. Make sure it is running.';
    }
}

function openSettings() {
    chrome.runtime.openOptionsPage();
}

async function loadStats() {
    try {
        // Fetch from background script (which calls the backend API)
        const response = await chrome.runtime.sendMessage({ action: 'GET_ANALYTICS' });

        if (response) {
            analyticsData = response; // Store for export
            todayCount.textContent = response.todayCount || 0;
            weekCount.textContent = response.weekCount || 0;
            totalCount.textContent = response.totalDMs || 0;
            successRate.textContent = response.successRate ? `${response.successRate}%` : '-';
        } else {
            // Fallback to local data
            const localData = await chrome.storage.local.get(['rateLimitState']);
            analyticsData = {
                todayCount: localData.rateLimitState?.dailyCount || 0,
                weekCount: 0,
                totalDMs: 0,
                successRate: 0
            };
            todayCount.textContent = localData.rateLimitState?.dailyCount || 0;
            weekCount.textContent = '-';
            totalCount.textContent = '-';
            successRate.textContent = '-';
        }
    } catch (error) {
        console.error('Failed to load stats:', error);
        analyticsData = null;
        todayCount.textContent = '-';
        weekCount.textContent = '-';
        totalCount.textContent = '-';
        successRate.textContent = '-';
    }
}

async function loadRateLimitStatus() {
    try {
        const response = await chrome.runtime.sendMessage({ action: 'GET_RATE_LIMIT_STATUS' });

        if (response) {
            rateLimitText.textContent = `${response.dailyCount} / ${response.dailyLimit}`;
            const percentage = Math.min((response.dailyCount / response.dailyLimit) * 100, 100);
            rateLimitFill.style.width = `${percentage}%`;

            // Change color based on usage
            if (percentage >= 90) {
                rateLimitFill.style.background = '#dc3545';
            } else if (percentage >= 70) {
                rateLimitFill.style.background = '#ffa500';
            } else {
                rateLimitFill.style.background = '#46a758';
            }
        }
    } catch (error) {
        console.error('Failed to load rate limit status:', error);
    }
}

async function loadSubreddits() {
    try {
        const response = await chrome.runtime.sendMessage({ action: 'GET_SUBREDDITS' });

        if (response && response.length > 0) {
            subredditsList.innerHTML = response.slice(0, 5).map(item => `
                <div class="subreddit-item">
                    <span class="subreddit-name">r/${item.subreddit}</span>
                    <span class="subreddit-count">${item.count}</span>
                </div>
            `).join('');
        } else {
            subredditsList.innerHTML = '<div class="empty-state">No data yet</div>';
        }
    } catch (error) {
        console.error('Failed to load subreddits:', error);
        subredditsList.innerHTML = '<div class="empty-state">Failed to load</div>';
    }
}

async function loadActivity() {
    try {
        const response = await chrome.runtime.sendMessage({ action: 'GET_DM_HISTORY', limit: 20 });
        dmHistory = response || [];

        renderActivity(dmHistory);
    } catch (error) {
        console.error('Failed to load activity:', error);
        activityList.innerHTML = '<div class="empty-state">Failed to load</div>';
    }
}

function renderActivity(items) {
    if (!items || items.length === 0) {
        activityList.innerHTML = '<div class="empty-state">No activity yet</div>';
        return;
    }

    activityList.innerHTML = items.map(item => {
        const date = new Date(item.created_at);
        const timeAgo = getTimeAgo(date);

        return `
            <div class="activity-item">
                <div class="activity-header">
                    <span class="activity-user">u/${item.recipient_username}</span>
                    <span class="activity-status ${item.status}">${item.status}</span>
                </div>
                <div class="activity-meta">
                    <span>${item.subreddit ? `r/${item.subreddit}` : 'Unknown'}</span>
                    <span>${timeAgo}</span>
                </div>
            </div>
        `;
    }).join('');
}

function filterActivity() {
    const status = filterStatus.value;

    if (status === 'all') {
        renderActivity(dmHistory);
    } else {
        const filtered = dmHistory.filter(item => item.status === status);
        renderActivity(filtered);
    }
}

function getTimeAgo(date) {
    const seconds = Math.floor((new Date() - date) / 1000);

    if (seconds < 60) return 'Just now';
    if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
    if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
    return `${Math.floor(seconds / 86400)}d ago`;
}

// ==========================================
// Export Modal Functions
// ==========================================

function openExportModal() {
    exportModal.classList.remove('hidden');
    document.body.style.overflow = 'hidden';
}

function closeExportModal() {
    exportModal.classList.add('hidden');
    document.body.style.overflow = '';
}

function handleDateRangeChange() {
    if (exportDateRange.value === 'custom') {
        customDateRange.classList.remove('hidden');
    } else {
        customDateRange.classList.add('hidden');
    }
}

function getDateRange() {
    const range = exportDateRange.value;
    const now = new Date();
    let startDate, endDate;

    endDate = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59);

    switch (range) {
        case 'today':
            startDate = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0);
            break;
        case 'week':
            startDate = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
            break;
        case 'month':
            startDate = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
            break;
        case 'custom':
            startDate = exportStartDate.value ? new Date(exportStartDate.value) : new Date(0);
            endDate = exportEndDate.value ? new Date(exportEndDate.value + 'T23:59:59') : endDate;
            break;
        case 'all':
        default:
            startDate = new Date(0);
            break;
    }

    return { startDate, endDate };
}

function filterByDateRange(items, startDate, endDate) {
    return items.filter(item => {
        const itemDate = new Date(item.created_at);
        return itemDate >= startDate && itemDate <= endDate;
    });
}

async function handleExport() {
    const btn = confirmExportBtn;
    const btnText = btn.querySelector('.btn-text');
    const btnSpinner = btn.querySelector('.btn-spinner');

    // Get export options
    const exportTypes = Array.from(document.querySelectorAll('input[name="export-type"]:checked'))
        .map(cb => cb.value);
    const format = document.querySelector('input[name="export-format"]:checked').value;

    if (exportTypes.length === 0) {
        alert('Please select at least one data type to export');
        return;
    }

    // Show loading state
    btn.disabled = true;
    btnText.textContent = 'Exporting...';
    btnSpinner.classList.remove('hidden');

    try {
        const { startDate, endDate } = getDateRange();
        const exportData = {
            exportedAt: new Date().toISOString(),
            dateRange: {
                start: startDate.toISOString(),
                end: endDate.toISOString()
            }
        };

        // Fetch DM History if selected
        if (exportTypes.includes('dms')) {
            const response = await chrome.runtime.sendMessage({ action: 'GET_DM_HISTORY', limit: 10000 });
            exportData.dmHistory = filterByDateRange(response || [], startDate, endDate);
        }

        // Add Analytics Summary if selected
        if (exportTypes.includes('analytics')) {
            exportData.analytics = {
                totalDMs: analyticsData?.totalDMs || 0,
                todayCount: analyticsData?.todayCount || 0,
                weekCount: analyticsData?.weekCount || 0,
                successRate: analyticsData?.successRate || 0,
                generatedAt: new Date().toISOString()
            };

            // Calculate stats from filtered data
            if (exportData.dmHistory) {
                const filteredDMs = exportData.dmHistory;
                const sentCount = filteredDMs.filter(dm => dm.status === 'sent').length;
                const failedCount = filteredDMs.filter(dm => dm.status === 'failed').length;

                exportData.analytics.periodStats = {
                    total: filteredDMs.length,
                    sent: sentCount,
                    failed: failedCount,
                    successRate: filteredDMs.length > 0
                        ? Math.round((sentCount / filteredDMs.length) * 100)
                        : 0
                };

                // Group by subreddit
                const subredditCounts = {};
                filteredDMs.forEach(dm => {
                    const sub = dm.subreddit || 'unknown';
                    subredditCounts[sub] = (subredditCounts[sub] || 0) + 1;
                });
                exportData.analytics.bySubreddit = Object.entries(subredditCounts)
                    .map(([name, count]) => ({ subreddit: name, count }))
                    .sort((a, b) => b.count - a.count);

                // Group by day
                const dailyCounts = {};
                filteredDMs.forEach(dm => {
                    const day = dm.created_at.split('T')[0];
                    dailyCounts[day] = (dailyCounts[day] || 0) + 1;
                });
                exportData.analytics.byDay = Object.entries(dailyCounts)
                    .map(([date, count]) => ({ date, count }))
                    .sort((a, b) => a.date.localeCompare(b.date));
            }
        }

        // Fetch Session Logs if selected
        if (exportTypes.includes('sessions')) {
            try {
                const data = await chrome.storage.local.get(['backendUrl', 'apiKey']);
                const backendUrl = data.backendUrl || 'http://localhost:3000';
                const headers = { 'Content-Type': 'application/json' };
                if (data.apiKey) headers['X-API-Key'] = data.apiKey;

                const response = await fetch(`${backendUrl}/api/session/logs?limit=1000`, { headers });
                if (response.ok) {
                    const result = await response.json();
                    exportData.sessions = (result.data || []).filter(session => {
                        const sessionDate = new Date(session.created_at);
                        return sessionDate >= startDate && sessionDate <= endDate;
                    });
                }
            } catch (e) {
                console.warn('Could not fetch sessions:', e);
                exportData.sessions = [];
            }
        }

        // Generate file content
        let content, filename, mimeType;
        const dateStr = new Date().toISOString().split('T')[0];

        if (format === 'csv') {
            content = generateCSV(exportData, exportTypes);
            filename = `reddit-analytics-${dateStr}.csv`;
            mimeType = 'text/csv;charset=utf-8';
        } else {
            content = JSON.stringify(exportData, null, 2);
            filename = `reddit-analytics-${dateStr}.json`;
            mimeType = 'application/json';
        }

        // Download file
        downloadFile(content, filename, mimeType);

        // Close modal
        closeExportModal();

    } catch (error) {
        console.error('Export failed:', error);
        alert('Export failed: ' + error.message);
    } finally {
        btn.disabled = false;
        btnText.textContent = 'Export';
        btnSpinner.classList.add('hidden');
    }
}

function generateCSV(data, exportTypes) {
    const lines = [];

    // Add header with export info
    lines.push('# Reddit Automated DM Export');
    lines.push(`# Generated: ${data.exportedAt}`);
    lines.push(`# Date Range: ${data.dateRange.start} to ${data.dateRange.end}`);
    lines.push('');

    // Analytics Summary Section
    if (exportTypes.includes('analytics') && data.analytics) {
        lines.push('# ANALYTICS SUMMARY');
        lines.push('Metric,Value');
        lines.push(`Total DMs (All Time),${data.analytics.totalDMs}`);
        lines.push(`DMs Today,${data.analytics.todayCount}`);
        lines.push(`DMs This Week,${data.analytics.weekCount}`);
        lines.push(`Overall Success Rate,${data.analytics.successRate}%`);

        if (data.analytics.periodStats) {
            lines.push('');
            lines.push('# PERIOD STATISTICS');
            lines.push(`Total in Period,${data.analytics.periodStats.total}`);
            lines.push(`Sent,${data.analytics.periodStats.sent}`);
            lines.push(`Failed,${data.analytics.periodStats.failed}`);
            lines.push(`Period Success Rate,${data.analytics.periodStats.successRate}%`);
        }

        if (data.analytics.bySubreddit && data.analytics.bySubreddit.length > 0) {
            lines.push('');
            lines.push('# BY SUBREDDIT');
            lines.push('Subreddit,Count');
            data.analytics.bySubreddit.forEach(item => {
                lines.push(`r/${item.subreddit},${item.count}`);
            });
        }

        if (data.analytics.byDay && data.analytics.byDay.length > 0) {
            lines.push('');
            lines.push('# DAILY BREAKDOWN');
            lines.push('Date,Count');
            data.analytics.byDay.forEach(item => {
                lines.push(`${item.date},${item.count}`);
            });
        }

        lines.push('');
    }

    // DM History Section
    if (exportTypes.includes('dms') && data.dmHistory && data.dmHistory.length > 0) {
        lines.push('# DM HISTORY');
        lines.push('Date,Time,Recipient,Subreddit,Post Title,Message,Status,Type');

        data.dmHistory.forEach(dm => {
            const date = dm.created_at ? dm.created_at.split('T')[0] : '';
            const time = dm.created_at ? dm.created_at.split('T')[1]?.split('.')[0] || '' : '';
            const row = [
                date,
                time,
                dm.recipient_username || '',
                dm.subreddit || '',
                escapeCSV(dm.post_title || ''),
                escapeCSV(dm.message_content || ''),
                dm.status || '',
                dm.automation_type || 'single'
            ];
            lines.push(row.join(','));
        });

        lines.push('');
    }

    // Sessions Section
    if (exportTypes.includes('sessions') && data.sessions && data.sessions.length > 0) {
        lines.push('# AUTOMATION SESSIONS');
        lines.push('Date,Subreddit,Total Posts,Processed,Successful,Failed,Status');

        data.sessions.forEach(session => {
            const date = session.created_at ? session.created_at.split('T')[0] : '';
            const row = [
                date,
                session.subreddit || '',
                session.total_posts || 0,
                session.processed_count || 0,
                session.success_count || 0,
                session.failed_count || 0,
                session.status || ''
            ];
            lines.push(row.join(','));
        });
    }

    return lines.join('\n');
}

function escapeCSV(str) {
    if (!str) return '';
    // Escape double quotes and wrap in quotes if contains comma, newline, or quote
    const escaped = str.replace(/"/g, '""');
    if (escaped.includes(',') || escaped.includes('\n') || escaped.includes('"')) {
        return `"${escaped}"`;
    }
    return escaped;
}

function downloadFile(content, filename, mimeType) {
    const blob = new Blob([content], { type: mimeType });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
}
