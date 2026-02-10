// Popup Script for Reddit Automated DM Extension

const DEFAULT_DASHBOARD_URL = 'https://reddit-ext-dashboard.vercel.app';
const DEFAULT_BACKEND_URL = 'https://backend-production-423ef.up.railway.app';

// Load on popup open
document.addEventListener('DOMContentLoaded', async () => {
    await loadConfig();
    await checkAuthState();
    initEventListeners();

    // Auto-update popup if auth changes via dashboard sync
    chrome.storage.onChanged.addListener((changes, area) => {
        if (area === 'local' && changes.accessToken) {
            if (changes.accessToken.newValue) {
                checkAuthState();
            } else {
                showLoginSection();
            }
        }
    });
});

async function loadConfig() {
    // Backend URL is hardcoded via DEFAULT_BACKEND_URL
}

async function checkAuthState() {
    const data = await chrome.storage.local.get(['accessToken', 'expiresAt', 'userEmail', 'teams', 'teamId']);

    const isAuth = data.accessToken && data.expiresAt && (Date.now() / 1000 < data.expiresAt);

    if (isAuth) {
        showMainSection(data.userEmail);
        populateTeamSelector(data.teams || [], data.teamId);
        await loadStats();
        await checkConnection();
    } else {
        showLoginSection();
    }
}

function showLoginSection() {
    document.getElementById('login-section').style.display = 'block';
    document.getElementById('main-section').style.display = 'none';
}

function showMainSection(email) {
    document.getElementById('login-section').style.display = 'none';
    document.getElementById('main-section').style.display = 'flex';
    document.getElementById('main-section').style.flexDirection = 'column';
    document.getElementById('main-section').style.gap = '16px';

    const userEmail = document.getElementById('user-email');
    if (userEmail) userEmail.textContent = email || '';
}

function populateTeamSelector(teams, currentTeamId) {
    const selectorDiv = document.getElementById('team-selector');
    const dropdown = document.getElementById('team-dropdown');

    if (!teams || teams.length <= 1) {
        selectorDiv.style.display = 'none';
        return;
    }

    selectorDiv.style.display = 'flex';
    dropdown.innerHTML = '';

    for (const team of teams) {
        const option = document.createElement('option');
        option.value = team.id;
        option.textContent = team.is_personal ? `${team.name} (Personal)` : team.name;
        if (team.id === currentTeamId) option.selected = true;
        dropdown.appendChild(option);
    }
}

async function loadStats() {
    try {
        const response = await chrome.runtime.sendMessage({ action: 'GET_ANALYTICS' });

        if (response) {
            document.getElementById('stat-today').textContent = response.todayCount || 0;
            document.getElementById('stat-week').textContent = response.weekCount || 0;
        }

        const queueResponse = await chrome.runtime.sendMessage({ action: 'GET_QUEUE_STATS' });
        if (queueResponse) {
            document.getElementById('stat-pending').textContent = queueResponse.pending || 0;
        }

        const convResponse = await chrome.runtime.sendMessage({ action: 'GET_CONVERSATION_STATS' });
        if (convResponse) {
            document.getElementById('stat-replies').textContent = convResponse.withReplies || 0;
        }
    } catch (error) {
        console.error('Failed to load stats:', error);
        const localData = await chrome.storage.local.get(['rateLimitState']);
        if (localData.rateLimitState) {
            document.getElementById('stat-today').textContent = localData.rateLimitState.dailyCount || 0;
        }
    }
}

async function checkConnection() {
    const statusDot = document.getElementById('connection-status');
    const backendUrl = DEFAULT_BACKEND_URL;

    try {
        const response = await fetch(`${backendUrl}/api/status`);

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
    const existing = document.querySelector('.toast');
    if (existing) existing.remove();

    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    toast.textContent = message;
    document.body.appendChild(toast);

    setTimeout(() => toast.remove(), 3000);
}

function clearAuthMessages() {
    const errorEl = document.getElementById('auth-error');
    errorEl.style.display = 'none';
}

function showAuthError(message) {
    const errorEl = document.getElementById('auth-error');
    errorEl.textContent = message;
    errorEl.style.display = 'block';
}

function initEventListeners() {
    // Set OS-specific shortcut hint
    const isMac = navigator.platform.toUpperCase().indexOf('MAC') >= 0;
    document.getElementById('shortcut-hint').textContent = isMac ? '(Alt+R)' : '(Ctrl+Shift+R)';

    // Login via Dashboard
    document.getElementById('login-via-dashboard').addEventListener('click', () => {
        chrome.tabs.create({ url: DEFAULT_DASHBOARD_URL + '/login' });
        window.close();
    });

    // Login form
    document.getElementById('login-form').addEventListener('submit', async (e) => {
        e.preventDefault();
        const email = document.getElementById('login-email').value;
        const password = document.getElementById('login-password').value;
        const loginBtn = document.getElementById('login-btn');

        clearAuthMessages();
        loginBtn.disabled = true;
        loginBtn.textContent = 'Signing in...';

        try {
            const response = await chrome.runtime.sendMessage({
                action: 'LOGIN',
                email,
                password
            });

            if (response && response.error) {
                throw new Error(response.error);
            }

            showMainSection(email);
            if (response.teams) {
                populateTeamSelector(response.teams, response.currentTeam?.id);
            }
            showToast('Signed in', 'success');
            await loadStats();
            await checkConnection();
        } catch (err) {
            showAuthError(err.message || 'Login failed');
        } finally {
            loginBtn.disabled = false;
            loginBtn.textContent = 'Sign In';
        }
    });

    // Logout
    document.getElementById('logout-btn').addEventListener('click', async () => {
        await chrome.runtime.sendMessage({ action: 'LOGOUT' });
        showLoginSection();
        showToast('Signed out', 'info');
    });

    // Toggle Sidebar
    document.getElementById('toggle-sidebar').addEventListener('click', async () => {
        const data = await chrome.storage.local.get(['isSidebarOpen']);
        const newState = !data.isSidebarOpen;
        await chrome.storage.local.set({ isSidebarOpen: newState });

        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (tab && tab.url && tab.url.includes('reddit.com')) {
            chrome.tabs.sendMessage(tab.id, { action: 'TOGGLE_SIDEBAR', isOpen: newState });
        }
        window.close();
    });

    // Open Dashboard
    document.getElementById('open-dashboard').addEventListener('click', async () => {
        const data = await chrome.storage.local.get(['dashboardUrl']);
        const dashboardUrl = data.dashboardUrl || DEFAULT_DASHBOARD_URL;
        chrome.tabs.create({ url: dashboardUrl });
    });

    // Team Switcher
    document.getElementById('team-dropdown').addEventListener('change', async (e) => {
        const newTeamId = e.target.value;
        const dropdown = e.target;
        dropdown.disabled = true;

        try {
            const response = await chrome.runtime.sendMessage({
                action: 'SWITCH_TEAM',
                teamId: newTeamId
            });

            if (response && response.error) {
                throw new Error(response.error);
            }

            showToast('Team switched', 'success');
            await loadStats();
        } catch (err) {
            showToast('Failed to switch team', 'error');
            const data = await chrome.storage.local.get(['teamId']);
            if (data.teamId) dropdown.value = data.teamId;
        } finally {
            dropdown.disabled = false;
        }
    });
}
