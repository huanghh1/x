import { fetchKlinesPaged } from "../binance.js";
import { config } from "../config.js";
import {
  klineStats,
  listKlineGaps,
  markKlineAvailabilityStart,
  markTokenFetching,
  refreshTokenFetchState,
  upsertKlinePage
} from "../db.js";

export function intervalMs(intervalCode) {
  return {
    "15m": 15 * 60 * 1000,
    "1h": 60 * 60 * 1000,
    "4h": 4 * 60 * 60 * 1000,
    "1d": 24 * 60 * 60 * 1000
  }[intervalCode];
}

function intervalLookbackStart(intervalCode) {
  const fallback = config.crawler.lookbackDays;
  const lookbackDays = config.crawler.intervalLookbackDays[intervalCode] ?? fallback;
  const retentionCount = Number(config.crawler.retentionLimits[intervalCode]);
  const latestClosedOpenTime = latestClosedKlineOpenTime(intervalCode);
  if (Number.isFinite(retentionCount) && retentionCount > 1) {
    return latestClosedOpenTime - (retentionCount - 1) * intervalMs(intervalCode);
  }
  return latestClosedOpenTime - lookbackDays * 24 * 60 * 60 * 1000;
}

function latestClosedKlineOpenTime(intervalCode) {
  const ms = intervalMs(intervalCode);
  return Math.floor(Date.now() / ms) * ms - ms;
}

export function recentKlineRefreshRange({ latestOpenTime, targetStartTime, targetEndTime, intervalMsValue }) {
  if (latestOpenTime !== null && latestOpenTime !== undefined) {
    const latest = Number(latestOpenTime);
    if (Number.isFinite(latest) && latest >= targetEndTime) return null;
    if (Number.isFinite(latest)) {
      return { startTime: latest + intervalMsValue, endTime: targetEndTime };
    }
  }
  return { startTime: targetStartTime, endTime: targetEndTime };
}

export async function fetchKlineRange({
  token,
  intervalCode,
  startTime,
  endTime,
  action,
  limit,
  shouldContinue,
  onAction = () => {},
  onRecoveredNetwork = () => {}
}) {
  if (endTime < startTime) return 0;
  let fetchedRows = 0;
  onAction(action);
  await fetchKlinesPaged({
    symbol: token.symbol,
    intervalCode,
    startTime,
    endTime,
    limit,
    onPage: async (page) => {
      const stored = await upsertKlinePage(token, intervalCode, page);
      fetchedRows += page.length;
      const changeSummary = stored ? `，写入/更新 ${stored} 行` : "";
      onAction(`${token.symbol} ${intervalCode} 同步 ${page.length} 根K线${changeSummary}`);
      onRecoveredNetwork();
    },
    shouldContinue
  });
  return fetchedRows;
}

export async function refreshTokenInterval(token, intervalCode, {
  maxGapPasses = 25,
  shouldContinue = () => true,
  onAction = () => {},
  onRecoveredNetwork = () => {}
} = {}) {
  await markTokenFetching(token.id, intervalCode);

  const targetStartTime = intervalLookbackStart(intervalCode);
  const targetEndTime = latestClosedKlineOpenTime(intervalCode);
  const stats = await klineStats(token.symbol, intervalCode);
  const hasEnoughCoverage =
    stats.count > 0 &&
    stats.minOpenTime !== null &&
    stats.minOpenTime <= targetStartTime;
  let coverageRows = 0;
  let gapRows = 0;
  let recentRows = 0;
  let repairedGapCount = 0;
  let attemptedHistoricalCoverage = false;

  if (!hasEnoughCoverage && shouldContinue()) {
    const startTime = targetStartTime;
    const endTime = stats.minOpenTime === null
      ? targetEndTime
      : Math.min(targetEndTime, stats.minOpenTime - intervalMs(intervalCode));
    attemptedHistoricalCoverage = true;
    coverageRows = await fetchKlineRange({
      token,
      intervalCode,
      startTime,
      endTime,
      action: `${token.symbol} ${intervalCode} 补齐目标窗口中`,
      shouldContinue,
      onAction,
      onRecoveredNetwork
    });
  }

  const gaps = await listKlineGaps(token.symbol, intervalCode, intervalMs(intervalCode), targetStartTime, targetEndTime, maxGapPasses);
  for (const gap of gaps) {
    if (!shouldContinue()) break;
    const fetched = await fetchKlineRange({
      token,
      intervalCode,
      startTime: gap.startTime,
      endTime: gap.endTime,
      action: `${token.symbol} ${intervalCode} 补齐中间缺口`,
      shouldContinue,
      onAction,
      onRecoveredNetwork
    });
    gapRows += fetched;
    repairedGapCount += 1;
    if (fetched === 0) {
      onAction(`${token.symbol} ${intervalCode} 缺口 ${new Date(gap.startTime).toISOString()} 未返回K线，继续检查后续缺口`);
    }
  }

  const latestStats = await klineStats(token.symbol, intervalCode);
  if (
    attemptedHistoricalCoverage &&
    shouldContinue() &&
    latestStats.minOpenTime !== null &&
    latestStats.minOpenTime > targetStartTime
  ) {
    await markKlineAvailabilityStart(token.symbol, intervalCode, latestStats.minOpenTime);
  }
  const recentRange = recentKlineRefreshRange({
    latestOpenTime: latestStats.maxOpenTime,
    targetStartTime,
    targetEndTime,
    intervalMsValue: intervalMs(intervalCode)
  });
  if (shouldContinue() && recentRange) {
    recentRows = await fetchKlineRange({
      token,
      intervalCode,
      startTime: recentRange.startTime,
      endTime: recentRange.endTime,
      limit: config.crawler.incrementalKlineLimit,
      action: `${token.symbol} ${intervalCode} 补最新K线`,
      shouldContinue,
      onAction,
      onRecoveredNetwork
    });
  }
  if (hasEnoughCoverage && recentRows === 0 && gapRows === 0) {
    onAction(`${token.symbol} ${intervalCode} 已是最新缓存`);
  }
  await refreshTokenFetchState(token.id);
  return {
    intervalCode,
    coverageRows,
    gapRows,
    recentRows,
    repairedGapCount,
    totalRows: coverageRows + gapRows + recentRows
  };
}
