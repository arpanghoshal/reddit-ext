// Dashboard Auth Bridge
// Lightweight content script injected only on the dashboard domain.
// Relays auth events from the dashboard page to the extension background.

const ALLOWED_ORIGINS = [
  'https://reddit-ext-dashboard.vercel.app',
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
  window.postMessage({ type: 'RDM_BRIDGE_READY' }, '*');
}

announceReady();
setTimeout(announceReady, 500);
setTimeout(announceReady, 1500);
setTimeout(announceReady, 3500);

// --- Direct localStorage sync fallback ---
// The postMessage bridge depends on React broadcasting at the right time.
// This fallback injects a tiny script into the page's main world to read
// the Supabase session directly from localStorage, ensuring the extension
// gets auth tokens even if the React broadcast was missed.

let _directSyncDone = false;

async function directLocalStorageSync() {
  if (_directSyncDone) return;

  try {
    // Inject a script element that reads localStorage and posts results back
    const scriptId = '__rdm_auth_reader_' + Date.now();
    const script = document.createElement('script');
    script.id = scriptId;
    script.textContent = `
      (function() {
        try {
          var authKey = Object.keys(localStorage).find(function(k) {
            return k.startsWith('sb-') && k.endsWith('-auth-token');
          });
          if (!authKey) return;
          var raw = localStorage.getItem(authKey);
          if (!raw) return;
          var parsed = JSON.parse(raw);
          var teamId = localStorage.getItem('currentTeamId');
          window.postMessage({
            type: '__RDM_DIRECT_AUTH_SYNC',
            session: parsed,
            currentTeamId: teamId
          }, window.location.origin);
        } catch(e) {}
        var el = document.getElementById('${scriptId}');
        if (el) el.remove();
      })();
    `;
    (document.head || document.documentElement).appendChild(script);
  } catch (e) {
    // Script injection failed (CSP etc)
  }
}

// Listen for the direct sync response
window.addEventListener('message', async (event) => {
  if (event.data?.type !== '__RDM_DIRECT_AUTH_SYNC') return;
  if (_directSyncDone) return;

  const { session, currentTeamId } = event.data;
  if (!session || !session.access_token) return;

  _directSyncDone = true;

  const payload = {
    accessToken: session.access_token,
    refreshToken: session.refresh_token,
    expiresAt: session.expires_at,
    teamId: currentTeamId || null,
    teams: [],
    userEmail: session.user?.email || '',
    userName: session.user?.user_metadata?.full_name || '',
  };

  try {
    await sendToBackground({ action: 'DASHBOARD_AUTH_SYNC', payload });
    console.log('[Auth Bridge] Direct localStorage sync successful');
  } catch (e) {
    console.warn('[Auth Bridge] Direct sync failed:', e.message);
  }
});

// Run direct sync after a short delay to give the postMessage bridge a chance first
setTimeout(directLocalStorageSync, 2000);
// Retry once more in case page was still loading
setTimeout(directLocalStorageSync, 5000);
