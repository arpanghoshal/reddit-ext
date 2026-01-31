// Options page script for Reddit Automated DM

const DEFAULT_SETTINGS = {
    backendUrl: 'http://localhost:3000',
    apiKey: '',
    typingSpeed: 100,
    delayBetweenDMs: 20,
    dailyLimit: 50
};

// DOM Elements
const form = document.getElementById('options-form');
const backendUrlInput = document.getElementById('backend-url');
const apiKeyInput = document.getElementById('api-key');
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
        apiKeyInput.value = data.apiKey || DEFAULT_SETTINGS.apiKey;
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
    const apiKey = apiKeyInput.value.trim();

    if (!url) {
        showConnectionStatus('Please enter a backend URL', 'error');
        return;
    }

    showConnectionStatus('Testing connection...', 'pending');
    testConnectionBtn.disabled = true;

    try {
        // Use AbortController for timeout
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 10000);

        // First, check server status
        const statusResponse = await fetch(`${url}/api/status`, {
            method: 'GET',
            headers: { 'Content-Type': 'application/json' },
            signal: controller.signal
        });

        clearTimeout(timeoutId);

        if (!statusResponse.ok) {
            throw new Error('Server returned an error');
        }

        const statusData = await statusResponse.json();

        let statusText = 'Server connected!';
        const details = [];

        if (statusData.supabaseConfigured) {
            details.push('Database: ✓');
        } else {
            details.push('Database: ✗');
        }

        if (statusData.openrouterConfigured) {
            details.push('LLM: ✓');
        } else {
            details.push('LLM: ✗');
        }

        // If API key provided, validate it
        if (apiKey) {
            const validateController = new AbortController();
            const validateTimeoutId = setTimeout(() => validateController.abort(), 10000);

            try {
                const validateResponse = await fetch(`${url}/api/auth/validate`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ apiKey }),
                    signal: validateController.signal
                });

                clearTimeout(validateTimeoutId);

                if (validateResponse.ok) {
                    const validateData = await validateResponse.json();

                    if (validateData.valid) {
                        details.push(`API Key: ✓ (${validateData.user.name})`);
                        statusText = 'Connected & authenticated!';
                    } else {
                        details.push('API Key: ✗ Invalid');
                        showConnectionStatus(
                            'Server connected but API key is invalid. ' + details.join(' | '),
                            'warning'
                        );
                        return;
                    }
                }
            } catch (validateError) {
                console.warn('API key validation failed:', validateError);
                details.push('API Key: ? (validation failed)');
            }
        } else {
            details.push('API Key: Not set');
        }

        showConnectionStatus(statusText + ' (' + details.join(' | ') + ')', 'success');
    } catch (error) {
        console.error('Connection test failed:', error);

        let errorMessage = 'Connection failed. Make sure the backend server is running.';

        if (error.name === 'AbortError') {
            errorMessage = 'Connection timed out. Check the server URL and try again.';
        }

        showConnectionStatus(errorMessage, 'error');
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
        apiKey: apiKeyInput.value.trim(),
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

    // Validate URL format
    try {
        new URL(settings.backendUrl);
    } catch {
        showStatus('Invalid backend URL format', 'error');
        backendUrlInput.focus();
        return;
    }

    // Validate numeric settings
    if (isNaN(settings.typingSpeed) || settings.typingSpeed < 50 || settings.typingSpeed > 200) {
        settings.typingSpeed = DEFAULT_SETTINGS.typingSpeed;
    }
    if (isNaN(settings.delayBetweenDMs) || settings.delayBetweenDMs < 15 || settings.delayBetweenDMs > 60) {
        settings.delayBetweenDMs = DEFAULT_SETTINGS.delayBetweenDMs;
    }
    if (isNaN(settings.dailyLimit) || settings.dailyLimit < 10 || settings.dailyLimit > 100) {
        settings.dailyLimit = DEFAULT_SETTINGS.dailyLimit;
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
