# UltraNote Lite

Lightweight, local‑first note + daily logging + task system with optional Express JSON persistence. Mobile friendly, keyboard centric, themable.

## Features (current)

- Daily notes (template driven) with unfinished task rollover/backlog
- General notes, ideas, project notes, links (CRUD, pin, tag)
- Tasks with status (TODO/DONE/BACKLOG), optional due dates, quick add
- Project list & filtering
- Links management + tagging (shared tag system with notes)
- Global Vault search (notes, links, tasks, projects)
- Templates manager (default + custom)
  - Meeting Notes
  - Project Plan
  - Weekly Review
  - Course / Lecture Notes
  - Project Execution Log
- Tag extraction via #tag syntax
- Custom modal dialogs (confirm/prompt) for consistent UI
- Attachments / sketches (referenced by sketchModal styles)
- Keyboard shortcuts (quick add, navigation)*
- Local storage + background sync to server (data.json)
- Responsive drawer navigation & mobile bottom bar
- Simple theming via CSS variables
- Export (DB / individual note)*

(*If some features not yet fully modularized they reside in `app.js`.)

## Files Overview

| File | Purpose |
|------|---------|
| `index.html` | Base HTML shell; loads `styles.css` & `app.js`; contains app layout containers (nav, content, modals). |
| `styles.css` | Extracted stylesheet: theme tokens, layout, responsive rules, modal + sketch + mobile bar styles. |
| `app.js` | All client logic: state/store, persistence (`/api/db` + localStorage), models (notes/tasks/projects/templates/links), rendering (navigation, pages), search, modals, rollover, tagging, backlog, attachments. (Monolithic pending modular split.) |
| `server.js` | Minimal Express 5 API: serves static files & JSON DB at `/api/db` (GET/POST) persisted to `data.json`. |
| `package.json` | Dependency manifest (no scripts yet). |
| `data.json` (runtime) | Persisted state (created after first save). |

### Dependencies (not all may be fully wired yet)

- `express` – backend API
- `prismjs` / `@types/prismjs` – code highlighting
- `@fortawesome/*` – icons
- `pptxgenjs` – potential export to slides
- `sharp`, `image-size` – image processing (attachments/thumbnails)
- `tailwindcss`, `postcss`, `autoprefixer` – (future utility build; currently custom CSS is primary)
- `typescript`, `ts-node` – planned TS migration

## Data Model (simplified)

```
{
  notes: [{ id, title, content, type(daily|note|idea), dateIndex?, projectId?, tags[], pinned, createdAt, updatedAt }],
  tasks: [{ id, title, status:TODO|DONE|BACKLOG, noteId?, projectId?, due?, priority, createdAt, completedAt? }],
  projects: [{ id, name, createdAt }],
  templates: [{ id, name, content, createdAt }],
  links: [{ id, title, url, tags[], pinned, status, createdAt, updatedAt }],
  settings: { rollover, seenTip, autoCarryTasks, dailyTemplate, ... }
}
```

## API

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/db` | Returns full DB JSON (empty object if none). |
| POST | `/api/db` | Replaces DB with posted JSON object. |

(No auth; intended for local use.)

## Running

### 1. Install deps
```
npm install
```

### 2. Start backend + static serving
```
node server.js
# Visit http://localhost:3366
```

### 3. PM2 (production-ish)
```
npm install -g pm2
pm2 start server.js --name ultranote
pm2 logs ultranote
pm2 save
pm2 startup   # follow printed instructions
```

Optional ecosystem file:
```
pm2 start ecosystem.config.js
```

### 4. Pure static (read‑only / localStorage only)
```
npx http-server .
# (But /api/db calls will 404)
```

## Persistence & Backup

- Primary live state: in‑memory within page + localStorage key `ultranote-lite`
- Server sync: periodic / debounced POST to `/api/db` writing `data.json`
- Manual backup: copy `data.json` or export (in UI)*
- Restore: replace `data.json` (stop server first if cautious)

## Templates

Names & purposes:

1. Meeting Notes – structured meeting capture
2. Project Plan – objective, milestones, risks
3. Weekly Review – reflection / planning
4. Course / Lecture Notes – concept & question oriented capture
5. Project Execution Log – operational session log (steps, decisions, issues)

Daily template customizable via settings (fields in `settings.dailyTemplate`).

## Keyboard (typical defaults)*

- Navigation via sidebar buttons
- Enter in quick task input adds task
- Custom key handlers located in `app.js` (search for `keydown`)

(*Exact mapping: inspect `app.js` since modular refactor pending.)

## Modularization Roadmap

Planned split (see discussion):
```
js/
  utils.js
  store.js
  persistence.js
  models.js
  router.js
  views/
    today.js
    projects.js
    ideas.js
    links.js
    vault.js
    review.js
    templates.js
    noteEditor.js
  components/
  index.js
```
Incrementally move logic from `app.js` into these modules.

## Development Tips

- Keep `data.json` out of version control if personal data (add to `.gitignore`).
- Consider adding `scripts` in `package.json`:
```
"scripts": {
  "start": "node server.js",
  "dev": "node server.js",
  "pm2": "pm2 start server.js --name ultranote"
}
```
- For TypeScript migration, introduce a `src/` directory and compile to `dist/`.

## Security Notes

- No authentication / CORS restrictions; do not expose publicly as‑is.
- JSON overwrite endpoint trusts client—add auth or token if deploying.

## Troubleshooting

| Issue | Cause | Fix |
|-------|-------|-----|
| PM2 app named `-f` | Misplaced flag | `pm2 delete all` then start with proper syntax |
| Port in use | Previous instance | `lsof -i :3366`, kill or change `PORT` |
| data not saving | FS permission or crash | Check `~/.pm2/logs/*.log` or console output |
| Daily note not created | Deferred creation | Open Today tab & click create prompt |

## License

MIT License

Copyright (c) 2025 Tharun V Puthanveettil

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the “Software”), to deal
in the Software without restriction, including without limitation the rights…
[full standard MIT text continues]


## Acknowledgements

Font Awesome, PrismJS, Express, TailwindCSS ecosystem.

---

For further modularization or test scaffolding ask for targeted refactors.