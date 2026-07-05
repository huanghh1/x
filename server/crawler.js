import { discoverTargetTokens } from "./binance.js";
import { config } from "./config.js";
import {
  claimNextTokenForFetch,
  cleanupInactiveTokenKlines,
  countActiveTokens,
  getActiveTokenBySymbol,
  getKlineAuditReport,
  listKlineTailRefreshTargets,
  markTokenPartial,
  queueActiveTokensForKlineAudit,
  refreshTokenFetchState,
  resetInterruptedFetchingTokens,
  upsertTokens
} from "./db.js";
import { INTERVALS } from "./ma.js";
import { fetchKlineRange, intervalMs, refreshTokenInterval } from "./crawler/klineRepair.js";
import { recomputeAndNotifyToken } from "./crawler/signalRecompute.js";
import { normalizeCrawlerToken } from "./crawler/tokenUtils.js";

export {
  buildHotMaSignalAlertState,
  shouldBackfillHotMaSignalAlertState,
  shouldRefreshHotMaSignalAlertState,
  shouldSendHotMaSignalAlert,
  shouldSuppressHotMaSignalAfterOiAlert
} from "./crawler/hotMaAlertState.js";

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

function setCrawlerAction(message) {
  crawlerState.lastAction = message;
}

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

async function fetchToken(token, workerId) {
  token = normalizeCrawlerToken(token);
  setWorkerActivity(workerId, token);
  crawlerState.lastAction = `开始处理 ${token.symbol}`;

  for (const intervalCode of INTERVALS) {
    if (!crawlerState.running) break;
    setWorkerActivity(workerId, token, intervalCode);
    await refreshTokenInterval(token, intervalCode, {
      maxGapPasses: config.crawler.maxGapRepairPasses,
      shouldContinue: () => crawlerState.running,
      onAction: setCrawlerAction,
      onRecoveredNetwork: clearRecoveredNetworkError
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
              shouldContinue,
              onAction: setCrawlerAction,
              onRecoveredNetwork: clearRecoveredNetworkError
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
    const onlyTransientNetworkErrors = errors.length > 0 && errors.every((message) => isTransientNetworkError(message));
    if (onlyTransientNetworkErrors && refreshedRows > 0) {
      clearCrawlerError();
    } else if (crawlerState.tailRefresh.lastError) {
      setCrawlerError(crawlerState.tailRefresh.lastError);
    }
    crawlerState.lastAction = errorCount > 0
      ? `快速追最新K线完成：${groups.length} 个交易对，写入/更新 ${refreshedRows} 行，临时失败 ${errorCount} 次`
      : `快速追最新K线完成：${groups.length} 个交易对，写入/更新 ${refreshedRows} 行`;
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
      shouldContinue: () => true,
      onAction: setCrawlerAction,
      onRecoveredNetwork: clearRecoveredNetworkError
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
