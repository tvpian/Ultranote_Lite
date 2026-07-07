const $ = (id) => document.getElementById(id);

async function load() {
  const cfg = await chrome.storage.local.get(['un_host', 'un_token', 'un_defaultKind']);
  $('host').value = cfg.un_host || '';
  $('token').value = cfg.un_token || '';
  $('defaultKind').value = cfg.un_defaultKind || 'note';
}
load();

function setStatus(ok, text) {
  const el = $('status');
  el.textContent = text;
  el.className = ok ? 'ok' : 'err';
}

$('save').addEventListener('click', async () => {
  const host = $('host').value.trim().replace(/\/+$/, '');
  const token = $('token').value.trim();
  const defaultKind = $('defaultKind').value;

  if (!host || !/^https?:\/\//i.test(host)) {
    setStatus(false, 'Host must start with http:// or https://');
    return;
  }
  if (!token) {
    setStatus(false, 'Token is required.');
    return;
  }

  // Request host permission for this specific origin at save-time (the MV3
  // optional_host_permissions pattern) — the extension only ever gets
  // network access to the exact host you configure here, nothing broader.
  let origin;
  try {
    origin = new URL(host).origin + '/*';
  } catch (e) {
    setStatus(false, 'Could not parse that host as a URL.');
    return;
  }
  const granted = await chrome.permissions.request({ origins: [origin] });
  if (!granted) {
    setStatus(false, 'Permission to access that host was not granted — cannot save.');
    return;
  }

  await chrome.storage.local.set({ un_host: host, un_token: token, un_defaultKind: defaultKind });
  setStatus(true, '✅ Saved.');
});

$('test').addEventListener('click', async () => {
  setStatus(true, 'Testing…');
  const resp = await chrome.runtime.sendMessage({ type: 'un-test-connection' });
  if (resp && resp.ok) setStatus(true, '✅ Connected — token accepted.');
  else setStatus(false, `❌ ${(resp && resp.error) || 'Failed'}`);
});
