/**
 * Extension Logger
 * Buffers log entries and flushes them to the backend /api/logs/batch endpoint.
 * Uses chrome.alarms for periodic flushing (works in MV3 service workers).
 * Falls back to console output so dev debugging still works.
 */

const FLUSH_ALARM_NAME = 'ext-log-flush';
const FLUSH_INTERVAL_MIN = 0.5; // 30 seconds (minimum alarm interval)
const MAX_BUFFER_SIZE = 30;
const STORAGE_KEY = 'ext_log_buffer';

let _memoryBuffer = [];
let _flushing = false;

// --- Internal helpers ---

async function getApiConfig() {
    const data = await chrome.storage.local.get([
        'accessToken', 'teamId'
    ]);
    return {
        baseUrl: 'https://backend-production-423ef.up.railway.app',
        accessToken: data.accessToken || null,
        teamId: data.teamId || null
    };
}

async function loadBuffer() {
    try {
        const data = await chrome.storage.local.get([STORAGE_KEY]);
        return data[STORAGE_KEY] || [];
    } catch {
        return [];
    }
}

async function saveBuffer(buffer) {
    try {
        await chrome.storage.local.set({ [STORAGE_KEY]: buffer });
    } catch {
        // Storage full or unavailable - drop entries
    }
}

async function flush() {
    if (_flushing) return;
    _flushing = true;

    try {
        // Merge memory buffer with any persisted entries
        const persisted = await loadBuffer();
        const all = [...persisted, ..._memoryBuffer];
        _memoryBuffer = [];

        if (all.length === 0) {
            _flushing = false;
            return;
        }

        const batch = all.splice(0, MAX_BUFFER_SIZE);
        // Save any overflow back to storage
        if (all.length > 0) {
            await saveBuffer(all);
        } else {
            await saveBuffer([]);
        }

        const config = await getApiConfig();
        if (!config.accessToken) {
            // Not authenticated - drop the logs
            _flushing = false;
            return;
        }

        const headers = {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${config.accessToken}`
        };
        if (config.teamId) {
            headers['X-Team-ID'] = config.teamId;
        }

        const response = await fetch(`${config.baseUrl}/api/logs/batch`, {
            method: 'POST',
            headers,
            body: JSON.stringify({ entries: batch })
        });

        if (!response.ok) {
            // Failed to send - re-queue the batch
            const existing = await loadBuffer();
            await saveBuffer([...batch, ...existing].slice(0, 100)); // cap at 100
        }
    } catch {
        // Logging should never crash the extension
    } finally {
        _flushing = false;
    }
}

function enqueue(level, message, opts = {}) {
    const entry = {
        level,
        source: 'extension',
        message: typeof message === 'string' ? message : String(message),
        component: opts.component || undefined,
        request_id: opts.requestId || undefined,
        error_name: opts.errorName || undefined,
        error_stack: opts.errorStack || undefined,
        metadata: opts.metadata || undefined,
        url: opts.url || undefined,
        browser_info: navigator.userAgent
    };

    _memoryBuffer.push(entry);

    if (_memoryBuffer.length >= MAX_BUFFER_SIZE) {
        flush();
    }
}

// --- Alarm-based flushing (service worker safe) ---

function setupAlarm() {
    try {
        chrome.alarms.create(FLUSH_ALARM_NAME, {
            delayInMinutes: FLUSH_INTERVAL_MIN,
            periodInMinutes: FLUSH_INTERVAL_MIN
        });
    } catch {
        // Alarms API not available in this context
    }
}

// Listen for alarm
try {
    chrome.alarms.onAlarm.addListener((alarm) => {
        if (alarm.name === FLUSH_ALARM_NAME) {
            flush();
        }
    });
} catch {
    // Not in a context where alarms are available
}

// Start the flush alarm
setupAlarm();

// --- Public API ---

export function extLogError(message, opts = {}) {
    console.error(`[ext:error] ${message}`, opts.metadata || '');
    enqueue('error', message, opts);
}

export function extLogWarn(message, opts = {}) {
    console.warn(`[ext:warn] ${message}`, opts.metadata || '');
    enqueue('warn', message, opts);
}

export function extLogInfo(message, opts = {}) {
    console.log(`[ext:info] ${message}`, opts.metadata || '');
    enqueue('info', message, opts);
}

export function extLogDebug(message, opts = {}) {
    console.log(`[ext:debug] ${message}`, opts.metadata || '');
    enqueue('debug', message, opts);
}

export { flush as extFlush };

export default { extLogError, extLogWarn, extLogInfo, extLogDebug, flush };
