// --- Import API Client (ES Module) ---
import * as api from '../lib/api.js';
import * as cookies from '../lib/cookies.js';
import { extLogInfo, extLogError, extLogWarn, extLogDebug } from '../lib/logger.js';

extLogInfo('Background service worker loaded', { component: 'background' });
extLogDebug('API module loaded', { component: 'background', metadata: { keys: Object.keys(api) } });

// --- Global Error Handlers ---
self.addEventListener('error', (event) => {
    extLogError(`Unhandled error: ${event.message}`, {
        component: 'background',
        errorName: 'UncaughtError',
        errorStack: `${event.filename}:${event.lineno}:${event.colno}`,
        url: event.filename
    });
});

self.addEventListener('unhandledrejection', (event) => {
    const reason = event.reason;
    extLogError(`Unhandled promise rejection: ${reason?.message || reason}`, {
        component: 'background',
        errorName: reason?.name || 'UnhandledRejection',
        errorStack: reason?.stack
    });
});

// --- Automation State Management ---
const AutomationState = {
    IDLE: 'IDLE',
    NAVIGATING_PROFILE: 'NAVIGATING_PROFILE',
    WAITING_FOR_PROFILE: 'WAITING_FOR_PROFILE',
    CLICKING_CHAT: 'CLICKING_CHAT',
    NAVIGATING_CHAT: 'NAVIGATING_CHAT',
    WAITING_FOR_CHAT: 'WAITING_FOR_CHAT',
    FINDING_CHAT_USER: 'FINDING_CHAT_USER',
    TYPING_MESSAGE: 'TYPING_MESSAGE',
    COMPLETED: 'COMPLETED',
    // Subreddit Automation States
    PROCESSING_QUEUE: 'PROCESSING_QUEUE',
    NAVIGATING_TO_POST: 'NAVIGATING_TO_POST',
    WAITING_FOR_POST: 'WAITING_FOR_POST',
    GENERATING_DM: 'GENERATING_DM',
    AWAITING_CONFIRMATION: 'AWAITING_CONFIRMATION'
};

// Store active automation tasks with retry support
// { [tabId]: { status, data: { targetUser, message }, retries, maxRetries, lastRetryDelay } }
let activeTasks = {};

// Subreddit Queue: { [tabId]: { urls: [], currentIndex: 0, isActive: false, subreddit: '', sessionId: '', successCount: 0, failedCount: 0 } }
let subredditQueues = {};

// Track which tab is waiting for chat to prevent race conditions
let chatWaitingTabId = null;
// Persists the origin tab even after chatWaitingTabId is cleared by timeout,
// so onUpdated can still transfer a task if the chat tab loads late
let chatOriginTabId = null;

// Track pending setTimeout IDs per tabId for cancellation on stop
let pendingTimeouts = {};

// Prevent overlapping processNextStep calls per tab
let commandInFlight = {};

// Track whether a bulk sync is active (signaled from content script)
let bulkSyncActive = false;

// --- Keep-Alive Alarm (prevents MV3 service worker suspension during active work) ---
const KEEPALIVE_ALARM_NAME = 'automation-keepalive';
const KEEPALIVE_INTERVAL_MINUTES = 0.4; // ~24 seconds (well under Chrome's ~30s inactivity threshold)

function updateKeepAlive() {
    const hasActiveTasks = Object.keys(activeTasks).length > 0;
    const hasActiveQueues = Object.values(subredditQueues).some(q => q?.isActive);
    const needsKeepAlive = hasActiveTasks || hasActiveQueues || bulkSyncActive;

    chrome.alarms.get(KEEPALIVE_ALARM_NAME).then(existing => {
        if (needsKeepAlive && !existing) {
            extLogDebug('Starting keep-alive alarm for active automation', { component: 'background' });
            chrome.alarms.create(KEEPALIVE_ALARM_NAME, {
                delayInMinutes: KEEPALIVE_INTERVAL_MINUTES,
                periodInMinutes: KEEPALIVE_INTERVAL_MINUTES
            });
        } else if (!needsKeepAlive && existing) {
            extLogDebug('Clearing keep-alive alarm — no active automation', { component: 'background' });
            chrome.alarms.clear(KEEPALIVE_ALARM_NAME);
        }
    });
}

// --- Automation State Persistence (survives service worker restarts) ---
const PERSISTED_STATE_KEY = 'automationState';

async function persistAutomationState() {
    try {
        const persistableTasks = {};
        for (const [tabId, task] of Object.entries(activeTasks)) {
            persistableTasks[tabId] = {
                status: task.status,
                data: task.data,
                retries: task.retries || 0
            };
        }

        const persistableQueues = {};
        for (const [tabId, queue] of Object.entries(subredditQueues)) {
            if (queue.isActive) {
                persistableQueues[tabId] = {
                    urls: queue.urls,
                    currentIndex: queue.currentIndex,
                    isActive: queue.isActive,
                    subreddit: queue.subreddit,
                    sessionId: queue.sessionId,
                    successCount: queue.successCount,
                    failedCount: queue.failedCount
                };
            }
        }

        await chrome.storage.local.set({
            [PERSISTED_STATE_KEY]: {
                activeTasks: persistableTasks,
                subredditQueues: persistableQueues,
                chatWaitingTabId,
                chatOriginTabId,
                timestamp: Date.now()
            }
        });
    } catch (err) {
        extLogError(`Failed to persist automation state: ${err?.message}`, {
            component: 'background', errorName: err?.name, errorStack: err?.stack
        });
    }
}

async function clearPersistedState() {
    await chrome.storage.local.remove(PERSISTED_STATE_KEY).catch(() => {});
}

// Combined helper — call at every state transition
function onStateChanged() {
    updateKeepAlive();
    persistAutomationState();
}

function setTrackedTimeout(tabId, fn, delay) {
    const timeoutId = setTimeout(() => {
        if (pendingTimeouts[tabId]) pendingTimeouts[tabId].delete(timeoutId);
        if (!activeTasks[tabId] && !subredditQueues[tabId]) return; // task was cleaned up
        fn();
    }, delay);
    if (!pendingTimeouts[tabId]) pendingTimeouts[tabId] = new Set();
    pendingTimeouts[tabId].add(timeoutId);
    return timeoutId;
}

function clearAllTimeouts(tabId) {
    if (pendingTimeouts[tabId]) {
        for (const id of pendingTimeouts[tabId]) clearTimeout(id);
        delete pendingTimeouts[tabId];
    }
}

// Notify any open dashboard tabs to refresh queue data immediately
function notifyDashboardQueueUpdate() {
    chrome.tabs.query({
        url: ['https://app.qualydm.com/*', 'http://localhost:5173/*', 'http://localhost:3000/*']
    }, (tabs) => {
        for (const tab of tabs) {
            chrome.tabs.sendMessage(tab.id, { action: 'QUEUE_UPDATED' }).catch(() => {});
        }
    });
}

// Poll content script until it responds to PING, confirming it's alive and ready.
// After several failed attempts, programmatically inject the content script as a
// fallback (the declarative injection from manifest may be delayed on heavy pages).
async function ensureContentScriptReady(tabId, timeoutMs = 15000, intervalMs = 500) {
    const start = Date.now();
    let injected = false;
    while (Date.now() - start < timeoutMs) {
        try {
            const r = await chrome.tabs.sendMessage(tabId, { action: 'PING' });
            if (r?.pong) return true;
        } catch (e) {
            // Content script not ready yet — after 5s, try programmatic injection once
            if (!injected && Date.now() - start > 5000) {
                injected = true;
                try {
                    extLogDebug(`Programmatically injecting content script into tab ${tabId}`, { component: 'background' });
                    await chrome.scripting.executeScript({
                        target: { tabId },
                        files: ['content/content.js']
                    });
                } catch (injErr) {
                    extLogDebug(`Programmatic injection failed: ${injErr?.message}`, { component: 'background' });
                }
            }
        }
        await new Promise(r => setTimeout(r, intervalMs));
    }
    return false;
}

// Send a command to the content script after verifying it's ready.
// Handles failure by reporting to handleStepCompletion for retry.
async function sendCommandWithReadinessCheck(tabId, message, expectedState, stepName) {
    try {
        const ready = await ensureContentScriptReady(tabId);
        if (!ready) {
            extLogError(`Content script not ready for ${stepName}`, { component: 'background' });
            delete commandInFlight[tabId];
            handleStepCompletion(tabId, { success: false, error: 'Content script not ready', step: stepName });
            return;
        }
        // Verify state hasn't changed during the wait
        if (!activeTasks[tabId] || activeTasks[tabId].status !== expectedState) {
            extLogDebug(`State changed during readiness wait for ${stepName}, aborting`, { component: 'background' });
            delete commandInFlight[tabId];
            return;
        }
        await chrome.tabs.sendMessage(tabId, message);
        delete commandInFlight[tabId];
    } catch (err) {
        extLogError(`Failed to send ${stepName}: ${err?.message}`, { component: 'background', errorName: err?.name, errorStack: err?.stack });
        delete commandInFlight[tabId];
        handleStepCompletion(tabId, { success: false, error: 'Message send failed', step: stepName });
    }
}

// Cleanup function to remove tasks for closed tabs
function cleanupTask(tabId) {
    clearAllTimeouts(tabId);
    delete commandInFlight[tabId];
    if (activeTasks[tabId]) {
        extLogDebug(`Cleaning up task for closed tab ${tabId}`, { component: 'background' });
        // Release queue processing locks if this was a queued task
        if (activeTasks[tabId].data?.isReply) replyQueueProcessing = false;
        if (activeTasks[tabId].data?.isOutreach) outreachQueueProcessing = false;
        // Clear persistent in-progress marker
        if (activeTasks[tabId].data?.queueItemId) {
            clearQueueItemInProgress(activeTasks[tabId].data.queueItemId).catch(() => {});
        }
        delete activeTasks[tabId];
    }
    if (subredditQueues[tabId]) {
        const queue = subredditQueues[tabId];
        if (queue.sessionId && queue.isActive) {
            api.updateAutomationSession(queue.sessionId, {
                processedCount: queue.currentIndex,
                successCount: queue.successCount || 0,
                failedCount: queue.failedCount || 0,
                status: 'stopped'
            }).catch(() => {});
        }
        delete subredditQueues[tabId];
    }
    if (chatWaitingTabId === tabId) {
        chatWaitingTabId = null;
    }
    if (chatOriginTabId === tabId) {
        chatOriginTabId = null;
    }
    onStateChanged();
}

// Listen for tab removal to clean up memory
chrome.tabs.onRemoved.addListener((tabId) => {
    cleanupTask(tabId);
});

// Retry configuration
const RETRY_CONFIG = {
    maxRetries: 3,
    baseDelay: 3000,  // 3 seconds
    maxDelay: 30000   // 30 seconds max
};

// Calculate exponential backoff delay
function getRetryDelay(retryCount) {
    const delay = RETRY_CONFIG.baseDelay * Math.pow(2, retryCount);
    return Math.min(delay, RETRY_CONFIG.maxDelay);
}

// --- Event Listeners ---

// 1. Message Handler
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === 'GENERATE_QUESTION') {
        generateQuestion(request.data)
            .then(response => sendResponse({ success: true, data: response }))
            .catch(error => sendResponse({ success: false, error: error.message }));
        return true; // Keep channel open for async response
    }

    // Relay log entries from content scripts / popup through the background logger
    if (request.action === 'CLIENT_LOG') {
        const { level, message, opts } = request.data || {};
        const fn = level === 'error' ? extLogError
            : level === 'warn' ? extLogWarn
            : level === 'debug' ? extLogDebug
            : extLogInfo;
        fn(message, opts || {});
        return;
    }

    if (request.action === 'START_AUTOMATION') {
        const tabId = sender.tab ? sender.tab.id : request.tabId;
        if (!tabId) {
            extLogError('No tab ID found for automation', { component: 'background' });
            return;
        }
        startAutomation(tabId, request.data);
    }

    if (request.action === 'DIRECT_SEND_REPLY') {
        // Triggered by content script when dashboard opens a Reddit chat tab
        // with #__rdm_send= hash. The tab is already on the chat page.
        const tabId = sender.tab?.id;
        if (!tabId) {
            extLogError('No tab ID for DIRECT_SEND_REPLY', { component: 'background' });
            return;
        }
        const { targetUser, message, queueItemId, conversationId, accountId } = request.data;
        extLogInfo(`Direct send reply for u/${targetUser} on tab ${tabId}${accountId ? ` via account ${accountId}` : ''}`, { component: 'background' });

        // Detect current account and warn if mismatched
        const doSend = async () => {
            // Detect who is currently logged in and tag the DM with that account
            const detected = await cookies.detectCurrentAccount(true);
            const effectiveAccountId = accountId || detected.accountId;

            if (accountId && detected.accountId && accountId !== detected.accountId) {
                // Wrong account logged in — warn but still send (user might know what they're doing)
                const check = await cookies.checkAccountMatch(accountId);
                extLogWarn(`Account mismatch: ${check.reason}`, { component: 'background' });
                chrome.tabs.sendMessage(tabId, {
                    action: 'SHOW_TOAST',
                    message: check.reason || 'Wrong Reddit account logged in for this DM.',
                    type: 'warning'
                }).catch(() => {});
            }

            activeTasks[tabId] = {
                status: AutomationState.TYPING_MESSAGE,
                data: {
                    targetUser,
                    message,
                    queueItemId: queueItemId || null,
                    conversationId: conversationId || null,
                    accountId: effectiveAccountId || null,
                    isReply: true
                },
                retries: 0
            };

            // Send combined find-and-send command. The content script handles
            // the entire flow: find user → open conversation → type → send.
            // We set status to TYPING_MESSAGE so handleStepCompletion's
            // TYPE_MESSAGE success handler fires on completion.
            sendCommandWithReadinessCheck(tabId, {
                action: 'EXECUTE_ACTION',
                command: 'DIRECT_CHAT_SEND',
                targetUser: targetUser,
                text: message
            }, AutomationState.TYPING_MESSAGE, 'DIRECT_CHAT_SEND');
        };

        doSend();
    }

    if (request.action === 'START_SUBREDDIT_AUTOMATION') {
        const tabId = sender.tab ? sender.tab.id : request.tabId;

        // Validate queue data
        if (!request.data || !Array.isArray(request.data.posts) || request.data.posts.length === 0) {
            extLogError('Invalid subreddit automation data: posts array is missing or empty', { component: 'background' });
            chrome.tabs.sendMessage(tabId, {
                action: 'SHOW_TOAST',
                message: 'No posts found to automate',
                type: 'error'
            }).catch(() => {});
            sendResponse({ success: false, error: 'No posts found' });
            return;
        }

        // Filter out invalid URLs
        const validPosts = request.data.posts.filter(url =>
            typeof url === 'string' &&
            url.startsWith('https://') &&
            url.includes('reddit.com')
        );

        if (validPosts.length === 0) {
            extLogError('No valid post URLs found', { component: 'background' });
            chrome.tabs.sendMessage(tabId, {
                action: 'SHOW_TOAST',
                message: 'No valid post URLs found',
                type: 'error'
            }).catch(() => {});
            sendResponse({ success: false, error: 'No valid posts' });
            return;
        }

        extLogInfo(`Starting subreddit automation for tab ${tabId} with ${validPosts.length} posts`, { component: 'background' });

        // Start Supabase automation session
        (async () => {
            const session = await api.startAutomationSession({
                subreddit: request.data.subreddit,
                totalPosts: validPosts.length
            });

            subredditQueues[tabId] = {
                urls: validPosts,
                currentIndex: 0,
                isActive: true,
                subreddit: request.data.subreddit || 'unknown',
                sessionId: session ? session.sessionId : null,
                successCount: 0,
                failedCount: 0
            };

            processNextQueueItem(tabId);
        })();
    }

    if (request.action === 'AUTOMATION_STEP_COMPLETE') {
        const tabId = sender.tab?.id ?? request.tabId;
        handleStepCompletion(tabId, request.result).catch(err => {
            extLogError(`handleStepCompletion error: ${err?.message}`, { component: 'background', errorName: err?.name, errorStack: err?.stack });
        });
    }

    if (request.action === 'GET_AUTOMATION_STATUS') {
        const tabId = sender.tab ? sender.tab.id : request.tabId;
        const task = activeTasks[tabId];
        const queue = subredditQueues[tabId];

        sendResponse({
            isActive: !!task || (queue && queue.isActive),
            status: task ? task.status : 'IDLE',
            queueProgress: queue ? `${queue.currentIndex + 1}/${queue.urls.length}` : '',
            subreddit: queue ? queue.subreddit : '',
            awaitingConfirmation: task ? task.status === AutomationState.AWAITING_CONFIRMATION : false,
            pendingDM: task && task.status === AutomationState.AWAITING_CONFIRMATION ? task.data : null
        });
    }

    if (request.action === 'STOP_AUTOMATION') {
        const tabId = sender.tab ? sender.tab.id : request.tabId;
        extLogInfo(`Stopping automation for tab ${tabId}`, { component: 'background' });

        // Cancel all pending timeouts and in-flight commands for this tab
        clearAllTimeouts(tabId);
        delete commandInFlight[tabId];

        const stoppedTask = activeTasks[tabId];
        if (stoppedTask) {
            if (stoppedTask.data?.queueItemId) {
                clearQueueItemInProgress(stoppedTask.data.queueItemId).catch(() => {});
            }
            delete activeTasks[tabId];
        }
        if (subredditQueues[tabId]) {
            const queue = subredditQueues[tabId];

            // Mark Supabase session as stopped
            if (queue.sessionId) {
                api.updateAutomationSession(queue.sessionId, {
                    processedCount: queue.currentIndex,
                    successCount: queue.successCount || 0,
                    failedCount: queue.failedCount || 0,
                    status: 'stopped'
                }).catch(e => extLogError(`Failed to update session: ${e?.message}`, { component: 'background', errorName: e?.name, errorStack: e?.stack }));
            }

            queue.isActive = false;
            delete subredditQueues[tabId];
        }

        // Only reset the relevant queue processing flag (not both)
        if (stoppedTask?.data?.isReply) replyQueueProcessing = false;
        else if (stoppedTask?.data?.isOutreach) outreachQueueProcessing = false;
        else { replyQueueProcessing = false; outreachQueueProcessing = false; }

        // Clear chat waiting state
        if (chatWaitingTabId === tabId) chatWaitingTabId = null;
        if (chatOriginTabId === tabId) chatOriginTabId = null;

        onStateChanged();
        sendResponse({ success: true });
    }

    if (request.action === 'RETRY_AUTOMATION') {
        const tabId = sender.tab ? sender.tab.id : request.tabId;
        const context = request.context || {};

        extLogInfo(`Retrying automation for tab ${tabId}`, { component: 'background' });

        const task = activeTasks[tabId];
        if (task) {
            task.retries = (task.retries || 0) + 1;

            if (task.retries > RETRY_CONFIG.maxRetries) {
                extLogWarn('Max retries exceeded, notifying content script', { component: 'background' });
                chrome.tabs.sendMessage(tabId, {
                    action: 'AUTOMATION_ERROR',
                    error: { message: 'Max retries exceeded. Please try again later.' },
                    context: context
                });
                return;
            }

            const delay = getRetryDelay(task.retries - 1);
            extLogInfo(`Retry ${task.retries}/${RETRY_CONFIG.maxRetries} after ${delay}ms delay`, { component: 'background' });

            chrome.tabs.sendMessage(tabId, {
                action: 'SHOW_TOAST',
                message: `Retrying in ${Math.round(delay / 1000)}s... (${task.retries}/${RETRY_CONFIG.maxRetries})`,
                type: 'warning'
            });

            setTrackedTimeout(tabId, () => {
                // Reset status to the "waiting" state so processNextStep can re-enter
                if (task.status === AutomationState.CLICKING_CHAT) {
                    task.status = AutomationState.WAITING_FOR_PROFILE;
                } else if (task.status === AutomationState.TYPING_MESSAGE) {
                    task.status = AutomationState.WAITING_FOR_CHAT;
                }
                processNextStep(tabId);
            }, delay);
        }

        sendResponse({ success: true });
    }

    if (request.action === 'SKIP_AND_CONTINUE') {
        const tabId = sender.tab ? sender.tab.id : request.tabId;

        extLogInfo(`Skipping current item for tab ${tabId}`, { component: 'background' });

        const task = activeTasks[tabId];
        const queue = subredditQueues[tabId];

        // Log skipped post to backend
        if (task && task.data) {
            api.logSkippedPost({
                postUrl: task.data.postUrl || '',
                postTitle: task.data.postTitle || null,
                subreddit: task.data.subreddit || (queue ? queue.subreddit : null),
                author: task.data.targetUser || null,
                sessionId: queue ? queue.sessionId : null,
                skipReason: 'error_skipped',
                skipDetails: {
                    source: 'error_recovery',
                    error: request.context?.error || null
                }
            }).catch(err => extLogError(`Failed to log skipped post: ${err?.message}`, { component: 'background', errorName: err?.name, errorStack: err?.stack }));
        }

        if (queue && queue.isActive) {
            queue.failedCount++;
            queue.currentIndex++;

            // Update Supabase session
            if (queue.sessionId) {
                api.updateAutomationSession(queue.sessionId, {
                    processedCount: queue.currentIndex,
                    successCount: queue.successCount,
                    failedCount: queue.failedCount
                });
            }

            // Clear current task and move to next
            delete activeTasks[tabId];
            onStateChanged();
            processNextQueueItem(tabId);
        } else {
            // Single automation - just clear the task
            // Release queue processing locks
            if (task?.data?.isReply) replyQueueProcessing = false;
            if (task?.data?.isOutreach) outreachQueueProcessing = false;
            if (task?.data?.queueItemId) clearQueueItemInProgress(task.data.queueItemId).catch(() => {});
            delete activeTasks[tabId];
            onStateChanged();
        }

        sendResponse({ success: true });
    }

    // Handle DM confirmation (user approved the DM)
    if (request.action === 'CONFIRM_DM') {
        const tabId = sender.tab ? sender.tab.id : request.tabId;
        const task = activeTasks[tabId];

        if (task && task.status === AutomationState.AWAITING_CONFIRMATION) {
            extLogInfo('DM confirmed, proceeding to send...', { component: 'background' });

            // Update message if user edited it
            if (request.editedMessage) {
                task.data.message = request.editedMessage;
            }

            // Proceed with automation
            task.status = AutomationState.NAVIGATING_PROFILE;
            const profileUrl = `https://www.reddit.com/user/${task.data.targetUser}/`;
            chrome.tabs.update(tabId, { url: profileUrl });
            task.status = AutomationState.WAITING_FOR_PROFILE;

            sendResponse({ success: true });
        } else {
            sendResponse({ success: false, error: 'No pending confirmation' });
        }
        return true;
    }

    // Handle DM skip (user declined the DM)
    if (request.action === 'SKIP_DM') {
        const tabId = sender.tab ? sender.tab.id : request.tabId;
        const task = activeTasks[tabId];

        if (task && task.status === AutomationState.AWAITING_CONFIRMATION) {
            extLogInfo('DM skipped by user', { component: 'background' });

            const queue = subredditQueues[tabId];

            // Log skipped post to backend
            if (task.data) {
                api.logSkippedPost({
                    postUrl: task.data.postUrl || '',
                    postTitle: task.data.postTitle || null,
                    subreddit: task.data.subreddit || (queue ? queue.subreddit : null),
                    author: task.data.targetUser || null,
                    sessionId: queue ? queue.sessionId : null,
                    skipReason: 'user_skipped',
                    skipDetails: { source: 'dm_confirmation' }
                }).catch(err => extLogError(`Failed to log skipped post: ${err?.message}`, { component: 'background', errorName: err?.name, errorStack: err?.stack }));
            }

            if (queue && queue.isActive) {
                // Move to next item in queue
                queue.currentIndex++;

                // Update Supabase session
                if (queue.sessionId) {
                    api.updateAutomationSession(queue.sessionId, {
                        processedCount: queue.currentIndex,
                        successCount: queue.successCount,
                        failedCount: queue.failedCount
                    });
                }

                // Clear current task and move to next
                delete activeTasks[tabId];
                processNextQueueItem(tabId);
            } else {
                // Single automation - just clear the task
                delete activeTasks[tabId];
                chrome.tabs.sendMessage(tabId, {
                    action: 'AUTOMATION_STOPPED'
                }).catch(() => {});
            }

            sendResponse({ success: true });
        } else {
            sendResponse({ success: false, error: 'No pending confirmation' });
        }
        return true;
    }
});

// 2. Tab Update Handler (Navigation Monitor)
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    // Check if this is a chat.reddit.com tab that we're waiting for
    if (changeInfo.status === 'complete' && tab.url && tab.url.includes('chat.reddit.com')) {
        // Primary: transfer if chatWaitingTabId is still set
        if (chatWaitingTabId !== null && activeTasks[chatWaitingTabId]) {
            const task = activeTasks[chatWaitingTabId];
            if (task.status === AutomationState.WAITING_FOR_CHAT) {
                extLogInfo(`Chat tab detected! Tab ${tabId}, transferring task from ${chatWaitingTabId}`, { component: 'background' });

                task.data.onChatTab = true; // Mark as transferred to a separate chat tab
                activeTasks[tabId] = task;
                delete activeTasks[chatWaitingTabId];
                chatWaitingTabId = null;
                chatOriginTabId = null;

                processNextStep(tabId);
                return;
            }
        }

        // Fallback: chatWaitingTabId was cleared by timeout, but the origin tab still
        // has a task that failed TYPE_MESSAGE. Rescue by transferring to this chat tab.
        if (chatOriginTabId !== null && activeTasks[chatOriginTabId]) {
            const originTask = activeTasks[chatOriginTabId];
            // Task is still in a chat-related state (timeout sent TYPE_MESSAGE which failed,
            // or it's retrying). Transfer if the task hasn't moved past typing.
            if (originTask.status === AutomationState.WAITING_FOR_CHAT ||
                originTask.status === AutomationState.TYPING_MESSAGE) {
                extLogInfo(`Late chat tab ${tabId} detected! Transferring task from origin ${chatOriginTabId}`, { component: 'background' });

                originTask.status = AutomationState.WAITING_FOR_CHAT;
                originTask.retries = 0;
                originTask.data.onChatTab = true;
                activeTasks[tabId] = originTask;
                delete activeTasks[chatOriginTabId];
                chatOriginTabId = null;

                processNextStep(tabId);
                return;
            }
        }
    }

    // Regular tab update handling
    if (changeInfo.status === 'complete' && activeTasks[tabId]) {
        extLogDebug(`Tab ${tabId} updated. Current state: ${activeTasks[tabId].status}`, { component: 'background' });

        // If we were waiting for a post to load, process it
        if (activeTasks[tabId].status === AutomationState.WAITING_FOR_POST) {
            processNextStep(tabId);
        }
        // If we were waiting for profile to load
        else if (activeTasks[tabId].status === AutomationState.WAITING_FOR_PROFILE) {
            processNextStep(tabId);
        }
        // If we were waiting for chat (transferred via onCreated but not yet loaded)
        else if (activeTasks[tabId].status === AutomationState.WAITING_FOR_CHAT) {
            processNextStep(tabId);
        }
    }
});

// 3. New Tab Created Handler (for chat.reddit.com opening in new tab)
chrome.tabs.onCreated.addListener((tab) => {
    extLogDebug(`New tab created: ${tab.id} ${tab.pendingUrl || tab.url}`, { component: 'background' });

    // Only handle if we have a specific tab waiting for chat (prevents race condition)
    if (chatWaitingTabId !== null && activeTasks[chatWaitingTabId]) {
        const task = activeTasks[chatWaitingTabId];
        if (task.status === AutomationState.WAITING_FOR_CHAT) {
            const pendingUrl = tab.pendingUrl || tab.url || '';
            if (pendingUrl.includes('chat.reddit.com')) {
                extLogInfo(`Chat tab opened! Transferring task from tab ${chatWaitingTabId} to ${tab.id}`, { component: 'background' });

                // Transfer task to new tab
                task.data.onChatTab = true;
                activeTasks[tab.id] = task;
                delete activeTasks[chatWaitingTabId];

                chatWaitingTabId = null;
                chatOriginTabId = null;

                // onUpdated will trigger processNextStep when the new tab finishes loading
            } else if (!pendingUrl) {
                // URL not yet available (Chrome hasn't resolved it).
                // Store this tab ID so onUpdated can check it when the URL resolves.
                extLogDebug(`New tab ${tab.id} has no URL yet, will check in onUpdated`, { component: 'background' });
                // onUpdated handler already checks for chat.reddit.com tabs via
                // chatWaitingTabId and chatOriginTabId, so this will be caught there.
            }
        }
    }
});

// 4. Sidebar Toggle
chrome.action.onClicked.addListener(async (tab) => {
    const data = await chrome.storage.local.get('isSidebarOpen');
    const newState = !data.isSidebarOpen;
    await chrome.storage.local.set({ isSidebarOpen: newState });

    if (tab.url && tab.url.includes('reddit.com')) {
        chrome.tabs.sendMessage(tab.id, {
            action: 'TOGGLE_SIDEBAR',
            isOpen: newState
        }).catch(() => extLogDebug('Could not send message to tab ' + tab.id, { component: 'background' }));
    }
});

// --- Automation Logic ---

// Send automation progress to content script (auto-opens sidebar)
function notifyAutomationProgress(tabId) {
    const task = activeTasks[tabId];
    const queue = subredditQueues[tabId];

    chrome.tabs.sendMessage(tabId, {
        action: 'AUTOMATION_PROGRESS',
        status: {
            isActive: !!task || (queue && queue.isActive),
            status: task ? task.status : 'IDLE',
            queueProgress: queue ? `${queue.currentIndex + 1}/${queue.urls.length}` : '',
            subreddit: queue ? queue.subreddit : '',
            awaitingConfirmation: task ? task.status === AutomationState.AWAITING_CONFIRMATION : false,
            pendingDM: task && task.status === AutomationState.AWAITING_CONFIRMATION ? task.data : null,
            currentClassification: task?.data?.classification || null
        }
    }).catch(() => {}); // Ignore errors if content script not ready
}

async function startAutomation(tabId, data) {
    extLogInfo(`Starting automation for user: ${data.targetUser}`, { component: 'background' });

    // Detect current account so DM logging tags the correct account
    if (!data.accountId) {
        const detected = await cookies.detectCurrentAccount();
        data.accountId = detected.accountId || null;
    }

    activeTasks[tabId] = {
        status: AutomationState.NAVIGATING_PROFILE,
        data: data,
        retries: 0
    };
    onStateChanged();

    // Notify content script to show sidebar with progress
    notifyAutomationProgress(tabId);

    // Step 1: Navigate to User Profile
    const profileUrl = `https://www.reddit.com/user/${data.targetUser}/`;
    await chrome.tabs.update(tabId, { url: profileUrl });

    // State will update to WAITING_FOR_PROFILE, but we handle it in onUpdated
    activeTasks[tabId].status = AutomationState.WAITING_FOR_PROFILE;
}

async function processNextStep(tabId) {
    const task = activeTasks[tabId];
    if (!task) return;

    // Guard: prevent overlapping processNextStep calls for the same tab
    if (commandInFlight[tabId]) {
        extLogDebug(`processNextStep: command already in-flight for tab ${tabId}, skipping`, { component: 'background' });
        return;
    }

    try {
        switch (task.status) {
            case AutomationState.WAITING_FOR_POST:
                extLogInfo('Post loaded. Extracting data and generating DM...', { component: 'background' });
                task.status = AutomationState.GENERATING_DM;

                // Safety timeout: if classification + DM generation takes too long, fail the step
                let dmGenSafetyTimeout = setTrackedTimeout(tabId, () => {
                    if (activeTasks[tabId]?.status === AutomationState.GENERATING_DM) {
                        extLogWarn('DM generation timed out after 30s', { component: 'background' });
                        handleStepCompletion(tabId, { success: false, error: 'DM generation timed out' }).catch(err => extLogError(`handleStepCompletion error: ${err?.message}`, { component: 'background', errorName: err?.name, errorStack: err?.stack }));
                    }
                }, 30000);

                // 1. Get Post Data
                chrome.tabs.sendMessage(tabId, { action: 'GET_POST_DATA' }, async (postData) => {
                    if (!postData || !postData.valid) {
                        extLogWarn('Invalid post data, skipping...', { component: 'background' });
                        handleStepCompletion(tabId, { success: false, error: 'Invalid post' }).catch(err => extLogError(`handleStepCompletion error: ${err?.message}`, { component: 'background', errorName: err?.name, errorStack: err?.stack }));
                        return;
                    }

                    // 1.5. Check if recipient was already contacted (skip for replies)
                    if (postData.author && !task.data?.isReply) {
                        try {
                            const contactCheck = await api.checkRecipientContacted(postData.author);
                            if (contactCheck && contactCheck.contacted) {
                                extLogInfo(`u/${postData.author} already contacted (source: ${contactCheck.source}), skipping`, { component: 'background' });
                                const skipQueue = subredditQueues[tabId];
                                api.logSkippedPost({
                                    postUrl: postData.url || '',
                                    postTitle: postData.title || null,
                                    subreddit: postData.subreddit || (skipQueue ? skipQueue.subreddit : null),
                                    author: postData.author,
                                    sessionId: skipQueue ? skipQueue.sessionId : null,
                                    skipReason: 'already_contacted',
                                    skipDetails: { source: contactCheck.source }
                                }).catch(err => extLogError(`Failed to log skipped post: ${err?.message}`, { component: 'background', errorName: err?.name, errorStack: err?.stack }));
                                handleStepCompletion(tabId, { success: false, error: 'Already contacted' }).catch(err => extLogError(`handleStepCompletion error: ${err?.message}`, { component: 'background', errorName: err?.name, errorStack: err?.stack }));
                                return;
                            }
                        } catch (err) {
                            extLogWarn(`Contact check failed, proceeding: ${err.message}`, { component: 'background', errorName: err?.name, errorStack: err?.stack });
                        }
                    }

                    // Abort if task was stopped during contact check
                    if (!activeTasks[tabId]) {
                        extLogDebug('Task cancelled during contact check, aborting', { component: 'background' });
                        return;
                    }

                    // 2. Classify post and Generate DM
                    try {
                        // Get settings from storage
                        const settings = await chrome.storage.local.get(['businessDesc', 'persona', 'insightTypes', 'tone']);

                        // Classify post first to determine usefulness
                        let classification = null;
                        try {
                            extLogDebug('Classifying post...', { component: 'background' });
                            classification = await api.classifyPost({
                                url: postData.url,
                                title: postData.title,
                                body: postData.body,
                                subreddit: postData.subreddit,
                                author: postData.author
                            }, settings);
                            extLogDebug(`Classification result: ${JSON.stringify(classification)}`, { component: 'background' });
                        } catch (classifyErr) {
                            extLogWarn(`Classification failed, continuing without: ${classifyErr?.message}`, { component: 'background', errorName: classifyErr?.name, errorStack: classifyErr?.stack });
                        }

                        // Reset safety timeout: classification done, give DM generation its own full 30s
                        clearTimeout(dmGenSafetyTimeout);
                        if (pendingTimeouts[tabId]) pendingTimeouts[tabId].delete(dmGenSafetyTimeout);
                        dmGenSafetyTimeout = setTrackedTimeout(tabId, () => {
                            if (activeTasks[tabId]?.status === AutomationState.GENERATING_DM) {
                                extLogWarn('DM generation timed out after 30s', { component: 'background' });
                                handleStepCompletion(tabId, { success: false, error: 'DM generation timed out' }).catch(err => extLogError(`handleStepCompletion error: ${err?.message}`, { component: 'background', errorName: err?.name, errorStack: err?.stack }));
                            }
                        }, 30000);

                        // Abort if task was stopped during classification
                        if (!activeTasks[tabId]) {
                            extLogDebug('Task cancelled during classification, aborting', { component: 'background' });
                            return;
                        }

                        // Generate DM
                        const message = await generateQuestion({ post: postData, settings });

                        // Abort if task was stopped during DM generation
                        if (!activeTasks[tabId]) {
                            extLogDebug('Task cancelled during DM generation, aborting', { component: 'background' });
                            return;
                        }

                        extLogInfo(`DM Generated: ${message}`, { component: 'background' });

                        // 3. Update task data with the new user, message, and classification
                        // Use Object.assign to preserve existing fields (isReply, isOutreach, queueItemId, accountId, etc.)
                        Object.assign(task.data, {
                            targetUser: postData.author,
                            message: message,
                            postUrl: postData.url,
                            postTitle: postData.title,
                            subreddit: postData.subreddit,
                            classification: classification
                        });

                        // Check DM send mode
                        const modeSettings = await chrome.storage.local.get(['dmSendMode']);
                        const dmSendMode = modeSettings.dmSendMode || 'confirm';

                        if (dmSendMode === 'confirm') {
                            // Show confirmation dialog in content script
                            task.status = AutomationState.AWAITING_CONFIRMATION;

                            // Safety timeout: auto-skip if user doesn't respond in 5 minutes
                            setTrackedTimeout(tabId, () => {
                                if (activeTasks[tabId]?.status === AutomationState.AWAITING_CONFIRMATION) {
                                    extLogWarn('Confirmation timed out after 5 minutes, auto-skipping', { component: 'background' });
                                    const q = subredditQueues[tabId];
                                    if (q && q.isActive) {
                                        q.currentIndex++;
                                        delete activeTasks[tabId];
                                        processNextQueueItem(tabId);
                                    } else {
                                        delete activeTasks[tabId];
                                    }
                                }
                            }, 300000);

                            chrome.tabs.sendMessage(tabId, {
                                action: 'SHOW_DM_CONFIRMATION',
                                data: {
                                    targetUser: postData.author,
                                    message: message,
                                    postTitle: postData.title,
                                    subreddit: postData.subreddit,
                                    classification: classification
                                }
                            }).catch(err => {
                                extLogError(`Failed to show confirmation dialog: ${err?.message}`, { component: 'background', errorName: err?.name, errorStack: err?.stack });
                            });
                        } else {
                            // Auto mode - proceed directly
                            task.status = AutomationState.NAVIGATING_PROFILE;
                            const profileUrl = `https://www.reddit.com/user/${postData.author}/`;
                            chrome.tabs.update(tabId, { url: profileUrl });
                            task.status = AutomationState.WAITING_FOR_PROFILE;
                        }

                    } catch (err) {
                        extLogError(`Generation failed: ${err?.message}`, { component: 'background', errorName: err?.name, errorStack: err?.stack });
                        handleStepCompletion(tabId, { success: false, error: 'Generation failed' }).catch(err => extLogError(`handleStepCompletion error: ${err?.message}`, { component: 'background', errorName: err?.name, errorStack: err?.stack }));
                    }
                });
                break;

            case AutomationState.WAITING_FOR_PROFILE:
                extLogInfo('Profile loaded. Attempting to find and click Chat button...', { component: 'background' });
                task.status = AutomationState.CLICKING_CHAT;

                // Wait for content script readiness, then send command
                commandInFlight[tabId] = true;
                sendCommandWithReadinessCheck(tabId, {
                    action: 'EXECUTE_ACTION',
                    command: 'CLICK_CHAT_BUTTON'
                }, AutomationState.CLICKING_CHAT, 'CLICK_CHAT_BUTTON');
                return; // Lock released inside sendCommandWithReadinessCheck

            case AutomationState.WAITING_FOR_CHAT:
                // Always find the target user's conversation first to avoid typing
                // into the wrong chat (popup may show most recent conversation)
                extLogInfo(`Chat ready. Finding ${task.data.targetUser}'s conversation before typing...`, { component: 'background' });
                task.status = AutomationState.TYPING_MESSAGE;
                commandInFlight[tabId] = true;

                sendCommandWithReadinessCheck(tabId, {
                    action: 'EXECUTE_ACTION',
                    command: 'DIRECT_CHAT_SEND',
                    targetUser: task.data.targetUser,
                    text: task.data.message
                }, AutomationState.TYPING_MESSAGE, 'DIRECT_CHAT_SEND');
                return;

        }
    } catch (error) {
        extLogError(`Automation Error: ${error?.message}`, { component: 'background', errorName: error?.name, errorStack: error?.stack });
    }
}

async function handleStepCompletion(tabId, result) {
    const task = activeTasks[tabId];
    if (!task) return;

    extLogDebug(`Step complete for tab ${tabId}: ${JSON.stringify(result)}`, { component: 'background' });

    if (result.success) {
        if (task.status === AutomationState.CLICKING_CHAT) {
            // Chat button clicked - could open as popup overlay or new tab
            extLogInfo('Chat button clicked. Setting up to wait for chat...', { component: 'background' });

            // Set this tab as waiting for chat (in case a new tab opens)
            chatWaitingTabId = tabId;
            chatOriginTabId = tabId;
            task.status = AutomationState.WAITING_FOR_CHAT;

            // Wait for either:
            // 1. Chat popup to render on same page
            // 2. New chat.reddit.com tab to open (handled by onCreated/onUpdated)
            // After 5.5 seconds, check for chat tabs before assuming popup
            setTrackedTimeout(tabId, async () => {
                // Only proceed if we're still waiting (didn't transfer to new tab)
                if (chatWaitingTabId === tabId && activeTasks[tabId] &&
                    activeTasks[tabId].status === AutomationState.WAITING_FOR_CHAT) {

                    // Before assuming popup, check if a chat.reddit.com tab was opened
                    // (onCreated may have missed it due to undefined pendingUrl)
                    try {
                        const chatTabs = await chrome.tabs.query({ url: '*://chat.reddit.com/*' });
                        const chatTab = chatTabs.find(t => t.id !== tabId);
                        if (chatTab) {
                            extLogInfo(`Found chat tab ${chatTab.id} during timeout, transferring task from ${tabId}`, { component: 'background' });
                            activeTasks[tabId].data.onChatTab = true;
                            activeTasks[chatTab.id] = activeTasks[tabId];
                            delete activeTasks[tabId];
                            chatWaitingTabId = null;
                            chatOriginTabId = null;

                            if (chatTab.status === 'complete') {
                                processNextStep(chatTab.id);
                            }
                            // else: onUpdated will fire when it finishes loading
                            return;
                        }
                    } catch (e) {
                        extLogError(`Error checking for chat tabs: ${e?.message}`, { component: 'background', errorName: e?.name, errorStack: e?.stack });
                    }

                    extLogInfo(`Chat popup detected (same tab). Finding ${task.data.targetUser}'s conversation...`, { component: 'background' });
                    chatWaitingTabId = null;
                    activeTasks[tabId].status = AutomationState.TYPING_MESSAGE;

                    sendCommandWithReadinessCheck(tabId, {
                        action: 'EXECUTE_ACTION',
                        command: 'DIRECT_CHAT_SEND',
                        targetUser: task.data.targetUser,
                        text: task.data.message
                    }, AutomationState.TYPING_MESSAGE, 'DIRECT_CHAT_SEND');
                }
            }, 5500);

        } else if (task.status === AutomationState.TYPING_MESSAGE) {
            extLogInfo('Single Automation Complete!', { component: 'background' });

            // Reset retry count on success
            task.retries = 0;

            // Record DM sent for rate limiting
            // Ensure account is detected (covers cold service worker / missing accountId)
            let currentAccountId = task.data.accountId || cookies.getCurrentAccountId() || null;
            if (!currentAccountId) {
                const detected = await cookies.detectCurrentAccount();
                currentAccountId = detected.accountId || null;
                if (currentAccountId) task.data.accountId = currentAccountId;
            }
            recordDMSent(currentAccountId);

            // Mark queue item as sent (replies and outreach)
            if (task.data.queueItemId) {
                extLogInfo(`Marking queue item as sent: ${task.data.queueItemId}`, { component: 'background' });

                let markedSent = false;
                for (let attempt = 0; attempt < 3 && !markedSent; attempt++) {
                    try {
                        await api.markQueueItemSent(task.data.queueItemId);
                        markedSent = true;
                    } catch (err) {
                        extLogError(`Failed to mark queue item as sent (attempt ${attempt + 1}/3): ${err?.message}`, { component: 'background', errorName: err?.name, errorStack: err?.stack });
                        if (attempt < 2) await new Promise(r => setTimeout(r, 2000));
                    }
                }
                if (!markedSent) {
                    // Last resort: store locally so we don't re-send
                    extLogError('Could not mark queue item as sent after 3 attempts, storing locally', { component: 'background' });
                    try {
                        const { sentQueueItems = [] } = await chrome.storage.local.get('sentQueueItems');
                        sentQueueItems.push(task.data.queueItemId);
                        await chrome.storage.local.set({ sentQueueItems: sentQueueItems.slice(-100) }); // keep last 100
                    } catch (e) { extLogError(`Failed to store sent item locally: ${e?.message}`, { component: 'background', errorName: e?.name, errorStack: e?.stack }); }
                }
                // Clear persistent in-progress marker and attempt counter
                clearQueueItemInProgress(task.data.queueItemId).catch(() => {});
                clearQueueItemAttempts(task.data.queueItemId).catch(() => {});
                // Notify dashboard immediately so queue UI updates without waiting for poll
                notifyDashboardQueueUpdate();
            }

            // Log DM to Supabase (tagged with the current logged-in account)
            // This also creates/updates the conversation and inserts the message
            const queue = subredditQueues[tabId];
            try {
                await api.logDM({
                    recipientUsername: task.data.targetUser,
                    postUrl: task.data.postUrl || null,
                    postTitle: task.data.postTitle || null,
                    subreddit: queue ? queue.subreddit : null,
                    messageContent: task.data.message,
                    status: 'sent',
                    automationType: task.data.isReply ? 'reply' : (queue ? 'batch' : 'single'),
                    sessionId: queue ? queue.sessionId : null,
                    accountId: task.data.accountId || cookies.getCurrentAccountId() || null
                });
            } catch (err) {
                extLogError(`Failed to log DM: ${err?.message}`, { component: 'background', errorName: err?.name, errorStack: err?.stack });
            }

            // Show success toast
            chrome.tabs.sendMessage(tabId, {
                action: 'SHOW_TOAST',
                message: `DM sent to u/${task.data.targetUser}`,
                type: 'success'
            }).catch(() => {});

            // Check if this was part of a queue
            if (queue && queue.isActive) {
                queue.successCount++;

                // Update Supabase session progress
                if (queue.sessionId) {
                    try {
                        await api.updateAutomationSession(queue.sessionId, {
                            processedCount: queue.currentIndex + 1,
                            successCount: queue.successCount,
                            failedCount: queue.failedCount
                        });
                    } catch (err) {
                        extLogError(`Failed to update automation session: ${err?.message}`, { component: 'background', errorName: err?.name, errorStack: err?.stack });
                    }
                }

                // Check rate limit before continuing
                canSendDM(currentAccountId).then(result => {
                    if (!result.allowed) {
                        const reason = (result.reason || '').toLowerCase();
                        const isCooldown = reason.includes('cooldown');

                        if (!isCooldown) {
                            // Hard stop: daily limit, suspended, paused, shadowbanned
                            extLogInfo(`Cannot send more DMs: ${result.reason}, stopping automation`, { component: 'background' });
                            chrome.tabs.sendMessage(tabId, {
                                action: 'SHOW_TOAST',
                                message: result.reason,
                                type: 'warning'
                            }).catch(() => {});

                            queue.isActive = false;
                            if (queue.sessionId) {
                                api.updateAutomationSession(queue.sessionId, {
                                    status: 'stopped',
                                    processedCount: queue.currentIndex + 1
                                }).catch(e => extLogError(`Failed to update session: ${e?.message}`, { component: 'background', errorName: e?.name, errorStack: e?.stack }));
                            }
                            delete activeTasks[tabId];
                            delete subredditQueues[tabId];
                            onStateChanged();
                            return;
                        }
                        // Soft stop: cooldown active, fall through to delay path
                        extLogInfo('Cooldown active, will continue after delay', { component: 'background' });
                    }

                    // Get configurable delay
                    getDelayBetweenDMs().then(delay => {
                        extLogDebug(`Waiting ${Math.round(delay / 1000)} seconds before next item...`, { component: 'background' });

                        chrome.tabs.sendMessage(tabId, {
                            action: 'SHOW_TOAST',
                            message: `Next DM in ${Math.round(delay / 1000)}s...`,
                            type: 'info'
                        }).catch(() => {});

                        setTrackedTimeout(tabId, () => {
                            extLogDebug('Moving to next item in queue...', { component: 'background' });
                            queue.currentIndex++;
                            processNextQueueItem(tabId);
                        }, delay);
                    }).catch(err => {
                        extLogError(`Failed to get delay: ${err?.message}`, { component: 'background', errorName: err?.name, errorStack: err?.stack });
                        queue.currentIndex++;
                        processNextQueueItem(tabId);
                    });
                }).catch(err => {
                    extLogError(`Rate limit check failed: ${err?.message}`, { component: 'background', errorName: err?.name, errorStack: err?.stack });
                    // Continue anyway to avoid stuck state
                    queue.currentIndex++;
                    processNextQueueItem(tabId);
                });
            } else {
                // Single automation completed - notify content script to refresh UI
                // Release queue processing locks so polling can resume
                if (task.data?.isReply) replyQueueProcessing = false;
                if (task.data?.isOutreach) outreachQueueProcessing = false;
                delete activeTasks[tabId];
                onStateChanged();
                chrome.tabs.sendMessage(tabId, {
                    action: 'AUTOMATION_STOPPED'
                }).catch(() => {});
            }
        }
    } else {
        extLogError(`Step failed: ${result.error}`, { component: 'background' });

        // Initialize retry count if not set
        task.retries = task.retries || 0;

        const queue = subredditQueues[tabId];
        const errorContext = {
            targetUser: task.data?.targetUser,
            step: result.step || task.status,
            postUrl: task.data?.postUrl
        };

        // Check if we can retry
        if (task.retries < RETRY_CONFIG.maxRetries) {
            // Show error UI with retry option
            chrome.tabs.sendMessage(tabId, {
                action: 'AUTOMATION_ERROR',
                error: { message: result.error || 'Step failed' },
                context: errorContext
            }).catch(() => {});

            extLogDebug(`Error shown to user. Retries: ${task.retries}/${RETRY_CONFIG.maxRetries}`, { component: 'background' });
        } else {
            // Max retries exceeded - log failure and move on
            extLogWarn('Max retries exceeded, moving to next item', { component: 'background' });

            if (queue && queue.isActive) {
                queue.failedCount++;

                // Log failed DM attempt
                if (task && task.data && task.data.targetUser) {
                    try {
                        await api.logDM({
                            recipientUsername: task.data.targetUser,
                            postUrl: task.data.postUrl || null,
                            postTitle: task.data.postTitle || null,
                            subreddit: queue.subreddit,
                            messageContent: task.data.message || '',
                            status: 'failed',
                            automationType: 'batch',
                            sessionId: queue.sessionId
                        });
                    } catch (err) {
                        extLogError(`Failed to log DM: ${err?.message}`, { component: 'background', errorName: err?.name, errorStack: err?.stack });
                    }

                    // Log as skipped post too
                    try {
                        await api.logSkippedPost({
                            postUrl: task.data.postUrl || '',
                            postTitle: task.data.postTitle || null,
                            subreddit: task.data.subreddit || queue.subreddit,
                            author: task.data.targetUser,
                            sessionId: queue.sessionId,
                            skipReason: 'max_retries_exceeded',
                            skipDetails: {
                                source: 'automation_failure',
                                retries: task.retries,
                                lastError: result.error || null
                            }
                        });
                    } catch (err) {
                        extLogError(`Failed to log skipped post: ${err?.message}`, { component: 'background', errorName: err?.name, errorStack: err?.stack });
                    }
                }

                // Update Supabase session progress
                if (queue.sessionId) {
                    try {
                        await api.updateAutomationSession(queue.sessionId, {
                            processedCount: queue.currentIndex + 1,
                            successCount: queue.successCount,
                            failedCount: queue.failedCount
                        });
                    } catch (err) {
                        extLogError(`Failed to update automation session: ${err?.message}`, { component: 'background', errorName: err?.name, errorStack: err?.stack });
                    }
                }

                // Show toast and move to next
                chrome.tabs.sendMessage(tabId, {
                    action: 'SHOW_TOAST',
                    message: 'Failed after max retries, skipping...',
                    type: 'error'
                }).catch(() => {});

                queue.currentIndex++;
                delete activeTasks[tabId];
                onStateChanged();
                processNextQueueItem(tabId);
            } else {
                // Single/reply/outreach automation failed - show error and stop
                // Release queue processing locks
                if (task.data?.isReply) replyQueueProcessing = false;
                if (task.data?.isOutreach) outreachQueueProcessing = false;

                // Mark queue item as failed in backend so it doesn't get re-processed
                if (task.data?.queueItemId) {
                    api.markQueueItemFailed(task.data.queueItemId, result.error || 'Max retries exceeded').catch(err => {
                        extLogError(`Failed to mark queue item as failed: ${err?.message}`, { component: 'background', errorName: err?.name, errorStack: err?.stack });
                    });
                    clearQueueItemInProgress(task.data.queueItemId).catch(() => {});
                }

                chrome.tabs.sendMessage(tabId, {
                    action: 'AUTOMATION_ERROR',
                    error: { message: 'Failed after maximum retries. Please try again.' },
                    context: errorContext
                }).catch(() => {});

                delete activeTasks[tabId];
                onStateChanged();
            }
        }
    }
}

async function processNextQueueItem(tabId) {
    const queue = subredditQueues[tabId];
    if (!queue || !queue.isActive) return;

    if (queue.currentIndex >= queue.urls.length) {
        extLogInfo('Queue finished!', { component: 'background' });
        queue.isActive = false;

        // Mark Supabase session as completed
        if (queue.sessionId) {
            api.updateAutomationSession(queue.sessionId, {
                processedCount: queue.urls.length,
                successCount: queue.successCount,
                failedCount: queue.failedCount,
                status: 'completed'
            }).catch(e => extLogError(`Failed to update session: ${e?.message}`, { component: 'background', errorName: e?.name, errorStack: e?.stack }));
        }

        delete activeTasks[tabId];
        delete subredditQueues[tabId];
        onStateChanged();
        return;
    }

    const nextUrl = queue.urls[queue.currentIndex];
    extLogInfo(`Processing item ${queue.currentIndex + 1}/${queue.urls.length}: ${nextUrl}`, { component: 'background' });

    // Initialize task for this item
    activeTasks[tabId] = {
        status: AutomationState.NAVIGATING_TO_POST,
        data: {}, // Will be populated after scraping
        retries: 0
    };
    onStateChanged();

    // Notify content script to show sidebar with progress
    notifyAutomationProgress(tabId);

    // Navigate to post
    await chrome.tabs.update(tabId, { url: nextUrl });
    activeTasks[tabId].status = AutomationState.WAITING_FOR_POST;
}


// --- LLM Logic ---

async function generateQuestion(inputData) {
    const { post, settings } = inputData;

    try {
        // Call backend API for LLM generation
        const message = await api.generateQuestion(post, settings);
        return message;
    } catch (error) {
        extLogError(`LLM Generation Error: ${error?.message}`, { component: 'background', errorName: error?.name, errorStack: error?.stack });
        throw error;
    }
}

// --- Rate Limiting ---

let rateLimitState = {
    dailyCount: 0,
    lastResetDate: null,
    lastActionTime: 0
};

async function initRateLimiter() {
    const data = await chrome.storage.local.get(['rateLimitState']);
    if (data.rateLimitState) {
        rateLimitState = data.rateLimitState;

        // Reset daily count if it's a new day
        const today = new Date().toDateString();
        if (rateLimitState.lastResetDate !== today) {
            rateLimitState.dailyCount = 0;
            rateLimitState.lastResetDate = today;
            await chrome.storage.local.set({ rateLimitState });
        }
    } else {
        rateLimitState.lastResetDate = new Date().toDateString();
    }
}

async function canSendDM(accountId = null) {
    // If we have an accountId, check the backend (source of truth for per-account limits)
    if (accountId) {
        try {
            const result = await api.canAccountSend(accountId);
            if (result && !result.allowed) {
                return { allowed: false, reason: result.reason || 'Account daily limit reached' };
            }
            if (result && result.allowed) return { allowed: true };
        } catch (err) {
            extLogWarn(`Backend limit check failed, using local fallback: ${err.message}`, { component: 'background', errorName: err?.name, errorStack: err?.stack });
        }
    }

    // Local fallback (global counter)
    const settings = await chrome.storage.local.get(['dailyLimit']);
    const dailyLimit = settings.dailyLimit || 50;

    if (rateLimitState.dailyCount >= dailyLimit) {
        return { allowed: false, reason: `Daily limit of ${dailyLimit} DMs reached` };
    }

    return { allowed: true };
}

async function recordDMSent(accountId = null) {
    rateLimitState.dailyCount++;
    rateLimitState.lastActionTime = Date.now();
    await chrome.storage.local.set({ rateLimitState });
}

async function getDelayBetweenDMs() {
    const settings = await chrome.storage.local.get(['dmDelay']);
    const baseDelay = (settings.dmDelay || 20) * 1000;
    // Add random jitter (0-5 seconds) for more human-like behavior
    const jitter = Math.random() * 5000;
    return baseDelay + jitter;
}

async function getRateLimitStatus() {
    const settings = await chrome.storage.local.get(['dailyLimit']);
    const dailyLimit = settings.dailyLimit || 50;
    return {
        dailyCount: rateLimitState.dailyCount,
        dailyLimit: dailyLimit,
        remaining: Math.max(0, dailyLimit - rateLimitState.dailyCount)
    };
}

// Initialize rate limiter on startup
initRateLimiter();

// --- Keyboard Commands ---

chrome.commands.onCommand.addListener(async (command) => {
    extLogDebug(`Command received: ${command}`, { component: 'background' });

    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab || !tab.url || !tab.url.includes('reddit.com')) {
        return;
    }

    if (command === 'toggle-sidebar') {
        const data = await chrome.storage.local.get('isSidebarOpen');
        const newState = !data.isSidebarOpen;
        await chrome.storage.local.set({ isSidebarOpen: newState });

        chrome.tabs.sendMessage(tab.id, {
            action: 'TOGGLE_SIDEBAR',
            isOpen: newState
        }).catch(() => extLogDebug('Could not send toggle message', { component: 'background' }));
    }

    if (command === 'stop-automation') {
        // Cancel all pending timeouts and in-flight commands for this tab
        clearAllTimeouts(tab.id);
        delete commandInFlight[tab.id];

        const stoppedTask = activeTasks[tab.id];
        if (stoppedTask) {
            if (stoppedTask.data?.queueItemId) {
                clearQueueItemInProgress(stoppedTask.data.queueItemId).catch(() => {});
            }
            delete activeTasks[tab.id];
        }
        if (subredditQueues[tab.id]) {
            const queue = subredditQueues[tab.id];
            if (queue.sessionId) {
                api.updateAutomationSession(queue.sessionId, {
                    processedCount: queue.currentIndex,
                    successCount: queue.successCount || 0,
                    failedCount: queue.failedCount || 0,
                    status: 'stopped'
                }).catch(e => extLogError(`Failed to update session: ${e?.message}`, { component: 'background', errorName: e?.name, errorStack: e?.stack }));
            }
            queue.isActive = false;
            delete subredditQueues[tab.id];
        }

        // Only reset the relevant queue processing flag
        if (stoppedTask?.data?.isReply) replyQueueProcessing = false;
        else if (stoppedTask?.data?.isOutreach) outreachQueueProcessing = false;
        else { replyQueueProcessing = false; outreachQueueProcessing = false; }

        // Clear chat waiting state
        if (chatWaitingTabId === tab.id) chatWaitingTabId = null;
        if (chatOriginTabId === tab.id) chatOriginTabId = null;

        chrome.tabs.sendMessage(tab.id, {
            action: 'AUTOMATION_STOPPED'
        }).catch(() => {});

        extLogInfo('Automation stopped via keyboard shortcut', { component: 'background' });
    }
});

// --- Settings Update Handler & Dashboard Data ---

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === 'LOGIN') {
        api.resetApiConfig();
        api.login(request.email, request.password)
            .then(result => {
                // Auto-start reply queue polling after successful login
                startReplyQueuePolling();
                sendResponse({ success: true, ...result });
            })
            .catch(err => sendResponse({ error: err.message }));
        return true;
    }

    if (request.action === 'LOGOUT') {
        // Stop reply queue polling on logout
        stopReplyQueuePolling();
        api.logout()
            .then(() => sendResponse({ success: true }))
            .catch(() => sendResponse({ success: true }));
        return true;
    }

    if (request.action === 'SWITCH_TEAM') {
        const newTeamId = request.teamId;
        if (!newTeamId) {
            sendResponse({ error: 'No teamId provided' });
            return true;
        }
        api.switchTeam(newTeamId)
            .then(() => sendResponse({ success: true, teamId: newTeamId }))
            .catch(err => sendResponse({ error: err.message }));
        return true;
    }

    if (request.action === 'GET_TEAMS') {
        chrome.storage.local.get(['teams', 'teamId'])
            .then(data => sendResponse({ teams: data.teams || [], currentTeamId: data.teamId || null }));
        return true;
    }

    // Open dashboard tab and save its ID for later sync
    if (request.action === 'OPEN_DASHBOARD') {
        (async () => {
            const tab = await chrome.tabs.create({ url: 'https://app.qualydm.com' });
            await chrome.storage.local.set({ dashboardTabId: tab.id });
            extLogDebug(`[Sync] Opened dashboard tab and saved ID: ${tab.id}`, { component: 'background' });
            sendResponse({ success: true, tabId: tab.id });
        })();
        return true;
    }

    // --- Dashboard tab registration ---
    // The content script (dashboard_auth_bridge.js) sends this when it loads
    // on the dashboard domain. We record the tab ID so we can message it later.
    if (request.action === 'DASHBOARD_TAB_READY') {
        const tabId = sender?.tab?.id;
        if (tabId) {
            chrome.storage.local.set({ dashboardTabId: tabId });
            extLogDebug(`[Sync] Dashboard content script registered tab: ${tabId}`, { component: 'background' });
        }
        sendResponse({ ok: true });
        return true;
    }

    // --- Dashboard Sync via content script bridge ---
    // Instead of executeScript (which requires host permissions that may not
    // be granted until extension re-install), we message the content script
    // already running on the dashboard tab. The content script triggers the
    // React app to re-broadcast its auth state via the postMessage bridge.
    if (request.action === 'SYNC_FROM_DASHBOARD') {
        (async () => {
            try {
                // Step 1: Check if we already have valid tokens in storage
                const existing = await chrome.storage.local.get(['accessToken', 'expiresAt', 'userEmail', 'teamId', 'teams']);
                if (existing.accessToken && existing.expiresAt && (Date.now() / 1000 < existing.expiresAt)) {
                    extLogDebug('[Sync] Already have valid tokens, skipping sync', { component: 'background' });
                    sendResponse({ success: true, email: existing.userEmail, teams: existing.teams || [], teamId: existing.teamId });
                    return;
                }

                // Step 2: Find the dashboard tab
                let tabId = null;

                // Method 1: Use tab ID registered by the content script
                const stored = await chrome.storage.local.get(['dashboardTabId']);
                if (stored.dashboardTabId) {
                    try {
                        const tab = await chrome.tabs.get(stored.dashboardTabId);
                        if (tab && !tab.discarded) {
                            tabId = tab.id;
                            extLogDebug(`[Sync] Using registered dashboard tab: ${tabId}`, { component: 'background' });
                        }
                    } catch (e) {
                        extLogDebug(`[Sync] Registered tab gone: ${e.message}`, { component: 'background' });
                        await chrome.storage.local.remove('dashboardTabId');
                    }
                }

                // Method 2: Query tabs by URL (works with host_permissions)
                if (!tabId) {
                    const allTabs = await chrome.tabs.query({});
                    const dashTabs = allTabs.filter(t =>
                        t.url && (
                            t.url.startsWith('https://app.qualydm.com') ||
                            t.url.startsWith('http://localhost:5173') ||
                            t.url.startsWith('http://localhost:3000')
                        )
                    );
                    if (dashTabs.length) {
                        tabId = dashTabs[0].id;
                        extLogDebug(`[Sync] Found dashboard tab by URL: ${tabId}`, { component: 'background' });
                    }
                }

                if (!tabId) {
                    sendResponse({ success: false, error: 'No dashboard tab found. Open the dashboard first.' });
                    return;
                }

                // Step 3: Ask the content script to trigger the React app's auth broadcast
                try {
                    await chrome.tabs.sendMessage(tabId, { action: 'REQUEST_AUTH_FROM_PAGE' });
                    extLogDebug(`[Sync] Sent REQUEST_AUTH_FROM_PAGE to tab ${tabId}`, { component: 'background' });
                } catch (e) {
                    extLogWarn(`[Sync] Failed to message content script: ${e.message}`, { component: 'background', errorName: e?.name, errorStack: e?.stack });
                    sendResponse({ success: false, error: 'Dashboard tab not ready. Try refreshing the dashboard page.' });
                    return;
                }

                // Step 4: Wait for tokens to arrive via the bridge
                // The bridge flow is: content script -> RDM_BRIDGE_READY -> React app
                // -> SESSION_RESTORE -> content script -> DASHBOARD_AUTH_SYNC -> stored
                const maxWait = 6000;
                const interval = 500;
                const start = Date.now();
                while (Date.now() - start < maxWait) {
                    await new Promise(r => setTimeout(r, interval));
                    const data = await chrome.storage.local.get(['accessToken', 'expiresAt', 'userEmail', 'teamId', 'teams']);
                    if (data.accessToken && data.expiresAt && (Date.now() / 1000 < data.expiresAt)) {
                        extLogDebug(`[Sync] Tokens arrived via bridge after ${Date.now() - start}ms`, { component: 'background' });
                        sendResponse({ success: true, email: data.userEmail, teams: data.teams || [], teamId: data.teamId });
                        return;
                    }
                }

                // Tokens didn't arrive in time — the bridge may still be working
                sendResponse({ success: false, error: 'Sync in progress. Close and reopen the popup in a few seconds.' });
            } catch (err) {
                sendResponse({ success: false, error: err.message });
            }
        })();
        return true;
    }

    // --- Dashboard Auth Sync Handlers (bridge-based) ---

    if (request.action === 'DASHBOARD_AUTH_SYNC') {
        const p = request.payload;
        if (!p || !p.accessToken) {
            sendResponse({ success: false, error: 'Missing auth data' });
            return true;
        }
        const authData = {
            accessToken: p.accessToken,
            refreshToken: p.refreshToken,
            expiresAt: p.expiresAt,
            teamId: p.teamId || null,
            teams: p.teams || [],
            userEmail: p.userEmail || '',
            userName: p.userName || ''
        };
        chrome.storage.local.set(authData).then(() => {
            api.resetApiConfig();
            startReplyQueuePolling();
            sendResponse({ success: true });
        });
        return true;
    }

    if (request.action === 'DASHBOARD_LOGOUT_SYNC') {
        stopReplyQueuePolling();
        chrome.storage.local.remove([
            'accessToken', 'refreshToken', 'expiresAt',
            'teamId', 'teams', 'userEmail', 'userName'
        ]).then(() => {
            api.resetApiConfig();
            sendResponse({ success: true });
        });
        return true;
    }

    if (request.action === 'DASHBOARD_TEAM_SWITCH') {
        const newTeamId = request.payload?.teamId;
        if (!newTeamId) {
            sendResponse({ success: false, error: 'No teamId' });
            return true;
        }
        chrome.storage.local.set({ teamId: newTeamId }).then(() => {
            api.resetApiConfig();
            sendResponse({ success: true, teamId: newTeamId });
        });
        return true;
    }

    if (request.action === 'DASHBOARD_TOKEN_REFRESH') {
        const p = request.payload;
        if (!p || !p.accessToken) {
            sendResponse({ success: false, error: 'Missing token data' });
            return true;
        }
        chrome.storage.local.set({
            accessToken: p.accessToken,
            refreshToken: p.refreshToken,
            expiresAt: p.expiresAt
        }).then(() => {
            api.resetApiConfig();
            sendResponse({ success: true });
        });
        return true;
    }

    if (request.action === 'SETTINGS_UPDATED') {
        extLogInfo(`Settings updated: ${JSON.stringify(request.settings)}`, { component: 'background' });
        // Reset API config cache so new settings are used
        api.resetApiConfig();
        // Re-initialize rate limiter with new settings
        initRateLimiter();
    }

    if (request.action === 'GET_RATE_LIMIT_STATUS') {
        getRateLimitStatus().then(status => sendResponse(status));
        return true;
    }

    if (request.action === 'GET_ANALYTICS') {
        api.getAnalytics().then(analytics => sendResponse(analytics));
        return true;
    }

    if (request.action === 'GET_SUBREDDITS') {
        api.getDMsBySubreddit(10).then(data => sendResponse(data));
        return true;
    }

    if (request.action === 'GET_DM_HISTORY') {
        api.getDMHistory(request.limit || 50).then(history => sendResponse(history));
        return true;
    }

    // Queue management
    if (request.action === 'GET_QUEUE_STATS') {
        api.getQueueStats().then(stats => sendResponse(stats)).catch(() => sendResponse({ pending: 0, sent: 0 }));
        return true;
    }

    if (request.action === 'GET_QUEUE') {
        api.getQueue({ status: request.status || 'pending', limit: request.limit || 10 }).then(items => sendResponse(items)).catch(() => sendResponse([]));
        return true;
    }

    if (request.action === 'APPROVE_QUEUE_ITEM') {
        api.approveQueueItem(request.itemId).then(() => sendResponse({ success: true })).catch(e => sendResponse({ success: false, error: e.message }));
        return true;
    }

    if (request.action === 'REJECT_QUEUE_ITEM') {
        api.rejectQueueItem(request.itemId).then(() => sendResponse({ success: true })).catch(e => sendResponse({ success: false, error: e.message }));
        return true;
    }

    if (request.action === 'ADD_TO_QUEUE') {
        api.addToQueue(request.data).then(item => sendResponse({ success: true, data: item })).catch(e => sendResponse({ success: false, error: e.message }));
        return true;
    }

    // Chat message sync (for reply detection)
    if (request.action === 'SYNC_CHAT_MESSAGES') {
        const syncData = request.data;
        if (syncData && syncData.participantUsername && syncData.messages) {
            // Auto-detect current logged-in account and tag the sync
            cookies.detectCurrentAccount().then(detected => {
                // Use background detection, fall back to content script's DOM-based username
                const resolvedUsername = detected.username || syncData.accountUsername || null;
                const resolvedAccountId = detected.accountId || null;

                // Guard: participant must not be the same as the logged-in account
                // This happens when getCurrentUsername() fails in the content script
                // and the user's own name gets picked up as the "participant"
                if (resolvedUsername &&
                    syncData.participantUsername.toLowerCase() === resolvedUsername.toLowerCase()) {
                    extLogWarn(`Skipping sync: participant "${syncData.participantUsername}" is the logged-in account`, { component: 'background' });
                    return { skipped: true, reason: 'participant is self' };
                }
                return api.syncConversation({
                    participantUsername: syncData.participantUsername,
                    messages: syncData.messages,
                    accountId: resolvedAccountId,
                    accountUsername: resolvedUsername
                });
            }).then(result => {
                extLogDebug(`Chat sync completed: ${JSON.stringify(result)}`, { component: 'background' });
                sendResponse({ success: true, data: result });
            }).catch(err => {
                extLogError(`Chat sync failed: ${err?.message}`, { component: 'background', errorName: err?.name, errorStack: err?.stack });
                sendResponse({ success: false, error: err.message });
            });
            return true;
        }
        sendResponse({ success: false, error: 'Invalid sync data' });
        return true;
    }

    // Bulk sync keep-alive: content script signals when bulk sync is active
    if (request.action === 'START_BULK_SYNC_KEEPALIVE') {
        bulkSyncActive = true;
        updateKeepAlive();
        sendResponse({ success: true });
        return true;
    }

    if (request.action === 'STOP_BULK_SYNC_KEEPALIVE') {
        bulkSyncActive = false;
        updateKeepAlive();
        sendResponse({ success: true });
        return true;
    }

    // Start bulk sync: find or create a Reddit chat tab, then tell it to sync
    if (request.action === 'TRIGGER_START_BULK_SYNC') {
        // Helper: create a fresh chat tab and send START_BULK_SYNC once loaded
        function createChatTabAndSync() {
            chrome.tabs.create({ url: 'https://www.reddit.com/chat/', active: true }, (newTab) => {
                const onUpdated = (tabId, changeInfo) => {
                    if (tabId === newTab.id && changeInfo.status === 'complete') {
                        chrome.tabs.onUpdated.removeListener(onUpdated);
                        // Extra delay for content script injection and chat sidebar to load
                        setTimeout(() => {
                            chrome.tabs.sendMessage(newTab.id, { action: 'START_BULK_SYNC' }).catch((err) => {
                                extLogWarn(`Failed to send START_BULK_SYNC to new tab: ${err?.message}`, { component: 'background', errorName: err?.name, errorStack: err?.stack });
                            });
                        }, 3000);
                    }
                };
                chrome.tabs.onUpdated.addListener(onUpdated);
                setTimeout(() => chrome.tabs.onUpdated.removeListener(onUpdated), 30000);
            });
        }

        chrome.tabs.query({
            url: ['*://*.reddit.com/chat/*', '*://chat.reddit.com/*']
        }, (tabs) => {
            if (tabs && tabs.length > 0) {
                const chatTab = tabs[0];
                chrome.tabs.update(chatTab.id, { active: true });

                // First try: ping the content script to check if it's alive
                setTimeout(() => {
                    chrome.tabs.sendMessage(chatTab.id, { action: 'PING' }).then((resp) => {
                        if (resp && resp.pong) {
                            // Content script is alive, send the sync command
                            chrome.tabs.sendMessage(chatTab.id, { action: 'START_BULK_SYNC' }).catch(() => {
                                extLogWarn('START_BULK_SYNC failed despite PING success, reloading tab', { component: 'background' });
                                chrome.tabs.reload(chatTab.id, {}, () => {
                                    setTimeout(() => {
                                        chrome.tabs.sendMessage(chatTab.id, { action: 'START_BULK_SYNC' }).catch(() => {
                                            extLogWarn('START_BULK_SYNC failed after reload too', { component: 'background' });
                                        });
                                    }, 4000);
                                });
                            });
                        } else {
                            // Content script not responding, reload the tab
                            extLogDebug('Chat tab content script not responding, reloading...', { component: 'background' });
                            chrome.tabs.reload(chatTab.id, {}, () => {
                                const onUpdated = (tabId, changeInfo) => {
                                    if (tabId === chatTab.id && changeInfo.status === 'complete') {
                                        chrome.tabs.onUpdated.removeListener(onUpdated);
                                        setTimeout(() => {
                                            chrome.tabs.sendMessage(chatTab.id, { action: 'START_BULK_SYNC' }).catch(() => {
                                                extLogWarn('START_BULK_SYNC failed after reload', { component: 'background' });
                                            });
                                        }, 3000);
                                    }
                                };
                                chrome.tabs.onUpdated.addListener(onUpdated);
                                setTimeout(() => chrome.tabs.onUpdated.removeListener(onUpdated), 30000);
                            });
                        }
                    }).catch(() => {
                        // PING failed - content script is dead, reload the tab
                        extLogDebug('Chat tab PING failed, reloading...', { component: 'background' });
                        chrome.tabs.reload(chatTab.id, {}, () => {
                            const onUpdated = (tabId, changeInfo) => {
                                if (tabId === chatTab.id && changeInfo.status === 'complete') {
                                    chrome.tabs.onUpdated.removeListener(onUpdated);
                                    setTimeout(() => {
                                        chrome.tabs.sendMessage(chatTab.id, { action: 'START_BULK_SYNC' }).catch(() => {
                                            extLogWarn('START_BULK_SYNC failed after reload', { component: 'background' });
                                        });
                                    }, 3000);
                                }
                            };
                            chrome.tabs.onUpdated.addListener(onUpdated);
                            setTimeout(() => chrome.tabs.onUpdated.removeListener(onUpdated), 30000);
                        });
                    });
                }, 500);
            } else {
                // No existing chat tab, create one
                createChatTabAndSync();
            }
        });
        sendResponse({ success: true });
        return true;
    }

    // Bulk sync progress relay: forward from content script to dashboard tabs
    if (request.action === 'BULK_SYNC_PROGRESS') {
        chrome.tabs.query({
            url: ['https://app.qualydm.com/*', 'http://localhost:5173/*', 'http://localhost:3000/*']
        }, (tabs) => {
            for (const tab of tabs) {
                chrome.tabs.sendMessage(tab.id, {
                    action: 'BULK_SYNC_PROGRESS',
                    data: request.data
                }).catch(() => {}); // Ignore if tab not listening
            }
        });
        return;
    }

    // Cancel bulk sync: forward from dashboard to Reddit chat tabs
    if (request.action === 'TRIGGER_CANCEL_BULK_SYNC') {
        chrome.tabs.query({
            url: ['*://*.reddit.com/chat/*', '*://chat.reddit.com/*']
        }, (tabs) => {
            for (const tab of tabs) {
                chrome.tabs.sendMessage(tab.id, { action: 'CANCEL_BULK_SYNC' }).catch(() => {});
            }
        });
        sendResponse({ success: true });
        return true;
    }

    // Get conversation stats (for popup)
    if (request.action === 'GET_CONVERSATION_STATS') {
        api.getConversationStats().then(stats => sendResponse(stats)).catch(() => sendResponse({ total: 0, withReplies: 0 }));
        return true;
    }

    // Reply Queue Management
    if (request.action === 'START_REPLY_QUEUE_POLLING') {
        startReplyQueuePolling();
        sendResponse({ success: true });
        return true;
    }

    if (request.action === 'STOP_REPLY_QUEUE_POLLING') {
        stopReplyQueuePolling();
        sendResponse({ success: true });
        return true;
    }

    if (request.action === 'GET_REPLY_QUEUE_STATUS') {
        chrome.alarms.get(REPLY_QUEUE_ALARM_NAME).then(alarm => {
            sendResponse({
                isPolling: !!alarm,
                isProcessing: replyQueueProcessing
            });
        });
        return true;
    }

    // Outreach Queue Management (triggered from dashboard via bridge)
    if (request.action === 'START_OUTREACH_QUEUE_POLLING') {
        startOutreachQueuePolling();
        sendResponse({ success: true });
        return true;
    }

    if (request.action === 'STOP_OUTREACH_QUEUE_POLLING') {
        stopOutreachQueuePolling();
        sendResponse({ success: true });
        return true;
    }

    if (request.action === 'GET_OUTREACH_QUEUE_STATUS') {
        chrome.alarms.get(OUTREACH_QUEUE_ALARM_NAME).then(alarm => {
            sendResponse({
                isPolling: !!alarm,
                isProcessing: outreachQueueProcessing
            });
        });
        return true;
    }

    if (request.action === 'CAPTURE_REDDIT_COOKIES') {
        // Capture current browser Reddit cookies + detect logged-in username
        cookies.captureCurrentCookies().then(result => {
            sendResponse(result);
        }).catch(err => {
            sendResponse({ cookies: [], username: null, error: err.message });
        });
        return true;
    }

    if (request.action === 'REGISTER_CAPTURED_ACCOUNT') {
        // Register a captured account via the backend API
        const { username, cookies: capturedCookies } = request;
        if (!username) {
            sendResponse({ success: false, error: 'No username' });
            return true;
        }
        api.addAccount({ username, cookies: capturedCookies })
            .then(result => {
                extLogInfo(`Account u/${username} registered via API`, { component: 'background' });
                sendResponse({ success: true, data: result });
            })
            .catch(err => {
                extLogError(`Failed to register account u/${username}: ${err?.message}`, { component: 'background', errorName: err?.name, errorStack: err?.stack });
                sendResponse({ success: false, error: err.message });
            });
        return true;
    }
});

// =============================================================================
// REPLY QUEUE PROCESSING (uses chrome.alarms for MV3 reliability)
// =============================================================================

const REPLY_QUEUE_ALARM_NAME = 'reply-queue-poll';
const REPLY_QUEUE_POLL_INTERVAL_MINUTES = 0.25; // 15 seconds (minimum chrome.alarms supports ~0.08 min in MV3 dev)
let replyQueueProcessing = false;

// Persistent tracking of in-progress queue item IDs (survives service worker restarts)
const QUEUE_IN_PROGRESS_KEY = 'queueItemsInProgress';
const QUEUE_IN_PROGRESS_TTL_MS = 5 * 60 * 1000; // 5 min TTL — auto-expire stale entries

async function markQueueItemInProgress(itemId) {
    const data = await chrome.storage.local.get(QUEUE_IN_PROGRESS_KEY);
    const inProgress = data[QUEUE_IN_PROGRESS_KEY] || {};
    inProgress[itemId] = Date.now();
    await chrome.storage.local.set({ [QUEUE_IN_PROGRESS_KEY]: inProgress });
}

async function clearQueueItemInProgress(itemId) {
    const data = await chrome.storage.local.get(QUEUE_IN_PROGRESS_KEY);
    const inProgress = data[QUEUE_IN_PROGRESS_KEY] || {};
    delete inProgress[itemId];
    await chrome.storage.local.set({ [QUEUE_IN_PROGRESS_KEY]: inProgress });
}

// Track how many times each queue item has been attempted (prevents stuck items)
const QUEUE_ATTEMPT_COUNTS_KEY = 'queueAttemptCounts';
const MAX_QUEUE_ITEM_ATTEMPTS = 5;

async function incrementQueueItemAttempts(itemId) {
    const data = await chrome.storage.local.get(QUEUE_ATTEMPT_COUNTS_KEY);
    const counts = data[QUEUE_ATTEMPT_COUNTS_KEY] || {};
    counts[itemId] = (counts[itemId] || 0) + 1;
    // Prune old entries (keep last 200)
    const entries = Object.entries(counts);
    if (entries.length > 200) {
        const pruned = Object.fromEntries(entries.slice(-200));
        await chrome.storage.local.set({ [QUEUE_ATTEMPT_COUNTS_KEY]: pruned });
        return pruned[itemId];
    }
    await chrome.storage.local.set({ [QUEUE_ATTEMPT_COUNTS_KEY]: counts });
    return counts[itemId];
}

async function clearQueueItemAttempts(itemId) {
    const data = await chrome.storage.local.get(QUEUE_ATTEMPT_COUNTS_KEY);
    const counts = data[QUEUE_ATTEMPT_COUNTS_KEY] || {};
    delete counts[itemId];
    await chrome.storage.local.set({ [QUEUE_ATTEMPT_COUNTS_KEY]: counts });
}

async function isQueueItemInProgress(itemId) {
    const data = await chrome.storage.local.get(QUEUE_IN_PROGRESS_KEY);
    const inProgress = data[QUEUE_IN_PROGRESS_KEY] || {};
    const startTime = inProgress[itemId];
    if (!startTime) return false;
    // Auto-expire entries older than TTL (handles crashed automations)
    if (Date.now() - startTime > QUEUE_IN_PROGRESS_TTL_MS) {
        delete inProgress[itemId];
        await chrome.storage.local.set({ [QUEUE_IN_PROGRESS_KEY]: inProgress });
        return false;
    }
    return true;
}
let replyQueueConsecutiveFailures = 0;
let replyQueuePollSkips = 0;

// Keep-alive alarm handler — lightweight, just prevents SW suspension
chrome.alarms.onAlarm.addListener(async (alarm) => {
    if (alarm.name !== KEEPALIVE_ALARM_NAME) return;
    extLogDebug('Keep-alive alarm fired', { component: 'background' });
});

// Handle alarm events for reply queue polling
chrome.alarms.onAlarm.addListener(async (alarm) => {
    if (alarm.name !== REPLY_QUEUE_ALARM_NAME) return;

    if (replyQueueProcessing) {
        extLogDebug('Reply queue: already processing, skipping poll', { component: 'background' });
        return;
    }

    // Backoff: skip polls when backend is repeatedly failing
    if (replyQueuePollSkips > 0) {
        replyQueuePollSkips--;
        extLogDebug(`Reply queue: backing off, skipping poll (${replyQueuePollSkips} skips remaining)`, { component: 'background' });
        return;
    }

    // Check if still authenticated before polling
    const authed = await api.isAuthenticated();
    if (!authed) {
        extLogInfo('Reply queue: not authenticated, stopping polling', { component: 'background' });
        stopReplyQueuePolling();
        return;
    }

    // Check if daily limit allows sending
    const limitCheck = await canSendDM();
    if (!limitCheck.allowed) {
        extLogDebug('Reply queue: daily limit reached, skipping poll', { component: 'background' });
        return;
    }

    try {
        const nextReply = await api.getNextReplyToSend();
        replyQueueConsecutiveFailures = 0;

        if (nextReply) {
            // Skip if this item is already being processed (persists across SW restarts)
            if (await isQueueItemInProgress(nextReply.id)) {
                extLogDebug(`Reply queue: item already in progress, skipping: ${nextReply.id}`, { component: 'background' });
                return;
            }
            // Skip if this item was already sent locally but API failed to update
            try {
                const { sentQueueItems = [] } = await chrome.storage.local.get('sentQueueItems');
                if (sentQueueItems.includes(nextReply.id)) {
                    extLogDebug(`Reply queue: item already sent locally, retrying API mark: ${nextReply.id}`, { component: 'background' });
                    api.markQueueItemSent(nextReply.id).then(() => {
                        const updated = sentQueueItems.filter(id => id !== nextReply.id);
                        chrome.storage.local.set({ sentQueueItems: updated });
                    }).catch(() => {});
                    return;
                }
            } catch (e) { /* ignore storage errors */ }
            extLogInfo(`Found approved reply to send: ${nextReply.id}`, { component: 'background' });
            replyQueueProcessing = true;
            await markQueueItemInProgress(nextReply.id);
            await processReplyQueueItem(nextReply);
            // NOTE: replyQueueProcessing stays true until the automation completes.
            // It is reset in handleStepCompletion (on success/failure) or cleanupTask.
        }
    } catch (err) {
        replyQueueConsecutiveFailures++;
        replyQueueProcessing = false;

        // Exponential backoff: skip future polls based on consecutive failures
        if (replyQueueConsecutiveFailures >= 6) {
            replyQueuePollSkips = 3; // ~60s effective interval
        } else if (replyQueueConsecutiveFailures >= 3) {
            replyQueuePollSkips = 1; // ~30s effective interval
        }

        if (replyQueueConsecutiveFailures >= 5) {
            extLogError(`Reply queue poll error (${replyQueueConsecutiveFailures} consecutive failures): ${err.message}`, { component: 'background', errorName: err?.name, errorStack: err?.stack });
        } else {
            extLogWarn(`Reply queue poll error (${replyQueueConsecutiveFailures}): ${err.message}`, { component: 'background', errorName: err?.name, errorStack: err?.stack });
        }
    }
});

async function startReplyQueuePolling() {
    const existing = await chrome.alarms.get(REPLY_QUEUE_ALARM_NAME);
    if (existing) {
        extLogDebug('Reply queue polling already active', { component: 'background' });
        return;
    }

    extLogInfo('Starting reply queue polling (chrome.alarms)...', { component: 'background' });
    chrome.alarms.create(REPLY_QUEUE_ALARM_NAME, {
        delayInMinutes: 0.08, // Fire first alarm almost immediately (~5s)
        periodInMinutes: REPLY_QUEUE_POLL_INTERVAL_MINUTES
    });

    // Also do an immediate check (alarm delay is not instant)
    try {
        const limitCheck = await canSendDM();
        if (limitCheck.allowed) {
            const nextReply = await api.getNextReplyToSend();
            if (nextReply) {
                if (await isQueueItemInProgress(nextReply.id)) {
                    extLogDebug(`Reply queue: item already in progress (immediate), skipping: ${nextReply.id}`, { component: 'background' });
                } else {
                    extLogInfo(`Found approved reply to send (immediate): ${nextReply.id}`, { component: 'background' });
                    replyQueueProcessing = true;
                    await markQueueItemInProgress(nextReply.id);
                    await processReplyQueueItem(nextReply);
                    // replyQueueProcessing stays true until automation completes
                }
            }
        } else {
            extLogDebug('Reply queue: daily limit reached at startup', { component: 'background' });
        }
    } catch (err) {
        extLogError(`Reply queue immediate check error: ${err?.message}`, { component: 'background', errorName: err?.name, errorStack: err?.stack });
    }
}

async function stopReplyQueuePolling() {
    extLogInfo('Stopping reply queue polling...', { component: 'background' });
    await chrome.alarms.clear(REPLY_QUEUE_ALARM_NAME);
}

async function processReplyQueueItem(item) {
    extLogInfo(`Processing reply queue item: ${item.id} to u/${item.recipientUsername}`, { component: 'background' });

    // Detect current account and warn if mismatched with the assigned account
    const detected = await cookies.detectCurrentAccount(true);
    if (item.accountId && detected.accountId && item.accountId !== detected.accountId) {
        const check = await cookies.checkAccountMatch(item.accountId);
        extLogWarn(`Reply queue account mismatch: ${check.reason}`, { component: 'background' });

        // Notify user via browser notification
        chrome.notifications.create(`account-mismatch-${item.id}`, {
            type: 'basic',
            iconUrl: chrome.runtime.getURL('icons/icon.svg'),
            title: 'Reply skipped — wrong account',
            message: `Reply to u/${item.recipientUsername} needs u/${check.expectedUsername || '???'} but you're logged in as u/${detected.username}. Switch accounts on Reddit to send it.`
        });

        // Also show toast on any open Reddit tab
        const tabs = await chrome.tabs.query({ url: '*://*.reddit.com/*' });
        if (tabs[0]?.id) {
            chrome.tabs.sendMessage(tabs[0].id, {
                action: 'SHOW_TOAST',
                message: `Reply to u/${item.recipientUsername} skipped — log in as u/${check.expectedUsername || '???'} to send it.`,
                type: 'warning'
            }).catch(() => {});
        }

        await clearQueueItemInProgress(item.id);
        replyQueueProcessing = false;
        return;
    }

    // Find an available Reddit tab (one without an active task) or create one
    const tabs = await chrome.tabs.query({ url: '*://*.reddit.com/*' });
    const availableTab = tabs.find(t => !activeTasks[t.id]);
    let tabId = availableTab?.id;

    if (!tabId && tabs.length > 0) {
        // All Reddit tabs have active tasks — defer instead of overwriting
        extLogDebug('Reply queue: all Reddit tabs busy, deferring', { component: 'background' });
        await clearQueueItemInProgress(item.id);
        replyQueueProcessing = false;
        return;
    }

    if (!tabId) {
        extLogInfo('No Reddit tab found - creating one for reply automation', { component: 'background' });
        const newTab = await chrome.tabs.create({
            url: `https://www.reddit.com/user/${item.recipientUsername}/`,
            active: false
        });
        tabId = newTab.id;

        // Wait for the tab to load before proceeding
        await new Promise((resolve) => {
            const listener = (updatedTabId, changeInfo) => {
                if (updatedTabId === tabId && changeInfo.status === 'complete') {
                    chrome.tabs.onUpdated.removeListener(listener);
                    resolve();
                }
            };
            chrome.tabs.onUpdated.addListener(listener);
            // Safety timeout - don't wait forever
            setTimeout(() => {
                chrome.tabs.onUpdated.removeListener(listener);
                resolve();
            }, 15000);
        });

        // Since we navigated directly to the profile, set state accordingly
        activeTasks[tabId] = {
            status: AutomationState.WAITING_FOR_PROFILE,
            data: {
                targetUser: item.recipientUsername,
                message: item.finalMessage,
                queueItemId: item.id,
                conversationId: item.conversationId,
                accountId: item.accountId || detected.accountId || null,
                isReply: true
            },
            retries: 0
        };
        onStateChanged();

        // Profile is already loaded, process next step
        processNextStep(tabId);
        return;
    }

    // Start automation task for this reply on the available tab
    activeTasks[tabId] = {
        status: AutomationState.NAVIGATING_PROFILE,
        data: {
            targetUser: item.recipientUsername,
            message: item.finalMessage,
            queueItemId: item.id,
            conversationId: item.conversationId,
            accountId: item.accountId || detected.accountId || null,
            isReply: true
        },
        retries: 0
    };
    onStateChanged();

    // Notify content script to show sidebar with progress
    notifyAutomationProgress(tabId);

    // Navigate to user's profile
    const profileUrl = `https://www.reddit.com/user/${item.recipientUsername}/`;
    await chrome.tabs.update(tabId, { url: profileUrl });
    activeTasks[tabId].status = AutomationState.WAITING_FOR_PROFILE;

    // The existing automation flow will handle clicking chat and typing the message
    // When complete, handleStepCompletion will mark the queue item as sent
}

// =============================================================================
// OUTREACH QUEUE PROCESSING (dashboard-triggered, alarm-based like reply queue)
// =============================================================================

const OUTREACH_QUEUE_ALARM_NAME = 'outreach-queue-poll';
const OUTREACH_QUEUE_POLL_INTERVAL_MINUTES = 0.5; // 30 seconds
let outreachQueueProcessing = false;
let lastOutreachSendTime = 0;

chrome.alarms.onAlarm.addListener(async (alarm) => {
    if (alarm.name !== OUTREACH_QUEUE_ALARM_NAME) return;

    if (outreachQueueProcessing) {
        extLogDebug('Outreach queue: already processing, skipping poll', { component: 'background' });
        return;
    }

    // Rate limit: respect delay between DMs
    const now = Date.now();
    const minDelay = 20000; // 20s minimum between sends
    if (lastOutreachSendTime && (now - lastOutreachSendTime) < minDelay) {
        return;
    }

    const authed = await api.isAuthenticated();
    if (!authed) {
        extLogInfo('Outreach queue: not authenticated, stopping polling', { component: 'background' });
        stopOutreachQueuePolling();
        return;
    }

    // Check if daily limit allows sending (skip this poll, don't stop entirely)
    const limitCheck = await canSendDM();
    if (!limitCheck.allowed) {
        extLogDebug('Outreach queue: daily limit reached, skipping this poll', { component: 'background' });
        return;
    }

    try {
        const nextItem = await api.getNextQueueItem(null, 'outreach');
        if (nextItem) {
            if (await isQueueItemInProgress(nextItem.id)) {
                extLogDebug(`Outreach queue: item already in progress, skipping: ${nextItem.id}`, { component: 'background' });
                return;
            }
            extLogInfo(`Found approved outreach item to send: ${nextItem.id}`, { component: 'background' });
            outreachQueueProcessing = true;
            await markQueueItemInProgress(nextItem.id);
            await processOutreachQueueItem(nextItem);
            lastOutreachSendTime = Date.now();
            // outreachQueueProcessing stays true until automation completes
        } else {
            // No more items - stop polling
            extLogInfo('Outreach queue: no more approved items, stopping', { component: 'background' });
            stopOutreachQueuePolling();
        }
    } catch (err) {
        extLogError(`Outreach queue poll error: ${err?.message}`, { component: 'background', errorName: err?.name, errorStack: err?.stack });
        outreachQueueProcessing = false;
    }
});

async function startOutreachQueuePolling() {
    const existing = await chrome.alarms.get(OUTREACH_QUEUE_ALARM_NAME);
    if (existing) {
        extLogDebug('Outreach queue polling already active', { component: 'background' });
        return;
    }

    extLogInfo('Starting outreach queue polling (chrome.alarms)...', { component: 'background' });
    chrome.alarms.create(OUTREACH_QUEUE_ALARM_NAME, {
        delayInMinutes: 0.08,
        periodInMinutes: OUTREACH_QUEUE_POLL_INTERVAL_MINUTES
    });

    // Immediate check
    try {
        const limitCheck = await canSendDM();
        if (limitCheck.allowed) {
            const nextItem = await api.getNextQueueItem(null, 'outreach');
            if (nextItem) {
                if (await isQueueItemInProgress(nextItem.id)) {
                    extLogDebug(`Outreach queue: item already in progress (immediate), skipping: ${nextItem.id}`, { component: 'background' });
                } else {
                    extLogInfo(`Found approved outreach item (immediate): ${nextItem.id}`, { component: 'background' });
                    outreachQueueProcessing = true;
                    await markQueueItemInProgress(nextItem.id);
                    await processOutreachQueueItem(nextItem);
                    lastOutreachSendTime = Date.now();
                    // outreachQueueProcessing stays true until automation completes
                }
            }
        } else {
            extLogDebug('Outreach queue: daily limit reached at startup', { component: 'background' });
        }
    } catch (err) {
        extLogError(`Outreach queue immediate check error: ${err?.message}`, { component: 'background', errorName: err?.name, errorStack: err?.stack });
    }
}

async function stopOutreachQueuePolling() {
    extLogInfo('Stopping outreach queue polling...', { component: 'background' });
    await chrome.alarms.clear(OUTREACH_QUEUE_ALARM_NAME);
}

async function processOutreachQueueItem(item) {
    extLogInfo(`Processing outreach queue item: ${item.id} to u/${item.recipientUsername}`, { component: 'background' });

    // Track attempts — auto-fail items that keep getting retried without success
    const attempts = await incrementQueueItemAttempts(item.id);
    if (attempts > MAX_QUEUE_ITEM_ATTEMPTS) {
        extLogWarn(`Outreach queue item ${item.id} exceeded ${MAX_QUEUE_ITEM_ATTEMPTS} attempts, marking as failed`, { component: 'background' });
        api.markQueueItemFailed(item.id, `Auto-failed after ${MAX_QUEUE_ITEM_ATTEMPTS} unsuccessful attempts`).catch(err => {
            extLogError(`Failed to mark stuck item as failed: ${err?.message}`, { component: 'background' });
        });
        await clearQueueItemInProgress(item.id);
        await clearQueueItemAttempts(item.id);
        outreachQueueProcessing = false;
        return;
    }

    // Account mismatch check
    const detected = await cookies.detectCurrentAccount(true);
    if (item.accountId && detected.accountId && item.accountId !== detected.accountId) {
        const check = await cookies.checkAccountMatch(item.accountId);
        extLogWarn(`Outreach queue account mismatch: ${check.reason}`, { component: 'background' });

        chrome.notifications.create(`account-mismatch-outreach-${item.id}`, {
            type: 'basic',
            iconUrl: chrome.runtime.getURL('icons/icon.svg'),
            title: 'Outreach skipped — wrong account',
            message: `DM to u/${item.recipientUsername} needs u/${check.expectedUsername || '???'} but you're logged in as u/${detected.username}. Switch accounts on Reddit.`
        });

        const tabs = await chrome.tabs.query({ url: '*://*.reddit.com/*' });
        if (tabs[0]?.id) {
            chrome.tabs.sendMessage(tabs[0].id, {
                action: 'SHOW_TOAST',
                message: `Outreach to u/${item.recipientUsername} skipped — log in as u/${check.expectedUsername || '???'} to send.`,
                type: 'warning'
            }).catch(() => {});
        }
        await clearQueueItemInProgress(item.id);
        outreachQueueProcessing = false;
        return;
    }

    // Find an available Reddit tab (one without an active task) or create one
    const tabs = await chrome.tabs.query({ url: '*://*.reddit.com/*' });
    const availableTab = tabs.find(t => !activeTasks[t.id]);
    let tabId = availableTab?.id;

    if (!tabId && tabs.length > 0) {
        // All Reddit tabs have active tasks — defer instead of overwriting
        extLogDebug('Outreach queue: all Reddit tabs busy, deferring', { component: 'background' });
        await clearQueueItemInProgress(item.id);
        outreachQueueProcessing = false;
        return;
    }

    if (!tabId) {
        extLogInfo('No Reddit tab found - creating one for outreach automation', { component: 'background' });
        const newTab = await chrome.tabs.create({
            url: `https://www.reddit.com/user/${item.recipientUsername}/`,
            active: false
        });
        tabId = newTab.id;

        // Wait for tab to load
        await new Promise((resolve) => {
            const listener = (updatedTabId, changeInfo) => {
                if (updatedTabId === tabId && changeInfo.status === 'complete') {
                    chrome.tabs.onUpdated.removeListener(listener);
                    resolve();
                }
            };
            chrome.tabs.onUpdated.addListener(listener);
            setTimeout(() => {
                chrome.tabs.onUpdated.removeListener(listener);
                resolve();
            }, 15000);
        });

        activeTasks[tabId] = {
            status: AutomationState.WAITING_FOR_PROFILE,
            data: {
                targetUser: item.recipientUsername,
                message: item.finalMessage,
                queueItemId: item.id,
                conversationId: null,
                accountId: item.accountId || detected.accountId || null,
                isReply: false,
                isOutreach: true
            },
            retries: 0
        };
        onStateChanged();

        processNextStep(tabId);
        return;
    }

    // Use available Reddit tab
    activeTasks[tabId] = {
        status: AutomationState.NAVIGATING_PROFILE,
        data: {
            targetUser: item.recipientUsername,
            message: item.finalMessage,
            queueItemId: item.id,
            conversationId: null,
            accountId: item.accountId || detected.accountId || null,
            isOutreach: true,
            isReply: false
        },
        retries: 0
    };
    onStateChanged();

    notifyAutomationProgress(tabId);

    const profileUrl = `https://www.reddit.com/user/${item.recipientUsername}/`;
    await chrome.tabs.update(tabId, { url: profileUrl });
    activeTasks[tabId].status = AutomationState.WAITING_FOR_PROFILE;
}

// =============================================================================
// SERVICE WORKER RESTART RECOVERY
// =============================================================================

// Recover interrupted automation state after SW suspension/restart
async function recoverInterruptedAutomation() {
    try {
        const data = await chrome.storage.local.get(PERSISTED_STATE_KEY);
        const state = data[PERSISTED_STATE_KEY];
        if (!state || !state.timestamp) return;

        const age = Date.now() - state.timestamp;
        // Discard state older than 5 minutes (stale from a previous crash)
        if (age > 5 * 60 * 1000) {
            extLogInfo('Persisted automation state is stale (>5min), discarding', { component: 'background' });
            await clearPersistedState();
            return;
        }

        extLogInfo(`Recovering interrupted automation state (age: ${Math.round(age / 1000)}s)`, { component: 'background' });

        // States where the in-flight work was lost and cannot be resumed
        const nonRecoverableStates = [
            AutomationState.GENERATING_DM,
            AutomationState.CLICKING_CHAT,
            AutomationState.TYPING_MESSAGE,
            AutomationState.FINDING_CHAT_USER,
            AutomationState.NAVIGATING_CHAT,
            AutomationState.WAITING_FOR_CHAT,
            AutomationState.NAVIGATING_PROFILE,
            AutomationState.WAITING_FOR_PROFILE,
            AutomationState.NAVIGATING_TO_POST,
            AutomationState.WAITING_FOR_POST
        ];

        // Recover subreddit queues (can resume from currentIndex)
        if (state.subredditQueues) {
            for (const [tabIdStr, queue] of Object.entries(state.subredditQueues)) {
                const tabId = parseInt(tabIdStr, 10);
                try {
                    const tab = await chrome.tabs.get(tabId);
                    if (!tab || tab.discarded) throw new Error('Tab gone');

                    subredditQueues[tabId] = queue;
                    extLogInfo(`Resuming queue for tab ${tabId} at index ${queue.currentIndex}/${queue.urls.length}`, { component: 'background' });

                    chrome.tabs.sendMessage(tabId, {
                        action: 'SHOW_TOAST',
                        message: 'Resuming automation after brief interruption...',
                        type: 'info'
                    }).catch(() => {});

                    processNextQueueItem(tabId);
                } catch {
                    extLogWarn(`Recovery: tab ${tabId} not available, stopping queue`, { component: 'background' });
                    if (queue.sessionId) {
                        api.updateAutomationSession(queue.sessionId, {
                            processedCount: queue.currentIndex,
                            successCount: queue.successCount,
                            failedCount: queue.failedCount,
                            status: 'interrupted'
                        }).catch(() => {});
                    }
                }
            }
        }

        // Recover individual tasks
        if (state.activeTasks) {
            for (const [tabIdStr, task] of Object.entries(state.activeTasks)) {
                const tabId = parseInt(tabIdStr, 10);
                // Skip tasks that belong to a recovered queue (handled above)
                if (subredditQueues[tabId]) continue;

                try {
                    const tab = await chrome.tabs.get(tabId);
                    if (!tab || tab.discarded) throw new Error('Tab gone');

                    if (task.status === AutomationState.AWAITING_CONFIRMATION && task.data?.message) {
                        // Re-show the confirmation dialog — the generated message is preserved
                        activeTasks[tabId] = task;
                        chrome.tabs.sendMessage(tabId, {
                            action: 'SHOW_DM_CONFIRMATION',
                            data: {
                                targetUser: task.data.targetUser,
                                message: task.data.message,
                                postTitle: task.data.postTitle,
                                subreddit: task.data.subreddit,
                                classification: task.data.classification
                            }
                        }).catch(() => {});
                    } else {
                        // Non-recoverable state — fail gracefully
                        extLogInfo(`Task on tab ${tabId} in state ${task.status} — not recoverable, notifying user`, { component: 'background' });
                        chrome.tabs.sendMessage(tabId, {
                            action: 'SHOW_TOAST',
                            message: 'Automation was interrupted. Please retry.',
                            type: 'warning'
                        }).catch(() => {});
                        chrome.tabs.sendMessage(tabId, {
                            action: 'AUTOMATION_STOPPED'
                        }).catch(() => {});
                    }
                } catch {
                    extLogWarn(`Recovery: tab ${tabId} not available`, { component: 'background' });
                }

                // Release queue processing locks for non-recoverable tasks
                if (!activeTasks[tabId]) {
                    if (task.data?.isReply) replyQueueProcessing = false;
                    if (task.data?.isOutreach) outreachQueueProcessing = false;
                    if (task.data?.queueItemId) {
                        clearQueueItemInProgress(task.data.queueItemId).catch(() => {});
                    }
                }
            }
        }

        // Restore chat waiting state
        if (state.chatWaitingTabId) chatWaitingTabId = state.chatWaitingTabId;
        if (state.chatOriginTabId) chatOriginTabId = state.chatOriginTabId;

        await clearPersistedState();
        onStateChanged();
    } catch (err) {
        extLogError(`Automation recovery failed: ${err?.message}`, {
            component: 'background', errorName: err?.name, errorStack: err?.stack
        });
        await clearPersistedState();
    }
}

// =============================================================================
// AUTO-START ON SERVICE WORKER LOAD
// =============================================================================

// In MV3, the service worker restarts after being killed.
// Recover interrupted automation and restart polling if authenticated.
(async () => {
    try {
        // Recover any interrupted automation first
        await recoverInterruptedAutomation();

        const authed = await api.isAuthenticated();
        if (authed) {
            extLogInfo('User authenticated on worker start - reply queue polling available (not auto-started)', { component: 'background' });
            // NOTE: Do NOT auto-start reply queue polling on SW restart.
            // Polling is started explicitly when the user triggers sends from the dashboard
            // or logs in. Auto-starting caused unexpected DMs on extension load.
        } else {
            extLogDebug('User not authenticated on worker start - reply queue polling not started', { component: 'background' });
        }
    } catch (err) {
        extLogError(`Error on worker start: ${err?.message}`, { component: 'background', errorName: err?.name, errorStack: err?.stack });
    }
})();

