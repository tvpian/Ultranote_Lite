const express  = require('express');
const fs       = require('fs');
const path     = require('path');
const session  = require('express-session');

const app      = express();
const PORT     = process.env.PORT || 3366;
const DATA_FILE = path.join(__dirname, 'data.json');

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

// Login form (GET)
app.get('/login', (req, res) => {
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>UltraNote – Login</title>
<style>
:root{--bg:#0b0f14;--card:#121924;--fg:#e8eef7;--muted:#a9b6c6;--acc:#4ea1ff;--border:#1e2938;--input-bg:#0f1621;--input-border:#203041;--btn-bg:#122134;--btn-border:#274768;}
*{box-sizing:border-box;font-family:system-ui,Segoe UI,Roboto,Helvetica,Arial,sans-serif;}
body{margin:0;background:var(--bg);color:var(--fg);min-height:100dvh;display:flex;align-items:center;justify-content:center;padding:32px;}
.card{background:var(--card);border:1px solid var(--border);border-radius:20px;padding:40px 36px;max-width:420px;width:100%;box-shadow:0 12px 40px -8px rgba(0,0,0,.55),0 2px 6px rgba(0,0,0,.4);}
h1{margin:0 0 6px;font-size:26px;letter-spacing:.5px;text-align:center;font-weight:600;}
.subtitle{text-align:center;color:var(--muted);font-size:14px;margin:0 0 28px;}
form{display:flex;flex-direction:column;gap:18px;margin:0;}
label{font-size:13px;text-transform:uppercase;letter-spacing:.8px;font-weight:600;color:var(--muted);}
input[type=password]{width:100%;padding:14px 16px;border-radius:14px;border:1px solid var(--input-border);background:var(--input-bg);color:var(--fg);font-size:15px;outline:none;transition:border-color .18s, background .18s;}
input[type=password]:focus{border-color:var(--acc);}
button{padding:14px 18px;border-radius:14px;border:1px solid var(--acc);background:linear-gradient(145deg,var(--acc),#2d7ac5);color:#fff;font-size:15px;font-weight:600;cursor:pointer;letter-spacing:.4px;box-shadow:0 4px 14px -4px rgba(78,161,255,.6);transition:filter .2s, transform .15s;}
button:hover{filter:brightness(1.05);}button:active{transform:translateY(1px);}
footer{margin-top:26px;text-align:center;font-size:12px;color:var(--muted);}
.badge{display:inline-block;background:rgba(255,255,255,.06);border:1px solid var(--border);padding:4px 10px;border-radius:999px;font-size:11px;margin-top:4px;}
.note{font-size:12px;color:var(--muted);line-height:1.4;margin-top:-6px;text-align:center;}
.err{color:#ff6b6b;font-size:13px;text-align:center;margin-top:-8px;}
@media (max-width:520px){body{padding:18px;} .card{padding:34px 28px;border-radius:18px;}}
</style>
</head>
<body>
  <div class="card">
    <h1>UltraNote</h1>
    <p class="subtitle">Secure Access</p>
    <form method="POST" action="/login" autocomplete="off">
      <div>
        <label for="pw">Password</label>
        <input id="pw" type="password" name="password" placeholder="Enter password" autofocus required />
      </div>
      <button type="submit">Enter Workspace</button>
      ${req.query.err ? '<div class="err">Incorrect password</div>' : ''}
      <div class="note">Set APP_PASSWORD env var to change this. Session persists for this IP.</div>
    </form>
    <footer><span class="badge">Local‑first</span></footer>
  </div>
</body>
</html>`);
});

// Login handler (POST)
app.post('/login', (req, res) => {
  const password = req.body.password;
  if (password === APP_PASSWORD) {
    // Whitelist the current IP and mark this session as authorized
    const ip = req.ip.replace(/^::ffff:/, '');
    allowedIps.add(ip);
    req.session.authorized = true;
    return res.redirect('/');
  }
  res.status(401).send('Incorrect password');
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
