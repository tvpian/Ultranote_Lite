const express  = require('express');
const fs       = require('fs');
const path     = require('path');
const session  = require('express-session');

const app      = express();
const PORT     = process.env.PORT || 3366;
const DATA_FILE = path.join(__dirname, 'data.json');

const MAX_ATTEMPTS = 5;          // tries before temporary lockout
const LOCK_MS = 2 * 60 * 1000;   // 2 minutes lock


// Password for first‑time visitors: set via env or fallback
const APP_PASSWORD = process.env.APP_PASSWORD || 'change-me';

// Whitelisted IPs (always allow loopback)
const allowedIps = new Set(['127.0.0.1', '::1', '26.57.15.177']);

// Middlewares to parse JSON and URL‑encoded bodies
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));

// Session middleware – the session data lives server‑side with improved persistence
app.use(session({
  secret: 'ultranote-session-secret',
  resave: false,
  saveUninitialized: false,
  cookie: { 
    secure: false,    // Set to true if using HTTPS
    httpOnly: true,   // Prevent XSS attacks
    maxAge: 24 * 60 * 60 * 1000 // 24 hours (instead of session-only)
  }
}));


let QUOTES = [];
try {
  const quotesPath = path.join(__dirname, 'quotes.json');
  const raw = fs.readFileSync(quotesPath, 'utf8');
  const parsed = JSON.parse(raw);
  if (parsed && Array.isArray(parsed.quotes)) {
    QUOTES = parsed.quotes.filter(q=> typeof q === 'string' && q.trim());
  }
} catch (e) {
  console.warn('Quotes load failed, using fallback sample.', e.message);
  QUOTES = [
    "Stay consistent—success will follow.",
    "Your focus determines your reality.",
    "Discipline beats motivation.",
    "Every day is a chance to improve.",
    "Progress, not perfection.",
    "Dream big, start small, act now.",
    "The secret to getting ahead is getting started."
  ];
}
if(!QUOTES.length){ QUOTES = ['Show up. Do the work.']; }

/**
 * Authentication middleware:
 *  – If the request IP is in allowedIps or this session has been authorized, allow the request.
 *  – Otherwise, redirect to /login.
 */
app.use((req, res, next) => {
  // Normalize IPv4‑mapped IPv6 addresses (e.g. ::ffff:192.168.0.5 → 192.168.0.5)
  const ip = req.ip.replace(/^::ffff:/, '');

  if (allowedIps.has(ip) || req.session.authorized) {
    return next();
  }
  // Let the login routes through
  if (req.path === '/login' && ['GET','POST'].includes(req.method)) {
    return next();
  }
  // Allow API endpoints for authenticated sessions (even from non-localhost IPs)
  if (req.path.startsWith('/api/') && req.session.authorized) {
    return next();
  }
  // Otherwise, force unauthenticated users to login
  return res.redirect('/login');
});

// === Login page (GET) with animated subtle gradient + graceful errors ===
app.get('/login', (req, res) => {
  const q = QUOTES[Math.floor(Math.random() * QUOTES.length)];

  const errType = req.query.err; // 'bad' | 'locked' | undefined
  const left = Number(req.query.left || 0);
  const msRemaining = Number(req.query.ms || 0);

  let errHtml = '';
  if (errType === 'bad') {
    errHtml = `<div class="err">Incorrect password${left ? ` — ${left} attempt${left===1?'':'s'} left` : ''}.</div>`;
  } else if (errType === 'locked') {
    errHtml = `<div class="err">Too many attempts. Try again in ${Math.ceil(msRemaining/1000)}s.</div>`;
  }

  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>UltraNote – Login</title>
<style>
:root {
  --bg1:#0e1117; --bg2:#151a23; --bg3:#1c2430;
  --card: rgba(30,34,45,.92);
  --fg:#f5f7fa; --muted:#97a5b8;
  --acc:#5073b8;
  --border:#2d3444;
  --input-bg:#141a24; --input-border:#394259;
  --btn-bg:#5073b8; --btn-border:#394259;
}
*{ box-sizing:border-box; font-family:"Segoe UI", Roboto, Helvetica, Arial, sans-serif; }
body{
  margin:0; min-height:100vh; color:var(--fg); display:flex; align-items:center; justify-content:center; padding:2rem;
  background:
    radial-gradient(1000px 700px at 20% 20%, var(--bg3), transparent 60%),
    radial-gradient(1000px 700px at 80% 80%, var(--bg2), transparent 60%),
    linear-gradient(120deg, var(--bg1), var(--bg2));
  background-size:200% 200%;
  animation:bg-pan 28s ease-in-out infinite alternate;
}
@keyframes bg-pan{ 0%{background-position:0% 0%} 100%{background-position:100% 100%} }
.card{
  background:var(--card); border:1px solid var(--border); border-radius:16px;
  padding:2.5rem 2rem; max-width:420px; width:100%;
  box-shadow:0 20px 40px rgba(0,0,0,.4);
}
h1{
  margin:0 0 .5rem; font-size:1.9rem; font-weight:600; text-align:center;
  background:linear-gradient(45deg, var(--acc), #6ea0e0);
  -webkit-background-clip:text; -webkit-text-fill-color:transparent;
}
.subtitle{ text-align:center; color:var(--muted); font-size:.95rem; margin:0 0 1.75rem; }
form{ display:flex; flex-direction:column; gap:1.1rem; }
label{ font-size:.75rem; text-transform:uppercase; letter-spacing:.05em; font-weight:600; color:var(--muted); }
input[type=password]{
  width:100%; padding:.75rem 1rem; border-radius:10px; border:1px solid var(--input-border);
  background:var(--input-bg); color:var(--fg); font-size:1rem; outline:none;
  transition:border-color .18s, box-shadow .18s;
}
input[type=password]:focus{ border-color:var(--acc); box-shadow:0 0 0 2px rgba(80,115,184,.35); }
button{
  padding:.8rem 1rem; border-radius:10px; border:1px solid var(--btn-border);
  background:var(--btn-bg); color:#fff; font-size:1rem; font-weight:600; cursor:pointer;
  transition:background .18s, transform .1s;
}
button:hover{ background:#6ea0e0; }
button:active{ transform:translateY(1px); }
.err{ color:#ff6b6b; font-size:.9rem; text-align:center; margin-top:.25rem; font-weight:600; }
.note{ font-size:.8rem; color:var(--muted); text-align:center; margin-top:.6rem; font-style:italic; }
footer{ margin-top:1.2rem; text-align:center; color:var(--muted); font-size:.75rem; }
.badge{ display:inline-block; background:rgba(255,255,255,.08); border:1px solid var(--border);
  padding:.35rem .75rem; border-radius:999px; font-size:.75rem; }
@media (max-width:520px){ body{padding:1rem;} .card{padding:2rem 1.25rem;} }
</style>
</head>
<body>
  <div class="card"${errHtml ? ' aria-live="polite"' : ''}>
    <h1>UltraNote</h1>
    <p class="subtitle">Secure Workspace Access</p>
    <form method="POST" action="/login" autocomplete="off">
      <div>
        <label for="pw">Password</label>
        <input id="pw" type="password" name="password" placeholder="Enter password" autofocus required />
      </div>
      <button type="submit">Enter Workspace</button>
      ${errHtml}
      <div class="note">“${q}”</div>
    </form>
    <footer><span class="badge">Private</span></footer>
  </div>
</body>
</html>`);
});

// === Login (POST) with throttling + lockout ===
app.post('/login', async (req, res) => {
  const ip = req.ip.replace(/^::ffff:/, '');
  const now = Date.now();
  if (!req.session.login) req.session.login = { attempts: 0, lockedUntil: 0 };

  // lock active?
  if (req.session.login.lockedUntil && req.session.login.lockedUntil > now) {
    const ms = req.session.login.lockedUntil - now;
    return res.redirect(`/login?err=locked&ms=${ms}`);
  }

  const password = (req.body.password || '').trim();
  const ok = password === APP_PASSWORD;

  if (ok) {
    // success → clear counters, whitelist IP, mark session authorized
    req.session.login = { attempts: 0, lockedUntil: 0 };
    allowedIps.add(ip);
    req.session.authorized = true;
    return res.redirect('/');
  }

  // failure → increment attempts, maybe lock
  req.session.login.attempts = (req.session.login.attempts || 0) + 1;

  if (req.session.login.attempts >= MAX_ATTEMPTS) {
    req.session.login.lockedUntil = now + LOCK_MS;
    return res.redirect(`/login?err=locked&ms=${LOCK_MS}`);
  }

  // gentle delay (throttling): grows with attempts, capped
  const delay = Math.min(200 * req.session.login.attempts, 1500);
  await new Promise(r => setTimeout(r, delay));

  const left = MAX_ATTEMPTS - req.session.login.attempts;
  return res.redirect(`/login?err=bad&left=${left}`);
});



// Logout: destroy the session and remove IP from whitelist
app.get('/logout', (req, res) => {
  // Normalise IPv4‑mapped IPv6 addresses
  const ip = req.ip.replace(/^::ffff:/, '');
  // Remove the IP from the allowed list so the next visit requires login again
  allowedIps.delete(ip);
  // Destroy the session: this unsets req.session and deletes the cookie:contentReference[oaicite:0]{index=0}
  req.session.destroy(err => {
    if (err) {
      console.error('Error destroying session', err);
    }
    // Redirect to login page after logging out
    res.redirect('/login');
  });
});


// Now add your existing API and file logic below
function readData() {
  try {
    if (!fs.existsSync(DATA_FILE)) return null;
    const txt = fs.readFileSync(DATA_FILE, 'utf8');
    const data = JSON.parse(txt);
    // Always guarantee the activity collection exists so agents can rely on it
    if (!Array.isArray(data.activity)) data.activity = [];
    return data;
  } catch (e) {
    console.error('Read error', e);
    return null;
  }
}

function writeData(obj) {
  try {
    // Keep a rolling backup (.bak) before overwriting so a single bad write
    // never destroys the only copy.
    if (fs.existsSync(DATA_FILE)) {
      fs.copyFileSync(DATA_FILE, DATA_FILE + '.bak');
    }
    fs.writeFileSync(DATA_FILE, JSON.stringify(obj, null, 2));
    return true;
  } catch (e) {
    console.error('Write error', e);
    return false;
  }
}

app.get('/api/db', (req, res) => {
  const data = readData();
  if (!data) return res.status(200).json({});
  res.json(data);
});

app.post('/api/db', (req, res) => {
  const incoming = req.body;
  if (!incoming || typeof incoming !== 'object') {
    return res.status(400).json({ error: 'Invalid body' });
  }

  // Server-side merge: never let a stale client silently overwrite newer server data.
  // For each array collection, merge by id keeping the record with the latest updatedAt/createdAt.
  // This means a client with an old in-memory db cannot wipe records that were saved by another
  // client (or directly on disk) after the stale client's last fetch.
  const current = readData() || {};
  const COLLECTIONS = ['notes','tasks','projects','templates','links','monthly','notebooks','activity'];

  function mergeById(serverArr = [], clientArr = []) {
    const ts = r => Date.parse(r.updatedAt || r.createdAt || 0);
    const map = new Map();
    // seed with server records
    serverArr.forEach(r => map.set(r.id, r));
    // apply client records using these rules (in priority order):
    //  1. New record (server doesn't have it) → always add
    //  2. Client deleted it (deletedAt set, server has non-deleted) → honor delete
    //  3. Server deleted it, client has old non-deleted copy of same age → keep delete
    //  4. No conflicting delete → newer timestamp wins
    //  5. Tie or server newer → keep server copy
    clientArr.forEach(r => {
      const s = map.get(r.id);
      if (!s) {
        map.set(r.id, r); return; // new record from client
      }
      if (r.deletedAt && !s.deletedAt) {
        map.set(r.id, r); return; // client explicitly deleted — honor it
      }
      if (s.deletedAt && !r.deletedAt && ts(r) <= ts(s)) {
        return; // server deleted and client copy is same-age or older — keep deletion
      }
      if (ts(r) > ts(s)) {
        map.set(r.id, r); // client's non-conflicting version is strictly newer
      }
      // else keep server copy
    });
    return Array.from(map.values());
  }

  const merged = { ...current };
  COLLECTIONS.forEach(k => {
    const serverArr  = Array.isArray(current[k])  ? current[k]  : [];
    const clientArr  = Array.isArray(incoming[k]) ? incoming[k] : [];
    merged[k] = mergeById(serverArr, clientArr);
  });
  // Settings: client wins for all keys (settings changes are intentional)
  merged.settings = { ...(current.settings || {}), ...(incoming.settings || {}) };
  merged.version = Math.max(current.version || 1, incoming.version || 1);

  if (!writeData(merged)) return res.status(500).json({ error: 'Persist failed' });
  // Return the merged state so the posting client can immediately update its own
  // in-memory db and pick up any records that other clients added since its last sync.
  res.json({ ok: true, db: merged });
});

// ── Agent-friendly query endpoints ─────────────────────────────────────────
// These allow an LLM agent to fetch targeted slices of the database instead
// of loading the entire blob into its context window.

/**
 * GET /api/search?q=<text>[&collection=notes|tasks|links|all][&limit=N]
 * Full-text search across title, content, description fields.
 * Returns { results: [ {collection, ...record} ] }
 */
app.get('/api/search', (req, res) => {
  const data = readData();
  if (!data) return res.status(500).json({ error: 'DB unavailable' });
  const q     = (req.query.q || '').toLowerCase().trim();
  const col   = (req.query.collection || 'all').toLowerCase();
  const limit = Math.min(parseInt(req.query.limit || '50', 10), 200);
  if (!q) return res.json({ results: [] });

  const results = [];
  const search = (collection, items, fields) => {
    if (col !== 'all' && col !== collection) return;
    (items || []).filter(item => !item.deletedAt).forEach(item => {
      const haystack = fields.map(f => (item[f] || '')).join(' ').toLowerCase();
      if (haystack.includes(q)) results.push({ collection, ...item });
    });
  };

  search('notes',     data.notes,     ['title', 'content', 'tags']);
  search('tasks',     data.tasks,     ['title', 'description']);
  search('links',     data.links,     ['title', 'url', 'description', 'tags']);
  search('projects',  data.projects,  ['name', 'description', 'tags']);
  search('templates', data.templates, ['name', 'content', 'description']);
  search('notebooks', data.notebooks, ['title', 'description']);

  res.json({ q, total: results.length, results: results.slice(0, limit) });
});

/**
 * GET /api/query?collection=<name>[&field=value...][&since=ISO][&limit=N][&sort=updatedAt|createdAt]
 * Filtered fetch from a single collection. All query-string params except
 * collection/limit/since/sort are treated as field=value filters.
 * Example: /api/query?collection=tasks&status=TODO&projectId=p1&limit=20
 */
app.get('/api/query', (req, res) => {
  const data = readData();
  if (!data) return res.status(500).json({ error: 'DB unavailable' });
  const { collection, limit: limitStr, since, sort, ...filters } = req.query;
  const limit = Math.min(parseInt(limitStr || '100', 10), 500);
  const sortKey = sort || 'updatedAt';

  const COLLECTIONS = ['notes','tasks','projects','templates','links','monthly','notebooks','activity'];
  if (!collection || !COLLECTIONS.includes(collection)) {
    return res.status(400).json({ error: `collection must be one of: ${COLLECTIONS.join(', ')}` });
  }

  let items = Array.isArray(data[collection]) ? data[collection] : [];

  // Exclude soft-deleted items unless explicitly requested
  if (!filters.includeDeleted) items = items.filter(i => !i.deletedAt);
  delete filters.includeDeleted;

  // Date range filter
  if (since) {
    const ts = Date.parse(since);
    if (!isNaN(ts)) items = items.filter(i => Date.parse(i.updatedAt || i.createdAt || 0) >= ts);
  }

  // Arbitrary field filters (all must match)
  Object.entries(filters).forEach(([key, val]) => {
    items = items.filter(i => {
      const v = i[key];
      if (Array.isArray(v)) return v.map(String).includes(val);
      return String(v) === String(val);
    });
  });

  // Sort
  items = items.slice().sort((a, b) =>
    (b[sortKey] || b.createdAt || '').localeCompare(a[sortKey] || a.createdAt || '')
  );

  res.json({ collection, total: items.length, results: items.slice(0, limit) });
});

/**
 * GET /api/context
 * Returns a curated, compact summary of the entire workspace — designed to
 * be pasted as system-context into an LLM prompt without blowing the context
 * window.  Full note content is NOT included; only structural metadata.
 */
app.get('/api/context', (req, res) => {
  const data = readData();
  if (!data) return res.status(500).json({ error: 'DB unavailable' });

  const liveNotes  = (data.notes    || []).filter(n => !n.deletedAt);
  const liveTasks  = (data.tasks    || []).filter(t => !t.deletedAt);
  const liveLinks  = (data.links    || []);
  const projects   = (data.projects || []).filter(p => !p.archivedAt);
  const notebooks  = (data.notebooks|| []).filter(nb => !nb.archivedAt);
  const monthly    = (data.monthly  || []);

  // Recent activity (last 20 events)
  const recentActivity = (data.activity || [])
    .slice().sort((a,b) => (b.ts||'').localeCompare(a.ts||''))
    .slice(0, 20);

  // Recent daily journal entries (last 7)
  const recentDailies = liveNotes
    .filter(n => n.type === 'daily' && n.dateIndex)
    .sort((a, b) => b.dateIndex.localeCompare(a.dateIndex))
    .slice(0, 7)
    .map(n => ({ id: n.id, date: n.dateIndex, mood: n.mood || null,
                 journal: (n.journal || '').slice(0, 300),
                 tags: n.tags }));

  const context = {
    generatedAt: new Date().toISOString(),
    version: data.version,
    counts: {
      notes:     liveNotes.filter(n => n.type === 'note').length,
      ideas:     liveNotes.filter(n => n.type === 'idea').length,
      dailies:   liveNotes.filter(n => n.type === 'daily').length,
      pages:     liveNotes.filter(n => n.type === 'page').length,
      tasks:     liveTasks.length,
      openTasks: liveTasks.filter(t => t.status === 'TODO').length,
      doneTasks: liveTasks.filter(t => t.status === 'DONE').length,
      projects:  projects.length,
      links:     liveLinks.length,
      notebooks: notebooks.length,
    },
    projects: projects.map(p => ({
      id: p.id, name: p.name, description: p.description || '',
      tags: p.tags || [],
      openTasks: liveTasks.filter(t => t.projectId === p.id && t.status === 'TODO').length,
    })),
    notebooks: notebooks.map(nb => ({
      id: nb.id, title: nb.title,
      pageCount: liveNotes.filter(n => n.notebookId === nb.id).length,
      tags: nb.tags || [],
    })),
    noteTitles: liveNotes
      .filter(n => n.type === 'note' || n.type === 'idea')
      .sort((a,b) => b.updatedAt.localeCompare(a.updatedAt))
      .slice(0, 100)
      .map(n => ({ id: n.id, title: n.title, type: n.type, tags: n.tags,
                   projectId: n.projectId, updatedAt: n.updatedAt })),
    openTasks: liveTasks
      .filter(t => t.status === 'TODO')
      .sort((a,b) => (a.due||'z').localeCompare(b.due||'z'))
      .slice(0, 50)
      .map(t => ({ id: t.id, title: t.title, due: t.due, priority: t.priority,
                   projectId: t.projectId, tags: t.tags })),
    recentDailies,
    recentActivity,
    allTags: [...new Set(
      liveNotes.flatMap(n => n.tags || [])
        .concat(liveTasks.flatMap(t => t.tags || []))
        .concat(liveLinks.flatMap(l => l.tags || []))
    )].sort(),
  };

  res.json(context);
});

/**
 * POST /api/activity  { type, entityType, entityId, detail }
 * Append an activity log entry. Can be called by an external agent to record
 * insight-generation or query events alongside user actions.
 */
app.post('/api/activity', (req, res) => {
  const data = readData();
  if (!data) return res.status(500).json({ error: 'DB unavailable' });
  const { type, entityType, entityId, detail } = req.body || {};
  if (!type) return res.status(400).json({ error: 'type is required' });
  if (!Array.isArray(data.activity)) data.activity = [];
  const entry = {
    id: `act_${Date.now()}_${Math.random().toString(36).slice(2,7)}`,
    ts: new Date().toISOString(),
    type: String(type),
    entityType: entityType || null,
    entityId:   entityId   || null,
    detail:     detail     || null,
  };
  data.activity.push(entry);
  // Cap at 2000 entries to avoid unbounded growth
  if (data.activity.length > 2000) data.activity = data.activity.slice(-2000);
  writeData(data);
  res.json({ ok: true, entry });
});
// ── End agent endpoints ─────────────────────────────────────────────────────

// Serve static files after the auth middleware so unauthorized users cannot fetch them
app.use(express.static(__dirname));

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});