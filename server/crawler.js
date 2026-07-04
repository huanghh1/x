import { discoverTargetTokens, fetchKlinesPaged } from "./binance.js";
import { config } from "./config.js";
import {
  claimNextTokenForFetch,
  cleanupInactiveTokenKlines,
  countActiveTokens,
  getActiveTokenBySymbol,
  getKlineAuditReport,
  getSignalCorrelationContext,
  listKlineTailRefreshTargets,
  listKlineGaps,
  markHotMaSignalAlertSent,
  klineStats,
  markKlineAvailabilityStart,
  markTokenFetching,
  markTokenPartial,
  queueActiveTokensForKlineAudit,
  recordMultiCycleHistory,
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
import {
  hasNewListItem,
  hasNewOrUpgradedIntervalSignal,
  isAlertLevelEntryOrUpgrade,
  normalizeAlertLevel,
  parseIntervalLevelSignature,
  parseKeyValueSignature,
  parseSignatureList
} from "./alertState.js";

const crawlerState = {
  running: false,
  initializedTokens: false,
  tokenUniverseCount: 0,
  currentSymbol: null,
  currentInterval: null,
  activeTokens: [],
  workerCount: config.crawler.concurrentTokens,
  runMode: "idle",
  runReason: null,
  runStartedAt: null,
  runCompletedAt: null,
  incrementalCutoffAt: null,
  includeIncremental: false,
  processedTokenCount: 0,
  lastAction: "等待启动",
  lastError: null,
  lastErrorAt: null,
  startedAt: null,
  lastTokenDelayMs: null,
  tailRefresh: {
    running: false,
    lastStartedAt: null,
    lastCompletedAt: null,
    targetCount: 0,
    tokenCount: 0,
    refreshedRows: 0,
    errorCount: 0,
    lastError: null,
    lastErrorAt: null
  }
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

function isRetryableDatabaseError(error) {
  const message = error instanceof Error ? error.message : String(error);
  const code = error?.code ?? error?.errno;
  return (
    code === "ER_LOCK_DEADLOCK" ||
    code === "ER_LOCK_WAIT_TIMEOUT" ||
    code === 1213 ||
    code === 1205 ||
    /deadlock|lock wait timeout/i.test(message)
  );
}

async function withRetryableDatabaseOperation(label, operation, attempts = 3) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (!isRetryableDatabaseError(error) || attempt >= attempts) break;
      const delayMs = 250 * 2 ** (attempt - 1);
      crawlerState.lastAction = `${label} 遇到数据库锁冲突，${delayMs}ms 后重试`;
      await sleep(delayMs);
    }
  }
  throw lastError;
}

const activeWorkers = new Map();
const hotMaAlertingSymbols = new Set();

function setCrawlerError(message) {
  crawlerState.lastError = message;
  crawlerState.lastErrorAt = new Date().toISOString();
}

function clearCrawlerError() {
  crawlerState.lastError = null;
  crawlerState.lastErrorAt = null;
}

function isTransientNetworkError(message) {
  return /(ECONNRESET|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|UND_ERR|fetch failed|aborted|timeout|socket|TLS|network)/i.test(String(message ?? ""));
}

function clearRecoveredNetworkError() {
  if (isTransientNetworkError(crawlerState.lastError)) clearCrawlerError();
}

function intervalSortIndex(intervalCode) {
  const index = INTERVALS.indexOf(intervalCode);
  return index === -1 ? INTERVALS.length : index;
}

function hasComparableHotMaAlertState(previousAlert) {
  return Boolean(previousAlert?.profileKey && previousAlert?.contextSignature && Number(previousAlert?.sourceMask) > 0);
}

function parseHotMaAlertSignature(signature, sourceMask = 0) {
  const state = parseKeyValueSignature(signature);
  return {
    sourceMask: Number(sourceMask || state.get("sources") || 0) || 0,
    level: normalizeAlertLevel(state.get("level")),
    fundingOneHour: state.get("funding") === "1",
    hotRank: state.get("hot") === "1",
    oiSpike: state.get("oi") === "1",
    oiWindows: parseSignatureList(state.get("oiWindows")),
    intervals: parseIntervalLevelSignature(state.get("intervals"))
  };
}

function hasNewHotMaAlertEntry(previousAlert, alertState = {}) {
  const previousState = parseHotMaAlertSignature(previousAlert?.contextSignature, previousAlert?.sourceMask);
  const currentState = parseHotMaAlertSignature(alertState.contextSignature, alertState.sourceMask);
  return (
    (currentState.sourceMask & ~previousState.sourceMask) !== 0 ||
    (!previousState.fundingOneHour && currentState.fundingOneHour) ||
    (!previousState.hotRank && currentState.hotRank) ||
    (!previousState.oiSpike && currentState.oiSpike) ||
    hasNewListItem(currentState.oiWindows, previousState.oiWindows) ||
    hasNewOrUpgradedIntervalSignal(currentState.intervals, previousState.intervals) ||
    isAlertLevelEntryOrUpgrade(previousState.level, currentState.level)
  );
}

export function buildHotMaSignalAlertState(multiCycleSignals = [], context = {}) {
  const intervalStates = (Array.isArray(multiCycleSignals) ? multiCycleSignals : [])
    .map(({ intervalCode, signal }) => ({
      intervalCode: String(intervalCode ?? signal?.intervalCode ?? ""),
      alertLevel: signal?.alertLevel
    }))
    .filter(({ intervalCode, alertLevel }) => INTERVALS.includes(intervalCode) && ["LEVEL1", "LEVEL2"].includes(alertLevel))
    .sort((a, b) => intervalSortIndex(a.intervalCode) - intervalSortIndex(b.intervalCode));
  const alertLevel = ["LEVEL1", "LEVEL2"].includes(context.alertLevel)
    ? context.alertLevel
    : resolveBestAlertLevel(intervalStates.map(({ alertLevel: level }) => level));
  const profile = context.profile ?? resolveSignalProfile({
    fundingOneHour: context.fundingOneHour,
    hotRank: context.hotRank,
    multiCycleCount: intervalStates.length,
    alertLevel,
    oiSpike: context.oiSpike
  });
  const oiWindows = [
    context.oiSpike5mHit ? "5m" : null,
    context.oiSpike1hHit ? "1h" : null,
    context.oiSpike4hHit ? "4h" : null,
    context.oiSpike1dHit ? "1d" : null
  ].filter(Boolean);
  const intervalSignature = intervalStates
    .map(({ intervalCode, alertLevel: level }) => `${intervalCode}:${level}`)
    .join(",");
  const sourceMask = Number(profile.sourceMask ?? 0);
  const profileKey = String(profile.key ?? "");
  const contextSignature = [
    `profile=${profileKey}`,
    `level=${alertLevel ?? "none"}`,
    `sources=${sourceMask}`,
    `funding=${context.fundingOneHour ? 1 : 0}`,
    `hot=${context.hotRank ? 1 : 0}`,
    `oi=${context.oiSpike ? 1 : 0}`,
    `oiWindows=${oiWindows.join(",") || "none"}`,
    `intervals=${intervalSignature || "none"}`
  ].join(";");

  return {
    profileKey,
    sourceMask,
    contextSignature,
    intervalSignature,
    alertLevel
  };
}

export function shouldSendHotMaSignalAlert({
  previousAlert,
  previousSignalLevel = null,
  signal,
  signalChanged = false,
  alertState
}) {
  const currentLevel = normalizeAlertLevel(signal?.alertLevel);
  if (!currentLevel) return false;
  if (!previousAlert) return true;
  if (signalChanged && isAlertLevelEntryOrUpgrade(previousSignalLevel, currentLevel)) return true;
  if (previousAlert.alertLevel !== currentLevel && isAlertLevelEntryOrUpgrade(previousAlert.alertLevel, currentLevel)) {
    return true;
  }
  if (!hasComparableHotMaAlertState(previousAlert)) return false;
  return hasNewHotMaAlertEntry(previousAlert, alertState);
}

export function shouldBackfillHotMaSignalAlertState(previousAlert) {
  return Boolean(previousAlert && !hasComparableHotMaAlertState(previousAlert));
}

export function shouldRefreshHotMaSignalAlertState(previousAlert, alertState = {}) {
  if (!previousAlert || !alertState?.contextSignature) return false;
  if (!hasComparableHotMaAlertState(previousAlert)) return true;
  return (
    String(previousAlert.profileKey) !== String(alertState.profileKey ?? "") ||
    Number(previousAlert.sourceMask ?? 0) !== Number(alertState.sourceMask ?? 0) ||
    String(previousAlert.contextSignature) !== String(alertState.contextSignature)
  );
}

export function shouldSuppressHotMaSignalAfterOiAlert(context = {}) {
  return Boolean(context?.oiSpike && (context.oiLastSpikeAlertAt || context.oiAlertPending));
}

function normalizeCrawlerToken(token) {
  if (!token) return token;
  const baseAsset = token.base_asset ?? token.baseAsset ?? "";
  const categoryType = token.category_type ?? token.categoryType ?? null;
  const categoryLabel = token.category_label ?? token.categoryLabel ?? "";
  return {
    ...token,
    base_asset: baseAsset,
    baseAsset,
    category_type: categoryType,
    categoryType,
    category_label: categoryLabel,
    categoryLabel
  };
}

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
      clearRecoveredNetworkError();
    },
    shouldContinue: shouldContinue ?? (() => crawlerState.running)
  });
  return fetchedRows;
}

async function runConcurrent(items, concurrency, worker) {
  const safeConcurrency = Math.max(1, Math.min(items.length || 1, Number(concurrency) || 1));
  let cursor = 0;
  await Promise.all(
    Array.from({ length: safeConcurrency }, async (_, workerIndex) => {
      while (cursor < items.length) {
        const itemIndex = cursor;
        cursor += 1;
        await worker(items[itemIndex], workerIndex + 1);
      }
    })
  );
}

export function getCrawlerState() {
  return { ...crawlerState, tailRefresh: { ...crawlerState.tailRefresh }, dailyAudit: { ...auditState } };
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
  if (crawlerState.running) {
    return {
      skipped: true,
      reason: "抓取服务正在运行，跳过本次 K 线审计，避免重复入队",
      crawlerRunning: true,
      runMode: crawlerState.runMode,
      runStartedAt: crawlerState.runStartedAt,
      processedTokenCount: crawlerState.processedTokenCount
    };
  }
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
    if (deficientSymbols.length > 0) {
      await startCrawler({
        mode: "repair",
        reason: "K线完整性审计修复",
        includeIncremental: false
      });
    } else if (!crawlerState.running) {
      crawlerState.lastAction = "K线完整性审计完成，未发现需要修复的缺口";
    }
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
  token = normalizeCrawlerToken(token);
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
  const telegramContext = {
    multiCycleCount: multiCycleSignals.length,
    multiCycleIntervals: multiCycleSignals.map(({ intervalCode }) => intervalCode)
  };
  await recordMultiCycleHistory(token, computedSignals, 3);

  const newAlertSignals = computedSignals.filter(
    ({ previous, signal }) =>
      ["LEVEL1", "LEVEL2"].includes(signal.alertLevel) && previous?.alert_level !== signal.alertLevel
  );

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
  telegramContext.oiLastSpikeAlertAt = correlation.oiLastSpikeAlertAt;
  telegramContext.oiAlertPending = correlation.oiAlertPending;
  telegramContext.alertLevel = bestAlertLevel;
  telegramContext.profile = profile;
  if (multiCycleSignals.length > 0 && profile.sourceMask > 0) {
    if (hotMaAlertingSymbols.has(token.symbol)) return;
    hotMaAlertingSymbols.add(token.symbol);
    try {
      const alertState = buildHotMaSignalAlertState(multiCycleSignals, telegramContext);
      const changedIntervals = new Set(newAlertSignals.map(({ intervalCode }) => intervalCode));
      const alertStates = await Promise.all(
        multiCycleSignals.map(async ({ intervalCode, previous, signal }) => {
          const previousAlert = await selectHotMaSignalAlert(token.symbol, intervalCode);
          return {
            shouldSend: shouldSendHotMaSignalAlert({
              previousAlert,
              previousSignalLevel: previous?.alert_level,
              signal,
              signalChanged: changedIntervals.has(intervalCode),
              alertState
            }),
            shouldRefresh: shouldRefreshHotMaSignalAlertState(previousAlert, alertState)
          };
        })
      );
      if (alertStates.some(({ shouldSend }) => shouldSend)) {
        if (shouldSuppressHotMaSignalAfterOiAlert(telegramContext)) {
          await Promise.all(
            multiCycleSignals.map(({ intervalCode, signal }) =>
              markHotMaSignalAlertSent(token.symbol, intervalCode, signal, alertState)
            )
          );
        } else {
          const representative = multiCycleSignals.find(({ signal }) => signal.alertLevel === bestAlertLevel)
            ?? multiCycleSignals[0];
          const result = await sendHotMaSignalTelegram(token, representative.signal, telegramContext);
          if (!result.skipped) {
            await Promise.all(
              multiCycleSignals.map(({ intervalCode, signal }) =>
                markHotMaSignalAlertSent(token.symbol, intervalCode, signal, alertState)
              )
            );
          }
        }
      } else if (alertStates.some(({ shouldRefresh }) => shouldRefresh)) {
        await Promise.all(
          multiCycleSignals.map(({ intervalCode, signal }) =>
            markHotMaSignalAlertSent(token.symbol, intervalCode, signal, { ...alertState, preserveSentAt: true })
          )
        );
      }
    } finally {
      hotMaAlertingSymbols.delete(token.symbol);
    }
  }
}

async function fetchToken(token, workerId) {
  token = normalizeCrawlerToken(token);
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
    clearCrawlerError();
    crawlerState.lastAction = `${token.symbol} 四周期缓存与信号计算完成`;
  }
}

async function refreshTokenInterval(token, intervalCode, { maxGapPasses = 25, shouldContinue = () => true } = {}) {
  token = normalizeCrawlerToken(token);
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
    latestStats.minOpenTime > targetStartTime
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

export async function refreshLatestKlineTails({ force = false, shouldContinue = () => true } = {}) {
  if (!config.crawler.tailRefreshEnabled && !force) {
    return { skipped: true, reason: "tail refresh disabled" };
  }
  if (crawlerState.tailRefresh.running) {
    return { skipped: true, reason: "tail refresh already running", ...crawlerState.tailRefresh };
  }

  crawlerState.tailRefresh.running = true;
  crawlerState.tailRefresh.lastStartedAt = new Date().toISOString();
  crawlerState.tailRefresh.lastCompletedAt = null;
  crawlerState.tailRefresh.targetCount = 0;
  crawlerState.tailRefresh.tokenCount = 0;
  crawlerState.tailRefresh.refreshedRows = 0;
  crawlerState.tailRefresh.errorCount = 0;
  crawlerState.tailRefresh.lastError = null;
  crawlerState.tailRefresh.lastErrorAt = null;

  try {
    const targets = await listKlineTailRefreshTargets({ limit: config.crawler.tailRefreshLimit });
    const bySymbol = new Map();
    for (const target of targets) {
      if (!bySymbol.has(target.symbol)) {
        bySymbol.set(target.symbol, normalizeCrawlerToken({
          id: target.id,
          symbol: target.symbol,
          baseAsset: target.baseAsset,
          categoryType: target.categoryType,
          categoryLabel: target.categoryLabel,
          intervals: []
        }));
      }
      bySymbol.get(target.symbol).intervals.push(target);
    }
    const groups = [...bySymbol.values()];
    crawlerState.tailRefresh.targetCount = targets.length;
    crawlerState.tailRefresh.tokenCount = groups.length;
    if (!groups.length) {
      crawlerState.lastAction = "快速追最新K线完成，所有活跃交易对已是最新";
      return { ok: true, targetCount: 0, tokenCount: 0, refreshedRows: 0, errorCount: 0 };
    }

    let refreshedRows = 0;
    let errorCount = 0;
    const errors = [];
    await runConcurrent(groups, config.crawler.concurrentTokens, async (token, workerId) => {
      const activityId = `tail-${workerId}`;
      let tokenRows = 0;
      setWorkerActivity(activityId, token);
      try {
        for (const target of token.intervals) {
          if (!shouldContinue()) break;
          const ms = intervalMs(target.intervalCode);
          const startTime = target.latestOpenTime === null
            ? Math.max(0, Number(target.targetEndTime) - (config.crawler.tailRefreshKlineLimit - 1) * ms)
            : Math.min(Number(target.latestOpenTime) + ms, Number(target.targetEndTime));
          const endTime = Number(target.targetEndTime);
          if (!Number.isFinite(startTime) || !Number.isFinite(endTime) || startTime > endTime) continue;

          setWorkerActivity(activityId, token, target.intervalCode);
          try {
            const rows = await fetchKlineRange({
              token,
              intervalCode: target.intervalCode,
              startTime,
              endTime,
              limit: config.crawler.tailRefreshKlineLimit,
              action: `${token.symbol} ${target.intervalCode} 快速追最新K线`,
              shouldContinue
            });
            tokenRows += rows;
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            errorCount += 1;
            errors.push(`${token.symbol} ${target.intervalCode}: ${message}`);
            crawlerState.tailRefresh.errorCount = errorCount;
            crawlerState.tailRefresh.lastError = message;
            crawlerState.tailRefresh.lastErrorAt = new Date().toISOString();
            setCrawlerError(message);
          }
        }
        if (tokenRows > 0) {
          await withRetryableDatabaseOperation(`${token.symbol} 快速追尾信号刷新`, async () => {
            await refreshTokenFetchState(token.id);
            await recomputeAndNotifyToken(token);
          });
          refreshedRows += tokenRows;
          crawlerState.tailRefresh.refreshedRows = refreshedRows;
        }
      } finally {
        setWorkerActivity(activityId, null);
      }
    });

    crawlerState.tailRefresh.refreshedRows = refreshedRows;
    crawlerState.tailRefresh.errorCount = errorCount;
    crawlerState.tailRefresh.lastError = errors.at(-1) ?? null;
    if (!crawlerState.tailRefresh.lastError) crawlerState.tailRefresh.lastErrorAt = null;
    crawlerState.lastAction = `快速追最新K线完成：${groups.length} 个交易对，写入/更新 ${refreshedRows} 行`;
    return {
      ok: true,
      targetCount: targets.length,
      tokenCount: groups.length,
      refreshedRows,
      errorCount,
      errors: errors.slice(-20)
    };
  } finally {
    crawlerState.tailRefresh.running = false;
    crawlerState.tailRefresh.lastCompletedAt = new Date().toISOString();
  }
}

export async function refreshKlineCacheForSymbol(symbol, intervalCode) {
  if (!INTERVALS.includes(intervalCode)) {
    return { ok: false, reason: "invalid interval" };
  }
  const token = normalizeCrawlerToken(await getActiveTokenBySymbol(symbol));
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

async function runCrawlerWorker(workerId, { incrementalCutoffAt = null } = {}) {
  while (crawlerState.running) {
    const token = await claimNextTokenForFetch({ incrementalCutoffAt });
    if (!token) return;

    try {
      await withRetryableDatabaseOperation(`${token.symbol} 抓取`, () => fetchToken(token, workerId));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setCrawlerError(message);
      crawlerState.lastAction = `${token.symbol} 抓取中断，保留断点`;
      await markTokenPartial(token.id, message);
    } finally {
      crawlerState.processedTokenCount += 1;
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

export async function startCrawler({ mode = "incremental", reason = null, includeIncremental = true } = {}) {
  if (crawlerState.running) return crawlerState;
  const runStartedAt = new Date();
  const incrementalCutoffAt = includeIncremental
    ? new Date(runStartedAt.getTime() - config.crawler.incrementalRefreshMs)
    : null;
  crawlerState.running = true;
  crawlerState.startedAt = crawlerState.startedAt ?? Date.now();
  crawlerState.runMode = mode;
  crawlerState.runReason = reason;
  crawlerState.runStartedAt = runStartedAt.toISOString();
  crawlerState.runCompletedAt = null;
  crawlerState.incrementalCutoffAt = incrementalCutoffAt?.toISOString() ?? null;
  crawlerState.includeIncremental = Boolean(includeIncremental);
  crawlerState.processedTokenCount = 0;
  clearCrawlerError();
  crawlerState.workerCount = config.crawler.concurrentTokens;

  queueMicrotask(async () => {
    try {
      const restoredFetchingCount = await resetInterruptedFetchingTokens(0);
      if (restoredFetchingCount > 0) {
        crawlerState.lastAction = `已恢复 ${restoredFetchingCount} 个上轮中断的抓取任务`;
      }
      if (!crawlerState.initializedTokens) {
        try {
          await initializeTokenUniverse();
        } catch (error) {
          const activeCount = await countActiveTokens();
          if (activeCount === 0) throw error;
          crawlerState.initializedTokens = true;
          crawlerState.tokenUniverseCount = activeCount;
          setCrawlerError(error instanceof Error ? error.message : String(error));
          crawlerState.lastAction = `同步交易对失败，使用本地 ${activeCount} 个活跃交易对继续增量抓取`;
        }
      }
      if (includeIncremental) {
        await refreshLatestKlineTails({ shouldContinue: () => crawlerState.running });
      }
      const workerCount = Math.max(1, config.crawler.concurrentTokens);
      await Promise.all(
        Array.from({ length: workerCount }, (_, index) =>
          runCrawlerWorker(index + 1, { incrementalCutoffAt })
        )
      );
      if (crawlerState.running) {
        crawlerState.lastAction = includeIncremental
          ? "本轮增量刷新已完成"
          : "本轮K线缺口修复已完成";
      }
      crawlerState.currentSymbol = null;
      crawlerState.currentInterval = null;
      crawlerState.activeTokens = [];
      activeWorkers.clear();
      crawlerState.running = false;
      crawlerState.runMode = "idle";
      crawlerState.runCompletedAt = new Date().toISOString();
      crawlerState.includeIncremental = false;
      crawlerState.incrementalCutoffAt = null;
    } catch (error) {
      setCrawlerError(error instanceof Error ? error.message : String(error));
      crawlerState.lastAction = "抓取服务异常停止";
      await resetInterruptedFetchingTokens(0);
      crawlerState.currentSymbol = null;
      crawlerState.currentInterval = null;
      crawlerState.activeTokens = [];
      activeWorkers.clear();
      crawlerState.running = false;
      crawlerState.runMode = "idle";
      crawlerState.runCompletedAt = new Date().toISOString();
      crawlerState.includeIncremental = false;
      crawlerState.incrementalCutoffAt = null;
    }
  });

  return crawlerState;
}

export function stopCrawler() {
  crawlerState.running = false;
  crawlerState.runMode = "idle";
  crawlerState.runCompletedAt = new Date().toISOString();
  crawlerState.includeIncremental = false;
  crawlerState.incrementalCutoffAt = null;
  crawlerState.lastAction = "抓取服务已手动暂停";
  return crawlerState;
}
