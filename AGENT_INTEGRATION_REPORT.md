# UltraNote Lite — Agent Integration Readiness Report

**Date:** 22 February 2026  
**Purpose:** Reference document for integrating an LLM/agent grounded on the UltraNote database.  
**Relevant commits:** `3a05f5c`, `db556cf`

---

## 1. What Was Already in Place (Before This Work)

| Capability | State |
|---|---|
| Flat-file JSON database (`data.json`) | ✅ Existed |
| Stable `id` references between collections | ✅ Existed |
| Note `content` in Markdown format | ✅ Existed |
| `tags[]` on notes and links | ✅ Existed |
| `links[]` array on notes (knowledge graph edges) | ✅ Existed |
| `projectId` foreign key on notes and tasks | ✅ Existed |
| `type` discriminator on notes (`note`, `daily`, `idea`, `page`) | ✅ Existed |
| Daily notes with `dateIndex` (`YYYY-MM-DD`) | ✅ Existed |
| `GET /api/db` — full database dump | ✅ Existed |
| `POST /api/db` — full database overwrite | ✅ Existed |

### Live data snapshot (as of this report)

```
notes:      48    (vault notes)
ideas:       4
dailies:    82    (one per working day)
tasks:     217    (69 open, 89 done)
projects:    6
links:      30
templates:   8
monthly:    27    (recurring habit tasks)
notebooks:   0    (feature ready, none created yet)
```

---

## 2. Problems Identified (Before This Work)

These were blockers for any real agent integration:

### 2a. Schema gaps — missing fields on existing records
Running a schema audit against the live `data.json` found **1,225 missing fields** across all collections.

| Collection | Missing fields (confirmed) |
|---|---|
| `tasks` | `updatedAt`, `tags`, `description`, `subtasks`, `deletedAt` |
| `projects` | `updatedAt`, `description`, `tags`, `color`, `archivedAt` |
| `templates` | `updatedAt`, `tags`, `description` |
| `monthly` | `type`, `updatedAt`, `tags`, `description` |
| `notebooks` | `updatedAt`, `tags`, `archivedAt` |
| `links` | `description` |

Without `updatedAt` on tasks, an agent could not answer "what did I work on this week?"  
Without `description` on projects, an agent had no way to understand what a project is about.

### 2b. No targeted query API
The only way to get data was `GET /api/db` — the entire ~2MB blob. An LLM with a 128k context window would fill it with raw JSON before doing any reasoning. There was no way to ask "show me open tasks for project X" without loading everything.

### 2c. No activity/event history
The app had no record of *when* things happened or what the user *did*. An agent grounded only on current state cannot answer "what have I been focusing on lately?" or "how many tasks did I complete last week?"

### 2d. `getAllTags()` was note+link-only
Tags on tasks, templates, monthly tasks, and notebooks were silently ignored. A tag-based agent query would return incomplete results.

---

## 3. What Was Done

### 3a. Schema normalization — `migrateDB()` (`app.js`)

A `migrateDB()` function was added that runs on every app boot. It is **additive-only** (never overwrites existing values) and uses an internal `ensure(obj, key, val)` helper.

**Canonical schemas now enforced:**

```javascript
// note / idea / daily / page
{ id, title, content, tags[], projectId, dateIndex, type,
  pinned, createdAt, updatedAt, attachments[], links[],
  deletedAt,
  // pages only:
  notebookId, sortOrder }

// task
{ id, title, status, due, noteId, projectId, priority,
  description, subtasks[], tags[],
  createdAt, updatedAt, completedAt, deletedAt }

// project
{ id, name, description, tags[], color, archivedAt,
  createdAt, updatedAt }

// template
{ id, name, content, description, tags[],
  createdAt, updatedAt }

// monthly recurring task
{ id, title, days[], month, type:'monthly_task',
  description, tags[],
  createdAt, updatedAt }

// notebook
{ id, title, description, tags[], archivedAt,
  createdAt, updatedAt }

// link
{ id, title, url, description, tags[], pinned, status,
  createdAt, updatedAt }

// activity event
{ id, ts, type, entityType, entityId, detail }
```

`migrateDB()` also bumps `db.version` from `1` → `2` on first run and calls `persistDB()` if anything changed.

**`create*` functions updated** — `createNote`, `createTask`, `createProject`, `createTemplate`, `createLink` all now stamp the full schema on every new record. No future record will need migration.

**New `updateProject(id, patch)`** helper added (was previously done inline with no `updatedAt`).

### 3b. Activity log (`app.js` + `data.json`)

A new top-level collection `db.activity[]` was added. Each entry:

```json
{
  "id": "act_1740197234521_k3j9x",
  "ts": "2026-02-22T10:47:14.521Z",
  "type": "task:done",
  "entityType": "task",
  "entityId": "t_abc123",
  "detail": { "title": "Write ROS2 nav stack", "projectId": "p2" }
}
```

**`logActivity(type, entityType, entityId, detail)`** is called automatically on:

| Event type | Trigger |
|---|---|
| `note:create` | Every `createNote()` call |
| `note:save` | Every `updateNote()` where `content` or `title` changes |
| `task:create` | Every `createTask()` call |
| `task:done` | Every `setTaskStatus(id, 'DONE')` |
| `task:reopen` | Every `setTaskStatus(id, 'TODO')` |
| `mood:set` | Every mood button click on Today page |

The log is capped at 2,000 entries (oldest pruned). The autosync merge loop also treats `activity` as a synced collection so entries from multiple devices merge correctly.

### 3c. Agent API endpoints (`server.js`)

Three new server-side endpoints were added, all behind the existing session auth.

---

#### `GET /api/context`

**Purpose:** Agent system-prompt injection. Returns a curated, compact snapshot of the entire workspace — no full note content. Designed to fit in a few thousand tokens.

**Response shape:**
```json
{
  "generatedAt": "2026-02-22T10:00:00Z",
  "version": 2,
  "counts": {
    "notes": 48, "ideas": 4, "dailies": 82, "pages": 0,
    "tasks": 217, "openTasks": 69, "doneTasks": 89,
    "projects": 6, "links": 30, "notebooks": 0
  },
  "projects": [
    { "id": "p1", "name": "ROS2 Nav Stack", "description": "...",
      "tags": ["ros2"], "openTasks": 14 }
  ],
  "notebooks": [ ... ],
  "noteTitles": [
    { "id": "n42", "title": "Multicamera Setup in Isaacsim",
      "type": "note", "tags": ["ros2","isaacsim"],
      "projectId": "p1", "updatedAt": "2026-02-15T..." }
  ],
  "openTasks": [
    { "id": "t7", "title": "Implement waypoint traversal",
      "due": "2026-02-28", "priority": "high", "projectId": "p1", "tags": [] }
  ],
  "recentDailies": [
    { "id": "n130", "date": "2026-02-22", "mood": "😊",
      "journal": "Worked on ...", "tags": [] }
  ],
  "recentActivity": [ ... last 20 events ... ],
  "allTags": ["MCP","ROS2","agent","ai", ...]
}
```

**Recommended LLM usage:**
```
System: You are a personal assistant for a robotics PhD student.
        Here is their workspace state: {GET /api/context response}
        Answer questions grounded on this data. For deeper lookups
        call /api/search or /api/query.
```

---

#### `GET /api/search?q=<text>[&collection=all|notes|tasks|links|...][&limit=N]`

**Purpose:** Full-text search across all or specific collections. Returns only matching records — not the whole database.

**Searched fields per collection:**
- `notes` → title, content, tags
- `tasks` → title, description
- `links` → title, url, description, tags
- `projects` → name, description, tags
- `templates` → name, content, description
- `notebooks` → title, description

**Example:**
```
GET /api/search?q=ros2&limit=10
→ { "q": "ros2", "total": 45, "results": [ {collection:"notes", ...}, ... ] }
```

---

#### `GET /api/query?collection=<name>[&field=value...][&since=ISO][&limit=N][&sort=updatedAt|createdAt]`

**Purpose:** Filtered fetch from a single collection. All field=value params are treated as equality filters. Soft-deleted records excluded by default.

**Valid collections:** `notes`, `tasks`, `projects`, `templates`, `links`, `monthly`, `notebooks`, `activity`

**Examples:**
```
GET /api/query?collection=tasks&status=TODO&projectId=p1
→ All open tasks for project p1

GET /api/query?collection=tasks&status=DONE&since=2026-02-01
→ All tasks completed since Feb 2026

GET /api/query?collection=notes&type=daily&since=2026-01-01
→ All daily notes from January onwards

GET /api/query?collection=activity&type=task:done&limit=30
→ Last 30 task completions
```

---

#### `POST /api/activity`  `{ type, entityType, entityId, detail }`

**Purpose:** Allows an external agent to write events back into the activity log — so agent queries, insights, and summaries are recorded alongside user actions.

**Example — agent records it ran an analysis:**
```json
POST /api/activity
{
  "type": "agent:insight",
  "entityType": "project",
  "entityId": "p1",
  "detail": "Identified 5 overdue tasks and suggested prioritization."
}
```

---

### 3d. `getAllTags()` expanded

The tag aggregation function now covers all collections:
```
notes (explicit + inline #hashtags in content)
+ tasks + templates + monthly + notebooks + links
```

---

## 4. Current Architecture Summary

```
┌─────────────────────────────────────────────────────────┐
│  data.json  (flat-file, ~2MB, ~500 records)             │
│                                                         │
│  collections: notes · tasks · projects · templates      │
│               links · monthly · notebooks · activity    │
│  version: 2                                             │
└──────────────────────┬──────────────────────────────────┘
                       │ read/write
┌──────────────────────▼──────────────────────────────────┐
│  server.js  (Express, port 3366, PM2 managed)           │
│                                                         │
│  POST /login            — password auth + session       │
│  GET  /api/db           — full dump (app sync)          │
│  POST /api/db           — full overwrite (app sync)     │
│  GET  /api/context      — compact agent context         │
│  GET  /api/search       — full-text search              │
│  GET  /api/query        — filtered collection fetch     │
│  POST /api/activity     — agent event logging           │
└──────────────────────┬──────────────────────────────────┘
                       │
          ┌────────────┴────────────┐
          │                         │
┌─────────▼──────────┐  ┌──────────▼────────────────────┐
│  app.js            │  │  Future: LLM Agent             │
│  (frontend SPA)    │  │                                │
│  logActivity() on  │  │  1. GET /api/context           │
│  key user events   │  │     → inject as system prompt  │
└────────────────────┘  │  2. GET /api/search?q=...      │
                        │     → retrieve relevant notes  │
                        │  3. GET /api/query?...         │
                        │     → targeted data slices     │
                        │  4. POST /api/activity         │
                        │     → log agent interactions   │
                        └────────────────────────────────┘
```

---

## 5. What You Still Need to Do Before Onboarding an Agent

These are the gaps that remain — prioritized by impact.

### 🔴 Must-do before first integration

**A. Note content is not chunked or embedded**  
Right now `content` is raw Markdown text. An LLM can read it, but for semantic search (e.g. "find notes similar to this concept") you'd need to chunk each note into passages and embed them into a vector store (pgvector, Chroma, Qdrant, etc.).  
→ _Recommend: run a one-time embedding job over all `notes[].content`, store vectors with `noteId` pointer_

**B. No authentication for agent requests**  
The server uses session cookies (browser-based). An agent running via API (Python script, LangChain, etc.) can't get a cookie easily. You need either:
- An API key header (`X-API-Key: <secret>`) bypassing the session check, or
- A service token endpoint (`POST /api/token`)  
→ _Quick fix: add `if (req.headers['x-api-key'] === process.env.AGENT_KEY) return next();` to auth middleware_

**C. Daily note `journal` field not returned in `/api/context` full-text**  
`daily.journal` is a separate field from `daily.content` (added during the journal feature). The `/api/search` endpoint searches `content` but not `journal`. An agent asking "what did I write on Feb 22?" would miss journal entries.  
→ _Fix: add `journal` to the note search fields in `/api/search`_

---

### 🟡 Should-do for a good agent experience

**D. No summarization of daily notes**  
82 daily notes exist. An agent that needs to reason over your entire history can't read all of them. A nightly/weekly summarization job that extracts key themes per week and stores them as a `summary` note would be very useful.  
→ _Recommend: a cron job calling the LLM on `GET /api/query?collection=notes&type=daily&since=<last-week>`, storing result as a new `type:'summary'` note_

**E. No semantic relationships beyond manual `links[]`**  
You have 48 notes and 45 cross-links to "ros2" topics. But notes are not automatically linked by semantic similarity. The agent can traverse explicit `links[]` but can't discover related notes it wasn't told about.  
→ _Deferred until vector embeddings are in place_

**F. Monthly habit data has no completion tracking per-day**  
`monthly[].days` stores which days of the week a task should run, but there is no per-date completion record. An agent can't tell you "you completed your daily coding habit 18/28 days in January."  
→ _Need a `completions: { 'YYYY-MM-DD': bool }` field on monthly records_

**G. No project `status` or `deadline`**  
Projects only have `name`, `description`, `tags`. An agent can't distinguish active vs archive projects programmatically without the `archivedAt` field (which now exists) being actually used in the UI.  
→ _Add an "Archive project" button in the Projects view, which sets `archivedAt`_

---

### 🟢 Nice-to-have

**H. Structured `wins` and `top3` extraction from daily notes**  
Your daily note template has `## Wins` and `# Top 3` sections in Markdown. An agent could answer "what were your wins this week?" but only by parsing the Markdown. If these were extracted into structured fields (`daily.wins[]`, `daily.top3[]`) on save, the agent could query them directly.  
→ _A regex-based extractor on `daily.content` save would populate these fields_

**I. Task duration tracking**  
Tasks record `createdAt` and `completedAt` but nothing about active work time. An agent cannot estimate how long things actually take you — useful for scheduling/estimation advice.  
→ _Deferred; would require a "Start/Stop timer" UI feature_

**J. `/api/context` caching**  
Currently `/api/context` reads and computes on every request. With 134+ notes it's fast, but once you have thousands of records and embedding lookups, caching (5-minute TTL) would help.  
→ _Add in-memory cache with timestamp invalidation when `POST /api/db` is called_

---

## 6. Recommended Agent Integration Pattern

When you are ready to integrate, the cleanest approach that works with your current stack:

```
┌─────────────────────────────────────────────────────────┐
│  Python agent script (local or server-side)             │
│                                                         │
│  from langchain/openai/anthropic import ...             │
│                                                         │
│  1. ctx = requests.get('http://localhost:3366/          │
│           api/context',                                 │
│           headers={'X-API-Key': AGENT_KEY}).json()      │
│                                                         │
│  2. system_prompt = f"""                                │
│       You are a personal assistant for a robotics       │
│       researcher. Today is {ctx['generatedAt']}.         │
│       Workspace: {ctx['counts']}                        │
│       Projects: {ctx['projects']}                       │
│       Open tasks: {ctx['openTasks']}                    │
│       Recent journal: {ctx['recentDailies']}            │
│       Recent activity: {ctx['recentActivity']}          │
│     """                                                 │
│                                                         │
│  3. On user query → search:                             │
│     results = requests.get('/api/search?q='+query)      │
│                                                         │
│  4. Compose final prompt: system + context + results    │
│     + user question → LLM API → answer                 │
│                                                         │
│  5. Log interaction:                                    │
│     requests.post('/api/activity', json={               │
│       'type': 'agent:query',                            │
│       'detail': {'query': user_question,                │
│                  'model': 'gpt-4o'}                     │
│     })                                                  │
└─────────────────────────────────────────────────────────┘
```

**Suitable models/frameworks to evaluate:**
- **OpenAI GPT-4o** — best general reasoning, good with structured JSON
- **Anthropic Claude** — excellent at long-document analysis (your daily notes)
- **LangChain / LlamaIndex** — orchestration frameworks that wrap the above
- **Ollama (local)** — `llama3.2`, `mistral`, or `deepseek-r1` run on your machine; no API cost, full privacy
- **MCP (Model Context Protocol)** — you already have `mcp` tagged notes; could expose UltraNote as an MCP server so any MCP-capable agent can query it natively

---

## 7. File Reference

| File | Role |
|---|---|
| `server.js` | Express backend — all API endpoints including the 4 new agent endpoints |
| `app.js` | Frontend SPA — `migrateDB()`, `logActivity()`, `create*` functions, all schema enforcement |
| `autosync.js` | Background merge loop — `activity` collection now included in sync |
| `data.json` | Live flat-file database — version 2 schema, ~500 records |
| `AGENT_INTEGRATION_REPORT.md` | This document |

---

*Report generated from commit `db556cf` on the `main` branch.*
