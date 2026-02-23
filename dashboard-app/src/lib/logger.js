/**
 * Frontend Logger
 * Buffers log entries and flushes them to the backend /api/logs/batch endpoint.
 * Falls back to console output so dev debugging still works.
 */

import { supabase } from './supabase';

const API_BASE_URL = import.meta.env.VITE_API_URL || 'http://localhost:3000/api';

const FLUSH_INTERVAL_MS = 10_000; // 10 seconds
const MAX_BUFFER_SIZE = 20;

let _buffer = [];
let _flushTimer = null;

function startFlushTimer() {
  if (_flushTimer) return;
  _flushTimer = setInterval(flush, FLUSH_INTERVAL_MS);
}

function stopFlushTimer() {
  if (_flushTimer) {
    clearInterval(_flushTimer);
    _flushTimer = null;
  }
}

async function flush() {
  if (_buffer.length === 0) return;

  const batch = _buffer.splice(0, MAX_BUFFER_SIZE);

  try {
    const { data: { session } } = await supabase.auth.getSession();
    const token = session?.access_token;
    if (!token) {
      // Not authenticated - just drop the logs
      return;
    }

    const teamId = localStorage.getItem('currentTeamId') || '';

    await fetch(`${API_BASE_URL}/logs/batch`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
        ...(teamId ? { 'X-Team-ID': teamId } : {}),
      },
      body: JSON.stringify({ entries: batch }),
    });
  } catch {
    // Logging should never crash the app - silently drop on failure
  }
}

function enqueue(level, message, opts = {}) {
  const entry = {
    level,
    source: 'frontend',
    message: typeof message === 'string' ? message : String(message),
    component: opts.component || undefined,
    request_id: opts.requestId || undefined,
    error_name: opts.errorName || undefined,
    error_stack: opts.errorStack || undefined,
    metadata: opts.metadata || undefined,
    url: window.location.href,
    browser_info: navigator.userAgent,
  };

  _buffer.push(entry);
  startFlushTimer();

  if (_buffer.length >= MAX_BUFFER_SIZE) {
    flush();
  }
}

// --- Public API ---

export function logError(message, opts = {}) {
  if (import.meta.env.DEV) {
    console.error(`[logger:error] ${message}`, opts);
  }
  enqueue('error', message, opts);
}

export function logWarn(message, opts = {}) {
  if (import.meta.env.DEV) {
    console.warn(`[logger:warn] ${message}`, opts);
  }
  enqueue('warn', message, opts);
}

export function logInfo(message, opts = {}) {
  if (import.meta.env.DEV) {
    console.log(`[logger:info] ${message}`, opts);
  }
  enqueue('info', message, opts);
}

export function logDebug(message, opts = {}) {
  if (import.meta.env.DEV) {
    console.log(`[logger:debug] ${message}`, opts);
  }
  enqueue('debug', message, opts);
}

// Flush on page unload
if (typeof window !== 'undefined') {
  window.addEventListener('beforeunload', flush);
}

export default { logError, logWarn, logInfo, logDebug, flush };
