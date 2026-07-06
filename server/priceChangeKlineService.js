import { fetchKlinesPaged } from "./binance.js";
import { mapLimit } from "./concurrency.js";
import { config } from "./config.js";
import {
  cleanupPriceChangeKlineRetention,
  listActivePriceChangeKlineTokens,
  listPriceChangeKlineGaps,
  priceChangeKlineStats,
  priceChangeKlineTarget,
  upsertPriceChangeKlinePage
} from "./db.js";
import { PRICE_CHANGE_1M_INTERVAL_MS } from "./db/priceChangeKlineRepository.js";

const priceChangeKlineState = {
  running: false,
  lastStartedAt: null,
  lastCompletedAt: null,
  nextRunAt: null,
  lastError: null,
  lastAction: "等待启动",
  tokenCount: 0,
  refreshedRows: 0,
  storedRows: 0,
  cleanupDeletedRows: 0,
  errorCount: 0,
  errors: []
};

let schedulerTimer = null;

function isoNow() {
  return new Date().toISOString();
}

function scheduleNextPriceChangeKlineRefresh(delayMs) {
  if (!config.priceChangeKline.enabled) {
    priceChangeKlineState.nextRunAt = null;
    return;
  }
  if (schedulerTimer) clearTimeout(schedulerTimer);
  const safeDelay = Math.max(1000, Number(delayMs) || config.priceChangeKline.refreshIntervalMs);
  priceChangeKlineState.nextRunAt = new Date(Date.now() + safeDelay).toISOString();
  schedulerTimer = setTimeout(async () => {
    try {
      await runPriceChangeKlineRefresh();
    } catch (error) {
      console.error("price change 1m kline refresh failed", error);
    } finally {
      scheduleNextPriceChangeKlineRefresh(config.priceChangeKline.refreshIntervalMs);
    }
  }, safeDelay);
  schedulerTimer.unref?.();
}

function requestLimitForRange(startTime, endTime) {
  const missingCount = Math.max(1, Math.round((Number(endTime) - Number(startTime)) / PRICE_CHANGE_1M_INTERVAL_MS) + 1);
  if (missingCount <= config.priceChangeKline.tailRequestLimit) return config.priceChangeKline.tailRequestLimit;
  return config.priceChangeKline.requestLimit;
}

async function fetchPriceChangeKlineRange({ token, startTime, endTime, shouldContinue = () => true }) {
  if (!shouldContinue() || endTime < startTime) return { fetchedRows: 0, storedRows: 0 };
  let fetchedRows = 0;
  let storedRows = 0;
  await fetchKlinesPaged({
    symbol: token.symbol,
    intervalCode: "1m",
    startTime,
    endTime,
    limit: requestLimitForRange(startTime, endTime),
    shouldContinue,
    onPage: async (page) => {
      const stored = await upsertPriceChangeKlinePage(token, page);
      fetchedRows += page.length;
      storedRows += stored;
    }
  });
  return { fetchedRows, storedRows };
}

async function refreshTokenPriceChangeKlines(token, target, { shouldContinue = () => true } = {}) {
  let fetchedRows = 0;
  let storedRows = 0;
  let coverageRows = 0;
  let gapRows = 0;
  let recentRows = 0;
  let repairedGapCount = 0;

  const addResult = (result, bucket) => {
    fetchedRows += result.fetchedRows;
    storedRows += result.storedRows;
    if (bucket === "coverage") coverageRows += result.fetchedRows;
    if (bucket === "gap") gapRows += result.fetchedRows;
    if (bucket === "recent") recentRows += result.fetchedRows;
  };

  const initialStats = await priceChangeKlineStats(token.symbol, {
    startTime: target.targetStartTime,
    endTime: target.targetEndTime
  });

  if (initialStats.minOpenTime === null) {
    addResult(
      await fetchPriceChangeKlineRange({
        token,
        startTime: target.targetStartTime,
        endTime: target.targetEndTime,
        shouldContinue
      }),
      "coverage"
    );
    if (coverageRows === 0) {
      return {
        symbol: token.symbol,
        fetchedRows,
        storedRows,
        coverageRows,
        gapRows,
        recentRows,
        repairedGapCount
      };
    }
  } else if (initialStats.minOpenTime > target.targetStartTime) {
    addResult(
      await fetchPriceChangeKlineRange({
        token,
        startTime: target.targetStartTime,
        endTime: Math.min(target.targetEndTime, initialStats.minOpenTime - PRICE_CHANGE_1M_INTERVAL_MS),
        shouldContinue
      }),
      "coverage"
    );
  }

  let latestStats = coverageRows > 0
    ? await priceChangeKlineStats(token.symbol, {
        startTime: target.targetStartTime,
        endTime: target.targetEndTime
      })
    : initialStats;
  const spanSlotCount =
    latestStats.minOpenTime !== null && latestStats.maxOpenTime !== null && latestStats.maxOpenTime >= latestStats.minOpenTime
      ? Math.floor((latestStats.maxOpenTime - latestStats.minOpenTime) / PRICE_CHANGE_1M_INTERVAL_MS) + 1
      : latestStats.count;
  if (latestStats.count > 1 && spanSlotCount > latestStats.count) {
    const gaps = await listPriceChangeKlineGaps(
      token.symbol,
      target.targetStartTime,
      target.targetEndTime,
      config.priceChangeKline.maxGapRepairPasses
    );
    for (const gap of gaps) {
      if (!shouldContinue()) break;
      addResult(
        await fetchPriceChangeKlineRange({
          token,
          startTime: gap.startTime,
          endTime: gap.endTime,
          shouldContinue
        }),
        "gap"
      );
      repairedGapCount += 1;
    }
    if (gapRows > 0) {
      latestStats = await priceChangeKlineStats(token.symbol, {
        startTime: target.targetStartTime,
        endTime: target.targetEndTime
      });
    }
  }

  const recentStartTime =
    latestStats.maxOpenTime === null
      ? target.targetStartTime
      : latestStats.maxOpenTime + PRICE_CHANGE_1M_INTERVAL_MS;
  if (recentStartTime <= target.targetEndTime) {
    addResult(
      await fetchPriceChangeKlineRange({
        token,
        startTime: recentStartTime,
        endTime: target.targetEndTime,
        shouldContinue
      }),
      "recent"
    );
  }

  return {
    symbol: token.symbol,
    fetchedRows,
    storedRows,
    coverageRows,
    gapRows,
    recentRows,
    repairedGapCount
  };
}

export function getPriceChangeKlineRefreshState() {
  return { ...priceChangeKlineState };
}

export async function runPriceChangeKlineRefresh({ force = false, shouldContinue = () => true } = {}) {
  if (!config.priceChangeKline.enabled && !force) {
    return { skipped: true, reason: "price change 1m kline refresh disabled" };
  }
  if (priceChangeKlineState.running) {
    return { skipped: true, reason: "price change 1m kline refresh already running", ...getPriceChangeKlineRefreshState() };
  }

  priceChangeKlineState.running = true;
  priceChangeKlineState.lastStartedAt = isoNow();
  priceChangeKlineState.lastCompletedAt = null;
  priceChangeKlineState.lastError = null;
  priceChangeKlineState.lastAction = "开始刷新 24h 涨跌幅专用 1m K线";
  priceChangeKlineState.refreshedRows = 0;
  priceChangeKlineState.storedRows = 0;
  priceChangeKlineState.cleanupDeletedRows = 0;
  priceChangeKlineState.errorCount = 0;
  priceChangeKlineState.errors = [];

  try {
    const target = priceChangeKlineTarget();
    const tokens = await listActivePriceChangeKlineTokens();
    priceChangeKlineState.tokenCount = tokens.length;
    if (!tokens.length) {
      const cleanup = await cleanupPriceChangeKlineRetention();
      priceChangeKlineState.cleanupDeletedRows = cleanup.deletedRows;
      priceChangeKlineState.lastAction = "没有活跃交易对，已清理 1m 涨跌幅缓存";
      return { ok: true, tokenCount: 0, refreshedRows: 0, storedRows: 0, cleanup };
    }

    const results = await mapLimit(tokens, config.priceChangeKline.concurrency, async (token) => {
      if (!shouldContinue()) return { symbol: token.symbol, fetchedRows: 0, storedRows: 0, skipped: true };
      const result = await refreshTokenPriceChangeKlines(token, target, { shouldContinue });
      if (result.fetchedRows > 0) {
        priceChangeKlineState.lastAction = `${token.symbol} 1m 涨跌幅缓存刷新 ${result.fetchedRows} 行`;
      }
      return result;
    });

    let refreshedRows = 0;
    let storedRows = 0;
    const errors = [];
    for (const [index, result] of results.entries()) {
      if (result.status === "fulfilled") {
        refreshedRows += Number(result.value?.fetchedRows ?? 0);
        storedRows += Number(result.value?.storedRows ?? 0);
        continue;
      }
      const token = tokens[index];
      const message = result.reason instanceof Error ? result.reason.message : String(result.reason);
      errors.push(`${token?.symbol ?? "UNKNOWN"}: ${message}`);
    }

    const cleanup = await cleanupPriceChangeKlineRetention();
    priceChangeKlineState.refreshedRows = refreshedRows;
    priceChangeKlineState.storedRows = storedRows;
    priceChangeKlineState.cleanupDeletedRows = cleanup.deletedRows;
    priceChangeKlineState.errorCount = errors.length;
    priceChangeKlineState.errors = errors.slice(-20);
    priceChangeKlineState.lastError = errors.at(-1) ?? null;
    priceChangeKlineState.lastAction = errors.length
      ? `1m 涨跌幅缓存刷新完成：${tokens.length} 个交易对，拉取 ${refreshedRows} 行，失败 ${errors.length} 个`
      : `1m 涨跌幅缓存刷新完成：${tokens.length} 个交易对，拉取 ${refreshedRows} 行`;

    return {
      ok: true,
      tokenCount: tokens.length,
      refreshedRows,
      storedRows,
      errorCount: errors.length,
      errors: errors.slice(-20),
      cleanup,
      target
    };
  } catch (error) {
    priceChangeKlineState.lastError = error instanceof Error ? error.message : String(error);
    priceChangeKlineState.lastAction = "1m 涨跌幅缓存刷新失败";
    throw error;
  } finally {
    priceChangeKlineState.running = false;
    priceChangeKlineState.lastCompletedAt = isoNow();
  }
}

export function startPriceChangeKlineScheduler() {
  if (!config.priceChangeKline.enabled) return getPriceChangeKlineRefreshState();
  scheduleNextPriceChangeKlineRefresh(config.priceChangeKline.initialDelayMs);
  return getPriceChangeKlineRefreshState();
}
