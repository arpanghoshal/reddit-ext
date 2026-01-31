// Dashboard Script for Reddit Automated DM
console.log('Dashboard loading...');

// =============================================================================
// API Configuration
// =============================================================================

let backendUrl = 'http://localhost:8000';
let apiKey = '';

async function loadConfig() {
    const data = await chrome.storage.local.get(['backendUrl', 'apiKey']);
    backendUrl = data.backendUrl || 'http://localhost:8000';
    apiKey = data.apiKey || '';
}

async function apiRequest(endpoint, options = {}) {
    const headers = {
        'Content-Type': 'application/json',
        ...(apiKey ? { 'X-API-Key': apiKey } : {}),
        ...options.headers
    };

    try {
        const response = await fetch(`${backendUrl}/api${endpoint}`, {
            ...options,
            headers
        });

        if (!response.ok) {
            throw new Error(`API Error: ${response.status}`);
        }

        return await response.json();
    } catch (error) {
        console.error(`API request failed: ${endpoint}`, error);
        throw error;
    }
}

// =============================================================================
// Tab Navigation
// =============================================================================

function initTabNavigation() {
    const navItems = document.querySelectorAll('.nav-item');
    const tabContents = document.querySelectorAll('.tab-content');

    navItems.forEach(item => {
        item.addEventListener('click', () => {
            const tabId = item.dataset.tab;

            // Update nav active state
            navItems.forEach(nav => nav.classList.remove('active'));
            item.classList.add('active');

            // Show corresponding tab content
            tabContents.forEach(tab => {
                tab.classList.remove('active');
                if (tab.id === `tab-${tabId}`) {
                    tab.classList.add('active');
                    loadTabData(tabId);
                }
            });
        });
    });

    // Handle tab links
    document.querySelectorAll('[data-tab-link]').forEach(link => {
        link.addEventListener('click', (e) => {
            e.preventDefault();
            const tabId = link.dataset.tabLink;
            document.querySelector(`[data-tab="${tabId}"]`).click();
        });
    });
}

function loadTabData(tabId) {
    switch (tabId) {
        case 'overview':
            loadOverviewData();
            break;
        case 'queue':
            loadQueueData();
            break;
        case 'conversations':
            loadConversationsData();
            break;
        case 'accounts':
            loadAccountsData();
            break;
        case 'analytics':
            loadAnalyticsData();
            break;
        case 'settings':
            loadSettings();
            break;
    }
}

// =============================================================================
// Connection Status
// =============================================================================

async function checkConnection() {
    const indicator = document.getElementById('connection-indicator');

    try {
        const response = await apiRequest('/status');
        indicator.classList.remove('error');
        indicator.classList.add('connected');
        indicator.querySelector('.text').textContent = 'Connected';
        return true;
    } catch (error) {
        indicator.classList.remove('connected');
        indicator.classList.add('error');
        indicator.querySelector('.text').textContent = 'Disconnected';
        return false;
    }
}

// =============================================================================
// Overview Tab
// =============================================================================

async function loadOverviewData() {
    await Promise.all([
        loadDashboardSummary(),
        loadFunnelMetrics(),
        loadRecentActivity(),
        loadRecommendations()
    ]);
}

async function loadDashboardSummary() {
    try {
        const response = await apiRequest('/analytics/dashboard');
        const data = response.data || {};

        document.getElementById('metric-dms-sent').textContent = data.todayDMs || 0;
        document.getElementById('metric-replies').textContent = data.totalReplies || 0;
        document.getElementById('metric-pending').textContent = data.pendingQueue || 0;
        document.getElementById('metric-reply-rate').textContent =
            data.replyRate ? `${data.replyRate}%` : '-';

        // Update badges
        document.getElementById('queue-badge').textContent = data.pendingQueue || 0;
        document.getElementById('conversations-badge').textContent = data.activeConversations || 0;
    } catch (error) {
        console.error('Failed to load dashboard summary:', error);
    }
}

async function loadFunnelMetrics() {
    try {
        const response = await apiRequest('/analytics/funnel');
        const data = response.data || {};

        document.getElementById('funnel-posts').textContent = data.postsIdentified || 0;
        document.getElementById('funnel-qualified').textContent = data.postsQualified || 0;
        document.getElementById('funnel-sent').textContent = data.dmsSent || 0;
        document.getElementById('funnel-replies').textContent = data.repliesReceived || 0;
        document.getElementById('funnel-positive').textContent = data.positiveReplies || 0;

        // Update funnel bar widths
        const total = data.postsIdentified || 1;
        const stages = [
            { id: 0, value: total },
            { id: 1, value: data.postsQualified || 0 },
            { id: 2, value: data.dmsSent || 0 },
            { id: 3, value: data.repliesReceived || 0 },
            { id: 4, value: data.positiveReplies || 0 }
        ];

        const funnelBars = document.querySelectorAll('.funnel-bar');
        stages.forEach((stage, i) => {
            if (funnelBars[i]) {
                const percentage = Math.max(10, (stage.value / total) * 100);
                funnelBars[i].style.width = `${percentage}%`;
            }
        });
    } catch (error) {
        console.error('Failed to load funnel metrics:', error);
    }
}

async function loadRecentActivity() {
    const container = document.getElementById('recent-activity');

    try {
        const response = await apiRequest('/dm/history?limit=10');
        const history = response.data || [];

        if (history.length === 0) {
            container.innerHTML = '<div class="empty-state"><p>No recent activity</p></div>';
            return;
        }

        container.innerHTML = history.map(item => `
            <div class="activity-item">
                <div class="activity-avatar">${(item.recipient_username || 'U')[0].toUpperCase()}</div>
                <div class="activity-content">
                    <div class="activity-title">DM to u/${item.recipient_username}</div>
                    <div class="activity-meta">${item.subreddit ? `r/${item.subreddit}` : ''} &bull; ${formatTimeAgo(item.created_at)}</div>
                </div>
                <span class="activity-status ${item.status}">${item.status}</span>
            </div>
        `).join('');
    } catch (error) {
        container.innerHTML = '<div class="empty-state"><p>Failed to load activity</p></div>';
    }
}

async function loadRecommendations() {
    const container = document.getElementById('recommendations');

    try {
        const response = await apiRequest('/analytics/recommendations');
        const recommendations = response.data || [];

        if (recommendations.length === 0) {
            container.innerHTML = '<div class="empty-state"><p>No recommendations at this time</p></div>';
            return;
        }

        const icons = {
            high: '<div class="recommendation-icon" style="background: rgba(220, 53, 69, 0.15); color: #dc3545;">!</div>',
            medium: '<div class="recommendation-icon" style="background: rgba(255, 165, 0, 0.15); color: #ffa500;">*</div>',
            low: '<div class="recommendation-icon" style="background: rgba(0, 121, 211, 0.15); color: #0079d3;">i</div>'
        };

        container.innerHTML = recommendations.slice(0, 5).map(rec => `
            <div class="recommendation-item">
                ${icons[rec.priority] || icons.low}
                <div class="recommendation-content">
                    <div class="recommendation-title">${rec.title}</div>
                    <div class="recommendation-desc">${rec.description}</div>
                </div>
            </div>
        `).join('');
    } catch (error) {
        container.innerHTML = '<div class="empty-state"><p>Failed to load recommendations</p></div>';
    }
}

// =============================================================================
// Queue Tab
// =============================================================================

let selectedQueueItems = new Set();

async function loadQueueData() {
    await Promise.all([
        loadQueueStats(),
        loadQueueItems()
    ]);

    initQueueEventListeners();
}

async function loadQueueStats() {
    try {
        const response = await apiRequest('/queue/stats');
        const stats = response.data || {};

        document.getElementById('queue-stat-pending').textContent = stats.pending || 0;
        document.getElementById('queue-stat-approved').textContent = stats.approved || 0;
        document.getElementById('queue-stat-sent').textContent = stats.sentToday || 0;
        document.getElementById('queue-stat-failed').textContent = stats.failed || 0;

        document.getElementById('queue-badge').textContent = stats.pending || 0;
    } catch (error) {
        console.error('Failed to load queue stats:', error);
    }
}

async function loadQueueItems() {
    const tbody = document.getElementById('queue-tbody');
    const filter = document.getElementById('queue-filter').value;

    tbody.innerHTML = '<tr><td colspan="7" class="loading-state">Loading...</td></tr>';

    try {
        const response = await apiRequest(`/queue?status=${filter}&limit=50`);
        const items = response.data || [];

        if (items.length === 0) {
            tbody.innerHTML = `<tr><td colspan="7" class="empty-state">No ${filter} items</td></tr>`;
            return;
        }

        tbody.innerHTML = items.map(item => `
            <tr data-id="${item.id}">
                <td><input type="checkbox" class="queue-checkbox" data-id="${item.id}"></td>
                <td>u/${item.recipient_username}</td>
                <td>${item.subreddit ? `r/${item.subreddit}` : '-'}</td>
                <td class="message-preview">${truncate(item.generated_message || item.edited_message || '', 50)}</td>
                <td>${item.classification_score ? (item.classification_score * 100).toFixed(0) + '%' : '-'}</td>
                <td><span class="status-badge ${item.status}">${item.status}</span></td>
                <td class="table-actions">
                    ${item.status === 'pending' ? `
                        <button class="btn-icon btn-approve" data-id="${item.id}" title="Approve">
                            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                <polyline points="20 6 9 17 4 12"></polyline>
                            </svg>
                        </button>
                        <button class="btn-icon btn-reject" data-id="${item.id}" title="Reject">
                            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                <line x1="18" y1="6" x2="6" y2="18"></line>
                                <line x1="6" y1="6" x2="18" y2="18"></line>
                            </svg>
                        </button>
                    ` : ''}
                    <button class="btn-icon btn-view" data-id="${item.id}" title="View">
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                            <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"></path>
                            <circle cx="12" cy="12" r="3"></circle>
                        </svg>
                    </button>
                </td>
            </tr>
        `).join('');
    } catch (error) {
        tbody.innerHTML = '<tr><td colspan="7" class="empty-state">Failed to load queue</td></tr>';
    }
}

function initQueueEventListeners() {
    // Filter change
    document.getElementById('queue-filter').addEventListener('change', loadQueueItems);

    // Select all
    document.getElementById('select-all-queue').addEventListener('change', (e) => {
        const checkboxes = document.querySelectorAll('.queue-checkbox');
        checkboxes.forEach(cb => {
            cb.checked = e.target.checked;
            if (e.target.checked) {
                selectedQueueItems.add(cb.dataset.id);
            } else {
                selectedQueueItems.delete(cb.dataset.id);
            }
        });
    });

    // Bulk approve
    document.getElementById('bulk-approve-btn').addEventListener('click', async () => {
        if (selectedQueueItems.size === 0) {
            showToast('No items selected', 'warning');
            return;
        }

        try {
            await apiRequest('/queue/bulk-approve', {
                method: 'POST',
                body: JSON.stringify({ ids: Array.from(selectedQueueItems) })
            });
            showToast(`Approved ${selectedQueueItems.size} items`, 'success');
            selectedQueueItems.clear();
            loadQueueData();
        } catch (error) {
            showToast('Failed to approve items', 'error');
        }
    });

    // Individual actions (delegated)
    document.getElementById('queue-tbody').addEventListener('click', async (e) => {
        const btn = e.target.closest('button');
        if (!btn) return;

        const id = btn.dataset.id;
        if (!id) return;

        if (btn.classList.contains('btn-approve')) {
            try {
                await apiRequest(`/queue/${id}/approve`, { method: 'POST' });
                showToast('Item approved', 'success');
                loadQueueData();
            } catch (error) {
                showToast('Failed to approve', 'error');
            }
        } else if (btn.classList.contains('btn-reject')) {
            try {
                await apiRequest(`/queue/${id}/reject`, { method: 'POST' });
                showToast('Item rejected', 'success');
                loadQueueData();
            } catch (error) {
                showToast('Failed to reject', 'error');
            }
        } else if (btn.classList.contains('btn-view')) {
            viewQueueItem(id);
        }
    });

    // Checkbox selection
    document.getElementById('queue-tbody').addEventListener('change', (e) => {
        if (e.target.classList.contains('queue-checkbox')) {
            if (e.target.checked) {
                selectedQueueItems.add(e.target.dataset.id);
            } else {
                selectedQueueItems.delete(e.target.dataset.id);
            }
        }
    });
}

async function viewQueueItem(id) {
    try {
        const response = await apiRequest(`/queue/${id}`);
        const item = response.data;

        const modal = document.getElementById('modal-content');
        modal.innerHTML = `
            <div class="modal-header">
                <h3>Queue Item Details</h3>
                <button class="btn-icon" onclick="closeModal()">&times;</button>
            </div>
            <div class="modal-body">
                <div class="form-group">
                    <label>Recipient</label>
                    <p>u/${item.recipient_username}</p>
                </div>
                <div class="form-group">
                    <label>Subreddit</label>
                    <p>${item.subreddit ? `r/${item.subreddit}` : 'N/A'}</p>
                </div>
                <div class="form-group">
                    <label>Post Title</label>
                    <p>${item.post_title || 'N/A'}</p>
                </div>
                <div class="form-group">
                    <label>Message</label>
                    <textarea rows="5" readonly>${item.edited_message || item.generated_message || ''}</textarea>
                </div>
                <div class="form-group">
                    <label>Status</label>
                    <span class="status-badge ${item.status}">${item.status}</span>
                </div>
            </div>
        `;
        openModal();
    } catch (error) {
        showToast('Failed to load item details', 'error');
    }
}

// =============================================================================
// Conversations Tab
// =============================================================================

let selectedConversationId = null;

async function loadConversationsData() {
    await Promise.all([
        loadConversationStats(),
        loadConversationsList()
    ]);

    initConversationEventListeners();
}

async function loadConversationStats() {
    try {
        const response = await apiRequest('/conversations/stats');
        const stats = response.data || {};

        document.getElementById('conv-stat-total').textContent = stats.total || 0;
        document.getElementById('conv-stat-active').textContent = stats.active || 0;
        document.getElementById('conv-stat-replies').textContent = stats.withReplies || 0;
        document.getElementById('conv-stat-interested').textContent = stats.interested || 0;

        document.getElementById('conversations-badge').textContent = stats.withReplies || 0;
    } catch (error) {
        console.error('Failed to load conversation stats:', error);
    }
}

async function loadConversationsList() {
    const container = document.getElementById('conversations-list');
    const filter = document.getElementById('conv-filter').value;

    container.innerHTML = '<div class="loading-state">Loading...</div>';

    try {
        let endpoint = '/conversations?limit=50';
        if (filter === 'needs-reply') {
            endpoint = '/conversations/needing-reply?limit=50';
        } else if (filter !== 'all') {
            endpoint += `&status=${filter}`;
        }

        const response = await apiRequest(endpoint);
        const conversations = response.data || [];

        if (conversations.length === 0) {
            container.innerHTML = '<div class="empty-state"><p>No conversations found</p></div>';
            return;
        }

        container.innerHTML = conversations.map(conv => `
            <div class="conversation-item ${conv.id === selectedConversationId ? 'active' : ''}" data-id="${conv.id}">
                <div class="conversation-header">
                    <span class="conversation-user">u/${conv.participant_username}</span>
                    <span class="conversation-time">${formatTimeAgo(conv.last_message_at || conv.created_at)}</span>
                </div>
                <div class="conversation-preview">
                    ${conv.has_reply ? '<strong style="color: var(--accent-green);">[Reply]</strong> ' : ''}
                    ${conv.status}
                </div>
            </div>
        `).join('');
    } catch (error) {
        container.innerHTML = '<div class="empty-state"><p>Failed to load conversations</p></div>';
    }
}

function initConversationEventListeners() {
    document.getElementById('conv-filter').addEventListener('change', loadConversationsList);

    document.getElementById('conversations-list').addEventListener('click', (e) => {
        const item = e.target.closest('.conversation-item');
        if (item) {
            const id = item.dataset.id;
            selectedConversationId = id;
            document.querySelectorAll('.conversation-item').forEach(i => i.classList.remove('active'));
            item.classList.add('active');
            loadConversationDetail(id);
        }
    });
}

async function loadConversationDetail(id) {
    const container = document.getElementById('conversation-detail');

    try {
        const [convResponse, messagesResponse] = await Promise.all([
            apiRequest(`/conversations/${id}`),
            apiRequest(`/conversations/${id}/messages?limit=100`)
        ]);

        const conv = convResponse.data;
        const messages = messagesResponse.data || [];

        container.innerHTML = `
            <div class="detail-header">
                <div class="detail-user">
                    <div class="detail-avatar">${conv.participant_username[0].toUpperCase()}</div>
                    <div class="detail-info">
                        <h4>u/${conv.participant_username}</h4>
                        <p><span class="status-badge ${conv.status}">${conv.status}</span></p>
                    </div>
                </div>
                <div>
                    <select class="select-input" id="conv-status-select">
                        <option value="active" ${conv.status === 'active' ? 'selected' : ''}>Active</option>
                        <option value="interested" ${conv.status === 'interested' ? 'selected' : ''}>Interested</option>
                        <option value="cold" ${conv.status === 'cold' ? 'selected' : ''}>Cold</option>
                        <option value="converted" ${conv.status === 'converted' ? 'selected' : ''}>Converted</option>
                        <option value="closed" ${conv.status === 'closed' ? 'selected' : ''}>Closed</option>
                    </select>
                </div>
            </div>
            <div class="messages-container">
                ${messages.length === 0 ? '<div class="empty-state"><p>No messages yet</p></div>' :
                    messages.map(msg => `
                        <div class="message ${msg.direction}">
                            <div class="message-bubble">${msg.content}</div>
                            <div class="message-time">${formatTimeAgo(msg.sent_at || msg.created_at)}</div>
                        </div>
                    `).join('')
                }
            </div>
        `;

        // Status change handler
        document.getElementById('conv-status-select').addEventListener('change', async (e) => {
            try {
                await apiRequest(`/conversations/${id}`, {
                    method: 'PATCH',
                    body: JSON.stringify({ status: e.target.value })
                });
                showToast('Status updated', 'success');
                loadConversationsData();
            } catch (error) {
                showToast('Failed to update status', 'error');
            }
        });
    } catch (error) {
        container.innerHTML = '<div class="empty-state"><p>Failed to load conversation</p></div>';
    }
}

// =============================================================================
// Accounts Tab
// =============================================================================

async function loadAccountsData() {
    const container = document.getElementById('accounts-grid');
    container.innerHTML = '<div class="loading-state">Loading...</div>';

    try {
        const response = await apiRequest('/accounts');
        const accounts = response.data || [];

        if (accounts.length === 0) {
            container.innerHTML = `
                <div class="empty-state" style="grid-column: 1/-1;">
                    <p>No accounts configured</p>
                    <button class="btn-primary" style="margin-top: 16px;" onclick="showAddAccountModal()">Add Account</button>
                </div>
            `;
            return;
        }

        container.innerHTML = accounts.map(account => {
            const healthPercent = account.status === 'shadowbanned' ? 0 :
                account.status === 'suspended' ? 10 :
                    account.warmup_mode ? 50 : 100;
            const healthClass = healthPercent >= 70 ? 'good' : healthPercent >= 40 ? 'warning' : 'danger';

            return `
                <div class="account-card" data-id="${account.id}">
                    <div class="account-header">
                        <div class="account-info">
                            <div class="account-avatar">${account.username[0].toUpperCase()}</div>
                            <div>
                                <div class="account-name">${account.display_name || account.username}</div>
                                <div class="account-username">u/${account.username}</div>
                            </div>
                        </div>
                        <span class="status-badge ${account.status}">${account.status}</span>
                    </div>
                    <div class="account-stats">
                        <div class="account-stat">
                            <div class="account-stat-value">${account.current_daily_count || 0}</div>
                            <div class="account-stat-label">Today</div>
                        </div>
                        <div class="account-stat">
                            <div class="account-stat-value">${account.daily_limit || 20}</div>
                            <div class="account-stat-label">Limit</div>
                        </div>
                        <div class="account-stat">
                            <div class="account-stat-value">${account.warmup_mode ? 'Yes' : 'No'}</div>
                            <div class="account-stat-label">Warmup</div>
                        </div>
                    </div>
                    <div class="account-health">
                        <div class="health-bar">
                            <div class="health-fill ${healthClass}" style="width: ${healthPercent}%"></div>
                        </div>
                        <span class="health-label">${healthPercent}%</span>
                    </div>
                    <div class="account-actions">
                        <button class="btn-secondary" onclick="checkShadowban('${account.id}')">Check Health</button>
                        <button class="btn-secondary" onclick="editAccount('${account.id}')">Edit</button>
                    </div>
                </div>
            `;
        }).join('');
    } catch (error) {
        container.innerHTML = '<div class="empty-state" style="grid-column: 1/-1;"><p>Failed to load accounts</p></div>';
    }
}

async function checkShadowban(accountId) {
    showToast('Checking account health...', 'info');
    try {
        const response = await apiRequest(`/accounts/${accountId}/check-shadowban`, { method: 'POST' });
        if (response.data.isShadowbanned) {
            showToast('Account may be shadowbanned!', 'error');
        } else {
            showToast('Account is healthy', 'success');
        }
        loadAccountsData();
    } catch (error) {
        showToast('Failed to check account', 'error');
    }
}

// =============================================================================
// Analytics Tab
// =============================================================================

async function loadAnalyticsData() {
    const days = document.getElementById('analytics-range').value;

    await Promise.all([
        loadAnalyticsMetrics(days),
        loadPerformanceBySubreddit(days),
        loadDailyPerformance(days),
        loadDMHistory()
    ]);

    initAnalyticsEventListeners();
}

async function loadAnalyticsMetrics(days) {
    try {
        const endDate = new Date().toISOString();
        const startDate = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

        const [funnelResponse, roiResponse] = await Promise.all([
            apiRequest(`/analytics/funnel?startDate=${startDate}&endDate=${endDate}`),
            apiRequest(`/analytics/roi?startDate=${startDate}&endDate=${endDate}`)
        ]);

        const funnel = funnelResponse.data || {};
        const roi = roiResponse.data || {};

        document.getElementById('analytics-total-dms').textContent = funnel.dmsSent || 0;
        document.getElementById('analytics-total-replies').textContent = funnel.repliesReceived || 0;
        document.getElementById('analytics-conversions').textContent = roi.conversions || 0;
        document.getElementById('analytics-roi').textContent = roi.roi ? `${roi.roi}%` : '-';
    } catch (error) {
        console.error('Failed to load analytics metrics:', error);
    }
}

async function loadPerformanceBySubreddit(days) {
    const tbody = document.getElementById('analytics-subreddits');

    try {
        const endDate = new Date().toISOString();
        const startDate = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

        const response = await apiRequest(`/analytics/by-subreddit?startDate=${startDate}&endDate=${endDate}&limit=10`);
        const data = response.data || [];

        if (data.length === 0) {
            tbody.innerHTML = '<tr><td colspan="4" class="empty-state">No data</td></tr>';
            return;
        }

        tbody.innerHTML = data.map(item => `
            <tr>
                <td>r/${item.subreddit}</td>
                <td>${item.dms || 0}</td>
                <td>${item.replies || 0}</td>
                <td>${item.replyRate ? item.replyRate + '%' : '-'}</td>
            </tr>
        `).join('');
    } catch (error) {
        tbody.innerHTML = '<tr><td colspan="4" class="empty-state">Failed to load</td></tr>';
    }
}

async function loadDailyPerformance(days) {
    const container = document.getElementById('daily-chart');

    try {
        const endDate = new Date().toISOString();
        const startDate = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

        const response = await apiRequest(`/analytics/by-day?startDate=${startDate}&endDate=${endDate}`);
        const data = response.data || [];

        if (data.length === 0) {
            container.innerHTML = '<div class="empty-state">No data</div>';
            return;
        }

        const maxValue = Math.max(...data.map(d => d.count || 0), 1);

        container.innerHTML = `
            <div class="chart-bars">
                ${data.slice(-14).map(d => {
                    const height = Math.max(10, ((d.count || 0) / maxValue) * 180);
                    const date = new Date(d.date).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
                    return `
                        <div class="chart-bar" style="height: ${height}px" title="${d.count || 0} DMs on ${date}">
                            <span class="chart-bar-label">${date}</span>
                        </div>
                    `;
                }).join('')}
            </div>
        `;
    } catch (error) {
        container.innerHTML = '<div class="empty-state">Failed to load chart</div>';
    }
}

async function loadDMHistory() {
    const tbody = document.getElementById('dm-history-tbody');

    try {
        const response = await apiRequest('/dm/history?limit=50');
        const history = response.data || [];

        if (history.length === 0) {
            tbody.innerHTML = '<tr><td colspan="5" class="empty-state">No history</td></tr>';
            return;
        }

        tbody.innerHTML = history.map(item => `
            <tr>
                <td>${formatDate(item.created_at)}</td>
                <td>u/${item.recipient_username}</td>
                <td>${item.subreddit ? `r/${item.subreddit}` : '-'}</td>
                <td><span class="status-badge ${item.status}">${item.status}</span></td>
                <td class="message-preview">${truncate(item.message_content || '', 40)}</td>
            </tr>
        `).join('');
    } catch (error) {
        tbody.innerHTML = '<tr><td colspan="5" class="empty-state">Failed to load</td></tr>';
    }
}

function initAnalyticsEventListeners() {
    document.getElementById('analytics-range').addEventListener('change', () => {
        loadAnalyticsData();
    });

    document.getElementById('export-history-btn').addEventListener('click', exportDMHistory);
}

async function exportDMHistory() {
    try {
        const response = await apiRequest('/dm/history?limit=10000');
        const history = response.data || [];

        const csv = [
            'Date,Recipient,Subreddit,Status,Message',
            ...history.map(h => [
                h.created_at,
                h.recipient_username,
                h.subreddit || '',
                h.status,
                `"${(h.message_content || '').replace(/"/g, '""')}"`
            ].join(','))
        ].join('\n');

        const blob = new Blob([csv], { type: 'text/csv' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `dm-history-${new Date().toISOString().split('T')[0]}.csv`;
        a.click();
        URL.revokeObjectURL(url);

        showToast('Export complete', 'success');
    } catch (error) {
        showToast('Export failed', 'error');
    }
}

// =============================================================================
// Settings Tab
// =============================================================================

async function loadSettings() {
    try {
        // Load local storage settings
        const localData = await chrome.storage.local.get([
            'backendUrl', 'apiKey', 'typingSpeed', 'delayBetweenDMs', 'dailyLimit',
            'businessDesc', 'persona', 'tone', 'dmSendMode'
        ]);

        document.getElementById('backend-url').value = localData.backendUrl || 'http://localhost:8000';
        document.getElementById('api-key').value = localData.apiKey || '';
        document.getElementById('typing-speed').value = localData.typingSpeed || 100;
        document.getElementById('speed-value').textContent = localData.typingSpeed || 100;
        document.getElementById('delay-between-dms').value = localData.delayBetweenDMs || 20;
        document.getElementById('delay-value').textContent = localData.delayBetweenDMs || 20;
        document.getElementById('daily-limit').value = localData.dailyLimit || 50;
        document.getElementById('business-desc').value = localData.businessDesc || '';
        document.getElementById('persona').value = localData.persona || '';
        document.getElementById('tone').value = localData.tone || 'curious';

        // Set DM send mode radio button
        const dmSendMode = localData.dmSendMode || 'confirm';
        document.getElementById('dm-mode-auto').checked = dmSendMode === 'auto';
        document.getElementById('dm-mode-confirm').checked = dmSendMode === 'confirm';

        // Load backend settings
        try {
            const response = await apiRequest('/settings');
            if (response.data) {
                document.getElementById('business-desc').value = response.data.business_desc || localData.businessDesc || '';
                document.getElementById('persona').value = response.data.persona || localData.persona || '';
                document.getElementById('tone').value = response.data.tone || localData.tone || 'curious';
            }
        } catch (e) {
            // Backend settings might not be available
        }
    } catch (error) {
        console.error('Failed to load settings:', error);
    }

    initSettingsEventListeners();
}

function initSettingsEventListeners() {
    // Range sliders
    document.getElementById('typing-speed').addEventListener('input', (e) => {
        document.getElementById('speed-value').textContent = e.target.value;
    });

    document.getElementById('delay-between-dms').addEventListener('input', (e) => {
        document.getElementById('delay-value').textContent = e.target.value;
    });

    // Test connection
    document.getElementById('test-connection').addEventListener('click', async () => {
        const url = document.getElementById('backend-url').value;
        const key = document.getElementById('api-key').value;

        try {
            const response = await fetch(`${url}/api/status`, {
                headers: key ? { 'X-API-Key': key } : {}
            });

            if (response.ok) {
                showToast('Connection successful!', 'success');
            } else {
                showToast('Connection failed', 'error');
            }
        } catch (error) {
            showToast('Could not connect to server', 'error');
        }
    });

    // Save settings
    document.getElementById('settings-form').addEventListener('submit', async (e) => {
        e.preventDefault();

        const dmSendMode = document.querySelector('input[name="dm-send-mode"]:checked').value;

        const settings = {
            backendUrl: document.getElementById('backend-url').value,
            apiKey: document.getElementById('api-key').value,
            typingSpeed: parseInt(document.getElementById('typing-speed').value),
            delayBetweenDMs: parseInt(document.getElementById('delay-between-dms').value),
            dailyLimit: parseInt(document.getElementById('daily-limit').value),
            businessDesc: document.getElementById('business-desc').value,
            persona: document.getElementById('persona').value,
            tone: document.getElementById('tone').value,
            dmSendMode: dmSendMode
        };

        try {
            await chrome.storage.local.set(settings);

            // Update global config
            backendUrl = settings.backendUrl;
            apiKey = settings.apiKey;

            // Save to backend
            try {
                await apiRequest('/settings', {
                    method: 'POST',
                    body: JSON.stringify({
                        businessDesc: settings.businessDesc,
                        persona: settings.persona,
                        tone: settings.tone
                    })
                });
            } catch (e) {
                // Backend save might fail
            }

            // Notify background script
            chrome.runtime.sendMessage({ action: 'SETTINGS_UPDATED', settings });

            showToast('Settings saved', 'success');
            checkConnection();
        } catch (error) {
            showToast('Failed to save settings', 'error');
        }
    });

    // Reset to defaults
    document.getElementById('reset-btn').addEventListener('click', async () => {
        if (confirm('Reset all settings to defaults?')) {
            await chrome.storage.local.remove([
                'backendUrl', 'apiKey', 'typingSpeed', 'delayBetweenDMs', 'dailyLimit',
                'businessDesc', 'persona', 'tone', 'dmSendMode'
            ]);
            loadSettings();
            showToast('Settings reset', 'info');
        }
    });
}

// =============================================================================
// Modal
// =============================================================================

function openModal() {
    document.getElementById('modal-overlay').classList.remove('hidden');
}

function closeModal() {
    document.getElementById('modal-overlay').classList.add('hidden');
}

// Close modal on backdrop click
document.getElementById('modal-overlay').addEventListener('click', (e) => {
    if (e.target.id === 'modal-overlay') {
        closeModal();
    }
});

// =============================================================================
// Toast Notifications
// =============================================================================

function showToast(message, type = 'info') {
    const container = document.getElementById('toast-container');
    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    toast.textContent = message;
    container.appendChild(toast);

    setTimeout(() => {
        toast.remove();
    }, 4000);
}

// =============================================================================
// Utility Functions
// =============================================================================

function formatTimeAgo(dateString) {
    if (!dateString) return '';
    const date = new Date(dateString);
    const seconds = Math.floor((new Date() - date) / 1000);

    if (seconds < 60) return 'Just now';
    if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
    if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
    if (seconds < 604800) return `${Math.floor(seconds / 86400)}d ago`;
    return date.toLocaleDateString();
}

function formatDate(dateString) {
    if (!dateString) return '';
    return new Date(dateString).toLocaleDateString('en-US', {
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit'
    });
}

function truncate(str, length) {
    if (!str) return '';
    return str.length > length ? str.substring(0, length) + '...' : str;
}

// =============================================================================
// Initialize
// =============================================================================

document.addEventListener('DOMContentLoaded', async () => {
    await loadConfig();
    initTabNavigation();
    checkConnection();
    loadTabData('overview');

    // Refresh button
    document.getElementById('refresh-overview').addEventListener('click', () => {
        loadOverviewData();
        showToast('Refreshed', 'info');
    });

    // Add account button
    document.getElementById('add-account-btn').addEventListener('click', showAddAccountModal);
});

function showAddAccountModal() {
    const modal = document.getElementById('modal-content');
    modal.innerHTML = `
        <div class="modal-header">
            <h3>Add Reddit Account</h3>
            <button class="btn-icon" onclick="closeModal()">&times;</button>
        </div>
        <div class="modal-body">
            <div class="form-group">
                <label for="new-username">Reddit Username</label>
                <input type="text" id="new-username" placeholder="username">
            </div>
            <div class="form-group">
                <label for="new-display-name">Display Name (optional)</label>
                <input type="text" id="new-display-name" placeholder="My Account">
            </div>
            <div class="form-group">
                <label for="new-daily-limit">Daily Limit</label>
                <input type="number" id="new-daily-limit" value="20" min="1" max="100">
            </div>
            <p class="help-text">After adding, you'll need to export cookies from your browser and import them.</p>
        </div>
        <div class="modal-footer">
            <button class="btn-secondary" onclick="closeModal()">Cancel</button>
            <button class="btn-primary" onclick="addAccount()">Add Account</button>
        </div>
    `;
    openModal();
}

async function addAccount() {
    const username = document.getElementById('new-username').value.trim();
    const displayName = document.getElementById('new-display-name').value.trim();
    const dailyLimit = parseInt(document.getElementById('new-daily-limit').value);

    if (!username) {
        showToast('Username is required', 'error');
        return;
    }

    try {
        await apiRequest('/accounts', {
            method: 'POST',
            body: JSON.stringify({
                username,
                displayName: displayName || username,
                dailyLimit,
                warmupMode: true
            })
        });
        showToast('Account added', 'success');
        closeModal();
        loadAccountsData();
    } catch (error) {
        showToast('Failed to add account', 'error');
    }
}

// Make functions available globally for onclick handlers
window.closeModal = closeModal;
window.showAddAccountModal = showAddAccountModal;
window.addAccount = addAccount;
window.checkShadowban = checkShadowban;
window.editAccount = function(id) {
    showToast('Edit functionality coming soon', 'info');
};
