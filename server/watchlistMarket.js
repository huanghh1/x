import { fetchKlinesPaged, fetchRecentKlines } from "./binance.js";
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
let lastFastRefreshAt = 0;
let lastFullRefreshAt = 0;

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

function closedKlinesOnly(klines, intervalCode) {
  const latestClosedOpenTime = latestClosedKlineOpenTime(intervalCode);
  return klines.filter((kline) => Number(kline?.[0]) <= latestClosedOpenTime);
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
  if (stats.minOpenTime === null || stats.minOpenTime > startTime) {
    await fetchRange(
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
  }
}

export async function refreshWatchlistMarketData({ force = false, full = false } = {}) {
  if (refreshing) return { skipped: true, reason: "already running" };
  const now = Date.now();
  if (!force && now - lastFastRefreshAt < 15_000) return { skipped: true, reason: "fresh cache" };
  refreshing = true;
  try {
    const tokens = await listWatchlistTokens();
    const fullRefresh = full || now - lastFullRefreshAt >= 60_000;
    const intervals = fullRefresh ? INTERVALS : ["15m"];
    for (const token of tokens) {
      for (const intervalCode of intervals) {
        const klines = closedKlinesOnly(
          await fetchRecentKlines({ symbol: token.symbol, intervalCode, limit: 2 }),
          intervalCode
        );
        if (klines.length) await upsertKlinePage(token, intervalCode, klines);
        if (fullRefresh) await repairGaps(token, intervalCode);
        const closes = await selectClosePrices(token.symbol, intervalCode);
        await upsertSignal(token, calculateSignal({ intervalCode, closes }));
      }
      await refreshTokenFetchState(token.id);
    }
    lastFastRefreshAt = Date.now();
    if (fullRefresh) lastFullRefreshAt = lastFastRefreshAt;
    return { ok: true, tokenCount: tokens.length, intervals };
  } finally {
    refreshing = false;
  }
}

export function getWatchlistMarketState() {
  return {
    refreshing,
    lastFastRefreshAt: lastFastRefreshAt ? new Date(lastFastRefreshAt).toISOString() : null,
    lastFullRefreshAt: lastFullRefreshAt ? new Date(lastFullRefreshAt).toISOString() : null
  };
}
