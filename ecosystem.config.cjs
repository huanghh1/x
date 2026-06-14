module.exports = {
  apps: [
    {
      name: "monitor-api",
      script: "server/index.js",
      env: { SERVICE_ROLE: "api" },
      autorestart: true,
      max_memory_restart: "500M"
    },
    {
      name: "monitor-crawler",
      script: "server/crawlerService.js",
      env: { SERVICE_ROLE: "crawler" },
      autorestart: true,
      max_memory_restart: "900M"
    },
    {
      name: "monitor-realtime",
      script: "server/realtimeService.js",
      env: { SERVICE_ROLE: "realtime" },
      autorestart: true,
      max_memory_restart: "500M"
    },
    {
      name: "monitor-scheduler",
      script: "server/schedulerService.js",
      env: { SERVICE_ROLE: "scheduler" },
      autorestart: true,
      max_memory_restart: "500M"
    }
  ]
};
