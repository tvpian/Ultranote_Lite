# UltraNote Lite

A local‑first, single‑page productivity and knowledge app (Daily / Projects / Ideas / Vault / Review) designed for speed, clarity, and data ownership. Runs directly from `index.html` (no build step) but can optionally persist to a lightweight Node/Express JSON backend.

---
## Contents
- [Key Features](#key-features)
- [Modes of Use](#modes-of-use)
- [Quick Start (Pure Static)](#quick-start-pure-static)
- [Optional Backend Persistence](#optional-backend-persistence)
- [Systemd Service (Auto Start After Reboot)](#systemd-service-auto-start-after-reboot)
- [Data Model](#data-model)
- [Feature Guide](#feature-guide)
  - [Daily Notes](#daily-notes)
  - [Tasks & Status Flow](#tasks--status-flow)
  - [Rollover vs Auto-Carry](#rollover-vs-auto-carry)
  - [Backlog Tasks](#backlog-tasks)
  - [Projects & Project Notes](#projects--project-notes)
  - [Ideas](#ideas)
  - [Draft Note Workflow](#draft-note-workflow)
  - [Vault (Global Search & Access)](#vault-global-search--access)
  - [Review Dashboard](#review-dashboard)
  - [Sketch Canvas](#sketch-canvas)
  - [Calendar & Date Navigation](#calendar--date-navigation)
  - [Deletion / Duplication / Export](#deletion--duplication--export)
- [Keyboard & Interaction Tips](#keyboard--interaction-tips)
- [Backup & Restore](#backup--restore)
- [Roadmap / Future Ideas](#roadmap--future-ideas)
- [License](#license)

---
## Key Features
- Local‑first: Fully functional via plain `file://` open in a modern browser.
- Optional JSON backend persistence (`/api/db`) for durability across browsers/devices on LAN.
- Daily journaling with explicit creation (no accidental blank days).
- Intelligent Task Flow: TODO → DONE / BACKLOG with Pending + Backlog review panels.
- Rollover & Auto-Carry logic only when creating *today’s* daily note.
- Backlog segregation (excluded from productivity analytics, easily restorable).
- Draft note editing (no premature persistence until you Save).
- Project notes & task grouping with progress stats.
- Idea capture with quick list + open-for-detail editor.
- Global Vault search (notes & metadata).
- Review dashboard: Analytics, Project Progress, Pending Tasks, Backlog Tasks, Recent Daily Logs, Tag Cloud.
- Embedded Sketch canvas (quick visual notes) per note.
- Responsive layout (desktop sidebar / mobile bottom bar).

---
## Modes of Use
| Mode | What You Get | Persistence Layer |
|------|--------------|-------------------|
| Pure Static | Everything except cross-device syncing | Browser `localStorage` |
| Static + Backend | Full feature set with durable JSON file & multi-device (same LAN) | Node/Express JSON (`data.json`) + localStorage fallback |

---
## Quick Start (Pure Static)
1. Clone or unzip.
2. Double‑click `index.html` (Chrome / Edge / Firefox).
3. Start using: create a Daily note or explore Projects / Ideas / Vault / Review.
4. Data stays in your browser’s `localStorage` (per browser & machine).

Optional lightweight static serve (avoids some browser isolation quirks):
```
python -m http.server 5173
# OR
auth npx serve -p 5173
```
Navigate to http://localhost:5173/

---
## Optional Backend Persistence
Enables a shared JSON datastore on disk (and across devices on the same network).

1. Create `server.js` (if not already present) in the project root:
```js
const express = require('express');
const fs = require('fs');
const path = require('path');
const app = express();
const DB_PATH = path.join(__dirname, 'data.json');
app.use(express.json({ limit: '2mb' }));

function load() {
  if (!fs.existsSync(DB_PATH)) return { notes: [], tasks: [], projects: [], ideas: [], settings: {}, createdAt: Date.now() };
  return JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
}
app.get('/api/db', (req,res)=>{ res.json(load()); });
app.post('/api/db', (req,res)=>{ fs.writeFileSync(DB_PATH, JSON.stringify(req.body, null, 2)); res.json({ ok: true }); });
app.use(express.static(__dirname));
const PORT = process.env.PORT || 3000;
app.listen(PORT, ()=> console.log('UltraNote backend on', PORT));
```
2. Install dependencies:
```
npm init -y
npm install express
```
3. Run:
```
node server.js
```
4. Open in browser: http://localhost:3000/index.html
5. The app will load from `/api/db`; saves are debounced and POST the full DB.
6. You can backup `data.json` at any time (see Backup section).

---
## Systemd Service (Auto Start After Reboot)
(Adjust paths / user as needed.)

1. Create service user (optional but recommended):
```
sudo useradd -r -s /usr/sbin/nologin noteapp
sudo chown -R noteapp:noteapp /media/mbwh/pop/tvp_ws/note_taking_app
```
2. Service file `/etc/systemd/system/noteapp.service`:
```
[Unit]
Description=UltraNote Backend
After=network-online.target
Wants=network-online.target

[Service]
WorkingDirectory=/media/mbwh/pop/tvp_ws/note_taking_app
ExecStart=/usr/bin/env node server.js
Restart=always
RestartSec=5
User=noteapp
Environment=NODE_ENV=production PORT=3000

[Install]
WantedBy=multi-user.target
```
3. Enable & start:
```
sudo systemctl daemon-reload
sudo systemctl enable --now noteapp
```
4. Logs / status:
```
systemctl status noteapp
journalctl -u noteapp -f
```

---
## Data Model
(Conceptual – actual stored object extended over time.)
```
{
  notes: [ { id, type: 'daily'|'note'|'idea', title, content, date?, projectId?, tags?:[], createdAt, updatedAt } ],
  tasks: [ { id, title, status: 'TODO'|'DONE'|'BACKLOG', projectId?, dailyId?, createdAt, doneAt?, backlogAt? } ],
  projects: [ { id, name, createdAt } ],
  ideas: [ { id, title, content, createdAt, updatedAt } ],
  settings: { ... },
  // additional derived fields may appear as features grow
}
```

---
## Feature Guide
### Daily Notes
- Choose a date via sidebar picker or prev/next buttons.
- If no daily exists for that date you see an "Open/Create Daily" button.
- Only when creating *today's* daily: incomplete tasks from yesterday roll over and top priority project tasks auto-carry.

### Tasks & Status Flow
- Add tasks inside a daily or a project context.
- Status buttons / toggles update to DONE or move to BACKLOG.
- Pending Tasks panel (Review) aggregates all TODO tasks not in backlog.

### Rollover vs Auto-Carry
- Rollover: Incomplete tasks from the previous day's daily note copied when you explicitly create today’s daily.
- Auto-Carry: Select top-priority (implementation: chosen subset) project tasks pulled into the new daily for visibility.
- Both happen only on explicit creation (no passive browsing side effects).

### Backlog Tasks
- Mark tasks as BACKLOG to remove them from analytics and daily clutter.
- View & restore them on the Review page (Backlog Tasks panel) or project view.
- Restoring returns status to TODO.

### Projects & Project Notes
- Each project can have tasks + associated notes (opened in the editor).
- Progress calculations exclude BACKLOG tasks; show completed vs total active.

### Ideas
- Quick capture list with title.
- Click Open to expand into full editable note (description + sketch optional).
- Newly created ideas auto-open for elaboration.

### Draft Note Workflow
- Draft mode lets you edit before committing to the database.
- Only saved when you click Save (avoids clutter and accidental empty notes).

### Vault (Global Search & Access)
- Search across notes (title/content) & jump directly to an item.
- Useful for resurfacing older dailies or project notes.

### Review Dashboard
Panels include:
- Analytics (task completion stats excluding backlog).
- Project Progress summary.
- Pending Tasks (all active TODO items).
- Backlog Tasks (all BACKLOG items with restore/open actions).
- Recent Daily Logs (quick jump to recent dates).
- Tag Cloud (if tags used).

### Sketch Canvas
- Accessible within a note editor for quick diagrams / scribbles.
- Opens a modal; drawing saved (implementation may store raster data or encoded path set – check code if extending).

### Calendar & Date Navigation
- Sidebar date picker sets `selectedDailyDate`.
- Prev / Next buttons move one day.
- No automatic note creation—explicit action required (prevents blank days).

### Deletion / Duplication / Export
- Note editor offers Delete (permanent), Duplicate (clone), Export (download as file / text) where implemented.
- Tasks can be removed or status-changed; backlog acts as a soft parking area.

---
## Keyboard & Interaction Tips
- Enter in task input: quick create.
- Debounced save (~400ms) – rapid edits are batched.
- Use browser back/forward cautiously (SPA state internal; prefer in-app navigation).

---
## Backup & Restore
- With backend: copy `data.json` regularly (e.g., cron). Example cron (daily at 01:00):
```
0 1 * * * cp /media/mbwh/pop/tvp_ws/note_taking_app/data.json /media/mbwh/pop/tvp_ws/note_taking_app/backups/data-$(date +\%F).json
```
- Pure static mode: use the Export functionality (if present) or manually copy `localStorage` via DevTools Application tab (recommended to switch to backend for reliable backups).
- To restore: stop server, replace `data.json`, restart.

---
## Roadmap / Future Ideas
- Service worker & offline sync queue.
- Diff-based (partial) persistence instead of full DB POST.
- Visual provenance for tasks (rolled over vs auto-carried vs manual).
- Enhanced sketch (pressure sensitivity, eraser, vector strokes).
- Backlog filters in Vault.
- Draft autosave indicator + listing.
- Optional encryption layer.

---
## License
Personal use unless a license file is added. Add an explicit LICENSE if distributing.

---
## Contributing
Open an issue or submit patches (keep dependencies minimal). Focus on clarity over abstraction.

---
### Support / Questions
Document issues or enhancement ideas for faster iteration.
