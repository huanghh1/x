import express from "express";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Readable } from "node:stream";
import { config } from "./config.js";
import {
  clearTriggerHistory,
  deleteTriggerHistory,
  deleteWatchlistItem,
  ensureDatabase,
  getKlines,
  getHotMaSignalsPage,
  getSignalGroupsPage,
  listMultiCycleHistory,
  listKlineTailRefreshTargets,
  getOverview,
  getSignals,
  getKlineAuditReport,
  getTokenUnlockCache,
  listOneHourFundingIntervals,
  listOpenInterestMonitorPage,
  listTriggerHistory,
  listWatchlist,
  pingDatabase,
  queueSymbolsForKlineRefresh,
  upsertWatchlistItem
} from "./db.js";
import { getHotRank } from "./hotRank.js";
import { cleanupRuntimeLogFiles, RUNTIME_ERROR_LOG_FILES, RUNTIME_LOG_FILES, runtimeLogPath } from "./runtimeLogs.js";
import { telegramState } from "./telegram.js";
import { getTradeAnalysis } from "./tradeAnalysis.js";
import { normalizeCodexScope, prepareCodexTradeAnalysis, runCodexTradeAnalysis } from "./codexTradeAnalysis.js";
import { normalizeTokenInterval, prepareCodexTokenAnalysis } from "./codexTokenAnalysis.js";
import { requestService, serviceStates, serviceUrl } from "./serviceClient.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const app = express();

app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.resolve(__dirname, "../public")));

function isLoopbackAddress(value) {
  const address = String(value ?? "").replace(/^::ffff:/, "");
  return address === "127.0.0.1" || address === "::1" || address === "localhost";
}

function hasLocalOrTokenAccess(request) {
  const configuredToken = config.app.mutationToken;
  if (configuredToken && request.get("X-API-Mutation-Token") === configuredToken) {
    return true;
  }
  return isLoopbackAddress(request.ip) || isLoopbackAddress(request.socket?.remoteAddress);
}

function requireLocalMutation(request, response, next) {
  if (hasLocalOrTokenAccess(request)) {
    next();
    return;
  }
  response.status(403).json({ ok: false, error: "mutating API is only available from localhost" });
}

function requireSensitiveRead(request, response, next) {
  if (hasLocalOrTokenAccess(request)) {
    next();
    return;
  }
  response.status(403).json({ ok: false, error: "sensitive API is only available from localhost" });
}

app.get("/api/health", async (_request, response) => {
  try {
    await pingDatabase();
    const services = await serviceStates();
    response.json({
      ok: true,
      database: "connected",
      services,
      crawler: services.crawler?.crawler ?? null,
      maintenance: services.scheduler?.maintenance ?? null,
      watchRealtime: services.realtime?.watchRealtime ?? null,
      fundingMonitor: services.scheduler?.fundingMonitor ?? null,
      openInterestMonitor: services.scheduler?.openInterestMonitor ?? null,
      telegram: { ...telegramState(), bot: services.scheduler?.telegramBot ?? null },
      now: new Date().toISOString()
    });
  } catch (error) {
    response.status(500).json({
      ok: false,
      database: "disconnected",
      error: error instanceof Error ? error.message : String(error)
    });
  }
});

async function readLogTail(filePath, maxBytes = 240_000) {
  const stat = await fs.stat(filePath);
  const start = Math.max(0, stat.size - maxBytes);
  const handle = await fs.open(filePath, "r");
  try {
    const buffer = Buffer.alloc(stat.size - start);
    await handle.read(buffer, 0, buffer.length, start);
    return {
      text: buffer.toString("utf8"),
      size: stat.size,
      mtime: stat.mtime
    };
  } finally {
    await handle.close();
  }
}

function compactLogEntry(service, rawLines, index) {
  const lines = rawLines.map((line) => line.replace(/^\d+\|[^|]*\|\s?/, "").trim()).filter(Boolean);
  const firstLine = lines[0] ?? "";
  const causeLine = lines.find((line) => /\b(cause|code|errno|syscall|hostname|host):/i.test(line));
  const message = [firstLine, causeLine && causeLine !== firstLine ? causeLine : null].filter(Boolean).join(" | ");
  const severity = /\b(error|failed|timeout|ECONNRESET|ENOTFOUND|UND_ERR|HTTP 4|HTTP 5)\b/i.test(message)
    ? "ERROR"
    : "WARN";
  const category = classifyRuntimeError({ service, message, details: lines.join("\n") });
  return {
    id: `${service}-${index}`,
    service,
    severity,
    category: category.key,
    categoryLabel: category.label,
    message: message.slice(0, 1000),
    details: lines.slice(0, 16).join("\n").slice(0, 3000)
  };
}

function classifyRuntimeError({ service = "", component = "", message = "", details = "" } = {}) {
  const text = `${service} ${component} ${message} ${details}`.toLowerCase();
  if (/(enotfound|eai_again|und_err_connect_timeout|etimedout|econnreset|fetch failed|connect timeout|socket disconnected|tls|dns|getaddrinfo|network)/i.test(text)) {
    return { key: "NETWORK", label: "网络连接" };
  }
  if (/(http 418|http 429|too many requests|rate limit|used-weight)/i.test(text)) {
    return { key: "BINANCE_LIMIT", label: "Binance限频" };
  }
  if (/(binance|fapi\.binance|api\.binance|premium index|klines|open interest|funding info).*http [45]\d\d/i.test(text)) {
    return { key: "BINANCE_HTTP", label: "Binance接口" };
  }
  if (/(telegram|bot|getupdates|sendmessage)/i.test(text)) {
    return { key: "TELEGRAM", label: "Telegram" };
  }
  if (/(mysql|database|sql|deadlock|er_|pool|connection.*refused|lock wait)/i.test(text)) {
    return { key: "DATABASE", label: "数据库" };
  }
  if (/(openinterest|open interest|oi[:\s_-]|open-interest)/i.test(text)) {
    return { key: "OI", label: "OI监控" };
  }
  if (/(funding|资金费率|premium index)/i.test(text)) {
    return { key: "FUNDING", label: "资金费率" };
  }
  if (/(kline|klines|watchlist market|crawler|token universe|crawl)/i.test(text)) {
    return { key: "KLINE", label: "K线抓取" };
  }
  if (/(syntaxerror|typeerror|referenceerror|rangeerror|unhandled|exception)/i.test(text)) {
    return { key: "PROGRAM", label: "程序异常" };
  }
  return { key: "OTHER", label: "其他" };
}

function parsePm2ErrorLog(service, text, limit = 80) {
  const lines = String(text ?? "").split(/\r?\n/).filter(Boolean);
  const entries = [];
  let current = [];
  const normalizeLine = (line) => line.replace(/^\d+\|[^|]*\|\s?/, "").trim();
  const startsEntry = (line) => {
    const normalized = normalizeLine(line);
    if (/^(\[cause\]|at\s|code:|errno:|syscall:|hostname:|host:|port:|localAddress:|path:|})/i.test(normalized)) {
      return false;
    }
    return /(failed|TypeError|Unhandled|Exception|^Error:|HTTP\s+[45]\d\d)/i.test(normalized);
  };
  for (const line of lines) {
    if (startsEntry(line) && current.length) {
      entries.push(compactLogEntry(service, current, entries.length));
      current = [];
    }
    if (startsEntry(line) || current.length) current.push(line);
    if (current.length >= 18) {
      entries.push(compactLogEntry(service, current, entries.length));
      current = [];
    }
  }
  if (current.length) entries.push(compactLogEntry(service, current, entries.length));
  return entries.slice(-limit).reverse();
}

function pushStateError(items, service, component, message, meta = {}) {
  if (!message) return;
  const category = classifyRuntimeError({ service, component, message, details: meta.details ?? "" });
  items.push({
    id: `state-${service}-${component}`,
    service,
    component,
    severity: "ERROR",
    category: category.key,
    categoryLabel: category.label,
    message: String(message).slice(0, 1000),
    updatedAt: meta.updatedAt ?? null,
    details: meta.details ?? ""
  });
}

function runtimeStateErrors(services) {
  const items = [];
  if (services.crawler?.ok === false) pushStateError(items, "crawler", "service", services.crawler.error);
  if (services.realtime?.ok === false) pushStateError(items, "realtime", "service", services.realtime.error);
  if (services.scheduler?.ok === false) pushStateError(items, "scheduler", "service", services.scheduler.error);

  const crawler = services.crawler?.crawler;
  pushStateError(items, "crawler", "crawler", crawler?.lastError, {
    updatedAt: crawler?.startedAt ? new Date(crawler.startedAt).toISOString() : null,
    details: crawler?.lastAction ?? ""
  });
  pushStateError(items, "crawler", "dailyAudit", crawler?.dailyAudit?.lastError, {
    updatedAt: crawler?.dailyAudit?.lastStartedAt ?? null
  });
  pushStateError(items, "crawler", "watchlistMarket", services.crawler?.watchlistMarket?.lastError);

  const realtime = services.realtime?.watchRealtime;
  pushStateError(items, "realtime", "watchRealtime", realtime?.lastError, {
    updatedAt: realtime?.lastMessageAt ?? realtime?.connectedAt ?? null
  });

  const scheduler = services.scheduler ?? {};
  pushStateError(items, "scheduler", "maintenance", scheduler.maintenance?.lastError, {
    updatedAt: scheduler.maintenance?.lastRunAt ?? null
  });
  pushStateError(items, "scheduler", "triggerHistoryCleanup", scheduler.maintenance?.triggerHistoryCleanup?.lastError, {
    updatedAt: scheduler.maintenance?.triggerHistoryCleanup?.lastRunAt ?? null
  });
  pushStateError(items, "scheduler", "runtimeLogCleanup", scheduler.maintenance?.runtimeLogCleanup?.lastError, {
    updatedAt: scheduler.maintenance?.runtimeLogCleanup?.lastRunAt ?? null
  });
  pushStateError(items, "scheduler", "fundingMonitor", scheduler.fundingMonitor?.lastError, {
    updatedAt: scheduler.fundingMonitor?.lastStartedAt ?? null
  });
  pushStateError(items, "scheduler", "openInterestMonitor", scheduler.openInterestMonitor?.lastError, {
    updatedAt: scheduler.openInterestMonitor?.lastStartedAt ?? null,
    details: (scheduler.openInterestMonitor?.errors ?? []).join("\n")
  });
  for (const error of scheduler.openInterestMonitor?.errors ?? []) {
    pushStateError(items, "scheduler", "openInterestToken", error, {
      updatedAt: scheduler.openInterestMonitor?.lastStartedAt ?? null
    });
  }
  for (const error of scheduler.tokenUnlock?.errors ?? []) {
    pushStateError(items, "scheduler", "tokenUnlock", error, {
      updatedAt: scheduler.tokenUnlock?.lastRunAt ?? null
    });
  }
  pushStateError(items, "scheduler", "telegramBot", scheduler.telegramBot?.lastError, {
    updatedAt: scheduler.telegramBot?.lastPollAt ?? null
  });
  return items;
}

app.get("/api/runtime-logs", async (request, response) => {
  try {
    const limit = Math.max(20, Math.min(300, Number(request.query.limit) || 120));
    const services = await serviceStates();
    const stateErrors = runtimeStateErrors(services);
    const logResults = await Promise.all(
      RUNTIME_ERROR_LOG_FILES.map(async ({ service, file }) => {
        const filePath = runtimeLogPath(file);
        try {
          const tail = await readLogTail(filePath);
          return {
            service,
            file,
            fileSize: tail.size,
            updatedAt: tail.mtime.toISOString(),
            entries: parsePm2ErrorLog(service, tail.text, limit)
          };
        } catch (error) {
          if (error?.code === "ENOENT") return { service, file, fileSize: 0, updatedAt: null, entries: [] };
          return {
            service,
            file,
            fileSize: 0,
            updatedAt: null,
            entries: [{
              id: `${service}-log-read`,
              service,
              severity: "ERROR",
              message: `读取日志失败：${error instanceof Error ? error.message : String(error)}`,
              details: ""
            }]
          };
        }
      })
    );
    const logEntries = logResults.flatMap((result) =>
      result.entries.map((entry) => ({
        ...entry,
        file: result.file,
        updatedAt: result.updatedAt,
        source: "pm2"
      }))
    );
    response.json({
      ok: true,
      generatedAt: new Date().toISOString(),
      services,
      files: logResults.map(({ entries, ...file }) => ({ ...file, entryCount: entries.length })),
      stateErrors,
      entries: [...stateErrors.map((entry) => ({ ...entry, source: "state" })), ...logEntries].slice(0, limit)
    });
  } catch (error) {
    console.error("get runtime logs failed", error);
    response.status(500).json({ ok: false, error: error instanceof Error ? error.message : String(error) });
  }
});

app.delete("/api/runtime-logs", requireLocalMutation, async (request, response) => {
  try {
    const requestedFiles = Array.isArray(request.body?.files)
      ? Array.from(new Set(request.body.files.map((file) => String(file ?? "")).filter(Boolean)))
      : [];
    const allowed = new Map(RUNTIME_LOG_FILES.map((item) => [item.file, item]));
    const files = requestedFiles.length
      ? requestedFiles.map((file) => allowed.get(file)).filter(Boolean)
      : RUNTIME_LOG_FILES;
    if (!files.length) {
      response.status(400).json({ ok: false, error: "no valid log files selected" });
      return;
    }
    const result = await cleanupRuntimeLogFiles({ files });
    response.json({ ok: true, ...result });
  } catch (error) {
    console.error("delete runtime logs failed", error);
    response.status(500).json({ ok: false, error: error instanceof Error ? error.message : String(error) });
  }
});

app.post("/api/bootstrap", requireLocalMutation, async (_request, response) => {
  try {
    response.json(await requestService("crawler", "/internal/bootstrap", { method: "POST", body: "{}" }));
  } catch (error) {
    response.status(503).json({ ok: false, error: error instanceof Error ? error.message : String(error) });
  }
});

app.post("/api/crawl/start", requireLocalMutation, async (_request, response) => {
  response.json(await requestService("crawler", "/internal/crawl/start", { method: "POST", body: "{}" }));
});

app.post("/api/crawl/stop", requireLocalMutation, async (_request, response) => {
  response.json(await requestService("crawler", "/internal/crawl/stop", { method: "POST", body: "{}" }));
});

app.post("/api/kline-audit", requireLocalMutation, async (_request, response) => {
  response.json(await requestService("crawler", "/internal/kline/audit", {
    method: "POST",
    body: "{}",
    timeoutMs: 60_000
  }));
});

app.post("/api/kline-tails", requireLocalMutation, async (_request, response) => {
  response.json(await requestService("crawler", "/internal/kline/tails", {
    method: "POST",
    body: "{}",
    timeoutMs: 10 * 60 * 1000
  }));
});

app.get("/api/kline-health", async (_request, response) => {
  try {
    response.json({ ok: true, ...(await getKlineAuditReport(config.crawler.retentionLimits)) });
  } catch (error) {
    console.error("get kline health failed", error);
    response.status(500).json({ ok: false, error: error instanceof Error ? error.message : String(error) });
  }
});

app.get("/api/kline-tail-health", async (_request, response) => {
  try {
    const targets = await listKlineTailRefreshTargets({ limit: 10_000 });
    response.json({
      ok: true,
      generatedAt: new Date().toISOString(),
      targetIntervalCount: targets.length,
      targetTokenCount: new Set(targets.map((item) => item.symbol)).size,
      targets
    });
  } catch (error) {
    console.error("get kline tail health failed", error);
    response.status(500).json({ ok: false, error: error instanceof Error ? error.message : String(error) });
  }
});

app.get("/api/overview", async (_request, response) => {
  const services = await serviceStates();
  response.json({
    ok: true,
    overview: await getOverview(),
    crawler: services.crawler?.crawler ?? null,
    watchRealtime: services.realtime?.watchRealtime ?? null,
    fundingMonitor: services.scheduler?.fundingMonitor ?? null,
    openInterestMonitor: services.scheduler?.openInterestMonitor ?? null,
    tokenUnlock: services.scheduler?.tokenUnlock ?? null,
    telegram: { ...telegramState(), bot: services.scheduler?.telegramBot ?? null },
    database: "connected"
  });
});

app.get("/api/trade-analysis", requireSensitiveRead, async (request, response) => {
  try {
    response.json(await getTradeAnalysis(config, {
      start: request.query.start,
      end: request.query.end,
      symbol: request.query.symbol,
      page: request.query.page,
      pageSize: request.query.pageSize,
      mode: request.query.mode
    }));
  } catch (error) {
    console.error("get trade analysis failed", error);
    response.status(500).json({ ok: false, error: error instanceof Error ? error.message : String(error) });
  }
});

app.post("/api/trade-analysis/codex", requireLocalMutation, async (request, response) => {
  try {
    const body = request.body ?? {};
    const scope = normalizeCodexScope(body.scope);
    if (scope === "trade" && !body.tradeKey && (!body.source || !body.symbol)) {
      response.status(400).json({ ok: false, error: "请先在交易记录表中选择一个交易组。" });
      return;
    }
    if (scope === "symbol" && !body.symbol) {
      response.status(400).json({ ok: false, error: "请先选择一个币种汇总，或输入币种。" });
      return;
    }
    const analysis = await getTradeAnalysis(config, {
      start: scope === "all" ? "" : body.start,
      end: scope === "all" ? "" : body.end,
      symbol: scope === "range" || scope === "symbol" || scope === "trade" ? body.symbol : ""
    });
    const prepared = prepareCodexTradeAnalysis(analysis, {
      scope: body.scope,
      symbol: body.symbol,
      source: body.source,
      tradeKey: body.tradeKey,
      contextEventLimit: config.tradeAnalysis.codex.contextEventLimit
    });
    const codexResult = await runCodexTradeAnalysis(prepared.prompt, {
      command: config.tradeAnalysis.codex.command,
      timeoutMs: config.tradeAnalysis.codex.timeoutMs
    });
    response.json({
      ok: true,
      generatedAt: new Date().toISOString(),
      scope: prepared.report.scope,
      title: prepared.report.title,
      report: prepared.report,
      analysis: codexResult.text
    });
  } catch (error) {
    console.error("run codex trade analysis failed", error);
    response.status(error.statusCode || 500).json({ ok: false, error: error instanceof Error ? error.message : String(error) });
  }
});

app.post("/api/token-analysis/codex", requireLocalMutation, async (request, response) => {
  try {
    const body = request.body ?? {};
    const symbol = sanitizeSymbol(body.symbol);
    const intervalCode = normalizeTokenInterval(body.intervalCode ?? body.interval);
    if (!symbol) {
      response.status(400).json({ ok: false, error: "symbol is required" });
      return;
    }

    const limit = body.klineLimit === undefined || body.klineLimit === null || body.klineLimit === "" || body.klineLimit === "all"
      ? "all"
      : Math.max(120, Number(body.klineLimit) || 360);
    const klinePayload = await getKlines({ symbol, intervalCode, limit });
    if (klinePayload.needsRefresh && shouldRequestKlineRefresh(symbol, intervalCode, klinePayload.refreshReason)) {
      void requestService("crawler", "/internal/kline/refresh", {
        method: "POST",
        body: JSON.stringify({ symbol, intervalCode }),
        timeoutMs: 10 * 60 * 1000
      })
        .catch((error) => console.error("token codex kline refresh failed", symbol, intervalCode, error));
      void queueSymbolsForKlineRefresh(symbol, `Codex 分析前补齐 ${intervalCode} K线：${klinePayload.refreshReason || "cache_refresh"}`)
        .catch((error) => console.error("token codex kline queue failed", symbol, intervalCode, error));
    }

    const prepared = prepareCodexTokenAnalysis({
      symbol,
      intervalCode,
      klinePayload,
      context: body.context,
      contextKlineLimit: body.contextKlineLimit
    });
    const codexResult = await runCodexTradeAnalysis(prepared.prompt, {
      command: config.tradeAnalysis.codex.command,
      timeoutMs: config.tradeAnalysis.codex.timeoutMs
    });
    response.json({
      ok: true,
      generatedAt: new Date().toISOString(),
      scope: prepared.report.scope,
      title: prepared.report.title,
      report: prepared.report,
      analysis: codexResult.text
    });
  } catch (error) {
    console.error("run codex token analysis failed", error);
    response.status(error.statusCode || 500).json({ ok: false, error: error instanceof Error ? error.message : String(error) });
  }
});

app.get("/api/signals", async (request, response) => {
  if (request.query.categories || request.query.levels || request.query.intervals || request.query.page || request.query.pageSize) {
    const result = await getSignalGroupsPage({
      categories: request.query.categories,
      levels: request.query.levels,
      intervals: request.query.intervals,
      page: request.query.page,
      pageSize: request.query.pageSize
    });
    response.json({ ok: true, ...result });
    return;
  }

  const category = request.query.category === "B" ? "B" : "A";
  response.json({ ok: true, category, signals: await getSignals(category) });
});

app.get("/api/hot-ma-signals", async (request, response) => {
  const result = await getHotMaSignalsPage({
    categories: request.query.categories ?? "A,B",
    levels: request.query.levels ?? "LEVEL1,LEVEL2",
    intervals: request.query.intervals ?? "15m,1h,4h,1d",
    page: request.query.page,
    pageSize: request.query.pageSize
  });
  response.json({ ok: true, ...result });
});

app.get("/api/multi-history", async (request, response) => {
  response.json({ ok: true, items: await listMultiCycleHistory({ limit: request.query.limit }) });
});

app.get("/api/klines", async (request, response) => {
  const symbol = String(request.query.symbol ?? "").toUpperCase().replace(/[^A-Z0-9_]/g, "");
  const interval = ["15m", "1h", "4h", "1d"].includes(request.query.interval) ? request.query.interval : "1h";
  const limit = request.query.limit === "all" ? "all" : Math.max(50, Math.min(1000, Number(request.query.limit) || 240));
  if (!symbol) {
    response.status(400).json({ ok: false, error: "symbol is required" });
    return;
  }
  const payload = await getKlines({ symbol, intervalCode: interval, limit });
  if (payload.needsRefresh && shouldRequestKlineRefresh(symbol, interval, payload.refreshReason)) {
    void requestService("crawler", "/internal/kline/refresh", {
      method: "POST",
      body: JSON.stringify({ symbol, intervalCode: interval }),
      timeoutMs: 10 * 60 * 1000
    })
      .catch((error) => console.error("on-demand kline refresh failed", symbol, interval, error));
    void queueSymbolsForKlineRefresh(symbol, `按需补齐 ${interval} K线：${payload.refreshReason || "cache_refresh"}`)
      .catch((error) => console.error("on-demand kline queue failed", symbol, interval, error));
  }
  response.json({
    ok: true,
    ...payload,
    tradingViewSymbol: `BINANCE:${symbol}.P`
  });
});

const klineRefreshRequests = new Map();

function shouldRequestKlineRefresh(symbol, intervalCode, reason = "") {
  const key = `${symbol}:${intervalCode}:${reason}`;
  const now = Date.now();
  const last = Number(klineRefreshRequests.get(key) ?? 0);
  if (now - last < 10 * 60 * 1000) return false;
  klineRefreshRequests.set(key, now);
  if (klineRefreshRequests.size > 2000) {
    for (const [entryKey, timestamp] of klineRefreshRequests) {
      if (now - Number(timestamp) > 30 * 60 * 1000) klineRefreshRequests.delete(entryKey);
    }
  }
  return true;
}

app.get("/api/hot-rank", async (request, response) => {
  try {
    const payload = await getHotRank({
      chain: String(request.query.chain ?? "all"),
      limit: request.query.limit,
      targetLanguage: String(request.query.targetLanguage ?? "zh"),
      socialLanguage: String(request.query.socialLanguage ?? "ALL"),
      timeRange: request.query.timeRange
    });
    response.json(payload);
  } catch (error) {
    response.status(502).json({
      ok: false,
      error: error instanceof Error ? error.message : String(error)
    });
  }
});

app.post("/api/funding-interval/check", requireLocalMutation, async (_request, response) => {
  try {
    response.json(await requestService("scheduler", "/internal/funding/check", { method: "POST", body: "{}" }));
  } catch (error) {
    response.status(502).json({
      ok: false,
      error: error instanceof Error ? error.message : String(error)
    });
  }
});

app.post("/api/open-interest/check", requireLocalMutation, async (_request, response) => {
  try {
    response.json(await requestService("scheduler", "/internal/open-interest/check", { method: "POST", body: "{}" }));
  } catch (error) {
    response.status(502).json({
      ok: false,
      error: error instanceof Error ? error.message : String(error)
    });
  }
});

app.get("/api/watchlist", async (_request, response) => {
  response.json({ ok: true, items: await listWatchlist() });
});

app.get("/api/watchlist/events", async (request, response) => {
  let upstream;
  try {
    upstream = await fetch(serviceUrl("realtime", "/internal/events"), {
      headers: config.service.internalToken ? { "X-Internal-Service-Token": config.service.internalToken } : {}
    });
  } catch (error) {
    console.error("watchlist events upstream failed", error);
    response.status(503).json({ ok: false, error: error instanceof Error ? error.message : String(error) });
    return;
  }
  if (!upstream.ok || !upstream.body) {
    response.status(503).json({ ok: false, error: `realtime service HTTP ${upstream.status}` });
    return;
  }
  response.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no"
  });
  const stream = Readable.fromWeb(upstream.body);
  stream.on("error", (error) => {
    console.error("watchlist events stream failed", error);
    if (!response.destroyed) response.end();
  });
  stream.pipe(response);
  request.on("close", () => stream.destroy());
});

app.post("/api/watchlist", requireLocalMutation, async (request, response) => {
  try {
    const items = await upsertWatchlistItem(request.body ?? {});
    const symbol = sanitizeSymbol(request.body?.symbol);
    const baseAsset = symbol.replace(/USDT$/, "");
    void requestService("crawler", "/internal/watchlist/refresh", {
      method: "POST",
      body: JSON.stringify({ full: true }),
      timeoutMs: 60_000
    }).catch((error) => console.error("watchlist post-refresh failed", error));
    void requestService("realtime", "/internal/refresh", { method: "POST", body: "{}" })
      .catch((error) => console.error("watchlist realtime refresh failed", error));
    void requestService("scheduler", "/internal/unlock/check", {
      method: "POST",
      body: JSON.stringify({ symbol, baseAsset }),
      timeoutMs: 60_000
    })
      .catch((error) => console.error("watchlist unlock refresh failed", error));
    response.json({ ok: true, items });
  } catch (error) {
    response.status(400).json({ ok: false, error: error instanceof Error ? error.message : String(error) });
  }
});

app.delete("/api/watchlist/:symbol", requireLocalMutation, async (request, response) => {
  const deleted = await deleteWatchlistItem(request.params.symbol);
  void requestService("realtime", "/internal/refresh", { method: "POST", body: "{}" })
    .catch((error) => console.error("watchlist realtime refresh failed", error));
  response.json({ ok: true, deleted });
});

app.get("/api/watchlist/:symbol/unlock", async (request, response) => {
  response.json({ ok: true, item: await getTokenUnlockCache(request.params.symbol) });
});

app.post("/api/watchlist/unlock/refresh", requireLocalMutation, async (_request, response) => {
  response.json(await requestService("scheduler", "/internal/unlock/check", {
    method: "POST",
    body: "{}",
    timeoutMs: 60_000
  }));
});

function sanitizeSymbol(value) {
  return String(value ?? "").toUpperCase().replace(/[^A-Z0-9_]/g, "");
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function appOpenPage({ title, symbol, primaryDeepLink, secondaryDeepLinks = [], fallbackUrl, note }) {
  const deepLinks = [primaryDeepLink, ...secondaryDeepLinks].filter(Boolean);
  const encodedLinks = JSON.stringify(deepLinks);
  return `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>${escapeHtml(title)}</title>
    <style>
      body {
        margin: 0;
        min-height: 100vh;
        display: grid;
        place-items: center;
        font-family: Arial, "PingFang SC", "Microsoft YaHei", sans-serif;
        color: #211721;
        background: #fff8fb;
      }
      main {
        width: min(92vw, 460px);
        padding: 28px;
        border: 1px solid #eee8ec;
        border-radius: 18px;
        background: #fff;
        box-shadow: 0 18px 45px rgba(69, 39, 55, 0.12);
      }
      h1 { margin: 0 0 10px; font-size: 24px; }
      p { color: #6d606b; line-height: 1.7; }
      a, button {
        display: flex;
        align-items: center;
        justify-content: center;
        width: 100%;
        min-height: 44px;
        margin-top: 12px;
        border: 0;
        border-radius: 999px;
        color: #fff;
        background: #ed2a75;
        font: inherit;
        font-weight: 800;
        text-decoration: none;
      }
      button { cursor: pointer; }
      small { display: block; margin-top: 14px; color: #9b8f98; line-height: 1.6; }
    </style>
  </head>
  <body>
    <main>
      <h1>${escapeHtml(title)}</h1>
      <p>正在尝试打开 App：<strong>${escapeHtml(symbol)}</strong></p>
      <button id="openApp" type="button">再次尝试打开 App</button>
      <a href="${escapeHtml(fallbackUrl)}">打不开 App 时打开网页</a>
      <small>${escapeHtml(note)}</small>
    </main>
    <script>
      const deepLinks = ${encodedLinks};
      const fallbackUrl = ${JSON.stringify(fallbackUrl)};
      function openApp() {
        deepLinks.forEach((url, index) => {
          setTimeout(() => {
            window.location.href = url;
          }, index * 450);
        });
        setTimeout(() => {
          if (!document.hidden) window.location.href = fallbackUrl;
        }, 2600);
      }
      document.getElementById("openApp").addEventListener("click", openApp);
      openApp();
    </script>
  </body>
</html>`;
}

app.get("/open/binance", (request, response) => {
  const symbol = sanitizeSymbol(request.query.symbol);
  if (!symbol) {
    response.status(400).send("symbol is required");
    return;
  }
  const fallbackUrl = `https://www.binance.com/en/futures/${encodeURIComponent(symbol)}`;
  response.type("html").send(
    appOpenPage({
      title: "打开 Binance App",
      symbol,
      primaryDeepLink: `bnc://app.binance.com/futures/${encodeURIComponent(symbol)}`,
      secondaryDeepLinks: [
        `bnc://app.binance.com/en/futures/${encodeURIComponent(symbol)}`,
        "bnc://app.binance.com/markets/markets",
        "bnc://app.binance.com"
      ],
      fallbackUrl,
      note: "如果 Binance App 没有接管深链，会自动回落到网页合约页。"
    })
  );
});

app.get("/open/tradingview", (request, response) => {
  const symbol = sanitizeSymbol(request.query.symbol);
  if (!symbol) {
    response.status(400).send("symbol is required");
    return;
  }
  const tvSymbol = `BINANCE:${symbol}.P`;
  const fallbackUrl = `https://www.tradingview.com/chart/?symbol=${encodeURIComponent(tvSymbol)}`;
  response.type("html").send(
    appOpenPage({
      title: "打开 TradingView App",
      symbol: tvSymbol,
      primaryDeepLink: `tradingview://chart/?symbol=${encodeURIComponent(tvSymbol)}`,
      secondaryDeepLinks: [`tradingview://symbols/${encodeURIComponent(tvSymbol.replace(":", "-"))}/`, "tradingview://"],
      fallbackUrl,
      note: "如果 TradingView App 没有接管深链，会自动回落到网页图表页。"
    })
  );
});

app.get("/api/trigger-history", async (request, response) => {
  try {
    response.json({
      ok: true,
      ...(await listTriggerHistory({
        page: request.query.page,
        pageSize: request.query.pageSize,
        triggerTypes: request.query.triggerTypes
      }))
    });
  } catch (error) {
    console.error("get trigger history failed", error);
    response.status(500).json({ ok: false, error: error instanceof Error ? error.message : String(error) });
  }
});

app.delete("/api/trigger-history/:id", requireLocalMutation, async (request, response) => {
  try {
    const deleted = await deleteTriggerHistory(request.params.id);
    response.json({ ok: true, deleted });
  } catch (error) {
    console.error("delete trigger history failed", error);
    response.status(500).json({ ok: false, error: error instanceof Error ? error.message : String(error) });
  }
});

app.delete("/api/trigger-history", requireLocalMutation, async (request, response) => {
  try {
    const ids = Array.isArray(request.body?.ids) ? request.body.ids : [];
    const deleted = ids.length ? await deleteTriggerHistory(ids) : await clearTriggerHistory();
    response.json({ ok: true, deleted });
  } catch (error) {
    console.error("clear trigger history failed", error);
    response.status(500).json({ ok: false, error: error instanceof Error ? error.message : String(error) });
  }
});

app.get("/api/funding-rate-tokens", async (_request, response) => {
  try {
    const tokens = await listOneHourFundingIntervals();
    response.json({ ok: true, tokens, total: tokens.length });
  } catch (error) {
    console.error("get funding rate tokens failed", error);
    response.status(500).json({ ok: false, error: error instanceof Error ? error.message : String(error) });
  }
});

async function handleOpenInterestMonitoring(request, response) {
  try {
    const timeWindow = ["5m", "15m", "1h", "4h", "1d"].includes(request.query.timeWindow)
      ? request.query.timeWindow
      : "5m";
    const sort = request.query.sort === "asc" ? "asc" : "desc";
    const scheduler = await requestService("scheduler", "/internal/health").catch(() => null);
    response.json({
      ok: true,
      generatedAt: new Date().toISOString(),
      ...(await listOpenInterestMonitorPage({
        timeWindow,
        sort,
        page: request.query.page,
        pageSize: request.query.pageSize
      })),
      timeWindow,
      sort,
      monitor: scheduler?.openInterestMonitor ?? null
    });
  } catch (error) {
    console.error("get oi monitoring failed", error);
    response.status(500).json({ ok: false, error: error instanceof Error ? error.message : String(error) });
  }
}

app.get("/api/oi-monitoring", handleOpenInterestMonitoring);
app.get("/api/io-monitoring", handleOpenInterestMonitoring);

app.use((_request, response) => {
  response.sendFile(path.resolve(__dirname, "../public/index.html"));
});

await ensureDatabase();
app.listen(config.service.apiPort, config.service.apiHost, () => {
  console.log(`API service running at http://${config.service.apiHost}:${config.service.apiPort}`);
});
