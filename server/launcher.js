import { spawn } from "node:child_process";

const services = [
  ["api", "server/index.js"],
  ["crawler", "server/crawlerService.js"],
  ["realtime", "server/realtimeService.js"],
  ["scheduler", "server/schedulerService.js"]
];

const children = new Map();
let stopping = false;

function startService(role, entry) {
  const child = spawn(process.execPath, [entry], {
    cwd: process.cwd(),
    env: { ...process.env, SERVICE_ROLE: role },
    stdio: "inherit"
  });
  children.set(role, child);
  child.on("exit", (code, signal) => {
    children.delete(role);
    if (stopping) return;
    console.error(`[launcher] ${role} exited (${signal || code || 0}); stopping service group`);
    stopAll(code || 1);
  });
}

function stopAll(exitCode = 0) {
  if (stopping) return;
  stopping = true;
  for (const child of children.values()) child.kill("SIGTERM");
  const timer = setTimeout(() => {
    for (const child of children.values()) child.kill("SIGKILL");
    process.exit(exitCode);
  }, 8000);
  timer.unref();
  Promise.all(
    Array.from(children.values(), (child) =>
      new Promise((resolve) => {
        if (child.exitCode !== null) resolve();
        else child.once("exit", resolve);
      })
    )
  ).finally(() => process.exit(exitCode));
}

for (const [role, entry] of services) startService(role, entry);

process.on("SIGINT", () => stopAll(0));
process.on("SIGTERM", () => stopAll(0));
process.on("SIGHUP", () => stopAll(0));
