import crypto from "node:crypto";
import { config } from "./config.js";
import {
  claimTelegramAlerts,
  enqueueTelegramAlert,
  getTelegramAlertQueueStats,
  markOpenInterestSpikeAlertSent,
  markTelegramAlertFailed,
  markTelegramAlertSent
} from "./db.js";
import { sendOpenInterestSpikeTelegram, sendStandaloneOpenInterestSpikeTelegram } from "./telegram.js";

const ALERT_RETRY_MAX_DELAY_MS = 5 * 60 * 1000;

let timer = null;

const queueState = {
  running: false,
  lastStartedAt: null,
  lastSuccessAt: null,
  lastError: null,
  nextRunAt: null,
  claimedCount: 0,
  sentCount: 0,
  failedCount: 0,
  skippedCount: 0,
  stats: { pending: 0, sending: 0, sent: 0, failed: 0 }
};

function queueKeyForOpenInterest(symbol, alertState = {}) {
  const signature = String(alertState.signature ?? "none");
  const hash = crypto.createHash("sha1").update(signature).digest("hex");
  return `oi:${String(symbol ?? "").toUpperCase()}:${hash}`;
}

export async function enqueueOpenInterestSpikeTelegramAlert(snapshot, context = {}, alertState = {}) {
  if (!config.telegram.enabled) return { skipped: true, reason: "Telegram disabled" };
  if (!config.telegram.botToken || !config.telegram.chatId) {
    return { skipped: true, reason: "Telegram missing config" };
  }
  const queueKey = queueKeyForOpenInterest(snapshot?.symbol, alertState);
  const enqueued = await enqueueTelegramAlert({
    queueKey,
    alertType: "OI_SPIKE",
    symbol: snapshot?.symbol,
    payload: { snapshot, context, alertState }
  });
  return { skipped: false, enqueued, queueKey };
}

function retryDelayMs(attemptCount) {
  return Math.min(
    ALERT_RETRY_MAX_DELAY_MS,
    Math.max(config.telegram.retryDelayMs, config.telegram.retryDelayMs * 2 ** Math.max(0, Number(attemptCount ?? 1) - 1))
  );
}

async function processOpenInterestAlert(alert) {
  const snapshot = alert.payload?.snapshot;
  const context = alert.payload?.context ?? {};
  const alertState = alert.payload?.alertState ?? {};
  if (!snapshot?.symbol) throw new Error("OI alert payload missing symbol");

  let result = await sendOpenInterestSpikeTelegram(snapshot, context);
  if (result.skipped) {
    result = await sendStandaloneOpenInterestSpikeTelegram(snapshot);
  }
  if (result.skipped) {
    throw new Error(result.reason || "Telegram OI alert skipped");
  }

  await markOpenInterestSpikeAlertSent(snapshot.symbol, alertState);
}

async function processTelegramAlert(alert) {
  if (alert.alertType === "OI_SPIKE") {
    await processOpenInterestAlert(alert);
    return;
  }
  throw new Error(`Unsupported Telegram alert type: ${alert.alertType}`);
}

async function refreshStats() {
  try {
    queueState.stats = await getTelegramAlertQueueStats();
  } catch (error) {
    queueState.lastError = error instanceof Error ? error.message : String(error);
  }
}

function scheduleNext(delayMs = config.telegram.alertQueuePollMs) {
  if (!config.telegram.enabled) {
    queueState.nextRunAt = null;
    return;
  }
  if (timer) clearTimeout(timer);
  const safeDelay = Math.max(1000, Number(delayMs) || config.telegram.alertQueuePollMs);
  queueState.nextRunAt = new Date(Date.now() + safeDelay).toISOString();
  timer = setTimeout(async () => {
    try {
      await runTelegramAlertQueueOnce();
    } catch (error) {
      console.error("telegram alert queue failed", error);
    } finally {
      scheduleNext(config.telegram.alertQueuePollMs);
    }
  }, safeDelay);
  timer.unref?.();
}

export function startTelegramAlertQueueWorker() {
  if (timer || !config.telegram.enabled) return getTelegramAlertQueueState();
  scheduleNext(1000);
  return getTelegramAlertQueueState();
}

export function getTelegramAlertQueueState() {
  return {
    enabled: config.telegram.enabled,
    pollMs: config.telegram.alertQueuePollMs,
    batchSize: config.telegram.alertQueueBatchSize,
    maxAttempts: config.telegram.alertQueueMaxAttempts,
    ...queueState
  };
}

export async function runTelegramAlertQueueOnce({ force = false } = {}) {
  if (!config.telegram.enabled && !force) {
    return { skipped: true, reason: "Telegram disabled" };
  }
  if (queueState.running) {
    return { skipped: true, reason: "Telegram alert queue already running" };
  }

  queueState.running = true;
  queueState.lastStartedAt = new Date().toISOString();
  queueState.lastError = null;
  queueState.claimedCount = 0;
  queueState.sentCount = 0;
  queueState.failedCount = 0;
  queueState.skippedCount = 0;

  try {
    const alerts = await claimTelegramAlerts(config.telegram.alertQueueBatchSize);
    queueState.claimedCount = alerts.length;
    for (const alert of alerts) {
      try {
        await processTelegramAlert(alert);
        await markTelegramAlertSent(alert.id);
        queueState.sentCount += 1;
      } catch (error) {
        const message = `${alert.symbol ?? alert.queueKey}: ${error instanceof Error ? error.message : String(error)}`;
        queueState.lastError = message;
        queueState.failedCount += 1;
        console.error("telegram alert delivery failed", message);
        await markTelegramAlertFailed(alert.id, error, {
          maxAttempts: config.telegram.alertQueueMaxAttempts,
          retryDelayMs: retryDelayMs(alert.attemptCount)
        });
      }
    }
    queueState.lastSuccessAt = new Date().toISOString();
    await refreshStats();
    return {
      ok: true,
      claimedCount: queueState.claimedCount,
      sentCount: queueState.sentCount,
      failedCount: queueState.failedCount,
      stats: queueState.stats
    };
  } finally {
    queueState.running = false;
  }
}
