import { fetchFundingInfo } from "./binance.js";
import { config } from "./config.js";
import {
  getMaintenanceState,
  listPendingFundingIntervalAlerts,
  markFundingIntervalAlertSent,
  markFundingIntervalsMissingFromSnapshot,
  markMaintenanceState,
  recordFundingIntervalSnapshot
} from "./db.js";
import { sendFundingIntervalTelegram } from "./telegram.js";

const BASELINE_TASK = "funding_interval_monitor_baseline";
const CHECK_TASK = "funding_interval_monitor";

let timer = null;

const fundingMonitorState = {
  running: false,
  lastStartedAt: null,
  lastSuccessAt: null,
  lastError: null,
  nextRunAt: null,
  lastSeenCount: 0,
  lastMissingCount: 0,
  lastPendingCount: 0,
  lastAlertedSymbols: [],
  lastSkippedAlerts: []
};

function isoNow() {
  return new Date().toISOString();
}

function scheduleNext(delayMs) {
  if (!config.fundingMonitor.enabled) {
    fundingMonitorState.nextRunAt = null;
    return;
  }
  if (timer) clearTimeout(timer);
  const safeDelay = Math.max(1000, Number(delayMs) || config.fundingMonitor.scanIntervalMs);
  fundingMonitorState.nextRunAt = new Date(Date.now() + safeDelay).toISOString();
  timer = setTimeout(async () => {
    try {
      await runFundingIntervalCheck();
    } catch (error) {
      console.error("funding interval monitor failed", error);
    } finally {
      scheduleNext(config.fundingMonitor.scanIntervalMs);
    }
  }, safeDelay);
  timer.unref?.();
}

export function getFundingIntervalMonitorState() {
  return {
    enabled: config.fundingMonitor.enabled,
    scanIntervalMs: config.fundingMonitor.scanIntervalMs,
    targetIntervalHours: config.fundingMonitor.targetIntervalHours,
    defaultIntervalHours: config.fundingMonitor.defaultIntervalHours,
    ...fundingMonitorState
  };
}

export function startFundingIntervalMonitor() {
  if (!config.fundingMonitor.enabled) return getFundingIntervalMonitorState();
  if (timer) return getFundingIntervalMonitorState();
  scheduleNext(config.fundingMonitor.initialDelayMs);
  return getFundingIntervalMonitorState();
}

export async function runFundingIntervalCheck({ force = false } = {}) {
  if (!config.fundingMonitor.enabled && !force) {
    return { skipped: true, reason: "Funding interval monitor disabled" };
  }
  if (fundingMonitorState.running) {
    return { skipped: true, reason: "Funding interval monitor already running" };
  }

  fundingMonitorState.running = true;
  fundingMonitorState.lastStartedAt = isoNow();
  fundingMonitorState.lastError = null;

  try {
    const baselineState = await getMaintenanceState(BASELINE_TASK);
    const baselineOnly = !baselineState;
    const items = await fetchFundingInfo();
    const snapshot = await recordFundingIntervalSnapshot(items);
    const missingCount = await markFundingIntervalsMissingFromSnapshot(
      snapshot.symbols,
      config.fundingMonitor.defaultIntervalHours
    );

    if (baselineOnly) {
      const baselineTargetSymbols = items
        .filter((item) => Number(item.fundingIntervalHours) === Number(config.fundingMonitor.targetIntervalHours))
        .map((item) => item.symbol);
      await markFundingIntervalAlertSent(baselineTargetSymbols);
      await markMaintenanceState(
        BASELINE_TASK,
        `baseline seen=${snapshot.seenCount}, suppressedTarget=${baselineTargetSymbols.length}`
      );
    }

    const pendingAlerts = baselineOnly
      ? []
      : await listPendingFundingIntervalAlerts(config.fundingMonitor.targetIntervalHours);
    const sentSymbols = [];
    const skippedAlerts = [];

    for (const alert of pendingAlerts) {
      try {
        const result = await sendFundingIntervalTelegram(alert);
        if (result.skipped) {
          skippedAlerts.push(`${alert.symbol}: ${result.reason}`);
        } else {
          sentSymbols.push(alert.symbol);
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        skippedAlerts.push(`${alert.symbol}: ${message}`);
        console.error("funding interval telegram alert failed", alert.symbol, error);
      }
    }

    if (sentSymbols.length) await markFundingIntervalAlertSent(sentSymbols);

    fundingMonitorState.lastSuccessAt = isoNow();
    fundingMonitorState.lastSeenCount = snapshot.seenCount;
    fundingMonitorState.lastMissingCount = missingCount;
    fundingMonitorState.lastPendingCount = pendingAlerts.length;
    fundingMonitorState.lastAlertedSymbols = sentSymbols;
    fundingMonitorState.lastSkippedAlerts = skippedAlerts.slice(0, 20);

    const result = {
      ok: true,
      baselineOnly,
      seenCount: snapshot.seenCount,
      missingCount,
      pendingCount: pendingAlerts.length,
      sentSymbols,
      skippedAlerts
    };
    await markMaintenanceState(CHECK_TASK, JSON.stringify(result));
    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    fundingMonitorState.lastError = message;
    await markMaintenanceState(CHECK_TASK, `failed: ${message}`).catch(() => {});
    throw error;
  } finally {
    fundingMonitorState.running = false;
  }
}
