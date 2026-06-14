import { discoverTargetTokens, fetchKlinesPaged } from "./binance.js";
import { config } from "./config.js";
import {
  claimNextTokenForFetch,
  cleanupInactiveTokenKlines,
  countActiveTokens,
  findKlineGap,
  getKlineAuditReport,
  getSignalCorrelationContext,
  insertKlinePage,
  markHotMaSignalAlertSent,
  klineStats,
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
  if (Number.isFinite(retentionCount) && retentionCount > 1) {
    return Date.now() - (retentionCount - 1) * intervalMs(intervalCode);
  }
  return Date.now() - lookbackDays * 24 * 60 * 60 * 1000;
}

async function fetchKlineRange({ token, intervalCode, startTime, endTime, action }) {
  if (endTime <= startTime) return 0;
  let insertedRows = 0;
  crawlerState.lastAction = action;
  await fetchKlinesPaged({
    symbol: token.symbol,
    intervalCode,
    startTime,
    endTime,
    onPage: async (page) => {
      const inserted = await insertKlinePage(token, intervalCode, page);
      insertedRows += inserted;
      crawlerState.lastAction = `${token.symbol} ${intervalCode} 入库 ${inserted}/${page.length} 根K线`;
    },
    shouldContinue: () => crawlerState.running
  });
  return insertedRows;
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
  telegramContext.alertLevel = bestAlertLevel;
  telegramContext.profile = profile;
  if (hotRankActive) {
    const hotSignals = newLevel1Signals;
    if (hotSignals.length) {
      triggerEvents.push({
        eventKey: `hot-ma:${token.symbol}:${hotSignals.map(({ intervalCode }) => intervalCode).join("-")}:${latestSignalTime}`,
        symbol: token.symbol,
        triggerType: "COMPOSITE",
        intervals: telegramContext.multiCycleIntervals.join(","),
        signalLevel: "LEVEL1",
        triggerTime: latestSignalTime,
        details: {
          sources: ["HOT_RANK", "MA"],
          multiCycleCount: multiCycleSignals.length,
          fundingOneHour: correlation.fundingOneHour,
          priority: profile.priority,
          profile: profile.label
        }
      });
    }
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
    await markTokenFetching(token.id, intervalCode);

    const targetStartTime = intervalLookbackStart(intervalCode);
    const stats = await klineStats(token.symbol, intervalCode);
    const hasEnoughCoverage =
      stats.count > 0 &&
      stats.minOpenTime !== null &&
      stats.minOpenTime <= targetStartTime + intervalMs(intervalCode);

    if (!hasEnoughCoverage) {
      const startTime = targetStartTime;
      const endTime = stats.minOpenTime === null ? Date.now() : stats.minOpenTime - intervalMs(intervalCode);
      await fetchKlineRange({
        token,
        intervalCode,
        startTime,
        endTime,
        action: `${token.symbol} ${intervalCode} 补齐目标窗口中`
      });
    }

    for (let gapPass = 0; gapPass < 3; gapPass += 1) {
      const gap = await findKlineGap(token.symbol, intervalCode, intervalMs(intervalCode), targetStartTime, Date.now());
      if (!gap) break;
      await fetchKlineRange({
        token,
        intervalCode,
        startTime: gap.startTime,
        endTime: gap.endTime,
        action: `${token.symbol} ${intervalCode} 补齐中间缺口`
      });
    }

    const latestStats = await klineStats(token.symbol, intervalCode);
    const recentStartTime =
      latestStats.maxOpenTime === null ? targetStartTime : Number(latestStats.maxOpenTime) + intervalMs(intervalCode);
    const recentEndTime = Date.now();
    const insertedRecent = await fetchKlineRange({
      token,
      intervalCode,
      startTime: recentStartTime,
      endTime: recentEndTime,
      action: `${token.symbol} ${intervalCode} 补最新K线`
    });
    if (hasEnoughCoverage && insertedRecent === 0) {
      crawlerState.lastAction = `${token.symbol} ${intervalCode} 已是最新缓存`;
    }
    await refreshTokenFetchState(token.id);
    await sleep(config.crawler.intervalDelayMs);
  }

  await refreshTokenFetchState(token.id);
  if (crawlerState.running) {
    await recomputeAndNotifyToken(token);
    crawlerState.lastAction = `${token.symbol} 四周期缓存与信号计算完成`;
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
