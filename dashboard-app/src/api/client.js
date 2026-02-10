/**
 * API Client for Reddit Automation Dashboard
 * Uses Supabase JWT authentication and team context
 */

import { supabase } from '../lib/supabase';

const API_BASE_URL = import.meta.env.VITE_API_URL || 'http://localhost:3000/api';

// Get API key from localStorage or environment (legacy, kept for backwards compatibility)
function getApiKey() {
    return localStorage.getItem('apiKey') || import.meta.env.VITE_API_KEY || '';
}

// Set API key in localStorage
export function setApiKey(key) {
    localStorage.setItem('apiKey', key);
}

// Clear API key
export function clearApiKey() {
    localStorage.removeItem('apiKey');
}

// Get current team ID from localStorage
function getCurrentTeamId() {
    return localStorage.getItem('currentTeamId') || '';
}

// Cached access token - updated on auth state changes
let _cachedAccessToken = null;

// Listen for session changes and cache the token
supabase.auth.onAuthStateChange((_event, session) => {
    _cachedAccessToken = session?.access_token || null;
});

// Get Supabase access token (uses cache, falls back to getSession)
async function getAccessToken() {
    if (_cachedAccessToken) return _cachedAccessToken;
    try {
        const { data: { session } } = await supabase.auth.getSession();
        _cachedAccessToken = session?.access_token || null;
        return _cachedAccessToken;
    } catch {
        return null;
    }
}

export async function apiRequest(endpoint, options = {}) {
    const url = `${API_BASE_URL}${endpoint}`;
    const apiKey = getApiKey();
    const teamId = getCurrentTeamId();
    const accessToken = await getAccessToken();

    const headers = {
        'Content-Type': 'application/json',
        ...options.headers
    };

    // Add Supabase JWT token (primary auth method)
    if (accessToken) {
        headers['Authorization'] = `Bearer ${accessToken}`;
    }

    // Add team context header
    if (teamId) {
        headers['X-Team-ID'] = teamId;
    }

    // Add API key if available (legacy fallback)
    if (apiKey && !accessToken) {
        headers['X-API-Key'] = apiKey;
    }

    try {
        const response = await fetch(url, {
            ...options,
            headers
        });

        if (!response.ok) {
            if (response.status === 401) {
                throw new Error('Authentication required. Please log in.');
            }
            if (response.status === 403) {
                throw new Error('Access denied. You may not have permission for this team.');
            }
            if (response.status === 429) {
                const error = await response.json().catch(() => ({ error: 'Rate limit exceeded' }));
                throw new Error(error.detail || 'Team quota exceeded. Please try again later.');
            }
            const error = await response.json().catch(() => ({ error: 'Request failed' }));
            throw new Error(error.error || error.detail || 'Request failed');
        }

        return await response.json();
    } catch (error) {
        console.error(`API request failed: ${endpoint}`, error);
        throw error;
    }
}

// Auth
export async function validateApiKey(apiKey) {
    const response = await fetch(`${API_BASE_URL}/auth/validate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ apiKey })
    });
    return await response.json();
}

export async function getStatus() {
    const response = await fetch(`${API_BASE_URL}/status`);
    return await response.json();
}

// Analytics
export async function getAnalytics() {
    const result = await apiRequest('/analytics');
    return result.data;
}

export async function getClassificationStats() {
    const result = await apiRequest('/classification/stats');
    return result.data;
}

export async function getQualificationStats() {
    const result = await apiRequest('/qualification/stats');
    return result.data;
}

// Queue
export async function getQueue(filters = {}) {
    const params = new URLSearchParams();
    Object.entries(filters).forEach(([key, value]) => {
        if (value !== undefined && value !== null && value !== '') {
            params.append(key, value);
        }
    });
    const result = await apiRequest(`/queue?${params}`);
    return result.data;
}

export async function getQueueStats(filters = {}) {
    const params = new URLSearchParams();
    Object.entries(filters).forEach(([key, value]) => {
        if (value !== undefined && value !== null && value !== '') {
            params.append(key, value);
        }
    });
    const qs = params.toString();
    const result = await apiRequest(`/queue/stats${qs ? `?${qs}` : ''}`);
    return result.data;
}

export async function approveQueueItem(id) {
    const result = await apiRequest(`/queue/${id}/approve`, { method: 'POST' });
    return result.data;
}

export async function rejectQueueItem(id, reason) {
    const result = await apiRequest(`/queue/${id}/reject`, {
        method: 'POST',
        body: JSON.stringify({ reason })
    });
    return result.data;
}

export async function bulkApprove(ids) {
    const result = await apiRequest('/queue/bulk-approve', {
        method: 'POST',
        body: JSON.stringify({ ids })
    });
    return result.data;
}

export async function bulkReject(ids, reason) {
    const result = await apiRequest('/queue/bulk-reject', {
        method: 'POST',
        body: JSON.stringify({ ids, reason })
    });
    return result.data;
}

// Reply Queue
export async function addReplyToQueue(data) {
    const result = await apiRequest('/queue/reply', {
        method: 'POST',
        body: JSON.stringify(data)
    });
    return result.data;
}

export async function getReplyQueue(filters = {}) {
    return getQueue({ ...filters, messageType: 'reply' });
}

export async function getReplyQueueStats() {
    const result = await apiRequest('/queue/stats?messageType=reply');
    return result.data;
}

export async function getNextReplyToSend(accountId = null) {
    const params = accountId ? `?accountId=${accountId}` : '';
    const result = await apiRequest(`/queue/next-reply${params}`);
    return result.data;
}

export async function getPendingReplyForConversation(conversationId) {
    const result = await apiRequest(`/queue/pending-reply/${conversationId}`);
    return result.data;
}

// Accounts
export async function getAccountsSummary() {
    const result = await apiRequest('/accounts/summary');
    return result.data;
}

export async function getAccounts() {
    const result = await apiRequest('/accounts');
    return result.data;
}

export async function addAccount(data) {
    const result = await apiRequest('/accounts', {
        method: 'POST',
        body: JSON.stringify(data)
    });
    return result.data;
}

export async function updateAccount(id, data) {
    const result = await apiRequest(`/accounts/${id}`, {
        method: 'PATCH',
        body: JSON.stringify(data)
    });
    return result.data;
}

export async function deleteAccount(id) {
    await apiRequest(`/accounts/${id}`, { method: 'DELETE' });
}

export async function checkShadowban(id) {
    const result = await apiRequest(`/accounts/${id}/check-shadowban`, { method: 'POST' });
    return result.data;
}

export async function getRotationStatus() {
    const result = await apiRequest('/rotation/status');
    return result.data;
}

// Conversations
export async function getConversations(filters = {}) {
    const params = new URLSearchParams();
    Object.entries(filters).forEach(([key, value]) => {
        if (value !== undefined && value !== null && value !== '') {
            params.append(key, value);
        }
    });
    const result = await apiRequest(`/conversations?${params}`);
    return result.data;
}

export async function getConversation(id) {
    const result = await apiRequest(`/conversations/${id}`);
    return result.data;
}

export async function updateConversation(id, data) {
    const result = await apiRequest(`/conversations/${id}`, {
        method: 'PATCH',
        body: JSON.stringify(data)
    });
    return result.data;
}

export async function getConversationStats() {
    const result = await apiRequest('/conversations/stats');
    return result.data;
}

export async function getConversationMessages(id, limit = 100) {
    const result = await apiRequest(`/conversations/${id}/messages?limit=${limit}`);
    return result.data;
}

export async function getReplySuggestion(id) {
    const result = await apiRequest(`/conversations/${id}/reply-suggestion`, { method: 'POST' });
    return result.data.suggestion;
}

// Safety
export async function getSafetyEvents(filters = {}) {
    const params = new URLSearchParams();
    Object.entries(filters).forEach(([key, value]) => {
        if (value !== undefined && value !== null && value !== '') {
            params.append(key, value);
        }
    });
    const result = await apiRequest(`/safety/events?${params}`);
    return result.data;
}

export async function getAccountHealth(accountId) {
    const result = await apiRequest(`/safety/health/${accountId}`);
    return result.data;
}

// DM History
export async function getDMHistory(limit = 50) {
    const result = await apiRequest(`/dm/history?limit=${limit}`);
    return result.data;
}

export async function getDMsBySubreddit(limit = 10) {
    const result = await apiRequest(`/dm/subreddits?limit=${limit}`);
    return result.data;
}

// Session logs
export async function getSessionLogs(limit = 20) {
    const result = await apiRequest(`/session/logs?limit=${limit}`);
    return result.data;
}

// User Settings
export async function getUserSettings() {
    const result = await apiRequest('/settings');
    return result.data;
}

export async function saveUserSettings(data) {
    const result = await apiRequest('/settings', {
        method: 'POST',
        body: JSON.stringify(data)
    });
    return result.data;
}

// Automation Settings
export async function getAutomationSettings() {
    const result = await apiRequest('/automation-settings');
    return result.data;
}

export async function saveAutomationSettings(data) {
    const result = await apiRequest('/automation-settings', {
        method: 'POST',
        body: JSON.stringify(data)
    });
    return result.data;
}

// Skipped Posts
export async function getSkippedPosts(filters = {}) {
    const params = new URLSearchParams();
    Object.entries(filters).forEach(([key, value]) => {
        if (value !== undefined && value !== null && value !== '') {
            params.append(key, value);
        }
    });
    const result = await apiRequest(`/skipped-posts?${params}`);
    return result.data;
}

export async function getSkipStats() {
    const result = await apiRequest('/skipped-posts/stats');
    return result.data;
}

// Audit Log
export async function getAuditLog(filters = {}) {
    const params = new URLSearchParams();
    Object.entries(filters).forEach(([key, value]) => {
        if (value !== undefined && value !== null && value !== '') {
            params.append(key, value);
        }
    });
    const result = await apiRequest(`/audit?${params}`);
    return result;
}

// Team Analytics
export async function getTeamAnalytics(period = '30d') {
    const result = await apiRequest(`/team-analytics?period=${period}`);
    return result.data;
}

// Quota Status
export async function getQuotaStatus() {
    const result = await apiRequest('/quotas/status');
    return result.data;
}

// ============================================================================
// Discovery
// ============================================================================

export async function startDiscovery(data) {
    const result = await apiRequest('/discovery/start', {
        method: 'POST',
        body: JSON.stringify(data),
    });
    return result.data;
}

export async function getDiscoverySessions(limit = 20, offset = 0) {
    const result = await apiRequest(`/discovery/sessions?limit=${limit}&offset=${offset}`);
    return result.data;
}

export async function getDiscoverySession(sessionId) {
    const result = await apiRequest(`/discovery/sessions/${sessionId}`);
    return result.data;
}

export async function cancelDiscovery(sessionId) {
    const result = await apiRequest(`/discovery/sessions/${sessionId}/cancel`, { method: 'POST' });
    return result.data;
}

export async function getDiscoverySubreddits(sessionId) {
    const result = await apiRequest(`/discovery/sessions/${sessionId}/subreddits`);
    return result.data;
}

export async function getDiscoveryLeads(sessionId, filters = {}) {
    const params = new URLSearchParams();
    Object.entries(filters).forEach(([key, value]) => {
        if (value !== undefined && value !== null && value !== '') {
            params.append(key, value);
        }
    });
    const qs = params.toString();
    const result = await apiRequest(`/discovery/sessions/${sessionId}/leads${qs ? '?' + qs : ''}`);
    return result.data;
}

export async function getDiscoveryLeadDetail(sessionId, leadId) {
    const result = await apiRequest(`/discovery/sessions/${sessionId}/leads/${leadId}`);
    return result.data;
}

export async function generateLeadMessage(sessionId, leadId) {
    const result = await apiRequest(`/discovery/sessions/${sessionId}/leads/${leadId}/generate-message`, {
        method: 'POST',
    });
    return result.data;
}

export async function queueLead(sessionId, leadId, data) {
    const result = await apiRequest(`/discovery/sessions/${sessionId}/leads/${leadId}/queue`, {
        method: 'POST',
        body: JSON.stringify(data),
    });
    return result.data;
}

export async function dismissLead(sessionId, leadId) {
    const result = await apiRequest(`/discovery/sessions/${sessionId}/leads/${leadId}/dismiss`, {
        method: 'POST',
    });
    return result;
}

export async function bulkQueueLeads(sessionId, data) {
    const result = await apiRequest(`/discovery/sessions/${sessionId}/leads/bulk-queue`, {
        method: 'POST',
        body: JSON.stringify(data),
    });
    return result.data;
}

// Extension Direct Send
// Opens Reddit chat page with reply data encoded in the URL hash.
// The Chrome extension's content script detects #__rdm_send= and triggers automation.
export function triggerExtensionSend(username, message, queueItemId, conversationId, accountId = null) {
    const payload = { username, message, queueItemId, conversationId, accountId };
    const encoded = btoa(JSON.stringify(payload));
    const url = `https://www.reddit.com/chat/#__rdm_send=${encoded}`;
    window.open(url, '_blank');
}

// ============================================================================
// Automation Stats & Extension Communication
// ============================================================================

// Get automation stats for a discovery session (queued/approved/sent/failed counts)
export async function getAutomationStats(sessionId) {
    const result = await apiRequest(`/discovery/sessions/${sessionId}/automation-stats`);
    return result.data;
}

// Check if Chrome extension is available via bridge PING/PONG
export function checkExtensionAvailable() {
    return new Promise((resolve) => {
        const timeout = setTimeout(() => resolve(false), 2000);
        const handler = (event) => {
            if (event.data?.type === 'RDM_EXTENSION_PONG') {
                clearTimeout(timeout);
                window.removeEventListener('message', handler);
                resolve(true);
            }
        };
        window.addEventListener('message', handler);
        window.postMessage({ type: 'RDM_AUTH_EVENT', action: 'PING' }, '*');
    });
}

// Signal extension to start/stop outreach queue processing
export function triggerOutreachPolling(start = true) {
    const action = start ? 'START_OUTREACH_POLLING' : 'STOP_OUTREACH_POLLING';
    window.postMessage({ type: 'RDM_AUTH_EVENT', action, payload: {} }, '*');
    return new Promise((resolve) => {
        const timeout = setTimeout(() => resolve(false), 3000);
        const handler = (event) => {
            if (event.data?.type === 'RDM_AUTH_RESPONSE' && event.data?.action === action) {
                clearTimeout(timeout);
                window.removeEventListener('message', handler);
                resolve(event.data.success);
            }
        };
        window.addEventListener('message', handler);
    });
}

// Get outreach queue status from extension
export function getOutreachQueueStatus() {
    window.postMessage({ type: 'RDM_AUTH_EVENT', action: 'GET_OUTREACH_STATUS', payload: {} }, '*');
    return new Promise((resolve) => {
        const timeout = setTimeout(() => resolve({ isPolling: false, isProcessing: false }), 3000);
        const handler = (event) => {
            if (event.data?.type === 'RDM_AUTH_RESPONSE' && event.data?.action === 'GET_OUTREACH_STATUS') {
                clearTimeout(timeout);
                window.removeEventListener('message', handler);
                resolve(event.data.data || { isPolling: false, isProcessing: false });
            }
        };
        window.addEventListener('message', handler);
    });
}
