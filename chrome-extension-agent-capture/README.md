# UltraNote Capture (Chrome extension)

A small reference Chrome extension that sends content straight into your
UltraNote Lite instance via `POST /api/agent/capture`, so you don't have to
copy-paste results (e.g. from an OSINT research skill, ChatGPT, Gemini, or any
web page) back into the app manually.

It works two ways:

1. **Right-click → "Send selection to UltraNote…"** on any highlighted text
   on any page. Uses your configured *default kind* (Note / Idea / Person /
   Paper).
2. **Toolbar popup** — paste content, pick a kind (note, idea, person, paper,
   notebook page, task, link, project), optionally set a title/tags/
   notebook/project, and send.

## Setup

1. `chrome://extensions` → enable **Developer mode** → **Load unpacked** →
   select this `chrome-extension-agent-capture/` folder.
2. Click the extension's icon → **Configure host / token** (or right-click
   the icon → Options).
3. Fill in:
   - **UltraNote host URL** — the address this browser can reach your app
     at (e.g. your Tailscale `https://your-machine.ts.net` or
     `http://100.x.x.x:3366`). No trailing slash.
   - **Agent API token** — the `AGENT_API_TOKEN` value from the app's
     `.env` file (see `server.js` in the main repo).
4. Click **Save** — Chrome will prompt you to grant access to that specific
   host (the extension only ever gets network access to the host you
   configure here, nothing broader).
5. Click **Test connection** to confirm the token is accepted before relying
   on it.

## Using it

- **Quick capture from any page**: select text → right-click → "Send
  selection to UltraNote…". A small ✓/✗ badge flashes on the extension icon
  to confirm success/failure (check the background service worker's console
  via `chrome://extensions` → "service worker" link if something fails).
- **Full control**: click the extension icon to open the popup, paste your
  content, pick the right `kind`, optionally set title/tags/notebook/
  project, and hit **Send to UltraNote**.

### `kind` reference

| kind | Goes to | Notes |
|---|---|---|
| `note` | Notes | plain note |
| `idea` | Notes (type=idea) | |
| `person` | People notebook | title auto-extracted from a leading `# Name` line if left blank — paste a full OSINT-skill dossier as-is |
| `paper` | Notes | auto-tagged `paper` |
| `page` | Any notebook | requires `notebook` (name) or `notebookId` |
| `task` | Tasks | requires `title` |
| `link` | Links | requires `title` + `url` |
| `project` | Projects | requires `title` (used as the project name) |

## Merging this into your existing OSINT-skill extension

If you already have a Chrome extension running your prompt-driven research
skill and want it to auto-post its output instead of you copy-pasting the
result, you don't need this whole extension — just port over the core
function from `background.js`:

```js
async function captureToUltraNote(payload) {
  const host = 'https://your-machine.ts.net';      // or read from chrome.storage
  const token = 'YOUR_AGENT_API_TOKEN';             // ditto — don't hardcode in shipped code
  const res = await fetch(`${host}/api/agent/capture`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Requested-With': 'XMLHttpRequest',
      'Authorization': `Bearer ${token}`,
    },
    body: JSON.stringify(payload),
  });
  return res.json();
}

// Wherever your skill currently produces its final dossier markdown:
await captureToUltraNote({ kind: 'person', content: dossierMarkdown });
```

Requirements for this to work from your existing extension:
- It must run from a **background/service worker context** (or a context
  with the right `host_permissions`/`optional_host_permissions` granted for
  your UltraNote host) — a content script injected into a third-party page
  (e.g. the Gemini/ChatGPT web UI) is still subject to normal CORS rules,
  and the server does not send CORS headers.
- Add your UltraNote host to `host_permissions` (or request it at runtime via
  `chrome.permissions.request`, as `options.js` in this folder does) in your
  existing extension's `manifest.json`.

## Security notes

- The extension only ever talks to the exact host you configure — MV3
  `optional_host_permissions` + a runtime `chrome.permissions.request` call,
  not a broad `<all_urls>` grant.
- The token is stored in `chrome.storage.local` (per-profile, not synced) and
  never leaves the browser except as the `Authorization` header on requests
  to your configured host.
- `/api/agent/capture` on the server is create-only — even if this token
  leaked, it can add content but can never edit or delete anything that
  already exists (see `server.js`'s `AGENT_TOKEN_PATHS` for the full
  server-side reasoning).
