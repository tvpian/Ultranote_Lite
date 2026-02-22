module.exports = {
  apps: [{
    name: "ultranote",
    script: "server.js",
    env: { NODE_ENV: "production", PORT: 3366 , APP_PASSWORD: "tvp_2407" },
    watch: ['server.js', 'app.js', 'autosync.js', 'styles.css', 'index.html', 'sw.js'],
    ignore_watch: ['data.json', 'node_modules', '*.log', '.git'],
    instances: 1, // or "max" for cluster
    autorestart: true
  }]
}
