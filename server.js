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
const allowedIps = new Set(['127.0.0.1', '::1']);

// Middlewares to parse JSON and URL‑encoded bodies
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));

// Session middleware – the session data lives server‑side:contentReference[oaicite:0]{index=0}
app.use(session({
  secret: 'ultranote-session-secret',
  resave: false,
  saveUninitialized: false
}));

// Motivational quotes pool (randomized on each /login render)
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
    'Stay consistent—success will follow.',
    'Progress, not perfection.',
    'Discipline beats motivation.'
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
.note{ font-size:.9rem; color:var(--muted); text-align:center; margin-top:.6rem; font-style:italic; }
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
    return JSON.parse(txt);
  } catch (e) {
    console.error('Read error', e);
    return null;
  }
}

function writeData(obj) {
  try {
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
  const body = req.body;
  if (!body || typeof body !== 'object') {
    return res.status(400).json({ error: 'Invalid body' });
  }
  if (!writeData(body)) return res.status(500).json({ error: 'Persist failed' });
  res.json({ ok: true });
});

// Serve static files after the auth middleware so unauthorized users cannot fetch them
app.use(express.static(__dirname));

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
