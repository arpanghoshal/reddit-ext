console.log('Reddit Insight Gatherer: Background service worker loaded');

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
    GENERATING_DM: 'GENERATING_DM'
};

// Store active automation tasks: { [tabId]: { status, data: { targetUser, message }, retries } }
let activeTasks = {};

// Subreddit Queue: { [tabId]: { urls: [], currentIndex: 0, isActive: false, subreddit: '' } }
let subredditQueues = {};

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
        console.log(`Starting subreddit automation for tab ${tabId} with ${request.data.posts.length} posts`);

        subredditQueues[tabId] = {
            urls: request.data.posts,
            currentIndex: 0,
            isActive: true,
            subreddit: request.data.subreddit
        };

        processNextQueueItem(tabId);
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
            subreddit: queue ? queue.subreddit : ''
        });
    }

    if (request.action === 'STOP_AUTOMATION') {
        const tabId = sender.tab ? sender.tab.id : request.tabId;
        console.log(`Stopping automation for tab ${tabId}`);

        if (activeTasks[tabId]) delete activeTasks[tabId];
        if (subredditQueues[tabId]) {
            subredditQueues[tabId].isActive = false;
            delete subredditQueues[tabId];
        }

        sendResponse({ success: true });
    }
});

// 2. Tab Update Handler (Navigation Monitor)
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    // Check if this is a chat.reddit.com tab that we're waiting for
    if (changeInfo.status === 'complete' && tab.url && tab.url.includes('chat.reddit.com')) {
        // Find if any task is waiting for chat
        for (const [originalTabId, task] of Object.entries(activeTasks)) {
            if (task.status === AutomationState.WAITING_FOR_CHAT) {
                console.log(`Chat tab detected! Tab ${tabId}, transferring task from ${originalTabId}`);

                // Transfer the task to the new chat tab
                activeTasks[tabId] = task;
                delete activeTasks[originalTabId];

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

    // Check if a task is waiting for chat and this might be the chat tab
    for (const [originalTabId, task] of Object.entries(activeTasks)) {
        if (task.status === AutomationState.WAITING_FOR_CHAT) {
            const pendingUrl = tab.pendingUrl || tab.url || '';
            if (pendingUrl.includes('chat.reddit.com')) {
                console.log(`Chat tab opened! Transferring task from tab ${originalTabId} to ${tab.id}`);

                // Transfer task to new tab
                activeTasks[tab.id] = task;
                delete activeTasks[originalTabId];

                // onUpdated will trigger processNextStep when the new tab finishes loading
            }
            break;
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

                        // 3. Start Single User Automation
                        // We update the task data with the new user and message
                        task.data = { targetUser: postData.author, message: message };

                        // Transition to Profile Navigation
                        task.status = AutomationState.NAVIGATING_PROFILE;
                        const profileUrl = `https://www.reddit.com/user/${postData.author}/`;
                        chrome.tabs.update(tabId, { url: profileUrl });
                        task.status = AutomationState.WAITING_FOR_PROFILE;

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
            // Chat button clicked - chat opens as popup overlay on same page
            // Proceed directly to typing after a delay for popup to render
            console.log('Chat button clicked. Waiting for popup to render...');
            task.status = AutomationState.TYPING_MESSAGE;

            // Wait for popup to fully render (5.5 seconds should be enough)
            setTimeout(() => {
                console.log('Sending TYPE_MESSAGE command...');
                chrome.tabs.sendMessage(tabId, {
                    action: 'EXECUTE_ACTION',
                    command: 'TYPE_MESSAGE',
                    text: task.data.message
                }).catch(err => {
                    console.error('Failed to send TYPE_MESSAGE:', err);
                });
            }, 5500);

        } else if (task.status === AutomationState.TYPING_MESSAGE) {
            console.log('🎉 Single Automation Complete!');

            // Check if this was part of a queue
            if (subredditQueues[tabId] && subredditQueues[tabId].isActive) {
                const nextPostDelay = 20000; // 20 seconds fixed delay
                console.log(`Waiting ${nextPostDelay / 1000} seconds before next item...`);

                // Add delay before moving to next item
                setTimeout(() => {
                    console.log('Moving to next item in queue...');
                    subredditQueues[tabId].currentIndex++;
                    processNextQueueItem(tabId);
                }, nextPostDelay);
            } else {
                delete activeTasks[tabId];
            }
        }
    } else {
        console.error('Step failed:', result.error);
        // If part of queue, skip and move next
        if (subredditQueues[tabId] && subredditQueues[tabId].isActive) {
            console.log('Step failed, skipping to next item...');
            subredditQueues[tabId].currentIndex++;
            processNextQueueItem(tabId);
        }
    }
}

async function processNextQueueItem(tabId) {
    const queue = subredditQueues[tabId];
    if (!queue || !queue.isActive) return;

    if (queue.currentIndex >= queue.urls.length) {
        console.log('Queue finished!');
        queue.isActive = false;
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


// --- LLM Logic (Existing) ---

// Hardcoded Configuration (Private)
const CONFIG = {
    API_KEY: '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',
    MODEL: 'tngtech/deepseek-r1t2-chimera:free'
};

async function generateQuestion(inputData) {
    const { post, settings } = inputData;
    const apiKey = CONFIG.API_KEY;

    try {
        const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${apiKey}`,
                'Content-Type': 'application/json',
                'HTTP-Referer': 'https://github.com/your-repo/reddit-insight-gatherer',
                'X-Title': 'Reddit Insight Gatherer'
            },
            body: JSON.stringify({
                model: CONFIG.MODEL,
                messages: [
                    {
                        role: 'system',
                        content: `You are a helpful assistant for a founder/marketer. 
            Your goal is to generate a single, natural, open-ended DM question with an introduction like hey or hi to a Reddit user based on their post.
            
            CONTEXT:
            Business: ${settings.businessDesc}
            Target Persona: ${settings.persona || 'General'}
            Insight Goal: ${settings.insightTypes ? settings.insightTypes.join(', ') : 'General insights'}
            Tone: ${settings.tone || 'Curious'}

            RULES:
            1. NO selling, pitching, or promoting.
            2. NO links or product mentions.
            3. Must feel like a personal, human message.
            4. Keep it short (1-2 sentences).
            5. Focus on the user's problem/situation.
            6. The output should be ONLY the message text, no quotes or explanations.`
                    },
                    {
                        role: 'user',
                        content: `Post Title: ${post.title}
            Post Body: ${post.body}
            Subreddit: ${post.subreddit}
            
            Generate a DM question:`
                    }
                ]
            })
        });

        if (!response.ok) {
            const errorData = await response.json();
            throw new Error(errorData.error?.message || 'Failed to generate question');
        }

        const data = await response.json();

        if (!data.choices || !data.choices.length || !data.choices[0].message) {
            console.error('Unexpected API response structure:', data);
            throw new Error('Invalid API response format');
        }

        return data.choices[0].message.content.trim();

    } catch (error) {
        console.error('LLM Generation Error:', error);
        throw error;
    }
}

