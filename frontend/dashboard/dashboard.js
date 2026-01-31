// Dashboard script for Reddit Insight Gatherer

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
const exportCsvBtn = document.getElementById('export-csv');
const exportJsonBtn = document.getElementById('export-json');

let dmHistory = [];

// Initialize dashboard
document.addEventListener('DOMContentLoaded', init);

async function init() {
    await checkBackendConnection();
    await loadStats();
    await loadRateLimitStatus();
    await loadSubreddits();
    await loadActivity();

    // Event listeners
    settingsBtn.addEventListener('click', openSettings);
    configureBtn.addEventListener('click', openSettings);
    filterStatus.addEventListener('change', filterActivity);
    exportCsvBtn.addEventListener('click', () => exportData('csv'));
    exportJsonBtn.addEventListener('click', () => exportData('json'));
}

async function checkBackendConnection() {
    try {
        const data = await chrome.storage.local.get(['backendUrl']);
        const backendUrl = data.backendUrl || 'http://localhost:3000';

        const response = await fetch(`${backendUrl}/api/status`);
        if (!response.ok) {
            throw new Error('Backend not reachable');
        }

        const status = await response.json();
        if (!status.openrouterConfigured) {
            apiWarning.classList.remove('hidden');
            apiWarning.querySelector('p').textContent = 'LLM not configured on backend server.';
        }
    } catch (error) {
        apiWarning.classList.remove('hidden');
        apiWarning.querySelector('p').textContent = 'Cannot connect to backend server. Make sure it is running.';
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
            todayCount.textContent = response.todayCount || 0;
            weekCount.textContent = response.weekCount || 0;
            totalCount.textContent = response.totalDMs || 0;
            successRate.textContent = response.successRate ? `${response.successRate}%` : '-';
        } else {
            // Fallback to local data
            const localData = await chrome.storage.local.get(['rateLimitState']);
            todayCount.textContent = localData.rateLimitState?.dailyCount || 0;
            weekCount.textContent = '-';
            totalCount.textContent = '-';
            successRate.textContent = '-';
        }
    } catch (error) {
        console.error('Failed to load stats:', error);
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

async function exportData(format) {
    try {
        const response = await chrome.runtime.sendMessage({ action: 'GET_DM_HISTORY', limit: 1000 });

        if (!response || response.length === 0) {
            alert('No data to export');
            return;
        }

        let content, filename, mimeType;

        if (format === 'csv') {
            const headers = ['Date', 'Recipient', 'Subreddit', 'Post Title', 'Message', 'Status'];
            const rows = response.map(dm => [
                dm.created_at,
                dm.recipient_username,
                dm.subreddit || '',
                `"${(dm.post_title || '').replace(/"/g, '""')}"`,
                `"${(dm.message_content || '').replace(/"/g, '""')}"`,
                dm.status
            ]);
            content = [headers.join(','), ...rows.map(r => r.join(','))].join('\n');
            filename = `reddit-dms-${new Date().toISOString().split('T')[0]}.csv`;
            mimeType = 'text/csv';
        } else {
            content = JSON.stringify(response, null, 2);
            filename = `reddit-dms-${new Date().toISOString().split('T')[0]}.json`;
            mimeType = 'application/json';
        }

        // Create and trigger download
        const blob = new Blob([content], { type: mimeType });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        a.click();
        URL.revokeObjectURL(url);
    } catch (error) {
        console.error('Export failed:', error);
        alert('Export failed. Please try again.');
    }
}
