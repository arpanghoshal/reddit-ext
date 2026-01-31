// --- Import API Client (ES Module) ---
import * as api from '../lib/api.js';

console.log('Reddit Automated DM: Background service worker loaded');
console.log('API module loaded:', Object.keys(api));

// --- Automation State Management ---
const AutomationState = {
    IDLE: 'IDLE',
    NAVIGATING_PROFILE: 'NAVIGATING_PROFILE',
    WAITING_FOR_PROFILE: 'WAITING_FOR_PROFILE',
    CLICKING_CHAT: 'CLICKING_CHAT',
    NAVIGATING_CHAT: 'NAVIGATING_CHAT',
    WAITING_FOR_CHAT: 'WAITING_FOR_CHAT',
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

// Cleanup function to remove tasks for closed tabs
function cleanupTask(tabId) {
    if (activeTasks[tabId]) {
        console.log(`Cleaning up task for closed tab ${tabId}`);
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
}

// Listen for tab removal to clean up memory
chrome.tabs.onRemoved.addListener((tabId) => {
    cleanupTask(tabId);
});

// Retry configuration
const RETRY_CONFIG = {
    maxRetries: 3,
    baseDelay: 5000,  // 5 seconds
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

    if (request.action === 'START_AUTOMATION') {
        const tabId = sender.tab ? sender.tab.id : request.tabId;
        if (!tabId) {
            console.error('No tab ID found for automation');
            return;
        }
        startAutomation(tabId, request.data);
    }

    if (request.action === 'START_SUBREDDIT_AUTOMATION') {
        const tabId = sender.tab ? sender.tab.id : request.tabId;

        // Validate queue data
        if (!request.data || !Array.isArray(request.data.posts) || request.data.posts.length === 0) {
            console.error('Invalid subreddit automation data: posts array is missing or empty');
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
            console.error('No valid post URLs found');
            chrome.tabs.sendMessage(tabId, {
                action: 'SHOW_TOAST',
                message: 'No valid post URLs found',
                type: 'error'
            }).catch(() => {});
            sendResponse({ success: false, error: 'No valid posts' });
            return;
        }

        console.log(`Starting subreddit automation for tab ${tabId} with ${validPosts.length} posts`);

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
        const tabId = sender.tab.id;
        handleStepCompletion(tabId, request.result);
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
        console.log(`Stopping automation for tab ${tabId}`);

        if (activeTasks[tabId]) delete activeTasks[tabId];
        if (subredditQueues[tabId]) {
            const queue = subredditQueues[tabId];

            // Mark Supabase session as stopped
            if (queue.sessionId) {
                api.updateAutomationSession(queue.sessionId, {
                    processedCount: queue.currentIndex,
                    successCount: queue.successCount || 0,
                    failedCount: queue.failedCount || 0,
                    status: 'stopped'
                });
            }

            queue.isActive = false;
            delete subredditQueues[tabId];
        }

        sendResponse({ success: true });
    }

    if (request.action === 'RETRY_AUTOMATION') {
        const tabId = sender.tab ? sender.tab.id : request.tabId;
        const context = request.context || {};

        console.log(`Retrying automation for tab ${tabId}`);

        const task = activeTasks[tabId];
        if (task) {
            task.retries = (task.retries || 0) + 1;

            if (task.retries > RETRY_CONFIG.maxRetries) {
                console.log('Max retries exceeded, notifying content script');
                chrome.tabs.sendMessage(tabId, {
                    action: 'AUTOMATION_ERROR',
                    error: { message: 'Max retries exceeded. Please try again later.' },
                    context: context
                });
                return;
            }

            const delay = getRetryDelay(task.retries - 1);
            console.log(`Retry ${task.retries}/${RETRY_CONFIG.maxRetries} after ${delay}ms delay`);

            chrome.tabs.sendMessage(tabId, {
                action: 'SHOW_TOAST',
                message: `Retrying in ${Math.round(delay / 1000)}s... (${task.retries}/${RETRY_CONFIG.maxRetries})`,
                type: 'warning'
            });

            setTimeout(() => {
                processNextStep(tabId);
            }, delay);
        }

        sendResponse({ success: true });
    }

    if (request.action === 'SKIP_AND_CONTINUE') {
        const tabId = sender.tab ? sender.tab.id : request.tabId;

        console.log(`Skipping current item for tab ${tabId}`);

        const queue = subredditQueues[tabId];
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
            processNextQueueItem(tabId);
        } else {
            // Single automation - just clear the task
            delete activeTasks[tabId];
        }

        sendResponse({ success: true });
    }

    // Handle DM confirmation (user approved the DM)
    if (request.action === 'CONFIRM_DM') {
        const tabId = sender.tab ? sender.tab.id : request.tabId;
        const task = activeTasks[tabId];

        if (task && task.status === AutomationState.AWAITING_CONFIRMATION) {
            console.log('DM confirmed, proceeding to send...');

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
            console.log('DM skipped by user');

            const queue = subredditQueues[tabId];
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
        // Only transfer if we have a specific tab waiting for chat (prevents race condition)
        if (chatWaitingTabId !== null && activeTasks[chatWaitingTabId]) {
            const task = activeTasks[chatWaitingTabId];
            if (task.status === AutomationState.WAITING_FOR_CHAT) {
                console.log(`Chat tab detected! Tab ${tabId}, transferring task from ${chatWaitingTabId}`);

                // Transfer the task to the new chat tab
                activeTasks[tabId] = task;
                delete activeTasks[chatWaitingTabId];

                // Clear the waiting flag
                const originalTabId = chatWaitingTabId;
                chatWaitingTabId = null;

                // Process next step on the new tab
                processNextStep(tabId);
                return;
            }
        }
    }

    // Regular tab update handling
    if (changeInfo.status === 'complete' && activeTasks[tabId]) {
        console.log(`Tab ${tabId} updated. Current state: ${activeTasks[tabId].status}`);

        // If we were waiting for a post to load, process it
        if (activeTasks[tabId].status === AutomationState.WAITING_FOR_POST) {
            processNextStep(tabId);
        }
        // If we were waiting for profile to load
        else if (activeTasks[tabId].status === AutomationState.WAITING_FOR_PROFILE) {
            processNextStep(tabId);
        }
    }
});

// 3. New Tab Created Handler (for chat.reddit.com opening in new tab)
chrome.tabs.onCreated.addListener((tab) => {
    console.log('New tab created:', tab.id, tab.pendingUrl || tab.url);

    // Only handle if we have a specific tab waiting for chat (prevents race condition)
    if (chatWaitingTabId !== null && activeTasks[chatWaitingTabId]) {
        const task = activeTasks[chatWaitingTabId];
        if (task.status === AutomationState.WAITING_FOR_CHAT) {
            const pendingUrl = tab.pendingUrl || tab.url || '';
            if (pendingUrl.includes('chat.reddit.com')) {
                console.log(`Chat tab opened! Transferring task from tab ${chatWaitingTabId} to ${tab.id}`);

                // Transfer task to new tab
                activeTasks[tab.id] = task;
                delete activeTasks[chatWaitingTabId];

                // Clear the waiting flag
                chatWaitingTabId = null;

                // onUpdated will trigger processNextStep when the new tab finishes loading
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
        }).catch(() => console.log('Could not send message to tab ' + tab.id));
    }
});

// --- Automation Logic ---

async function startAutomation(tabId, data) {
    console.log(`Starting automation for user: ${data.targetUser}`);

    activeTasks[tabId] = {
        status: AutomationState.NAVIGATING_PROFILE,
        data: data,
        retries: 0
    };

    // Step 1: Navigate to User Profile
    const profileUrl = `https://www.reddit.com/user/${data.targetUser}/`;
    await chrome.tabs.update(tabId, { url: profileUrl });

    // State will update to WAITING_FOR_PROFILE, but we handle it in onUpdated
    activeTasks[tabId].status = AutomationState.WAITING_FOR_PROFILE;
}

async function processNextStep(tabId) {
    const task = activeTasks[tabId];
    if (!task) return;

    try {
        switch (task.status) {
            case AutomationState.WAITING_FOR_POST:
                console.log('Post loaded. Extracting data and generating DM...');
                task.status = AutomationState.GENERATING_DM;

                // 1. Get Post Data
                chrome.tabs.sendMessage(tabId, { action: 'GET_POST_DATA' }, async (postData) => {
                    if (!postData || !postData.valid) {
                        console.warn('Invalid post data, skipping...');
                        handleStepCompletion(tabId, { success: false, error: 'Invalid post' });
                        return;
                    }

                    // 2. Generate DM
                    try {
                        // Get settings from storage
                        const settings = await chrome.storage.local.get(['businessDesc', 'persona', 'insightTypes', 'tone']);
                        const message = await generateQuestion({ post: postData, settings });

                        console.log('DM Generated:', message);

                        // 3. Update task data with the new user and message
                        task.data = {
                            targetUser: postData.author,
                            message: message,
                            postUrl: postData.url,
                            postTitle: postData.title,
                            subreddit: postData.subreddit
                        };

                        // Check DM send mode
                        const modeSettings = await chrome.storage.local.get(['dmSendMode']);
                        const dmSendMode = modeSettings.dmSendMode || 'confirm';

                        if (dmSendMode === 'confirm') {
                            // Show confirmation dialog in content script
                            task.status = AutomationState.AWAITING_CONFIRMATION;
                            chrome.tabs.sendMessage(tabId, {
                                action: 'SHOW_DM_CONFIRMATION',
                                data: {
                                    targetUser: postData.author,
                                    message: message,
                                    postTitle: postData.title,
                                    subreddit: postData.subreddit
                                }
                            }).catch(err => {
                                console.error('Failed to show confirmation dialog:', err);
                            });
                        } else {
                            // Auto mode - proceed directly
                            task.status = AutomationState.NAVIGATING_PROFILE;
                            const profileUrl = `https://www.reddit.com/user/${postData.author}/`;
                            chrome.tabs.update(tabId, { url: profileUrl });
                            task.status = AutomationState.WAITING_FOR_PROFILE;
                        }

                    } catch (err) {
                        console.error('Generation failed:', err);
                        handleStepCompletion(tabId, { success: false, error: 'Generation failed' });
                    }
                });
                break;

            case AutomationState.WAITING_FOR_PROFILE:
                console.log('Profile loaded. Attempting to find and click Chat button...');
                task.status = AutomationState.CLICKING_CHAT;

                // Inject script to find and click chat
                // We send a message to the content script to perform the action
                // The content script must be ready.
                setTimeout(() => {
                    chrome.tabs.sendMessage(tabId, {
                        action: 'EXECUTE_ACTION',
                        command: 'CLICK_CHAT_BUTTON'
                    }).catch(err => {
                        console.error('Failed to send CLICK_CHAT_BUTTON:', err);
                        // Retry or abort?
                    });
                }, 2000); // Small delay to ensure hydration
                break;

            case AutomationState.WAITING_FOR_CHAT:
                console.log('Chat loaded. Attempting to type message...');
                task.status = AutomationState.TYPING_MESSAGE;

                setTimeout(() => {
                    chrome.tabs.sendMessage(tabId, {
                        action: 'EXECUTE_ACTION',
                        command: 'TYPE_MESSAGE',
                        text: task.data.message
                    });
                }, 2000);
                break;
        }
    } catch (error) {
        console.error('Automation Error:', error);
        // Handle error state
    }
}

function handleStepCompletion(tabId, result) {
    const task = activeTasks[tabId];
    if (!task) return;

    console.log(`Step complete for tab ${tabId}:`, result);

    if (result.success) {
        if (task.status === AutomationState.CLICKING_CHAT) {
            // Chat button clicked - could open as popup overlay or new tab
            console.log('Chat button clicked. Setting up to wait for chat...');

            // Set this tab as waiting for chat (in case a new tab opens)
            chatWaitingTabId = tabId;
            task.status = AutomationState.WAITING_FOR_CHAT;

            // Wait for either:
            // 1. Chat popup to render on same page
            // 2. New chat.reddit.com tab to open (handled by onCreated/onUpdated)
            // After 5.5 seconds, try to type on current tab (popup case)
            setTimeout(() => {
                // Only proceed if we're still waiting (didn't transfer to new tab)
                if (chatWaitingTabId === tabId && activeTasks[tabId] &&
                    activeTasks[tabId].status === AutomationState.WAITING_FOR_CHAT) {
                    console.log('Chat popup detected (same tab). Sending TYPE_MESSAGE...');
                    chatWaitingTabId = null;
                    activeTasks[tabId].status = AutomationState.TYPING_MESSAGE;
                    chrome.tabs.sendMessage(tabId, {
                        action: 'EXECUTE_ACTION',
                        command: 'TYPE_MESSAGE',
                        text: task.data.message
                    }).catch(err => {
                        console.error('Failed to send TYPE_MESSAGE:', err);
                    });
                }
            }, 5500);

        } else if (task.status === AutomationState.TYPING_MESSAGE) {
            console.log('🎉 Single Automation Complete!');

            // Reset retry count on success
            task.retries = 0;

            // Record DM sent for rate limiting
            recordDMSent();

            // Log DM to Supabase
            const queue = subredditQueues[tabId];
            api.logDM({
                recipientUsername: task.data.targetUser,
                postUrl: task.data.postUrl || null,
                postTitle: task.data.postTitle || null,
                subreddit: queue ? queue.subreddit : null,
                messageContent: task.data.message,
                status: 'sent',
                automationType: queue ? 'batch' : 'single',
                sessionId: queue ? queue.sessionId : null
            });

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
                    api.updateAutomationSession(queue.sessionId, {
                        processedCount: queue.currentIndex + 1,
                        successCount: queue.successCount,
                        failedCount: queue.failedCount
                    });
                }

                // Check rate limit before continuing
                canSendDM().then(result => {
                    if (!result.allowed) {
                        console.log('Daily limit reached, stopping automation');
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
                            });
                        }
                        delete activeTasks[tabId];
                        return;
                    }

                    // Get configurable delay
                    getDelayBetweenDMs().then(delay => {
                        console.log(`Waiting ${Math.round(delay / 1000)} seconds before next item...`);

                        chrome.tabs.sendMessage(tabId, {
                            action: 'SHOW_TOAST',
                            message: `Next DM in ${Math.round(delay / 1000)}s...`,
                            type: 'info'
                        }).catch(() => {});

                        setTimeout(() => {
                            console.log('Moving to next item in queue...');
                            queue.currentIndex++;
                            processNextQueueItem(tabId);
                        }, delay);
                    });
                });
            } else {
                // Single automation completed - notify content script to refresh UI
                delete activeTasks[tabId];
                chrome.tabs.sendMessage(tabId, {
                    action: 'AUTOMATION_STOPPED'
                }).catch(() => {});
            }
        }
    } else {
        console.error('Step failed:', result.error);

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

            console.log(`Error shown to user. Retries: ${task.retries}/${RETRY_CONFIG.maxRetries}`);
        } else {
            // Max retries exceeded - log failure and move on
            console.log('Max retries exceeded, moving to next item');

            if (queue && queue.isActive) {
                queue.failedCount++;

                // Log failed DM attempt
                if (task && task.data && task.data.targetUser) {
                    api.logDM({
                        recipientUsername: task.data.targetUser,
                        postUrl: task.data.postUrl || null,
                        postTitle: task.data.postTitle || null,
                        subreddit: queue.subreddit,
                        messageContent: task.data.message || '',
                        status: 'failed',
                        automationType: 'batch',
                        sessionId: queue.sessionId
                    });
                }

                // Update Supabase session progress
                if (queue.sessionId) {
                    api.updateAutomationSession(queue.sessionId, {
                        processedCount: queue.currentIndex + 1,
                        successCount: queue.successCount,
                        failedCount: queue.failedCount
                    });
                }

                // Show toast and move to next
                chrome.tabs.sendMessage(tabId, {
                    action: 'SHOW_TOAST',
                    message: 'Failed after max retries, skipping...',
                    type: 'error'
                }).catch(() => {});

                queue.currentIndex++;
                delete activeTasks[tabId];
                processNextQueueItem(tabId);
            } else {
                // Single automation failed - show error and stop
                chrome.tabs.sendMessage(tabId, {
                    action: 'AUTOMATION_ERROR',
                    error: { message: 'Failed after maximum retries. Please try again.' },
                    context: errorContext
                }).catch(() => {});

                delete activeTasks[tabId];
            }
        }
    }
}

async function processNextQueueItem(tabId) {
    const queue = subredditQueues[tabId];
    if (!queue || !queue.isActive) return;

    if (queue.currentIndex >= queue.urls.length) {
        console.log('Queue finished!');
        queue.isActive = false;

        // Mark Supabase session as completed
        if (queue.sessionId) {
            api.updateAutomationSession(queue.sessionId, {
                processedCount: queue.urls.length,
                successCount: queue.successCount,
                failedCount: queue.failedCount,
                status: 'completed'
            });
        }

        delete activeTasks[tabId];
        return;
    }

    const nextUrl = queue.urls[queue.currentIndex];
    console.log(`Processing item ${queue.currentIndex + 1}/${queue.urls.length}: ${nextUrl}`);

    // Initialize task for this item
    activeTasks[tabId] = {
        status: AutomationState.NAVIGATING_TO_POST,
        data: {}, // Will be populated after scraping
        retries: 0
    };

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
        console.error('LLM Generation Error:', error);
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

async function canSendDM() {
    const settings = await chrome.storage.local.get(['dailyLimit']);
    const dailyLimit = settings.dailyLimit || 50;

    // Check daily limit
    if (rateLimitState.dailyCount >= dailyLimit) {
        return { allowed: false, reason: `Daily limit of ${dailyLimit} DMs reached` };
    }

    return { allowed: true };
}

async function recordDMSent() {
    rateLimitState.dailyCount++;
    rateLimitState.lastActionTime = Date.now();
    await chrome.storage.local.set({ rateLimitState });
}

async function getDelayBetweenDMs() {
    const settings = await chrome.storage.local.get(['delayBetweenDMs']);
    const baseDelay = (settings.delayBetweenDMs || 20) * 1000;
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
    console.log('Command received:', command);

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
        }).catch(() => console.log('Could not send toggle message'));
    }

    if (command === 'stop-automation') {
        if (activeTasks[tab.id]) delete activeTasks[tab.id];
        if (subredditQueues[tab.id]) {
            const queue = subredditQueues[tab.id];
            if (queue.sessionId) {
                api.updateAutomationSession(queue.sessionId, {
                    processedCount: queue.currentIndex,
                    successCount: queue.successCount || 0,
                    failedCount: queue.failedCount || 0,
                    status: 'stopped'
                });
            }
            queue.isActive = false;
            delete subredditQueues[tab.id];
        }

        chrome.tabs.sendMessage(tab.id, {
            action: 'AUTOMATION_STOPPED'
        }).catch(() => {});

        console.log('Automation stopped via keyboard shortcut');
    }
});

// --- Settings Update Handler & Dashboard Data ---

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === 'SETTINGS_UPDATED') {
        console.log('Settings updated:', request.settings);
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
        api.getQueue(request.status || 'pending', request.limit || 10).then(items => sendResponse(items)).catch(() => sendResponse([]));
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
});

