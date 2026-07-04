const express  = require('express');
const compression = require('compression');
const fs       = require('fs');
const path     = require('path');
const session  = require('express-session');
const FileStore = require('session-file-store')(session);

const app      = express();
const PORT     = process.env.PORT || 3366;
const DATA_FILE = path.join(__dirname, 'data.json');
const BACKUPS_DIR = path.join(__dirname, 'backups');
const BACKUP_BASE = path.join(BACKUPS_DIR, 'data.json.bak');
try { fs.mkdirSync(BACKUPS_DIR, { recursive: true }); } catch (_) {}
const SESSIONS_DIR = path.join(__dirname, '.sessions');
const ATTACHMENTS_DIR = path.join(__dirname, 'attachments');
try { fs.mkdirSync(ATTACHMENTS_DIR, { recursive: true }); } catch (_) {}

const MAX_ATTEMPTS = 5;          // tries before temporary lockout
const LOCK_MS = 2 * 60 * 1000;   // 2 minutes lock


// Password for first‑time visitors: set via env or fallback
const APP_PASSWORD = process.env.APP_PASSWORD || 'change-me';
// Session secret: prefer env var; fall back to a stable file-based secret so
// existing cookies still validate across restarts without forcing re-login.
const SESSION_SECRET = process.env.SESSION_SECRET || (() => {
  const secretFile = path.join(__dirname, '.session-secret');
  try {
    if (fs.existsSync(secretFile)) return fs.readFileSync(secretFile, 'utf8').trim();
    const generated = require('crypto').randomBytes(48).toString('hex');
    fs.writeFileSync(secretFile, generated, { mode: 0o600 });
    return generated;
  } catch (e) {
    console.warn('Could not persist session secret, using ephemeral one:', e.message);
    return require('crypto').randomBytes(48).toString('hex');
  }
})();

// Whitelisted IPs (always allow loopback)
const allowedIps = new Set(['127.0.0.1', '::1', '26.57.15.177']);

// Per-IP failed-login tracking. The existing per-session lockout in POST /login
// can be bypassed by clearing cookies. This adds a second gate keyed on source
// IP so a teammate on the LAN can't brute-force by wiping cookies between tries.
// Entries auto-expire LOCK_MS after the last failure.
const ipLoginFails = new Map(); // ip -> { attempts, lockedUntil }
function ipLockState(ip) {
  const rec = ipLoginFails.get(ip);
  if (!rec) return { attempts: 0, lockedUntil: 0 };
  if (rec.lockedUntil && rec.lockedUntil < Date.now() - LOCK_MS) {
    // Fully expired — reset so the user gets a fresh allowance.
    ipLoginFails.delete(ip);
    return { attempts: 0, lockedUntil: 0 };
  }
  return rec;
}

// Middlewares to parse JSON and URL‑encoded bodies
// Large limit needed because attachments (audio, images) are stored as base64 inside data.json
// Gzip compression. We now compress everything textual, including JSON. The
// previous skip was justified when data.json was multi-MB and dominated by
// poorly-compressible base64 attachments — attachments now live out-of-band
// (see /api/attachments), and the residual JSON (~1 MB) compresses ~5x for
// negligible CPU. Binary attachment responses are already excluded by the
// default compression filter.
app.use(compression({
  threshold: 1024,
  filter: (req, res) => {
    if (req.headers['x-no-compression']) return false;
    return compression.filter(req, res);
  },
}));
app.use(express.json({ limit: '100mb' }));
app.use(express.urlencoded({ extended: true, limit: '100mb' }));

// Session middleware – sessions persisted to disk via session-file-store so
// pm2 restarts and code reloads no longer log every device out.
app.use(session({
  store: new FileStore({
    path: SESSIONS_DIR,
    retries: 1,
    ttl: 24 * 60 * 60,        // seconds — match cookie maxAge
    reapInterval: 60 * 60,    // hourly cleanup of expired session files
    logFn: () => {}           // silence verbose info logs; errors still surface
  }),
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: { 
    secure: false,    // Set to true if using HTTPS
    httpOnly: true,   // Prevent XSS attacks
    sameSite: 'lax',  // mitigate CSRF on top-level navigations
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
  --bg1:#0c0917; --bg2:#161122; --bg3:#1c1430;
  --card: rgba(30,34,45,.92);
  --fg:#f5f7fa; --muted:#97a5b8;
  --acc:#8b6dff;
  --border:#281f3e;
  --input-bg:#14101f; --input-border:#3a2a5a;
  --btn-bg:#6b46e5; --btn-border:#5b3dd1;
}
*{ box-sizing:border-box; font-family:"Segoe UI", Roboto, Helvetica, Arial, sans-serif; }
body{
  margin:0; min-height:100vh; color:var(--fg); display:flex; align-items:center; justify-content:center; padding:2rem;
  font-feature-settings:"kern" 1,"liga" 1,"calt" 1;
  -webkit-font-smoothing:antialiased;
  background:
    radial-gradient(1100px 700px at 20% 15%, rgba(139,109,255,0.16), transparent 60%),
    radial-gradient(900px 600px at 85% 80%, rgba(107,70,229,0.13), transparent 60%),
    radial-gradient(700px 500px at 50% 50%, rgba(167,139,250,0.05), transparent 70%),
    linear-gradient(160deg, var(--bg1) 0%, #060410 100%);
  background-attachment:fixed;
}
@keyframes bg-pan{ 0%{background-position:0% 0%} 100%{background-position:100% 100%} }
.card{
  background:
    linear-gradient(180deg, rgba(255,255,255,0.04) 0%, rgba(255,255,255,0.01) 100%),
    rgba(20, 15, 36, 0.72);
  border:1px solid rgba(255,255,255,0.08); border-radius:20px;
  padding:2.5rem 2rem; max-width:420px; width:100%;
  backdrop-filter:blur(24px) saturate(180%);
  -webkit-backdrop-filter:blur(24px) saturate(180%);
  box-shadow:
    0 1px 0 rgba(255,255,255,0.06) inset,
    0 12px 32px rgba(0,0,0,0.55),
    0 32px 80px rgba(0,0,0,0.45),
    0 0 64px rgba(139,109,255,0.10);
}
h1{
  margin:0 0 .5rem; font-size:1.9rem; font-weight:600; text-align:center;
  background:linear-gradient(45deg, var(--acc), #a78bfa);
  -webkit-background-clip:text; -webkit-text-fill-color:transparent;
}
.subtitle{ text-align:center; color:var(--muted); font-size:.95rem; margin:0 0 1.75rem; }
form{ display:flex; flex-direction:column; gap:1.1rem; }
label{ font-size:.75rem; text-transform:uppercase; letter-spacing:.05em; font-weight:600; color:var(--muted); }
input[type=password]{
  width:100%; padding:.85rem 1rem; border-radius:10px; border:1px solid rgba(255,255,255,0.10);
  background:rgba(0,0,0,0.25); color:var(--fg); font-size:1rem; outline:none;
  box-shadow: 0 1px 2px rgba(0,0,0,0.35) inset;
  transition:border-color .18s, box-shadow .18s, background .18s;
}
input[type=password]:hover{ border-color:rgba(139,109,255,0.30); }
input[type=password]:focus{
  border-color:rgba(139,109,255,0.65);
  background:rgba(0,0,0,0.30);
  box-shadow:
    0 1px 2px rgba(0,0,0,0.30) inset,
    0 0 0 3px rgba(139,109,255,0.18),
    0 0 24px rgba(139,109,255,0.12);
}
button{
  padding:.85rem 1rem; border-radius:10px; border:1px solid rgba(139,109,255,0.7);
  background:linear-gradient(180deg, #9d83ff 0%, #7c5cff 100%); color:#fff;
  font-size:1rem; font-weight:600; cursor:pointer;
  text-shadow:0 1px 0 rgba(0,0,0,0.20);
  box-shadow:
    0 1px 0 rgba(255,255,255,0.18) inset,
    0 1px 3px rgba(107,70,229,0.30),
    0 4px 12px rgba(107,70,229,0.25);
  transition:background .18s, transform .12s cubic-bezier(0.34, 1.20, 0.36, 1), box-shadow .18s;
}
button:hover{
  background:linear-gradient(180deg, #b09bff 0%, #8b6dff 100%);
  transform:translateY(-1px);
  box-shadow:
    0 1px 0 rgba(255,255,255,0.22) inset,
    0 2px 8px rgba(107,70,229,0.45),
    0 8px 24px rgba(107,70,229,0.35),
    0 0 32px rgba(139,109,255,0.30);
}
button:active{ transform:translateY(1px); }
.err{ color:#ff6b6b; font-size:.9rem; text-align:center; margin-top:.25rem; font-weight:600; }
.note{ font-size:.82rem; color:var(--muted); text-align:center; margin-top:.75rem; font-style:italic; line-height:1.6;
  border-top:1px solid var(--border); padding-top:.75rem; }
footer{ margin-top:1.2rem; text-align:center; color:var(--muted); font-size:.75rem; }
.badge{ display:inline-block; background:rgba(255,255,255,.08); border:1px solid var(--border);
  padding:.35rem .75rem; border-radius:999px; font-size:.75rem; }
.icon{ text-align:center; margin-bottom:.75rem; }
.icon svg{ opacity:.7; }
.date-line{ text-align:center; color:var(--muted); font-size:.78rem; letter-spacing:.06em; text-transform:uppercase; margin:0 0 1.5rem; }
@keyframes card-in{ from{opacity:0;transform:translateY(16px)} to{opacity:1;transform:translateY(0)} }
.card{ animation:card-in .38s cubic-bezier(.22,.68,0,1.2) both; }
@media (max-width:520px){ body{padding:1rem;} .card{padding:2rem 1.25rem;} }
</style>
</head>
<body>
  <div class="card"${errHtml ? ' aria-live="polite"' : ''}>
    <div class="icon">
      <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#a78bfa" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
        <rect x="3" y="11" width="18" height="11" rx="2" ry="2"/>
        <path d="M7 11V7a5 5 0 0 1 10 0v4"/>
      </svg>
    </div>
    <h1>UltraNote</h1>
    <p class="date-line" id="dateline"></p>
    <form method="POST" action="/login" autocomplete="off">
      <div>
        <label for="pw">Password</label>
        <input id="pw" type="password" name="password" placeholder="Enter password" autofocus required />
      </div>
      <button type="submit">Enter Workspace</button>
      ${errHtml}
      <div class="note">"${q}"</div>
    </form>
    <footer><span class="badge">Private</span></footer>
  </div>
  <script>
    const d = new Date();
    document.getElementById('dateline').textContent =
      d.toLocaleDateString(undefined,{weekday:'long',year:'numeric',month:'long',day:'numeric'});
  </script>
</body>
</html>`);
});

// === Login (POST) with throttling + lockout ===
app.post('/login', async (req, res) => {
  const ip = req.ip.replace(/^::ffff:/, '');
  const now = Date.now();
  if (!req.session.login) req.session.login = { attempts: 0, lockedUntil: 0 };

  // Per-IP lockout check (survives cookie-clearing)
  const ipState = ipLockState(ip);
  if (ipState.lockedUntil && ipState.lockedUntil > now) {
    const ms = ipState.lockedUntil - now;
    return res.redirect(`/login?err=locked&ms=${ms}`);
  }

  // lock active? (per-session)
  if (req.session.login.lockedUntil && req.session.login.lockedUntil > now) {
    const ms = req.session.login.lockedUntil - now;
    return res.redirect(`/login?err=locked&ms=${ms}`);
  }

  const password = (req.body.password || '').trim();
  const ok = password === APP_PASSWORD;

  if (ok) {
    // success → clear counters, whitelist IP, mark session authorized
    req.session.login = { attempts: 0, lockedUntil: 0 };
    ipLoginFails.delete(ip);
    allowedIps.add(ip);
    req.session.authorized = true;
    return res.redirect('/');
  }

  // failure → increment attempts, maybe lock (both per-session and per-IP)
  req.session.login.attempts = (req.session.login.attempts || 0) + 1;
  const ipRec = ipLoginFails.get(ip) || { attempts: 0, lockedUntil: 0 };
  ipRec.attempts = (ipRec.attempts || 0) + 1;
  ipLoginFails.set(ip, ipRec);

  if (req.session.login.attempts >= MAX_ATTEMPTS) {
    req.session.login.lockedUntil = now + LOCK_MS;
    return res.redirect(`/login?err=locked&ms=${LOCK_MS}`);
  }
  if (ipRec.attempts >= MAX_ATTEMPTS) {
    ipRec.lockedUntil = now + LOCK_MS;
    return res.redirect(`/login?err=locked&ms=${LOCK_MS}`);
  }

  // gentle delay (throttling): grows with attempts, capped
  const delay = Math.min(200 * Math.max(req.session.login.attempts, ipRec.attempts), 1500);
  await new Promise(r => setTimeout(r, delay));

  const left = MAX_ATTEMPTS - Math.max(req.session.login.attempts, ipRec.attempts);
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
    // Rotate save backups inside backups/: data.json.bak (most recent) → .bak.1 → .bak.N.
    // Ring depth bumped from 3 → 30 on 2026-06-02 after a phone-side rapid-delete
    // sequence overflowed the original 3-slot buffer in seconds and made the
    // accidentally-deleted captures unrecoverable. Real disaster recovery still
    // lives in the private git backup repo via backup.sh; this ring is for the
    // "oops I just clicked save" near-term recovery window.
    const BACKUP_RING_DEPTH = 30;
    if (fs.existsSync(DATA_FILE)) {
      try {
        // Shift the ring: .bak.(N-1) -> .bak.N, …, .bak.1 -> .bak.2, then .bak -> .bak.1, then copy current -> .bak.
        for (let i = BACKUP_RING_DEPTH - 1; i >= 1; i--) {
          const from = `${BACKUP_BASE}.${i}`;
          const to   = `${BACKUP_BASE}.${i + 1}`;
          if (fs.existsSync(from)) fs.renameSync(from, to);
        }
        if (fs.existsSync(BACKUP_BASE)) fs.renameSync(BACKUP_BASE, `${BACKUP_BASE}.1`);
        fs.copyFileSync(DATA_FILE, BACKUP_BASE);
      } catch (rotErr) {
        console.warn('Backup rotation warning:', rotErr.message);
      }
    }
    // Atomic write: write to a temp file in the same directory, then rename.
    // rename() on POSIX is atomic within a filesystem, so a crash mid-write can
    // never leave data.json truncated or partially-written. Worst case: the temp
    // file lingers and the previous data.json is preserved untouched.
    const tmp = `${DATA_FILE}.tmp.${process.pid}.${Date.now()}`;
    fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
    fs.renameSync(tmp, DATA_FILE);
    return true;
  } catch (e) {
    console.error('Write error', e);
    return false;
  }
}

// === CSRF guard for state-changing API calls ===
// All /api/* POST requests must include `X-Requested-With: XMLHttpRequest`.
// Browsers refuse to send custom headers on cross-origin form/img/script
// submissions (those would require a CORS preflight, which we never approve),
// so this header reliably proves the request came from our own JS. Combined
// with `sameSite: 'lax'` on the session cookie, it blocks CSRF on the
// state-changing endpoints without breaking same-origin app.js calls.
function requireSameOrigin(req, res, next) {
  if (req.method !== 'POST') return next();
  const xrw = req.get('X-Requested-With');
  if (xrw === 'XMLHttpRequest') return next();
  return res.status(403).json({ error: 'Forbidden: missing X-Requested-With header' });
}
app.use('/api', requireSameOrigin);

// === Password re-check for editing "immutable" reference content ===
// The Reference Prompts library (db.agentPrompts, see app.js) is presented
// as read-only in the UI. This endpoint lets the user re-enter the *same*
// app password (APP_PASSWORD) as a deliberate confirmation step before the
// edit UI unlocks — a friction/confirmation gate against casual accidental
// edits, not a new privilege boundary: any already-authenticated session can
// already rewrite arbitrary data via POST /api/db, so this doesn't grant
// anything that session didn't already have. Reuses the same per-IP
// attempt/lockout counters as /login so hammering this endpoint also trips
// the existing brute-force protection instead of being a fresh unguarded
// attack surface.
app.post('/api/verify-password', (req, res) => {
  const ip = req.ip.replace(/^::ffff:/, '');
  const now = Date.now();
  const ipState = ipLockState(ip);
  if (ipState.lockedUntil && ipState.lockedUntil > now) {
    return res.status(429).json({ ok: false, error: 'Too many attempts. Try again later.' });
  }
  const password = String((req.body && req.body.password) || '').trim();
  if (password === APP_PASSWORD) {
    ipLoginFails.delete(ip);
    return res.json({ ok: true });
  }
  const ipRec = ipLoginFails.get(ip) || { attempts: 0, lockedUntil: 0 };
  ipRec.attempts = (ipRec.attempts || 0) + 1;
  if (ipRec.attempts >= MAX_ATTEMPTS) ipRec.lockedUntil = now + LOCK_MS;
  ipLoginFails.set(ip, ipRec);
  return res.status(401).json({ ok: false, error: 'Incorrect password' });
});

// === Write-back for sourceFile-backed reference prompts ===
// Some agentPrompts entries (e.g. the Coding-Agent API Guide) mirror a real
// markdown file on disk instead of embedding content inline, so the in-app
// copy never drifts from what's actually checked into the repo. Editing one
// from the UI writes straight back to that file. Tightly whitelisted to a
// bare `<name>.md` filename (no path separators, no `..`) resolved directly
// under the app root, with a second directory-containment check as
// defense-in-depth — this must never become a generic arbitrary-file-write
// endpoint.
app.post('/api/agent-prompt-file', (req, res) => {
  const filename = String((req.body && req.body.file) || '');
  const content = req.body && req.body.content;
  if (typeof content !== 'string') return res.status(400).json({ error: 'content must be a string' });
  if (!/^[A-Za-z0-9_-]+\.md$/.test(filename)) {
    return res.status(400).json({ error: 'Invalid filename' });
  }
  const target = path.join(__dirname, filename);
  if (path.dirname(target) !== __dirname || !fs.existsSync(target)) {
    return res.status(404).json({ error: 'File not found' });
  }
  try {
    fs.writeFileSync(target, content, 'utf8');
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: 'Write failed: ' + e.message });
  }
});

app.get('/api/db', (req, res) => {
  const data = readData();
  if (!data) return res.status(200).json({});
  res.json(data);
});

// arXiv metadata proxy. arXiv's Atom API doesn't send CORS headers, so the
// browser can't call it directly — we proxy through this endpoint. Strictly
// limited to a single ID per request; the upstream URL is constructed from a
// validated ID so we can't be tricked into proxying arbitrary URLs.
app.get('/api/arxiv', async (req, res) => {
  const id = String(req.query.id || '').trim();
  if (!/^([a-z\-]+\/\d{7}|\d{4}\.\d{4,5})(v\d+)?$/i.test(id)) {
    return res.status(400).json({ error: 'Invalid arXiv id' });
  }
  try {
    const url = `https://export.arxiv.org/api/query?id_list=${encodeURIComponent(id)}`;
    const upstream = await fetch(url, { headers: { 'User-Agent': 'UltraNote-Lite/1.0 (local research tool)' } });
    if (!upstream.ok) return res.status(502).json({ error: 'arxiv upstream ' + upstream.status });
    const xml = await upstream.text();
    res.set('Content-Type', 'application/atom+xml; charset=utf-8');
    res.set('Cache-Control', 'public, max-age=86400');
    res.send(xml);
  } catch (e) {
    res.status(502).json({ error: 'arxiv fetch failed: ' + String(e && e.message || e) });
  }
});

app.post('/api/db', (req, res) => {
  const incoming = req.body;
  if (!incoming || typeof incoming !== 'object' || Array.isArray(incoming)) {
    return res.status(400).json({ error: 'Invalid body: expected JSON object' });
  }

  // Boundary validation. The merge below will be defensive on any field, but
  // we reject obviously malformed payloads up-front so a buggy client cannot
  // make the data file unreadable. Limits are generous on purpose — they only
  // exist to stop a runaway/garbage payload, not to constrain real usage.
  const COLLECTIONS = ['notes','tasks','projects','templates','links','monthly','notebooks','activity'];
  const MAX_ITEMS_PER_COLLECTION = 50000;   // ample headroom; user has ~250 notes today
  for (const k of COLLECTIONS) {
    if (incoming[k] === undefined || incoming[k] === null) continue;
    if (!Array.isArray(incoming[k])) {
      return res.status(400).json({ error: `Invalid body: ${k} must be an array` });
    }
    if (incoming[k].length > MAX_ITEMS_PER_COLLECTION) {
      return res.status(400).json({ error: `Too many items in ${k} (${incoming[k].length} > ${MAX_ITEMS_PER_COLLECTION})` });
    }
    // Each record must be an object with a string id; anything else is dropped
    // silently from the merge below (so partial corruption can't take down a save).
    for (let i = 0; i < incoming[k].length; i++) {
      const rec = incoming[k][i];
      if (!rec || typeof rec !== 'object' || typeof rec.id !== 'string') {
        return res.status(400).json({ error: `Invalid record in ${k}[${i}]: missing string id` });
      }
    }
  }
  if (incoming.settings !== undefined &&
      (typeof incoming.settings !== 'object' || Array.isArray(incoming.settings))) {
    return res.status(400).json({ error: 'Invalid body: settings must be an object' });
  }

  // Server-side merge: never let a stale client silently overwrite newer server data.
  // For each array collection, merge by id keeping the record with the latest updatedAt/createdAt.
  // This means a client with an old in-memory db cannot wipe records that were saved by another
  // client (or directly on disk) after the stale client's last fetch.
  const current = readData() || {};

  // Notes the client explicitly confirmed shrinking (after being warned by
  // a previous request's `refusedShrinks` response) — bypasses the guard
  // below for just these ids, on just this request.
  const forceShrinkIds = new Set(Array.isArray(incoming.__forceShrinkIds) ? incoming.__forceShrinkIds : []);
  const refusedShrinks = [];

  function mergeById(serverArr = [], clientArr = [], collection = '') {
    const ts = r => Date.parse(r.updatedAt || r.createdAt || 0);
    const map = new Map();
    // seed with server records
    serverArr.forEach(r => map.set(r.id, r));

    // Content-shrinkage guard. Pure "newer-updatedAt wins" lets a stale tab
    // silently wipe a large note when it pushes a truncated copy with a fresh
    // updatedAt (e.g. bookmarklet capture acked into a tab that loaded the
    // 📥 Inbox hours earlier). On 2026-06-03 this lost 11 capture lines from
    // the Research Inbox in a 7-second window. Backups recovered them, but
    // the right fix is to never let a single save erase >50% of a note's
    // existing content. Edits never shrink notes that violently; this only
    // ever triggers on bug-induced or stale-state overwrites.
    //
    // IMPORTANT: a refusal here is NOT silent — it's collected into
    // `refusedShrinks` and echoed back to the client, which prompts the user
    // to confirm ("did you really mean to delete most of this note?") and,
    // if so, resends with this note's id in `__forceShrinkIds` to bypass the
    // guard on the retry. Without this round-trip, a legitimate large
    // trim/rewrite would look to the user exactly like "my save silently
    // reverted to the old version" the next time the app reloaded from disk.
    const NOTE_SHRINK_FLOOR = 500;       // bytes — only protect non-trivial notes
    const NOTE_SHRINK_RATIO = 0.5;       // refuse if new < server * ratio
    function isDangerousNoteShrink(server, client) {
      if (collection !== 'notes') return false;
      if (!server || !client) return false;
      if (client.deletedAt) return false; // explicit deletion is allowed
      if (forceShrinkIds.has(client.id)) return false; // user already confirmed
      const sLen = (server.content || '').length;
      const cLen = (client.content || '').length;
      if (sLen < NOTE_SHRINK_FLOOR) return false;
      if (cLen >= sLen * NOTE_SHRINK_RATIO) return false;
      return true;
    }

    // apply client records using these rules (in priority order):
    //  1. New record (server doesn't have it) → always add
    //  2. Client deleted it (deletedAt set, server has non-deleted) → honor delete
    //  3. Server deleted it, client has old non-deleted copy of same age → keep delete
    //  4. Dangerous content shrinkage (notes only) → refuse, keep server
    //  5. No conflicting delete → newer timestamp wins
    //  6. Tie or server newer → keep server copy
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
      if (isDangerousNoteShrink(s, r)) {
        console.warn(`[merge-guard] refused content shrink on note ${r.id} ("${(s.title||'').slice(0,40)}"): ${(s.content||'').length} → ${(r.content||'').length} bytes; keeping server copy`);
        refusedShrinks.push({ id: r.id, title: s.title || r.title || '', serverLen: (s.content||'').length, clientLen: (r.content||'').length });
        return;
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
    merged[k] = mergeById(serverArr, clientArr, k);
  });
  // Settings: client wins for all keys (settings changes are intentional)
  merged.settings = { ...(current.settings || {}), ...(incoming.settings || {}) };
  merged.version = Math.max(current.version || 1, incoming.version || 1);

  if (!writeData(merged)) return res.status(500).json({ error: 'Persist failed' });
  // The merged db is normally echoed so the posting client can pick up any
  // records other clients added since its last sync. With a multi-MB db that
  // doubles every save's payload. Clients can opt out via ?noEcho=1 and rely
  // on the autosync layer for cross-device pickup instead.
  if (req.query.noEcho === '1') {
    return res.json(refusedShrinks.length ? { ok: true, refusedShrinks } : { ok: true });
  }
  res.json(refusedShrinks.length ? { ok: true, db: merged, refusedShrinks } : { ok: true, db: merged });
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

// ── Attachments out-of-band store ───────────────────────────────────────────
// Attachments (images, audio, video, files) used to live as base64 inside
// data.json, which made the DB multi-MB and dominated every save/load. They
// now live on disk under ./attachments/<id>.bin and are referenced by id in
// data.json. Records keep { id, name, type, size, createdAt } only.
function attachmentPath(id){
  // Allow only alphanumerics + a few safe chars to prevent path traversal.
  if (!/^[A-Za-z0-9_-]{4,64}$/.test(String(id || ''))) return null;
  return path.join(ATTACHMENTS_DIR, `${id}.bin`);
}
// Small sidecar file recording { name, type } next to the binary. Needed
// because inline images embedded directly in note markdown (pasted/dragged
// into the editor) never get a matching entry in any note's `attachments`
// array — the old MIME lookup (scanning data.json notes) silently missed
// those and served them as application/octet-stream, which some browsers/
// viewers won't render inline.
function attachmentMetaPath(id){
  const p = attachmentPath(id);
  return p ? p.replace(/\.bin$/, '.meta.json') : null;
}
function parseDataUrl(dataUrl){
  // "data:image/png;base64,iVBORw0K..." → { mime, buffer }
  const m = /^data:([^;,]+);base64,(.+)$/.exec(String(dataUrl || ''));
  if (!m) return null;
  try { return { mime: m[1], buffer: Buffer.from(m[2], 'base64') }; }
  catch (_) { return null; }
}

// POST /api/attachments  body: { id?, name, type, data: "data:...;base64,..." }
// Decodes the base64 payload, writes attachments/<id>.bin, returns { id, name, type, size }.
app.post('/api/attachments', (req, res) => {
  const { id, name, type, data } = req.body || {};
  const safeId = id && /^[A-Za-z0-9_-]{4,64}$/.test(id)
    ? id
    : require('crypto').randomBytes(9).toString('base64url').replace(/[^A-Za-z0-9_-]/g,'').slice(0,16);
  const parsed = parseDataUrl(data);
  if (!parsed) return res.status(400).json({ error: 'Invalid data url' });
  const target = attachmentPath(safeId);
  if (!target) return res.status(400).json({ error: 'Invalid id' });
  const finalType = String(type || parsed.mime || 'application/octet-stream');
  const finalName = String(name || 'attachment');
  try {
    fs.writeFileSync(target, parsed.buffer);
    fs.writeFileSync(attachmentMetaPath(safeId), JSON.stringify({ name: finalName, type: finalType }));
  } catch (e) {
    console.error('attachment write failed', e);
    return res.status(500).json({ error: 'Write failed' });
  }
  res.json({
    ok: true,
    id: safeId,
    name: finalName,
    type: finalType,
    size: parsed.buffer.length
  });
});

// GET /api/attachments/:id  — streams the binary with the correct Content-Type.
// Cacheable: the binary for a given id is immutable.
app.get('/api/attachments/:id', (req, res) => {
  const p = attachmentPath(req.params.id);
  if (!p) return res.status(400).json({ error: 'Invalid id' });
  if (!fs.existsSync(p)) return res.status(404).json({ error: 'Not found' });
  let mime = 'application/octet-stream';
  let name = '';
  // Preferred: the sidecar written at upload time (works for both note
  // attachments AND inline images, which have no data.json record at all).
  try {
    const metaPath = attachmentMetaPath(req.params.id);
    if (metaPath && fs.existsSync(metaPath)) {
      const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
      mime = meta.type || mime;
      name = meta.name || '';
    }
  } catch (_) {}
  // Fallback for attachments uploaded before the sidecar existed: scan
  // data.json's note attachment records like before.
  if (mime === 'application/octet-stream') {
    try {
      const d = readData();
      outer: for (const n of (d && d.notes) || []) {
        for (const a of (n.attachments || [])) {
          if (a.id === req.params.id) { mime = a.type || mime; name = a.name || name; break outer; }
        }
      }
    } catch (_) {}
  }
  res.setHeader('Content-Type', mime);
  res.setHeader('Cache-Control', 'private, max-age=31536000, immutable');
  if (name) res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(name)}"`);
  fs.createReadStream(p).pipe(res);
});

// DELETE /api/attachments/:id  — remove the binary + its sidecar. Caller is
// responsible for removing the metadata entry from data.json (for note
// attachments) via the usual /api/db save; inline images have no such entry.
app.delete('/api/attachments/:id', (req, res) => {
  const p = attachmentPath(req.params.id);
  if (!p) return res.status(400).json({ error: 'Invalid id' });
  try {
    if (fs.existsSync(p)) fs.unlinkSync(p);
    const metaPath = attachmentMetaPath(req.params.id);
    if (metaPath && fs.existsSync(metaPath)) fs.unlinkSync(metaPath);
    res.json({ ok: true });
  } catch (e) {
    console.error('attachment delete failed', e);
    res.status(500).json({ error: 'Delete failed' });
  }
});

// One-time migration on boot: any attachment record that still has an inline
// `data` field gets written to disk and the inline data is stripped. Safe to
// run repeatedly — only acts on records that still have a `data` field.
function migrateAttachmentsToDisk(){
  try {
    const d = readData();
    if (!d || !Array.isArray(d.notes)) return;
    let migrated = 0, failed = 0;
    for (const n of d.notes) {
      if (!Array.isArray(n.attachments)) continue;
      for (const a of n.attachments) {
        if (!a || !a.data) continue;
        const target = attachmentPath(a.id);
        if (!target) { failed++; continue; }
        const parsed = parseDataUrl(a.data);
        if (!parsed) { failed++; continue; }
        try {
          // Only strip the inline data after the file write succeeds.
          if (!fs.existsSync(target)) fs.writeFileSync(target, parsed.buffer);
          // Write the sidecar too so GET /api/attachments/:id doesn't need to
          // fall back to scanning data.json for this record's MIME type.
          const metaPath = attachmentMetaPath(a.id);
          if (metaPath && !fs.existsSync(metaPath)) {
            fs.writeFileSync(metaPath, JSON.stringify({ name: a.name || '', type: a.type || parsed.mime || 'application/octet-stream' }));
          }
          a.size = parsed.buffer.length;
          delete a.data;
          migrated++;
        } catch (e) {
          console.error('attachment migration failed for', a.id, e.message);
          failed++;
        }
      }
    }
    if (migrated) {
      writeData(d);
      console.log(`📎 migrateAttachmentsToDisk: moved ${migrated} attachment(s) out of data.json` + (failed ? `, ${failed} failed` : ''));
    }
  } catch (e) {
    console.error('migrateAttachmentsToDisk error', e);
  }
}
migrateAttachmentsToDisk();
// ── End attachments store ───────────────────────────────────────────────────

// Serve static files after the auth middleware so unauthorized users cannot fetch them
app.use(express.static(__dirname));

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});