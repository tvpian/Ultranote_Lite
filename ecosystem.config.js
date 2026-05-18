// Load secrets from .env (gitignored). Each non-comment line is `KEY=VALUE`.
// Anything not present in .env will simply be missing from the env, and server.js
// will fall back to its own placeholder defaults — so a clean clone never
// silently inherits a stale credential.
const fs = require('fs');
const path = require('path');
const envFile = path.join(__dirname, '.env');
const env = { NODE_ENV: 'production', PORT: '3366' };
try {
  if (fs.existsSync(envFile)) {
    fs.readFileSync(envFile, 'utf8').split(/\r?\n/).forEach(line => {
      const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/);
      if (!m) return;
      let val = m[2];
      // Strip optional surrounding quotes
      if ((val.startsWith('"') && val.endsWith('"')) ||
          (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      env[m[1]] = val;
    });
  }
} catch (e) {
  console.warn('ecosystem.config.js: could not read .env:', e.message);
}

module.exports = {
  apps: [{
    name: "ultranote",
    script: "server.js",
    env,
    watch: ['server.js'],  // Only restart server for server-side code changes. Client files (app.js, styles.css, etc.) are static — PM2 does NOT need to restart for them, and restarting wipes in-memory sessions causing unwanted lock-screen redirects.
    ignore_watch: ['data.json', 'node_modules', '*.log', '.git'],
    instances: 1,
    exec_mode: 'fork',
    autorestart: true
  }]
}
