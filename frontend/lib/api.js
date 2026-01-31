// API Client for Reddit Automated DM Backend
// All API calls go through the backend server

// Default timeout for API requests (30 seconds)
const DEFAULT_TIMEOUT = 30000;

// Maximum retries for failed requests
const MAX_RETRIES = 3;

// Retry delay base (exponential backoff)
const RETRY_DELAY_BASE = 1000;

let apiConfig = {
    baseUrl: null,
    apiKey: null,
    initialized: false
};

// Get API configuration from storage
async function getApiConfig() {
    if (apiConfig.initialized && apiConfig.baseUrl) {
        return apiConfig;
    }

    const data = await chrome.storage.local.get(['backendUrl', 'apiKey']);

    if (data.backendUrl) {
        apiConfig = {
            baseUrl: data.backendUrl.replace(/\/$/, ''), // Remove trailing slash
            apiKey: data.apiKey || null,
            initialized: true
        };
        return apiConfig;
    }

    // Default to localhost for development
    apiConfig = {
        baseUrl: 'http://localhost:3000',
        apiKey: data.apiKey || null,
        initialized: true
    };
    return apiConfig;
}

// Fetch with timeout support
async function fetchWithTimeout(url, options = {}, timeout = DEFAULT_TIMEOUT) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout);

    try {
        const response = await fetch(url, {
            ...options,
            signal: controller.signal
        });
        return response;
    } finally {
        clearTimeout(timeoutId);
    }
}

// Sleep helper for retry delays
function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// Check if error is retryable
function isRetryableError(error, response) {
    // Network errors are retryable
    if (error.name === 'TypeError' || error.name === 'AbortError') {
        return true;
    }
    // 5xx server errors are retryable
    if (response && response.status >= 500) {
        return true;
    }
    // 429 rate limit is retryable
    if (response && response.status === 429) {
        return true;
    }
    return false;
}

async function apiRequest(endpoint, options = {}, retries = 0) {
    const config = await getApiConfig();
    const url = `${config.baseUrl}/api${endpoint}`;

    // Build headers with API key if configured
    const headers = {
        'Content-Type': 'application/json',
        ...options.headers
    };

    // Add API key header if configured
    if (config.apiKey) {
        headers['X-API-Key'] = config.apiKey;
    }

    try {
        const response = await fetchWithTimeout(url, {
            ...options,
            headers
        }, options.timeout || DEFAULT_TIMEOUT);

        if (!response.ok) {
            // Check if retryable
            if (retries < MAX_RETRIES && isRetryableError(null, response)) {
                const delay = RETRY_DELAY_BASE * Math.pow(2, retries);
                console.warn(`API request failed with ${response.status}, retrying in ${delay}ms...`);
                await sleep(delay);
                return apiRequest(endpoint, options, retries + 1);
            }

            // Handle specific error codes
            if (response.status === 401) {
                throw new Error('Authentication required. Please configure your API key in settings.');
            }
            if (response.status === 403) {
                throw new Error('Invalid API key. Please check your settings.');
            }

            const error = await response.json().catch(() => ({ error: 'Request failed' }));
            throw new Error(error.error || error.message || `Request failed with status ${response.status}`);
        }

        return await response.json();
    } catch (error) {
        // Handle timeout
        if (error.name === 'AbortError') {
            if (retries < MAX_RETRIES) {
                const delay = RETRY_DELAY_BASE * Math.pow(2, retries);
                console.warn(`API request timed out, retrying in ${delay}ms...`);
                await sleep(delay);
                return apiRequest(endpoint, options, retries + 1);
            }
            throw new Error('Request timed out. Please check your network connection.');
        }

        // Handle network errors with retry
        if (error.name === 'TypeError' && retries < MAX_RETRIES) {
            const delay = RETRY_DELAY_BASE * Math.pow(2, retries);
            console.warn(`Network error, retrying in ${delay}ms...`);
            await sleep(delay);
            return apiRequest(endpoint, options, retries + 1);
        }

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
    // Use crypto.getRandomValues for better randomness
    const array = new Uint8Array(16);
    crypto.getRandomValues(array);
    const randomStr = Array.from(array, b => b.toString(16).padStart(2, '0')).join('').substring(0, 16);
    return `session_${Date.now()}_${randomStr}`;
}

// ============================================
// CLASSIFICATION FUNCTIONS
// ============================================

async function classifyPost(post, settings = {}) {
    const result = await apiRequest('/classify', {
        method: 'POST',
        body: JSON.stringify({ post, settings })
    });
    return result.data;
}

async function getClassificationStats() {
    const result = await apiRequest('/classification/stats');
    return result.data;
}

// ============================================
// QUALIFICATION FUNCTIONS
// ============================================

async function qualifyUser(username, options = {}) {
    const queryParams = new URLSearchParams();
    if (options.minAge) queryParams.set('minAge', options.minAge);
    if (options.minKarma) queryParams.set('minKarma', options.minKarma);
    if (options.blockBots !== undefined) queryParams.set('blockBots', options.blockBots);

    const result = await apiRequest(`/qualify/${encodeURIComponent(username)}?${queryParams}`);
    return result.data;
}

async function getQualificationStats() {
    const result = await apiRequest('/qualification/stats');
    return result.data;
}

// Combined filter (classify + qualify)
async function filterPost(post, settings = {}) {
    const result = await apiRequest('/filter', {
        method: 'POST',
        body: JSON.stringify({ post, settings })
    });
    return result.data;
}

// ============================================
// QUEUE FUNCTIONS
// ============================================

async function getQueue(filters = {}) {
    const queryParams = new URLSearchParams();
    if (filters.status) queryParams.set('status', filters.status);
    if (filters.accountId) queryParams.set('accountId', filters.accountId);
    if (filters.limit) queryParams.set('limit', filters.limit);
    if (filters.offset) queryParams.set('offset', filters.offset);

    const result = await apiRequest(`/queue?${queryParams}`);
    return result.data || [];
}

async function addToQueue(item) {
    const result = await apiRequest('/queue', {
        method: 'POST',
        body: JSON.stringify(item)
    });
    return result.data;
}

async function getQueueStats() {
    const result = await apiRequest('/queue/stats');
    return result.data;
}

async function getNextQueueItem(accountId = null) {
    const url = accountId ? `/queue/next?accountId=${accountId}` : '/queue/next';
    const result = await apiRequest(url);
    return result.data;
}

async function updateQueueItem(id, updates) {
    const result = await apiRequest(`/queue/${id}`, {
        method: 'PATCH',
        body: JSON.stringify(updates)
    });
    return result.data;
}

async function approveQueueItem(id, approvedBy = null) {
    const result = await apiRequest(`/queue/${id}/approve`, {
        method: 'POST',
        body: JSON.stringify({ approvedBy })
    });
    return result.data;
}

async function rejectQueueItem(id, reason = null) {
    const result = await apiRequest(`/queue/${id}/reject`, {
        method: 'POST',
        body: JSON.stringify({ reason })
    });
    return result.data;
}

async function markQueueItemSent(id) {
    const result = await apiRequest(`/queue/${id}/sent`, {
        method: 'POST'
    });
    return result.data;
}

async function markQueueItemFailed(id, reason) {
    const result = await apiRequest(`/queue/${id}/failed`, {
        method: 'POST',
        body: JSON.stringify({ reason })
    });
    return result.data;
}

async function bulkApproveQueue(ids, approvedBy = null) {
    const result = await apiRequest('/queue/bulk-approve', {
        method: 'POST',
        body: JSON.stringify({ ids, approvedBy })
    });
    return result.data;
}

async function bulkRejectQueue(ids, reason = null) {
    const result = await apiRequest('/queue/bulk-reject', {
        method: 'POST',
        body: JSON.stringify({ ids, reason })
    });
    return result.data;
}

// ============================================
// ACCOUNT FUNCTIONS
// ============================================

async function getAccounts(filters = {}) {
    const queryParams = new URLSearchParams();
    if (filters.status) queryParams.set('status', filters.status);
    if (filters.activeOnly) queryParams.set('activeOnly', 'true');

    const result = await apiRequest(`/accounts?${queryParams}`);
    return result.data || [];
}

async function addAccount(accountData) {
    const result = await apiRequest('/accounts', {
        method: 'POST',
        body: JSON.stringify(accountData)
    });
    return result.data;
}

async function getAccount(id) {
    const result = await apiRequest(`/accounts/${id}`);
    return result.data;
}

async function updateAccount(id, updates) {
    const result = await apiRequest(`/accounts/${id}`, {
        method: 'PATCH',
        body: JSON.stringify(updates)
    });
    return result.data;
}

async function deleteAccount(id) {
    const result = await apiRequest(`/accounts/${id}`, {
        method: 'DELETE'
    });
    return result.success;
}

async function getAccountCookies(id) {
    const result = await apiRequest(`/accounts/${id}/cookies`);
    return result.data;
}

async function canAccountSend(id) {
    const result = await apiRequest(`/accounts/${id}/can-send`);
    return result.data;
}

async function incrementAccountDM(id) {
    const result = await apiRequest(`/accounts/${id}/increment-dm`, {
        method: 'POST'
    });
    return result.data;
}

async function checkAccountShadowban(id) {
    const result = await apiRequest(`/accounts/${id}/check-shadowban`, {
        method: 'POST'
    });
    return result.data;
}

async function getAccountSubreddits(id) {
    const result = await apiRequest(`/accounts/${id}/subreddits`);
    return result.data || [];
}

async function assignAccountToSubreddit(id, subreddit, priority = 1) {
    const result = await apiRequest(`/accounts/${id}/subreddits`, {
        method: 'POST',
        body: JSON.stringify({ subreddit, priority })
    });
    return result.success;
}

// ============================================
// ROTATION FUNCTIONS
// ============================================

async function getNextAccountForSubreddit(subreddit) {
    const result = await apiRequest(`/rotation/next/${encodeURIComponent(subreddit)}`);
    return result.data;
}

async function getRotationStatus() {
    const result = await apiRequest('/rotation/status');
    return result.data;
}

async function getNextAvailableAccount() {
    const result = await apiRequest('/rotation/next-available');
    return result.data;
}

// ============================================
// SAFETY FUNCTIONS
// ============================================

async function getSafetyEvents(filters = {}) {
    const queryParams = new URLSearchParams();
    if (filters.accountId) queryParams.set('accountId', filters.accountId);
    if (filters.type) queryParams.set('type', filters.type);
    if (filters.limit) queryParams.set('limit', filters.limit);

    const result = await apiRequest(`/safety/events?${queryParams}`);
    return result.data || [];
}

async function logSafetyEvent(event) {
    const result = await apiRequest('/safety/events', {
        method: 'POST',
        body: JSON.stringify(event)
    });
    return result.data;
}

async function getAccountHealth(accountId) {
    const result = await apiRequest(`/safety/health/${accountId}`);
    return result.data;
}

// ============================================
// RULES FUNCTIONS
// ============================================

async function getRules(filters = {}) {
    const queryParams = new URLSearchParams();
    if (filters.activeOnly) queryParams.set('activeOnly', 'true');
    if (filters.type) queryParams.set('type', filters.type);

    const result = await apiRequest(`/rules?${queryParams}`);
    return result.data || [];
}

async function createRule(ruleData) {
    const result = await apiRequest('/rules', {
        method: 'POST',
        body: JSON.stringify(ruleData)
    });
    return result.data;
}

async function updateRule(id, updates) {
    const result = await apiRequest(`/rules/${id}`, {
        method: 'PATCH',
        body: JSON.stringify(updates)
    });
    return result.data;
}

async function deleteRule(id) {
    const result = await apiRequest(`/rules/${id}`, {
        method: 'DELETE'
    });
    return result.success;
}

async function evaluateRules(post, userProfile = null) {
    const result = await apiRequest('/rules/evaluate', {
        method: 'POST',
        body: JSON.stringify({ post, userProfile })
    });
    return result.data;
}

async function getRuleTemplates() {
    const result = await apiRequest('/rules/templates');
    return result.data || [];
}

// ============================================
// CONVERSATIONS FUNCTIONS
// ============================================

async function getConversations(filters = {}) {
    const queryParams = new URLSearchParams();
    if (filters.status) queryParams.set('status', filters.status);
    if (filters.hasReply !== undefined) queryParams.set('hasReply', filters.hasReply);
    if (filters.limit) queryParams.set('limit', filters.limit);
    if (filters.offset) queryParams.set('offset', filters.offset);

    const result = await apiRequest(`/conversations?${queryParams}`);
    return result.data || [];
}

async function getConversation(id) {
    const result = await apiRequest(`/conversations/${id}`);
    return result.data;
}

async function updateConversation(id, updates) {
    const result = await apiRequest(`/conversations/${id}`, {
        method: 'PATCH',
        body: JSON.stringify(updates)
    });
    return result.data;
}

async function getConversationStats() {
    const result = await apiRequest('/conversations/stats');
    return result.data;
}

async function syncConversation(syncData) {
    const result = await apiRequest('/conversations/sync', {
        method: 'POST',
        body: JSON.stringify(syncData)
    });
    return result.data;
}

async function getReplySuggestion(conversationId) {
    const result = await apiRequest(`/conversations/${conversationId}/reply-suggestion`, {
        method: 'POST'
    });
    return result.data?.suggestion;
}

// Export for use in background script
if (typeof globalThis !== 'undefined') {
    globalThis.api = {
        // Original functions
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
        generateSessionId,

        // Classification
        classifyPost,
        getClassificationStats,

        // Qualification
        qualifyUser,
        getQualificationStats,
        filterPost,

        // Queue
        getQueue,
        addToQueue,
        getQueueStats,
        getNextQueueItem,
        updateQueueItem,
        approveQueueItem,
        rejectQueueItem,
        markQueueItemSent,
        markQueueItemFailed,
        bulkApproveQueue,
        bulkRejectQueue,

        // Accounts
        getAccounts,
        addAccount,
        getAccount,
        updateAccount,
        deleteAccount,
        getAccountCookies,
        canAccountSend,
        incrementAccountDM,
        checkAccountShadowban,
        getAccountSubreddits,
        assignAccountToSubreddit,

        // Rotation
        getNextAccountForSubreddit,
        getRotationStatus,
        getNextAvailableAccount,

        // Safety
        getSafetyEvents,
        logSafetyEvent,
        getAccountHealth,

        // Rules
        getRules,
        createRule,
        updateRule,
        deleteRule,
        evaluateRules,
        getRuleTemplates,

        // Conversations
        getConversations,
        getConversation,
        updateConversation,
        getConversationStats,
        syncConversation,
        getReplySuggestion
    };
}
