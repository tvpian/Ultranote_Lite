const $ = (id) => document.getElementById(id);

$('openOptions').addEventListener('click', (e) => {
  e.preventDefault();
  chrome.runtime.openOptionsPage();
});

$('kind').addEventListener('change', () => {
  const isLink = $('kind').value === 'link';
  $('urlLabel').style.display = isLink ? 'block' : 'none';
  $('url').style.display = isLink ? 'block' : 'none';
});

// Pull the current page's selected text (if any) into the content box —
// handy when you didn't right-click "Send selection" but opened the popup
// instead (e.g. to also set a title/tags/project before sending).
$('useSelection').addEventListener('click', async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) return;
  try {
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => window.getSelection().toString(),
    });
    if (result) $('content').value = result;
  } catch (e) {
    // Some pages (chrome://, the Web Store, etc.) block script injection — ignore.
  }
});

function setStatus(ok, text) {
  const el = $('status');
  el.textContent = text;
  el.className = ok ? 'ok' : 'err';
}

$('send').addEventListener('click', async () => {
  const kind = $('kind').value;
  const title = $('title').value.trim();
  const content = $('content').value;
  const tags = $('tags').value.split(',').map((s) => s.trim()).filter(Boolean);
  const notebook = $('notebook').value.trim();
  const project = $('project').value.trim();
  const url = $('url').value.trim();

  if (!title && !content) {
    setStatus(false, 'Enter a title or content first.');
    return;
  }
  if (kind === 'link' && !url) {
    setStatus(false, 'URL is required for links.');
    return;
  }
  if (['task', 'link', 'project'].includes(kind) && !title) {
    setStatus(false, `Title is required for kind=${kind}.`);
    return;
  }

  const payload = { kind, title, content, tags };
  if (notebook) payload.notebook = notebook;
  if (project) payload.project = project;
  if (url) payload.url = url;

  $('send').disabled = true;
  setStatus(true, 'Sending…');
  const resp = await chrome.runtime.sendMessage({ type: 'un-capture', payload });
  $('send').disabled = false;

  if (resp && resp.ok) {
    setStatus(true, `✅ Saved: ${(resp.record && (resp.record.title || resp.record.name)) || '(untitled)'}`);
    $('content').value = '';
    $('title').value = '';
  } else {
    setStatus(false, `❌ ${(resp && resp.error) || 'Unknown error'}`);
  }
});
