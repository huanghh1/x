import { discoverTargetTokens, fetchKlinesPaged } from "./binance.js";
import { config } from "./config.js";
import {
  claimNextTokenForFetch,
  countActiveTokens,
  findKlineGap,
  insertKlinePage,
  isActiveHotRankSymbol,
  markHotMaSignalAlertSent,
  klineStats,
  markSignalTelegramSent,
  markTokenFetching,
  markTokenPartial,
  recordMultiCycleHistory,
  refreshTokenFetchState,
  resetInterruptedFetchingTokens,
  selectClosePrices,
  selectHotMaSignalAlert,
  selectPreviousSignal,
  upsertSignal,
  upsertTokens
} from "./db.js";
import { calculateSignal, INTERVALS } from "./ma.js";
import { sendHotMaSignalTelegram, sendSignalTelegram } from "./telegram.js";

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
  return { ...crawlerState };
}

export async function initializeTokenUniverse() {
  const tokens = await discoverTargetTokens();
  const count = await upsertTokens(tokens);
  crawlerState.initializedTokens = true;
  crawlerState.tokenUniverseCount = count;
  crawlerState.lastAction = `已同步 ${count} 个目标交易对`;
  return { count, tokens };
}

async function recomputeAndNotifyToken(token) {
  const computedSignals = [];
  for (const intervalCode of INTERVALS) {
    const closes = await selectClosePrices(token.symbol, intervalCode);
    const signal = calculateSignal({ intervalCode, closes });
    const previous = await selectPreviousSignal(token.symbol, intervalCode);
    await upsertSignal(token, signal);
    computedSignals.push({ intervalCode, previous, signal });
  }

  const multiCycleSignals = computedSignals.filter(({ signal }) => ["LEVEL1", "LEVEL2"].includes(signal.alertLevel));
  const telegramContext = {
    multiCycleCount: multiCycleSignals.length,
    multiCycleIntervals: multiCycleSignals.map(({ intervalCode }) => intervalCode)
  };
  await recordMultiCycleHistory(token, computedSignals, 2);

  for (const { intervalCode, previous, signal } of computedSignals) {
    const hotRankHit = ["LEVEL1", "LEVEL2"].includes(signal.alertLevel) && (await isActiveHotRankSymbol(token.symbol));
    if (hotRankHit) {
      const previousHotAlert = await selectHotMaSignalAlert(token.symbol, intervalCode);
      const previousSignalTime = previousHotAlert?.signalTime ? new Date(previousHotAlert.signalTime).getTime() : 0;
      const signalTime = Number(signal.signalTime ?? 0);
      const shouldSendHotMa =
        !previousHotAlert ||
        previousHotAlert.alertLevel !== signal.alertLevel ||
        Math.abs(previousSignalTime - signalTime) > 1;
      if (shouldSendHotMa) {
        const result = await sendHotMaSignalTelegram(token, signal, telegramContext);
        if (!result.skipped) {
          await markHotMaSignalAlertSent(token.symbol, intervalCode, signal);
          continue;
        }
      }
    }
    const shouldNotify =
      signal.alertLevel === "LEVEL1" &&
      (!previous || previous.alert_level !== signal.alertLevel || !previous.telegram_sent_at);
    if (shouldNotify) {
      const result = await sendSignalTelegram(token, signal, telegramContext);
      if (!result.skipped) await markSignalTelegramSent(token.symbol, intervalCode);
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
    const hasEnoughCoverage = stats.count > 0 && stats.minOpenTime !== null && stats.minOpenTime <= targetStartTime;

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
