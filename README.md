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
| `backup.sh` | Daily backup script — commits `data.json` to the private backup repo |
| `data.json` | Live database — auto-created on first save, **do not commit if repo is public** |

---

## Data & Backup

- All data lives in `data.json` in the project root.
- The browser saves to the server on every note/task/settings change.
- **Backup:** copy `data.json` somewhere safe at any time.
- **Restore:** stop the server, replace `data.json`, restart.
- `data.json` is in `.gitignore` — it is **not** committed to the source repo.

---

## Two-Repo Setup (Recommended)

Keep source code and data in separate private GitHub repositories:

| Repo | What goes in it | Visibility |
|------|----------------|------------|
| `ultranote` (this repo) | All code — `app.js`, `server.js`, `styles.css`, etc. | Private or public |
| `ultranote-backup` (separate) | `data.json` only, auto-committed by `backup.sh` | **Private** |

This means your notes are versioned independently of the code, you can roll back to any previous day's data, and the source repo stays clean.

---

## Automated Daily Backup to GitHub

### Step 1 — Create the backup repo

The backup repo is already created: `git@github.com:tvpian/Ultranote_Data.git`

### Step 2 — Generate an SSH key on the server

```bash
ssh-keygen -t ed25519 -C "ultranote-backup" -f ~/.ssh/ultranote_backup -N ""
cat ~/.ssh/ultranote_backup.pub
```

Copy the output (starts with `ssh-ed25519 ...`).

### Step 3 — Add the key to GitHub

Go to your `ultranote-backup` repo → **Settings → Deploy keys → Add deploy key**
- Title: `ultranote server`
- Key: paste the public key
- ✅ **Allow write access**

### Step 4 — Tell SSH to use this key for GitHub

Add to `~/.ssh/config`:

```
Host github-backup
  HostName github.com
  User git
  IdentityFile ~/.ssh/ultranote_backup
```

### Step 5 — Clone the backup repo

```bash
git clone git@github-backup:tvpian/Ultranote_Data.git ~/.local/share/ultranote-data
```

### Step 6 — Run a test backup

```bash
chmod +x /media/mbwh/pop/tvp_ws/note_taking_app/backup.sh
/media/mbwh/pop/tvp_ws/note_taking_app/backup.sh
```

You should see `Backup pushed successfully.` and a commit in the GitHub repo.

### Step 7 — Schedule daily midnight backups via cron

```bash
crontab -e
```

Add this line:

```
0 0 * * * /media/mbwh/pop/tvp_ws/note_taking_app/backup.sh >> /media/mbwh/pop/tvp_ws/note_taking_app/backup.log 2>&1
```

Logs are written to `backup.log` in the project folder. The script skips the commit if `data.json` hasn't changed since the last backup.

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
| `Ctrl+L` | Anywhere | Logout |
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
