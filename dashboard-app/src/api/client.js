/**
 * API Client for Reddit Automation Dashboard
 */

const API_BASE_URL = import.meta.env.VITE_API_URL || '/api';

async function apiRequest(endpoint, options = {}) {
    const url = `${API_BASE_URL}${endpoint}`;

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
    const params = new URLSearchParams(filters);
    const result = await apiRequest(`/queue?${params}`);
    return result.data;
}

export async function getQueueStats() {
    const result = await apiRequest('/queue/stats');
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

// Accounts
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
    const params = new URLSearchParams(filters);
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

export async function getReplySuggestion(id) {
    const result = await apiRequest(`/conversations/${id}/reply-suggestion`, { method: 'POST' });
    return result.data.suggestion;
}

// Rules
export async function getRules() {
    const result = await apiRequest('/rules');
    return result.data;
}

export async function createRule(data) {
    const result = await apiRequest('/rules', {
        method: 'POST',
        body: JSON.stringify(data)
    });
    return result.data;
}

export async function updateRule(id, data) {
    const result = await apiRequest(`/rules/${id}`, {
        method: 'PATCH',
        body: JSON.stringify(data)
    });
    return result.data;
}

export async function deleteRule(id) {
    await apiRequest(`/rules/${id}`, { method: 'DELETE' });
}

export async function getRuleTemplates() {
    const result = await apiRequest('/rules/templates');
    return result.data;
}

// Safety
export async function getSafetyEvents(filters = {}) {
    const params = new URLSearchParams(filters);
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
