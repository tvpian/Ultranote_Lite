# UltraNote — Coding-Agent API Guide

Drop this file (plus a `.ultranote.json`) into any project workspace. Your coding
agent reads it to manage that project's **tasks** and **notes** in UltraNote.
UltraNote's DB is the single source of truth — never cache or mirror; always
read live and write back.

> **Read this whole file before touching the API.** Section 1 ("Hard-won
> lessons") will save you the ~30 minutes of dead ends the first agent burned.

---

## 0. Workspace config — `.ultranote.json`

```json
{ "baseUrl": "http://localhost:3366", "projectId": "p1" }
```

Find `projectId` once with: `GET /api/query?collection=projects` and match by `name`.
For a remote instance on the LAN, `baseUrl` is just `http://<host>:<port>`
(e.g. `http://26.57.15.177:3366`) — see Section 1 for what auth this needs (none).

---

## 1. Hard-won lessons — READ FIRST (verified against a live instance)

These are the exact traps the previous agent hit. Each one below is confirmed by
testing the running server, not guessed.

### 1.1 Auth: there is NO login for local/LAN requests — don't waste time on it
- `GET`/`POST` to `/api/*` from the same machine **or the same LAN** are
  **auto-authorized**. A bare `GET /api/query?collection=projects` returns
  **HTTP 200** with no cookie, no password, no session.
- **Do NOT** `POST /login` — there is no such route; it returns **HTTP 404**.
  There is no password handshake to perform. (The first agent wasted a full
  login/cookie cycle here. Skip it entirely.)
- Therefore: **no cookie jar, no `-b/-c`, no `password=` form post.** Just call the
  API directly.

### 1.2 `X-Requested-With` is mandatory on WRITES (and harmless on reads)
- Every **write** (`POST /api/db`) **must** include `-H 'X-Requested-With: XMLHttpRequest'`.
  Without it you get **HTTP 403 `{"error":"Forbidden: missing X-Requested-With header"}`**.
- Reads currently tolerate its absence, but **always send it anyway** so you never
  get bitten when the rule tightens.

### 1.3 `POST /api/db` echoes the ENTIRE database back (~1.6 MB) — do NOT parse it
- A successful write returns the **whole DB dump**: every collection, all records
  (on the live instance that was 830 tasks, 419 notes, 1600+ activity rows ≈ **1.6 MB**).
- The previous agent tried to `json.load()` this to confirm its single write and got
  `JSONDecodeError: Extra data` / "output too large" every time.
- **Correct pattern:** don't read the body as your confirmation. Just check the
  response **starts with** `{"ok":true`. Then **verify the actual write** with a
  small follow-up query (Section 2). Never echo the full response into your context.

```bash
# success check without ingesting 1.6 MB:
curl -s -X POST "$BASE/api/db" -H 'Content-Type: application/json' \
  -H 'X-Requested-With: XMLHttpRequest' -d "$PAYLOAD" -o /dev/null -w '%{http_code}\n'
# expect: 200   (then verify with /api/query)
```

### 1.4 NEVER hand-build JSON for non-trivial content — use a script + `json.dumps`
- Note bodies contain markdown: backticks, quotes, ASCII-art diagrams, `$`, newlines.
  Putting that in an inline `curl -d '{...}'` **will** corrupt via shell escaping.
- **Always** build the payload in a tiny Python script: read file content from disk,
  `json.dumps` the record, `urllib`/`requests` POST it. This is the single biggest
  reliability win. Template in Section 10.

### 1.5 Batch big writes; keep payloads sane
- Uploading 17 large notes in one POST works but makes a multi-MB request and a
  multi-MB echo. **Batch ~4 records per POST** (a few hundred KB each). Loop the batches.

### 1.6 `updatedAt` strictly-newer or the write is silently dropped
- Merge is whole-record, strictly-newer-wins. If you **create then edit in the same
  run**, reusing the same ISO second means the edit is **ignored with no error**.
- Use a monotonic clock: keep a counter and add seconds per record, or read the
  stored `updatedAt` first and add a few seconds.

### 1.7 The `links` collection is for EXTERNAL bookmarks — not note↔note edges
- `links` holds saved URLs (the live instance had 39 web bookmarks). It does **not**
  connect notes to each other.
- **Note-to-note connections = `[[wiki-links]]` inside note `content`** (the
  "notemap"). See Section 5. Don't reach for the `links` collection to chain docs.

### 1.8 Soft-delete only
- Never hard-delete. Set `deletedAt` (ISO) and re-POST the full record.

---

## 2. Read tasks / notes for this project
```bash
curl -s "$BASE/api/query?collection=tasks&projectId=$PID&status=TODO" \
  -H 'X-Requested-With: XMLHttpRequest'
curl -s "$BASE/api/query?collection=notes&projectId=$PID" \
  -H 'X-Requested-With: XMLHttpRequest'
```
Response shape: `{"total": N, "results": [ ... ]}`. **This** is what you parse to
confirm writes — small and clean, unlike the `/api/db` echo.
Overview: `GET /api/context`. Full text: `GET /api/search?q=...&collection=tasks`.

---

## 3. Add / update a task
```bash
curl -s -X POST "$BASE/api/db" \
  -H 'Content-Type: application/json' -H 'X-Requested-With: XMLHttpRequest' \
  -o /dev/null -w '%{http_code}\n' \
  -d '{"tasks":[{"id":"tsk_1735500000_a1","title":"Wire up auth","status":"TODO","projectId":"p1","priority":"high","tags":["backend","auth"],"subtasks":[{"title":"hash pwd","done":false}],"description":"WHAT/WHY/HOW-VALIDATED — see Section 8.1","createdAt":"2026-06-29T10:00:00Z","updatedAt":"2026-06-29T10:00:00Z"}]}'
```
Mark done: re-POST the **full** task with same `id`, `"status":"DONE"`, a
`"completedAt"`, and a strictly-later `updatedAt` (read it first, change those
fields, send the whole object). **Only mark DONE when validated** — Section 7.

---

## 4. Add a note under this project
Use the Section 10 script for real content. Inline form (trivial content only):
```bash
curl -s -X POST "$BASE/api/db" -o /dev/null -w '%{http_code}\n' \
  -H 'Content-Type: application/json' -H 'X-Requested-With: XMLHttpRequest' \
  -d '{"notes":[{"id":"nte_1735500001_b2","type":"note","title":"Auth design","content":"# Decisions\n- argon2","projectId":"p1","tags":["design","auth","backend"],"createdAt":"2026-06-29T10:01:00Z","updatedAt":"2026-06-29T10:01:00Z"}]}'
```

### 4.1 Tagging convention — 3-4 specific tags per note
Give each note **3-4 tags** so it is uniquely findable and filterable. Mix levels:
one project/topic tag, one stage/area tag, one type tag, optionally one status tag.
Example: `["humanego","preprocessing","cotracker","reference"]`. Avoid one-word
generic tags only (`["docs"]`) — they don't disambiguate in a 400-note DB.

---

## 5. Linking docs together (notemap / wiki-links)
Docs cross-reference each other with `[[wiki-links]]` inside markdown `content`.
Linked notes form the **notemap** (a graph of connected docs). Write them as
plain text in the body — UltraNote resolves and renders them, you don't touch ids:

- `[[Auth design]]` → links to the note titled "Auth design".
- `[[Auth design|see notes]]` → custom label.
- Matching is **fuzzy** (case-insensitive, substring) so exact titles aren't required.
- A link to a not-yet-existing title renders as a "missing" link the user can click
  to create — fine for forward references.
- Keep note titles **unique + descriptive**; that's the linking key. Backlinks are
  derived automatically, so you write the link in only one direction.

### 5.1 Chaining an ordered series of docs (prev/next navigation)
When a set of notes is a **sequence** (a course, a pipeline walkthrough, numbered
chapters), give each note a **navigation footer** so the reader can move along the
chain and the notemap shows the spine:

```md
---
⬅️ Prev: [[Chapter N-1 — Previous Topic]]
➡️ Next: [[Chapter N+1 — Next Topic]]
🗂️ Index: [[Series Index Note]]
```
(Use your real note titles here — generic placeholders shown so this example
doesn't create stray edges in a live notemap.)

Put a matching ordered list of `[[links]]` in the index/README note so it is the hub
of the series. First note has only Next; last note has only Prev; every note points
back to the Index.

---

## 6. Notebooks (multi-page docs)
A notebook groups ordered **pages** (notes with `type:"page"` + `notebookId`).
Use it for living docs / runbooks: one notebook, many pages instead of one giant note.
```bash
curl -s -X POST "$BASE/api/db" -o /dev/null -w '%{http_code}\n' \
  -H 'Content-Type: application/json' -H 'X-Requested-With: XMLHttpRequest' \
  -d '{"notebooks":[{"id":"nbk_173_x","title":"Backend Runbook","createdAt":"2026-06-29T10:00:00Z","updatedAt":"2026-06-29T10:00:00Z"}],
       "notes":[{"id":"pg_173_a","type":"page","notebookId":"nbk_173_x","title":"Deploy","content":"...","sortOrder":0,"createdAt":"2026-06-29T10:00:00Z","updatedAt":"2026-06-29T10:00:00Z"}]}'
```
Pages order by `sortOrder` and can wiki-link to each other and to notes. Read with `GET /api/query?collection=notebooks`.

---

## 7. The living-project loop — keep UltraNote truthful until done or parked
UltraNote is the project's **ground-truth ledger**. Treat keeping it current as part
of the work, not an afterthought. **Until the project is fully completed or
explicitly parked**, run this loop every working session:

1. **Read live state first.** `GET /api/query` for this project's tasks + notes.
   Never act on a stale mental model — pull the real records.
2. **Reconcile with reality.** Compare each task's status to what actually happened
   on disk / in the repo / on hardware. The DB must match the world, not your hopes.
3. **Update statuses truthfully (Section 7.1).** Flip TODO→DONE only with evidence;
   flip anything back to TODO/BACKLOG if it regressed or was never really validated.
4. **Grow the plan.** As new sub-steps emerge, add tasks/subtasks immediately so the
   backlog reflects the true remaining work. Don't keep scope only in your head.
5. **Capture knowledge as notes.** Decisions, gotchas, validated procedures, and new
   findings become notes (3-4 tags, Section 4.1), chained into the notemap (Section 5.1).
6. **Verify every write** with a follow-up `/api/query` (Section 1.3).

### 7.1 Truthfulness rules (non-negotiable)
- **Never mark a task DONE without concrete validation evidence**, and record that
  evidence in the task `description` (the file produced, the metric, the command that
  passed). "How was it validated" must always be answerable from the task alone.
- If you are unsure whether something is truly done, it is **not** done — leave it
  TODO and note what's missing.
- Keep `description` fields **WHAT / WHY / HOW-VALIDATED** (Section 8.1) so a human
  reading months later understands the work without you.
- The DB outranks any summary or memory. If they disagree, fix the DB to match
  reality and trust the DB.

---

## 8. Schemas (set every field on create)
- **task**: `id, title, status(TODO|DONE|BACKLOG), due, projectId, priority(high|medium|low), description, subtasks[{title,done}], tags[], createdAt, updatedAt, completedAt, deletedAt`
- **note**: `id, title, content(markdown, supports [[wiki-links]]), type(note|idea|page), projectId, notebookId, sortOrder, tags[], createdAt, updatedAt, deletedAt`
- **notebook**: `id, title, description, createdAt, updatedAt, deletedAt`
- **link**: `id, title, url, description, tags[], status, createdAt, updatedAt, deletedAt`  ← external bookmarks only
- **project**: `id, name, description, tags[], color(#hex), createdAt, updatedAt, deletedAt`

### 8.1 Write task `description`s as WHAT / WHY / HOW-VALIDATED
A good description has three answerable parts so a human (or the next agent) can read
one task and fully understand it later:
- **WHAT** was done / is to be done — the concrete action and the exact command(s).
- **WHY** it matters — its role in the pipeline / what it unblocks.
- **HOW-VALIDATED** — the evidence the task is truly complete (artifact path, metric,
  passing command). For TODO tasks, state the acceptance check up front.
Subtasks carry the step-by-step; the description carries the narrative + proof.

---

## 9. ID convention
New record → fresh unique `id`: `<prefix>_<epoch>_<rand4>`
(`tsk_…`, `nte_…`, `nbk_…`, `pg_…`, `lnk_…`, `prj_…`). Edit → reuse the existing id.

---

## 10. Reference script (robust writes — copy this, don't hand-roll curl)
```python
import json, urllib.request, time, random, os

BASE = "http://26.57.15.177:3366"      # from .ultranote.json
PID  = "prj_xxx"                        # this project

def post_db(payload: dict) -> bool:
    """POST records; return True on ok. Never ingests the 1.6 MB echo."""
    req = urllib.request.Request(
        BASE + "/api/db",
        data=json.dumps(payload).encode(),
        headers={"Content-Type": "application/json",
                 "X-Requested-With": "XMLHttpRequest"},   # required on writes
        method="POST")
    with urllib.request.urlopen(req) as r:
        head = r.read(40).decode("utf-8", "ignore")        # peek, don't slurp
    return head.startswith('{"ok":true')

_clock = int(time.time())
def uid(prefix):                       # unique id
    global _clock; _clock += 1
    return f"{prefix}_{_clock}_{random.randint(1000,9999)}"

def iso(offset=0):                     # strictly-newer timestamps
    return time.strftime("%Y-%m-%dT%H:%M:%S.000Z",
                         time.gmtime(time.time() + offset))

def verify(collection):                # confirm via small query, not the echo
    url = f"{BASE}/api/query?collection={collection}&projectId={PID}"
    req = urllib.request.Request(url, headers={"X-Requested-With": "XMLHttpRequest"})
    with urllib.request.urlopen(req) as r:
        return json.load(r)["total"]

# Batch large note uploads ~4 at a time (Section 1.5)
notes = [...]
for i in range(0, len(notes), 4):
    assert post_db({"notes": notes[i:i+4]}), f"batch {i} failed"
print("notes now in project:", verify("notes"))
```

---

## 11. Agent prompt to paste per project
> You manage this project in UltraNote via REST. Read `.ultranote.json` for
> `baseUrl`+`projectId`. **Local/LAN requests are auto-authorized — do NOT log in
> (`/login` 404s); no cookie/password.** Always send `X-Requested-With: XMLHttpRequest`
> (required on writes; 403 without). Read tasks/notes via
> `GET /api/query?collection=...&projectId=<pid>`. To write, `POST /api/db` with full
> records (set/keep `id`, strictly-newer `updatedAt`, include `projectId`); the POST
> echoes the **entire 1.6 MB DB** so just check it starts `{"ok":true` and verify with
> a follow-up query — never parse the echo. Build payloads with a Python script +
> `json.dumps` (never inline curl for markdown), batch ~4 records per POST. Mark DONE
> only with validation evidence recorded in the task `description` (WHAT/WHY/HOW-
> VALIDATED). Give notes 3-4 specific tags and chain ordered docs with prev/next
> `[[wiki-links]]` footers into the notemap. **Run the living-project loop (read →
> reconcile with reality → update statuses truthfully → grow tasks → capture notes →
> verify) every session until the project is completed or parked.** UltraNote is the
> single source of truth; if memory and DB disagree, fix the DB to match reality.
