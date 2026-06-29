# UltraNote — Coding-Agent API Guide

Drop this file (plus a `.ultranote.json`) into any project workspace. Your coding
agent reads it to manage that project's **tasks** and **notes** in UltraNote.
UltraNote's DB is the single source of truth — never cache or mirror; always
read live and write back.

## 0. Workspace config — `.ultranote.json`

```json
{ "baseUrl": "http://localhost:3366", "projectId": "p1" }
```

Find `projectId` once with: `GET /api/query?collection=projects` and match by `name`.

## 1. Rules
- Base URL from `.ultranote.json`. Every `/api/*` request MUST send header
  `X-Requested-With: XMLHttpRequest`. Local requests are auto-authorized.
- **Read** with `/api/query`, `/api/search`, `/api/context`.
- **Write** with `POST /api/db` sending only the records you changed.
- Merge is **whole-record, strictly-newer wins**. Two non-negotiable rules:
  1. Send the **complete record** (all fields), not a partial — the winning
     record replaces the old one, so omitted fields are lost.
  2. `updatedAt` must be **strictly greater** than the stored value, or the
     write is silently ignored. Use a fresh ISO timestamp; if unsure, add a few
     seconds. Same-second updates are dropped.
- New record → make a fresh unique `id` (e.g. `tsk_<epoch>_<rand>`). Edit → reuse id.
- Soft-delete = set `deletedAt` (ISO). Never hard-delete.

## 2. Read tasks for this project
```bash
curl -s "$BASE/api/query?collection=tasks&projectId=$PID&status=TODO" \
  -H 'X-Requested-With: XMLHttpRequest'
```
Overview: `GET /api/context`. Full text: `GET /api/search?q=...&collection=tasks`.

## 3. Add / update a task
```bash
curl -s -X POST "$BASE/api/db" \
  -H 'Content-Type: application/json' -H 'X-Requested-With: XMLHttpRequest' \
  -d '{"tasks":[{"id":"tsk_1735500000_a1","title":"Wire up auth","status":"TODO","projectId":"p1","priority":"high","tags":["backend"],"subtasks":[{"title":"hash pwd","done":false}],"createdAt":"2026-06-29T10:00:00Z","updatedAt":"2026-06-29T10:00:00Z"}]}'
```
Mark done: re-POST the **full** task with same `id`, `"status":"DONE"`, `"completedAt"`, and a strictly-later `updatedAt` (read it first, change those fields, send the whole object).

## 4. Add a note under this project
```bash
curl -s -X POST "$BASE/api/db" \
  -H 'Content-Type: application/json' -H 'X-Requested-With: XMLHttpRequest' \
  -d '{"notes":[{"id":"nte_1735500001_b2","type":"note","title":"Auth design","content":"# Decisions\n- argon2","projectId":"p1","tags":["design"],"createdAt":"2026-06-29T10:01:00Z","updatedAt":"2026-06-29T10:01:00Z"}]}'
```

## 5. Schemas (set every field on create)
- **task**: `id, title, status(TODO|DONE), due, projectId, priority, description, subtasks[], tags[], createdAt, updatedAt, completedAt, deletedAt`
- **note**: `id, title, content(markdown), type(note|idea|page), projectId, tags[], createdAt, updatedAt, deletedAt`

## 6. Agent prompt to paste per project
> You manage this project in UltraNote via REST. Read `.ultranote.json` for
> `baseUrl`+`projectId`. Always send `X-Requested-With: XMLHttpRequest`. Read open
> tasks via `GET /api/query?collection=tasks&projectId=<pid>&status=TODO`. To add/
> update tasks or notes, `POST /api/db` with only changed records (set/keep `id`,
> always set `updatedAt`, include `projectId`). Mark done = status DONE +
> completedAt. Never overwrite the whole DB. UltraNote is the source of truth.
