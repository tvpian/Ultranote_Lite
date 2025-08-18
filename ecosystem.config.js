module.exports = {
  apps: [{
    name: "ultranote",
    script: "server.js",
    env: { NODE_ENV: "production", PORT: 3366 , APP_PASSWORD: "tvp_2407" },
    watch: true,
    instances: 1, // or "max" for cluster
    autorestart: true
  }]
}
