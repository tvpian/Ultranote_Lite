// Background service worker for the UltraNote Capture extension.
//
// Two entry points into UltraNote's POST /api/agent/capture:
//  1. Right-click "Send selection to UltraNote…" on any highlighted text
//     on any page (see contextMenus below).
//  2. Messages forwarded from popup.js (the manual paste-and-send form).
//
// All network calls live here (not in popup.js / content scripts) so there
// is exactly one place that knows about the host/token and one place that
// needs the granted host permission — see options.js for how that
// permission is requested per-host at save time.

const MENU_ID = 'send-selection-to-ultranote';

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: MENU_ID,
    title: 'Send selection to UltraNote…',
    contexts: ['selection'],
  });
});

async function getConfig() {
  const cfg = await chrome.storage.local.get(['un_host', 'un_token', 'un_defaultKind']);
  return {
    host: (cfg.un_host || '').replace(/\/+$/, ''),
    token: cfg.un_token || '',
    defaultKind: cfg.un_defaultKind || 'note',
  };
}

// Core capture call, shared by the context menu handler and the popup.
async function captureToUltraNote(payload) {
  const { host, token } = await getConfig();
  if (!host || !token) {
    return { ok: false, error: 'Configure the UltraNote host + token in the extension options first.' };
  }
  try {
    const res = await fetch(`${host}/api/agent/capture`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        // Required by the server's CSRF guard on every /api/* POST.
        'X-Requested-With': 'XMLHttpRequest',
        'Authorization': `Bearer ${token}`,
      },
      body: JSON.stringify(payload),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) return { ok: false, error: body.error || `HTTP ${res.status}` };
    return { ok: true, record: body.record };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
}

// Lightweight, asset-free feedback for the context-menu flow (avoids needing
// the "notifications" permission + a bundled icon just for a checkmark).
function flashBadge(ok) {
  chrome.action.setBadgeText({ text: ok ? '\u2713' : '\u00d7' });
  chrome.action.setBadgeBackgroundColor({ color: ok ? '#2e7d32' : '#c62828' });
  setTimeout(() => chrome.action.setBadgeText({ text: '' }), 3000);
}

chrome.contextMenus.onClicked.addListener(async (info) => {
  if (info.menuItemId !== MENU_ID || !info.selectionText) return;
  const { defaultKind } = await getConfig();
  const result = await captureToUltraNote({ kind: defaultKind, content: info.selectionText });
  flashBadge(result.ok);
  if (!result.ok) console.warn('UltraNote capture failed:', result.error);
});

// Messages from popup.js
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg && msg.type === 'un-capture') {
    captureToUltraNote(msg.payload).then(sendResponse);
    return true; // keep the message channel open for the async response
  }
  if (msg && msg.type === 'un-test-connection') {
    (async () => {
      const { host, token } = await getConfig();
      if (!host || !token) return sendResponse({ ok: false, error: 'Host/token not configured.' });
      try {
        // /api/search is on the server's agent-token allow-list and is
        // read-only, so this proves host+token both work without writing
        // any test data.
        const res = await fetch(`${host}/api/search?q=__connection_test__`, {
          headers: { 'Authorization': `Bearer ${token}` },
        });
        if (res.status === 401) return sendResponse({ ok: false, error: 'Rejected: invalid token.' });
        if (!res.ok) return sendResponse({ ok: false, error: `HTTP ${res.status}` });
        sendResponse({ ok: true });
      } catch (e) {
        sendResponse({ ok: false, error: String((e && e.message) || e) });
      }
    })();
    return true;
  }
});
