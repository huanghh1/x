import { fetchMarkPrices, fetchOpenInterest, fetchOpenInterestHistory } from "./binance.js";
import { config } from "./config.js";
import {
  getOpenInterestSampleBaselines,
  getOpenInterestMonitorItem,
  getSignalCorrelationContext,
  listOpenInterestScanTokens,
  markOpenInterestSpikeAlertSent,
  recordTriggerHistory,
  upsertOpenInterestSamples,
  upsertOpenInterestSnapshot
} from "./db.js";
import { evaluateOpenInterestSpike } from "./openInterestSpike.js";
import { enqueueOpenInterestSpikeTelegramAlert } from "./telegramAlertQueue.js";

const WINDOW_MS = {
  "5m": 5 * 60 * 1000,
  "15m": 15 * 60 * 1000,
  "1h": 60 * 60 * 1000,
  "4h": 4 * 60 * 60 * 1000,
  "1d": 24 * 60 * 60 * 1000
};
const HISTORY_PERIOD_MS = 5 * 60 * 1000;
const REQUEST_WINDOW_MS = 5 * 60 * 1000;
const OI_WINDOW_ORDER = ["5m", "1h", "4h", "1d"];

let timer = null;
const retryQueue = new Set();
const historyBootstrapAttempted = new Set();

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
  unavailableSymbols: [],
  unavailableCount: 0,
  retryPendingCount: 0,
  lastRetryMode: false,
  requestLimitPerRun: 0,
  historyBootstrapLimit: 0,
  historyBootstrapUsedCount: 0,
  historyBootstrapCount: 0,
  historyBootstrapFailedCount: 0,
  historyBootstrapDeferredCount: 0
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

function sortedSignalIntervals(intervals) {
  const order = new Map(["15m", "1h", "4h", "1d"].map((interval, index) => [interval, index]));
  return [...new Set((Array.isArray(intervals) ? intervals : []).map((item) => String(item)).filter(Boolean))]
    .sort((a, b) => (order.get(a) ?? order.size) - (order.get(b) ?? order.size));
}

export function buildOpenInterestAlertState(spike = {}, context = {}) {
  const windows = [
    spike.hit5m ? "5m" : null,
    spike.hit1h ? "1h" : null,
    spike.hit4h ? "4h" : null,
    spike.hit1d ? "1d" : null
  ].filter(Boolean).sort((a, b) => OI_WINDOW_ORDER.indexOf(a) - OI_WINDOW_ORDER.indexOf(b));
  const intervals = sortedSignalIntervals(context.intervals);
  const signature = [
    `windows=${windows.join(",") || "none"}`,
    `level=${context.alertLevel ?? "none"}`,
    `intervals=${intervals.join(",") || "none"}`,
    `multi=${Number(context.multiCycleCount ?? intervals.length ?? 0)}`,
    `funding=${context.fundingOneHour ? 1 : 0}`,
    `hot=${context.hotRank ? 1 : 0}`
  ].join(";");

  return {
    windows,
    signature
  };
}

export function shouldSendOpenInterestSpikeAlert({ previous, previousSpike, spike, alertState }) {
  if (!spike?.hit) return false;
  if (!previous?.lastSpikeAlertAt) return true;
  if (!previousSpike?.hit) return true;
  if (!previous.lastSpikeAlertSignature) return false;
  return String(previous.lastSpikeAlertSignature) !== String(alertState?.signature ?? "");
}

export function shouldBackfillOpenInterestSpikeAlertState({ previous, previousSpike }) {
  return Boolean(previous?.lastSpikeAlertAt && previousSpike?.hit && !previous.lastSpikeAlertSignature);
}

export function effectiveOpenInterestScanLimit({
  tokenCount = Infinity,
  scanIntervalMs = config.openInterestMonitor.scanIntervalMs,
  requestLimitPerWindow = config.openInterestMonitor.requestLimitPerWindow,
  useHistoryBudget = false
} = {}) {
  const safeTokenCount = Number.isFinite(Number(tokenCount)) ? Math.max(0, Math.floor(Number(tokenCount))) : Infinity;
  if (!useHistoryBudget) return safeTokenCount;
  const configuredWindowLimit = Math.max(1, Math.floor(Number(requestLimitPerWindow) || 1));
  const intervalMs = Math.max(1000, Math.floor(Number(scanIntervalMs) || REQUEST_WINDOW_MS));
  const runsPerWindow = Math.max(1, Math.ceil(REQUEST_WINDOW_MS / intervalMs));
  const perRunLimit = Math.max(1, Math.floor(configuredWindowLimit / runsPerWindow));
  return Math.max(0, Math.min(safeTokenCount, perRunLimit));
}

export function isOpenInterestHistoryUnavailable(error) {
  const message = error instanceof Error ? error.message : String(error);
  return /\bopen interest history HTTP 403\b/i.test(message);
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

function baselineFreshEnough(latestObservedAt, duration, baseline, maxLagMs = HISTORY_PERIOD_MS) {
  if (!baseline?.observedAt) return false;
  const latestMs = latestObservedAt instanceof Date ? latestObservedAt.getTime() : Number(latestObservedAt);
  const baselineMs = baseline.observedAt instanceof Date
    ? baseline.observedAt.getTime()
    : new Date(baseline.observedAt).getTime();
  if (!Number.isFinite(latestMs) || !Number.isFinite(baselineMs)) return false;
  const targetTime = latestMs - duration;
  return targetTime - baselineMs >= 0 && targetTime - baselineMs < maxLagMs;
}

export function buildOpenInterestSnapshotFromSample(sample, baselines = {}) {
  const observedAt = sample?.observedAt instanceof Date
    ? sample.observedAt.getTime()
    : Number(sample?.observedAt);
  const currentOpenInterest = Number(sample?.openInterest);
  if (!sample?.symbol || !Number.isFinite(observedAt) || !Number.isFinite(currentOpenInterest)) return null;
  const changes = {};
  for (const [window, duration] of Object.entries(WINDOW_MS)) {
    const baseline = baselines[window];
    changes[window] = baselineFreshEnough(observedAt, duration, baseline)
      ? percentChange(currentOpenInterest, Number(baseline.openInterest))
      : null;
  }
  return {
    symbol: sample.symbol,
    currentOpenInterest,
    currentOpenInterestValue: sample.openInterestValue ?? null,
    change5mPct: changes["5m"],
    change15mPct: changes["15m"],
    change1hPct: changes["1h"],
    change4hPct: changes["4h"],
    change1dPct: changes["1d"],
    observedAt
  };
}

async function buildCachedOpenInterestSnapshot(sample) {
  const baselines = await getOpenInterestSampleBaselines(sample.symbol, sample.observedAt);
  return buildOpenInterestSnapshotFromSample(sample, baselines);
}

async function bootstrapOpenInterestHistorySamples(symbol) {
  if (historyBootstrapAttempted.has(symbol)) return { attempted: false, count: 0 };
  let rows;
  try {
    rows = await fetchOpenInterestHistory({
      symbol,
      period: "5m",
      limit: config.openInterestMonitor.historyLimit
    });
  } catch (error) {
    if (isOpenInterestHistoryUnavailable(error)) historyBootstrapAttempted.add(symbol);
    throw error;
  }
  const samples = rows.map((row) => ({
    symbol,
    openInterest: row.sumOpenInterest,
    openInterestValue: row.sumOpenInterestValue,
    observedAt: row.timestamp,
    source: "history"
  }));
  await upsertOpenInterestSamples(samples);
  historyBootstrapAttempted.add(symbol);
  return { attempted: true, count: samples.length };
}

function snapshotNeedsHistoryBootstrap(snapshot) {
  if (!snapshot) return true;
  return [snapshot.change5mPct, snapshot.change1hPct, snapshot.change4hPct, snapshot.change1dPct].some((value) => value === null);
}

async function scanToken(token, { markPrices = new Map(), claimHistoryBootstrap = () => true } = {}) {
  const current = await fetchOpenInterest({ symbol: token.symbol });
  const markPrice = markPrices.get(token.symbol);
  const sample = {
    symbol: token.symbol,
    openInterest: current.openInterest,
    openInterestValue: Number.isFinite(markPrice) ? current.openInterest * markPrice : null,
    observedAt: current.time,
    source: "current"
  };
  await upsertOpenInterestSamples([sample]);
  let snapshot = await buildCachedOpenInterestSnapshot(sample);
  let historyBootstrap = { attempted: false, count: 0 };
  let historyBootstrapError = null;
  let historyBootstrapDeferred = false;
  if (snapshotNeedsHistoryBootstrap(snapshot) && !historyBootstrapAttempted.has(token.symbol)) {
    if (!claimHistoryBootstrap()) {
      historyBootstrapDeferred = true;
    } else {
      try {
        historyBootstrap = await bootstrapOpenInterestHistorySamples(token.symbol);
        if (historyBootstrap.count > 0) {
          snapshot = await buildCachedOpenInterestSnapshot(sample);
        }
      } catch (error) {
        historyBootstrapError = error instanceof Error ? error.message : String(error);
      }
    }
  }
  if (!snapshot) {
    return {
      updated: false,
      spike: false,
      alerted: false,
      historyBootstrap,
      historyBootstrapError,
      historyBootstrapDeferred
    };
  }

  const previous = await getOpenInterestMonitorItem(token.symbol);
  await upsertOpenInterestSnapshot(snapshot);
  const spike = evaluateOpenInterestSpike(snapshot, config.openInterestMonitor);
  if (!spike.hit) {
    return {
      updated: true,
      spike: false,
      alerted: false,
      historyBootstrap,
      historyBootstrapError,
      historyBootstrapDeferred
    };
  }
  const previousSpike = evaluateOpenInterestSpike(previous ?? {}, config.openInterestMonitor);

  const context = await getSignalCorrelationContext(token.symbol);
  const alertState = buildOpenInterestAlertState(spike, context);
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

  if (!shouldSendOpenInterestSpikeAlert({ previous, previousSpike, spike, alertState })) {
    if (shouldBackfillOpenInterestSpikeAlertState({ previous, previousSpike })) {
      await markOpenInterestSpikeAlertSent(snapshot.symbol, { ...alertState, preserveAlertAt: true });
    }
    return {
      updated: true,
      spike: true,
      alerted: false,
      historyBootstrap,
      historyBootstrapError,
      historyBootstrapDeferred
    };
  }
  const result = await enqueueOpenInterestSpikeTelegramAlert(snapshot, context, alertState);
  return {
    updated: true,
    spike: true,
    alerted: !result.skipped,
    alertQueued: !result.skipped,
    historyBootstrap,
    historyBootstrapError,
    historyBootstrapDeferred,
    alertSkippedReason: result.skipped ? result.reason : null
  };
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
    sampleRetentionDays: config.openInterestMonitor.sampleRetentionDays,
    standaloneAlertEnabled: config.openInterestMonitor.standaloneAlertEnabled,
    ...monitorState
  };
}

export function startOpenInterestMonitor() {
  if (!config.openInterestMonitor.enabled || timer) return getOpenInterestMonitorState();
  scheduleNext(config.openInterestMonitor.initialDelayMs);
  return getOpenInterestMonitorState();
}

export function selectScanBatch(tokens) {
  if (!tokens.length) {
    monitorState.scanCursor = 0;
    monitorState.requestLimitPerRun = 0;
    return { batch: [], startOffset: 0, deferredCount: 0, requestLimitPerRun: 0 };
  }
  const initialRetryMode = retryQueue.size > 0;
  const limit = effectiveOpenInterestScanLimit({
    tokenCount: tokens.length,
    scanIntervalMs: initialRetryMode
      ? Math.min(config.openInterestMonitor.scanIntervalMs, config.openInterestMonitor.retryDelayMs)
      : config.openInterestMonitor.scanIntervalMs
  });
  monitorState.requestLimitPerRun = limit;
  const tokenBySymbol = new Map(tokens.map((token) => [token.symbol, token]));
  const retryLimit = Math.max(1, Math.min(limit, Math.ceil(limit / 2)));
  const retryBatch = [];
  for (const symbol of retryQueue) {
    const token = tokenBySymbol.get(symbol);
    if (!token) {
      retryQueue.delete(symbol);
      continue;
    }
    retryBatch.push(token);
    retryQueue.delete(symbol);
    if (retryBatch.length >= retryLimit) break;
  }
  if (retryBatch.length >= limit) {
    return {
      batch: retryBatch,
      startOffset: 0,
      deferredCount: tokens.length - retryBatch.length,
      retryMode: true,
      requestLimitPerRun: limit
    };
  }
  const retrySymbols = new Set(retryBatch.map((token) => token.symbol));
  if (tokens.length <= limit) {
    monitorState.scanCursor = 0;
    const batch = [...retryBatch, ...tokens.filter((token) => !retrySymbols.has(token.symbol))].slice(0, limit);
    return {
      batch,
      startOffset: 0,
      deferredCount: Math.max(0, tokens.length - batch.length),
      retryMode: retryBatch.length > 0,
      requestLimitPerRun: limit
    };
  }
  const normalLimit = limit - retryBatch.length;
  const normalBatch = [];
  const startOffset = Math.max(0, Math.min(tokens.length - 1, monitorState.scanCursor % tokens.length));
  for (let offset = 0; offset < tokens.length && normalBatch.length < normalLimit; offset += 1) {
    const token = tokens[(startOffset + offset) % tokens.length];
    if (!retrySymbols.has(token.symbol)) normalBatch.push(token);
  }
  const batch = [...retryBatch, ...normalBatch];
  monitorState.scanCursor = (startOffset + Math.max(1, normalLimit)) % tokens.length;
  return {
    batch,
    startOffset,
    deferredCount: tokens.length - batch.length,
    retryMode: retryBatch.length > 0,
    requestLimitPerRun: limit
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
  monitorState.unavailableSymbols = [];
  monitorState.unavailableCount = 0;
  monitorState.retryPendingCount = retryQueue.size;
  monitorState.lastRetryMode = false;
  monitorState.historyBootstrapLimit = 0;
  monitorState.historyBootstrapUsedCount = 0;
  monitorState.historyBootstrapCount = 0;
  monitorState.historyBootstrapFailedCount = 0;
  monitorState.historyBootstrapDeferredCount = 0;

  try {
    const tokens = await listOpenInterestScanTokens();
    const { batch: scanTokens, startOffset, deferredCount, retryMode, requestLimitPerRun } = selectScanBatch(tokens);
    const historyBootstrapLimit = effectiveOpenInterestScanLimit({
      tokenCount: scanTokens.length,
      scanIntervalMs: retryMode
        ? Math.min(config.openInterestMonitor.scanIntervalMs, config.openInterestMonitor.retryDelayMs)
        : config.openInterestMonitor.scanIntervalMs,
      requestLimitPerWindow: config.openInterestMonitor.requestLimitPerWindow,
      useHistoryBudget: true
    });
    let historyBootstrapUsedCount = 0;
    const claimHistoryBootstrap = () => {
      if (historyBootstrapUsedCount >= historyBootstrapLimit) return false;
      historyBootstrapUsedCount += 1;
      return true;
    };
    const errors = [];
    let markPrices = new Map();
    try {
      markPrices = new Map((await fetchMarkPrices()).map((item) => [item.symbol, item.markPrice]));
    } catch (error) {
      errors.push(`mark prices: ${error instanceof Error ? error.message : String(error)}`);
    }
    let cursor = 0;
    let updatedCount = 0;
    let spikeCount = 0;
    let historyBootstrapCount = 0;
    let historyBootstrapFailedCount = 0;
    let historyBootstrapDeferredCount = 0;
    const alertedSymbols = [];
    const failedSymbols = [];
    const unavailableSymbols = [];

    const worker = async () => {
      while (cursor < scanTokens.length) {
        const index = cursor;
        cursor += 1;
        const token = scanTokens[index];
        try {
          const result = await scanToken(token, { markPrices, claimHistoryBootstrap });
          if (result.updated) updatedCount += 1;
          if (result.spike) spikeCount += 1;
          if (result.alerted) alertedSymbols.push(token.symbol);
          if (result.historyBootstrap?.count > 0) historyBootstrapCount += 1;
          if (result.historyBootstrapDeferred) historyBootstrapDeferredCount += 1;
          if (result.historyBootstrapError) {
            historyBootstrapFailedCount += 1;
            errors.push(`${token.symbol}: OI history bootstrap failed: ${result.historyBootstrapError}`);
          }
        } catch (error) {
          if (isOpenInterestHistoryUnavailable(error)) {
            unavailableSymbols.push(token.symbol);
            continue;
          }
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
    const allHistoryUnavailable = scanTokens.length > 0 && updatedCount === 0 && unavailableSymbols.length === scanTokens.length;
    if (allHistoryUnavailable) {
      errors.unshift(
        `Open interest history unavailable for all ${scanTokens.length} scanned symbols; check Binance 403/rate-limit/network access`
      );
    }

    monitorState.lastSuccessAt = new Date().toISOString();
    monitorState.totalTokenCount = tokens.length;
    monitorState.deferredCount = deferredCount;
    monitorState.requestLimitPerWindow = config.openInterestMonitor.requestLimitPerWindow;
    monitorState.requestLimitPerRun = requestLimitPerRun;
    monitorState.scannedCount = scanTokens.length;
    monitorState.updatedCount = updatedCount;
    monitorState.spikeCount = spikeCount;
    monitorState.alertedSymbols = alertedSymbols;
    monitorState.errors = errors.slice(0, 30);
    monitorState.lastError = allHistoryUnavailable ? monitorState.errors[0] : monitorState.lastError;
    monitorState.failedSymbols = failedSymbols.slice(0, 100);
    monitorState.unavailableSymbols = unavailableSymbols.slice(0, 100);
    monitorState.unavailableCount = unavailableSymbols.length;
    monitorState.retryPendingCount = retryQueue.size;
    monitorState.lastRetryMode = Boolean(retryMode);
    monitorState.historyBootstrapLimit = historyBootstrapLimit;
    monitorState.historyBootstrapUsedCount = historyBootstrapUsedCount;
    monitorState.historyBootstrapCount = historyBootstrapCount;
    monitorState.historyBootstrapFailedCount = historyBootstrapFailedCount;
    monitorState.historyBootstrapDeferredCount = historyBootstrapDeferredCount;
    return {
      ok: true,
      totalTokenCount: tokens.length,
      scannedCount: scanTokens.length,
      deferredCount,
      scanStartOffset: startOffset,
      requestLimitPerWindow: config.openInterestMonitor.requestLimitPerWindow,
      requestLimitPerRun: monitorState.requestLimitPerRun,
      retryMode: Boolean(retryMode),
      updatedCount,
      spikeCount,
      alertedSymbols,
      failedSymbols: monitorState.failedSymbols,
      unavailableSymbols: monitorState.unavailableSymbols,
      unavailableCount: monitorState.unavailableCount,
      retryPendingCount: retryQueue.size,
      historyBootstrapLimit,
      historyBootstrapUsedCount,
      historyBootstrapCount,
      historyBootstrapFailedCount,
      historyBootstrapDeferredCount,
      errors: monitorState.errors
    };
  } catch (error) {
    monitorState.lastError = error instanceof Error ? error.message : String(error);
    throw error;
  } finally {
    monitorState.running = false;
  }
}
