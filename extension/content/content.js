console.log('Reddit Automated DM: Content script loaded');

// --- Early PING handler (registered before any async init so background can detect readiness) ---
if (!window.__redditDMExtPingReady) {
    window.__redditDMExtPingReady = true;
    chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
        if (request.action === 'PING') {
            sendResponse({ pong: true });
            return;
        }
    });
}

// --- Lightweight Logger Relay (sends to background service worker) ---
function reportToBackground(level, message, opts = {}) {
    if (!isContextValid()) return;
    try {
        chrome.runtime.sendMessage({
            action: 'CLIENT_LOG',
            data: { level, message, opts: { ...opts, url: window.location.href } }
        });
    } catch {
        // Extension context invalidated - ignore
    }
}

// --- Extension Context Validity ---
let contextInvalidated = false;

function isContextValid() {
    try {
        return !contextInvalidated && chrome.runtime && !!chrome.runtime.id;
    } catch {
        return false;
    }
}

function onContextInvalidated() {
    if (contextInvalidated) return;
    contextInvalidated = true;
    reportToBackground('info', 'Extension updated, cleaning up...', { component: 'content' });
    stopChatSync();
    bulkSyncActive = false;
    bulkSyncCancelled = true;
    // Remove injected UI elements
    if (sidebarContainer) {
        sidebarContainer.remove();
        sidebarContainer = null;
        document.body.style.marginRight = '';
    }
}

// Detect context invalidation via chrome.runtime.id polling
setInterval(() => {
    if (!contextInvalidated && !isContextValid()) {
        onContextInvalidated();
    }
}, 5000);

// Safe wrapper for chrome.runtime.sendMessage with retry for transient SW disconnects
async function safeSendMessage(message, { retries = 3, baseDelay = 500 } = {}) {
    for (let attempt = 0; attempt <= retries; attempt++) {
        if (!isContextValid()) return;
        try {
            return await chrome.runtime.sendMessage(message);
        } catch (e) {
            if (e.message?.includes('Extension context invalidated')) {
                onContextInvalidated();
                return;
            }
            // "Could not establish connection" or "Receiving end does not exist"
            // means the service worker is suspended/restarting
            const isTransient = e.message?.includes('Could not establish connection') ||
                                e.message?.includes('Receiving end does not exist');
            if (isTransient && attempt < retries) {
                const delay = baseDelay * Math.pow(2, attempt);
                reportToBackground('warn', `sendMessage failed (attempt ${attempt + 1}/${retries + 1}), retrying in ${delay}ms: ${e.message}`, { component: 'content' });
                await new Promise(r => setTimeout(r, delay));
                continue;
            }
            if (attempt >= retries) {
                reportToBackground('error', `safeSendMessage failed after ${attempt + 1} attempts: ${e.message}`, {
                    component: 'content', errorName: e?.name || e?.constructor?.name, errorStack: e?.stack
                });
            }
        }
    }
}

// --- Configuration & State ---
let isSidebarOpen = false;
let sidebarWidth = 400;
let shadowRoot = null;
let sidebarContainer = null;
let isSidebarInjecting = false; // Prevent race condition in sidebar injection
let isAutomationRunning = false; // Track if automation is running to prevent sidebar toggle
let lastSyncedMessages = new Set(); // Track already synced messages to avoid duplicates
let chatSyncInterval = null; // Interval for periodic chat syncing

// --- Bulk Sync State ---
let bulkSyncActive = false;
let bulkSyncCancelled = false;
let bulkSyncProgress = { current: 0, total: 0, synced: 0, skipped: 0, failed: 0, currentUser: '' };

// --- Chat Reply Sync ---
function isOnChatPage() {
    // Check both chat.reddit.com and reddit.com/chat/
    return window.location.hostname === 'chat.reddit.com' ||
           (window.location.hostname.includes('reddit.com') && window.location.pathname.startsWith('/chat'));
}

function isChatPanelOpen() {
    // Check for Reddit's side chat panel (appears on any page)
    // Includes both old selectors and new Reddit chat components
    const chatPanel = document.querySelector('[data-testid="chat-room"]') ||
                      document.querySelector('[class*="ChatRoom"]') ||
                      document.querySelector('[class*="chat-room"]') ||
                      document.querySelector('div[style*="chat"]') ||
                      document.querySelector('#chat-app') ||
                      document.querySelector('[class*="ChatPanel"]') ||
                      // New Reddit chat components
                      document.querySelector('rs-rooms-nav') ||
                      document.querySelector('rs-rooms-nav-room') ||
                      document.querySelector('rs-app-container') ||
                      document.querySelector('.rs-app-container');
    return !!chatPanel;
}

function hasChatElements() {
    // Check if any chat-related elements exist in DOM
    return isOnChatPage() || isChatPanelOpen();
}

async function syncChatMessages() {
    if (!isContextValid()) { stopChatSync(); return; }
    // Allow sync on dedicated chat page OR when chat panel is open on any Reddit page
    if (!isOnChatPage() && !isChatPanelOpen()) return;

    reportToBackground('debug', 'Syncing chat messages...', { component: 'content' });

    try {
        // Find all chat conversations on the page
        const conversations = extractChatConversations();

        for (const conv of conversations) {
            if (conv.messages.length === 0) continue;

            // Create a unique key for this sync batch to avoid duplicates
            const syncKey = `${conv.participantUsername}_${conv.messages.length}_${conv.messages[conv.messages.length - 1]?.content?.substring(0, 20)}`;
            if (lastSyncedMessages.has(syncKey)) continue;
            // Cap size to prevent unbounded memory growth
            if (lastSyncedMessages.size > 500) lastSyncedMessages.clear();

            // Sync to backend (uses safeSendMessage for SW disconnect resilience)
            try {
                const result = await safeSendMessage({
                    action: 'SYNC_CHAT_MESSAGES',
                    data: {
                        ...conv,
                        accountUsername: getCurrentUsername()
                    }
                });
                if (result) {
                    lastSyncedMessages.add(syncKey);
                    reportToBackground('info', `Synced conversation with ${conv.participantUsername}: ${conv.messages.length} messages`, { component: 'content' });
                }
            } catch (err) {
                reportToBackground('warn', 'Failed to sync conversation', { component: 'content', errorName: err?.name || err?.constructor?.name, errorStack: err?.stack });
            }
        }
    } catch (err) {
        reportToBackground('error', 'Chat sync error', { component: 'content', errorName: err?.name || err?.constructor?.name, errorStack: err?.stack });
    }
}

// Helper function to search through Shadow DOMs
function querySelectorDeep(selector, root = document) {
    const results = [];

    // Search in current root
    const found = root.querySelectorAll(selector);
    results.push(...found);

    // Search in all shadow roots
    const allElements = root.querySelectorAll('*');
    for (const el of allElements) {
        if (el.shadowRoot) {
            results.push(...querySelectorDeep(selector, el.shadowRoot));
        }
    }

    return results;
}

function querySelectorOneDeep(selector, root = document) {
    // Search in current root
    const found = root.querySelector(selector);
    if (found) return found;

    // Search in all shadow roots
    const allElements = root.querySelectorAll('*');
    for (const el of allElements) {
        if (el.shadowRoot) {
            const result = querySelectorOneDeep(selector, el.shadowRoot);
            if (result) return result;
        }
    }

    return null;
}

// Get all text content including from shadow DOMs
function getDeepTextContent(root = document.body) {
    let text = '';

    function traverse(node) {
        if (node.nodeType === Node.TEXT_NODE) {
            text += node.textContent + ' ';
        } else if (node.nodeType === Node.ELEMENT_NODE) {
            if (node.shadowRoot) {
                traverse(node.shadowRoot);
            }
            for (const child of node.childNodes) {
                traverse(child);
            }
        }
    }

    traverse(root);
    return text;
}

// Get the current logged-in user's username
function getCurrentUsername() {
    // PRIORITY: rs-current-user element (Reddit chat specific)
    const rsCurrentUser = document.querySelector('rs-current-user');
    if (rsCurrentUser) {
        // Check display-name attribute FIRST (this is what Reddit uses!)
        const displayName = rsCurrentUser.getAttribute('display-name');
        if (displayName && /^[a-zA-Z0-9_-]{3,20}$/.test(displayName)) {
            reportToBackground('debug', `Current user from rs-current-user display-name: ${displayName}`, { component: 'content' });
            return displayName.toLowerCase();
        }

        // Check other possible attributes
        const attrs = ['username', 'user', 'name', 'data-username', 'data-user'];
        for (const attr of attrs) {
            const val = rsCurrentUser.getAttribute(attr);
            if (val && /^[a-zA-Z0-9_-]{3,20}$/.test(val)) {
                reportToBackground('debug', `Current user from rs-current-user attr: ${val}`, { component: 'content' });
                return val.toLowerCase();
            }
        }

        // Check shadow root
        if (rsCurrentUser.shadowRoot) {
            const userEl = rsCurrentUser.shadowRoot.querySelector('a[href*="/user/"]');
            if (userEl) {
                const match = userEl.href.match(/\/user\/([^\/\?]+)/);
                if (match) {
                    reportToBackground('debug', `Current user from rs-current-user shadow: ${match[1]}`, { component: 'content' });
                    return match[1].toLowerCase();
                }
            }
        }

        // Log attributes for debugging if we still didn't find it
        reportToBackground('debug', 'rs-current-user found but username not extracted', { component: 'content' });
    }

    // Strategy 1: Reddit's user dropdown/menu (most reliable on main Reddit)
    const userDropdown = document.querySelector('[data-testid="user-dropdown-button"]');
    if (userDropdown) {
        const nameEl = userDropdown.querySelector('span');
        if (nameEl?.textContent) {
            const username = nameEl.textContent.trim();
            if (username && /^[a-zA-Z0-9_-]{3,20}$/.test(username)) {
                reportToBackground('debug', `Current user from dropdown: ${username}`, { component: 'content' });
                return username.toLowerCase();
            }
        }
    }

    // Strategy 2: Look in shreddit-app for user attribute
    const shredditApp = document.querySelector('shreddit-app');
    if (shredditApp) {
        const currentUserAttr = shredditApp.getAttribute('user') ||
                                shredditApp.getAttribute('data-user');
        if (currentUserAttr) {
            reportToBackground('debug', `Current user from shreddit-app: ${currentUserAttr}`, { component: 'content' });
            return currentUserAttr.toLowerCase();
        }
    }

    // Strategy 3: Check script tags for logged-in user data
    const scripts = document.querySelectorAll('script');
    for (const script of scripts) {
        const content = script.textContent || '';
        const usernameMatch = content.match(/"(?:username|userName|logged)":\s*"([a-zA-Z0-9_-]{3,20})"/i);
        if (usernameMatch) {
            reportToBackground('debug', `Current user from script data: ${usernameMatch[1]}`, { component: 'content' });
            return usernameMatch[1].toLowerCase();
        }
    }

    // Strategy 4: Profile link in header/navigation
    const profileLinks = document.querySelectorAll('a[href*="/user/"]');
    for (const link of profileLinks) {
        const isProfileLink = link.closest('header') ||
                             link.closest('nav') ||
                             link.classList.toString().includes('profile') ||
                             link.getAttribute('aria-label')?.toLowerCase().includes('profile');
        if (isProfileLink) {
            const match = link.href.match(/\/user\/([^\/\?]+)/);
            if (match && match[1]) {
                reportToBackground('debug', `Current user from profile link: ${match[1]}`, { component: 'content' });
                return match[1].toLowerCase();
            }
        }
    }

    // Strategy 5: Reddit's __REDDIT__ global data
    try {
        const redditData = window.__REDDIT__;
        if (redditData?.config?.user?.name) {
            reportToBackground('debug', `Current user from __REDDIT__: ${redditData.config.user.name}`, { component: 'content' });
            return redditData.config.user.name.toLowerCase();
        }
    } catch (e) {}

    // Strategy 6: Reddit's r.config (old Reddit)
    try {
        if (window.r?.config?.logged) {
            reportToBackground('debug', `Current user from r.config: ${window.r.config.logged}`, { component: 'content' });
            return window.r.config.logged.toLowerCase();
        }
    } catch (e) {}

    // Strategy 7: Check localStorage for Reddit user session data
    try {
        for (let i = 0; i < localStorage.length; i++) {
            const key = localStorage.key(i);
            if (key && (key.includes('user') || key.includes('session'))) {
                const value = localStorage.getItem(key);
                if (value) {
                    const match = value.match(/"?(?:name|username)"?\s*[:=]\s*"?([a-zA-Z0-9_-]{3,20})"?/i);
                    if (match) {
                        reportToBackground('debug', `Current user from localStorage: ${match[1]}`, { component: 'content' });
                        return match[1].toLowerCase();
                    }
                }
            }
        }
    } catch (e) {}

    // Strategy 8: In chat, messages aligned right are typically from current user
    // Find right-aligned messages and extract username
    const allMessages = querySelectorDeep('div[class*="message"]');
    for (const msg of allMessages) {
        const style = getComputedStyle(msg);
        const parent = msg.parentElement;
        const parentStyle = parent ? getComputedStyle(parent) : null;

        // Check if message is right-aligned (own message)
        const isRightAligned = style.marginLeft === 'auto' ||
                              style.alignSelf === 'flex-end' ||
                              style.justifySelf === 'flex-end' ||
                              (parentStyle && parentStyle.justifyContent === 'flex-end');

        if (isRightAligned) {
            const userLink = msg.querySelector('a[href*="/user/"]') ||
                            querySelectorOneDeep('a[href*="/user/"]', msg);
            if (userLink) {
                const match = userLink.href.match(/\/user\/([^\/\?]+)/);
                if (match && match[1]) {
                    reportToBackground('debug', `Current user from right-aligned message: ${match[1]}`, { component: 'content' });
                    return match[1].toLowerCase();
                }
            }
        }
    }

    reportToBackground('warn', 'Could not determine current username', { component: 'content' });
    return null;
}

function extractChatConversations() {
    const conversations = [];

    let participantUsername = null;

    // Get current user to filter out from participant detection
    const currentUser = getCurrentUsername();
    reportToBackground('debug', `Current logged-in user: ${currentUser}`, { component: 'content' });

    // Helper to validate participant is not current user
    const isValidParticipant = (username) => {
        if (!username) return false;
        const normalized = username.toLowerCase().trim();
        if (currentUser && normalized === currentUser) {
            reportToBackground('debug', `Skipping current user as participant: ${username}`, { component: 'content' });
            return false;
        }
        return true;
    };

    // Debug: Log available elements to help identify correct selectors
    reportToBackground('debug', 'Debugging chat DOM (with Shadow DOM support)...', { component: 'content' });

    // PRIORITY Strategy: Look for the chat room header title
    // In a DM, the header shows ONLY the other person's name, never your own
    // This is the most reliable way to get the participant
    const roomHeaderSelectors = [
        // Reddit chat room header selectors
        'rs-room-header',
        'rs-room',
        '[class*="RoomHeader"]',
        '[class*="room-header"]',
        '[class*="ChatHeader"]',
        '[class*="chat-header"]',
        '[data-testid="room-header"]',
        '[data-testid="chat-header"]',
        // Matrix-style selectors
        '[class*="mx_RoomHeader"]',
        '[class*="mx_Room"]',
    ];

    // Debug: Log what custom elements exist
    const customElements = document.querySelectorAll('*');
    const rsElements = [];
    customElements.forEach(el => {
        if (el.tagName && el.tagName.toLowerCase().startsWith('rs-')) {
            rsElements.push(el.tagName.toLowerCase());
        }
    });
    if (rsElements.length > 0) {
        reportToBackground('debug', `Found Reddit custom elements (rs-*): ${[...new Set(rsElements)]}`, { component: 'content' });
    }

    for (const selector of roomHeaderSelectors) {
        let header = document.querySelector(selector) || querySelectorOneDeep(selector);
        if (header) {
            reportToBackground('debug', `Found room header with selector: ${selector}`, { component: 'content' });

            // Check shadow root if exists
            const root = header.shadowRoot || header;

            // Debug: log shadow root contents
            if (header.shadowRoot) {
                const shadowHTML = header.shadowRoot.innerHTML?.substring(0, 500);
                reportToBackground('debug', `Shadow DOM preview: ${shadowHTML}`, { component: 'content' });
            }

            // Look for the room name/title element - try many selectors
            const titleSelectors = [
                '.room-name', '[class*="room-name"]', '[class*="roomName"]',
                '[class*="title"]', '[class*="Title"]',
                '[class*="name"]', '[class*="Name"]',
                'h1', 'h2', 'h3',
                'a[href*="/user/"]',
                '[class*="header"] span', '[class*="Header"] span',
                'span[class]', // Generic span with class
            ];

            let titleEl = null;
            for (const ts of titleSelectors) {
                titleEl = root.querySelector(ts);
                if (titleEl) {
                    reportToBackground('debug', `Found title element with selector: ${ts}`, { component: 'content' });
                    break;
                }
            }

            // Also search deeper in nested shadow DOMs
            if (!titleEl && header.shadowRoot) {
                titleEl = querySelectorOneDeep('a[href*="/user/"]', header.shadowRoot) ||
                         querySelectorOneDeep('[class*="name"]', header.shadowRoot);
            }

            if (titleEl) {
                let candidate = null;
                if (titleEl.href) {
                    const match = titleEl.href.match(/\/user\/([^\/\?]+)/);
                    if (match) candidate = match[1];
                } else {
                    candidate = titleEl.textContent?.trim();
                }

                if (candidate && /^[a-zA-Z0-9_-]{3,20}$/.test(candidate) && isValidParticipant(candidate)) {
                    participantUsername = candidate;
                    reportToBackground('debug', `Found participant from room header: ${participantUsername}`, { component: 'content' });
                    break;
                } else if (candidate && !isValidParticipant(candidate)) {
                    reportToBackground('debug', `Room header returned current user, skipping: ${candidate}`, { component: 'content' });
                }
            }
        }
    }

    // Additional priority: Look for the participant name in the page's main content area
    // The chat UI typically has a header showing "Username" with karma info like "Redditor for 2y · 6 karma"
    if (!participantUsername) {
        // Strategy A: Look for "Redditor for" text and find username near it
        const allText = getDeepTextContent(document.body);
        const redditorMatch = allText.match(/([a-zA-Z0-9_-]{3,20})\s*Redditor for/i);
        if (redditorMatch && isValidParticipant(redditorMatch[1])) {
            participantUsername = redditorMatch[1];
            reportToBackground('debug', `Found participant from "Redditor for" pattern: ${participantUsername}`, { component: 'content' });
        }

        // Strategy B: Look for elements that show user karma
        if (!participantUsername) {
            const karmaElements = querySelectorDeep('[class*="karma"], [class*="Karma"]');
            for (const karmaEl of karmaElements) {
                const container = karmaEl.closest('div') || karmaEl.parentElement;
                if (container) {
                    const userLink = container.querySelector('a[href*="/user/"]') ||
                                    container.parentElement?.querySelector('a[href*="/user/"]');
                    if (userLink) {
                        const match = userLink.href.match(/\/user\/([^\/\?]+)/);
                        if (match && match[1] && /^[a-zA-Z0-9_-]{3,20}$/.test(match[1]) && isValidParticipant(match[1])) {
                            participantUsername = match[1];
                            reportToBackground('debug', `Found participant from karma area: ${participantUsername}`, { component: 'content' });
                            break;
                        }
                    }
                }
            }
        }
    }

    // Strategy 1: Use rs-rooms-nav activeroom attribute to find the active room
    // This works on both dedicated chat page and side panel
    const roomsNav = document.querySelector('rs-rooms-nav[activeroom]');
    if (roomsNav) {
        const activeRoomId = roomsNav.getAttribute('activeroom');
        reportToBackground('debug', `Found rs-rooms-nav with activeroom: ${activeRoomId}`, { component: 'content' });

        // Find the room element with this room ID
        const activeRoom = document.querySelector(`rs-rooms-nav-room[room="${activeRoomId}"]`);
        if (activeRoom?.shadowRoot) {
            const chatLink = activeRoom.shadowRoot.querySelector('a[aria-label]');
            if (chatLink) {
                const ariaLabel = chatLink.getAttribute('aria-label');
                reportToBackground('debug', `Found aria-label from activeroom: ${ariaLabel}`, { component: 'content' });
                const match = ariaLabel?.match(/Direct chat with ([^\s]+)/i);
                if (match && isValidParticipant(match[1])) {
                    participantUsername = match[1];
                    reportToBackground('debug', `Found username from activeroom: ${participantUsername}`, { component: 'content' });
                }
            }
            if (!participantUsername) {
                const roomName = activeRoom.shadowRoot.querySelector('.room-name');
                if (roomName) {
                    const candidate = roomName.textContent?.trim();
                    if (isValidParticipant(candidate)) {
                        participantUsername = candidate;
                        reportToBackground('debug', `Found username from activeroom .room-name: ${participantUsername}`, { component: 'content' });
                    }
                }
            }
        }
    }

    // Strategy 1b: Reddit's new chat components (rs-rooms-nav-room with selected attribute)
    // The selected room has the username in its shadow DOM
    if (!participantUsername) {
        const selectedRoom = document.querySelector('rs-rooms-nav-room[selected]');
        if (selectedRoom) {
            reportToBackground('debug', 'Found selected rs-rooms-nav-room element', { component: 'content' });

            // Try to get username from aria-label on the link inside shadow root
            if (selectedRoom.shadowRoot) {
                const chatLink = selectedRoom.shadowRoot.querySelector('a[aria-label]');
                if (chatLink) {
                    const ariaLabel = chatLink.getAttribute('aria-label');
                    reportToBackground('debug', `Found aria-label: ${ariaLabel}`, { component: 'content' });
                    // Pattern: "Direct chat with {username}"
                    const match = ariaLabel.match(/Direct chat with ([^\s]+)/i);
                    if (match && isValidParticipant(match[1])) {
                        participantUsername = match[1];
                        reportToBackground('debug', `Found username from aria-label: ${participantUsername}`, { component: 'content' });
                    }
                }

                // Fallback: Get from .room-name span
                if (!participantUsername) {
                    const roomName = selectedRoom.shadowRoot.querySelector('.room-name');
                    if (roomName) {
                        const candidate = roomName.textContent?.trim();
                        if (isValidParticipant(candidate)) {
                            participantUsername = candidate;
                            reportToBackground('debug', `Found username from .room-name: ${participantUsername}`, { component: 'content' });
                        }
                    }
                }
            }
        }
    }

    // Strategy 1b: Find any rs-rooms-nav-room and check for selected or first one
    if (!participantUsername) {
        const allRooms = document.querySelectorAll('rs-rooms-nav-room');
        reportToBackground('debug', `Found ${allRooms.length} rs-rooms-nav-room elements`, { component: 'content' });

        for (const room of allRooms) {
            if (room.shadowRoot) {
                // Check if this is the currently selected room or just get first one
                const chatLink = room.shadowRoot.querySelector('a[aria-label]');
                if (chatLink) {
                    const ariaLabel = chatLink.getAttribute('aria-label');
                    const match = ariaLabel?.match(/Direct chat with ([^\s]+)/i);
                    if (match && isValidParticipant(match[1])) {
                        // Check if this room is selected (has 'selected' class or attribute)
                        const isSelected = room.hasAttribute('selected') ||
                                          chatLink.classList.contains('selected') ||
                                          room.shadowRoot.querySelector('.selected');
                        if (isSelected) {
                            participantUsername = match[1];
                            reportToBackground('debug', `Found username from rs-rooms-nav-room (selected): ${participantUsername}`, { component: 'content' });
                            break;
                        }
                    }
                }
            }
        }
    }

    // Strategy 1c: URL-based detection for room pages
    // URLs like /room/!f_mXurYu_FsHGxStMrHIfiPcUxcRtmelcIlf3H-DwmU%3Areddit.com
    if (!participantUsername) {
        const roomUrlMatch = window.location.href.match(/\/room\/([^\/\?]+)/);
        if (roomUrlMatch) {
            reportToBackground('debug', `Found room ID in URL: ${roomUrlMatch[1]}`, { component: 'content' });
            const roomId = decodeURIComponent(roomUrlMatch[1]);
            // Find the matching room in the nav by room attribute
            const matchingRoom = document.querySelector(`rs-rooms-nav-room[room="${roomId}"]`);
            if (matchingRoom?.shadowRoot) {
                const chatLink = matchingRoom.shadowRoot.querySelector('a[aria-label]');
                if (chatLink) {
                    const ariaLabel = chatLink.getAttribute('aria-label');
                    const match = ariaLabel?.match(/Direct chat with ([^\s]+)/i);
                    if (match && isValidParticipant(match[1])) {
                        participantUsername = match[1];
                        reportToBackground('debug', `Found username from room URL match: ${participantUsername}`, { component: 'content' });
                    }
                }
                // Try .room-name as fallback
                if (!participantUsername) {
                    const roomName = matchingRoom.shadowRoot.querySelector('.room-name');
                    if (roomName) {
                        const candidate = roomName.textContent?.trim();
                        if (isValidParticipant(candidate)) {
                            participantUsername = candidate;
                            reportToBackground('debug', `Found username from .room-name (URL match): ${participantUsername}`, { component: 'content' });
                        }
                    }
                }
            }
        }
    }

    // Strategy 1d: URL-based detection (channel format)
    const urlMatch = window.location.href.match(/\/channel\/(\d+_\d+)/);
    if (urlMatch) {
        reportToBackground('debug', `Found channel ID in URL: ${urlMatch[1]}`, { component: 'content' });
    }

    // Strategy 2: Look for the conversation header/title area (with Shadow DOM support)
    // Reddit's new chat uses various header patterns inside shadow roots
    const headerSelectors = [
        '[data-testid="conversation-header"]',
        '[data-testid="room-header"]',
        '[class*="ChatHeader"]',
        '[class*="chat-header"]',
        '[class*="RoomHeader"]',
        '[class*="ConversationHeader"]',
        'header[class*="chat"]',
        // New Reddit Shreddit chat selectors
        '[class*="DirectMessage"] header',
        '[class*="ThreadHeader"]',
        '[class*="ChannelHeader"]',
        'div[class*="header"] h1',
        'div[class*="header"] h2',
        // Reddit Matrix chat selectors
        '[class*="mx_RoomHeader"]',
        '[class*="mx_RoomTile_name"]',
        '[class*="room-header"]',
        '[class*="room_header"]',
    ];

    for (const selector of headerSelectors) {
        // Search in regular DOM and all shadow roots
        const header = querySelectorOneDeep(selector);
        if (header) {
            reportToBackground('debug', `Found header with selector: ${selector} Content: ${header.textContent?.substring(0, 100)}`, { component: 'content' });

            // Look for username link (also search in shadow DOM)
            const usernameLink = header.querySelector('a[href*="/user/"]') || querySelectorOneDeep('a[href*="/user/"]', header);
            if (usernameLink) {
                const match = usernameLink.href.match(/\/user\/([^\/\?]+)/);
                if (match && isValidParticipant(match[1])) {
                    participantUsername = match[1];
                    reportToBackground('debug', `Found username from link: ${participantUsername}`, { component: 'content' });
                    break;
                }
            }

            // Check for u/username pattern in text
            const headerText = header.textContent;
            const uMatch = headerText.match(/u\/(\w+)/);
            if (uMatch && isValidParticipant(uMatch[1])) {
                participantUsername = uMatch[1];
                reportToBackground('debug', `Found username from u/ pattern: ${participantUsername}`, { component: 'content' });
                break;
            }

            // Check for plain username (often the header just shows the username)
            // Look for text that looks like a username (alphanumeric, underscores, hyphens)
            const cleanText = header.textContent?.trim();
            if (cleanText && /^[a-zA-Z0-9_-]{3,20}$/.test(cleanText) && isValidParticipant(cleanText)) {
                participantUsername = cleanText;
                reportToBackground('debug', `Found username from header text: ${participantUsername}`, { component: 'content' });
                break;
            }
        }
    }

    // Strategy 2b: Look for user links, but prioritize finding the PARTICIPANT
    // In a DM, there are 2 users. We need to find the OTHER person.
    if (!participantUsername) {
        const allUserLinks = querySelectorDeep('a[href*="/user/"]');
        reportToBackground('debug', `Found ${allUserLinks.length} user links in DOM (including shadow)`, { component: 'content' });

        // Collect all unique usernames
        const usernames = new Set();
        for (const link of allUserLinks) {
            const match = link.href.match(/\/user\/([^\/\?]+)/);
            if (match && match[1] && match[1].length >= 3 && match[1].length <= 20) {
                if (!['preferences', 'settings', 'me', 'undefined'].includes(match[1].toLowerCase())) {
                    usernames.add(match[1].toLowerCase());
                }
            }
        }

        reportToBackground('debug', `Unique usernames found: ${[...usernames]}`, { component: 'content' });

        // If we found exactly 2 usernames in a DM, and we know currentUser, use the other one
        if (usernames.size === 2 && currentUser) {
            for (const username of usernames) {
                if (username !== currentUser) {
                    participantUsername = username;
                    reportToBackground('debug', `Found participant by elimination (2 users, excluding current): ${participantUsername}`, { component: 'content' });
                    break;
                }
            }
        }

        // If we still don't have participant, try to find user link in message area (not navigation)
        if (!participantUsername) {
            for (const link of allUserLinks) {
                const match = link.href.match(/\/user\/([^\/\?]+)/);
                if (match && match[1] && match[1].length >= 3 && match[1].length <= 20) {
                    // Skip if it's in navigation/header (likely current user's profile)
                    const isInNav = link.closest('nav') || link.closest('header') ||
                                   link.closest('[class*="nav"]') || link.closest('[class*="sidebar"]');
                    if (!isInNav) {
                        const username = match[1].toLowerCase();
                        if (!['preferences', 'settings', 'me', 'undefined'].includes(username) && isValidParticipant(username)) {
                            participantUsername = username;
                            reportToBackground('debug', `Found username from user link (not in nav): ${participantUsername}`, { component: 'content' });
                            break;
                        }
                    }
                }
            }
        }
    }

    // Strategy 3: Page title parsing
    if (!participantUsername) {
        const title = document.title;
        reportToBackground('debug', `Page title: ${title}`, { component: 'content' });

        // Various title patterns Reddit might use
        const titlePatterns = [
            /(?:Chat with |Messages? - |@)(\w+)/i,
            /^(\w+) - Reddit Chat/i,
            /^(\w+) \| Reddit/i,
            /Reddit Chat - (\w+)/i,
        ];

        for (const pattern of titlePatterns) {
            const titleMatch = title.match(pattern);
            if (titleMatch && isValidParticipant(titleMatch[1])) {
                participantUsername = titleMatch[1];
                reportToBackground('debug', `Found username from title: ${participantUsername}`, { component: 'content' });
                break;
            }
        }
    }

    // Strategy 4: URL patterns
    if (!participantUsername) {
        const userMatch = window.location.href.match(/\/user\/([^\/\?]+)/);
        if (userMatch && isValidParticipant(userMatch[1])) {
            participantUsername = userMatch[1];
            reportToBackground('debug', `Found username from URL: ${participantUsername}`, { component: 'content' });
        }
    }

    // Strategy 5: Find username elements in the chat UI (with Shadow DOM support)
    if (!participantUsername) {
        // Look for various username display patterns
        const usernameSelectors = [
            'a[href*="/user/"]',
            '[class*="username"]',
            '[class*="Username"]',
            '[class*="author"]',
            '[class*="Author"]',
            '[class*="participant"]',
            '[class*="Participant"]',
            '[data-testid*="user"]',
            '[data-testid*="author"]',
            // Avatar/profile elements often have username nearby
            '[class*="Avatar"] + span',
            '[class*="avatar"] ~ span',
            // Reddit Matrix chat specific
            '[class*="mx_Username"]',
            '[class*="mx_DisambiguatedProfile"]',
            '[class*="mx_BaseAvatar"]',
        ];

        for (const selector of usernameSelectors) {
            // Use deep query to search shadow DOMs
            const elements = querySelectorDeep(selector);
            for (const el of elements) {
                let username = null;
                if (el.href) {
                    const match = el.href.match(/\/user\/([^\/\?]+)/);
                    if (match) username = match[1];
                } else {
                    username = el.textContent?.trim()?.replace(/^u\//, '');
                }

                // Skip if it's the current user, common UI text, or too short/long
                if (username &&
                    isValidParticipant(username) &&
                    username !== 'me' &&
                    username.length >= 3 &&
                    username.length <= 20 &&
                    /^[a-zA-Z0-9_-]+$/.test(username) &&
                    !['user', 'profile', 'settings', 'chat', 'message', 'send', 'reddit', 'inbox'].includes(username.toLowerCase())) {
                    participantUsername = username;
                    reportToBackground('debug', `Found username from element: ${participantUsername} Selector: ${selector}`, { component: 'content' });
                    break;
                }
            }
            if (participantUsername) break;
        }
    }

    // Strategy 6: Look in the active/selected conversation in sidebar
    if (!participantUsername) {
        const activeConversation = document.querySelector('[class*="active"][class*="conversation"], [class*="selected"][class*="conversation"], [aria-selected="true"]');
        if (activeConversation) {
            const usernameEl = activeConversation.querySelector('a[href*="/user/"], [class*="username"]');
            if (usernameEl) {
                const match = usernameEl.href?.match(/\/user\/([^\/\?]+)/) ||
                             usernameEl.textContent?.match(/^u\/(\w+)$|^(\w+)$/);
                if (match) {
                    const candidate = match[1] || match[2];
                    if (isValidParticipant(candidate)) {
                        participantUsername = candidate;
                        reportToBackground('debug', `Found username from active conversation: ${participantUsername}`, { component: 'content' });
                    }
                }
            }
        }
    }

    // Debug: If still not found, log what we can see
    if (!participantUsername) {
        reportToBackground('warn', 'Could not determine chat participant', { component: 'content' });

        // Log user links from both regular DOM and shadow DOMs
        const regularUserLinks = Array.from(document.querySelectorAll('a[href*="/user/"]')).map(a => a.href);
        const deepUserLinks = querySelectorDeep('a[href*="/user/"]').map(a => a.href);
        reportToBackground('debug', `User links in regular DOM: ${JSON.stringify(regularUserLinks.slice(0, 5))}`, { component: 'content' });
        reportToBackground('debug', `User links in shadow DOM: ${JSON.stringify(deepUserLinks.filter(l => !regularUserLinks.includes(l)).slice(0, 5))}`, { component: 'content' });

        // Check for shadow roots
        const shadowHostCount = document.querySelectorAll('*').length;
        let shadowRootCount = 0;
        document.querySelectorAll('*').forEach(el => { if (el.shadowRoot) shadowRootCount++; });
        reportToBackground('debug', `Elements with shadow roots: ${shadowRootCount} out of ${shadowHostCount} elements`, { component: 'content' });

        // Log elements with "username" class from shadow DOM
        const usernameElements = querySelectorDeep('[class*="username"], [class*="Username"], [class*="mx_"]');
        reportToBackground('debug', `Username-related elements (including shadow DOM): ${usernameElements.length}`, { component: 'content' });
        usernameElements.slice(0, 5).forEach(el => {
            reportToBackground('debug', `  - ${el.tagName} ${el.className} text: ${el.textContent?.substring(0, 30)}`, { component: 'content' });
        });

        reportToBackground('debug', `Page URL: ${window.location.href}`, { component: 'content' });

        // Last resort: try to get any visible username-like text from the header area
        const possibleHeaders = querySelectorDeep('h1, h2, h3, [role="heading"]');
        possibleHeaders.forEach(h => {
            const text = h.textContent?.trim();
            if (text && /^[a-zA-Z0-9_-]{3,20}$/.test(text)) {
                reportToBackground('debug', `Possible username in heading: ${text}`, { component: 'content' });
            }
        });

        // Try to extract username from page text as last resort
        const pageText = getDeepTextContent(document.body);
        const usernameMatches = pageText.match(/u\/([a-zA-Z0-9_-]{3,20})/g);
        if (usernameMatches && usernameMatches.length > 0) {
            reportToBackground('debug', `Found u/username patterns in page text: ${[...new Set(usernameMatches)].slice(0, 5)}`, { component: 'content' });
            // Try to use the first non-common username that isn't the current user
            for (const match of usernameMatches) {
                const username = match.replace('u/', '');
                if (!['me', 'user', 'reddit', 'admin'].includes(username.toLowerCase()) && isValidParticipant(username)) {
                    participantUsername = username;
                    reportToBackground('debug', `Found username from page text: ${participantUsername}`, { component: 'content' });
                    break;
                }
            }
        }

        if (!participantUsername) {
            return conversations;
        }
    }

    reportToBackground('info', `Chat participant: ${participantUsername}`, { component: 'content' });

    // Extract messages
    const messages = extractMessagesFromDOM(participantUsername);

    if (messages.length > 0) {
        conversations.push({
            participantUsername,
            messages
        });
    }

    return conversations;
}

function extractMessagesFromDOM(participantUsername) {
    const messages = [];
    const seenContent = new Set(); // Avoid duplicates

    // Try multiple strategies to find messages (with Shadow DOM support)

    // Strategy 1: Find the chat/message container first (search shadow DOMs too)
    // NOTE: Order matters - more specific selectors first to avoid matching single messages
    const containerSelectors = [
        // Reddit's rs-room component (the main chat room element)
        'rs-room',
        '[data-testid="chat-room"]',
        '[data-testid="message-list"]',
        '[class*="ChatRoom"]',
        '[class*="MessageList"]',
        '[class*="chat-messages"]',
        '[role="log"]', // Accessibility role for chat
        '[class*="Thread"]',
        // Reddit Matrix chat selectors
        '[class*="mx_RoomView_body"]',
        '[class*="mx_MessagePanel"]',
        '[class*="mx_RoomView_MessageList"]',
        '[class*="mx_ScrollPanel"]',
        // Generic room container - but NOT single messages
        'div[class*="room"]:not([class*="room-message"])',
        '[class*="room-timeline"]',
        '[class*="timeline"]',
    ];

    let chatContainer = null;
    for (const selector of containerSelectors) {
        // Try regular DOM first
        chatContainer = document.querySelector(selector);
        if (chatContainer) {
            reportToBackground('debug', `Found chat container with selector: ${selector}`, { component: 'content' });
            break;
        }
        // Try shadow DOM
        chatContainer = querySelectorOneDeep(selector);
        if (chatContainer) {
            reportToBackground('debug', `Found chat container in shadow DOM with selector: ${selector}`, { component: 'content' });
            break;
        }
    }

    if (!chatContainer) {
        reportToBackground('debug', 'Could not find chat container, trying to find messages directly...', { component: 'content' });
        // Fall back to finding messages anywhere in the page
    } else {
        // Debug: Show what's inside the chat container
        reportToBackground('debug', `Chat container tag: ${chatContainer.tagName} classes: ${chatContainer.className}`, { component: 'content' });

        // Look for nested shadow roots (Reddit uses many layers)
        const childrenWithShadow = [];
        chatContainer.querySelectorAll('*').forEach(el => {
            if (el.shadowRoot) {
                childrenWithShadow.push(el.tagName.toLowerCase());
            }
        });
        if (childrenWithShadow.length > 0) {
            reportToBackground('debug', `Elements with shadow roots inside container: ${[...new Set(childrenWithShadow)]}`, { component: 'content' });
        }

        // Try to find the actual timeline/events container
        const timelineSelectors = [
            'rs-room-timeline',
            'rs-timeline',
            '[class*="timeline"]',
            '[class*="Timeline"]',
            '[class*="event-list"]',
            '[class*="EventList"]',
            '[role="list"]',
            '[class*="ScrollPanel"]',
        ];

        for (const ts of timelineSelectors) {
            const timeline = chatContainer.querySelector(ts) || querySelectorOneDeep(ts, chatContainer);
            if (timeline) {
                reportToBackground('debug', `Found timeline element: ${ts} tag: ${timeline.tagName}`, { component: 'content' });
                // Use this as the search root for messages
                if (timeline.shadowRoot) {
                    reportToBackground('debug', 'Timeline has shadow root, searching inside...', { component: 'content' });
                }
            }
        }
    }

    // Strategy 2: Find message elements within container (with Shadow DOM support)
    const messageSelectors = [
        // Reddit's rs-* custom elements for events/messages
        'rs-timeline-event',  // Main event wrapper in Reddit chat
        'rs-event',
        'rs-message',
        'rs-text-message',
        'rs-room-event',
        // Room message elements (the actual message bubbles)
        '.room-message',
        'div.room-message',
        // Matrix event tiles
        '[class*="mx_EventTile"]',
        '[class*="mx_EventTile_body"]',
        '[class*="mx_MTextBody"]',
        // Reddit room timeline events
        '[class*="timeline-event"]',
        '[class*="TimelineEvent"]',
        '[class*="event-tile"]',
        '[class*="EventTile"]',
        // Standard message selectors
        '[data-testid="message"]',
        '[class*="Message_container"]',
        '[class*="message-container"]',
        '[class*="ChatMessage"]',
        // Role-based selectors
        '[role="listitem"]',
        '[role="article"]',
        // Generic message selectors - lower priority
        'div[class*="message"]:not([class*="messages"]):not([class*="room-message"])',
        'article[class*="message"]',
        '[class*="bubble"]',
    ];

    let messageElements = [];
    const searchRoot = chatContainer || document.body;

    // If searchRoot is a custom element with shadow DOM, search inside its shadow root
    const actualSearchRoot = searchRoot.shadowRoot || searchRoot;
    reportToBackground('debug', `Searching for messages in: ${searchRoot.tagName}, has shadowRoot: ${!!searchRoot.shadowRoot}`, { component: 'content' });

    for (const selector of messageSelectors) {
        // Try regular DOM first
        let elements = actualSearchRoot.querySelectorAll(selector);
        if (elements.length === 0 && searchRoot.shadowRoot) {
            // Search deeper in nested shadow DOMs
            elements = querySelectorDeep(selector, searchRoot.shadowRoot);
        }
        if (elements.length === 0) {
            // Try from the original searchRoot with deep search
            elements = querySelectorDeep(selector, searchRoot);
        }
        if (elements.length > 0) {
            messageElements = Array.from(elements);
            reportToBackground('debug', `Found ${elements.length} messages with selector: ${selector}`, { component: 'content' });
            break;
        }
    }

    // Fallback: Try to find any elements that look like messages
    if (messageElements.length === 0 && chatContainer) {
        // Search in shadow root if available
        const fallbackRoot = chatContainer.shadowRoot || chatContainer;
        const allDivs = querySelectorDeep('div', fallbackRoot);
        reportToBackground('debug', `Fallback: found ${allDivs.length} divs in container`, { component: 'content' });

        messageElements = Array.from(allDivs).filter(div => {
            const text = div.textContent?.trim();
            // Messages typically have some text and aren't too long (not containers)
            // Also check for message-related classes
            const hasMessageClass = div.className?.includes('message') || div.className?.includes('room-message');
            return text && text.length > 10 && text.length < 2000 &&
                   (div.children.length < 10 || hasMessageClass);
        });
        reportToBackground('debug', `Fallback: ${messageElements.length} potential message elements after filtering`, { component: 'content' });
    }

    // Extract message data
    reportToBackground('debug', `Processing ${messageElements.length} message elements...`, { component: 'content' });
    const cachedCurrentUsername = getCurrentUsername();
    messageElements.forEach((el, index) => {
        // Get message content - try multiple approaches
        let content = '';

        // For custom elements like rs-timeline-event, content is inside their shadow DOM
        const searchRoot = el.shadowRoot || el;

        // Try to find the actual text content element - search in shadow root if available
        let textEl = searchRoot.querySelector('[class*="message-body"]') ||
                     searchRoot.querySelector('[class*="message-text"]') ||
                     searchRoot.querySelector('[class*="room-message-body"]') ||
                     searchRoot.querySelector('[class*="content"]') ||
                     searchRoot.querySelector('[class*="text"]') ||
                     searchRoot.querySelector('[class*="body"]') ||
                     searchRoot.querySelector('p');

        // If not found in direct shadow root, search deeper
        if (!textEl && el.shadowRoot) {
            textEl = querySelectorOneDeep('[class*="message"]', el.shadowRoot) ||
                     querySelectorOneDeep('[class*="body"]', el.shadowRoot) ||
                     querySelectorOneDeep('p', el.shadowRoot);
        }

        // If still not found, try getDeepTextContent on the element
        if (!textEl) {
            content = getDeepTextContent(el);
        } else {
            content = textEl.textContent?.trim() || '';
        }

        // Strip leading timestamps that get merged into content from DOM extraction
        // e.g. "1:51 PM hey i need your help" → "hey i need your help"
        content = content.replace(/^\d{1,2}:\d{2}\s*(AM|PM)\s+/i, '').trim();

        // Debug: show what we found
        reportToBackground('debug', `  [${index}] Element: ${el.tagName}, hasShadow: ${!!el.shadowRoot}`, { component: 'content' });
        reportToBackground('debug', `  [${index}] Content preview: "${content?.substring(0, 60)}..."`, { component: 'content' });

        // Skip if no content, too short, or already seen
        if (!content || content.length < 2 || content.length > 5000) {
            reportToBackground('debug', `  [${index}] Skipped: content length ${content?.length || 0}`, { component: 'content' });
            return;
        }
        if (seenContent.has(content)) {
            reportToBackground('debug', `  [${index}] Skipped: duplicate content`, { component: 'content' });
            return;
        }

        // Skip UI elements (buttons, timestamps alone, etc.)
        if (content.match(/^(Send|Reply|Edit|Delete|Cancel|Save|\d{1,2}:\d{2}|Today|Yesterday)$/i)) {
            reportToBackground('debug', `  [${index}] Skipped: UI element`, { component: 'content' });
            return;
        }

        // Skip content that's exactly the current user's name or participant name (UI headers)
        if (cachedCurrentUsername && content.toLowerCase() === cachedCurrentUsername.toLowerCase()) {
            reportToBackground('debug', `  [${index}] Skipped: current user name`, { component: 'content' });
            return;
        }

        seenContent.add(content);
        reportToBackground('debug', `  [${index}] Accepted message`, { component: 'content' });

        // Determine direction (outbound = sent by user, inbound = received)
        // For Reddit's rs-timeline-event, we need to look inside Shadow DOM for author
        let isOutbound = false;
        const currentUser = cachedCurrentUsername;

        // Debug: Log Shadow DOM inner HTML structure (first 500 chars)
        if (el.shadowRoot) {
            const shadowHTML = el.shadowRoot.innerHTML?.substring(0, 500) || '';
            reportToBackground('debug', `  [${index}] Shadow DOM preview: ${shadowHTML}...`, { component: 'content' });
        }

        // Method 1: Find span.user-name element inside Shadow DOM
        let authorEl = null;
        let authorName = '';

        if (el.shadowRoot) {
            // Priority 1: Look for span.user-name (most reliable)
            authorEl = querySelectorOneDeep('span.user-name', el.shadowRoot) ||
                      querySelectorOneDeep('.user-name', el.shadowRoot) ||
                      querySelectorOneDeep('[class*="user-name"]', el.shadowRoot);

            // Priority 2: Try user links
            if (!authorEl) {
                authorEl = querySelectorOneDeep('a[href*="/user/"]', el.shadowRoot) ||
                          querySelectorOneDeep('[class*="author"]', el.shadowRoot) ||
                          querySelectorOneDeep('[class*="sender"]', el.shadowRoot);
            }
        }

        // Also try direct search if deep search failed
        if (!authorEl) {
            const authorSearchRoot = el.shadowRoot || el;
            authorEl = authorSearchRoot.querySelector('span.user-name') ||
                      authorSearchRoot.querySelector('.user-name') ||
                      authorSearchRoot.querySelector('a[href*="/user/"]');
        }

        if (authorEl) {
            // Extract username from href if it's a link, otherwise get text content
            if (authorEl.href && authorEl.href.includes('/user/')) {
                const match = authorEl.href.match(/\/user\/([^\/\?]+)/);
                authorName = match ? match[1].toLowerCase() : '';
            }
            if (!authorName) {
                authorName = authorEl.textContent?.trim().replace(/^u\//, '').toLowerCase() || '';
            }
            reportToBackground('debug', `  [${index}] Author found from .user-name: "${authorName}", currentUser: "${currentUser}"`, { component: 'content' });
            if (currentUser && authorName === currentUser.toLowerCase()) {
                isOutbound = true;
            }
        } else {
            reportToBackground('debug', `  [${index}] No author element found in Shadow DOM`, { component: 'content' });
        }

        // Method 2: Check element attributes
        if (!isOutbound) {
            const elAttrs = Array.from(el.attributes || []).map(a => `${a.name}=${a.value}`).join(', ');
            reportToBackground('debug', `  [${index}] Element attrs: ${elAttrs}`, { component: 'content' });

            isOutbound = el.getAttribute('data-is-own') === 'true' ||
                        el.getAttribute('data-sender') === currentUser ||
                        el.classList.toString().toLowerCase().includes('own') ||
                        el.classList.toString().toLowerCase().includes('self') ||
                        el.classList.toString().toLowerCase().includes('sent') ||
                        el.classList.toString().toLowerCase().includes('outgoing');
        }

        // Method 3: Check inside Shadow DOM for 'own' or 'self' classes (deep search)
        if (!isOutbound && el.shadowRoot) {
            const innerContainer = querySelectorOneDeep('[class*="own"]', el.shadowRoot) ||
                                  querySelectorOneDeep('[class*="self"]', el.shadowRoot) ||
                                  querySelectorOneDeep('[class*="outgoing"]', el.shadowRoot) ||
                                  querySelectorOneDeep('[class*="local"]', el.shadowRoot) ||
                                  querySelectorOneDeep('[class*="mine"]', el.shadowRoot);
            if (innerContainer) {
                isOutbound = true;
                reportToBackground('debug', `  [${index}] Found own/self/local class inside Shadow DOM: ${innerContainer.className}`, { component: 'content' });
            }
        }

        reportToBackground('debug', `  [${index}] Direction: ${isOutbound ? 'outbound' : 'inbound'}`, { component: 'content' });

        // Try to get timestamp - search in Shadow DOM first
        const timeSearchRoot = el.shadowRoot || el;
        let timeEl = timeSearchRoot.querySelector('time') ||
                    timeSearchRoot.querySelector('[class*="time"]') ||
                    timeSearchRoot.querySelector('[class*="timestamp"]') ||
                    timeSearchRoot.querySelector('[datetime]');

        // If not found, search deeper in Shadow DOM
        if (!timeEl && el.shadowRoot) {
            timeEl = querySelectorOneDeep('time', el.shadowRoot) ||
                    querySelectorOneDeep('[datetime]', el.shadowRoot);
        }

        const sentAt = timeEl?.getAttribute('datetime') ||
                      timeEl?.getAttribute('title') ||
                      timeEl?.textContent?.trim() ||
                      new Date().toISOString();

        reportToBackground('debug', `  [${index}] Timestamp: ${sentAt}`, { component: 'content' });

        messages.push({
            direction: isOutbound ? 'outbound' : 'inbound',
            content: content,
            sentAt: sentAt,
            isAiGenerated: false
        });
    });

    reportToBackground('debug', `Extracted ${messages.length} messages`, { component: 'content' });

    // TEXT-BASED FALLBACK: If no messages were found via DOM selectors,
    // try parsing the visible text from the chat area.
    // Reddit's Shadow DOM can be opaque — this catches messages the selectors miss.
    if (messages.length === 0 && chatContainer) {
        reportToBackground('debug', 'Attempting text-based fallback extraction...', { component: 'content' });
        const rawText = getDeepTextContent(chatContainer);
        const currentUser = getCurrentUsername();

        // Split text into lines and look for message-like content
        const lines = rawText.split(/\n/).map(l => l.trim()).filter(l => l.length > 0);
        let lastAuthor = null;

        for (const line of lines) {
            // Skip very short or very long lines
            if (line.length < 3 || line.length > 5000) continue;

            // Skip lines that are just timestamps like "2:32 AM", "Today", "Yesterday"
            if (/^\d{1,2}:\d{2}\s*(AM|PM)?$/i.test(line)) continue;
            if (/^(Today|Yesterday|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)$/i.test(line)) continue;

            // Skip common UI text
            if (/^(Send|Reply|Edit|Delete|Cancel|Save|Message|Chat|Type a message|Write)$/i.test(line)) continue;

            // Detect author lines (username-only lines often precede messages)
            if (/^[a-zA-Z0-9_-]{3,20}$/.test(line)) {
                lastAuthor = line.toLowerCase();
                continue;
            }

            // Skip lines that are just the participant or current user name
            if (line.toLowerCase() === participantUsername?.toLowerCase()) continue;
            if (currentUser && line.toLowerCase() === currentUser) continue;

            // Strip leading timestamps merged into content
            const cleanLine = line.replace(/^\d{1,2}:\d{2}\s*(AM|PM)\s+/i, '').trim();
            if (!cleanLine || cleanLine.length < 2) continue;

            // This looks like a message — deduplicate
            if (seenContent.has(cleanLine)) continue;
            seenContent.add(cleanLine);

            const isOutbound = currentUser && lastAuthor === currentUser;
            messages.push({
                direction: isOutbound ? 'outbound' : 'inbound',
                content: cleanLine,
                sentAt: new Date().toISOString(),
                isAiGenerated: false
            });
        }

        if (messages.length > 0) {
            reportToBackground('debug', `Text fallback extracted ${messages.length} messages`, { component: 'content' });
        }
    }

    reportToBackground('debug', `Total extracted: ${messages.length} messages`, { component: 'content' });
    return messages;
}

function startChatSync() {
    if (chatSyncInterval) return; // Already running

    reportToBackground('info', 'Starting chat sync monitoring...', { component: 'content' });

    // Track last synced room to detect room changes
    let lastSyncedRoomId = null;
    let syncDebounceTimer = null;

    // Debounced sync function to avoid multiple rapid syncs
    const debouncedSync = (reason = 'unknown') => {
        if (syncDebounceTimer) clearTimeout(syncDebounceTimer);
        syncDebounceTimer = setTimeout(() => {
            if (hasChatElements()) {
                // Extract current room ID from URL
                const urlMatch = location.href.match(/\/chat\/room\/([^\/\?]+)/);
                const currentRoomId = urlMatch ? urlMatch[1] : null;

                // Only sync if room changed or it's been a while
                if (currentRoomId !== lastSyncedRoomId || reason === 'periodic') {
                    reportToBackground('debug', `Syncing chat (${reason})...`, { component: 'content' });
                    lastSyncedRoomId = currentRoomId;
                    syncChatMessages();
                }
            }
        }, 1000); // 1 second debounce
    };

    // Function to check and sync if chat is visible
    const checkAndSync = () => {
        if (hasChatElements()) {
            reportToBackground('debug', 'Chat detected, syncing...', { component: 'content' });
            syncChatMessages();
        }
    };

    // Initial check after page load
    setTimeout(checkAndSync, 2000);

    // Periodic sync every 30 seconds
    chatSyncInterval = setInterval(() => debouncedSync('periodic'), 30000);

    // Watch for chat panel opening (DOM mutations)
    const chatObserver = new MutationObserver((mutations) => {
        // Check if chat elements were added
        for (const mutation of mutations) {
            if (mutation.addedNodes.length > 0) {
                // Small delay to let chat fully render
                setTimeout(() => {
                    if (hasChatElements()) {
                        reportToBackground('debug', 'Chat panel opened, syncing...', { component: 'content' });
                        syncChatMessages();
                    }
                }, 1500);
                break;
            }
        }
    });

    // Observe body for chat panel additions
    chatObserver.observe(document.body, {
        childList: true,
        subtree: true
    });

    // Also sync on visibility change (when user switches back to tab)
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible' && hasChatElements()) {
            syncChatMessages();
        }
    });

    // Sync on URL changes (for SPAs)
    let lastUrl = location.href;
    new MutationObserver(() => {
        if (location.href !== lastUrl) {
            lastUrl = location.href;
            reportToBackground('debug', 'URL changed, triggering sync...', { component: 'content' });
            debouncedSync('url-change');
        }
    }).observe(document, { subtree: true, childList: true });

    // Listen for History API navigation (pushState/replaceState)
    const originalPushState = history.pushState;
    const originalReplaceState = history.replaceState;

    history.pushState = function(...args) {
        originalPushState.apply(this, args);
        if (isContextValid()) debouncedSync('pushstate');
    };

    history.replaceState = function(...args) {
        originalReplaceState.apply(this, args);
        if (isContextValid()) debouncedSync('replacestate');
    };

    // Listen for popstate (back/forward buttons)
    window.addEventListener('popstate', () => {
        reportToBackground('debug', 'popstate navigation detected', { component: 'content' });
        debouncedSync('popstate');
    });

    // Click listener for chat-related clicks
    document.addEventListener('click', (e) => {
        const target = e.target;

        // Check if click is on a chat room element or inside chat area
        const isChatClick =
            target.closest('rs-rooms-nav-room') ||
            target.closest('rs-room') ||
            target.closest('[class*="room"]') ||
            target.closest('[class*="chat"]') ||
            target.closest('[class*="conversation"]') ||
            target.closest('a[href*="/chat/"]') ||
            (target.tagName === 'A' && target.href?.includes('/chat/'));

        if (isChatClick) {
            reportToBackground('debug', 'Chat click detected, will sync...', { component: 'content' });
            debouncedSync('click');
        }
    }, true); // Use capture phase to catch clicks early
}

function stopChatSync() {
    if (chatSyncInterval) {
        clearInterval(chatSyncInterval);
        chatSyncInterval = null;
    }
}

// --- Bulk Sync All Chats ---

// Enumerate all chat entries in the sidebar
function getAllSidebarRooms() {
    const rooms = [];
    const seen = new Set(); // Avoid duplicate usernames

    // Strategy 1: rs-rooms-nav-room elements (Reddit chat web components)
    const roomElements = document.querySelectorAll('rs-rooms-nav-room');
    reportToBackground('debug', `[BulkSync] Found ${roomElements.length} rs-rooms-nav-room elements`, { component: 'content' });

    for (const room of roomElements) {
        let username = null;
        let clickable = null;

        if (room.shadowRoot) {
            const chatLink = room.shadowRoot.querySelector('a[aria-label]');
            if (chatLink) {
                const ariaLabel = chatLink.getAttribute('aria-label') || '';
                const match = ariaLabel.match(/Direct chat with (\S+)/i);
                if (match) {
                    username = match[1];
                    clickable = chatLink;
                }
            }

            // Fallback: try room-name text
            if (!username) {
                const roomName = room.shadowRoot.querySelector('.room-name') ||
                                 room.shadowRoot.querySelector('[class*="room-name"]');
                if (roomName) {
                    const candidate = roomName.textContent?.trim();
                    if (candidate && /^[a-zA-Z0-9_-]{3,20}$/.test(candidate)) {
                        username = candidate;
                        clickable = room.shadowRoot.querySelector('a') || room;
                    }
                }
            }

            // Fallback: deep text content for username
            if (!username) {
                const deepText = getDeepTextContent(room);
                const chatMatch = deepText.match(/Direct chat with (\S+)/i);
                if (chatMatch) {
                    username = chatMatch[1];
                    clickable = room.shadowRoot.querySelector('a') || room;
                }
            }
        } else {
            // No shadow root - try direct DOM
            const ariaLabel = room.getAttribute('aria-label') || '';
            const match = ariaLabel.match(/Direct chat with (\S+)/i);
            if (match) {
                username = match[1];
                clickable = room;
            }
            if (!username) {
                const text = room.textContent?.trim() || '';
                const chatMatch = text.match(/Direct chat with (\S+)/i);
                if (chatMatch) {
                    username = chatMatch[1];
                    clickable = room;
                }
            }
        }

        if (username && clickable && !seen.has(username.toLowerCase())) {
            seen.add(username.toLowerCase());
            rooms.push({ element: clickable, roomElement: room, username });
        }
    }

    // Strategy 2: Deep search all shadow DOMs for chat room links
    if (rooms.length === 0) {
        reportToBackground('debug', '[BulkSync] No rs-rooms-nav-room found, trying deep search...', { component: 'content' });

        // Look for any chat sidebar navigation
        const navSelectors = [
            'rs-rooms-nav',
            '[class*="rooms-nav"]',
            '[class*="RoomsList"]',
            '[class*="conversation-list"]',
            '[class*="chat-list"]',
            '[role="navigation"]',
            '[role="list"]'
        ];

        let sidebarContainer = null;
        for (const sel of navSelectors) {
            sidebarContainer = document.querySelector(sel) || querySelectorOneDeep(sel);
            if (sidebarContainer) {
                reportToBackground('debug', `[BulkSync] Found sidebar container via: ${sel}`, { component: 'content' });
                break;
            }
        }

        if (sidebarContainer) {
            // Find all clickable items that look like chat entries
            const clickables = querySelectorDeep('a, [role="listitem"], [role="option"]', sidebarContainer);
            reportToBackground('debug', `[BulkSync] Found ${clickables.length} clickable items in sidebar`, { component: 'content' });

            for (const el of clickables) {
                const ariaLabel = (el.getAttribute('aria-label') || '');
                const text = (el.textContent || '').trim();
                const fullText = ariaLabel || text;

                const match = fullText.match(/Direct chat with (\S+)/i);
                if (match) {
                    const uname = match[1];
                    if (!seen.has(uname.toLowerCase())) {
                        seen.add(uname.toLowerCase());
                        rooms.push({ element: el, username: uname });
                    }
                    continue;
                }

                // Try to extract a username-like string from short text
                if (text && /^[a-zA-Z0-9_-]{3,20}$/.test(text) && !seen.has(text.toLowerCase())) {
                    seen.add(text.toLowerCase());
                    rooms.push({ element: el, username: text });
                }
            }
        }
    }

    // Strategy 3: If still nothing, try to find any clickable with "Direct chat" anywhere
    if (rooms.length === 0) {
        reportToBackground('debug', '[BulkSync] Trying broadest deep search...', { component: 'content' });
        const allClickables = querySelectorDeep('a[aria-label], [role="listitem"], [role="option"]');
        for (const el of allClickables) {
            const ariaLabel = (el.getAttribute('aria-label') || '');
            const match = ariaLabel.match(/Direct chat with (\S+)/i);
            if (match) {
                const uname = match[1];
                if (!seen.has(uname.toLowerCase())) {
                    seen.add(uname.toLowerCase());
                    rooms.push({ element: el, username: uname });
                }
            }
        }
    }

    reportToBackground('debug', `[BulkSync] Total rooms found: ${rooms.length} ${JSON.stringify(rooms.map(r => r.username))}`, { component: 'content' });
    return rooms;
}

// Wait for chat messages to load after clicking a sidebar entry
async function waitForChatLoad(expectedUsername, timeout = 3000) {
    const start = Date.now();

    while (Date.now() - start < timeout) {
        // Check multiple container selectors
        const chatContainer = document.querySelector('rs-room') ||
                             querySelectorOneDeep('rs-room') ||
                             document.querySelector('[data-testid="chat-room"]') ||
                             querySelectorOneDeep('[class*="ChatRoom"]');

        if (chatContainer) {
            // Look for message elements with multiple selectors
            const messageSelectors = ['rs-timeline-event', 'rs-text-message', '[role="listitem"]', '[role="article"]', '[class*="mx_EventTile"]', '[class*="message"]'];
            for (const sel of messageSelectors) {
                const els = querySelectorDeep(sel, chatContainer);
                if (els && els.length > 0) {
                    await new Promise(r => setTimeout(r, 300));
                    return true;
                }
            }
        }

        await new Promise(r => setTimeout(r, 300));
    }

    // Timeout: proceed anyway (extractChatConversations will handle empty case)
    reportToBackground('warn', `[BulkSync] Chat load timeout for ${expectedUsername}, proceeding anyway`, { component: 'content' });
    return false;
}

// Main bulk sync orchestration
async function syncAllChats() {
    if (bulkSyncActive) {
        reportToBackground('info', 'Bulk sync already in progress', { component: 'content' });
        return;
    }

    reportToBackground('info', '[BulkSync] syncAllChats called', { component: 'content' });
    reportToBackground('debug', `[BulkSync] isOnChatPage: ${isOnChatPage()}`, { component: 'content' });
    reportToBackground('debug', `[BulkSync] URL: ${window.location.href}`, { component: 'content' });

    if (!isOnChatPage()) {
        reportToBackground('warn', '[BulkSync] Not on chat page, cannot sync all chats', { component: 'content' });
        safeSendMessage({
            action: 'BULK_SYNC_PROGRESS',
            data: { status: 'error', error: 'Please navigate to Reddit Chat first' }
        });
        return;
    }

    bulkSyncActive = true;
    bulkSyncCancelled = false;

    // Signal background to keep service worker alive during bulk sync
    safeSendMessage({ action: 'START_BULK_SYNC_KEEPALIVE' });

    const currentUser = getCurrentUsername();
    reportToBackground('debug', `[BulkSync] Current user: ${currentUser}`, { component: 'content' });

    // Debug: log what DOM elements exist
    reportToBackground('debug', `[BulkSync] rs-rooms-nav-room count: ${document.querySelectorAll('rs-rooms-nav-room').length}`, { component: 'content' });
    reportToBackground('debug', `[BulkSync] rs-rooms-nav count: ${document.querySelectorAll('rs-rooms-nav').length}`, { component: 'content' });
    const allShadowHosts = [];
    document.querySelectorAll('*').forEach(el => { if (el.shadowRoot) allShadowHosts.push(el.tagName.toLowerCase()); });
    reportToBackground('debug', `[BulkSync] Elements with shadow roots: ${[...new Set(allShadowHosts)]}`, { component: 'content' });

    // Get all rooms from sidebar
    const rooms = getAllSidebarRooms();
    const total = rooms.length;

    if (total === 0) {
        reportToBackground('warn', '[BulkSync] No rooms found in sidebar. Aborting.', { component: 'content' });
        bulkSyncActive = false;
        safeSendMessage({ action: 'STOP_BULK_SYNC_KEEPALIVE' });
        safeSendMessage({
            action: 'BULK_SYNC_PROGRESS',
            data: { current: 0, total: 0, synced: 0, skipped: 0, failed: 0, currentUser: '', status: 'completed' }
        });
        return;
    }

    bulkSyncProgress = { current: 0, total, synced: 0, skipped: 0, failed: 0, currentUser: '' };

    // Report initial state
    safeSendMessage({
        action: 'BULK_SYNC_PROGRESS',
        data: { ...bulkSyncProgress, status: 'started' }
    });

    reportToBackground('info', `Starting bulk sync of ${total} chats...`, { component: 'content' });

    let consecutiveAlreadySynced = 0;
    const ALREADY_SYNCED_THRESHOLD = 3;

    for (let i = 0; i < rooms.length; i++) {
        if (bulkSyncCancelled) {
            reportToBackground('info', 'Bulk sync cancelled by user', { component: 'content' });
            break;
        }

        const room = rooms[i];
        bulkSyncProgress.current = i + 1;
        bulkSyncProgress.currentUser = room.username;

        // Report progress
        safeSendMessage({
            action: 'BULK_SYNC_PROGRESS',
            data: { ...bulkSyncProgress, status: 'syncing' }
        });

        // Skip if participant is self
        if (currentUser && room.username.toLowerCase() === currentUser.toLowerCase()) {
            bulkSyncProgress.skipped++;
            continue;
        }

        try {
            // Click the room to open it
            room.element.click();

            // Wait for the chat to load
            await waitForChatLoad(room.username);

            // Extract conversations using existing function
            const conversations = extractChatConversations();

            if (conversations.length === 0 || conversations[0].messages.length === 0) {
                reportToBackground('debug', `No messages found for ${room.username}, skipping`, { component: 'content' });
                bulkSyncProgress.skipped++;
                continue;
            }

            const conv = conversations[0];

            // Sync to backend via background script (uses safeSendMessage for SW resilience)
            const response = await safeSendMessage({
                action: 'SYNC_CHAT_MESSAGES',
                data: {
                    participantUsername: conv.participantUsername,
                    messages: conv.messages,
                    accountUsername: currentUser
                }
            });

            // Check if already synced via _syncMeta from backend
            const syncMeta = response?.data?._syncMeta;
            if (syncMeta?.alreadySynced) {
                reportToBackground('debug', `Chat with ${room.username} already synced`, { component: 'content' });
                bulkSyncProgress.skipped++;
                consecutiveAlreadySynced++;

                if (consecutiveAlreadySynced >= ALREADY_SYNCED_THRESHOLD) {
                    reportToBackground('info', `${ALREADY_SYNCED_THRESHOLD} consecutive already-synced chats, stopping`, { component: 'content' });
                    break;
                }
            } else {
                reportToBackground('info', `Synced ${syncMeta?.addedCount || '?'} new messages for ${room.username}`, { component: 'content' });
                bulkSyncProgress.synced++;
                consecutiveAlreadySynced = 0; // Reset counter when new data found
            }

        } catch (err) {
            reportToBackground('error', `Failed to sync chat with ${room.username}`, { component: 'content', errorName: err?.name || err?.constructor?.name, errorStack: err?.stack });
            bulkSyncProgress.failed++;
            // Don't stop on individual failures, continue to next
        }

        // Rate limiting: wait between chats
        if (i < rooms.length - 1 && !bulkSyncCancelled) {
            await new Promise(r => setTimeout(r, 1000));
        }
    }

    bulkSyncActive = false;
    safeSendMessage({ action: 'STOP_BULK_SYNC_KEEPALIVE' });

    // Report completion
    safeSendMessage({
        action: 'BULK_SYNC_PROGRESS',
        data: { ...bulkSyncProgress, status: 'completed' }
    });

    reportToBackground('info', `Bulk sync completed: ${JSON.stringify(bulkSyncProgress)}`, { component: 'content' });
}

// Detect #__rdm_sync_all in URL hash (triggered by dashboard Sync Chats button)
function checkBulkSyncInstructions() {
    const hash = window.location.hash;
    if (!hash || !hash.startsWith('#__rdm_sync_all')) return;

    // Clean the hash from URL
    history.replaceState(null, '', window.location.pathname + window.location.search);

    reportToBackground('info', 'Bulk sync detected from dashboard', { component: 'content' });

    // Delay to ensure chat page is fully loaded
    setTimeout(() => syncAllChats(), 3000);
}

// --- Direct Send from Dashboard ---
// Detects #__rdm_send= in the URL hash (set by dashboard "Send Now" / Queue "Send").
// Parses the base64 JSON payload and forwards to background for automation.
function checkDirectSendInstructions() {
    const hash = window.location.hash;
    if (!hash || !hash.startsWith('#__rdm_send=')) return;

    try {
        const encoded = hash.substring('#__rdm_send='.length);
        const payload = JSON.parse(atob(encoded));

        const targetUser = payload.username;
        if (!targetUser) {
            reportToBackground('warn', 'Direct send: no username in payload', { component: 'content' });
            return;
        }

        // Clean the hash from URL for privacy
        history.replaceState(null, '', window.location.pathname + window.location.search);

        reportToBackground('info', `Direct send detected for user: ${targetUser}`, { component: 'content' });

        // Send to background script for automation
        chrome.runtime.sendMessage({
            action: 'DIRECT_SEND_REPLY',
            data: {
                targetUser,
                message: payload.message,
                queueItemId: payload.queueItemId,
                conversationId: payload.conversationId,
                accountId: payload.accountId || null
            }
        });
    } catch (err) {
        reportToBackground('error', 'Failed to parse direct send instructions', { component: 'content', errorName: err?.name || err?.constructor?.name, errorStack: err?.stack });
    }
}

// --- Cookie Capture from Dashboard ---
// Detects #__rdm_capture_cookies in the URL hash (set by dashboard "Capture from Browser").
// Asks background to capture cookies + detect username, then sends result back.
function checkCookieCaptureInstructions() {
    const hash = window.location.hash;
    if (!hash || !hash.startsWith('#__rdm_capture_cookies')) return;

    // Clean the hash from URL
    history.replaceState(null, '', window.location.pathname + window.location.search);

    reportToBackground('info', 'Cookie capture detected', { component: 'content' });

    chrome.runtime.sendMessage({ action: 'CAPTURE_REDDIT_COOKIES' }, (response) => {
        if (chrome.runtime.lastError) {
            reportToBackground('error', `Cookie capture failed: ${chrome.runtime.lastError.message}`, { component: 'content' });
            return;
        }

        if (response && response.cookies && response.cookies.length > 0) {
            reportToBackground('info', `Cookies captured for u/${response.username || 'unknown'} (${response.cookies.length} cookies)`, { component: 'content' });

            // Register the account via the backend API directly
            chrome.runtime.sendMessage({
                action: 'REGISTER_CAPTURED_ACCOUNT',
                username: response.username,
                cookies: response.cookies
            }, (regResult) => {
                if (chrome.runtime.lastError) {
                    reportToBackground('error', `Account registration failed: ${chrome.runtime.lastError.message}`, { component: 'content' });
                }
                // Store result so dashboard can detect completion
                chrome.storage.local.set({
                    capturedCookies: response.cookies,
                    capturedUsername: response.username,
                    capturedAt: Date.now(),
                    capturedRegistered: !!(regResult && regResult.success)
                });
            });
        } else {
            reportToBackground('warn', 'No cookies captured. Make sure you are logged into Reddit.', { component: 'content' });
            chrome.storage.local.set({
                capturedCookies: null,
                capturedUsername: null,
                capturedAt: Date.now(),
                capturedError: 'No Reddit cookies found. Please log into Reddit first.'
            });
        }
    });
}

// --- Initialization ---
async function init() {
    if (window.__redditDMExtInitialized) return;
    window.__redditDMExtInitialized = true;

    if (!isContextValid()) return;
    reportToBackground('info', `Content script init() called on: ${window.location.href}`, { component: 'content' });
    // Load state from storage
    const data = await chrome.storage.local.get(['isSidebarOpen', 'sidebarWidth']);
    isSidebarOpen = data.isSidebarOpen || false;
    sidebarWidth = data.sidebarWidth || 400;

    if (isSidebarOpen) {
        injectSidebar();
    }

    // Start chat sync on all Reddit pages (side panel can open anywhere)
    if (window.location.hostname.includes('reddit.com')) {
        startChatSync();
    }

    // Listen for messages from background script
    chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
        if (!isContextValid()) return;
        if (request.action === 'PING') {
            sendResponse({ pong: true });
            return;
        }
        if (request.action === 'TOGGLE_SIDEBAR') {
            toggleSidebar(request.isOpen);
        } else if (request.action === 'GET_POST_DATA') {
            sendResponse(extractPostData());
        } else if (request.action === 'EXECUTE_ACTION') {
            // Fire-and-forget: kick off the command, ack immediately.
            // The real result goes through AUTOMATION_STEP_COMPLETE messages.
            sendResponse(handleAutomationCommand(request));
        } else if (request.action === 'AUTOMATION_STOPPED') {
            isAutomationRunning = false;
            hideFloatingStopButton();
            showToast('Automation stopped', 'info');
            checkPageStatus();
        } else if (request.action === 'AUTOMATION_ERROR') {
            hideFloatingStopButton();
            ensureSidebarVisible();
            setTimeout(() => renderErrorState(request.error, request.context), 300);
            // Safety: reset toggle lock after 30s if automation doesn't resume
            setTimeout(() => {
                chrome.runtime.sendMessage({ action: 'GET_AUTOMATION_STATUS' }, (status) => {
                    if (!status || !status.isActive) {
                        isAutomationRunning = false;
                    }
                });
            }, 30000);
        } else if (request.action === 'SHOW_TOAST') {
            showToast(request.message, request.type);
        } else if (request.action === 'SHOW_DM_CONFIRMATION') {
            // Show confirmation dialog before sending DM - auto-open sidebar
            ensureSidebarVisible();
            setTimeout(() => renderDMConfirmation(request.data), 300);
        } else if (request.action === 'AUTOMATION_PROGRESS') {
            // Show automation progress - auto-open sidebar
            ensureSidebarVisible();
            setTimeout(() => renderRunningState(request.status), 300);
        } else if (request.action === 'START_BULK_SYNC') {
            reportToBackground('info', 'Received START_BULK_SYNC from background', { component: 'content' });
            syncAllChats();
            sendResponse({ success: true });
        } else if (request.action === 'CANCEL_BULK_SYNC') {
            bulkSyncCancelled = true;
            sendResponse({ success: true });
        } else if (request.action === 'REFRESH_SIDEBAR_STATS') {
            loadSidebarData();
        }
    });

    // Check for direct-send instructions from dashboard (via URL hash)
    checkDirectSendInstructions();

    // Check for cookie capture instructions from dashboard (via URL hash)
    checkCookieCaptureInstructions();

    // Check for bulk sync instructions from dashboard (via URL hash)
    checkBulkSyncInstructions();

    // Check automation status on load
    chrome.runtime.sendMessage({ action: 'GET_AUTOMATION_STATUS' }, (status) => {
        if (status && status.isActive) {
            reportToBackground('info', `Resuming automation UI: ${JSON.stringify(status)}`, { component: 'content' });
            ensureSidebarVisible();
            // We need to wait for sidebar to inject
            setTimeout(() => renderRunningState(status), 500);
        }
    });

    // Listen for storage changes (to sync across tabs)
    chrome.storage.onChanged.addListener((changes, area) => {
        if (!isContextValid()) return;
        if (area === 'local') {
            if (changes.isSidebarOpen) {
                toggleSidebar(changes.isSidebarOpen.newValue);
            }
            if (changes.sidebarWidth) {
                sidebarWidth = changes.sidebarWidth.newValue;
                if (sidebarContainer) {
                    sidebarContainer.style.width = `${sidebarWidth}px`;
                }
            }
        }
    });

    // Fallback keyboard shortcut listener (in case chrome.commands doesn't work)
    document.addEventListener('keydown', (e) => {
        if (!isContextValid()) return;
        // Ctrl+Shift+R (Windows/Linux) or Alt+R (Mac) to toggle sidebar
        const isMac = (navigator.userAgentData?.platform || navigator.platform || '').toUpperCase().indexOf('MAC') >= 0;
        const isToggleShortcut = isMac
            ? (e.altKey && e.key.toLowerCase() === 'r')
            : (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === 'r');

        if (isToggleShortcut) {
            e.preventDefault();
            reportToBackground('debug', 'Toggle sidebar shortcut pressed (fallback handler)', { component: 'content' });
            const newState = !isSidebarOpen;
            chrome.storage.local.set({ isSidebarOpen: newState });
            toggleSidebar(newState);
        }
    });
}

// --- Automation Command Handler ---
// Synchronous fire-and-forget: kicks off async work and returns an immediate ack.
// The actual result is delivered via AUTOMATION_STEP_COMPLETE messages.
function handleAutomationCommand(request) {
    reportToBackground('info', `Received automation command: ${request.command}`, { component: 'content' });
    // Ensure automation flag is set so typing checks don't abort prematurely
    isAutomationRunning = true;
    // Show floating stop button so user can stop even without sidebar open
    showFloatingStopButton();

    switch (request.command) {
        case 'CLICK_CHAT_BUTTON':
            executeClickChat().catch(err => {
                reportToBackground('error', 'executeClickChat error', { component: 'content', errorName: err?.name || err?.constructor?.name, errorStack: err?.stack });
                safeSendMessage({
                    action: 'AUTOMATION_STEP_COMPLETE',
                    result: { success: false, error: err.message, step: 'CLICK_CHAT_BUTTON' }
                });
            });
            return { ack: true };

        case 'FIND_CHAT_USER':
            executeFindChatUser(request.targetUser).catch(err => {
                reportToBackground('error', 'executeFindChatUser error', { component: 'content', errorName: err?.name || err?.constructor?.name, errorStack: err?.stack });
                safeSendMessage({
                    action: 'AUTOMATION_STEP_COMPLETE',
                    result: { success: false, error: err.message, step: 'FIND_CHAT_USER' }
                });
            });
            return { ack: true };

        case 'DIRECT_CHAT_SEND':
            executeDirectChatSend(request.targetUser, request.text).catch(err => {
                reportToBackground('error', 'executeDirectChatSend error', { component: 'content', errorName: err?.name || err?.constructor?.name, errorStack: err?.stack });
                safeSendMessage({
                    action: 'AUTOMATION_STEP_COMPLETE',
                    result: { success: false, error: err.message, step: 'DIRECT_CHAT_SEND' }
                });
            });
            return { ack: true };

        case 'TYPE_MESSAGE':
            executeTypeMessage(request.text).catch(err => {
                reportToBackground('error', 'executeTypeMessage error', { component: 'content', errorName: err?.name || err?.constructor?.name, errorStack: err?.stack });
                safeSendMessage({
                    action: 'AUTOMATION_STEP_COMPLETE',
                    result: { success: false, error: err.message, step: 'TYPE_MESSAGE' }
                });
            });
            return { ack: true };

        default:
            return { ack: false, error: `Unknown command: ${request.command}` };
    }
}

async function executeClickChat() {
    if (!isContextValid()) throw new Error('Extension context invalidated');
    reportToBackground('info', 'Looking for Chat button...', { component: 'content' });

    const findChatButton = () => {
        // Priority 1: data-testid="private-chat-button" (new Reddit anchor)
        const chatTestId = document.querySelector('[data-testid="private-chat-button"]');
        if (chatTestId) {
            reportToBackground('debug', 'Found via data-testid="private-chat-button"', { component: 'content' });
            return chatTestId;
        }

        // Priority 2: aria-label="Open chat"
        const ariaChat = document.querySelector('[aria-label="Open chat"]');
        if (ariaChat) {
            reportToBackground('debug', 'Found via aria-label="Open chat"', { component: 'content' });
            return ariaChat;
        }

        // Priority 3: Link to chat.reddit.com
        const chatLink = document.querySelector('a[href*="chat.reddit.com"]');
        if (chatLink) {
            reportToBackground('debug', 'Found via href containing chat.reddit.com', { component: 'content' });
            return chatLink;
        }

        // Priority 4: Shadow DOM "Chat" button (common in new Reddit)
        const shadowHosts = document.querySelectorAll('shreddit-profile-action-row, shreddit-header-action-row');
        for (const host of shadowHosts) {
            if (host.shadowRoot) {
                const btn = host.shadowRoot.querySelector('button');
                if (btn && btn.innerText.includes('Chat')) return btn;
                const icon = host.shadowRoot.querySelector('faceplate-icon[name="chat"]');
                if (icon) return icon.closest('button');
            }
        }

        // Priority 5: Standard DOM buttons/anchors with "Chat" text
        const allClickables = Array.from(document.querySelectorAll('button, a'));
        const chatBtn = allClickables.find(el => {
            const text = el.innerText.trim();
            return text === 'Chat' || text === 'Start Chat' || text.includes('Start Chat');
        });
        if (chatBtn) {
            reportToBackground('debug', 'Found via text content', { component: 'content' });
            return chatBtn;
        }

        // Priority 6: Links to /chat/ path
        const chatPathLink = document.querySelector('a[href^="/chat/"]');
        if (chatPathLink) return chatPathLink;

        return null;
    };

    const chatBtn = await pollForElement(findChatButton, 8000, 500);

    if (chatBtn) {
        reportToBackground('info', 'Chat button found. Animating cursor...', { component: 'content' });
        await showCursorAnimation(chatBtn);

        // Detect if clicking will cause same-tab navigation (destroying this script)
        const navLink = chatBtn.tagName === 'A' && chatBtn.href &&
            (chatBtn.href.includes('chat.reddit.com') || chatBtn.href.includes('/chat/'));
        const parentNavLink = !navLink && chatBtn.closest('a[href*="chat"]');
        const willNavigate = navLink || parentNavLink;

        if (willNavigate) {
            reportToBackground('info', 'Chat button is a navigation link, sending step-complete before click...', { component: 'content' });
            // Send step-complete BEFORE clicking, since click will destroy this content script
            chrome.runtime.sendMessage({
                action: 'AUTOMATION_STEP_COMPLETE',
                result: { success: true, step: 'CLICK_CHAT_BUTTON' }
            });
            // Delay to ensure message is flushed before navigation begins
            await new Promise(r => setTimeout(r, 300));
            chatBtn.click();
        } else {
            reportToBackground('debug', 'Clicking chat button (popup/overlay mode)...', { component: 'content' });
            chatBtn.click();
            // Safe to send after click since no navigation occurred
            chrome.runtime.sendMessage({
                action: 'AUTOMATION_STEP_COMPLETE',
                result: { success: true, step: 'CLICK_CHAT_BUTTON' }
            });
        }
    } else {
        reportToBackground('error', 'Could not find Chat button', { component: 'content' });
        safeSendMessage({
            action: 'AUTOMATION_STEP_COMPLETE',
            result: { success: false, error: 'Chat button not found', step: 'CLICK_CHAT_BUTTON' }
        });
    }
}

// Search for a chat conversation with the given username in the chat sidebar.
// Returns a clickable element or null. Works across shadow DOMs.
// Uses exact username matching first, then word-boundary fallback to avoid substring false positives.
function findChatUserElement(targetLower) {
    // Helper: check if text matches the target username (exact or word-boundary)
    function isExactMatch(text) {
        const normalized = text.replace(/^u\//, '').trim();
        if (normalized === targetLower || text === `u/${targetLower}`) return true;
        // Handle aria-labels like "Direct chat with _Devouring_"
        const chatMatch = text.match(/direct chat with (\S+)/i);
        if (chatMatch && chatMatch[1].toLowerCase() === targetLower) return true;
        return false;
    }
    function isWordBoundaryMatch(text) {
        try {
            const escaped = targetLower.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            return new RegExp('(?:^|[\\s/])' + escaped + '(?:$|[\\s,.])', 'i').test(text);
        } catch { return false; }
    }
    function isSubstringMatch(text) {
        return text.includes(targetLower);
    }

    // Pass 1: Exact matches across all strategies
    // Pass 2: Word-boundary matches (fallback)
    // Pass 3: Substring matches (loose fallback, chat elements only)
    for (const matchFn of [isExactMatch, isWordBoundaryMatch, isSubstringMatch]) {
        // Strategy 1: rs-rooms-nav-room elements (Reddit chat web components)
        const rooms = document.querySelectorAll('rs-rooms-nav-room');
        for (const room of rooms) {
            if (!room.shadowRoot) continue;
            const chatLink = room.shadowRoot.querySelector('a[aria-label]');
            if (chatLink) {
                const ariaLabel = (chatLink.getAttribute('aria-label') || '').toLowerCase();
                if (matchFn(ariaLabel)) {
                    reportToBackground('debug', `Found via rs-rooms-nav-room aria-label: ${ariaLabel}`, { component: 'content' });
                    return chatLink;
                }
            }
            const deepText = getDeepTextContent(room).toLowerCase();
            if (matchFn(deepText)) {
                reportToBackground('debug', 'Found via rs-rooms-nav-room text content', { component: 'content' });
                return room.shadowRoot.querySelector('a') || room;
            }
        }

        // Strategy 2: Deep search ALL shadow DOMs for clickable elements with username
        const allClickables = querySelectorDeep('a, button, [role="listitem"], [role="option"], [role="link"]');
        for (const el of allClickables) {
            const text = (el.textContent || '').trim().toLowerCase();
            const ariaLabel = (el.getAttribute('aria-label') || '').toLowerCase();
            if (matchFn(text) || matchFn(ariaLabel)) {
                reportToBackground('debug', `Found via deep clickable search: ${el.tagName} ${text.substring(0, 50)}`, { component: 'content' });
                return el;
            }
        }

        // Skip broad DOM strategies for substring match (too many false positives)
        if (matchFn === isSubstringMatch) continue;

        // Strategy 3: Standard DOM links/buttons containing username
        const allLinks = document.querySelectorAll('a, button');
        for (const link of allLinks) {
            const linkText = (link.textContent || '').trim().toLowerCase();
            if (matchFn(linkText)) {
                reportToBackground('debug', `Found via standard DOM text: ${link.tagName} ${linkText.substring(0, 50)}`, { component: 'content' });
                return link;
            }
        }

        // Strategy 4: Walk entire DOM tree including shadow roots for text nodes
        const findClickableWithText = (root) => {
            const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null);
            let node;
            while ((node = walker.nextNode())) {
                if (matchFn(node.textContent.trim().toLowerCase())) {
                    let el = node.parentElement;
                    while (el && el !== root) {
                        if (el.tagName === 'A' || el.tagName === 'BUTTON' || el.getAttribute('role') === 'listitem' || el.onclick) {
                            reportToBackground('debug', `Found via text node walk: ${el.tagName}`, { component: 'content' });
                            return el;
                        }
                        el = el.parentElement;
                    }
                }
            }
            const elements = root.querySelectorAll('*');
            for (const el of elements) {
                if (el.shadowRoot) {
                    const result = findClickableWithText(el.shadowRoot);
                    if (result) return result;
                }
            }
            return null;
        };

        const result = findClickableWithText(document);
        if (result) return result;
    }

    return null;
}

async function executeFindChatUser(targetUser) {
    if (!isContextValid()) throw new Error('Extension context invalidated');
    reportToBackground('info', `Looking for chat conversation with: ${targetUser}`, { component: 'content' });
    const targetLower = targetUser.toLowerCase();

    const userRoom = await pollForElement(() => findChatUserElement(targetLower), 12000, 500);

    if (userRoom) {
        reportToBackground('info', 'Chat conversation found. Clicking to open...', { component: 'content' });
        userRoom.click();
        await new Promise(r => setTimeout(r, 1500));

        safeSendMessage({
            action: 'AUTOMATION_STEP_COMPLETE',
            result: { success: true, step: 'FIND_CHAT_USER' }
        });
        return { success: true };
    } else {
        reportToBackground('error', `Could not find chat conversation for: ${targetUser}`, { component: 'content' });
        safeSendMessage({
            action: 'AUTOMATION_STEP_COMPLETE',
            result: { success: false, error: `Chat with ${targetUser} not found`, step: 'FIND_CHAT_USER' }
        });
        return { success: false, error: `Chat with ${targetUser} not found` };
    }
}

// Combined command: find user in chat sidebar, open conversation, type and send.
// Runs entirely within the content script to avoid state-transition issues when
// clicking a conversation causes a soft/hard navigation.
async function executeDirectChatSend(targetUser, text) {
    if (!isContextValid()) throw new Error('Extension context invalidated');
    reportToBackground('info', `Direct chat send to: ${targetUser} | message length: ${text?.length}`, { component: 'content' });

    const targetLower = targetUser.toLowerCase();
    const onChatPage = /chat\.reddit\.com|reddit\.com\/chat/i.test(window.location.href);

    // When on a chat page (navigated from profile "Chat" button), the conversation
    // may already be open directly — no sidebar entry exists for new conversations.
    // Race: look for either the sidebar entry OR a directly-available chat input.
    if (onChatPage) {
        reportToBackground('debug', 'On chat page, racing sidebar lookup vs direct chat input...', { component: 'content' });
        const result = await raceForChatReady(targetLower, 15000, 500);

        if (result === 'direct') {
            reportToBackground('debug', `Chat input found directly for ${targetUser} - typing...`, { component: 'content' });
            return await executeTypeMessage(text, targetUser);
        } else if (result === 'sidebar') {
            // findChatUserElement found a clickable sidebar entry — use it
            const userRoom = findChatUserElement(targetLower);
            if (userRoom) {
                reportToBackground('debug', `Found conversation for ${targetUser} in sidebar - clicking...`, { component: 'content' });
                userRoom.click();
                await new Promise(r => setTimeout(r, 2000));
                return await executeTypeMessage(text, targetUser);
            }
        }

        // Final fallback: poll for chat input, but verify it's the right conversation
        reportToBackground('debug', 'Race failed, polling for chat input as last resort...', { component: 'content' });
        const chatInput = await pollForElement(() => {
            const input = findChatInput();
            if (input && verifyConversationUser(targetUser)) return input;
            return null;
        }, 8000, 500);
        if (chatInput) {
            reportToBackground('debug', `Chat input found and verified for ${targetUser}`, { component: 'content' });
            return await executeTypeMessage(text, targetUser);
        }

        reportToBackground('error', `Could not find chat conversation for: ${targetUser}`, { component: 'content' });
        safeSendMessage({
            action: 'AUTOMATION_STEP_COMPLETE',
            result: { success: false, error: `Chat with ${targetUser} not found`, step: 'DIRECT_CHAT_SEND' }
        });
        return { success: false, error: `Chat with ${targetUser} not found` };
    }

    // Not on a dedicated chat page — chat opened as overlay/popup on the current page.
    // Look for the user in the sidebar.
    const userRoom = await pollForElement(() => findChatUserElement(targetLower), 12000, 500);
    if (!userRoom) {
        // Fallback: chat may already be open from the chat button click (new conversation)
        reportToBackground('debug', `Sidebar lookup failed, checking if chat is already open for ${targetUser}`, { component: 'content' });
        const chatInput = await pollForElement(findChatInput, 5000, 500);
        if (chatInput && verifyConversationUser(targetUser)) {
            reportToBackground('debug', `Chat already open for ${targetUser} - typing directly`, { component: 'content' });
            return await executeTypeMessage(text, targetUser);
        }

        reportToBackground('error', `Could not find chat conversation for: ${targetUser}`, { component: 'content' });
        safeSendMessage({
            action: 'AUTOMATION_STEP_COMPLETE',
            result: { success: false, error: `Chat with ${targetUser} not found`, step: 'DIRECT_CHAT_SEND' }
        });
        return { success: false, error: `Chat with ${targetUser} not found` };
    }

    reportToBackground('debug', `Found conversation for ${targetUser} - clicking...`, { component: 'content' });
    userRoom.click();

    // Wait for conversation to open and chat input to appear
    await new Promise(r => setTimeout(r, 2000));

    if (!verifyConversationUser(targetUser)) {
        reportToBackground('warn', `Conversation header does not match target user: ${targetUser}`, { component: 'content' });
        // Retry: wait a bit longer and re-verify (Reddit may still be rendering)
        await new Promise(r => setTimeout(r, 2000));
        if (!verifyConversationUser(targetUser)) {
            reportToBackground('error', `Wrong conversation open — expected ${targetUser}, aborting to prevent messaging wrong user`, { component: 'content' });
            safeSendMessage({
                action: 'AUTOMATION_STEP_COMPLETE',
                result: { success: false, error: `Wrong conversation: expected ${targetUser}`, step: 'VERIFY_USER' }
            });
            return { success: false, error: `Wrong conversation: expected ${targetUser}` };
        }
    }

    // Type and send using the existing logic
    return await executeTypeMessage(text, targetUser);
}

// Race between finding the user in the sidebar and finding a direct chat input.
// Returns 'direct' if a chat input is found, 'sidebar' if a sidebar entry is found, or null.
function raceForChatReady(targetLower, timeout, interval) {
    return new Promise((resolve) => {
        // Prioritize sidebar — it's the reliable path to the correct user
        if (findChatUserElement(targetLower)) return resolve('sidebar');
        // Only resolve 'direct' if chat input exists AND we can verify it's the right user
        if (findChatInput() && verifyConversationUser(targetLower)) return resolve('direct');

        const start = Date.now();
        const timer = setInterval(() => {
            if (findChatUserElement(targetLower)) {
                clearInterval(timer);
                resolve('sidebar');
            } else if (findChatInput() && verifyConversationUser(targetLower)) {
                clearInterval(timer);
                resolve('direct');
            } else if (Date.now() - start >= timeout) {
                clearInterval(timer);
                resolve(null);
            }
        }, interval);
    });
}

// Standalone helper: find a chat input element across shadow DOMs
function findChatInput() {
    const findInShadow = (root) => {
        if (!root) return null;

        const textareaByName = root.querySelector('textarea[name="message"]');
        if (textareaByName) return textareaByName;

        const textareaByAria = root.querySelector('textarea[aria-label="Write message"]');
        if (textareaByAria) return textareaByAria;

        const contentEditable = root.querySelector('div[contenteditable="true"][role="textbox"]');
        if (contentEditable) return contentEditable;

        const fallback = root.querySelector('textarea[placeholder="Message"]');
        if (fallback) return fallback;

        // Reddit chat (Matrix-based) may use different aria labels
        const sendMsgAria = root.querySelector('textarea[aria-label="Send a message…"], textarea[aria-label="Send a message"]');
        if (sendMsgAria) return sendMsgAria;

        // Generic contenteditable divs in chat context
        const chatEditable = root.querySelector('[data-testid="chat-input"] textarea, [data-testid="chat-input"] [contenteditable="true"]');
        if (chatEditable) return chatEditable;

        // Any visible textarea or contenteditable in the chat area
        const anyTextarea = root.querySelector('rs-chat-composer textarea, rs-chat-composer [contenteditable="true"]');
        if (anyTextarea) return anyTextarea;

        const candidates = root.querySelectorAll('*');
        for (const el of candidates) {
            if (el.shadowRoot) {
                const found = findInShadow(el.shadowRoot);
                if (found) return found;
            }
        }
        return null;
    };

    // Search main document
    const mainResult = findInShadow(document);
    if (mainResult) return mainResult;

    // Search same-origin iframes (Reddit chat may render inside an iframe)
    try {
        const iframes = document.querySelectorAll('iframe');
        for (const iframe of iframes) {
            try {
                const iframeDoc = iframe.contentDocument || iframe.contentWindow?.document;
                if (iframeDoc) {
                    const result = findInShadow(iframeDoc);
                    if (result) return result;
                }
            } catch (e) { /* cross-origin iframe, skip */ }
        }
    } catch (e) { /* ignore */ }

    return null;
}

// Standalone helper: verify the open conversation matches the target username
function verifyConversationUser(targetUser) {
    const headers = querySelectorDeep('h1, h2, h3, [class*="header"], [class*="title"], [class*="name"]');
    const normalizedTarget = targetUser.replace(/^u\//, '').toLowerCase();
    for (const h of headers) {
        const text = (h.textContent || '').trim().toLowerCase();
        if (text.includes(normalizedTarget)) return true;
    }
    if (window.location.href.toLowerCase().includes(normalizedTarget)) return true;
    return false;
}

async function executeTypeMessage(text, targetUser = null) {
    if (!isContextValid()) throw new Error('Extension context invalidated');
    reportToBackground('info', 'Looking for chat input...', { component: 'content' });

    // Use polling instead of MutationObserver since chat input is inside shadow DOM
    // (MutationObserver on document.body cannot observe changes inside shadow roots)
    const input = await pollForElement(findChatInput, 10000, 500);

    if (input) {
        // Verify we're still in the correct conversation before typing
        if (targetUser && !verifyConversationUser(targetUser)) {
            reportToBackground('error', `Wrong conversation open before typing — expected ${targetUser}`, { component: 'content' });
            safeSendMessage({
                action: 'AUTOMATION_STEP_COMPLETE',
                result: { success: false, error: `Wrong conversation — expected ${targetUser}`, step: 'TYPE_MESSAGE' }
            });
            return { success: false, error: `Wrong conversation — aborting to prevent messaging wrong user` };
        }

        reportToBackground('info', 'Chat input found. Typing message...', { component: 'content' });

        // Show cursor animation on input first
        await showCursorAnimation(input);

        // Type the message
        await simulateTyping(input, text, targetUser);

        // Abort if conversation changed during typing
        if (targetUser && !verifyConversationUser(targetUser)) {
            reportToBackground('error', `Conversation changed during typing — expected ${targetUser}, aborting send`, { component: 'content' });
            safeSendMessage({
                action: 'AUTOMATION_STEP_COMPLETE',
                result: { success: false, error: `Conversation changed during typing — expected ${targetUser}`, step: 'TYPE_MESSAGE' }
            });
            return { success: false, error: 'Conversation changed during typing' };
        }

        // Abort if automation was stopped during typing
        if (!isAutomationRunning) {
            reportToBackground('info', 'Automation stopped during typing, aborting send', { component: 'content' });
            return { success: false, error: 'Automation stopped' };
        }

        // Find send button
        const findSendButton = () => {
            const findInShadow = (root) => {
                if (!root) return null;

                // Priority 1: aria-label="Send message"
                const sendByAria = root.querySelector('button[aria-label="Send message"]');
                if (sendByAria) return sendByAria;

                // Priority 2: type="submit" inside chat area
                const submitBtn = root.querySelector('button[type="submit"][aria-label*="Send"]');
                if (submitBtn) return submitBtn;

                // Recurse
                const candidates = root.querySelectorAll('*');
                for (const el of candidates) {
                    if (el.shadowRoot) {
                        const found = findInShadow(el.shadowRoot);
                        if (found) return found;
                    }
                }
                return null;
            };

            // 1. Search main document
            const mainDocResult = findInShadow(document);
            if (mainDocResult) return mainDocResult;

            // Fallback: Standard DOM search
            const buttons = Array.from(document.querySelectorAll('button'));
            return buttons.find(b =>
                b.getAttribute('aria-label')?.includes('Send') ||
                b.innerText.includes('Send')
            );
        };

        const sendBtn = await pollForElement(findSendButton, 5000, 500);
        if (sendBtn) {
            reportToBackground('info', 'Send button found. Animating cursor...', { component: 'content' });
            await showCursorAnimation(sendBtn);

            reportToBackground('debug', 'Clicking send button...', { component: 'content' });
            sendBtn.click();

            reportToBackground('info', 'Message sent successfully!', { component: 'content' });
            hideFloatingStopButton();

            // --- CLOSE CHAT LOGIC REMOVED ---
            reportToBackground('debug', 'Automation stopping here as requested.', { component: 'content' });

            safeSendMessage({
                action: 'AUTOMATION_STEP_COMPLETE',
                result: { success: true, step: 'TYPE_MESSAGE' }
            });
            return { success: true };
        } else {
            reportToBackground('warn', 'Send button not found. Message typed but not sent.', { component: 'content' });
            safeSendMessage({
                action: 'AUTOMATION_STEP_COMPLETE',
                result: { success: false, step: 'TYPE_MESSAGE', error: 'Send button not found' }
            });
            return { success: false, error: 'Send button not found' };
        }
    } else {
        reportToBackground('error', 'Could not find chat input', { component: 'content' });
        safeSendMessage({
            action: 'AUTOMATION_STEP_COMPLETE',
            result: { success: false, error: 'Chat input not found', step: 'TYPE_MESSAGE' }
        });
        return { success: false, error: 'Chat input not found' };
    }
}

// --- Floating Stop Button (visible during reply automation even without sidebar open) ---
function showFloatingStopButton() {
    // Remove existing if any
    hideFloatingStopButton();

    const btn = document.createElement('div');
    btn.id = 'reddit-insight-floating-stop';
    btn.style.cssText = 'position:fixed; bottom:20px; right:20px; z-index:2147483647; font-family:-apple-system,BlinkMacSystemFont,sans-serif;';
    btn.innerHTML = `
        <button style="
            background: #dc2626; color: white; border: none; padding: 10px 20px;
            border-radius: 10px; font-size: 14px; font-weight: 600; cursor: pointer;
            box-shadow: 0 4px 12px rgba(220,38,38,0.4); display: flex; align-items: center; gap: 6px;
            transition: background 0.2s;
        " onmouseover="this.style.background='#b91c1c'" onmouseout="this.style.background='#dc2626'">
            <span style="font-size:16px;">&#9724;</span> Stop Reply
        </button>
    `;
    btn.querySelector('button').addEventListener('click', () => {
        isAutomationRunning = false;
        chrome.runtime.sendMessage({ action: 'STOP_AUTOMATION' }, () => {
            showToast('Automation stopped', 'info');
            hideFloatingStopButton();
            checkPageStatus();
        });
    });
    document.body.appendChild(btn);
}

function hideFloatingStopButton() {
    const existing = document.getElementById('reddit-insight-floating-stop');
    if (existing) existing.remove();
}

// --- Sidebar Injection ---
function injectSidebar() {
    // Prevent race condition: check both DOM and flag
    if (document.getElementById('reddit-insight-sidebar-host') || isSidebarInjecting) return;
    isSidebarInjecting = true;

    try {
    const host = document.createElement('div');
    host.id = 'reddit-insight-sidebar-host';
    host.style.position = 'fixed';
    host.style.top = '0';
    host.style.right = '0';
    host.style.zIndex = '2147483647';
    host.style.height = '100vh';
    host.style.pointerEvents = 'none';
    document.body.appendChild(host);

    shadowRoot = host.attachShadow({ mode: 'open' });

    // Inject Styles
    const styleLink = document.createElement('link');
    styleLink.rel = 'stylesheet';
    styleLink.href = chrome.runtime.getURL('styles/main.css');
    shadowRoot.appendChild(styleLink);

    // Inject HTML Structure
    const container = document.createElement('div');
    container.className = 'sidebar-container';
    container.style.width = `${sidebarWidth}px`;
    container.style.pointerEvents = 'auto';
    container.innerHTML = `
        <div id="app" class="container">
            <!-- Onboarding View -->
            <div id="onboarding-view" class="hidden">
                <header>
                    <h1>Setup Reddit Automated DM</h1>
                    <p class="subtitle">Configure your business context to generate better DMs.</p>
                </header>
                <form id="setup-form">
                    <div class="form-group">
                        <label for="business-desc">Business / Product Description</label>
                        <textarea id="business-desc" rows="3" placeholder="e.g. We build a productivity tool..." required></textarea>
                    </div>
                    <div class="form-group">
                        <label for="persona">Target Customer / Persona (Optional)</label>
                        <input type="text" id="persona" placeholder="e.g. Engineering Managers">
                    </div>
                    <div class="form-group">
                        <label>Insight Type</label>
                        <div class="checkbox-group">
                            <label><input type="checkbox" name="insight" value="Pain points"> Pain points</label>
                            <label><input type="checkbox" name="insight" value="Current solutions"> Current solutions</label>
                            <label><input type="checkbox" name="insight" value="Frustrations"> Frustrations</label>
                            <label><input type="checkbox" name="insight" value="Decision triggers"> Decision triggers</label>
                        </div>
                    </div>
                    <div class="form-group">
                        <label for="tone">Tone of Message</label>
                        <select id="tone">
                            <option value="Curious">Curious</option>
                            <option value="Empathetic">Empathetic</option>
                            <option value="Casual">Casual Reddit-native</option>
                            <option value="Professional">Professional</option>
                        </select>
                    </div>
                    <button type="submit" class="btn-primary">Save & Continue</button>
                </form>
            </div>

            <!-- Settings View -->
            <div id="settings-view" class="hidden">
                <header class="main-header">
                    <button id="back-from-settings" class="btn-icon" title="Back">←</button>
                    <h2 style="margin:0;font-size:16px;">Settings</h2>
                    <div></div>
                </header>
                <div class="settings-content">
                    <div class="form-group">
                        <label for="settings-business-desc">Business Description</label>
                        <textarea id="settings-business-desc" rows="2" placeholder="Your business..."></textarea>
                    </div>
                    <div class="form-group">
                        <label for="settings-persona">Target Persona</label>
                        <input type="text" id="settings-persona" placeholder="e.g. Startup founders">
                    </div>
                    <div class="form-group">
                        <label for="settings-tone">Message Tone</label>
                        <select id="settings-tone">
                            <option value="Curious">Curious</option>
                            <option value="Empathetic">Empathetic</option>
                            <option value="Casual">Casual Reddit-native</option>
                            <option value="Professional">Professional</option>
                        </select>
                    </div>
                    <div class="form-group">
                        <label>DM Send Mode</label>
                        <select id="settings-dm-mode">
                            <option value="confirm">Ask before sending</option>
                            <option value="auto">Auto-send</option>
                        </select>
                        <p class="help-text">Choose whether to review each DM before sending</p>
                    </div>
                    <div class="form-group">
                        <label for="settings-daily-limit">Daily DM Limit</label>
                        <input type="number" id="settings-daily-limit" min="1" max="100" value="50">
                    </div>
                    <div class="form-group">
                        <label for="settings-delay">Delay Between DMs (seconds)</label>
                        <input type="number" id="settings-delay" min="5" max="120" value="20">
                    </div>
                    <button id="save-settings-btn" class="btn-primary">Save Settings</button>
                </div>
            </div>

            <!-- Main View -->
            <div id="main-view" class="hidden">
                <header class="main-header">
                    <div class="status-indicator">
                        <span id="status-dot" class="dot inactive"></span>
                        <span id="status-text">Inactive</span>
                    </div>
                    <div class="header-actions">
                        <button id="refresh-btn" class="btn-icon" title="Refresh">🔄</button>
                        <button id="settings-btn" class="btn-icon" title="Settings">⚙️</button>
                    </div>
                </header>

                <!-- Stats Section -->
                <div id="stats-section" class="stats-grid">
                    <div class="stat-card">
                        <span class="stat-value" id="stat-today">-</span>
                        <span class="stat-label">Today</span>
                    </div>
                    <div class="stat-card">
                        <span class="stat-value" id="stat-success">-</span>
                        <span class="stat-label">Success</span>
                    </div>
                    <div class="stat-card">
                        <span class="stat-value" id="stat-remaining">-</span>
                        <span class="stat-label">Remaining</span>
                    </div>
                </div>

                <!-- Rate Limit Bar -->
                <div id="rate-limit-section" class="rate-limit-bar-container">
                    <div class="rate-limit-header">
                        <span>Daily Quota</span>
                        <span id="rate-limit-text">0 / 50</span>
                    </div>
                    <div class="rate-limit-track">
                        <div class="rate-limit-fill" id="rate-limit-fill"></div>
                    </div>
                </div>

                <!-- Tab Navigation -->
                <div class="tab-nav">
                    <button class="tab-btn active" data-tab="action">Action</button>
                    <button class="tab-btn" data-tab="history">History</button>
                    <button class="tab-btn" data-tab="queue">Queue</button>
                </div>

                <!-- Tab Content -->
                <div id="tab-content">
                    <!-- Action Tab (default) -->
                    <div id="tab-action" class="tab-panel active">
                        <div id="content-area">
                            <div class="empty-state">
                                <p>Navigate to a Reddit post to start gathering insights.</p>
                            </div>
                        </div>
                    </div>

                    <!-- History Tab -->
                    <div id="tab-history" class="tab-panel hidden">
                        <div id="history-list" class="history-list">
                            <div class="loading-state">Loading...</div>
                        </div>
                    </div>

                    <!-- Queue Tab -->
                    <div id="tab-queue" class="tab-panel hidden">
                        <div id="queue-stats" class="queue-stats">
                            <span class="queue-stat"><span id="queue-pending">0</span> pending</span>
                            <span class="queue-stat"><span id="queue-sent">0</span> sent</span>
                        </div>
                        <div id="queue-list" class="queue-list">
                            <div class="loading-state">Loading...</div>
                        </div>
                    </div>
                </div>
            </div>
        </div>
    `;

    // Inject Floating Toggle
    const toggleBtn = document.createElement('div');
    toggleBtn.className = 'floating-toggle';
    toggleBtn.title = "Toggle Sidebar (Drag to move)";
    toggleBtn.innerHTML = `
        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="white" width="24px" height="24px">
            <path d="M20 2H4c-1.1 0-2 .9-2 2v18l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2z"/>
        </svg>
    `;

    // Make draggable
    makeDraggable(toggleBtn, container);

    shadowRoot.appendChild(toggleBtn);
    shadowRoot.appendChild(container);
    sidebarContainer = container;

    // Initialize Logic
    initSidebarLogic();
    } finally {
        // Always clear injection flag, even if an error occurred
        isSidebarInjecting = false;
    }
}

function makeDraggable(element, sidebar) {
    let isDragging = false;
    let startY = 0;
    let startTop = 0;
    let hasMoved = false;

    element.addEventListener('mousedown', (e) => {
        isDragging = true;
        hasMoved = false;
        startY = e.clientY;
        startTop = element.offsetTop;
        e.preventDefault();

        document.addEventListener('mousemove', onMouseMove);
        document.addEventListener('mouseup', onMouseUp);
    });

    function onMouseMove(e) {
        if (!isDragging) return;
        const dy = e.clientY - startY;
        if (Math.abs(dy) > 3) hasMoved = true;

        let newTop = startTop + dy;
        const maxTop = window.innerHeight - element.offsetHeight;
        newTop = Math.max(0, Math.min(newTop, maxTop));
        element.style.top = `${newTop}px`;

        if (sidebar) {
            sidebar.style.top = `${newTop}px`;
        }
    }

    function onMouseUp(e) {
        isDragging = false;
        document.removeEventListener('mousemove', onMouseMove);
        document.removeEventListener('mouseup', onMouseUp);

        if (!hasMoved) {
            // Don't allow hiding sidebar during automation
            if (isAutomationRunning && !sidebar.classList.contains('hidden')) {
                reportToBackground('debug', 'Sidebar toggle prevented - automation is running', { component: 'content' });
                return;
            }
            const newState = sidebar.classList.contains('hidden');
            chrome.storage.local.set({ isSidebarOpen: newState });
            toggleSidebar(newState);
        }
    }
}

function removeSidebar() {
    const host = document.getElementById('reddit-insight-sidebar-host');
    if (host) host.remove();
    sidebarContainer = null;
    shadowRoot = null;
    isSidebarInjecting = false;
}

function toggleSidebar(isOpen) {
    isSidebarOpen = isOpen;
    if (isOpen) {
        injectSidebar();
    } else {
        removeSidebar();
    }
}

// Ensure sidebar is visible (auto-open when automation is running)
function ensureSidebarVisible() {
    isAutomationRunning = true; // Prevent sidebar from being hidden during automation
    if (!isSidebarOpen) {
        reportToBackground('debug', 'Auto-opening sidebar for automation', { component: 'content' });
        isSidebarOpen = true;
        chrome.storage.local.set({ isSidebarOpen: true });
        injectSidebar();
    }
}

// --- App Logic ---
async function initSidebarLogic() {
    const onboardingView = shadowRoot.getElementById('onboarding-view');
    const mainView = shadowRoot.getElementById('main-view');
    const settingsView = shadowRoot.getElementById('settings-view');
    const setupForm = shadowRoot.getElementById('setup-form');
    const settingsBtn = shadowRoot.getElementById('settings-btn');
    const refreshBtn = shadowRoot.getElementById('refresh-btn');
    const backFromSettings = shadowRoot.getElementById('back-from-settings');
    const saveSettingsBtn = shadowRoot.getElementById('save-settings-btn');

    const data = await chrome.storage.local.get(['businessDesc', 'persona', 'insightTypes', 'tone', 'dailyLimit', 'dmDelay']);

    if (data.businessDesc) {
        showMainView();
    } else {
        showOnboarding();
    }

    // Setup form submit
    setupForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        const businessDesc = shadowRoot.getElementById('business-desc').value;
        const persona = shadowRoot.getElementById('persona').value;
        const tone = shadowRoot.getElementById('tone').value;
        const insightCheckboxes = shadowRoot.querySelectorAll('input[name="insight"]:checked');
        const insightTypes = Array.from(insightCheckboxes).map(cb => cb.value);

        await chrome.storage.local.set({ businessDesc, persona, insightTypes, tone });
        showMainView();
    });

    // Settings button
    settingsBtn.addEventListener('click', async () => {
        const items = await chrome.storage.local.get(['businessDesc', 'persona', 'tone', 'dailyLimit', 'dmDelay', 'dmSendMode']);
        shadowRoot.getElementById('settings-business-desc').value = items.businessDesc || '';
        shadowRoot.getElementById('settings-persona').value = items.persona || '';
        shadowRoot.getElementById('settings-tone').value = items.tone || 'Curious';
        shadowRoot.getElementById('settings-dm-mode').value = items.dmSendMode || 'confirm';
        shadowRoot.getElementById('settings-daily-limit').value = items.dailyLimit || 50;
        shadowRoot.getElementById('settings-delay').value = items.dmDelay || 20;
        showSettingsView();
    });

    // Back from settings
    backFromSettings.addEventListener('click', () => {
        showMainView();
    });

    // Save settings
    saveSettingsBtn.addEventListener('click', async () => {
        const businessDesc = shadowRoot.getElementById('settings-business-desc').value;
        const persona = shadowRoot.getElementById('settings-persona').value;
        const tone = shadowRoot.getElementById('settings-tone').value;
        const dmSendMode = shadowRoot.getElementById('settings-dm-mode').value;
        const dailyLimit = parseInt(shadowRoot.getElementById('settings-daily-limit').value) || 50;
        const dmDelay = parseInt(shadowRoot.getElementById('settings-delay').value) || 20;

        await chrome.storage.local.set({ businessDesc, persona, tone, dmSendMode, dailyLimit, dmDelay });
        chrome.runtime.sendMessage({ action: 'SETTINGS_UPDATED' });
        showToast('Settings saved!', 'success');
        showMainView();
    });

    // Refresh button
    refreshBtn.addEventListener('click', () => {
        loadSidebarData();
        checkPageStatus();
        showToast('Refreshed', 'info');
    });

    // Tab navigation
    const tabBtns = shadowRoot.querySelectorAll('.tab-btn');
    tabBtns.forEach(btn => {
        btn.addEventListener('click', () => {
            const tabName = btn.getAttribute('data-tab');
            switchTab(tabName);
        });
    });

    function switchTab(tabName) {
        // Update active tab button
        shadowRoot.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
        shadowRoot.querySelector(`.tab-btn[data-tab="${tabName}"]`).classList.add('active');

        // Show active panel
        shadowRoot.querySelectorAll('.tab-panel').forEach(p => p.classList.add('hidden'));
        shadowRoot.getElementById(`tab-${tabName}`).classList.remove('hidden');

        // Load data for the tab
        if (tabName === 'history') loadHistory();
        if (tabName === 'queue') loadQueue();
    }

    function showOnboarding() {
        mainView.classList.add('hidden');
        settingsView.classList.add('hidden');
        onboardingView.classList.remove('hidden');
    }

    function showSettingsView() {
        mainView.classList.add('hidden');
        onboardingView.classList.add('hidden');
        settingsView.classList.remove('hidden');
    }

    function showMainView() {
        onboardingView.classList.add('hidden');
        settingsView.classList.add('hidden');
        mainView.classList.remove('hidden');
        loadSidebarData();
        checkPageStatus();
    }

    // Lightweight URL change detection via polling (avoids expensive MutationObserver on full DOM)
    let lastUrl = location.href;
    setInterval(() => {
        const url = location.href;
        if (url !== lastUrl) {
            lastUrl = url;
            checkPageStatus();
        }
    }, 1000);

    checkPageStatus();
}

// --- Data Loading Functions ---
async function loadSidebarData() {
    loadStats();
    loadRateLimitStatus();
}

async function loadStats() {
    if (!shadowRoot) return;

    const statToday = shadowRoot.getElementById('stat-today');
    const statSuccess = shadowRoot.getElementById('stat-success');
    const statRemaining = shadowRoot.getElementById('stat-remaining');

    if (!statToday) return;

    try {
        // Get analytics from background script
        chrome.runtime.sendMessage({ action: 'GET_ANALYTICS' }, (analytics) => {
            if (analytics) {
                statToday.textContent = analytics.todayCount || 0;
                statSuccess.textContent = analytics.successRate ? `${analytics.successRate}%` : '-';
            }
        });

        // Get rate limit status for remaining
        chrome.runtime.sendMessage({ action: 'GET_RATE_LIMIT_STATUS' }, (status) => {
            if (status) {
                const remaining = Math.max(0, status.dailyLimit - status.dailyCount);
                statRemaining.textContent = remaining;
            }
        });
    } catch (error) {
        reportToBackground('error', 'Error loading stats', { component: 'content', errorName: error?.name || error?.constructor?.name, errorStack: error?.stack });
    }
}

async function loadRateLimitStatus() {
    if (!shadowRoot) return;

    const rateLimitText = shadowRoot.getElementById('rate-limit-text');
    const rateLimitFill = shadowRoot.getElementById('rate-limit-fill');

    if (!rateLimitText || !rateLimitFill) return;

    try {
        chrome.runtime.sendMessage({ action: 'GET_RATE_LIMIT_STATUS' }, (status) => {
            if (status) {
                rateLimitText.textContent = `${status.dailyCount} / ${status.dailyLimit}`;
                const percentage = Math.min((status.dailyCount / status.dailyLimit) * 100, 100);
                rateLimitFill.style.width = `${percentage}%`;

                // Update color based on usage
                rateLimitFill.classList.remove('warning', 'danger');
                if (percentage >= 90) {
                    rateLimitFill.classList.add('danger');
                } else if (percentage >= 70) {
                    rateLimitFill.classList.add('warning');
                }
            }
        });
    } catch (error) {
        reportToBackground('error', 'Error loading rate limit', { component: 'content', errorName: error?.name || error?.constructor?.name, errorStack: error?.stack });
    }
}

async function loadHistory() {
    if (!shadowRoot) return;

    const historyList = shadowRoot.getElementById('history-list');
    if (!historyList) return;

    historyList.innerHTML = '<div class="loading-state">Loading...</div>';

    try {
        chrome.runtime.sendMessage({ action: 'GET_DM_HISTORY', limit: 10 }, (history) => {
            if (!history || history.length === 0) {
                historyList.innerHTML = '<div class="empty-state-small">No DMs sent yet</div>';
                return;
            }

            historyList.innerHTML = history.map(item => `
                <div class="history-item">
                    <div class="history-item-header">
                        <span class="history-user">u/${escapeHtml(item.recipient_username || 'Unknown')}</span>
                        <span class="history-status ${item.status}">${item.status}</span>
                    </div>
                    <div class="history-meta">
                        <span>${item.subreddit ? 'r/' + escapeHtml(item.subreddit) : ''}</span>
                        <span>${getTimeAgo(new Date(item.created_at))}</span>
                    </div>
                    ${item.message_content ? `<div class="history-message">${escapeHtml(truncateText(item.message_content, 100))}</div>` : ''}
                </div>
            `).join('');
        });
    } catch (error) {
        historyList.innerHTML = '<div class="empty-state-small">Failed to load history</div>';
    }
}

async function loadQueue() {
    if (!shadowRoot) return;

    const queueList = shadowRoot.getElementById('queue-list');
    const queuePending = shadowRoot.getElementById('queue-pending');
    const queueSent = shadowRoot.getElementById('queue-sent');

    if (!queueList) return;

    queueList.innerHTML = '<div class="loading-state">Loading...</div>';

    try {
        // Get queue stats
        chrome.runtime.sendMessage({ action: 'GET_QUEUE_STATS' }, (stats) => {
            if (stats) {
                queuePending.textContent = stats.pending || 0;
                queueSent.textContent = stats.sent || 0;
            }
        });

        // Get queue items
        chrome.runtime.sendMessage({ action: 'GET_QUEUE', status: 'pending', limit: 5 }, (items) => {
            if (!items || items.length === 0) {
                queueList.innerHTML = '<div class="empty-state-small">No pending items</div>';
                return;
            }

            queueList.innerHTML = items.map(item => `
                <div class="queue-item" data-id="${escapeHtml(item.id)}">
                    <div class="queue-item-header">
                        <span class="queue-user">u/${escapeHtml(item.recipient_username || 'Unknown')}</span>
                        ${item.relevance_score ? `<span class="queue-score">${Math.round(item.relevance_score * 100)}%</span>` : ''}
                    </div>
                    <div class="queue-message">${escapeHtml(truncateText(item.message_content || '', 80))}</div>
                    <div class="queue-actions">
                        <button class="btn-approve">Approve</button>
                        <button class="btn-reject">Reject</button>
                    </div>
                </div>
            `).join('');

            // Add event listeners for queue actions
            queueList.querySelectorAll('.btn-approve').forEach(btn => {
                btn.addEventListener('click', (e) => {
                    const itemId = e.target.closest('.queue-item').getAttribute('data-id');
                    handleQueueAction(itemId, 'approve');
                });
            });

            queueList.querySelectorAll('.btn-reject').forEach(btn => {
                btn.addEventListener('click', (e) => {
                    const itemId = e.target.closest('.queue-item').getAttribute('data-id');
                    handleQueueAction(itemId, 'reject');
                });
            });
        });
    } catch (error) {
        queueList.innerHTML = '<div class="empty-state-small">Failed to load queue</div>';
    }
}

function handleQueueAction(itemId, action) {
    chrome.runtime.sendMessage({
        action: action === 'approve' ? 'APPROVE_QUEUE_ITEM' : 'REJECT_QUEUE_ITEM',
        itemId: itemId
    }, (response) => {
        if (response && response.success) {
            showToast(`Item ${action}d`, 'success');
            loadQueue(); // Refresh queue
        } else {
            showToast(`Failed to ${action} item`, 'error');
        }
    });
}

function getTimeAgo(date) {
    const seconds = Math.floor((new Date() - date) / 1000);
    if (seconds < 60) return 'Just now';
    if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
    if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
    return `${Math.floor(seconds / 86400)}d ago`;
}

function checkPageStatus() {
    if (!shadowRoot) return;

    // Check if automation is running first
    chrome.runtime.sendMessage({ action: 'GET_AUTOMATION_STATUS' }, (status) => {
        if (status && status.isActive) {
            renderRunningState(status);
            return;
        }

        // Automation is not active, allow sidebar toggle again
        isAutomationRunning = false;

        const statusDot = shadowRoot.getElementById('status-dot');
        const statusText = shadowRoot.getElementById('status-text');
        const contentArea = shadowRoot.getElementById('content-area');

        if (!statusDot || !contentArea) return;

        statusDot.className = 'dot inactive';
        statusText.innerText = 'Inactive';

        const postData = extractPostData();

        if (postData.valid) {
            statusDot.className = 'dot ready';
            statusText.innerText = 'Ready';
            renderPostInfo(postData, contentArea);
        } else {
            const subredditData = extractSubredditData();
            if (subredditData.valid) {
                statusDot.className = 'dot ready';
                statusText.innerText = 'Subreddit Detected';
                renderSubredditInfo(subredditData, contentArea);
            } else {
                contentArea.innerHTML = '<div class="empty-state"><p>Navigate to a Reddit post or Subreddit to start.</p></div>';
            }
        }
    });
}

function showSettingsReview(onConfirm) {
    if (!shadowRoot) return;
    const contentArea = shadowRoot.getElementById('content-area');

    chrome.storage.local.get(['businessDesc', 'persona', 'tone', 'dmSendMode'], (items) => {
        contentArea.innerHTML = `
          <div class="review-panel">
            <header>
                <button id="review-back-btn" class="btn-icon" title="Back">←</button>
                <h2>Review Settings</h2>
            </header>
            <div class="form-group">
                <label for="review-business-desc">Business Description</label>
                <textarea id="review-business-desc" rows="2">${escapeHtml(items.businessDesc || '')}</textarea>
            </div>
            <div class="form-group">
                <label for="review-persona">Target Persona</label>
                <input type="text" id="review-persona" value="${escapeHtml(items.persona || '')}" placeholder="e.g. Startup founders">
            </div>
            <div class="form-group">
                <label for="review-tone">Message Tone</label>
                <select id="review-tone">
                    <option value="Curious"${items.tone === 'Curious' ? ' selected' : ''}>Curious</option>
                    <option value="Empathetic"${items.tone === 'Empathetic' ? ' selected' : ''}>Empathetic</option>
                    <option value="Casual"${items.tone === 'Casual' ? ' selected' : ''}>Casual Reddit-native</option>
                    <option value="Professional"${items.tone === 'Professional' ? ' selected' : ''}>Professional</option>
                </select>
            </div>
            <div class="form-group">
                <label for="review-dm-mode">DM Send Mode</label>
                <select id="review-dm-mode">
                    <option value="confirm"${(items.dmSendMode || 'confirm') === 'confirm' ? ' selected' : ''}>Ask before sending</option>
                    <option value="auto"${items.dmSendMode === 'auto' ? ' selected' : ''}>Auto-send</option>
                </select>
            </div>
            <div class="review-actions">
                <button id="review-cancel-btn" class="btn-cancel">Cancel</button>
                <button id="review-confirm-btn" class="btn-primary">Confirm & Start</button>
            </div>
          </div>
        `;

        shadowRoot.getElementById('review-back-btn').addEventListener('click', () => {
            checkPageStatus();
        });

        shadowRoot.getElementById('review-cancel-btn').addEventListener('click', () => {
            checkPageStatus();
        });

        shadowRoot.getElementById('review-confirm-btn').addEventListener('click', async () => {
            const businessDesc = shadowRoot.getElementById('review-business-desc').value;
            const persona = shadowRoot.getElementById('review-persona').value;
            const tone = shadowRoot.getElementById('review-tone').value;
            const dmSendMode = shadowRoot.getElementById('review-dm-mode').value;

            await chrome.storage.local.set({ businessDesc, persona, tone, dmSendMode });
            chrome.runtime.sendMessage({ action: 'SETTINGS_UPDATED' });
            onConfirm();
        });
    });
}

function renderSubredditInfo(data, container) {
    container.innerHTML = `
      <div class="post-info">
        <div class="meta">
          <span class="subreddit">r/${escapeHtml(data.name)}</span>
        </div>
        <h2 class="post-title">Found potential posts</h2>
        <p class="subtitle" style="margin-bottom: 12px; font-size: 0.9em; opacity: 0.8;">
            Ready to automate DMs for this subreddit.
        </p>
        <button id="start-sub-auto-btn" class="btn-primary">Start Subreddit Automation</button>
      </div>
    `;

    shadowRoot.getElementById('start-sub-auto-btn').addEventListener('click', async () => {
        const btn = shadowRoot.getElementById('start-sub-auto-btn');

        // Show loading state while scrolling
        btn.disabled = true;
        btn.innerHTML = '<span class="spinner"></span> Loading posts...';
        btn.classList.add('loading');

        // Add spinner styles if not present
        if (!shadowRoot.querySelector('#spinner-style')) {
            const style = document.createElement('style');
            style.id = 'spinner-style';
            style.textContent = `
                .spinner {
                    display: inline-block;
                    width: 14px;
                    height: 14px;
                    border: 2px solid rgba(255,255,255,0.3);
                    border-radius: 50%;
                    border-top-color: #fff;
                    animation: spin 0.8s linear infinite;
                    vertical-align: middle;
                    margin-right: 6px;
                }
                @keyframes spin {
                    to { transform: rotate(360deg); }
                }
                .btn-primary.loading {
                    opacity: 0.8;
                    cursor: wait;
                }
            `;
            shadowRoot.appendChild(style);
        }

        // Scroll to load 50 posts first
        reportToBackground('debug', 'Scrolling to load 50 posts...', { component: 'content' });
        await scrollToLoadPosts(50);

        // Scroll back to top after loading posts
        window.scrollTo({ top: 0, behavior: 'smooth' });
        await new Promise(resolve => setTimeout(resolve, 500));

        // Get fresh list of links after scrolling
        const links = getPostLinks();

        if (links.length === 0) {
            showToast('No posts found to automate!', 'error');
            btn.disabled = false;
            btn.innerHTML = 'Start Subreddit Automation';
            btn.classList.remove('loading');
            return;
        }

        // Show settings review before starting
        showSettingsReview(() => {
            reportToBackground('info', `Starting automation on ${links.length} posts`, { component: 'content' });

            chrome.runtime.sendMessage({
                action: 'START_SUBREDDIT_AUTOMATION',
                data: {
                    subreddit: data.name,
                    posts: links
                }
            });
        });
    });
}

function generateDMForPost(data) {
    if (!shadowRoot) return;
    const contentArea = shadowRoot.getElementById('content-area');

    // Re-render post info with loading state
    contentArea.innerHTML = `
      <div class="post-info">
        <div class="meta">
          <span class="subreddit">r/${escapeHtml(data.subreddit)}</span>
          <span class="author">u/${escapeHtml(data.author)}</span>
        </div>
        <h2 class="post-title">${truncate(data.title, 60)}</h2>
        <button id="generate-btn" class="btn-primary loading" disabled>
            <span class="spinner"></span> Generating...
        </button>
      </div>
    `;

    // Add spinner styles if not present
    if (!shadowRoot.querySelector('#spinner-style')) {
        const style = document.createElement('style');
        style.id = 'spinner-style';
        style.textContent = `
            .spinner {
                display: inline-block;
                width: 14px;
                height: 14px;
                border: 2px solid rgba(255,255,255,0.3);
                border-radius: 50%;
                border-top-color: #fff;
                animation: spin 0.8s linear infinite;
                vertical-align: middle;
                margin-right: 6px;
            }
            @keyframes spin {
                to { transform: rotate(360deg); }
            }
            .btn-primary.loading {
                opacity: 0.8;
                cursor: wait;
            }
        `;
        shadowRoot.appendChild(style);
    }

    chrome.storage.local.get(['businessDesc', 'persona', 'insightTypes', 'tone'], (settings) => {
        chrome.runtime.sendMessage({
            action: 'GENERATE_QUESTION',
            data: { post: data, settings: settings }
        }, (response) => {
            if (chrome.runtime.lastError) {
                showToast('Error: ' + chrome.runtime.lastError.message, 'error');
                checkPageStatus();
                return;
            }

            if (response && response.success) {
                showPreview(response.data, data.author, data);
            } else {
                showToast('Generation failed: ' + (response?.error || 'Unknown error'), 'error');
                checkPageStatus();
            }
        });
    });
}

function renderPostInfo(data, container) {
    container.innerHTML = `
      <div class="post-info">
        <div class="meta">
          <span class="subreddit">r/${escapeHtml(data.subreddit)}</span>
          <span class="author">u/${escapeHtml(data.author)}</span>
        </div>
        <h2 class="post-title">${truncate(data.title, 60)}</h2>
        <button id="generate-btn" class="btn-primary">Generate DM Question</button>
      </div>
    `;

    shadowRoot.getElementById('generate-btn').addEventListener('click', () => {
        showSettingsReview(() => {
            generateDMForPost(data);
        });
    });
}

function renderRunningState(status) {
    if (!shadowRoot) return;
    isAutomationRunning = true; // Prevent sidebar from being hidden during automation
    const contentArea = shadowRoot.getElementById('content-area');
    const statusDot = shadowRoot.getElementById('status-dot');
    const statusText = shadowRoot.getElementById('status-text');

    if (statusDot) {
        statusDot.className = 'dot running';
        statusText.innerText = 'Running';
    }

    let statusMessage = 'Processing...';
    let stepNumber = 0;
    const totalSteps = 5;

    switch (status.status) {
        case 'NAVIGATING_TO_POST': statusMessage = 'Navigating to post...'; stepNumber = 1; break;
        case 'WAITING_FOR_POST': statusMessage = 'Analyzing post...'; stepNumber = 1; break;
        case 'GENERATING_DM': statusMessage = 'Generating DM...'; stepNumber = 2; break;
        case 'NAVIGATING_PROFILE': statusMessage = 'Going to profile...'; stepNumber = 3; break;
        case 'WAITING_FOR_PROFILE': statusMessage = 'Loading profile...'; stepNumber = 3; break;
        case 'CLICKING_CHAT': statusMessage = 'Opening chat...'; stepNumber = 4; break;
        case 'TYPING_MESSAGE': statusMessage = 'Typing message...'; stepNumber = 5; break;
        default: stepNumber = 1;
    }

    const progressPercent = (stepNumber / totalSteps) * 100;

    // Parse queue progress
    let currentPost = 1, totalPosts = 1;
    if (status.queueProgress) {
        const match = status.queueProgress.match(/(\d+)\/(\d+)/);
        if (match) {
            currentPost = parseInt(match[1], 10);
            totalPosts = parseInt(match[2], 10);
        }
    }

    // Build classification display if available
    const classificationHtml = status.currentClassification ? `
        <div class="running-classification">
            <div class="classification-badge classification-${status.currentClassification.category}">
                <span class="classification-label">${formatCategory(status.currentClassification.category)}</span>
                <span class="classification-score">${status.currentClassification.relevanceScore || 0}%</span>
            </div>
        </div>
    ` : '';

    contentArea.innerHTML = `
      <div class="post-info running-state">
        <div class="loader-container">
            <div class="loader"></div>
        </div>
        <h2 class="post-title" style="text-align: center; margin-top: 12px;">Automation Active</h2>

        ${status.queueProgress ? `
        <div class="progress-container">
            <div class="progress-bar">
                <div class="progress-fill" style="width: ${(currentPost / totalPosts) * 100}%"></div>
            </div>
            <div class="progress-text">
                <span>Post ${currentPost} of ${totalPosts}</span>
                <span>${Math.round((currentPost / totalPosts) * 100)}%</span>
            </div>
        </div>
        ` : ''}

        ${classificationHtml}

        <p class="progress-step">${statusMessage}</p>

        <p class="shortcut-hint">Press ${(navigator.userAgentData?.platform || navigator.platform || '').toUpperCase().indexOf('MAC') >= 0 ? '<kbd>Alt</kbd>+<kbd>S</kbd>' : '<kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>S</kbd>'} to stop</p>

        <button id="stop-auto-btn" class="btn-danger" style="margin-top: 16px;">STOP AUTOMATION</button>
      </div>
    `;

    shadowRoot.getElementById('stop-auto-btn').addEventListener('click', () => {
        isAutomationRunning = false;
        chrome.runtime.sendMessage({ action: 'STOP_AUTOMATION' }, () => {
            showToast('Automation stopped', 'info');
            checkPageStatus();
        });
    });
}

// --- Toast Notifications ---
function showToast(message, type = 'info', duration = 3000) {
    if (!shadowRoot) return;

    // Create toast container if it doesn't exist
    let toastContainer = shadowRoot.querySelector('.toast-container');
    if (!toastContainer) {
        toastContainer = document.createElement('div');
        toastContainer.className = 'toast-container';
        shadowRoot.appendChild(toastContainer);
    }

    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;
    toast.textContent = message;
    toastContainer.appendChild(toast);

    // Trigger animation
    requestAnimationFrame(() => {
        toast.classList.add('show');
    });

    // Auto-remove
    setTimeout(() => {
        toast.classList.remove('show');
        setTimeout(() => toast.remove(), 300);
    }, duration);
}

// --- DM Confirmation Dialog ---
function renderDMConfirmation(data) {
    if (!shadowRoot) return;

    // Ensure sidebar is open
    if (!isSidebarOpen) {
        isSidebarOpen = true;
        injectSidebar();
        // Wait for sidebar to inject before rendering
        setTimeout(() => renderDMConfirmation(data), 500);
        return;
    }

    const contentArea = shadowRoot.getElementById('content-area');
    const statusDot = shadowRoot.getElementById('status-dot');
    const statusText = shadowRoot.getElementById('status-text');

    if (statusDot) {
        statusDot.className = 'dot pending';
        statusText.innerText = 'Pending Approval';
    }

    // Add pending dot style if not present
    if (!shadowRoot.querySelector('#pending-style')) {
        const style = document.createElement('style');
        style.id = 'pending-style';
        style.textContent = `
            .dot.pending { background-color: #ffa500; }
            .confirmation-box {
                background: var(--secondary-bg, #272729);
                border: 1px solid var(--border-color, #343536);
                border-radius: 8px;
                padding: 16px;
                margin-top: 12px;
            }
            .confirmation-header {
                display: flex;
                align-items: center;
                gap: 8px;
                margin-bottom: 12px;
            }
            .confirmation-icon {
                font-size: 24px;
            }
            .confirmation-title {
                font-size: 16px;
                font-weight: 600;
                color: var(--text-color, #d7dadc);
            }
            .confirmation-meta {
                display: flex;
                gap: 12px;
                font-size: 12px;
                color: var(--text-muted, #818384);
                margin-bottom: 12px;
            }
            .confirmation-message-label {
                font-size: 12px;
                color: var(--text-muted, #818384);
                margin-bottom: 6px;
            }
            .confirmation-message {
                width: 100%;
                background: var(--primary-bg, #1a1a1b);
                border: 1px solid var(--border-color, #343536);
                border-radius: 6px;
                padding: 10px;
                color: var(--text-color, #d7dadc);
                font-size: 13px;
                resize: vertical;
                min-height: 80px;
                font-family: inherit;
            }
            .confirmation-actions {
                display: flex;
                gap: 8px;
                margin-top: 12px;
            }
            .confirmation-actions .btn-confirm {
                flex: 1;
                background: #46a758;
                color: #fff;
                border: none;
                padding: 10px 16px;
                border-radius: 6px;
                font-size: 14px;
                font-weight: 500;
                cursor: pointer;
            }
            .confirmation-actions .btn-confirm:hover {
                background: #3d9148;
            }
            .confirmation-actions .btn-skip {
                flex: 1;
                background: transparent;
                color: var(--text-color, #d7dadc);
                border: 1px solid var(--border-color, #343536);
                padding: 10px 16px;
                border-radius: 6px;
                font-size: 14px;
                cursor: pointer;
            }
            .confirmation-actions .btn-skip:hover {
                background: var(--secondary-bg, #272729);
            }
        `;
        shadowRoot.appendChild(style);
    }

    // Build classification display for confirmation dialog
    const classificationHtml = data.classification ? `
        <div class="confirmation-classification">
            <div class="classification-header">
                <div class="classification-badge classification-${data.classification.category}">
                    <span class="classification-label">${formatCategory(data.classification.category)}</span>
                </div>
                <span class="relevance-score">${data.classification.relevanceScore || 0}% relevance</span>
            </div>
            <div class="classification-scores">
                <div class="score-item">
                    <span class="score-label">Buyer Intent</span>
                    <span class="score-value">${data.classification.buyerIntent || 0}</span>
                </div>
                <div class="score-item">
                    <span class="score-label">Problem Awareness</span>
                    <span class="score-value">${data.classification.problemAwareness || 0}</span>
                </div>
                <div class="score-item">
                    <span class="score-label">Product Fit</span>
                    <span class="score-value">${data.classification.productFit || 0}</span>
                </div>
            </div>
            ${data.classification.reasoning ? `<p class="classification-reasoning">"${escapeHtml(data.classification.reasoning)}"</p>` : ''}
        </div>
    ` : '';

    contentArea.innerHTML = `
        <div class="post-info">
            <div class="confirmation-box">
                <div class="confirmation-header">
                    <span class="confirmation-icon">📨</span>
                    <span class="confirmation-title">Review DM before sending</span>
                </div>
                <div class="confirmation-meta">
                    <span>To: <strong>u/${escapeHtml(data.targetUser)}</strong></span>
                    ${data.subreddit ? `<span>r/${escapeHtml(data.subreddit)}</span>` : ''}
                </div>
                ${data.postTitle ? `<div style="font-size: 12px; color: var(--text-muted); margin-bottom: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">"${escapeHtml(truncateText(data.postTitle, 60))}"</div>` : ''}
                ${classificationHtml}
                <div class="confirmation-message-label">Message (you can edit):</div>
                <textarea class="confirmation-message" id="confirm-message">${escapeHtml(data.message)}</textarea>
                <div class="confirmation-actions">
                    <button class="btn-skip" id="skip-dm-btn">Skip</button>
                    <button class="btn-confirm" id="confirm-dm-btn">Send DM</button>
                </div>
            </div>
        </div>
    `;

    // Add event listeners
    shadowRoot.getElementById('confirm-dm-btn').addEventListener('click', () => {
        const editedMessage = shadowRoot.getElementById('confirm-message').value;
        chrome.runtime.sendMessage({
            action: 'CONFIRM_DM',
            editedMessage: editedMessage
        });
        showToast('Sending DM...', 'info');
    });

    shadowRoot.getElementById('skip-dm-btn').addEventListener('click', () => {
        chrome.runtime.sendMessage({
            action: 'SKIP_DM'
        });
        showToast('DM skipped', 'info');
        checkPageStatus();
    });
}

// --- Error Recovery UI ---
function renderErrorState(error, context = {}) {
    if (!shadowRoot) return;

    const contentArea = shadowRoot.getElementById('content-area');
    const statusDot = shadowRoot.getElementById('status-dot');
    const statusText = shadowRoot.getElementById('status-text');

    if (statusDot) {
        statusDot.className = 'dot error';
        statusText.innerText = 'Error';
    }

    contentArea.innerHTML = `
      <div class="post-info error-state">
        <div class="error-icon">&#9888;</div>
        <h3 class="error-title">Action Failed</h3>
        <p class="error-message">${escapeHtml(error.message || String(error))}</p>
        <div class="error-details">
            ${context.targetUser ? `<span>User: u/${escapeHtml(context.targetUser)}</span>` : ''}
            ${context.step ? `<span>Step: ${escapeHtml(context.step)}</span>` : ''}
        </div>
        <div class="error-actions">
            <button id="retry-btn" class="btn-retry">Retry</button>
            <button id="skip-btn" class="btn-skip">Skip</button>
        </div>
      </div>
    `;

    // Add error dot style if not present
    if (!shadowRoot.querySelector('#error-style')) {
        const style = document.createElement('style');
        style.id = 'error-style';
        style.textContent = `
            .dot.error { background-color: #dc3545; }
            .dot.running { background-color: #ffa500; animation: pulse 1.5s infinite; }
            @keyframes pulse {
                0%, 100% { opacity: 1; }
                50% { opacity: 0.5; }
            }
        `;
        shadowRoot.appendChild(style);
    }

    shadowRoot.getElementById('retry-btn').addEventListener('click', () => {
        chrome.runtime.sendMessage({
            action: 'RETRY_AUTOMATION',
            context: context
        });
        showToast('Retrying...', 'info');
    });

    shadowRoot.getElementById('skip-btn').addEventListener('click', () => {
        chrome.runtime.sendMessage({
            action: 'SKIP_AND_CONTINUE',
            context: context
        });
        showToast('Skipped, continuing...', 'info');
        checkPageStatus();
    });
}

async function showPreview(message, author, postData = {}) {
    const contentArea = shadowRoot.getElementById('content-area');
    const postInfo = contentArea.querySelector('.post-info');
    const btn = shadowRoot.getElementById('generate-btn');
    if (btn) btn.remove();

    // Load templates
    const templates = await loadTemplates();

    const previewHtml = `
      <div class="preview-box">
        <div class="template-section">
          <label>Use Template</label>
          <select id="template-select">
            <option value="">AI Generated</option>
            ${templates.map(t => `<option value="${t.id}">${t.name}</option>`).join('')}
          </select>
        </div>
        <label>Draft Message</label>
        <textarea id="dm-message" rows="4">${escapeHtml(message)}</textarea>
        <div class="actions">
          <button id="copy-btn" class="btn-secondary">Copy</button>
          <button id="send-btn" class="btn-primary">Send DM</button>
        </div>
        <div class="template-actions">
          <button id="save-template-btn" class="btn-text">Save as Template</button>
          <button id="regenerate-btn" class="btn-text">Regenerate</button>
        </div>
        <button id="add-to-queue-btn" class="btn-outline" style="width:100%;margin-top:8px;">Add to Queue</button>
      </div>
    `;

    postInfo.insertAdjacentHTML('beforeend', previewHtml);

    // Add template section styles if not present
    if (!shadowRoot.querySelector('#template-style')) {
        const style = document.createElement('style');
        style.id = 'template-style';
        style.textContent = `
            .template-section { margin-bottom: 12px; }
            .template-section select {
                width: 100%;
                padding: 8px 12px;
                border: 1px solid var(--border-color);
                border-radius: 4px;
                background-color: var(--secondary-bg);
                color: var(--text-color);
                font-size: 13px;
                cursor: pointer;
            }
            .template-actions {
                display: flex;
                justify-content: space-between;
                margin-top: 8px;
            }
            .template-actions .btn-text { width: auto; margin-top: 0; }
        `;
        shadowRoot.appendChild(style);
    }

    // Store context for template rendering
    const templateContext = {
        author: author,
        subreddit: postData.subreddit || '',
        postTitle: postData.title || ''
    };

    // Template selector change handler
    shadowRoot.getElementById('template-select').addEventListener('change', async (e) => {
        const templateId = e.target.value;
        if (templateId) {
            const template = templates.find(t => t.id === templateId);
            if (template) {
                const rendered = renderTemplate(template.content, templateContext);
                shadowRoot.getElementById('dm-message').value = rendered;
            }
        }
    });

    shadowRoot.getElementById('copy-btn').addEventListener('click', () => {
        const text = shadowRoot.getElementById('dm-message').value;
        navigator.clipboard.writeText(text);
        const copyBtn = shadowRoot.getElementById('copy-btn');
        copyBtn.innerText = 'Copied!';
        setTimeout(() => copyBtn.innerText = 'Copy', 2000);
    });

    shadowRoot.getElementById('send-btn').addEventListener('click', async () => {
        reportToBackground('info', 'Open Chat button clicked', { component: 'content' });
        const text = shadowRoot.getElementById('dm-message').value;

        // Send message to background to start automation
        chrome.runtime.sendMessage({
            action: 'START_AUTOMATION',
            data: {
                targetUser: author,
                message: text,
                postUrl: postData.url,
                postTitle: postData.title
            }
        });

        reportToBackground('info', 'Started automation via background script', { component: 'content' });
    });

    shadowRoot.getElementById('save-template-btn').addEventListener('click', async () => {
        const text = shadowRoot.getElementById('dm-message').value;
        const name = prompt('Enter a name for this template:');

        if (name && name.trim()) {
            await saveNewTemplate(name.trim(), text);
            showToast('Template saved!', 'success');
        }
    });

    shadowRoot.getElementById('regenerate-btn').addEventListener('click', () => {
        checkPageStatus();
    });

    shadowRoot.getElementById('add-to-queue-btn').addEventListener('click', () => {
        const text = shadowRoot.getElementById('dm-message').value;
        const queueBtn = shadowRoot.getElementById('add-to-queue-btn');
        queueBtn.disabled = true;
        queueBtn.innerText = 'Adding...';

        chrome.runtime.sendMessage({
            action: 'ADD_TO_QUEUE',
            data: {
                recipientUsername: author,
                generatedMessage: text,
                subreddit: postData.subreddit || '',
                postUrl: postData.url || '',
                postTitle: postData.title || '',
                postBody: postData.body || '',
                messageType: 'outreach',
                queueMode: 'review',
                status: 'pending'
            }
        }, (response) => {
            if (response && response.success) {
                queueBtn.innerText = 'Added to Queue!';
                showToast('Added to outreach queue', 'success');
                setTimeout(() => {
                    queueBtn.innerText = 'Add to Queue';
                    queueBtn.disabled = false;
                }, 2000);
            } else {
                queueBtn.innerText = 'Add to Queue';
                queueBtn.disabled = false;
                showToast('Failed to add to queue', 'error');
            }
        });
    });
}

// Template helper functions
async function loadTemplates() {
    const data = await chrome.storage.local.get(['messageTemplates']);
    if (data.messageTemplates && data.messageTemplates.length > 0) {
        return data.messageTemplates;
    }

    // Return default templates
    return [
        { id: 'default_curious', name: 'Curious Question', content: '{{greeting}}! I saw your post about "{{post_title}}" in r/{{subreddit}}. I\'m curious - what led you to that decision?' },
        { id: 'default_empathy', name: 'Empathetic Inquiry', content: '{{greeting}}, I noticed your post in r/{{subreddit}} and it really resonated with me. Would you mind sharing more about your experience?' },
        { id: 'default_pain_point', name: 'Pain Point Discovery', content: '{{greeting}}! Reading your post in r/{{subreddit}}, I\'m wondering - what\'s been the most frustrating part of dealing with this?' },
        { id: 'default_solution', name: 'Solution Explorer', content: '{{greeting}}! Your post in r/{{subreddit}} caught my attention. Have you found any solutions that worked well for you?' }
    ];
}

function renderTemplate(template, context) {
    const greetings = ['Hey', 'Hi', 'Hello', 'Hi there'];
    const greeting = greetings[Math.floor(Math.random() * greetings.length)];

    return template
        .replace(/\{\{author\}\}/g, context.author || 'there')
        .replace(/\{\{subreddit\}\}/g, context.subreddit || '')
        .replace(/\{\{post_title\}\}/g, context.postTitle || '')
        .replace(/\{\{greeting\}\}/g, greeting);
}

async function saveNewTemplate(name, content) {
    const templates = await loadTemplates();
    const newTemplate = {
        id: `template_${Date.now()}`,
        name: name,
        content: content
    };

    templates.push(newTemplate);
    await chrome.storage.local.set({ messageTemplates: templates });
    return newTemplate;
}

// HTML sanitization to prevent XSS attacks
function escapeHtml(str) {
    if (!str) return '';
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
}

function truncate(str, n) {
    if (!str) return '';
    // Truncate first (on raw text), then escape to avoid breaking HTML entities mid-entity
    const truncated = str.length > n ? str.substring(0, n - 1) + '…' : str;
    return escapeHtml(truncated);
}

// Safe truncate that returns text (not HTML)
function truncateText(str, n) {
    if (!str) return '';
    return (str.length > n) ? str.substring(0, n - 1) + '…' : str;
}

// Format classification category for display
function formatCategory(category) {
    const labels = {
        'strong_match': 'Strong Match',
        'weak_match': 'Weak Match',
        'not_relevant': 'Not Relevant'
    };
    return labels[category] || category || 'Unknown';
}

// --- Extraction Logic ---

// Scroll to load more posts (scrolls past 28 posts to trigger infinite scroll)
async function scrollToLoadPosts(targetPostCount = 50) {
    return new Promise((resolve) => {
        let lastPostCount = 0;
        let staleCount = 0;
        let scrollAttempts = 0;
        const maxScrollAttempts = 30;

        const scrollInterval = setInterval(() => {
            const currentPosts = document.querySelectorAll('shreddit-post');
            const currentPostCount = currentPosts.length;

            reportToBackground('debug', `Scroll attempt ${scrollAttempts + 1}: Found ${currentPostCount} posts`, { component: 'content' });

            // Track consecutive scrolls with no new posts
            if (currentPostCount === lastPostCount) {
                staleCount++;
            } else {
                staleCount = 0;
            }

            // Stop if target reached, stale for 5 attempts, or max attempts hit
            if (currentPostCount >= targetPostCount ||
                staleCount >= 5 ||
                scrollAttempts >= maxScrollAttempts) {
                clearInterval(scrollInterval);
                reportToBackground('debug', `Scrolling complete. Total posts found: ${currentPostCount}`, { component: 'content' });
                resolve(currentPostCount);
                return;
            }

            lastPostCount = currentPostCount;
            scrollAttempts++;

            // Scroll down to trigger loading more posts
            window.scrollBy({
                top: window.innerHeight * 2,
                behavior: 'smooth'
            });
            // Also scroll to absolute bottom as fallback for Reddit's infinite scroll
            setTimeout(() => {
                window.scrollTo(0, document.body.scrollHeight);
            }, 500);
        }, 1500);
    });
}

function extractSubredditData() {
    const url = window.location.href;
    const match = url.match(/\/r\/([^/]+)\/?(?:$|hot|new|top|rising)/);

    if (match) {
        const posts = getPostLinks();
        if (posts.length > 0) {
            return { valid: true, name: match[1], postCount: posts.length };
        }
    }
    return { valid: false };
}

// Async version that scrolls to load 28 posts first
async function extractSubredditDataWithScroll() {
    const url = window.location.href;
    const match = url.match(/\/r\/([^/]+)\/?(?:$|hot|new|top|rising)/);

    if (match) {
        // Scroll to load at least 50 posts
        await scrollToLoadPosts(50);

        const posts = getPostLinks();
        if (posts.length > 0) {
            return { valid: true, name: match[1], postCount: posts.length };
        }
    }
    return { valid: false };
}

function getPostLinks() {
    // Select all post elements (shreddit-post is the new Reddit element)
    const posts = Array.from(document.querySelectorAll('shreddit-post'));

    // Filter out promoted/sponsored posts
    const validPosts = posts.filter(post => {
        // Check for "promoted" attribute or class
        if (post.getAttribute('promoted') === 'true') return false;

        // Double check for ad indicators inside
        if (post.querySelector('.promoted-tag')) return false;
        if (post.innerText.includes('Promoted')) return false;

        return true;
    });

    // Extract permalinks
    return validPosts.map(post => {
        // shreddit-post usually has a 'permalink' attribute
        const permalink = post.getAttribute('permalink');
        if (permalink) return `https://www.reddit.com${permalink}`;

        // Fallback to finding the link inside
        const link = post.querySelector('a[slot="full-post-link"]');
        if (link) return link.href;

        return null;
    }).filter(link => link !== null);
}

function extractPostData() {
    const url = window.location.href;
    if (!url.includes('/comments/')) {
        return { valid: false, reason: 'Not a post page' };
    }

    const title = getTitle();
    const body = getBody();
    const author = getAuthor();
    const subreddit = getSubreddit();

    if (!title) {
        return { valid: false, reason: 'Could not find post title' };
    }

    return { valid: true, title, body, author, subreddit, url };
}

function getTitle() {
    const h1 = document.querySelector('h1');
    if (h1) return h1.innerText.trim();
    const oldTitle = document.querySelector('a.title');
    if (oldTitle) return oldTitle.innerText.trim();
    return document.title.split(' : ')[0];
}

function getBody() {
    const shredditBody = document.querySelector('div[slot="text-body"]');
    if (shredditBody) return shredditBody.innerText.trim();
    const shredditContent = document.getElementById('post-content');
    if (shredditContent) return shredditContent.innerText.trim();
    const newBody = document.querySelector('div[data-click-id="text"]');
    if (newBody) return newBody.innerText.trim();
    const oldBody = document.querySelector('.entry .usertext-body .md');
    if (oldBody) return oldBody.innerText.trim();
    const metaDesc = document.querySelector('meta[name="description"]');
    if (metaDesc) return metaDesc.content;
    return '';
}

function getAuthor() {
    const shredditAuthor = document.querySelector('span[slot="authorName"]');
    if (shredditAuthor) return shredditAuthor.innerText.trim().replace('u/', '');
    const newAuthor = document.querySelector('a[href^="/user/"][data-click-id="user"]');
    if (newAuthor) return newAuthor.innerText.trim().replace('u/', '');
    const oldAuthor = document.querySelector('.tagline .author');
    if (oldAuthor) return oldAuthor.innerText.trim();
    return 'Unknown';
}

function getSubreddit() {
    const match = window.location.href.match(/\/r\/([^/]+)/);
    if (match) return match[1];
    return 'Unknown';
}

// --- Helper Functions ---
// Poll-based element finder for shadow DOM elements that MutationObserver can't detect
function pollForElement(selectorFn, timeout = 10000, interval = 500) {
    return new Promise((resolve) => {
        const element = selectorFn();
        if (element) return resolve(element);

        const start = Date.now();
        const timer = setInterval(() => {
            const element = selectorFn();
            if (element) {
                clearInterval(timer);
                resolve(element);
            } else if (Date.now() - start >= timeout) {
                clearInterval(timer);
                resolve(null);
            }
        }, interval);
    });
}

async function simulateTyping(element, text, targetUser = null) {
    reportToBackground('debug', `simulateTyping: element type: ${element.tagName} contentEditable: ${element.isContentEditable} shadow: ${!!element.getRootNode()?.host}`, { component: 'content' });
    element.focus();
    await new Promise(r => setTimeout(r, 300)); // Let focus settle

    // Visibility-aware delay: skip delays when tab is hidden
    // (browsers throttle setTimeout to ~1s+ in background tabs, freezing typing)
    let isTabVisible = document.visibilityState === 'visible';
    let resolveCurrentDelay = null;
    const onVisChange = () => {
        isTabVisible = document.visibilityState === 'visible';
        if (!isTabVisible && resolveCurrentDelay) {
            resolveCurrentDelay();
        }
    };
    document.addEventListener('visibilitychange', onVisChange);
    const typingDelay = (ms) => {
        if (!isTabVisible) return Promise.resolve();
        return new Promise(r => {
            resolveCurrentDelay = r;
            setTimeout(() => { resolveCurrentDelay = null; r(); }, ms);
        });
    };

    // Ensure cursor is positioned inside the element
    if (element.isContentEditable) {
        // Place cursor at end of contenteditable
        const sel = element.getRootNode().getSelection ? element.getRootNode().getSelection() : window.getSelection();
        if (sel) {
            sel.selectAllChildren(element);
            sel.collapseToEnd();
        }
    } else if ('setSelectionRange' in element) {
        // Place cursor at end of textarea/input
        const len = (element.value || '').length;
        element.setSelectionRange(len, len);
    }

    // Strategy 1: Try execCommand (works for both contenteditable and textarea in Chrome)
    let execCmdWorked = false;
    if (element.isContentEditable) {
        for (let i = 0; i < text.length; i++) {
            if (!isAutomationRunning) break;
            // Check element is still in DOM every 20 chars (Reddit may re-render)
            if (i > 0 && i % 20 === 0 && !element.isConnected) {
                reportToBackground('warn', `Input element detached after ${i} chars, aborting char-by-char`, { component: 'content' });
                break;
            }
            // Verify conversation hasn't changed every 50 chars
            if (targetUser && i > 0 && i % 50 === 0 && !verifyConversationUser(targetUser)) {
                reportToBackground('error', `Conversation switched during typing (expected ${targetUser}), aborting`, { component: 'content' });
                break;
            }
            document.execCommand('insertText', false, text[i]);
            await typingDelay(80);
        }
        execCmdWorked = (element.textContent || '').length > 0;
        reportToBackground('debug', `execCommand contentEditable result: ${execCmdWorked} text length: ${(element.textContent || '').length}`, { component: 'content' });
    } else {
        // For textarea: try execCommand first
        const before = element.value || '';
        document.execCommand('insertText', false, text.charAt(0));
        await typingDelay(50);
        execCmdWorked = (element.value || '') !== before;

        if (execCmdWorked) {
            // execCommand works for this textarea — type remaining chars
            reportToBackground('debug', 'execCommand works for textarea, typing remaining chars...', { component: 'content' });
            for (let i = 1; i < text.length; i++) {
                if (!isAutomationRunning) break;
                if (i % 20 === 0 && !element.isConnected) {
                    reportToBackground('warn', `Textarea element detached after ${i} chars`, { component: 'content' });
                    break;
                }
                if (targetUser && i > 0 && i % 50 === 0 && !verifyConversationUser(targetUser)) {
                    reportToBackground('error', `Conversation switched during typing (expected ${targetUser}), aborting`, { component: 'content' });
                    break;
                }
                document.execCommand('insertText', false, text[i]);
                await typingDelay(80);
            }
        } else {
            reportToBackground('debug', 'execCommand failed for textarea, using native setter approach...', { component: 'content' });
            // Strategy 2: Native value setter (bypasses React's override)
            const nativeSetter = Object.getOwnPropertyDescriptor(
                HTMLTextAreaElement.prototype, 'value'
            )?.set || Object.getOwnPropertyDescriptor(
                HTMLInputElement.prototype, 'value'
            )?.set;

            if (nativeSetter) {
                for (let i = 0; i < text.length; i++) {
                    if (!isAutomationRunning) break;
                    if (i > 0 && i % 20 === 0 && !element.isConnected) break;
                    if (targetUser && i > 0 && i % 50 === 0 && !verifyConversationUser(targetUser)) {
                        reportToBackground('error', `Conversation switched during typing (expected ${targetUser}), aborting`, { component: 'content' });
                        break;
                    }
                    nativeSetter.call(element, (element.value || '') + text[i]);
                    element.dispatchEvent(new InputEvent('input', {
                        bubbles: true,
                        composed: true,
                        inputType: 'insertText',
                        data: text[i]
                    }));
                    await typingDelay(80);
                }
            } else {
                // Strategy 3: Direct value + composed events
                for (let i = 0; i < text.length; i++) {
                    if (!isAutomationRunning) break;
                    if (targetUser && i > 0 && i % 50 === 0 && !verifyConversationUser(targetUser)) {
                        reportToBackground('error', `Conversation switched during typing (expected ${targetUser}), aborting`, { component: 'content' });
                        break;
                    }
                    element.value += text[i];
                    element.dispatchEvent(new InputEvent('input', {
                        bubbles: true,
                        composed: true,
                        inputType: 'insertText',
                        data: text[i]
                    }));
                    await typingDelay(80);
                }
            }
        }
    }

    document.removeEventListener('visibilitychange', onVisChange);

    await new Promise(r => setTimeout(r, 300));

    // Verify text was entered — check for both empty AND partial typing (e.g., only 2 letters)
    const getElementValue = (el) => el.isContentEditable
        ? (el.textContent || el.innerText || '')
        : (el.value || '');

    let currentValue = getElementValue(element);
    reportToBackground('debug', `After typing, input value length: ${currentValue.length} expected: ${text.length}`, { component: 'content' });

    // If element was detached (Reddit re-rendered), try to re-find the chat input
    if (!element.isConnected || currentValue.length < text.length * 0.5) {
        const staleReason = !element.isConnected ? 'element detached from DOM' : `only ${currentValue.length}/${text.length} chars entered`;
        reportToBackground('warn', `Typing incomplete (${staleReason}), re-finding input and retrying with bulk paste...`, { component: 'content' });

        // Re-find the active input element
        const freshInput = findChatInput() || element;
        if (freshInput !== element) {
            reportToBackground('debug', 'Found fresh chat input element after re-render', { component: 'content' });
        }

        // Clear existing partial text and bulk-paste the full message
        if (freshInput.isContentEditable) {
            freshInput.textContent = '';
            freshInput.focus();
            await new Promise(r => setTimeout(r, 100));
            freshInput.textContent = text;
            freshInput.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true, inputType: 'insertText', data: text }));
        } else {
            const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
            if (setter) setter.call(freshInput, text);
            else freshInput.value = text;
            freshInput.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true, inputType: 'insertText', data: text }));
        }
        freshInput.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
        await new Promise(r => setTimeout(r, 300));

        const retryValue = getElementValue(freshInput);
        reportToBackground('debug', `After bulk paste retry, input value length: ${retryValue.length}`, { component: 'content' });
    }

    await new Promise(r => setTimeout(r, 500));
}

// --- Visual Mouse Helper ---
// Track cursor element for cleanup
let cursorElement = null;
let cursorCleanupTimeout = null;

function cleanupCursor() {
    if (cursorElement && cursorElement.parentNode) {
        cursorElement.parentNode.removeChild(cursorElement);
        cursorElement = null;
    }
    if (cursorCleanupTimeout) {
        clearTimeout(cursorCleanupTimeout);
        cursorCleanupTimeout = null;
    }
}

async function showCursorAnimation(targetElement) {
    reportToBackground('debug', 'Showing cursor animation...', { component: 'content' });

    // Clean up any existing cursor first
    cleanupCursor();

    const cursor = document.createElement('div');
    cursor.id = 'reddit-insight-cursor';
    cursor.innerHTML = `
        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="#FF4500" width="48px" height="48px" style="filter: drop-shadow(0 2px 8px rgba(0,0,0,0.5));">
            <path d="M13.64 21.97c-.16-.02-.3-.15-.35-.31l-1.82-5.64-4.47-1.82c-.16-.06-.27-.2-.29-.36-.02-.16.05-.32.19-.41l13.99-9.99c.13-.09.29-.11.44-.04.15.06.25.2.27.36l1.98 15.99c.02.16-.07.32-.22.4-.15.07-.33.06-.47-.03l-4.81-3.59-3.9 5.63c-.1.14-.26.22-.43.22-.11 0-.22-.03-.31-.09z"/>
        </svg>
    `;
    cursor.style.position = 'fixed';
    cursor.style.zIndex = '2147483647';
    cursor.style.pointerEvents = 'none';
    cursor.style.transition = 'all 1.2s cubic-bezier(0.4, 0, 0.2, 1)';
    cursor.style.width = '48px';
    cursor.style.height = '48px';
    cursor.style.top = '50vh';
    cursor.style.left = '50vw';
    cursor.style.opacity = '0';
    document.body.appendChild(cursor);

    // Track for cleanup
    cursorElement = cursor;

    await new Promise(r => setTimeout(r, 50));
    cursor.style.opacity = '1';
    await new Promise(r => setTimeout(r, 200));

    const rect = targetElement.getBoundingClientRect();
    const targetX = rect.left + (rect.width / 2) - 24;
    const targetY = rect.top + (rect.height / 2) - 24;

    reportToBackground('debug', `Moving cursor to: ${targetX}, ${targetY}`, { component: 'content' });

    cursor.style.top = `${targetY}px`;
    cursor.style.left = `${targetX}px`;

    await new Promise(r => setTimeout(r, 1400));

    cursor.style.transform = 'scale(0.7) rotate(-10deg)';
    await new Promise(r => setTimeout(r, 150));
    cursor.style.transform = 'scale(1) rotate(0deg)';
    await new Promise(r => setTimeout(r, 150));

    reportToBackground('debug', 'Cursor animation complete', { component: 'content' });

    // Schedule cursor cleanup after animation completes (fade out and remove)
    cursor.style.opacity = '0';
    cursorCleanupTimeout = setTimeout(() => {
        cleanupCursor();
    }, 500);
}

// Start
init();
