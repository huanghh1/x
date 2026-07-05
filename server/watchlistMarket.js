import { fetchKlinesPaged } from "./binance.js";
import { mapLimit } from "./concurrency.js";
import { config } from "./config.js";
import {
  klineStats,
  listKlineGaps,
  listWatchlistTokens,
  refreshTokenFetchState,
  selectClosePrices,
  upsertKlinePage,
  upsertSignal
} from "./db.js";
import { calculateSignal, INTERVALS } from "./ma.js";

let refreshing = false;
let lastSkippedRealtimeAt = 0;
let lastFullRefreshAt = 0;
let lastFullRefreshError = null;

function intervalMs(intervalCode) {
  return {
    "15m": 15 * 60 * 1000,
    "1h": 60 * 60 * 1000,
    "4h": 4 * 60 * 60 * 1000,
    "1d": 24 * 60 * 60 * 1000
  }[intervalCode];
}

function targetStart(intervalCode) {
  const targetCount = Math.max(200, Number(config.crawler.retentionLimits[intervalCode]) || 200);
  return latestClosedKlineOpenTime(intervalCode) - Math.max(1, targetCount - 1) * intervalMs(intervalCode);
}

function latestClosedKlineOpenTime(intervalCode) {
  const ms = intervalMs(intervalCode);
  return Math.floor(Date.now() / ms) * ms - ms;
}

async function fetchRange(token, intervalCode, startTime, endTime) {
  if (endTime < startTime) return 0;
  let fetchedRows = 0;
  await fetchKlinesPaged({
    symbol: token.symbol,
    intervalCode,
    startTime,
    endTime,
    onPage: async (page) => {
      fetchedRows += page.length;
      await upsertKlinePage(token, intervalCode, page);
    },
    shouldContinue: () => true
  });
  return fetchedRows;
}

async function repairGaps(token, intervalCode) {
  const ms = intervalMs(intervalCode);
  const startTime = targetStart(intervalCode);
  const endTime = latestClosedKlineOpenTime(intervalCode);
  const stats = await klineStats(token.symbol, intervalCode);
  let fetchedRows = 0;
  if (stats.minOpenTime === null || stats.minOpenTime > startTime) {
    fetchedRows += await fetchRange(
      token,
      intervalCode,
      startTime,
      stats.minOpenTime === null ? endTime : Math.min(endTime, stats.minOpenTime - ms)
    );
  }
  const gaps = await listKlineGaps(token.symbol, intervalCode, ms, startTime, endTime, 25);
  for (const gap of gaps) {
    const fetched = await fetchRange(token, intervalCode, gap.startTime, gap.endTime);
    if (!fetched) continue;
    fetchedRows += fetched;
  }
  return fetchedRows;
}

async function refreshWatchlistToken(token) {
  let refreshedRows = 0;
  for (const intervalCode of INTERVALS) {
    refreshedRows += await repairGaps(token, intervalCode);
    const closes = await selectClosePrices(token.symbol, intervalCode);
    await upsertSignal(token, calculateSignal({ intervalCode, closes }));
  }
  await refreshTokenFetchState(token.id);
  return refreshedRows;
}

export async function refreshWatchlistMarketData({ force = false, full = false } = {}) {
  if (refreshing) return { skipped: true, reason: "already running" };
  const now = Date.now();
  if (!full) {
    lastSkippedRealtimeAt = now;
    return {
      skipped: true,
      reason: "latest watchlist klines are handled by realtime service",
      realtimeManaged: true
    };
  }
  if (!force && now - lastFullRefreshAt < 60_000) return { skipped: true, reason: "fresh history repair" };
  refreshing = true;
  try {
    const tokens = await listWatchlistTokens();
    const results = await mapLimit(tokens, config.crawler.watchlistMarketConcurrency, refreshWatchlistToken);
    const errors = [];
    let refreshedRows = 0;
    let refreshedTokenCount = 0;
    for (const [index, result] of results.entries()) {
      const token = tokens[index];
      if (result.status === "fulfilled") {
        refreshedTokenCount += 1;
        refreshedRows += Number(result.value) || 0;
        continue;
      }
      const message = result.reason instanceof Error ? result.reason.message : String(result.reason);
      errors.push(`${token?.symbol ?? "UNKNOWN"}: ${message}`);
    }
    if (errors.length && refreshedTokenCount === 0) {
      throw new Error(`watchlist market refresh failed for all tokens: ${errors[0]}`);
    }
    lastFullRefreshAt = Date.now();
    lastFullRefreshError = errors.at(-1) ?? null;
    return {
      ok: true,
      partial: errors.length > 0,
      tokenCount: tokens.length,
      refreshedTokenCount,
      refreshedRows,
      errorCount: errors.length,
      errors: errors.slice(0, 20),
      intervals: INTERVALS,
      realtimeManaged: true,
      concurrency: config.crawler.watchlistMarketConcurrency
    };
  } catch (error) {
    lastFullRefreshError = error instanceof Error ? error.message : String(error);
    throw error;
  } finally {
    refreshing = false;
  }
}

export function getWatchlistMarketState() {
  return {
    refreshing,
    lastSkippedRealtimeAt: lastSkippedRealtimeAt ? new Date(lastSkippedRealtimeAt).toISOString() : null,
    lastFullRefreshAt: lastFullRefreshAt ? new Date(lastFullRefreshAt).toISOString() : null,
    lastFullRefreshError,
    concurrency: config.crawler.watchlistMarketConcurrency
  };
}
