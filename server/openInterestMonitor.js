import { fetchOpenInterestHistory } from "./binance.js";
import { config } from "./config.js";
import {
  getOpenInterestMonitorItem,
  getSignalCorrelationContext,
  listActiveTokenSymbols,
  markOpenInterestSpikeAlertSent,
  recordTriggerHistory,
  upsertOpenInterestSnapshot
} from "./db.js";
import { sendOpenInterestSpikeTelegram, sendStandaloneOpenInterestSpikeTelegram } from "./telegram.js";
import { evaluateOpenInterestSpike } from "./openInterestSpike.js";

const WINDOW_MS = {
  "5m": 5 * 60 * 1000,
  "15m": 15 * 60 * 1000,
  "1h": 60 * 60 * 1000,
  "4h": 4 * 60 * 60 * 1000,
  "1d": 24 * 60 * 60 * 1000
};
const HISTORY_PERIOD_MS = 5 * 60 * 1000;

let timer = null;
const retryQueue = new Set();

const monitorState = {
  running: false,
  lastStartedAt: null,
  lastSuccessAt: null,
  lastError: null,
  nextRunAt: null,
  scanCursor: 0,
  totalTokenCount: 0,
  deferredCount: 0,
  requestLimitPerWindow: config.openInterestMonitor.requestLimitPerWindow,
  scannedCount: 0,
  updatedCount: 0,
  spikeCount: 0,
  alertedSymbols: [],
  errors: [],
  failedSymbols: [],
  retryPendingCount: 0,
  lastRetryMode: false
};

function percentChange(current, previous) {
  if (!Number.isFinite(current) || !Number.isFinite(previous) || previous <= 0) return null;
  return Number((((current - previous) / previous) * 100).toFixed(8));
}

function baselineAt(rows, targetTime, maxLagMs = HISTORY_PERIOD_MS) {
  let match = null;
  for (const row of rows) {
    if (row.timestamp > targetTime) break;
    match = row;
  }
  if (!match) return null;
  if (targetTime - match.timestamp >= maxLagMs) return null;
  return match;
}

export function buildOpenInterestSnapshot(symbol, rows) {
  const latest = rows.at(-1);
  if (!latest) return null;
  const changes = {};
  for (const [window, duration] of Object.entries(WINDOW_MS)) {
    const baseline = baselineAt(rows, latest.timestamp - duration);
    changes[window] = baseline ? percentChange(latest.sumOpenInterest, baseline.sumOpenInterest) : null;
  }
  return {
    symbol,
    currentOpenInterest: latest.sumOpenInterest,
    currentOpenInterestValue: latest.sumOpenInterestValue,
    change5mPct: changes["5m"],
    change15mPct: changes["15m"],
    change1hPct: changes["1h"],
    change4hPct: changes["4h"],
    change1dPct: changes["1d"],
    observedAt: latest.timestamp
  };
}

async function scanToken(token) {
  const rows = await fetchOpenInterestHistory({
    symbol: token.symbol,
    period: "5m",
    limit: config.openInterestMonitor.historyLimit
  });
  const snapshot = buildOpenInterestSnapshot(token.symbol, rows);
  if (
    !snapshot ||
    [snapshot.change5mPct, snapshot.change1hPct, snapshot.change4hPct, snapshot.change1dPct].every((value) => value === null)
  ) {
    return { updated: false, spike: false, alerted: false };
  }

  const previous = await getOpenInterestMonitorItem(token.symbol);
  await upsertOpenInterestSnapshot(snapshot);
  const spike = evaluateOpenInterestSpike(snapshot, config.openInterestMonitor);
  if (!spike.hit) return { updated: true, spike: false, alerted: false };

  const context = await getSignalCorrelationContext(token.symbol);
  await recordTriggerHistory({
    eventKey: `oi:${token.symbol}:${snapshot.observedAt}`,
    symbol: token.symbol,
    triggerType: "OI_SPIKE",
    intervals: context.intervals.join(","),
    signalLevel: context.multiCycleCount >= 3 ? "MULTI_CYCLE" : null,
    triggerTime: snapshot.observedAt,
    details: {
      ...snapshot,
      spike5mHit: spike.hit5m,
      spike1hHit: spike.hit1h,
      spike4hHit: spike.hit4h,
      spike1dHit: spike.hit1d,
      ...context,
      sources: [
        "OI_SPIKE",
        context.hotRank ? "HOT_RANK" : null,
        context.fundingOneHour ? "FUNDING_RATE" : null,
        context.multiCycleCount >= 3 ? "MULTI_CYCLE" : null
      ].filter(Boolean)
    }
  });

  const lastAlertAt = previous?.lastSpikeAlertAt ? new Date(previous.lastSpikeAlertAt).getTime() : 0;
  if (Date.now() - lastAlertAt < config.openInterestMonitor.alertCooldownMs) {
    return { updated: true, spike: true, alerted: false };
  }
  let result = await sendOpenInterestSpikeTelegram(snapshot, context);
  if (result.skipped) {
    result = await sendStandaloneOpenInterestSpikeTelegram(snapshot);
  }
  if (result.skipped) return { updated: true, spike: true, alerted: false };
  await markOpenInterestSpikeAlertSent(token.symbol);
  return { updated: true, spike: true, alerted: true };
}

function scheduleNext(delayMs) {
  if (!config.openInterestMonitor.enabled) {
    monitorState.nextRunAt = null;
    return;
  }
  if (timer) clearTimeout(timer);
  const safeDelay = Math.max(1000, Number(delayMs) || config.openInterestMonitor.scanIntervalMs);
  monitorState.nextRunAt = new Date(Date.now() + safeDelay).toISOString();
  timer = setTimeout(async () => {
    let nextDelayMs = config.openInterestMonitor.scanIntervalMs;
    try {
      const result = await runOpenInterestCheck();
      if (result?.retryPendingCount > 0) nextDelayMs = config.openInterestMonitor.retryDelayMs;
    } catch (error) {
      console.error("open interest monitor failed", error);
      nextDelayMs = config.openInterestMonitor.retryDelayMs;
    } finally {
      scheduleNext(nextDelayMs);
    }
  }, safeDelay);
  timer.unref?.();
}

export function getOpenInterestMonitorState() {
  return {
    enabled: config.openInterestMonitor.enabled,
    scanIntervalMs: config.openInterestMonitor.scanIntervalMs,
    spike5mPct: config.openInterestMonitor.spike5mPct,
    spike1hPct: config.openInterestMonitor.spike1hPct,
    spike4hPct: config.openInterestMonitor.spike4hPct,
    spike1dPct: config.openInterestMonitor.spike1dPct,
    retryDelayMs: config.openInterestMonitor.retryDelayMs,
    standaloneAlertEnabled: config.openInterestMonitor.standaloneAlertEnabled,
    ...monitorState
  };
}

export function startOpenInterestMonitor() {
  if (!config.openInterestMonitor.enabled || timer) return getOpenInterestMonitorState();
  scheduleNext(config.openInterestMonitor.initialDelayMs);
  return getOpenInterestMonitorState();
}

function selectScanBatch(tokens) {
  if (!tokens.length) {
    monitorState.scanCursor = 0;
    return { batch: [], startOffset: 0, deferredCount: 0 };
  }
  const limit = Math.min(tokens.length, config.openInterestMonitor.requestLimitPerWindow);
  const tokenBySymbol = new Map(tokens.map((token) => [token.symbol, token]));
  const retryBatch = [];
  for (const symbol of retryQueue) {
    const token = tokenBySymbol.get(symbol);
    if (!token) {
      retryQueue.delete(symbol);
      continue;
    }
    retryBatch.push(token);
    retryQueue.delete(symbol);
    if (retryBatch.length >= limit) break;
  }
  if (retryBatch.length) {
    return {
      batch: retryBatch,
      startOffset: 0,
      deferredCount: tokens.length - retryBatch.length,
      retryMode: true
    };
  }
  if (tokens.length <= limit) {
    monitorState.scanCursor = 0;
    return { batch: tokens, startOffset: 0, deferredCount: 0, retryMode: false };
  }
  const startOffset = monitorState.scanCursor % tokens.length;
  const batch = Array.from({ length: limit }, (_, index) => tokens[(startOffset + index) % tokens.length]);
  monitorState.scanCursor = (startOffset + limit) % tokens.length;
  return {
    batch,
    startOffset,
    deferredCount: tokens.length - batch.length,
    retryMode: false
  };
}

export async function runOpenInterestCheck({ force = false } = {}) {
  if (!config.openInterestMonitor.enabled && !force) {
    return { skipped: true, reason: "Open interest monitor disabled" };
  }
  if (monitorState.running) return { skipped: true, reason: "Open interest monitor already running" };

  monitorState.running = true;
  monitorState.lastStartedAt = new Date().toISOString();
  monitorState.lastError = null;
  monitorState.errors = [];
  monitorState.alertedSymbols = [];
  monitorState.failedSymbols = [];
  monitorState.retryPendingCount = retryQueue.size;
  monitorState.lastRetryMode = false;

  try {
    const tokens = await listActiveTokenSymbols();
    const { batch: scanTokens, startOffset, deferredCount, retryMode } = selectScanBatch(tokens);
    let cursor = 0;
    let updatedCount = 0;
    let spikeCount = 0;
    const alertedSymbols = [];
    const errors = [];
    const failedSymbols = [];

    const worker = async () => {
      while (cursor < scanTokens.length) {
        const index = cursor;
        cursor += 1;
        const token = scanTokens[index];
        try {
          const result = await scanToken(token);
          if (result.updated) updatedCount += 1;
          if (result.spike) spikeCount += 1;
          if (result.alerted) alertedSymbols.push(token.symbol);
        } catch (error) {
          failedSymbols.push(token.symbol);
          errors.push(`${token.symbol}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    };

    await Promise.all(
      Array.from(
        { length: Math.min(config.openInterestMonitor.concurrency, Math.max(1, scanTokens.length)) },
        () => worker()
      )
    );
    for (const symbol of failedSymbols) retryQueue.add(symbol);

    monitorState.lastSuccessAt = new Date().toISOString();
    monitorState.totalTokenCount = tokens.length;
    monitorState.deferredCount = deferredCount;
    monitorState.requestLimitPerWindow = config.openInterestMonitor.requestLimitPerWindow;
    monitorState.scannedCount = scanTokens.length;
    monitorState.updatedCount = updatedCount;
    monitorState.spikeCount = spikeCount;
    monitorState.alertedSymbols = alertedSymbols;
    monitorState.errors = errors.slice(0, 30);
    monitorState.failedSymbols = failedSymbols.slice(0, 100);
    monitorState.retryPendingCount = retryQueue.size;
    monitorState.lastRetryMode = Boolean(retryMode);
    return {
      ok: true,
      totalTokenCount: tokens.length,
      scannedCount: scanTokens.length,
      deferredCount,
      scanStartOffset: startOffset,
      requestLimitPerWindow: config.openInterestMonitor.requestLimitPerWindow,
      retryMode: Boolean(retryMode),
      updatedCount,
      spikeCount,
      alertedSymbols,
      failedSymbols: monitorState.failedSymbols,
      retryPendingCount: retryQueue.size,
      errors: monitorState.errors
    };
  } catch (error) {
    monitorState.lastError = error instanceof Error ? error.message : String(error);
    throw error;
  } finally {
    monitorState.running = false;
  }
}
