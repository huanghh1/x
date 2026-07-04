import { fetchCurrentFundingRates, fetchFundingInfo } from "./binance.js";
import { config } from "./config.js";
import {
  getMaintenanceState,
  getSignalCorrelationContext,
  markFundingIntervalAlertConfirmed,
  listPendingFundingIntervalAlerts,
  markFundingIntervalAlertSent,
  markFundingIntervalsMissingFromSnapshot,
  markMaintenanceState,
  recordFundingIntervalSnapshot
} from "./db.js";
import { sendFundingIntervalTelegram } from "./telegram.js";

const BASELINE_TASK = "funding_interval_monitor_baseline";
const CHECK_TASK = "funding_interval_monitor";
const ALERT_TASK = "funding_interval_pending_alerts";

let scanTimer = null;
let alertTimer = null;

const fundingMonitorState = {
  running: false,
  alertRunning: false,
  lastStartedAt: null,
  lastSuccessAt: null,
  lastError: null,
  nextRunAt: null,
  lastAlertStartedAt: null,
  lastAlertSuccessAt: null,
  lastAlertError: null,
  nextAlertRunAt: null,
  lastSeenCount: 0,
  lastMissingCount: 0,
  lastPendingCount: 0,
  lastAlertedSymbols: [],
  lastSkippedAlerts: []
};

function isoNow() {
  return new Date().toISOString();
}

export function hasReliableFundingIntervalSnapshot(fundingInfo, currentRates) {
  return Array.isArray(fundingInfo) && fundingInfo.length > 0 && Array.isArray(currentRates);
}

function scheduleNextScan(delayMs) {
  if (!config.fundingMonitor.enabled) {
    fundingMonitorState.nextRunAt = null;
    return;
  }
  if (scanTimer) clearTimeout(scanTimer);
  const safeDelay = Math.max(1000, Number(delayMs) || config.fundingMonitor.scanIntervalMs);
  fundingMonitorState.nextRunAt = new Date(Date.now() + safeDelay).toISOString();
  scanTimer = setTimeout(async () => {
    try {
      await runFundingIntervalCheck();
    } catch (error) {
      console.error("funding interval monitor failed", error);
    } finally {
      scheduleNextScan(config.fundingMonitor.scanIntervalMs);
    }
  }, safeDelay);
  scanTimer.unref?.();
}

function scheduleNextAlert(delayMs) {
  if (!config.fundingMonitor.enabled) {
    fundingMonitorState.nextAlertRunAt = null;
    return;
  }
  if (alertTimer) clearTimeout(alertTimer);
  const safeDelay = Math.max(1000, Number(delayMs) || config.fundingMonitor.alertPollMs);
  fundingMonitorState.nextAlertRunAt = new Date(Date.now() + safeDelay).toISOString();
  alertTimer = setTimeout(async () => {
    try {
      await runFundingPendingAlertCheck();
    } catch (error) {
      console.error("funding interval pending alert check failed", error);
    } finally {
      scheduleNextAlert(config.fundingMonitor.alertPollMs);
    }
  }, safeDelay);
  alertTimer.unref?.();
}

function settledValue(result, fallback) {
  return result.status === "fulfilled" ? result.value : fallback;
}

function settledErrorMessage(result) {
  if (result.status === "fulfilled") return null;
  return result.reason instanceof Error ? result.reason.message : String(result.reason);
}

export function getFundingIntervalMonitorState() {
  return {
    enabled: config.fundingMonitor.enabled,
    scanIntervalMs: config.fundingMonitor.scanIntervalMs,
    alertPollMs: config.fundingMonitor.alertPollMs,
    targetIntervalHours: config.fundingMonitor.targetIntervalHours,
    defaultIntervalHours: config.fundingMonitor.defaultIntervalHours,
    ...fundingMonitorState
  };
}

export function startFundingIntervalMonitor() {
  if (!config.fundingMonitor.enabled) return getFundingIntervalMonitorState();
  if (!scanTimer) scheduleNextScan(config.fundingMonitor.initialDelayMs);
  if (!alertTimer) scheduleNextAlert(config.fundingMonitor.initialDelayMs);
  return getFundingIntervalMonitorState();
}

async function sendPendingFundingIntervalAlerts({ recordState = true } = {}) {
  if (fundingMonitorState.alertRunning) {
    return {
      skipped: true,
      reason: "Funding interval pending alert check already running",
      pendingCount: fundingMonitorState.lastPendingCount,
      sentSymbols: [],
      skippedAlerts: []
    };
  }

  fundingMonitorState.alertRunning = true;
  fundingMonitorState.lastAlertStartedAt = isoNow();
  fundingMonitorState.lastAlertError = null;

  try {
    const pendingAlerts = await listPendingFundingIntervalAlerts(config.fundingMonitor.targetIntervalHours);
    const sentSymbols = [];
    const skippedAlerts = [];

    for (const alert of pendingAlerts) {
      try {
        const context = await getSignalCorrelationContext(alert.symbol);
        const result = await sendFundingIntervalTelegram(alert, context);
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

    fundingMonitorState.lastAlertSuccessAt = isoNow();
    fundingMonitorState.lastPendingCount = pendingAlerts.length;
    fundingMonitorState.lastAlertedSymbols = sentSymbols;
    fundingMonitorState.lastSkippedAlerts = skippedAlerts.slice(0, 20);

    const result = {
      ok: true,
      pendingCount: pendingAlerts.length,
      sentSymbols,
      skippedAlerts: fundingMonitorState.lastSkippedAlerts
    };
    if (recordState) await markMaintenanceState(ALERT_TASK, JSON.stringify(result));
    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    fundingMonitorState.lastAlertError = message;
    if (recordState) await markMaintenanceState(ALERT_TASK, `failed: ${message}`).catch(() => {});
    throw error;
  } finally {
    fundingMonitorState.alertRunning = false;
  }
}

export async function runFundingPendingAlertCheck({ force = false } = {}) {
  if (!config.fundingMonitor.enabled && !force) {
    return { skipped: true, reason: "Funding interval monitor disabled" };
  }
  return sendPendingFundingIntervalAlerts();
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
    const [fundingInfoResult, currentRatesResult] = await Promise.allSettled([
      fetchFundingInfo(),
      fetchCurrentFundingRates()
    ]);
    const fundingInfo = settledValue(fundingInfoResult, []);
    const currentRates = settledValue(currentRatesResult, []);
    const fundingInfoError = settledErrorMessage(fundingInfoResult);
    const currentRatesError = settledErrorMessage(currentRatesResult);

    if (fundingInfoError) {
      const result = {
        ok: false,
        skipped: true,
        reason: `Binance funding info unavailable: ${fundingInfoError}`,
        baselineOnly,
        seenCount: 0,
        missingCount: 0,
        pendingCount: 0,
        sentSymbols: [],
        skippedAlerts: [fundingInfoError]
      };
      fundingMonitorState.lastSeenCount = 0;
      fundingMonitorState.lastMissingCount = 0;
      fundingMonitorState.lastPendingCount = 0;
      fundingMonitorState.lastAlertedSymbols = [];
      fundingMonitorState.lastSkippedAlerts = result.skippedAlerts;
      await markMaintenanceState(CHECK_TASK, JSON.stringify(result));
      return result;
    }

    if (!hasReliableFundingIntervalSnapshot(fundingInfo, currentRates)) {
      const result = {
        ok: false,
        skipped: true,
        reason: currentRatesError
          ? `Empty Binance funding snapshot; premium index unavailable: ${currentRatesError}`
          : "Empty Binance funding snapshot",
        baselineOnly,
        seenCount: 0,
        missingCount: 0,
        pendingCount: 0,
        sentSymbols: [],
        skippedAlerts: []
      };
      fundingMonitorState.lastSeenCount = 0;
      fundingMonitorState.lastMissingCount = 0;
      fundingMonitorState.lastPendingCount = 0;
      fundingMonitorState.lastAlertedSymbols = [];
      fundingMonitorState.lastSkippedAlerts = [result.reason];
      await markMaintenanceState(CHECK_TASK, JSON.stringify(result));
      return result;
    }
    const currentRateBySymbol = new Map(currentRates.map((item) => [item.symbol, item]));
    const items = fundingInfo.map((item) => ({
      ...item,
      ...currentRateBySymbol.get(item.symbol)
    }));
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
      await markFundingIntervalAlertConfirmed(baselineTargetSymbols);
      await markMaintenanceState(
        BASELINE_TASK,
        `baseline seen=${snapshot.seenCount}, suppressedTarget=${baselineTargetSymbols.length}`
      );
    }

    const alertResult = baselineOnly
      ? { pendingCount: 0, sentSymbols: [], skippedAlerts: [] }
      : await sendPendingFundingIntervalAlerts({ recordState: false });

    fundingMonitorState.lastSuccessAt = isoNow();
    fundingMonitorState.lastSeenCount = snapshot.seenCount;
    fundingMonitorState.lastMissingCount = missingCount;
    fundingMonitorState.lastPendingCount = alertResult.pendingCount ?? 0;
    fundingMonitorState.lastAlertedSymbols = alertResult.sentSymbols ?? [];
    fundingMonitorState.lastSkippedAlerts = [
      ...(alertResult.skippedAlerts ?? []),
      ...(currentRatesError ? [`premiumIndex: ${currentRatesError}`] : [])
    ].slice(0, 20);

    const result = {
      ok: true,
      baselineOnly,
      seenCount: snapshot.seenCount,
      missingCount,
      pendingCount: alertResult.pendingCount ?? 0,
      sentSymbols: alertResult.sentSymbols ?? [],
      skippedAlerts: fundingMonitorState.lastSkippedAlerts
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
