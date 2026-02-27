// Dashboard Auth Bridge
// Lightweight content script injected only on the dashboard domain.
// Relays auth events from the dashboard page to the extension background.

function reportLog(level, message, opts = {}) {
    try { chrome.runtime.sendMessage({ action: 'CLIENT_LOG', data: { level, message, opts } }); } catch {}
}

const ALLOWED_ORIGINS = [
  'https://app.qualydm.com',
  'http://localhost:5173',
  'http://localhost:3000'
];

const MESSAGE_TYPE = 'RDM_AUTH_EVENT';

// Retry sending a message to the background service worker.
// MV3 service workers can be suspended; this ensures they wake up.
async function sendToBackground(message, retries = 3) {
  for (let i = 0; i <= retries; i++) {
    try {
      const response = await chrome.runtime.sendMessage(message);
      return response;
    } catch (err) {
      if (i === retries) throw err;
      // Brief pause before retry to let service worker wake up
      await new Promise(r => setTimeout(r, 300));
    }
  }
}

window.addEventListener('message', async (event) => {
  if (!ALLOWED_ORIGINS.includes(event.origin)) return;
  if (!event.data || event.data.type !== MESSAGE_TYPE) return;

  const { action, payload } = event.data;

  try {
    // PING: respond directly without hitting background
    if (action === 'PING') {
      window.postMessage({ type: 'RDM_EXTENSION_PONG' }, event.origin);
      return;
    }

    let bgAction;
    switch (action) {
      case 'LOGIN':
      case 'SESSION_RESTORE':
        bgAction = 'DASHBOARD_AUTH_SYNC';
        break;
      case 'LOGOUT':
        bgAction = 'DASHBOARD_LOGOUT_SYNC';
        break;
      case 'TEAM_SWITCH':
        bgAction = 'DASHBOARD_TEAM_SWITCH';
        break;
      case 'TOKEN_REFRESH':
        bgAction = 'DASHBOARD_TOKEN_REFRESH';
        break;
      // Outreach queue automation
      case 'START_OUTREACH_POLLING':
        bgAction = 'START_OUTREACH_QUEUE_POLLING';
        break;
      case 'STOP_OUTREACH_POLLING':
        bgAction = 'STOP_OUTREACH_QUEUE_POLLING';
        break;
      case 'GET_OUTREACH_STATUS':
        bgAction = 'GET_OUTREACH_QUEUE_STATUS';
        break;
      // Bulk chat sync
      case 'START_BULK_SYNC':
        bgAction = 'TRIGGER_START_BULK_SYNC';
        break;
      case 'CANCEL_BULK_SYNC':
        bgAction = 'TRIGGER_CANCEL_BULK_SYNC';
        break;
      default:
        return;
    }

    const response = await sendToBackground({ action: bgAction, payload });

    window.postMessage({
      type: 'RDM_AUTH_RESPONSE',
      action,
      success: true,
      data: response
    }, event.origin);
  } catch (err) {
    window.postMessage({
      type: 'RDM_AUTH_RESPONSE',
      action,
      success: false,
      error: err.message
    }, event.origin);
  }
});

// Notify the dashboard that the bridge is ready so it can re-broadcast
// existing session. Retry several times because React may not have mounted
// its listener yet when the content script first runs at document_idle.
function announceReady() {
  // Use the current page origin instead of '*' to prevent leaking messages to other frames
  window.postMessage({ type: 'RDM_BRIDGE_READY' }, window.location.origin);
}

announceReady();
setTimeout(announceReady, 500);
setTimeout(announceReady, 1500);
setTimeout(announceReady, 3500);

// --- Register this tab with the background service worker ---
// The background needs to know which tab has the dashboard open so it can
// request auth state on demand (e.g., when the popup asks for sync).
// The sender.tab.id is automatically available to the background handler.
sendToBackground({ action: 'DASHBOARD_TAB_READY' }).catch(() => {});

// --- On-demand auth request from background ---
// When the popup triggers SYNC_FROM_DASHBOARD, the background sends us this
// message. We re-announce RDM_BRIDGE_READY so the React app re-broadcasts
// the current session via the normal postMessage bridge flow.
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.action === 'REQUEST_AUTH_FROM_PAGE') {
    reportLog('debug', 'Received REQUEST_AUTH_FROM_PAGE, re-announcing ready', { component: 'auth-bridge' });
    announceReady();
    // Also announce again after a short delay in case React hasn't mounted yet
    setTimeout(announceReady, 300);
    setTimeout(announceReady, 800);
    sendResponse({ ok: true });
  }

  // Relay queue update from background so dashboard refreshes immediately
  if (msg.action === 'QUEUE_UPDATED') {
    window.postMessage({ type: 'RDM_QUEUE_UPDATED' }, window.location.origin);
  }

  // Relay bulk sync progress from background to dashboard page
  if (msg.action === 'BULK_SYNC_PROGRESS') {
    window.postMessage({
      type: 'RDM_SYNC_PROGRESS',
      action: msg.action,
      data: msg.data
    }, window.location.origin);
  }
});
