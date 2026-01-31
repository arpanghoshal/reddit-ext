// API Client for Reddit Insight Gatherer Backend
// All API calls go through the backend server

let apiConfig = {
    baseUrl: null,
    initialized: false
};

// Get API configuration from storage
async function getApiConfig() {
    if (apiConfig.initialized && apiConfig.baseUrl) {
        return apiConfig;
    }

    const data = await chrome.storage.local.get(['backendUrl']);

    if (data.backendUrl) {
        apiConfig = {
            baseUrl: data.backendUrl.replace(/\/$/, ''), // Remove trailing slash
            initialized: true
        };
        return apiConfig;
    }

    // Default to localhost for development
    apiConfig = {
        baseUrl: 'http://localhost:3000',
        initialized: true
    };
    return apiConfig;
}

async function apiRequest(endpoint, options = {}) {
    const config = await getApiConfig();
    const url = `${config.baseUrl}/api${endpoint}`;

    try {
        const response = await fetch(url, {
            ...options,
            headers: {
                'Content-Type': 'application/json',
                ...options.headers
            }
        });

        if (!response.ok) {
            const error = await response.json().catch(() => ({ error: 'Request failed' }));
            throw new Error(error.error || 'Request failed');
        }

        return await response.json();
    } catch (error) {
        console.error(`API request failed: ${endpoint}`, error);
        throw error;
    }
}

// Check if backend is configured and accessible
async function isConfigured() {
    try {
        const config = await getApiConfig();
        const response = await fetch(`${config.baseUrl}/api/status`);
        return response.ok;
    } catch {
        return false;
    }
}

// Get backend status
async function getStatus() {
    return apiRequest('/status');
}

// --- LLM Functions ---

async function generateQuestion(post, settings) {
    const result = await apiRequest('/generate', {
        method: 'POST',
        body: JSON.stringify({ post, settings })
    });
    return result.message;
}

async function getAvailableModels() {
    const result = await apiRequest('/models');
    return result.models;
}

// --- DM History Functions ---

async function logDM(data) {
    const result = await apiRequest('/dm', {
        method: 'POST',
        body: JSON.stringify(data)
    });
    return result.data;
}

async function getDMHistory(limit = 50) {
    const result = await apiRequest(`/dm/history?limit=${limit}`);
    return result.data || [];
}

async function getDMsBySubreddit(limit = 10) {
    const result = await apiRequest(`/dm/subreddits?limit=${limit}`);
    return result.data || [];
}

// --- Automation Session Functions ---

async function startAutomationSession(data) {
    const result = await apiRequest('/session/start', {
        method: 'POST',
        body: JSON.stringify(data)
    });
    return { sessionId: result.sessionId, record: result.record };
}

async function updateAutomationSession(sessionId, data) {
    const result = await apiRequest(`/session/${sessionId}`, {
        method: 'PATCH',
        body: JSON.stringify(data)
    });
    return result.data;
}

async function getAutomationLogs(limit = 20) {
    const result = await apiRequest(`/session/logs?limit=${limit}`);
    return result.data || [];
}

// --- Analytics Functions ---

async function getAnalytics() {
    try {
        const result = await apiRequest('/analytics');
        return result.data || { totalDMs: 0, successRate: 0, todayCount: 0, weekCount: 0 };
    } catch {
        return { totalDMs: 0, successRate: 0, todayCount: 0, weekCount: 0 };
    }
}

// --- Settings Functions ---

async function saveSettings(settings) {
    const result = await apiRequest('/settings', {
        method: 'POST',
        body: JSON.stringify(settings)
    });
    return result.data;
}

async function getSettings() {
    try {
        const result = await apiRequest('/settings');
        return result.data;
    } catch {
        return null;
    }
}

// Generate unique session ID (for offline/fallback use)
function generateSessionId() {
    return `session_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
}

// Export for use in background script
if (typeof globalThis !== 'undefined') {
    globalThis.api = {
        isConfigured,
        getStatus,
        generateQuestion,
        getAvailableModels,
        logDM,
        getDMHistory,
        getDMsBySubreddit,
        startAutomationSession,
        updateAutomationSession,
        getAutomationLogs,
        getAnalytics,
        saveSettings,
        getSettings,
        generateSessionId
    };
}
