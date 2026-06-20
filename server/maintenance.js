import { config } from "./config.js";
import { nextDailyRunAt } from "./dailySchedule.js";
import {
  cleanupAllKlineRetention,
  cleanupExpiredData,
  getMaintenanceState,
  markMaintenanceState
} from "./db.js";
import { cleanupRuntimeLogFiles } from "./runtimeLogs.js";

const KLINE_CLEANUP_TASK = "kline_retention_cleanup";
const RUNTIME_LOG_CLEANUP_TASK = "runtime_log_cleanup";

const maintenanceState = {
  running: false,
  lastRunAt: null,
  lastResult: null,
  nextCheckAt: null,
  lastError: null,
  timer: null
};

const runtimeLogCleanupState = {
  running: false,
  lastRunAt: null,
  lastResult: null,
  nextRunAt: null,
  lastError: null,
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
    nextCheckAt: maintenanceState.nextCheckAt,
    lastError: maintenanceState.lastError,
    runtimeLogCleanup: {
      running: runtimeLogCleanupState.running,
      lastRunAt: runtimeLogCleanupState.lastRunAt,
      lastResult: runtimeLogCleanupState.lastResult,
      nextRunAt: runtimeLogCleanupState.nextRunAt,
      lastError: runtimeLogCleanupState.lastError
    }
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
    const [klineRetention, expiredData] = await Promise.all([
      cleanupAllKlineRetention(config.crawler.retentionLimits),
      cleanupExpiredData()
    ]);
    const result = { klineRetention, expiredData };
    const summary = JSON.stringify(result);
    await markMaintenanceState(KLINE_CLEANUP_TASK, summary);
    const updated = await getMaintenanceState(KLINE_CLEANUP_TASK);
    maintenanceState.lastRunAt = updated?.lastRunAt ?? null;
    maintenanceState.lastResult = updated?.lastResult ?? summary;
    maintenanceState.lastError = null;
    return maintenanceState;
  } catch (error) {
    maintenanceState.lastError = error instanceof Error ? error.message : String(error);
    throw error;
  } finally {
    maintenanceState.running = false;
  }
}

async function loadRuntimeLogCleanupState() {
  const stored = await getMaintenanceState(RUNTIME_LOG_CLEANUP_TASK);
  runtimeLogCleanupState.lastRunAt = stored?.lastRunAt ?? null;
  runtimeLogCleanupState.lastResult = stored?.lastResult ?? null;
  return runtimeLogCleanupState;
}

export async function runDailyRuntimeLogCleanup() {
  if (runtimeLogCleanupState.running) return runtimeLogCleanupState;
  runtimeLogCleanupState.running = true;
  try {
    const result = await cleanupRuntimeLogFiles();
    const summary = JSON.stringify({
      fileCount: result.fileCount,
      truncatedCount: result.truncatedCount,
      truncatedBytes: result.truncatedBytes
    });
    await markMaintenanceState(RUNTIME_LOG_CLEANUP_TASK, summary);
    const updated = await getMaintenanceState(RUNTIME_LOG_CLEANUP_TASK);
    runtimeLogCleanupState.lastRunAt = updated?.lastRunAt ?? null;
    runtimeLogCleanupState.lastResult = updated?.lastResult ?? summary;
    runtimeLogCleanupState.lastError = null;
    return runtimeLogCleanupState;
  } catch (error) {
    runtimeLogCleanupState.lastError = error instanceof Error ? error.message : String(error);
    throw error;
  } finally {
    runtimeLogCleanupState.running = false;
  }
}

function scheduleNextRuntimeLogCleanup() {
  const nextRunAt = nextDailyRunAt(config.maintenance.runtimeLogCleanupHour);
  runtimeLogCleanupState.nextRunAt = nextRunAt.toISOString();
  runtimeLogCleanupState.timer = setTimeout(async () => {
    try {
      await runDailyRuntimeLogCleanup();
    } catch (error) {
      runtimeLogCleanupState.lastError = error instanceof Error ? error.message : String(error);
      runtimeLogCleanupState.lastResult = runtimeLogCleanupState.lastError;
    } finally {
      scheduleNextRuntimeLogCleanup();
    }
  }, Math.max(0, nextRunAt.getTime() - Date.now()));
  runtimeLogCleanupState.timer.unref?.();
}

export async function startMaintenanceScheduler() {
  await runWeeklyKlineCleanupIfDue({ initializeOnly: true });
  await loadRuntimeLogCleanupState();
  scheduleNextRuntimeLogCleanup();
  const tick = async () => {
    maintenanceState.nextCheckAt = new Date(Date.now() + config.maintenance.checkIntervalMs).toISOString();
    try {
      await runWeeklyKlineCleanupIfDue();
    } catch (error) {
      maintenanceState.lastResult = error instanceof Error ? error.message : String(error);
      maintenanceState.lastError = maintenanceState.lastResult;
    }
  };
  maintenanceState.nextCheckAt = new Date(Date.now() + config.maintenance.checkIntervalMs).toISOString();
  maintenanceState.timer = setInterval(tick, config.maintenance.checkIntervalMs);
  return maintenanceState;
}
