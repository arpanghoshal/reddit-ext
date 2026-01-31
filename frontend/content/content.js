console.log('Reddit Insight Gatherer: Content script loaded');

// --- Configuration & State ---
let isSidebarOpen = false;
let sidebarWidth = 400;
let shadowRoot = null;
let sidebarContainer = null;

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
            renderErrorState(request.error, request.context);
        } else if (request.action === 'SHOW_TOAST') {
            showToast(request.message, request.type);
        }
        return true;
    });

    // Check automation status on load
    chrome.runtime.sendMessage({ action: 'GET_AUTOMATION_STATUS' }, (status) => {
        if (status && status.isActive) {
            console.log('Resuming automation UI:', status);
            if (!isSidebarOpen) {
                isSidebarOpen = true;
                injectSidebar();
            }
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
    if (document.getElementById('reddit-insight-sidebar-host')) return;

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
                    <h1>Setup Insight Gatherer</h1>
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

            <!-- Main View -->
            <div id="main-view" class="hidden">
                <header class="main-header">
                    <div class="status-indicator">
                        <span id="status-dot" class="dot inactive"></span>
                        <span id="status-text">Inactive</span>
                    </div>
                    <button id="settings-btn" class="btn-icon" title="Settings">⚙️</button>
                </header>
                <div id="content-area">
                    <div class="empty-state">
                        <p>Navigate to a Reddit post to start gathering insights.</p>
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
}

function toggleSidebar(isOpen) {
    isSidebarOpen = isOpen;
    if (isOpen) {
        injectSidebar();
    } else {
        removeSidebar();
    }
}

// --- App Logic ---
async function initSidebarLogic() {
    const onboardingView = shadowRoot.getElementById('onboarding-view');
    const mainView = shadowRoot.getElementById('main-view');
    const setupForm = shadowRoot.getElementById('setup-form');
    const settingsBtn = shadowRoot.getElementById('settings-btn');

    const data = await chrome.storage.local.get(['businessDesc', 'persona', 'insightTypes', 'tone']);

    if (data.businessDesc) {
        showMainView();
    } else {
        showOnboarding();
    }

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

    settingsBtn.addEventListener('click', () => {
        chrome.storage.local.get(['businessDesc', 'persona', 'insightTypes', 'tone'], (items) => {
            shadowRoot.getElementById('business-desc').value = items.businessDesc || '';
            shadowRoot.getElementById('persona').value = items.persona || '';
            shadowRoot.getElementById('tone').value = items.tone || 'Curious';
            const types = items.insightTypes || [];
            shadowRoot.querySelectorAll('input[name="insight"]').forEach(cb => {
                cb.checked = types.includes(cb.value);
            });
            showOnboarding();
        });
    });

    function showOnboarding() {
        mainView.classList.add('hidden');
        onboardingView.classList.remove('hidden');
    }

    function showMainView() {
        onboardingView.classList.add('hidden');
        mainView.classList.remove('hidden');
        checkPageStatus();
    }

    let lastUrl = location.href;
    new MutationObserver(() => {
        const url = location.href;
        if (url !== lastUrl) {
            lastUrl = url;
            checkPageStatus();
        }
    }).observe(document, { subtree: true, childList: true });

    checkPageStatus();
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
          <span class="subreddit">r/${data.name}</span>
        </div>
        <h2 class="post-title">Found ${data.postCount} potential posts</h2>
        <p class="subtitle" style="margin-bottom: 12px; font-size: 0.9em; opacity: 0.8;">
            Ready to automate DMs for this subreddit.
        </p>
        <button id="start-sub-auto-btn" class="btn-primary">Start Subreddit Automation</button>
      </div>
    `;

    shadowRoot.getElementById('start-sub-auto-btn').addEventListener('click', async () => {
        const btn = shadowRoot.getElementById('start-sub-auto-btn');
        btn.disabled = true;
        btn.innerText = 'Starting...';

        // Get fresh list of links
        const links = getPostLinks();

        if (links.length === 0) {
            alert('No posts found to automate!');
            btn.disabled = false;
            btn.innerText = 'Start Subreddit Automation';
            return;
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
          <span class="subreddit">r/${data.subreddit}</span>
          <span class="author">u/${data.author}</span>
        </div>
        <h2 class="post-title">${truncate(data.title, 60)}</h2>
        <button id="generate-btn" class="btn-primary">Generate DM Question</button>
      </div>
    `;

    shadowRoot.getElementById('generate-btn').addEventListener('click', async () => {
        const btn = shadowRoot.getElementById('generate-btn');
        const originalText = btn.innerText;

        btn.disabled = true;
        btn.innerText = 'Generating...';

        try {
            const settings = await chrome.storage.local.get(['businessDesc', 'persona', 'insightTypes', 'tone']);

            chrome.runtime.sendMessage({
                action: 'GENERATE_QUESTION',
                data: { post: data, settings: settings }
            }, (response) => {
                btn.disabled = false;
                btn.innerText = originalText;

                if (chrome.runtime.lastError) {
                    alert('Error: ' + chrome.runtime.lastError.message);
                    return;
                }

                if (response && response.success) {
                    showPreview(response.data, data.author, data);
                } else {
                    alert('Generation failed: ' + (response?.error || 'Unknown error'));
                }
            });
        } catch (err) {
            btn.disabled = false;
            btn.innerText = originalText;
            alert('Error: ' + err.message);
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

        <p class="shortcut-hint">Press <kbd>Alt</kbd>+<kbd>S</kbd> to stop</p>

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
        <p class="error-message">${error.message || error}</p>
        <div class="error-details">
            ${context.targetUser ? `<span>User: u/${context.targetUser}</span>` : ''}
            ${context.step ? `<span>Step: ${context.step}</span>` : ''}
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

function truncate(str, n) {
    return (str.length > n) ? str.substr(0, n - 1) + '&hellip;' : str;
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
async function showCursorAnimation(targetElement) {
    console.log('🖱️ Showing cursor animation...');

    let cursor = document.getElementById('reddit-insight-cursor');
    if (!cursor) {
        cursor = document.createElement('div');
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

        await new Promise(r => setTimeout(r, 50));
        cursor.style.opacity = '1';
        await new Promise(r => setTimeout(r, 200));
    }

    cursor.style.opacity = '1';
    cursor.style.display = 'block';

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
}

// Start
init();
