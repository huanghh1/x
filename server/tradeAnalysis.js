import { readTradeEventHistoryAnalysis, upsertTradeEventHistory } from "./db.js";
import { enrichRowsWithMarketMetadata } from "./marketMetadata.js";
import { fetchBinanceEvents, fetchBinancePositionSource } from "./tradeAnalysis/binanceProvider.js";
import { fetchHyperliquidEvents, fetchHyperliquidPositionSource } from "./tradeAnalysis/hyperliquidProvider.js";
import {
  errorSource,
  normalizeWindow,
  retryTransient,
  SOURCE_LABELS,
  sourceConnectionStatus,
  symbolMatchesValue,
  toNumber,
  uniqueById
} from "./tradeAnalysis/shared.js";

const TRADE_ANALYSIS_CACHE_MS = 60 * 1000;
const tradeAnalysisCache = new Map();
const tradePositionCache = new Map();

function snapshotSourceResults(connectionStatus = []) {
  return connectionStatus.map((connection) => ({
    id: connection.id,
    label: connection.label,
    configured: connection.configured,
    ok: connection.configured,
    missing: connection.missing ?? [],
    error: connection.configured ? "" : `缺少 ${(connection.missing ?? []).join("、")}`,
    eventCount: 0,
    positionCount: 0,
    rangeNote: connection.configured ? "先显示本地数据库记录，后台同步最新数据。" : ""
  }));
}

function positionCacheKey(safeSymbol = "") {
  return safeSymbol || "__all__";
}

function positionCacheTtlMs(config) {
  const configured = Number(config?.tradeAnalysis?.positionCacheMs);
  return Number.isFinite(configured) && configured > 0 ? configured : 5 * 60 * 1000;
}

function publicSourceResult(source = {}) {
  const { events: _events, positions: _positions, ...rest } = source;
  return rest;
}

function positionOnlySourceResult(source = {}, positions = [], cachedAt = Date.now()) {
  return {
    ...publicSourceResult(source),
    eventCount: 0,
    positionCount: positions.length,
    rangeNote: source.configured === false
      ? source.rangeNote || ""
      : `后台预抓取仓位缓存，时间 ${new Date(cachedAt).toISOString()}`,
    events: [],
    positions
  };
}

function rememberTradePositionSnapshot({ safeSymbol = "", sourceResults = [], positions = [], cachedAt = Date.now() } = {}) {
  const key = positionCacheKey(safeSymbol);
  tradePositionCache.set(key, {
    cachedAt,
    sourceResults: sourceResults.map((source) => ({
      ...publicSourceResult(source),
      events: [],
      positions: Array.isArray(source.positions) ? source.positions : []
    })),
    positions: Array.isArray(positions) ? positions : []
  });
}

function cachedTradePositionSnapshot(config, { safeSymbol = "" } = {}) {
  const now = Date.now();
  const ttlMs = positionCacheTtlMs(config);
  const exact = tradePositionCache.get(positionCacheKey(safeSymbol));
  const fallback = safeSymbol ? tradePositionCache.get(positionCacheKey("")) : null;
  const cached = [exact, fallback].find((item) => item && now - item.cachedAt <= ttlMs);
  if (!cached) return null;
  const positions = cached.positions
    .filter((position) => symbolMatchesValue(position.symbol, safeSymbol))
    .sort((a, b) => Math.abs(toNumber(b.notional)) - Math.abs(toNumber(a.notional)));
  const sourceResults = cached.sourceResults.map((source) => {
    const sourcePositions = positions.filter((position) => position.source === source.id);
    return positionOnlySourceResult(source, sourcePositions, cached.cachedAt);
  });
  return {
    cachedAt: cached.cachedAt,
    positions,
    sourceResults,
    meta: {
      cached: true,
      updatedAt: new Date(cached.cachedAt).toISOString(),
      ageSeconds: Math.max(0, Math.round((now - cached.cachedAt) / 1000)),
      ttlSeconds: Math.round(ttlMs / 1000)
    }
  };
}

function emptyGroup(source, symbol) {
  return {
    source: source ?? "",
    sourceLabel: source ? SOURCE_LABELS[source] : "全部",
    symbol: symbol ?? "",
    firstTime: null,
    lastTime: null,
    events: 0,
    realizedPnl: 0,
    funding: 0,
    commission: 0,
    feeCost: 0,
    net: 0,
    notional: 0
  };
}

function addEvent(group, event) {
  group.events += 1;
  if (event.pnlIncluded !== false) {
    group.realizedPnl += toNumber(event.realizedPnl);
    group.funding += toNumber(event.funding);
    group.commission += toNumber(event.commission);
    group.feeCost += Math.abs(Math.min(0, toNumber(event.commission)));
    group.net += toNumber(event.realizedPnl) + toNumber(event.funding) + toNumber(event.commission);
    group.notional += toNumber(event.notional);
  }
  if (event.time) {
    group.firstTime = group.firstTime ? Math.min(group.firstTime, event.time) : event.time;
    group.lastTime = group.lastTime ? Math.max(group.lastTime, event.time) : event.time;
  }
}

function groupLastActivityTime(group) {
  return toNumber(group.lastTime ?? group.firstTime, 0);
}

function compareSymbolGroupsByTimeDesc(a, b) {
  return groupLastActivityTime(b) - groupLastActivityTime(a) ||
    toNumber(b.firstTime, 0) - toNumber(a.firstTime, 0) ||
    String(a.source ?? "").localeCompare(String(b.source ?? "")) ||
    String(a.symbol ?? "").localeCompare(String(b.symbol ?? ""));
}

function summarize(events, sources) {
  const totals = emptyGroup(null, null);
  const sourceMap = new Map(sources.map((source) => [source.id, emptyGroup(source.id, null)]));
  const symbolMap = new Map();
  for (const event of events) {
    addEvent(totals, event);
    const sourceGroup = sourceMap.get(event.source) ?? emptyGroup(event.source, null);
    addEvent(sourceGroup, event);
    sourceMap.set(event.source, sourceGroup);
    const symbolKey = `${event.source}:${event.symbol}`;
    const symbolGroup = symbolMap.get(symbolKey) ?? emptyGroup(event.source, event.symbol);
    addEvent(symbolGroup, event);
    symbolMap.set(symbolKey, symbolGroup);
  }
  return {
    totals,
    bySource: Array.from(sourceMap.values()),
    bySymbol: Array.from(symbolMap.values()).sort(compareSymbolGroupsByTimeDesc)
  };
}

function mergeSourceSummaries(sourceSummaries = [], sources = []) {
  const summaryBySource = new Map(sourceSummaries.map((item) => [item.source, item]));
  for (const source of sources) {
    if (!source?.id || summaryBySource.has(source.id)) continue;
    summaryBySource.set(source.id, emptyGroup(source.id, null));
  }
  return Array.from(summaryBySource.values()).sort((a, b) =>
    groupLastActivityTime(b) - groupLastActivityTime(a) ||
    String(a.source ?? "").localeCompare(String(b.source ?? ""))
  );
}

function paginateSymbolSummary(summary, { page = 1, pageSize = 20 } = {}) {
  const safePage = Math.max(1, Number(page) || 1);
  const safePageSize = Math.max(1, Math.min(100, Number(pageSize) || 20));
  const rows = Array.isArray(summary?.bySymbol) ? summary.bySymbol : [];
  const total = rows.length;
  const totalPages = Math.max(1, Math.ceil(total / safePageSize));
  const effectivePage = Math.min(safePage, totalPages);
  return {
    summary: {
      ...summary,
      bySymbol: rows.slice((effectivePage - 1) * safePageSize, effectivePage * safePageSize)
    },
    symbolSummary: {
      total,
      page: effectivePage,
      pageSize: safePageSize
    }
  };
}

function emptyTradeHistory(sourceResults = [], { page = 1, pageSize = 20, persistError = "" } = {}) {
  const summary = summarize([], sourceResults);
  const pageResult = paginateSymbolSummary(summary, { page, pageSize });
  return {
    ...pageResult,
    events: [],
    eventCount: 0,
    persisted: !persistError,
    persistError
  };
}

async function tradeHistoryAnalysisOrFallback({ tradeEvents, sourceResults, window, symbol, page, pageSize, eventLimit }) {
  try {
    await upsertTradeEventHistory(tradeEvents);
    const history = await readTradeEventHistoryAnalysis({
      startMs: window.startMs,
      endMs: window.endMs,
      symbol,
      page,
      pageSize,
      eventLimit
    });
    return {
      ...history,
      summary: {
        ...history.summary,
        bySource: mergeSourceSummaries(history.summary.bySource, sourceResults)
      },
      persisted: true,
      persistError: ""
    };
  } catch (error) {
    const summary = summarize(tradeEvents, sourceResults);
    const pageResult = paginateSymbolSummary(summary, { page, pageSize });
    return {
      ...pageResult,
      events: tradeEvents.slice(0, eventLimit),
      eventCount: tradeEvents.length,
      persisted: false,
      persistError: error instanceof Error ? error.message : String(error)
    };
  }
}

function summarizePositions(positions, sources) {
  const totals = {
    count: positions.length,
    notional: 0,
    unrealizedPnl: 0,
    bySource: sources.map((source) => ({
      source: source.id,
      sourceLabel: SOURCE_LABELS[source.id],
      count: 0,
      notional: 0,
      unrealizedPnl: 0
    }))
  };
  const sourceMap = new Map(totals.bySource.map((item) => [item.source, item]));
  for (const position of positions) {
    const notional = Math.abs(toNumber(position.notional));
    const unrealizedPnl = toNumber(position.unrealizedPnl);
    totals.notional += notional;
    totals.unrealizedPnl += unrealizedPnl;
    const sourceGroup = sourceMap.get(position.source);
    if (sourceGroup) {
      sourceGroup.count += 1;
      sourceGroup.notional += notional;
      sourceGroup.unrealizedPnl += unrealizedPnl;
    }
  }
  return totals;
}

function currentPositionEvent(position) {
  return {
    id: `${position.id}:current-position`,
    source: position.source,
    sourceLabel: position.sourceLabel,
    symbol: position.symbol || "--",
    asset: position.asset || "USDT",
    time: position.updatedAt ?? null,
    type: "OPEN_POSITION",
    side: position.side || "",
    direction: "Current Open",
    positionSide: position.side || "",
    quantity: position.quantity,
    price: position.entryPrice,
    markPrice: position.markPrice,
    notional: position.notional,
    fundingRate: null,
    realizedPnl: 0,
    unrealizedPnl: toNumber(position.unrealizedPnl),
    funding: 0,
    commission: 0,
    feeAsset: position.asset || "USDT",
    net: toNumber(position.unrealizedPnl),
    orderId: "",
    tradeId: "",
    liquidity: "",
    note: "当前未平仓，未实现盈亏不计入已实现收益",
    pnlIncluded: false,
    rawType: "CURRENT_POSITION"
  };
}

function normalizeTradeAnalysisMode(value) {
  const mode = String(value ?? "").trim().toLowerCase();
  return ["snapshot", "history", "local"].includes(mode) ? "snapshot" : "refresh";
}

async function buildTradeAnalysisPayload({
  window,
  safeSymbol,
  connectionStatus,
  sourceResults,
  history,
  positions,
  positionSnapshot,
  maxEventRows,
  mode
}) {
  const rawPositions = Array.isArray(positions) ? positions : [];
  const [safePositions, symbolRows] = await Promise.all([
    enrichRowsWithMarketMetadata(rawPositions),
    enrichRowsWithMarketMetadata(history?.summary?.bySymbol ?? [])
  ]);
  const summary = {
    ...history.summary,
    bySymbol: symbolRows
  };
  const historyEvents = Array.isArray(history?.events) ? history.events : [];
  const events = uniqueById([...historyEvents, ...safePositions.map(currentPositionEvent)])
    .sort((a, b) => (b.time ?? 0) - (a.time ?? 0));
  const positionSummary = summarizePositions(safePositions, sourceResults);
  return {
    ok: true,
    mode,
    snapshot: mode === "snapshot",
    generatedAt: new Date().toISOString(),
    window: {
      startTime: new Date(window.startMs).toISOString(),
      endTime: new Date(window.endMs).toISOString()
    },
    symbol: safeSymbol,
    connections: connectionStatus,
    sources: sourceResults.map(({ events: _events, positions: _positions, ...source }) => source),
    summary,
    symbolSummary: history.symbolSummary,
    tradeRows: {
      items: summary.bySymbol,
      total: history.symbolSummary.total,
      page: history.symbolSummary.page,
      pageSize: history.symbolSummary.pageSize
    },
    positionSummary,
    positions: safePositions,
    positionSnapshot: positionSnapshot ?? null,
    persistence: {
      enabled: history.persisted,
      error: history.persisted ? "" : history.persistError
    },
    eventCount: history.eventCount + safePositions.length,
    eventLimit: maxEventRows,
    events: events.slice(0, maxEventRows)
  };
}

export async function refreshTradePositionCache(config, { symbol = "" } = {}) {
  const safeSymbol = String(symbol ?? "").trim().toUpperCase().replace(/[^A-Z0-9:_-]/g, "");
  const fetchers = [
    ["binance", () => fetchBinancePositionSource(config, safeSymbol)],
    ["hyperliquid", () => fetchHyperliquidPositionSource(config, safeSymbol)]
  ];
  const sourceResults = await Promise.all(fetchers.map(async ([id, run]) => {
    try {
      return await retryTransient(run);
    } catch (error) {
      return errorSource(id, error);
    }
  }));
  const positions = sourceResults
    .flatMap((source) => source.positions ?? [])
    .filter((position) => symbolMatchesValue(position.symbol, safeSymbol))
    .filter((position, index, all) => all.findIndex((item) => item.id === position.id) === index)
    .sort((a, b) => Math.abs(toNumber(b.notional)) - Math.abs(toNumber(a.notional)));
  const cachedAt = Date.now();
  rememberTradePositionSnapshot({ safeSymbol, sourceResults, positions, cachedAt });
  return {
    ok: true,
    generatedAt: new Date(cachedAt).toISOString(),
    symbol: safeSymbol,
    sources: sourceResults.map(publicSourceResult),
    positionSummary: summarizePositions(positions, sourceResults),
    positions
  };
}

export function startTradePositionPrefetch(config, { logger = console } = {}) {
  const settings = config?.tradeAnalysis ?? {};
  if (settings.positionPrefetchEnabled === false) {
    return { started: false, stop() {}, runNow() { return Promise.resolve(null); } };
  }
  const intervalMs = Math.max(10_000, Number(settings.positionPrefetchIntervalMs) || 60_000);
  const initialDelayMs = Math.max(0, Number(settings.positionPrefetchInitialDelayMs) || 0);
  let stopped = false;
  let running = false;

  async function runNow() {
    if (stopped || running) return null;
    running = true;
    try {
      return await refreshTradePositionCache(config);
    } catch (error) {
      logger.error?.("trade position prefetch failed", error);
      return null;
    } finally {
      running = false;
    }
  }

  const initialTimer = setTimeout(() => {
    void runNow();
  }, initialDelayMs);
  const intervalTimer = setInterval(() => {
    void runNow();
  }, intervalMs);
  initialTimer.unref?.();
  intervalTimer.unref?.();

  return {
    started: true,
    runNow,
    stop() {
      stopped = true;
      clearTimeout(initialTimer);
      clearInterval(intervalTimer);
    }
  };
}

export async function getTradeAnalysis(config, { start, end, symbol, page = 1, pageSize = 20, mode } = {}) {
  const window = normalizeWindow({ start, end, defaultLookbackDays: config.tradeAnalysis.defaultLookbackDays });
  const safeSymbol = String(symbol ?? "").trim().toUpperCase().replace(/[^A-Z0-9:_-]/g, "");
  const safePage = Math.max(1, Number(page) || 1);
  const safePageSize = Math.max(1, Math.min(100, Number(pageSize) || 20));
  const analysisMode = normalizeTradeAnalysisMode(mode);
  const connectionStatus = sourceConnectionStatus(config);

  if (analysisMode === "snapshot") {
    const cachedPositions = cachedTradePositionSnapshot(config, { safeSymbol });
    const sourceResults = cachedPositions?.sourceResults ?? snapshotSourceResults(connectionStatus);
    let history;
    try {
      history = await readTradeEventHistoryAnalysis({
        startMs: window.startMs,
        endMs: window.endMs,
        symbol: safeSymbol,
        page: safePage,
        pageSize: safePageSize,
        eventLimit: config.tradeAnalysis.maxEventRows
      });
    } catch (error) {
      history = emptyTradeHistory(sourceResults, {
        page: safePage,
        pageSize: safePageSize,
        persistError: error instanceof Error ? error.message : String(error)
      });
    }
    const snapshotHistory = {
      ...history,
      summary: {
        ...history.summary,
        bySource: mergeSourceSummaries(history.summary.bySource, sourceResults)
      },
      persisted: history.persisted !== false,
      persistError: history.persistError ?? ""
    };
    return await buildTradeAnalysisPayload({
      window,
      safeSymbol,
      connectionStatus,
      sourceResults,
      history: snapshotHistory,
      positions: cachedPositions?.positions ?? [],
      positionSnapshot: cachedPositions?.meta ?? null,
      maxEventRows: config.tradeAnalysis.maxEventRows,
      mode: "snapshot"
    });
  }

  const cacheKey = JSON.stringify({
    start: start ?? "",
    end: end ?? "",
    symbol: safeSymbol
  });
  const cached = tradeAnalysisCache.get(cacheKey);
  const cachedSync = cached && Date.now() - cached.cachedAt < TRADE_ANALYSIS_CACHE_MS ? cached : null;

  let sourceResults;
  let tradeEvents;
  let positions;
  let positionSnapshot;
  if (cachedSync) {
    sourceResults = cachedSync.sourceResults;
    tradeEvents = cachedSync.tradeEvents;
    positions = cachedSync.positions;
    positionSnapshot = {
      cached: true,
      updatedAt: new Date(cachedSync.cachedAt).toISOString(),
      ageSeconds: Math.max(0, Math.round((Date.now() - cachedSync.cachedAt) / 1000)),
      ttlSeconds: Math.round(TRADE_ANALYSIS_CACHE_MS / 1000)
    };
  } else {
    const fetchers = [
      ["binance", () => fetchBinanceEvents(config, window, safeSymbol)],
      ["hyperliquid", () => fetchHyperliquidEvents(config, window, safeSymbol)]
    ];
    sourceResults = await Promise.all(fetchers.map(async ([id, run]) => {
      try {
        return await retryTransient(run);
      } catch (error) {
        return errorSource(id, error);
      }
    }));
    tradeEvents = sourceResults
      .flatMap((source) => source.events)
      .filter((event) => event.time === null || (event.time >= window.startMs && event.time <= window.endMs))
      .sort((a, b) => (b.time ?? 0) - (a.time ?? 0));
    positions = sourceResults
      .flatMap((source) => source.positions ?? [])
      .filter((position, index, all) => all.findIndex((item) => item.id === position.id) === index)
      .sort((a, b) => Math.abs(toNumber(b.notional)) - Math.abs(toNumber(a.notional)));
    const positionsFetchedAt = Date.now();
    rememberTradePositionSnapshot({ safeSymbol, sourceResults, positions, cachedAt: positionsFetchedAt });
    positionSnapshot = {
      cached: false,
      updatedAt: new Date(positionsFetchedAt).toISOString(),
      ageSeconds: 0,
      ttlSeconds: Math.round(positionCacheTtlMs(config) / 1000)
    };
    const cacheable = sourceResults.every((source) =>
      source.ok &&
      !source.error &&
      !source.tradeError &&
      !source.billError &&
      !source.fillError &&
      !source.orderError &&
      !source.positionError &&
      !source.utaError
    );
    if (cacheable) {
      tradeAnalysisCache.set(cacheKey, { cachedAt: Date.now(), sourceResults, tradeEvents, positions });
      for (const [key, value] of tradeAnalysisCache) {
        if (Date.now() - value.cachedAt >= TRADE_ANALYSIS_CACHE_MS) tradeAnalysisCache.delete(key);
      }
    }
  }

  const history = await tradeHistoryAnalysisOrFallback({
    tradeEvents,
    sourceResults,
    window,
    symbol: safeSymbol,
    page: safePage,
    pageSize: safePageSize,
    eventLimit: config.tradeAnalysis.maxEventRows
  });
  return await buildTradeAnalysisPayload({
    window,
    safeSymbol,
    connectionStatus,
    sourceResults,
    history,
    positions,
    positionSnapshot,
    maxEventRows: config.tradeAnalysis.maxEventRows,
    mode: "refresh"
  });
}
