// Options page script for Reddit Insight Gatherer

const DEFAULT_SETTINGS = {
    backendUrl: 'http://localhost:3000',
    typingSpeed: 100,
    delayBetweenDMs: 20,
    dailyLimit: 50
};

// DOM Elements
const form = document.getElementById('options-form');
const backendUrlInput = document.getElementById('backend-url');
const testConnectionBtn = document.getElementById('test-connection');
const connectionStatus = document.getElementById('connection-status');
const typingSpeedInput = document.getElementById('typing-speed');
const speedValueSpan = document.getElementById('speed-value');
const delayInput = document.getElementById('delay-between-dms');
const delayValueSpan = document.getElementById('delay-value');
const dailyLimitInput = document.getElementById('daily-limit');
const resetBtn = document.getElementById('reset-btn');
const statusMessage = document.getElementById('status-message');

// Load saved settings on page load
document.addEventListener('DOMContentLoaded', loadSettings);

// Event listeners
form.addEventListener('submit', saveSettings);
resetBtn.addEventListener('click', resetToDefaults);
testConnectionBtn.addEventListener('click', testConnection);

// Update displayed values for range inputs
typingSpeedInput.addEventListener('input', () => {
    speedValueSpan.textContent = typingSpeedInput.value;
});

delayInput.addEventListener('input', () => {
    delayValueSpan.textContent = delayInput.value;
});

async function loadSettings() {
    try {
        const data = await chrome.storage.local.get(Object.keys(DEFAULT_SETTINGS));

        backendUrlInput.value = data.backendUrl || DEFAULT_SETTINGS.backendUrl;
        typingSpeedInput.value = data.typingSpeed || DEFAULT_SETTINGS.typingSpeed;
        speedValueSpan.textContent = typingSpeedInput.value;
        delayInput.value = data.delayBetweenDMs || DEFAULT_SETTINGS.delayBetweenDMs;
        delayValueSpan.textContent = delayInput.value;
        dailyLimitInput.value = data.dailyLimit || DEFAULT_SETTINGS.dailyLimit;
    } catch (error) {
        console.error('Failed to load settings:', error);
        showStatus('Failed to load settings', 'error');
    }
}

async function testConnection() {
    const url = backendUrlInput.value.trim().replace(/\/$/, '');

    if (!url) {
        showConnectionStatus('Please enter a backend URL', 'error');
        return;
    }

    showConnectionStatus('Testing connection...', 'pending');
    testConnectionBtn.disabled = true;

    try {
        const response = await fetch(`${url}/api/status`, {
            method: 'GET',
            headers: { 'Content-Type': 'application/json' }
        });

        if (!response.ok) {
            throw new Error('Server returned an error');
        }

        const data = await response.json();

        let statusText = 'Connected successfully!';
        const details = [];

        if (data.supabaseConfigured) {
            details.push('Database: Connected');
        } else {
            details.push('Database: Not configured');
        }

        if (data.openrouterConfigured) {
            details.push('LLM: Connected');
        } else {
            details.push('LLM: Not configured');
        }

        if (details.length > 0) {
            statusText += ' (' + details.join(', ') + ')';
        }

        showConnectionStatus(statusText, 'success');
    } catch (error) {
        console.error('Connection test failed:', error);
        showConnectionStatus('Connection failed. Make sure the backend server is running.', 'error');
    } finally {
        testConnectionBtn.disabled = false;
    }
}

function showConnectionStatus(message, type) {
    connectionStatus.textContent = message;
    connectionStatus.className = `connection-status ${type}`;
    connectionStatus.classList.remove('hidden');
}

async function saveSettings(e) {
    e.preventDefault();

    const settings = {
        backendUrl: backendUrlInput.value.trim().replace(/\/$/, ''),
        typingSpeed: parseInt(typingSpeedInput.value, 10),
        delayBetweenDMs: parseInt(delayInput.value, 10),
        dailyLimit: parseInt(dailyLimitInput.value, 10)
    };

    // Validate backend URL
    if (!settings.backendUrl) {
        showStatus('Backend URL is required', 'error');
        backendUrlInput.focus();
        return;
    }

    try {
        await chrome.storage.local.set(settings);
        showStatus('Settings saved successfully!', 'success');

        // Notify background script that settings have changed
        chrome.runtime.sendMessage({ action: 'SETTINGS_UPDATED', settings });
    } catch (error) {
        console.error('Failed to save settings:', error);
        showStatus('Failed to save settings', 'error');
    }
}

async function resetToDefaults() {
    if (!confirm('Are you sure you want to reset all settings to defaults?')) {
        return;
    }

    try {
        await chrome.storage.local.set(DEFAULT_SETTINGS);
        await loadSettings();
        connectionStatus.classList.add('hidden');
        showStatus('Settings reset to defaults', 'success');
    } catch (error) {
        console.error('Failed to reset settings:', error);
        showStatus('Failed to reset settings', 'error');
    }
}

function showStatus(message, type) {
    statusMessage.textContent = message;
    statusMessage.className = `status-message ${type}`;
    statusMessage.classList.remove('hidden');

    // Auto-hide after 3 seconds
    setTimeout(() => {
        statusMessage.classList.add('hidden');
    }, 3000);
}
