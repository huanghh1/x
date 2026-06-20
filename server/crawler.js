import { discoverTargetTokens, fetchKlinesPaged } from "./binance.js";
import { config } from "./config.js";
import {
  claimNextTokenForFetch,
  cleanupInactiveTokenKlines,
  countActiveTokens,
  getActiveTokenBySymbol,
  getKlineAuditReport,
  getSignalCorrelationContext,
  listKlineGaps,
  markHotMaSignalAlertSent,
  klineStats,
  markKlineAvailabilityStart,
  markTokenFetching,
  markTokenPartial,
  queueActiveTokensForKlineAudit,
  recordMultiCycleHistory,
  recordTriggerHistoryBatch,
  refreshTokenFetchState,
  resetInterruptedFetchingTokens,
  selectClosePrices,
  selectHotMaSignalAlert,
  selectPreviousSignals,
  upsertKlinePage,
  upsertSignals,
  upsertTokens
} from "./db.js";
import { calculateSignal, INTERVALS } from "./ma.js";
import { sendHotMaSignalTelegram } from "./telegram.js";
import { resolveBestAlertLevel, resolveSignalProfile } from "./signalPriority.js";

const crawlerState = {
  running: false,
  initializedTokens: false,
  tokenUniverseCount: 0,
  currentSymbol: null,
  currentInterval: null,
  activeTokens: [],
  workerCount: config.crawler.concurrentTokens,
  lastAction: "等待启动",
  lastError: null,
  startedAt: null,
  lastTokenDelayMs: null
};

const auditState = {
  running: false,
  nextRunAt: null,
  lastStartedAt: null,
  lastCompletedAt: null,
  lastResult: null,
  lastError: null
};

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function randomTokenDelay() {
  const { tokenDelayMinMs, tokenDelayMaxMs } = config.crawler;
  return Math.floor(tokenDelayMinMs + Math.random() * Math.max(0, tokenDelayMaxMs - tokenDelayMinMs));
}

const activeWorkers = new Map();

function setWorkerActivity(workerId, token, intervalCode = null) {
  if (token) {
    activeWorkers.set(workerId, { workerId, symbol: token.symbol, intervalCode });
  } else {
    activeWorkers.delete(workerId);
  }
  crawlerState.activeTokens = Array.from(activeWorkers.values());
  const latest = crawlerState.activeTokens[crawlerState.activeTokens.length - 1];
  crawlerState.currentSymbol = latest?.symbol ?? null;
  crawlerState.currentInterval = latest?.intervalCode ?? null;
}

function intervalMs(intervalCode) {
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

async function fetchKlineRange({ token, intervalCode, startTime, endTime, action, limit, shouldContinue }) {
  if (endTime < startTime) return 0;
  let fetchedRows = 0;
  crawlerState.lastAction = action;
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
      crawlerState.lastAction = `${token.symbol} ${intervalCode} 同步 ${page.length} 根K线${changeSummary}`;
    },
    shouldContinue: shouldContinue ?? (() => crawlerState.running)
  });
  return fetchedRows;
}

export function getCrawlerState() {
  return { ...crawlerState, dailyAudit: { ...auditState } };
}

export function setDailyAuditNextRunAt(value) {
  auditState.nextRunAt = value ? new Date(value).toISOString() : null;
}

export async function initializeTokenUniverse() {
  const tokens = await discoverTargetTokens();
  const count = await upsertTokens(tokens);
  crawlerState.initializedTokens = true;
  crawlerState.tokenUniverseCount = count;
  crawlerState.lastAction = `已同步 ${count} 个目标交易对`;
  return { count, tokens };
}

export async function runDailyKlineAudit({ syncUniverse = true } = {}) {
  if (auditState.running) return { skipped: true, reason: "K 线审计正在运行", ...auditState };
  auditState.running = true;
  auditState.lastStartedAt = new Date().toISOString();
  auditState.lastError = null;
  try {
    let universe = null;
    let universeError = null;
    if (syncUniverse) {
      try {
        universe = await initializeTokenUniverse();
      } catch (error) {
        universeError = error instanceof Error ? error.message : String(error);
      }
    }
    const [report, inactiveCleanup] = await Promise.all([
      getKlineAuditReport(config.crawler.retentionLimits),
      cleanupInactiveTokenKlines(config.crawler.inactiveRetentionDays)
    ]);
    const deficientSymbols = [...new Set(report.deficient.map((item) => item.symbol))];
    const queuedTokenCount = await queueActiveTokensForKlineAudit(deficientSymbols);
    await startCrawler();
    const result = {
      ok: true,
      universeCount: universe?.count ?? null,
      universeError,
      queuedTokenCount,
      report,
      inactiveCleanup
    };
    auditState.lastCompletedAt = new Date().toISOString();
    auditState.lastResult = {
      universeCount: result.universeCount,
      universeError: result.universeError,
      queuedTokenCount: result.queuedTokenCount,
      activeTokenCount: report.activeTokenCount,
      deficientTokenCount: report.deficientTokenCount,
      deficientIntervalCount: report.deficientIntervalCount,
      inactiveCleanup
    };
    return result;
  } catch (error) {
    auditState.lastError = error instanceof Error ? error.message : String(error);
    throw error;
  } finally {
    auditState.running = false;
  }
}

async function recomputeAndNotifyToken(token) {
  const [previousByInterval, closeGroups] = await Promise.all([
    selectPreviousSignals(token.symbol),
    Promise.all(
      INTERVALS.map(async (intervalCode) => ({
        intervalCode,
        closes: await selectClosePrices(token.symbol, intervalCode)
      }))
    )
  ]);
  const computedSignals = closeGroups.map(({ intervalCode, closes }) => ({
    intervalCode,
    previous: previousByInterval.get(intervalCode) ?? null,
    signal: calculateSignal({ intervalCode, closes })
  }));
  await upsertSignals(token, computedSignals.map(({ signal }) => signal));

  const multiCycleSignals = computedSignals.filter(({ signal }) => ["LEVEL1", "LEVEL2"].includes(signal.alertLevel));
  const previousMultiCycleCount = computedSignals.filter(({ previous }) =>
    ["LEVEL1", "LEVEL2"].includes(previous?.alert_level)
  ).length;
  const telegramContext = {
    multiCycleCount: multiCycleSignals.length,
    multiCycleIntervals: multiCycleSignals.map(({ intervalCode }) => intervalCode)
  };
  await recordMultiCycleHistory(token, computedSignals, 3);

  const latestSignalTime =
    Math.max(...computedSignals.map(({ signal }) => Number(signal.signalTime) || 0)) || Date.now();
  const newLevel1Signals = computedSignals.filter(
    ({ previous, signal }) => signal.alertLevel === "LEVEL1" && previous?.alert_level !== "LEVEL1"
  );
  const newAlertSignals = computedSignals.filter(
    ({ previous, signal }) =>
      ["LEVEL1", "LEVEL2"].includes(signal.alertLevel) && previous?.alert_level !== signal.alertLevel
  );
  const triggerEvents = [];
  if (newLevel1Signals.length) {
    triggerEvents.push({
      eventKey: `ma:${token.symbol}:${newLevel1Signals.map(({ intervalCode }) => intervalCode).join("-")}:${latestSignalTime}`,
      symbol: token.symbol,
      triggerType: "MA_SIGNAL",
      intervals: computedSignals
        .filter(({ signal }) => signal.alertLevel === "LEVEL1")
        .map(({ intervalCode }) => intervalCode)
        .join(","),
      signalLevel: "LEVEL1",
      triggerTime: latestSignalTime,
      details: {
        newlyTriggeredIntervals: newLevel1Signals.map(({ intervalCode }) => intervalCode),
        multiCycleCount: multiCycleSignals.length
      }
    });
  }

  if (multiCycleSignals.length >= 3 && previousMultiCycleCount < 3) {
    triggerEvents.push({
      eventKey: `multi:${token.symbol}:${multiCycleSignals.map(({ intervalCode }) => intervalCode).join("-")}:${latestSignalTime}`,
      symbol: token.symbol,
      triggerType: "COMPOSITE",
      intervals: telegramContext.multiCycleIntervals.join(","),
      signalLevel: multiCycleSignals.some(({ signal }) => signal.alertLevel === "LEVEL1") ? "LEVEL1" : null,
      triggerTime: latestSignalTime,
      details: { sources: ["MA", "MULTI_CYCLE"], multiCycleCount: multiCycleSignals.length }
    });
  }

  const correlation = await getSignalCorrelationContext(token.symbol);
  const hotRankActive = multiCycleSignals.length > 0 && correlation.hotRank;
  const bestAlertLevel = resolveBestAlertLevel(multiCycleSignals);
  const profile = resolveSignalProfile({
    fundingOneHour: correlation.fundingOneHour,
    hotRank: hotRankActive,
    multiCycleCount: multiCycleSignals.length,
    alertLevel: bestAlertLevel,
    oiSpike: correlation.oiSpike
  });
  telegramContext.fundingOneHour = correlation.fundingOneHour;
  telegramContext.hotRank = hotRankActive;
  telegramContext.oiSpike = correlation.oiSpike;
  telegramContext.oiChange5mPct = correlation.oiChange5mPct;
  telegramContext.oiChange1hPct = correlation.oiChange1hPct;
  telegramContext.oiChange4hPct = correlation.oiChange4hPct;
  telegramContext.oiChange1dPct = correlation.oiChange1dPct;
  telegramContext.oiSpike5mHit = correlation.oiSpike5mHit;
  telegramContext.oiSpike1hHit = correlation.oiSpike1hHit;
  telegramContext.oiSpike4hHit = correlation.oiSpike4hHit;
  telegramContext.oiSpike1dHit = correlation.oiSpike1dHit;
  telegramContext.alertLevel = bestAlertLevel;
  telegramContext.profile = profile;
  const compositeChanged = newAlertSignals.length > 0 || (multiCycleSignals.length >= 3 && previousMultiCycleCount < 3);
  if (profile.sourceMask > 1 && compositeChanged) {
    triggerEvents.push({
      eventKey: `combo:${token.symbol}:${profile.key}:${telegramContext.multiCycleIntervals.join("-")}:${latestSignalTime}`,
      symbol: token.symbol,
      triggerType: "COMPOSITE",
      intervals: telegramContext.multiCycleIntervals.join(","),
      signalLevel: bestAlertLevel,
      triggerTime: latestSignalTime,
      details: {
        sources: [
          "MA",
          correlation.fundingOneHour ? "FUNDING_RATE" : null,
          correlation.oiSpike ? "OI_SPIKE" : null,
          hotRankActive ? "HOT_RANK" : null,
          profile.multi ? "MULTI_CYCLE" : null
        ].filter(Boolean),
        newlyTriggeredIntervals: newAlertSignals.map(({ intervalCode }) => intervalCode),
        multiCycleCount: multiCycleSignals.length,
        sourceMask: profile.sourceMask,
        priority: profile.priority,
        profile: profile.label
      }
    });
  }
  await recordTriggerHistoryBatch(triggerEvents);

  if (multiCycleSignals.length > 0 && profile.sourceMask > 0) {
    const alertStates = await Promise.all(
      multiCycleSignals.map(async ({ intervalCode, signal }) => {
        const previousAlert = await selectHotMaSignalAlert(token.symbol, intervalCode);
        const previousSignalTime = previousAlert?.signalTime ? new Date(previousAlert.signalTime).getTime() : 0;
        const signalTime = Number(signal.signalTime ?? 0);
        return {
          shouldSend:
            !previousAlert ||
            previousAlert.alertLevel !== signal.alertLevel ||
            Math.abs(previousSignalTime - signalTime) > 1 ||
            (multiCycleSignals.length >= 3 && previousMultiCycleCount < 3)
        };
      })
    );
    if (alertStates.some(({ shouldSend }) => shouldSend)) {
      const representative = multiCycleSignals.find(({ signal }) => signal.alertLevel === bestAlertLevel)
        ?? multiCycleSignals[0];
      const result = await sendHotMaSignalTelegram(token, representative.signal, telegramContext);
      if (!result.skipped) {
        await Promise.all(
          multiCycleSignals.map(({ intervalCode, signal }) =>
            markHotMaSignalAlertSent(token.symbol, intervalCode, signal)
          )
        );
      }
    }
  }
}

async function fetchToken(token, workerId) {
  setWorkerActivity(workerId, token);
  crawlerState.lastAction = `开始处理 ${token.symbol}`;

  for (const intervalCode of INTERVALS) {
    if (!crawlerState.running) break;
    setWorkerActivity(workerId, token, intervalCode);
    await refreshTokenInterval(token, intervalCode, {
      maxGapPasses: config.crawler.maxGapRepairPasses,
      shouldContinue: () => crawlerState.running
    });
    await sleep(config.crawler.intervalDelayMs);
  }

  await refreshTokenFetchState(token.id);
  if (crawlerState.running) {
    await recomputeAndNotifyToken(token);
    crawlerState.lastError = null;
    crawlerState.lastAction = `${token.symbol} 四周期缓存与信号计算完成`;
  }
}

async function refreshTokenInterval(token, intervalCode, { maxGapPasses = 25, shouldContinue = () => true } = {}) {
  await markTokenFetching(token.id, intervalCode);

  const targetStartTime = intervalLookbackStart(intervalCode);
  const targetEndTime = latestClosedKlineOpenTime(intervalCode);
  const stats = await klineStats(token.symbol, intervalCode);
  const hasEnoughCoverage =
    stats.count > 0 &&
    stats.minOpenTime !== null &&
    stats.minOpenTime <= targetStartTime + intervalMs(intervalCode);
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
      shouldContinue
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
      shouldContinue
    });
    gapRows += fetched;
    repairedGapCount += 1;
    if (fetched === 0) {
      crawlerState.lastAction = `${token.symbol} ${intervalCode} 缺口 ${new Date(gap.startTime).toISOString()} 未返回K线，继续检查后续缺口`;
    }
  }

  const latestStats = await klineStats(token.symbol, intervalCode);
  if (
    attemptedHistoricalCoverage &&
    shouldContinue() &&
    latestStats.minOpenTime !== null &&
    latestStats.minOpenTime > targetStartTime + intervalMs(intervalCode)
  ) {
    await markKlineAvailabilityStart(token.symbol, intervalCode, latestStats.minOpenTime);
  }
  const recentStartTime =
    latestStats.maxOpenTime === null
      ? targetStartTime
      : Math.min(Number(latestStats.maxOpenTime) + intervalMs(intervalCode), targetEndTime);
  const recentEndTime = targetEndTime;
  if (shouldContinue()) {
    recentRows = await fetchKlineRange({
      token,
      intervalCode,
      startTime: recentStartTime,
      endTime: recentEndTime,
      limit: config.crawler.incrementalKlineLimit,
      action: `${token.symbol} ${intervalCode} 补最新K线`,
      shouldContinue
    });
  }
  if (hasEnoughCoverage && recentRows === 0 && gapRows === 0) {
    crawlerState.lastAction = `${token.symbol} ${intervalCode} 已是最新缓存`;
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

export async function refreshKlineCacheForSymbol(symbol, intervalCode) {
  if (!INTERVALS.includes(intervalCode)) {
    return { ok: false, reason: "invalid interval" };
  }
  const token = await getActiveTokenBySymbol(symbol);
  if (!token) return { ok: false, reason: "symbol not active" };
  setWorkerActivity("on-demand", token, intervalCode);
  try {
    const result = await refreshTokenInterval(token, intervalCode, {
      maxGapPasses: config.crawler.onDemandMaxGapRepairPasses,
      shouldContinue: () => true
    });
    crawlerState.lastAction = `${token.symbol} ${intervalCode} 按需K线修复完成`;
    return { ok: true, symbol: token.symbol, ...result };
  } finally {
    setWorkerActivity("on-demand", null);
  }
}

async function runCrawlerWorker(workerId) {
  while (crawlerState.running) {
    const token = await claimNextTokenForFetch();
    if (!token) return;

    try {
      await fetchToken(token, workerId);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      crawlerState.lastError = message;
      crawlerState.lastAction = `${token.symbol} 抓取中断，保留断点`;
      await markTokenPartial(token.id, message);
    } finally {
      setWorkerActivity(workerId, null);
    }

    if (!crawlerState.running) break;
    const delayMs = randomTokenDelay();
    crawlerState.lastTokenDelayMs = delayMs;
    if (delayMs > 0) {
      crawlerState.lastAction = `worker ${workerId} 单币种完成，暂停 ${Math.round(delayMs / 1000)} 秒`;
      await sleep(delayMs);
    }
  }
}

export async function startCrawler() {
  if (crawlerState.running) return crawlerState;
  crawlerState.running = true;
  crawlerState.startedAt = crawlerState.startedAt ?? Date.now();
  crawlerState.lastError = null;
  crawlerState.workerCount = config.crawler.concurrentTokens;

  queueMicrotask(async () => {
    try {
      await resetInterruptedFetchingTokens(config.crawler.staleFetchingAfterMs);
      if (!crawlerState.initializedTokens) {
        try {
          await initializeTokenUniverse();
        } catch (error) {
          const activeCount = await countActiveTokens();
          if (activeCount === 0) throw error;
          crawlerState.initializedTokens = true;
          crawlerState.tokenUniverseCount = activeCount;
          crawlerState.lastError = error instanceof Error ? error.message : String(error);
          crawlerState.lastAction = `同步交易对失败，使用本地 ${activeCount} 个活跃交易对继续增量抓取`;
        }
      }
      const workerCount = Math.max(1, config.crawler.concurrentTokens);
      await Promise.all(Array.from({ length: workerCount }, (_, index) => runCrawlerWorker(index + 1)));
      if (crawlerState.running) crawlerState.lastAction = "所有目标币种已完成本地缓存";
      crawlerState.currentSymbol = null;
      crawlerState.currentInterval = null;
      crawlerState.activeTokens = [];
      activeWorkers.clear();
      crawlerState.running = false;
    } catch (error) {
      crawlerState.lastError = error instanceof Error ? error.message : String(error);
      crawlerState.lastAction = "抓取服务异常停止";
      await resetInterruptedFetchingTokens(0);
      crawlerState.currentSymbol = null;
      crawlerState.currentInterval = null;
      crawlerState.activeTokens = [];
      activeWorkers.clear();
      crawlerState.running = false;
    }
  });

  return crawlerState;
}

export function stopCrawler() {
  crawlerState.running = false;
  crawlerState.lastAction = "抓取服务已手动暂停";
  return crawlerState;
}
