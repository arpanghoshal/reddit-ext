// Popup Script for Reddit Automated DM Extension

const DEFAULT_DASHBOARD_URL = 'http://localhost:5173';
const DEFAULT_BACKEND_URL = 'http://localhost:3000';

// Load on popup open
document.addEventListener('DOMContentLoaded', async () => {
    await loadConfig();
    await checkAuthState();
    initEventListeners();
});

async function loadConfig() {
    const data = await chrome.storage.local.get(['backendUrl']);
    const backendUrl = data.backendUrl || DEFAULT_BACKEND_URL;

    const loginBackendInput = document.getElementById('login-backend-url');
    if (loginBackendInput) loginBackendInput.value = backendUrl;
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
    const data = await chrome.storage.local.get(['backendUrl', 'accessToken']);
    const backendUrl = data.backendUrl || DEFAULT_BACKEND_URL;

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

function initEventListeners() {
    // Login form
    document.getElementById('login-form').addEventListener('submit', async (e) => {
        e.preventDefault();
        const email = document.getElementById('login-email').value;
        const password = document.getElementById('login-password').value;
        const loginBtn = document.getElementById('login-btn');
        const errorEl = document.getElementById('login-error');

        // Save backend URL from login form before attempting login
        const loginBackendUrl = document.getElementById('login-backend-url').value || DEFAULT_BACKEND_URL;
        await chrome.storage.local.set({ backendUrl: loginBackendUrl });

        errorEl.style.display = 'none';
        loginBtn.disabled = true;
        loginBtn.textContent = 'Signing in...';

        try {
            // Call backend login via background script
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
            errorEl.textContent = err.message || 'Login failed';
            errorEl.style.display = 'block';
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
