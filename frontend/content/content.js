console.log('Reddit Automated DM: Content script loaded');

// --- Configuration & State ---
let isSidebarOpen = false;
let sidebarWidth = 400;
let shadowRoot = null;
let sidebarContainer = null;
let isSidebarInjecting = false; // Prevent race condition in sidebar injection
let lastSyncedMessages = new Set(); // Track already synced messages to avoid duplicates
let chatSyncInterval = null; // Interval for periodic chat syncing

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
    // Allow sync on dedicated chat page OR when chat panel is open on any Reddit page
    if (!isOnChatPage() && !isChatPanelOpen()) return;

    console.log('🔄 Syncing chat messages...');

    try {
        // Find all chat conversations on the page
        const conversations = extractChatConversations();

        for (const conv of conversations) {
            if (conv.messages.length === 0) continue;

            // Create a unique key for this sync batch to avoid duplicates
            const syncKey = `${conv.participantUsername}_${conv.messages.length}_${conv.messages[conv.messages.length - 1]?.content?.substring(0, 20)}`;
            if (lastSyncedMessages.has(syncKey)) continue;

            // Sync to backend
            try {
                await chrome.runtime.sendMessage({
                    action: 'SYNC_CHAT_MESSAGES',
                    data: conv
                });
                lastSyncedMessages.add(syncKey);
                console.log(`✅ Synced conversation with ${conv.participantUsername}: ${conv.messages.length} messages`);
            } catch (err) {
                console.warn('Failed to sync conversation:', err);
            }
        }
    } catch (err) {
        console.error('Chat sync error:', err);
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
            console.log('👤 Current user from rs-current-user display-name:', displayName);
            return displayName.toLowerCase();
        }

        // Check other possible attributes
        const attrs = ['username', 'user', 'name', 'data-username', 'data-user'];
        for (const attr of attrs) {
            const val = rsCurrentUser.getAttribute(attr);
            if (val && /^[a-zA-Z0-9_-]{3,20}$/.test(val)) {
                console.log('👤 Current user from rs-current-user attr:', val);
                return val.toLowerCase();
            }
        }

        // Check shadow root
        if (rsCurrentUser.shadowRoot) {
            const userEl = rsCurrentUser.shadowRoot.querySelector('a[href*="/user/"]');
            if (userEl) {
                const match = userEl.href.match(/\/user\/([^\/\?]+)/);
                if (match) {
                    console.log('👤 Current user from rs-current-user shadow:', match[1]);
                    return match[1].toLowerCase();
                }
            }
        }

        // Log attributes for debugging if we still didn't find it
        console.log('🔍 rs-current-user found but username not extracted');
    }

    // Strategy 1: Reddit's user dropdown/menu (most reliable on main Reddit)
    const userDropdown = document.querySelector('[data-testid="user-dropdown-button"]');
    if (userDropdown) {
        const nameEl = userDropdown.querySelector('span');
        if (nameEl?.textContent) {
            const username = nameEl.textContent.trim();
            if (username && /^[a-zA-Z0-9_-]{3,20}$/.test(username)) {
                console.log('👤 Current user from dropdown:', username);
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
            console.log('👤 Current user from shreddit-app:', currentUserAttr);
            return currentUserAttr.toLowerCase();
        }
    }

    // Strategy 3: Check script tags for logged-in user data
    const scripts = document.querySelectorAll('script');
    for (const script of scripts) {
        const content = script.textContent || '';
        const usernameMatch = content.match(/"(?:username|userName|logged)":\s*"([a-zA-Z0-9_-]{3,20})"/i);
        if (usernameMatch) {
            console.log('👤 Current user from script data:', usernameMatch[1]);
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
                console.log('👤 Current user from profile link:', match[1]);
                return match[1].toLowerCase();
            }
        }
    }

    // Strategy 5: Reddit's __REDDIT__ global data
    try {
        const redditData = window.__REDDIT__;
        if (redditData?.config?.user?.name) {
            console.log('👤 Current user from __REDDIT__:', redditData.config.user.name);
            return redditData.config.user.name.toLowerCase();
        }
    } catch (e) {}

    // Strategy 6: Reddit's r.config (old Reddit)
    try {
        if (window.r?.config?.logged) {
            console.log('👤 Current user from r.config:', window.r.config.logged);
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
                        console.log('👤 Current user from localStorage:', match[1]);
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
                    console.log('👤 Current user from right-aligned message:', match[1]);
                    return match[1].toLowerCase();
                }
            }
        }
    }

    console.log('⚠️ Could not determine current username');
    return null;
}

function extractChatConversations() {
    const conversations = [];

    let participantUsername = null;

    // Get current user to filter out from participant detection
    const currentUser = getCurrentUsername();
    console.log('👤 Current logged-in user:', currentUser);

    // Helper to validate participant is not current user
    const isValidParticipant = (username) => {
        if (!username) return false;
        const normalized = username.toLowerCase().trim();
        if (currentUser && normalized === currentUser) {
            console.log('⚠️ Skipping current user as participant:', username);
            return false;
        }
        return true;
    };

    // Debug: Log available elements to help identify correct selectors
    console.log('🔍 Debugging chat DOM (with Shadow DOM support)...');

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
        console.log('🔍 Found Reddit custom elements (rs-*):', [...new Set(rsElements)]);
    }

    for (const selector of roomHeaderSelectors) {
        let header = document.querySelector(selector) || querySelectorOneDeep(selector);
        if (header) {
            console.log('📍 Found room header with selector:', selector);

            // Check shadow root if exists
            const root = header.shadowRoot || header;

            // Debug: log shadow root contents
            if (header.shadowRoot) {
                const shadowHTML = header.shadowRoot.innerHTML?.substring(0, 500);
                console.log('🔍 Shadow DOM preview:', shadowHTML);
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
                    console.log('📍 Found title element with selector:', ts);
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
                    console.log('✓ Found participant from room header:', participantUsername);
                    break;
                } else if (candidate && !isValidParticipant(candidate)) {
                    console.log('⚠️ Room header returned current user, skipping:', candidate);
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
            console.log('✓ Found participant from "Redditor for" pattern:', participantUsername);
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
                            console.log('✓ Found participant from karma area:', participantUsername);
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
        console.log('📍 Found rs-rooms-nav with activeroom:', activeRoomId);

        // Find the room element with this room ID
        const activeRoom = document.querySelector(`rs-rooms-nav-room[room="${activeRoomId}"]`);
        if (activeRoom?.shadowRoot) {
            const chatLink = activeRoom.shadowRoot.querySelector('a[aria-label]');
            if (chatLink) {
                const ariaLabel = chatLink.getAttribute('aria-label');
                console.log('📍 Found aria-label from activeroom:', ariaLabel);
                const match = ariaLabel?.match(/Direct chat with ([^\s]+)/i);
                if (match && isValidParticipant(match[1])) {
                    participantUsername = match[1];
                    console.log('✓ Found username from activeroom:', participantUsername);
                }
            }
            if (!participantUsername) {
                const roomName = activeRoom.shadowRoot.querySelector('.room-name');
                if (roomName) {
                    const candidate = roomName.textContent?.trim();
                    if (isValidParticipant(candidate)) {
                        participantUsername = candidate;
                        console.log('✓ Found username from activeroom .room-name:', participantUsername);
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
            console.log('✓ Found selected rs-rooms-nav-room element');

            // Try to get username from aria-label on the link inside shadow root
            if (selectedRoom.shadowRoot) {
                const chatLink = selectedRoom.shadowRoot.querySelector('a[aria-label]');
                if (chatLink) {
                    const ariaLabel = chatLink.getAttribute('aria-label');
                    console.log('📍 Found aria-label:', ariaLabel);
                    // Pattern: "Direct chat with {username}"
                    const match = ariaLabel.match(/Direct chat with ([^\s]+)/i);
                    if (match && isValidParticipant(match[1])) {
                        participantUsername = match[1];
                        console.log('✓ Found username from aria-label:', participantUsername);
                    }
                }

                // Fallback: Get from .room-name span
                if (!participantUsername) {
                    const roomName = selectedRoom.shadowRoot.querySelector('.room-name');
                    if (roomName) {
                        const candidate = roomName.textContent?.trim();
                        if (isValidParticipant(candidate)) {
                            participantUsername = candidate;
                            console.log('✓ Found username from .room-name:', participantUsername);
                        }
                    }
                }
            }
        }
    }

    // Strategy 1b: Find any rs-rooms-nav-room and check for selected or first one
    if (!participantUsername) {
        const allRooms = document.querySelectorAll('rs-rooms-nav-room');
        console.log('🔍 Found', allRooms.length, 'rs-rooms-nav-room elements');

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
                            console.log('✓ Found username from rs-rooms-nav-room (selected):', participantUsername);
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
            console.log('📍 Found room ID in URL:', roomUrlMatch[1]);
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
                        console.log('✓ Found username from room URL match:', participantUsername);
                    }
                }
                // Try .room-name as fallback
                if (!participantUsername) {
                    const roomName = matchingRoom.shadowRoot.querySelector('.room-name');
                    if (roomName) {
                        const candidate = roomName.textContent?.trim();
                        if (isValidParticipant(candidate)) {
                            participantUsername = candidate;
                            console.log('✓ Found username from .room-name (URL match):', participantUsername);
                        }
                    }
                }
            }
        }
    }

    // Strategy 1d: URL-based detection (channel format)
    const urlMatch = window.location.href.match(/\/channel\/(\d+_\d+)/);
    if (urlMatch) {
        console.log('📍 Found channel ID in URL:', urlMatch[1]);
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
            console.log('✓ Found header with selector:', selector, 'Content:', header.textContent?.substring(0, 100));

            // Look for username link (also search in shadow DOM)
            const usernameLink = header.querySelector('a[href*="/user/"]') || querySelectorOneDeep('a[href*="/user/"]', header);
            if (usernameLink) {
                const match = usernameLink.href.match(/\/user\/([^\/\?]+)/);
                if (match && isValidParticipant(match[1])) {
                    participantUsername = match[1];
                    console.log('✓ Found username from link:', participantUsername);
                    break;
                }
            }

            // Check for u/username pattern in text
            const headerText = header.textContent;
            const uMatch = headerText.match(/u\/(\w+)/);
            if (uMatch && isValidParticipant(uMatch[1])) {
                participantUsername = uMatch[1];
                console.log('✓ Found username from u/ pattern:', participantUsername);
                break;
            }

            // Check for plain username (often the header just shows the username)
            // Look for text that looks like a username (alphanumeric, underscores, hyphens)
            const cleanText = header.textContent?.trim();
            if (cleanText && /^[a-zA-Z0-9_-]{3,20}$/.test(cleanText) && isValidParticipant(cleanText)) {
                participantUsername = cleanText;
                console.log('✓ Found username from header text:', participantUsername);
                break;
            }
        }
    }

    // Strategy 2b: Look for user links, but prioritize finding the PARTICIPANT
    // In a DM, there are 2 users. We need to find the OTHER person.
    if (!participantUsername) {
        const allUserLinks = querySelectorDeep('a[href*="/user/"]');
        console.log('🔍 Found', allUserLinks.length, 'user links in DOM (including shadow)');

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

        console.log('🔍 Unique usernames found:', [...usernames]);

        // If we found exactly 2 usernames in a DM, and we know currentUser, use the other one
        if (usernames.size === 2 && currentUser) {
            for (const username of usernames) {
                if (username !== currentUser) {
                    participantUsername = username;
                    console.log('✓ Found participant by elimination (2 users, excluding current):', participantUsername);
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
                            console.log('✓ Found username from user link (not in nav):', participantUsername);
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
        console.log('📄 Page title:', title);

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
                console.log('✓ Found username from title:', participantUsername);
                break;
            }
        }
    }

    // Strategy 4: URL patterns
    if (!participantUsername) {
        const userMatch = window.location.href.match(/\/user\/([^\/\?]+)/);
        if (userMatch && isValidParticipant(userMatch[1])) {
            participantUsername = userMatch[1];
            console.log('✓ Found username from URL:', participantUsername);
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
                    console.log('✓ Found username from element:', participantUsername, 'Selector:', selector);
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
                        console.log('✓ Found username from active conversation:', participantUsername);
                    }
                }
            }
        }
    }

    // Debug: If still not found, log what we can see
    if (!participantUsername) {
        console.log('❌ Could not determine chat participant');

        // Log user links from both regular DOM and shadow DOMs
        const regularUserLinks = Array.from(document.querySelectorAll('a[href*="/user/"]')).map(a => a.href);
        const deepUserLinks = querySelectorDeep('a[href*="/user/"]').map(a => a.href);
        console.log('🔍 User links in regular DOM:', regularUserLinks.slice(0, 5));
        console.log('🔍 User links in shadow DOM:', deepUserLinks.filter(l => !regularUserLinks.includes(l)).slice(0, 5));

        // Check for shadow roots
        const shadowHostCount = document.querySelectorAll('*').length;
        let shadowRootCount = 0;
        document.querySelectorAll('*').forEach(el => { if (el.shadowRoot) shadowRootCount++; });
        console.log('🔍 Elements with shadow roots:', shadowRootCount, 'out of', shadowHostCount, 'elements');

        // Log elements with "username" class from shadow DOM
        const usernameElements = querySelectorDeep('[class*="username"], [class*="Username"], [class*="mx_"]');
        console.log('🔍 Username-related elements (including shadow DOM):', usernameElements.length);
        usernameElements.slice(0, 5).forEach(el => {
            console.log('  -', el.tagName, el.className, 'text:', el.textContent?.substring(0, 30));
        });

        console.log('🔍 Page URL:', window.location.href);

        // Last resort: try to get any visible username-like text from the header area
        const possibleHeaders = querySelectorDeep('h1, h2, h3, [role="heading"]');
        possibleHeaders.forEach(h => {
            const text = h.textContent?.trim();
            if (text && /^[a-zA-Z0-9_-]{3,20}$/.test(text)) {
                console.log('🔍 Possible username in heading:', text);
            }
        });

        // Try to extract username from page text as last resort
        const pageText = getDeepTextContent(document.body);
        const usernameMatches = pageText.match(/u\/([a-zA-Z0-9_-]{3,20})/g);
        if (usernameMatches && usernameMatches.length > 0) {
            console.log('🔍 Found u/username patterns in page text:', [...new Set(usernameMatches)].slice(0, 5));
            // Try to use the first non-common username that isn't the current user
            for (const match of usernameMatches) {
                const username = match.replace('u/', '');
                if (!['me', 'user', 'reddit', 'admin'].includes(username.toLowerCase()) && isValidParticipant(username)) {
                    participantUsername = username;
                    console.log('✓ Found username from page text:', participantUsername);
                    break;
                }
            }
        }

        if (!participantUsername) {
            return conversations;
        }
    }

    console.log(`Chat participant: ${participantUsername}`);

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
    const containerSelectors = [
        '[data-testid="chat-room"]',
        '[data-testid="message-list"]',
        '[class*="ChatRoom"]',
        '[class*="MessageList"]',
        '[class*="chat-messages"]',
        '[role="log"]', // Accessibility role for chat
        'div[class*="room"]',
        '[class*="Thread"]',
        // Reddit Matrix chat selectors
        '[class*="mx_RoomView_body"]',
        '[class*="mx_MessagePanel"]',
        '[class*="mx_RoomView_MessageList"]',
        '[class*="mx_ScrollPanel"]',
    ];

    let chatContainer = null;
    for (const selector of containerSelectors) {
        // Try regular DOM first
        chatContainer = document.querySelector(selector);
        if (chatContainer) {
            console.log('✓ Found chat container with selector:', selector);
            break;
        }
        // Try shadow DOM
        chatContainer = querySelectorOneDeep(selector);
        if (chatContainer) {
            console.log('✓ Found chat container in shadow DOM with selector:', selector);
            break;
        }
    }

    if (!chatContainer) {
        console.log('Could not find chat container, trying to find messages directly...');
        // Fall back to finding messages anywhere in the page
    }

    // Strategy 2: Find message elements within container (with Shadow DOM support)
    const messageSelectors = [
        '[data-testid="message"]',
        '[class*="Message_container"]',
        '[class*="message-container"]',
        '[class*="ChatMessage"]',
        'div[class*="message"]:not([class*="messages"])',
        '[role="listitem"]', // Accessibility role for messages
        // Reddit Matrix chat selectors
        '[class*="mx_EventTile"]',
        '[class*="mx_MTextBody"]',
        '[class*="mx_EventTile_content"]',
    ];

    let messageElements = [];
    const searchRoot = chatContainer || document.body;

    for (const selector of messageSelectors) {
        // Try regular DOM first
        let elements = searchRoot.querySelectorAll(selector);
        if (elements.length === 0) {
            // Try shadow DOM
            elements = querySelectorDeep(selector, searchRoot);
        }
        if (elements.length > 0) {
            messageElements = Array.from(elements);
            console.log(`Found ${elements.length} messages with selector: ${selector}`);
            break;
        }
    }

    // Fallback: Try to find any elements that look like messages
    if (messageElements.length === 0 && chatContainer) {
        const allDivs = chatContainer.querySelectorAll('div');
        messageElements = Array.from(allDivs).filter(div => {
            const text = div.textContent?.trim();
            // Messages typically have some text and aren't too long (not containers)
            return text && text.length > 5 && text.length < 2000 &&
                   div.children.length < 10; // Likely a leaf node
        });
    }

    // Extract message data
    messageElements.forEach((el) => {
        // Get message content - try multiple approaches
        let content = '';

        // Try to find the actual text content element
        const textEl = el.querySelector('[class*="content"]') ||
                      el.querySelector('[class*="text"]') ||
                      el.querySelector('p') ||
                      el;

        content = textEl?.textContent?.trim() || '';

        // Skip if no content, too short, or already seen
        if (!content || content.length < 2 || content.length > 5000 || seenContent.has(content)) {
            return;
        }

        // Skip UI elements (buttons, timestamps alone, etc.)
        if (content.match(/^(Send|Reply|Edit|Delete|Cancel|Save|\d{1,2}:\d{2}|Today|Yesterday)$/i)) {
            return;
        }

        seenContent.add(content);

        // Determine direction (outbound = sent by user, inbound = received)
        // Reddit typically marks own messages differently
        const isOutbound = el.classList.toString().toLowerCase().includes('own') ||
                          el.classList.toString().toLowerCase().includes('self') ||
                          el.classList.toString().toLowerCase().includes('sent') ||
                          el.closest('[class*="own"]') !== null ||
                          el.closest('[class*="self"]') !== null ||
                          el.closest('[class*="outgoing"]') !== null ||
                          el.getAttribute('data-is-own') === 'true' ||
                          // Check computed style - own messages often aligned right
                          (el.style.marginLeft === 'auto' ||
                           getComputedStyle(el).marginLeft === 'auto');

        // Try to get timestamp
        const timeEl = el.querySelector('time') ||
                      el.querySelector('[class*="time"]') ||
                      el.querySelector('[class*="timestamp"]') ||
                      el.querySelector('[datetime]');
        const sentAt = timeEl?.getAttribute('datetime') ||
                      timeEl?.getAttribute('title') ||
                      new Date().toISOString();

        messages.push({
            direction: isOutbound ? 'outbound' : 'inbound',
            content: content,
            sentAt: sentAt,
            isAiGenerated: false
        });
    });

    console.log(`Extracted ${messages.length} messages`);
    return messages;
}

function startChatSync() {
    if (chatSyncInterval) return; // Already running

    console.log('📡 Starting chat sync monitoring...');

    // Function to check and sync if chat is visible
    const checkAndSync = () => {
        if (hasChatElements()) {
            console.log('🔄 Chat detected, syncing...');
            syncChatMessages();
        }
    };

    // Initial check after page load
    setTimeout(checkAndSync, 2000);

    // Periodic sync every 30 seconds
    chatSyncInterval = setInterval(checkAndSync, 30000);

    // Watch for chat panel opening (DOM mutations)
    const chatObserver = new MutationObserver((mutations) => {
        // Check if chat elements were added
        for (const mutation of mutations) {
            if (mutation.addedNodes.length > 0) {
                // Small delay to let chat fully render
                setTimeout(() => {
                    if (hasChatElements()) {
                        console.log('💬 Chat panel opened, syncing...');
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
            setTimeout(checkAndSync, 1000);
        }
    }).observe(document, { subtree: true, childList: true });
}

function stopChatSync() {
    if (chatSyncInterval) {
        clearInterval(chatSyncInterval);
        chatSyncInterval = null;
    }
}

// --- Initialization ---
async function init() {
    console.log('📍 Content script init() called on:', window.location.href);
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
        if (request.action === 'TOGGLE_SIDEBAR') {
            toggleSidebar(request.isOpen);
        } else if (request.action === 'GET_POST_DATA') {
            sendResponse(extractPostData());
        } else if (request.action === 'EXECUTE_ACTION') {
            // Handle automation commands from background
            handleAutomationCommand(request)
                .then(result => sendResponse(result))
                .catch(err => sendResponse({ success: false, error: err.message }));
            return true; // Keep channel open for async response
        } else if (request.action === 'AUTOMATION_STOPPED') {
            showToast('Automation stopped', 'info');
            checkPageStatus();
        } else if (request.action === 'AUTOMATION_ERROR') {
            ensureSidebarVisible();
            setTimeout(() => renderErrorState(request.error, request.context), 300);
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
        }
        return true;
    });

    // Check automation status on load
    chrome.runtime.sendMessage({ action: 'GET_AUTOMATION_STATUS' }, (status) => {
        if (status && status.isActive) {
            console.log('Resuming automation UI:', status);
            ensureSidebarVisible();
            // We need to wait for sidebar to inject
            setTimeout(() => renderRunningState(status), 500);
        }
    });

    // Listen for storage changes (to sync across tabs)
    chrome.storage.onChanged.addListener((changes, area) => {
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
        // Ctrl+Shift+R (Windows/Linux) or Alt+R (Mac) to toggle sidebar
        const isMac = navigator.platform.toUpperCase().indexOf('MAC') >= 0;
        const isToggleShortcut = isMac
            ? (e.altKey && e.key.toLowerCase() === 'r')
            : (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === 'r');

        if (isToggleShortcut) {
            e.preventDefault();
            console.log('Toggle sidebar shortcut pressed (fallback handler)');
            const newState = !isSidebarOpen;
            chrome.storage.local.set({ isSidebarOpen: newState });
            toggleSidebar(newState);
        }
    });
}

// --- Automation Command Handler ---
async function handleAutomationCommand(request) {
    console.log('📬 Received automation command:', request.command);

    switch (request.command) {
        case 'CLICK_CHAT_BUTTON':
            return await executeClickChat();

        case 'TYPE_MESSAGE':
            return await executeTypeMessage(request.text);

        default:
            return { success: false, error: `Unknown command: ${request.command}` };
    }
}

async function executeClickChat() {
    console.log('🔍 Looking for Chat button...');

    const findChatButton = () => {
        // Priority 1: data-testid="private-chat-button" (new Reddit anchor)
        const chatTestId = document.querySelector('[data-testid="private-chat-button"]');
        if (chatTestId) {
            console.log('✓ Found via data-testid="private-chat-button"');
            return chatTestId;
        }

        // Priority 2: aria-label="Open chat"
        const ariaChat = document.querySelector('[aria-label="Open chat"]');
        if (ariaChat) {
            console.log('✓ Found via aria-label="Open chat"');
            return ariaChat;
        }

        // Priority 3: Link to chat.reddit.com
        const chatLink = document.querySelector('a[href*="chat.reddit.com"]');
        if (chatLink) {
            console.log('✓ Found via href containing chat.reddit.com');
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
            console.log('✓ Found via text content');
            return chatBtn;
        }

        // Priority 6: Links to /chat/ path
        const chatPathLink = document.querySelector('a[href^="/chat/"]');
        if (chatPathLink) return chatPathLink;

        return null;
    };

    const chatBtn = await waitForElement(findChatButton, 8000);

    if (chatBtn) {
        console.log('✓ Chat button found. Animating cursor...');
        await showCursorAnimation(chatBtn);
        console.log('Clicking chat button...');
        chatBtn.click();

        // Notify background that step is complete
        chrome.runtime.sendMessage({
            action: 'AUTOMATION_STEP_COMPLETE',
            result: { success: true, step: 'CLICK_CHAT_BUTTON' }
        });

        return { success: true };
    } else {
        console.error('❌ Could not find Chat button');
        chrome.runtime.sendMessage({
            action: 'AUTOMATION_STEP_COMPLETE',
            result: { success: false, error: 'Chat button not found', step: 'CLICK_CHAT_BUTTON' }
        });
        return { success: false, error: 'Chat button not found' };
    }
}

async function executeTypeMessage(text) {
    console.log('🔍 Looking for chat input...');

    const findChatInput = () => {
        // Helper to search recursively through Shadow DOMs
        const findInShadow = (root) => {
            if (!root) return null;

            // Check current root
            const textareaByName = root.querySelector('textarea[name="message"]');
            if (textareaByName) return textareaByName;

            const textareaByAria = root.querySelector('textarea[aria-label="Write message"]');
            if (textareaByAria) return textareaByAria;

            const contentEditable = root.querySelector('div[contenteditable="true"][role="textbox"]');
            if (contentEditable) return contentEditable;

            const fallback = root.querySelector('textarea[placeholder="Message"]');
            if (fallback) return fallback;

            // Recurse into children with shadow roots
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
        if (mainDocResult) {
            console.log('✓ Found chat input in main document/shadow tree');
            return mainDocResult;
        }

        return null;
    };

    const input = await waitForElement(findChatInput, 10000);

    if (input) {
        console.log('✓ Chat input found. Typing message...');

        // Show cursor animation on input first
        await showCursorAnimation(input);

        // Type the message
        await simulateTyping(input, text);

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

        const sendBtn = await waitForElement(findSendButton, 3000);
        if (sendBtn) {
            console.log('✓ Send button found. Animating cursor...');
            await showCursorAnimation(sendBtn);

            console.log('Clicking send button...');
            sendBtn.click();

            console.log('🎉 Message sent successfully!');

            // --- CLOSE CHAT LOGIC REMOVED ---
            console.log('Automation stopping here as requested.');

        } else {
            console.warn('⚠️ Send button not found. Message typed but not sent.');
        }

        chrome.runtime.sendMessage({
            action: 'AUTOMATION_STEP_COMPLETE',
            result: { success: true, step: 'TYPE_MESSAGE' }
        });

        return { success: true };
    } else {
        console.error('❌ Could not find chat input');
        chrome.runtime.sendMessage({
            action: 'AUTOMATION_STEP_COMPLETE',
            result: { success: false, error: 'Chat input not found', step: 'TYPE_MESSAGE' }
        });
        return { success: false, error: 'Chat input not found' };
    }
}

// --- Sidebar Injection ---
function injectSidebar() {
    // Prevent race condition: check both DOM and flag
    if (document.getElementById('reddit-insight-sidebar-host') || isSidebarInjecting) return;
    isSidebarInjecting = true;

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
    container.className = 'sidebar-container hidden';
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

    // Clear injection flag
    isSidebarInjecting = false;

    // Initialize Logic
    initSidebarLogic();
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
            sidebar.classList.toggle('hidden');
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
    if (!isSidebarOpen) {
        console.log('🔓 Auto-opening sidebar for automation');
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

    // Debounced URL change detection to prevent excessive UI rebuilds
    let lastUrl = location.href;
    let urlChangeTimeout = null;

    new MutationObserver(() => {
        const url = location.href;
        if (url !== lastUrl) {
            lastUrl = url;

            // Debounce: wait 500ms after last URL change before updating UI
            if (urlChangeTimeout) {
                clearTimeout(urlChangeTimeout);
            }
            urlChangeTimeout = setTimeout(() => {
                urlChangeTimeout = null;
                checkPageStatus();
            }, 500);
        }
    }).observe(document, { subtree: true, childList: true });

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
        console.log('Error loading stats:', error);
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
        console.log('Error loading rate limit:', error);
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
                <div class="queue-item" data-id="${item.id}">
                    <div class="queue-item-header">
                        <span class="queue-user">u/${escapeHtml(item.recipient_username || 'Unknown')}</span>
                        ${item.relevance_score ? `<span class="queue-score">${Math.round(item.relevance_score * 100)}%</span>` : ''}
                    </div>
                    <div class="queue-message">${escapeHtml(truncateText(item.message_content || '', 80))}</div>
                    <div class="queue-actions">
                        <button class="btn-approve" onclick="approveQueueItem('${item.id}')">Approve</button>
                        <button class="btn-reject" onclick="rejectQueueItem('${item.id}')">Reject</button>
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

function renderSubredditInfo(data, container) {
    container.innerHTML = `
      <div class="post-info">
        <div class="meta">
          <span class="subreddit">r/${escapeHtml(data.name)}</span>
        </div>
        <h2 class="post-title">Found ${parseInt(data.postCount, 10) || 0} potential posts</h2>
        <p class="subtitle" style="margin-bottom: 12px; font-size: 0.9em; opacity: 0.8;">
            Ready to automate DMs for this subreddit.
        </p>
        <button id="start-sub-auto-btn" class="btn-primary">Start Subreddit Automation</button>
      </div>
    `;

    shadowRoot.getElementById('start-sub-auto-btn').addEventListener('click', async () => {
        const btn = shadowRoot.getElementById('start-sub-auto-btn');

        // Get fresh list of links
        const links = getPostLinks();

        if (links.length === 0) {
            showToast('No posts found to automate!', 'error');
            return;
        }

        // Show confirmation dialog
        const confirmed = confirm(
            `Start automation for ${links.length} posts in r/${escapeHtml(data.name)}?\n\n` +
            `This will:\n` +
            `• Navigate to each post\n` +
            `• Generate a personalized DM\n` +
            `• Send the DM to the post author\n\n` +
            `You can stop at any time by pressing Alt+S.`
        );

        if (!confirmed) {
            return;
        }

        btn.disabled = true;
        btn.innerHTML = '<span class="spinner"></span> Starting...';
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

        console.log(`Starting automation on ${links.length} posts`);

        chrome.runtime.sendMessage({
            action: 'START_SUBREDDIT_AUTOMATION',
            data: {
                subreddit: data.name,
                posts: links
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

    shadowRoot.getElementById('generate-btn').addEventListener('click', async () => {
        const btn = shadowRoot.getElementById('generate-btn');
        const originalText = btn.innerText;

        btn.disabled = true;
        btn.innerHTML = '<span class="spinner"></span> Generating...';
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

        try {
            const settings = await chrome.storage.local.get(['businessDesc', 'persona', 'insightTypes', 'tone']);

            chrome.runtime.sendMessage({
                action: 'GENERATE_QUESTION',
                data: { post: data, settings: settings }
            }, (response) => {
                btn.disabled = false;
                btn.innerText = originalText;
                btn.classList.remove('loading');

                if (chrome.runtime.lastError) {
                    showToast('Error: ' + chrome.runtime.lastError.message, 'error');
                    return;
                }

                if (response && response.success) {
                    showPreview(response.data, data.author, data);
                } else {
                    showToast('Generation failed: ' + (response?.error || 'Unknown error'), 'error');
                }
            });
        } catch (err) {
            btn.disabled = false;
            btn.innerText = originalText;
            btn.classList.remove('loading');
            showToast('Error: ' + err.message, 'error');
        }
    });
}

function renderRunningState(status) {
    if (!shadowRoot) return;
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

        <p class="progress-step">${statusMessage}</p>

        <p class="shortcut-hint">Press ${navigator.platform.toUpperCase().indexOf('MAC') >= 0 ? '<kbd>Alt</kbd>+<kbd>S</kbd>' : '<kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>S</kbd>'} to stop</p>

        <button id="stop-auto-btn" class="btn-danger" style="margin-top: 16px;">STOP AUTOMATION</button>
      </div>
    `;

    shadowRoot.getElementById('stop-auto-btn').addEventListener('click', () => {
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
        <textarea id="dm-message" rows="4">${message}</textarea>
        <div class="actions">
          <button id="copy-btn" class="btn-secondary">Copy</button>
          <button id="send-btn" class="btn-primary">Send DM</button>
        </div>
        <div class="template-actions">
          <button id="save-template-btn" class="btn-text">Save as Template</button>
          <button id="regenerate-btn" class="btn-text">Regenerate</button>
        </div>
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
        console.log('🚀 Open Chat button clicked');
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

        console.log('✓ Started automation via background script');
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
    // First escape HTML, then truncate
    const escaped = escapeHtml(str);
    return (escaped.length > n) ? escaped.substring(0, n - 1) + '…' : escaped;
}

// Safe truncate that returns text (not HTML)
function truncateText(str, n) {
    if (!str) return '';
    return (str.length > n) ? str.substring(0, n - 1) + '…' : str;
}

// --- Extraction Logic ---
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
function waitForElement(selectorFn, timeout = 5000) {
    return new Promise((resolve) => {
        const element = selectorFn();
        if (element) return resolve(element);

        const observer = new MutationObserver(() => {
            const element = selectorFn();
            if (element) {
                observer.disconnect();
                resolve(element);
            }
        });

        observer.observe(document.body, { childList: true, subtree: true });

        setTimeout(() => {
            observer.disconnect();
            resolve(null);
        }, timeout);
    });
}

async function simulateTyping(element, text) {
    element.focus();

    if (element.isContentEditable) {
        for (let i = 0; i < text.length; i++) {
            document.execCommand('insertText', false, text[i]);
            await new Promise(r => setTimeout(r, 100)); // Slower typing
        }
    } else {
        for (let i = 0; i < text.length; i++) {
            element.value += text[i];
            element.dispatchEvent(new Event('input', { bubbles: true }));
            await new Promise(r => setTimeout(r, 100)); // Slower typing
        }
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
    console.log('🖱️ Showing cursor animation...');

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

    console.log(`Moving cursor to: ${targetX}, ${targetY}`);

    cursor.style.top = `${targetY}px`;
    cursor.style.left = `${targetX}px`;

    await new Promise(r => setTimeout(r, 1400));

    cursor.style.transform = 'scale(0.7) rotate(-10deg)';
    await new Promise(r => setTimeout(r, 150));
    cursor.style.transform = 'scale(1) rotate(0deg)';
    await new Promise(r => setTimeout(r, 150));

    console.log('✓ Cursor animation complete');

    // Schedule cursor cleanup after animation completes (fade out and remove)
    cursor.style.opacity = '0';
    cursorCleanupTimeout = setTimeout(() => {
        cleanupCursor();
    }, 500);
}

// Start
init();
