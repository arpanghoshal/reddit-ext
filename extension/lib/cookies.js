/**
 * Account Detection Module for Multi-Account Reddit Automation
 *
 * Detects which Reddit account is currently logged in and resolves
 * the corresponding account ID from the backend. Does NOT swap cookies
 * (Reddit locks accounts when cookies are swapped between sessions).
 */

import * as api from './api.js';

// Cache the current logged-in account
let currentUsername = null;
let currentAccountId = null;
let lastCheckedAt = 0;
const CACHE_TTL_MS = 30000; // Re-detect every 30s

/**
 * Get the currently detected account ID (cached)
 */
export function getCurrentAccountId() {
    return currentAccountId;
}

/**
 * Get the currently detected username (cached)
 */
export function getCurrentUsername() {
    return currentUsername;
}

/**
 * Detect the currently logged-in Reddit account.
 * Uses Reddit's API to determine the username, then resolves the account ID
 * from our backend.
 *
 * @param {boolean} force - Skip cache and re-detect
 * @returns {Promise<{username: string|null, accountId: string|null}>}
 */
export async function detectCurrentAccount(force = false) {
    const now = Date.now();

    // Return cached result if fresh
    if (!force && currentUsername && (now - lastCheckedAt < CACHE_TTL_MS)) {
        return { username: currentUsername, accountId: currentAccountId };
    }

    try {
        const session = await verifySession();
        if (!session.success || !session.username) {
            currentUsername = null;
            currentAccountId = null;
            lastCheckedAt = now;
            return { username: null, accountId: null };
        }

        currentUsername = session.username;
        lastCheckedAt = now;

        // Resolve account ID from backend by username
        try {
            const accounts = await api.getAccounts();
            const match = accounts?.find(a =>
                a.username?.toLowerCase() === session.username.toLowerCase()
            );
            currentAccountId = match?.id || null;
        } catch {
            // Backend may be down — keep username, clear account ID
            currentAccountId = null;
        }

        console.log(`Detected Reddit account: u/${currentUsername} (id: ${currentAccountId || 'unknown'})`);
        return { username: currentUsername, accountId: currentAccountId };
    } catch (err) {
        console.warn('Failed to detect current account:', err);
        return { username: null, accountId: null };
    }
}

/**
 * Check if the currently logged-in account matches the expected one.
 * Returns a result indicating match/mismatch with details.
 *
 * @param {string} expectedAccountId - The account ID we want to send from
 * @returns {Promise<{match: boolean, currentUsername: string|null, expectedUsername: string|null}>}
 */
export async function checkAccountMatch(expectedAccountId) {
    if (!expectedAccountId) {
        // No specific account required — any account is fine
        return { match: true, currentUsername: currentUsername };
    }

    const current = await detectCurrentAccount();

    if (!current.accountId) {
        return {
            match: false,
            currentUsername: current.username,
            reason: current.username
                ? `Logged in as u/${current.username} but this account is not registered. Add it on the Accounts page.`
                : 'Not logged into Reddit.'
        };
    }

    if (current.accountId === expectedAccountId) {
        return { match: true, currentUsername: current.username };
    }

    // Mismatch — look up the expected account's username for a helpful message
    try {
        const accounts = await api.getAccounts();
        const expected = accounts?.find(a => a.id === expectedAccountId);
        return {
            match: false,
            currentUsername: current.username,
            expectedUsername: expected?.username,
            reason: `This DM should be sent from u/${expected?.username || '???'} but you're logged in as u/${current.username}. Please switch accounts on Reddit.`
        };
    } catch {
        return {
            match: false,
            currentUsername: current.username,
            reason: `Wrong account. Please log into the correct Reddit account.`
        };
    }
}

/**
 * Verify the current Reddit session by checking who is logged in.
 * @returns {Promise<{success: boolean, username?: string}>}
 */
export async function verifySession() {
    try {
        // Service workers have no cookie jar, so credentials: 'include' won't work.
        // Read session cookies via chrome.cookies API and pass as header.
        const cookies = await chrome.cookies.getAll({ domain: '.reddit.com' });
        const cookieHeader = cookies.map(c => `${c.name}=${c.value}`).join('; ');

        const response = await fetch('https://www.reddit.com/api/me.json', {
            headers: {
                'Accept': 'application/json',
                ...(cookieHeader ? { 'Cookie': cookieHeader } : {})
            }
        });

        if (!response.ok) {
            return { success: false, reason: `HTTP ${response.status}` };
        }

        const data = await response.json();
        const username = data?.data?.name || data?.name;

        if (username) {
            return { success: true, username };
        }

        return { success: false, reason: 'No username in response' };
    } catch (err) {
        console.warn('Session verification failed:', err);
        return { success: false, reason: err.message };
    }
}

/**
 * Capture current Reddit cookies from the browser.
 * Used when adding new accounts.
 * @returns {Promise<{cookies: Array, username?: string}>}
 */
export async function captureCurrentCookies() {
    const allCookies = await chrome.cookies.getAll({ domain: '.reddit.com' });
    const wwwCookies = await chrome.cookies.getAll({ domain: 'reddit.com' });

    // Merge, dedup by name+domain
    const seen = new Set();
    const merged = [];
    for (const cookie of [...allCookies, ...wwwCookies]) {
        const key = `${cookie.name}|${cookie.domain}`;
        if (!seen.has(key)) {
            seen.add(key);
            merged.push({
                name: cookie.name,
                value: cookie.value,
                domain: cookie.domain,
                path: cookie.path,
                secure: cookie.secure,
                httpOnly: cookie.httpOnly,
                sameSite: cookie.sameSite || 'lax',
                expirationDate: cookie.expirationDate
            });
        }
    }

    // Determine current logged-in username
    const session = await verifySession();

    return {
        cookies: merged,
        username: session.success ? session.username : null
    };
}

/**
 * Reset the cached account state.
 * Call this when you know the browser session has changed externally.
 */
export function resetState() {
    currentUsername = null;
    currentAccountId = null;
    lastCheckedAt = 0;
}
