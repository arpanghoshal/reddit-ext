// Dashboard Auth Bridge
// Lightweight content script injected only on the dashboard domain.
// Relays auth events from the dashboard page to the extension background.

const ALLOWED_ORIGINS = [
  'https://reddit-ext-dashboard.vercel.app',
  'http://localhost:5173',
  'http://localhost:3000'
];

const MESSAGE_TYPE = 'RDM_AUTH_EVENT';

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
      default:
        return;
    }

    const response = await chrome.runtime.sendMessage({ action: bgAction, payload });

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

// Notify the dashboard that the bridge is ready so it can re-broadcast existing session
window.postMessage({ type: 'RDM_BRIDGE_READY' }, '*');
