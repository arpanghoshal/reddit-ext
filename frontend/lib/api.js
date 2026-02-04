// API Client for Reddit Automated DM Backend
// All API calls go through the backend server

// Default timeout for API requests (5 seconds - fast fail when backend is down)
const DEFAULT_TIMEOUT = 5000;

// Maximum retries for failed requests (reduced for faster fail when backend is down)
const MAX_RETRIES = 1;

// Retry delay base (exponential backoff)
const RETRY_DELAY_BASE = 1000;

let apiConfig = {
    baseUrl: null,
    apiKey: null,
    initialized: false
};

// Reset config cache (call when settings change)
function resetApiConfig() {
    apiConfig = {
        baseUrl: null,
        apiKey: null,
        initialized: false
    };
}

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

async function addConversationMessage(conversationId, messageData) {
    const result = await apiRequest(`/conversations/${conversationId}/messages`, {
        method: 'POST',
        body: JSON.stringify(messageData)
    });
    return result.data;
}

// ============================================
// REPLY QUEUE FUNCTIONS
// ============================================

async function addReplyToQueue(item) {
    const result = await apiRequest('/queue/reply', {
        method: 'POST',
        body: JSON.stringify(item)
    });
    return result.data;
}

async function getNextReplyToSend(accountId = null) {
    const url = accountId ? `/queue/next-reply?accountId=${accountId}` : '/queue/next-reply';
    const result = await apiRequest(url);
    return result.data;
}

async function getPendingReplyForConversation(conversationId) {
    const result = await apiRequest(`/queue/pending-reply/${conversationId}`);
    return result.data;
}

// ============================================
// USER ANALYSIS FUNCTIONS (Deep Profile)
// ============================================

async function analyzeUser(username, forceRefresh = false) {
    const result = await apiRequest(`/user-analysis/${encodeURIComponent(username)}?forceRefresh=${forceRefresh}`);
    return result.data;
}

async function getOptimalSendTime(username) {
    const result = await apiRequest(`/user-analysis/${encodeURIComponent(username)}/optimal-time`);
    return result.data;
}

async function getSubredditCulture(subreddit) {
    const result = await apiRequest(`/subreddit-culture/${encodeURIComponent(subreddit)}`);
    return result.data;
}

// ============================================
// LEAD SCORING FUNCTIONS
// ============================================

async function calculateLeadScore(post, classification, qualification, userProfile = null) {
    const result = await apiRequest('/lead-score', {
        method: 'POST',
        body: JSON.stringify({ post, classification, qualification, userProfile })
    });
    return result.data;
}

async function scoreLeadsBatch(leads) {
    const result = await apiRequest('/lead-score/batch', {
        method: 'POST',
        body: JSON.stringify({ leads })
    });
    return result.data;
}

async function getLeadScoreStats(days = 7) {
    const result = await apiRequest(`/lead-score/stats?days=${days}`);
    return result.data;
}

// ============================================
// INTENT DETECTION FUNCTIONS
// ============================================

async function detectIntent(message, conversationContext = '', useLlmFallback = true) {
    const result = await apiRequest('/intent/detect', {
        method: 'POST',
        body: JSON.stringify({ message, conversationContext, useLlmFallback })
    });
    return result.data;
}

async function getIntentTemplate(intentName) {
    const result = await apiRequest(`/intent/${encodeURIComponent(intentName)}/template`);
    return result.data;
}

async function analyzeSentimentTrajectory(messages) {
    const result = await apiRequest('/intent/sentiment-trajectory', {
        method: 'POST',
        body: JSON.stringify({ messages })
    });
    return result.data;
}

// ============================================
// A/B TESTING FUNCTIONS
// ============================================

async function getExperiments(status = 'running') {
    const result = await apiRequest(`/experiments?status=${status}`);
    return result.data || [];
}

async function createExperiment(experimentData) {
    const result = await apiRequest('/experiments', {
        method: 'POST',
        body: JSON.stringify(experimentData)
    });
    return result.data;
}

async function getExperiment(experimentId) {
    const result = await apiRequest(`/experiments/${experimentId}`);
    return result.data;
}

async function getExperimentStats(experimentId) {
    const result = await apiRequest(`/experiments/${experimentId}/stats`);
    return result.data;
}

async function selectVariant(experimentId) {
    const result = await apiRequest(`/experiments/${experimentId}/select-variant`, {
        method: 'POST'
    });
    return result.data;
}

async function recordExperimentOutcome(experimentId, variantId, success, dmId = null) {
    const result = await apiRequest(`/experiments/${experimentId}/variants/${variantId}/outcome`, {
        method: 'POST',
        body: JSON.stringify({ success, dmId })
    });
    return result.success;
}

async function checkExperimentSignificance(experimentId) {
    const result = await apiRequest(`/experiments/${experimentId}/significance`);
    return result.data;
}

async function pauseExperiment(experimentId) {
    const result = await apiRequest(`/experiments/${experimentId}/pause`, {
        method: 'POST'
    });
    return result.data;
}

async function resumeExperiment(experimentId) {
    const result = await apiRequest(`/experiments/${experimentId}/resume`, {
        method: 'POST'
    });
    return result.data;
}

async function promoteExperimentWinner(experimentId) {
    const result = await apiRequest(`/experiments/${experimentId}/promote-winner`, {
        method: 'POST'
    });
    return result.data;
}

// ============================================
// ANALYTICS FUNCTIONS (Funnel & ROI)
// ============================================

async function getFunnelMetrics(options = {}) {
    const queryParams = new URLSearchParams();
    if (options.startDate) queryParams.set('startDate', options.startDate);
    if (options.endDate) queryParams.set('endDate', options.endDate);
    if (options.accountId) queryParams.set('accountId', options.accountId);
    if (options.subreddit) queryParams.set('subreddit', options.subreddit);

    const result = await apiRequest(`/analytics/funnel?${queryParams}`);
    return result.data;
}

async function logFunnelEvent(event) {
    const result = await apiRequest('/analytics/funnel/event', {
        method: 'POST',
        body: JSON.stringify(event)
    });
    return result.data;
}

async function getROIMetrics(options = {}) {
    const queryParams = new URLSearchParams();
    if (options.startDate) queryParams.set('startDate', options.startDate);
    if (options.endDate) queryParams.set('endDate', options.endDate);

    const result = await apiRequest(`/analytics/roi?${queryParams}`);
    return result.data;
}

async function logConversion(conversionData) {
    const result = await apiRequest('/analytics/conversion', {
        method: 'POST',
        body: JSON.stringify(conversionData)
    });
    return result.data;
}

async function getPerformanceBySubreddit(options = {}) {
    const queryParams = new URLSearchParams();
    if (options.startDate) queryParams.set('startDate', options.startDate);
    if (options.endDate) queryParams.set('endDate', options.endDate);
    if (options.limit) queryParams.set('limit', options.limit);

    const result = await apiRequest(`/analytics/by-subreddit?${queryParams}`);
    return result.data || [];
}

async function getPerformanceByDay(options = {}) {
    const queryParams = new URLSearchParams();
    if (options.startDate) queryParams.set('startDate', options.startDate);
    if (options.endDate) queryParams.set('endDate', options.endDate);

    const result = await apiRequest(`/analytics/by-day?${queryParams}`);
    return result.data || [];
}

async function getRecommendations() {
    const result = await apiRequest('/analytics/recommendations');
    return result.data || [];
}

async function getDashboardSummary() {
    const result = await apiRequest('/analytics/dashboard');
    return result.data;
}

// ============================================
// SAFETY PRE-SEND CHECK FUNCTIONS
// ============================================

async function preSendSafetyCheck(accountId, recipientUsername, message, subreddit = null) {
    const result = await apiRequest('/safety/pre-send-check', {
        method: 'POST',
        body: JSON.stringify({ accountId, recipientUsername, message, subreddit })
    });
    return result.data;
}

async function getRiskAssessment(accountId) {
    const result = await apiRequest(`/safety/risk-assessment/${accountId}`);
    return result.data;
}

async function checkDuplicateRecipient(recipientUsername, excludeAccountId = null, lookbackDays = 30) {
    const result = await apiRequest('/safety/check-duplicate', {
        method: 'POST',
        body: JSON.stringify({ recipientUsername, excludeAccountId, lookbackDays })
    });
    return result.data;
}

// =============================================================================
// CONVERSATION AI (Automated Replies & Follow-ups)
// =============================================================================

async function getConversationsNeedingReply(accountId = null, limit = 50) {
    const params = new URLSearchParams();
    if (accountId) params.append('accountId', accountId);
    params.append('limit', limit.toString());
    const result = await apiRequest(`/conversations/needing-reply?${params}`);
    return result.data;
}

async function analyzeReply(conversation, settings = null) {
    const result = await apiRequest('/conversations/analyze-reply', {
        method: 'POST',
        body: JSON.stringify({ conversation, settings })
    });
    return result.data;
}

async function processPendingReplies(accountId = null, autoSend = false, settings = null) {
    const result = await apiRequest('/conversations/process-pending-replies', {
        method: 'POST',
        body: JSON.stringify({ accountId, autoSend, settings })
    });
    return result.data;
}

async function getConversationsNeedingFollowUp(accountId = null, limit = 50) {
    const params = new URLSearchParams();
    if (accountId) params.append('accountId', accountId);
    params.append('limit', limit.toString());
    const result = await apiRequest(`/conversations/needing-follow-up?${params}`);
    return result.data;
}

async function generateFollowUp(conversation, settings = null) {
    const result = await apiRequest('/conversations/generate-follow-up', {
        method: 'POST',
        body: JSON.stringify({ conversation, settings })
    });
    return result.data;
}

async function processScheduledFollowUps(accountId = null, autoQueue = false, settings = null) {
    const result = await apiRequest('/conversations/process-follow-ups', {
        method: 'POST',
        body: JSON.stringify({ accountId, autoQueue, settings })
    });
    return result.data;
}

async function getPrioritizedConversations(accountId = null, limit = 20) {
    const params = new URLSearchParams();
    if (accountId) params.append('accountId', accountId);
    params.append('limit', limit.toString());
    const result = await apiRequest(`/conversations/prioritized?${params}`);
    return result.data;
}

async function getConversationSummary(accountId = null) {
    const params = new URLSearchParams();
    if (accountId) params.append('accountId', accountId);
    const result = await apiRequest(`/conversations/summary?${params}`);
    return result.data;
}

async function getConversationHealth(conversationId) {
    const result = await apiRequest(`/conversations/${conversationId}/health`);
    return result.data;
}

async function queueFollowUp(conversationId, message, accountId) {
    const result = await apiRequest('/conversations/queue-follow-up', {
        method: 'POST',
        body: JSON.stringify({ conversationId, message, accountId })
    });
    return result.success;
}

// ES Module exports
export {
    // Config management
    resetApiConfig,

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
    getReplySuggestion,
    addConversationMessage,

    // Reply Queue
    addReplyToQueue,
    getNextReplyToSend,
    getPendingReplyForConversation,

    // User Analysis (Deep Profile)
    analyzeUser,
    getOptimalSendTime,
    getSubredditCulture,

    // Lead Scoring
    calculateLeadScore,
    scoreLeadsBatch,
    getLeadScoreStats,

    // Intent Detection
    detectIntent,
    getIntentTemplate,
    analyzeSentimentTrajectory,

    // A/B Testing
    getExperiments,
    createExperiment,
    getExperiment,
    getExperimentStats,
    selectVariant,
    recordExperimentOutcome,
    checkExperimentSignificance,
    pauseExperiment,
    resumeExperiment,
    promoteExperimentWinner,

    // Analytics (Funnel & ROI)
    getFunnelMetrics,
    logFunnelEvent,
    getROIMetrics,
    logConversion,
    getPerformanceBySubreddit,
    getPerformanceByDay,
    getRecommendations,
    getDashboardSummary,

    // Safety Pre-Send Check
    preSendSafetyCheck,
    getRiskAssessment,
    checkDuplicateRecipient,

    // Conversation AI (Automated Replies & Follow-ups)
    getConversationsNeedingReply,
    analyzeReply,
    processPendingReplies,
    getConversationsNeedingFollowUp,
    generateFollowUp,
    processScheduledFollowUps,
    getPrioritizedConversations,
    getConversationSummary,
    getConversationHealth,
    queueFollowUp
};
