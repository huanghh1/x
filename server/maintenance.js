import { config } from "./config.js";
import { cleanupAllKlineRetention, getMaintenanceState, markMaintenanceState } from "./db.js";

const KLINE_CLEANUP_TASK = "kline_retention_cleanup";

const maintenanceState = {
  running: false,
  lastRunAt: null,
  lastResult: null,
  nextCheckAt: null,
  timer: null
};

function cleanupDue(lastRunAt) {
  if (!lastRunAt) return false;
  const lastRunMs = new Date(lastRunAt).getTime();
  if (!Number.isFinite(lastRunMs)) return true;
  return Date.now() - lastRunMs >= config.maintenance.cleanupIntervalDays * 24 * 60 * 60 * 1000;
}

export function getMaintenanceRuntimeState() {
  return {
    running: maintenanceState.running,
    lastRunAt: maintenanceState.lastRunAt,
    lastResult: maintenanceState.lastResult,
    nextCheckAt: maintenanceState.nextCheckAt
  };
}

export async function runWeeklyKlineCleanupIfDue({ initializeOnly = false } = {}) {
  if (maintenanceState.running) return maintenanceState;
  const stored = await getMaintenanceState(KLINE_CLEANUP_TASK);

  if (!stored) {
    await markMaintenanceState(KLINE_CLEANUP_TASK, "initialized; next cleanup after interval");
    const initialized = await getMaintenanceState(KLINE_CLEANUP_TASK);
    maintenanceState.lastRunAt = initialized?.lastRunAt ?? null;
    maintenanceState.lastResult = initialized?.lastResult ?? null;
    return maintenanceState;
  }

  maintenanceState.lastRunAt = stored.lastRunAt;
  maintenanceState.lastResult = stored.lastResult;
  if (initializeOnly || !cleanupDue(stored.lastRunAt)) return maintenanceState;

  maintenanceState.running = true;
  try {
    const result = await cleanupAllKlineRetention(config.crawler.retentionLimits);
    const summary = JSON.stringify(result);
    await markMaintenanceState(KLINE_CLEANUP_TASK, summary);
    const updated = await getMaintenanceState(KLINE_CLEANUP_TASK);
    maintenanceState.lastRunAt = updated?.lastRunAt ?? null;
    maintenanceState.lastResult = updated?.lastResult ?? summary;
    return maintenanceState;
  } finally {
    maintenanceState.running = false;
  }
}

export async function startMaintenanceScheduler() {
  await runWeeklyKlineCleanupIfDue({ initializeOnly: true });
  const tick = async () => {
    maintenanceState.nextCheckAt = new Date(Date.now() + config.maintenance.checkIntervalMs).toISOString();
    try {
      await runWeeklyKlineCleanupIfDue();
    } catch (error) {
      maintenanceState.lastResult = error instanceof Error ? error.message : String(error);
    }
  };
  maintenanceState.nextCheckAt = new Date(Date.now() + config.maintenance.checkIntervalMs).toISOString();
  maintenanceState.timer = setInterval(tick, config.maintenance.checkIntervalMs);
  return maintenanceState;
}
