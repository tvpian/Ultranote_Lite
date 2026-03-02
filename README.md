# UltraNote

A personal knowledge and productivity workspace — daily notes, tasks, projects, notebooks, ideas, links, and a journal, all in one self-hosted app. Runs on a single Node.js server, stores everything in a local JSON file, and works offline via a service worker.

---

## Features

| Section | What it does |
|---------|-------------|
| **Today** | Daily note with customizable template, scratchpad, task inbox, task rollover/backlog, journal |
| **Projects** | Project list, per-project notes and tasks, task status (TODO / DONE / BACKLOG), due dates, priorities |
| **Ideas** | Freeform idea notes, pin, tag, search |
| **Notebooks** | Multi-page notebooks with markdown support |
| **Vault** | Global search across all notes, tasks, projects, links |
| **Links** | Save, tag, and manage reference links |
| **Monthly** | Monthly planning view |
| **Review** | Soft-deleted (trashable/restorable) notes and tasks |
| **Journal** | Persistent journal section on the Today page |

**Cross-cutting:**
- Markdown editor with toolbar, live preview toggle (Ctrl+Shift+V), and Ctrl+S to save
- "Saved ✓" inline confirmation on every save
- Pin, tag, due-date badges (overdue / due today / due soon)
- Monthly task carry-forward
- Sketch canvas — draw and embed diagrams into notes
- Voice memo attachment
- Template manager (meeting notes, project plan, weekly review, course notes, execution log + custom)
- Auto-sync across browser sessions (polling)
- Responsive layout with mobile bottom bar
- Dark theme with CSS variable theming
- Password-protected login with rate limiting and lockout
- PWA / offline support via service worker

---

## Quick Start

### Prerequisites

- Node.js ≥ 18
- npm

### 1. Clone and install

```bash
git clone <repo-url>
cd note_taking_app
npm install
```

### 2. Set your password

Open `ecosystem.config.js` and set `APP_PASSWORD`:

```js
env: { NODE_ENV: "production", PORT: 3366, APP_PASSWORD: "your-password-here" }
```

> If you skip this the server falls back to `change-me`. Change it before exposing to any network.

### 3. Run

**Development (direct node):**
```bash
APP_PASSWORD=yourpassword node server.js
# Open http://localhost:3366
```

**Production with PM2 (recommended):**
```bash
npm install -g pm2
pm2 start ecosystem.config.js
pm2 save
pm2 startup   # run the printed command to auto-start on reboot
```

**Useful PM2 commands:**
```bash
pm2 logs ultranote       # live logs
pm2 restart ultranote    # restart after config changes
pm2 stop ultranote       # stop
pm2 delete ultranote     # remove from PM2
```

---

## Authentication

- All non-localhost visitors are shown a login page before accessing the app.
- Password is set via the `APP_PASSWORD` environment variable in `ecosystem.config.js`.
- **5 failed attempts** trigger a **2-minute lockout**.
- Sessions last **24 hours**.
- IPs listed in `allowedIps` in `server.js` bypass login — `127.0.0.1` / `::1` are always allowed. Add your LAN or VPN IP there if needed.
- The session secret is hardcoded in `server.js` — change it for anything beyond personal local use.

---

## Files

| File | Purpose |
|------|---------|
| `server.js` | Express server — static files, `/api/db` persistence, login/auth, session handling |
| `app.js` | All client-side logic — rendering, state, keyboard shortcuts, modals, all views |
| `index.html` | HTML shell — layout containers (nav, content, modals) and bootstrap script |
| `styles.css` | All styles — theme tokens, layout, responsive rules, component styles |
| `sw.js` | Service worker — offline caching (bump `CACHE` version string after every deploy) |
| `autosync.js` | Auto-sync polling — keeps multiple open tabs in sync |
| `ecosystem.config.js` | PM2 config — port, password, file watch list |
| `package.json` | Dependencies |
| `quotes.json` | Quotes shown on the login screen |
| `data.json` | Live database — auto-created on first save, **do not commit if repo is public** |

---

## Data & Backup

- All data lives in `data.json` in the project root.
- The browser saves to the server on every note/task/settings change.
- **Backup:** copy `data.json` somewhere safe at any time.
- **Restore:** stop the server, replace `data.json`, restart.
- `data.json` is in `.gitignore` by default.

---

## API

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/db` | Returns the full database as JSON |
| `POST` | `/api/db` | Replaces the database with the posted JSON body |
| `GET` | `/login` | Login page |
| `POST` | `/login` | Submit password |
| `GET` | `/logout` | Clear session and redirect to login |

All endpoints require an authenticated session (or a whitelisted IP).

---

## Keyboard Shortcuts

| Shortcut | Where | Action |
|----------|-------|--------|
| `Ctrl+S` | Note editor, daily page, draft, notebook page | Save |
| `Ctrl+Shift+V` | Note editor | Toggle markdown preview |
| `Enter` | Task quick-add input | Add task |

---

## Service Worker & Caching

Static assets are cached under a versioned name in `sw.js` (e.g. `ultranote-lite-v7-full`).

**After any deploy that changes `app.js`, `styles.css`, `index.html`, or `sw.js`:**
1. Bump the cache version string in `sw.js`
2. Restart PM2 (`pm2 restart ultranote`)
3. Each user needs a hard refresh (Ctrl+Shift+R) once, after which the new service worker takes over automatically

---

## Troubleshooting

| Symptom | Likely cause | Fix |
|---------|-------------|-----|
| Port 3366 already in use | Previous instance still running | `lsof -i :3366` → kill the PID, or change `PORT` in `ecosystem.config.js` |
| Code changes not showing | Old service worker serving cached files | Bump cache version in `sw.js`, hard refresh (Ctrl+Shift+R) |
| Data not saving | `data.json` permission error or server crash | `pm2 logs ultranote` — check for write permission errors |
| Login loop | Cookie / session issue | Ensure browser allows cookies for the site; restart the server |
| Daily note not created | First visit | Open the Today tab and click the create prompt |
| PM2 process named `-f` | Flag accidentally used as name | `pm2 delete all`, then `pm2 start ecosystem.config.js` |
| Changes on remote machine not syncing | Auto-sync off or browser tab in background | Toggle "Auto-sync" in the app header, or reload the tab |

---

## Security Notes

- Do **not** expose this directly on a public IP without HTTPS and a reverse proxy (nginx / Caddy).
- The `/api/db` POST does a full database overwrite — there is no field-level validation; it trusts authenticated sessions.
- Change the session secret in `server.js` before sharing with others.

---

## Data Model

```jsonc
{
  "notes": [{
    "id": "string", "title": "string", "content": "string",
    "type": "daily | note | idea",
    "dateIndex": "YYYY-MM-DD",   // daily notes only
    "projectId": "string | null",
    "tags": ["string"], "pinned": false,
    "createdAt": "ISO", "updatedAt": "ISO", "deletedAt": "ISO | null"
  }],
  "tasks": [{
    "id": "string", "title": "string",
    "status": "TODO | DONE | BACKLOG",
    "noteId": "string | null", "projectId": "string | null",
    "due": "YYYY-MM-DD | null", "priority": "high | medium | low",
    "createdAt": "ISO", "completedAt": "ISO | null", "deletedAt": "ISO | null"
  }],
  "projects":  [{ "id": "string", "name": "string", "createdAt": "ISO" }],
  "notebooks": [{ "id": "string", "name": "string", "createdAt": "ISO" }],
  "pages":     [{ "id": "string", "notebookId": "string", "title": "string", "content": "string", "createdAt": "ISO", "updatedAt": "ISO" }],
  "links":     [{ "id": "string", "title": "string", "url": "string", "tags": [], "pinned": false, "createdAt": "ISO" }],
  "templates": [{ "id": "string", "name": "string", "content": "string", "createdAt": "ISO" }],
  "settings": {
    "rollover": true,
    "autoCarryTasks": false,
    "dailyTemplate": "string",
    "theme": "dark"
  }
}
```

---

## License

MIT — Copyright (c) 2025 Tharun V Puthanveettil
