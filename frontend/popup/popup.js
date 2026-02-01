// Popup Script for Reddit Insight Extension

const DEFAULT_DASHBOARD_URL = 'http://localhost:5173';
const DEFAULT_BACKEND_URL = 'http://localhost:3000';

// Load stats and config on popup open
document.addEventListener('DOMContentLoaded', async () => {
    await loadConfig();
    await loadStats();
    await checkConnection();
    initEventListeners();
});

async function loadConfig() {
    const data = await chrome.storage.local.get(['dashboardUrl', 'backendUrl', 'apiKey']);
    document.getElementById('dashboard-url').value = data.dashboardUrl || DEFAULT_DASHBOARD_URL;
    document.getElementById('backend-url').value = data.backendUrl || DEFAULT_BACKEND_URL;
    document.getElementById('api-key').value = data.apiKey || '';
}

async function loadStats() {
    try {
        // Try to get stats from background script
        const response = await chrome.runtime.sendMessage({ action: 'GET_ANALYTICS' });

        if (response) {
            document.getElementById('stat-today').textContent = response.todayCount || 0;
            document.getElementById('stat-week').textContent = response.weekCount || 0;
        }

        // Get queue stats
        const queueResponse = await chrome.runtime.sendMessage({ action: 'GET_QUEUE_STATS' });
        if (queueResponse) {
            document.getElementById('stat-pending').textContent = queueResponse.pending || 0;
        }

        // Get conversation stats
        const convResponse = await chrome.runtime.sendMessage({ action: 'GET_CONVERSATION_STATS' });
        if (convResponse) {
            document.getElementById('stat-replies').textContent = convResponse.withReplies || 0;
        }
    } catch (error) {
        console.error('Failed to load stats:', error);
        // Try local fallback
        const localData = await chrome.storage.local.get(['rateLimitState']);
        if (localData.rateLimitState) {
            document.getElementById('stat-today').textContent = localData.rateLimitState.dailyCount || 0;
        }
    }
}

async function checkConnection() {
    const statusDot = document.getElementById('connection-status');
    const data = await chrome.storage.local.get(['backendUrl', 'apiKey']);
    const backendUrl = data.backendUrl || DEFAULT_BACKEND_URL;

    try {
        const response = await fetch(`${backendUrl}/api/status`, {
            headers: data.apiKey ? { 'X-API-Key': data.apiKey } : {}
        });

        if (response.ok) {
            statusDot.classList.remove('disconnected');
            statusDot.classList.add('connected');
            statusDot.title = 'Connected to backend';
            return true;
        } else {
            throw new Error('Not OK');
        }
    } catch (error) {
        statusDot.classList.remove('connected');
        statusDot.classList.add('disconnected');
        statusDot.title = 'Disconnected - check settings';
        return false;
    }
}

function showToast(message, type = 'info') {
    // Remove existing toast
    const existing = document.querySelector('.toast');
    if (existing) existing.remove();

    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    toast.textContent = message;
    document.body.appendChild(toast);

    setTimeout(() => toast.remove(), 3000);
}

function initEventListeners() {
    // Open Dashboard
    document.getElementById('open-dashboard').addEventListener('click', async () => {
        const dashboardUrl = document.getElementById('dashboard-url').value || DEFAULT_DASHBOARD_URL;
        await chrome.storage.local.set({ dashboardUrl });
        chrome.tabs.create({ url: dashboardUrl });
    });

    // Toggle Settings
    document.getElementById('toggle-settings').addEventListener('click', () => {
        document.querySelector('.settings-section').classList.toggle('open');
    });

    // Test Connection
    document.getElementById('test-connection').addEventListener('click', async () => {
        const backendUrl = document.getElementById('backend-url').value || DEFAULT_BACKEND_URL;
        const apiKey = document.getElementById('api-key').value;

        try {
            const response = await fetch(`${backendUrl}/api/status`, {
                headers: apiKey ? { 'X-API-Key': apiKey } : {}
            });

            if (response.ok) {
                showToast('Connected!', 'success');
            } else {
                showToast('Connection failed', 'error');
            }
        } catch (error) {
            showToast('Cannot reach server', 'error');
        }
    });

    // Save Settings
    document.getElementById('save-settings').addEventListener('click', async () => {
        const settings = {
            dashboardUrl: document.getElementById('dashboard-url').value || DEFAULT_DASHBOARD_URL,
            backendUrl: document.getElementById('backend-url').value || DEFAULT_BACKEND_URL,
            apiKey: document.getElementById('api-key').value
        };

        await chrome.storage.local.set(settings);

        // Notify background script
        chrome.runtime.sendMessage({ action: 'SETTINGS_UPDATED', settings });

        showToast('Settings saved', 'success');
        checkConnection();
    });
}
