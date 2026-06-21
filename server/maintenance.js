import { config } from "./config.js";
import {
  cleanupAllKlineRetention,
  cleanupExpiredData,
  cleanupTriggerHistoryRetention,
  getMaintenanceState,
  markMaintenanceState
} from "./db.js";
import { cleanupRuntimeLogFiles } from "./runtimeLogs.js";

const KLINE_CLEANUP_TASK = "kline_retention_cleanup";
const TRIGGER_HISTORY_CLEANUP_TASK = "trigger_history_cleanup";
const RUNTIME_LOG_CLEANUP_TASK = "runtime_log_cleanup";
const HOUR_MS = 60 * 60 * 1000;

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

const triggerHistoryCleanupState = {
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

function hoursToMs(value, fallbackHours = 4) {
  return Math.max(1, Number(value) || fallbackHours) * HOUR_MS;
}

function nextIntervalDelayMs(lastRunAt, intervalMs) {
  if (!lastRunAt) return 0;
  const lastRunMs = new Date(lastRunAt).getTime();
  if (!Number.isFinite(lastRunMs)) return 0;
  return Math.max(0, lastRunMs + intervalMs - Date.now());
}

export function getMaintenanceRuntimeState() {
  return {
    running: maintenanceState.running,
    lastRunAt: maintenanceState.lastRunAt,
    lastResult: maintenanceState.lastResult,
    nextCheckAt: maintenanceState.nextCheckAt,
    lastError: maintenanceState.lastError,
    triggerHistoryCleanup: {
      running: triggerHistoryCleanupState.running,
      lastRunAt: triggerHistoryCleanupState.lastRunAt,
      lastResult: triggerHistoryCleanupState.lastResult,
      nextRunAt: triggerHistoryCleanupState.nextRunAt,
      lastError: triggerHistoryCleanupState.lastError
    },
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

async function loadCleanupState(taskName, state) {
  const stored = await getMaintenanceState(taskName);
  state.lastRunAt = stored?.lastRunAt ?? null;
  state.lastResult = stored?.lastResult ?? null;
  return state;
}

export async function runTriggerHistoryCleanup() {
  if (triggerHistoryCleanupState.running) return triggerHistoryCleanupState;
  triggerHistoryCleanupState.running = true;
  try {
    const deletedRows = await cleanupTriggerHistoryRetention();
    const summary = JSON.stringify({
      retentionHours: config.maintenance.triggerHistoryRetentionHours,
      deletedRows
    });
    await markMaintenanceState(TRIGGER_HISTORY_CLEANUP_TASK, summary);
    const updated = await getMaintenanceState(TRIGGER_HISTORY_CLEANUP_TASK);
    triggerHistoryCleanupState.lastRunAt = updated?.lastRunAt ?? null;
    triggerHistoryCleanupState.lastResult = updated?.lastResult ?? summary;
    triggerHistoryCleanupState.lastError = null;
    return triggerHistoryCleanupState;
  } catch (error) {
    triggerHistoryCleanupState.lastError = error instanceof Error ? error.message : String(error);
    throw error;
  } finally {
    triggerHistoryCleanupState.running = false;
  }
}

export async function runRuntimeLogCleanup() {
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

function scheduleIntervalCleanup(state, runner, intervalMs, { afterFailure = false } = {}) {
  if (state.timer) clearTimeout(state.timer);
  const delayMs = afterFailure ? intervalMs : nextIntervalDelayMs(state.lastRunAt, intervalMs);
  const nextRunAt = new Date(Date.now() + delayMs);
  state.nextRunAt = nextRunAt.toISOString();
  state.timer = setTimeout(async () => {
    let failed = false;
    try {
      await runner();
    } catch (error) {
      failed = true;
      state.lastError = error instanceof Error ? error.message : String(error);
      state.lastResult = state.lastError;
    } finally {
      scheduleIntervalCleanup(state, runner, intervalMs, { afterFailure: failed });
    }
  }, delayMs);
  state.timer.unref?.();
}

function scheduleNextTriggerHistoryCleanup() {
  scheduleIntervalCleanup(
    triggerHistoryCleanupState,
    runTriggerHistoryCleanup,
    hoursToMs(config.maintenance.recordCleanupIntervalHours)
  );
}

function scheduleNextRuntimeLogCleanup() {
  scheduleIntervalCleanup(
    runtimeLogCleanupState,
    runRuntimeLogCleanup,
    hoursToMs(config.maintenance.runtimeLogCleanupIntervalHours)
  );
}

export async function startMaintenanceScheduler() {
  await runWeeklyKlineCleanupIfDue({ initializeOnly: true });
  await loadCleanupState(TRIGGER_HISTORY_CLEANUP_TASK, triggerHistoryCleanupState);
  await loadCleanupState(RUNTIME_LOG_CLEANUP_TASK, runtimeLogCleanupState);
  scheduleNextTriggerHistoryCleanup();
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
