module.exports = {
  apps: [{
    name: "ultranote",
    script: "server.js",
    env: { NODE_ENV: "production", PORT: 3366 , APP_PASSWORD: "tvp_2407" },
    watch: ['server.js'],  // Only restart server for server-side code changes. Client files (app.js, styles.css, etc.) are static — PM2 does NOT need to restart for them, and restarting wipes in-memory sessions causing unwanted lock-screen redirects.
    ignore_watch: ['data.json', 'node_modules', '*.log', '.git'],
    instances: 1,
    exec_mode: 'fork',
    autorestart: true
  }]
}
