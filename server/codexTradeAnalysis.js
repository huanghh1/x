import { spawn } from "node:child_process";
import os from "node:os";

const VALID_SCOPES = new Set(["all", "range", "trade", "symbol"]);
const DEFAULT_CODEX_COMMAND = "/Applications/Codex.app/Contents/Resources/codex";
const DEFAULT_TIMEOUT_MS = 180_000;
const DEFAULT_CONTEXT_EVENTS = 80;
const MAX_CONTEXT_EVENTS = 180;
const MAX_STDIO_BYTES = 2 * 1024 * 1024;

function toNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function cleanSymbol(value) {
  return String(value ?? "").trim().toUpperCase().replace(/[^A-Z0-9_-]/g, "");
}

function comparableSymbol(value) {
  const compact = cleanSymbol(value).replace(/[_-]/g, "");
  return compact.endsWith("USDT") ? compact.slice(0, -4) : compact;
}

function symbolMatches(left, right) {
  const a = comparableSymbol(left);
  const b = comparableSymbol(right);
  return Boolean(a && b && a === b);
}

function requestError(message, statusCode = 400) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

export function normalizeCodexScope(value) {
  const scope = String(value ?? "all").trim().toLowerCase();
  if (scope === "event") return "trade";
  return VALID_SCOPES.has(scope) ? scope : "all";
}

function pickEvent(event) {
  return {
    id: event.id ?? "",
    time: event.time ?? null,
    source: event.source ?? "",
    sourceLabel: event.sourceLabel ?? "",
    symbol: event.symbol ?? "",
    type: event.type ?? "",
    side: event.side ?? "",
    direction: event.direction ?? "",
    positionSide: event.positionSide ?? "",
    quantity: event.quantity ?? null,
    price: event.price ?? null,
    markPrice: event.markPrice ?? null,
    notional: event.notional ?? null,
    realizedPnl: event.realizedPnl ?? 0,
    unrealizedPnl: event.unrealizedPnl ?? 0,
    funding: event.funding ?? 0,
    commission: event.commission ?? 0,
    feeAsset: event.feeAsset ?? "",
    fundingRate: event.fundingRate ?? null,
    net: event.net ?? 0,
    liquidity: event.liquidity ?? "",
    note: event.note ?? "",
    pnlIncluded: event.pnlIncluded !== false,
    rawType: event.rawType ?? ""
  };
}

function pickPosition(position) {
  return {
    id: position.id ?? "",
    source: position.source ?? "",
    sourceLabel: position.sourceLabel ?? "",
    symbol: position.symbol ?? "",
    side: position.side ?? "",
    quantity: position.quantity ?? null,
    entryPrice: position.entryPrice ?? null,
    markPrice: position.markPrice ?? null,
    notional: position.notional ?? null,
    unrealizedPnl: position.unrealizedPnl ?? 0,
    leverage: position.leverage ?? null,
    liquidationPrice: position.liquidationPrice ?? null,
    marginMode: position.marginMode ?? "",
    updatedAt: position.updatedAt ?? null
  };
}

function tradeRowKey(row = {}) {
  return JSON.stringify([row.source || "", row.symbol || "", row.firstTime ?? null, row.lastTime ?? null]);
}

function pickTrade(row) {
  return {
    key: tradeRowKey(row),
    source: row.source ?? "",
    sourceLabel: row.sourceLabel ?? "",
    symbol: row.symbol ?? "",
    firstTime: row.firstTime ?? null,
    lastTime: row.lastTime ?? null,
    events: row.events ?? 0,
    realizedPnl: row.realizedPnl ?? 0,
    funding: row.funding ?? 0,
    commission: row.commission ?? 0,
    feeCost: row.feeCost ?? 0,
    net: row.net ?? 0,
    notional: row.notional ?? 0
  };
}

function addEventSummary(summary, event) {
  summary.events += 1;
  if (event.pnlIncluded === false) return;
  const realizedPnl = toNumber(event.realizedPnl);
  const funding = toNumber(event.funding);
  const commission = toNumber(event.commission);
  const net = realizedPnl + funding + commission;
  summary.realizedPnl += realizedPnl;
  summary.funding += funding;
  summary.commission += commission;
  summary.feeCost += Math.abs(Math.min(0, commission));
  summary.net += net;
  summary.notional += toNumber(event.notional);
  if (net > 0) summary.profitableEvents += 1;
  if (net < 0) summary.losingEvents += 1;
}

function summarizeEvents(events) {
  const totals = {
    events: 0,
    realizedPnl: 0,
    funding: 0,
    commission: 0,
    feeCost: 0,
    net: 0,
    notional: 0,
    profitableEvents: 0,
    losingEvents: 0
  };
  const symbolMap = new Map();
  const sourceMap = new Map();
  for (const event of events) {
    addEventSummary(totals, event);
    const symbolKey = `${event.source ?? ""}:${event.symbol ?? ""}`;
    const symbolSummary = symbolMap.get(symbolKey) ?? {
      source: event.source ?? "",
      sourceLabel: event.sourceLabel ?? "",
      symbol: event.symbol ?? "",
      events: 0,
      realizedPnl: 0,
      funding: 0,
      commission: 0,
      feeCost: 0,
      net: 0,
      notional: 0,
      profitableEvents: 0,
      losingEvents: 0
    };
    addEventSummary(symbolSummary, event);
    symbolMap.set(symbolKey, symbolSummary);

    const sourceKey = event.source ?? "";
    const sourceSummary = sourceMap.get(sourceKey) ?? {
      source: event.source ?? "",
      sourceLabel: event.sourceLabel ?? "",
      events: 0,
      realizedPnl: 0,
      funding: 0,
      commission: 0,
      feeCost: 0,
      net: 0,
      notional: 0,
      profitableEvents: 0,
      losingEvents: 0
    };
    addEventSummary(sourceSummary, event);
    sourceMap.set(sourceKey, sourceSummary);
  }
  return {
    totals,
    bySource: Array.from(sourceMap.values()).sort((a, b) => Math.abs(b.net) - Math.abs(a.net)),
    bySymbol: Array.from(symbolMap.values()).sort((a, b) => Math.abs(b.net) - Math.abs(a.net)).slice(0, 20)
  };
}

function findTradeRow(analysis, options = {}) {
  const rows = Array.isArray(analysis?.summary?.bySymbol) ? analysis.summary.bySymbol : [];
  const requestedKey = String(options.tradeKey ?? "").trim();
  if (requestedKey) {
    const exact = rows.find((row) => tradeRowKey(row) === requestedKey);
    if (exact) return exact;
  }
  const requestedSource = String(options.source ?? "").trim();
  const requestedSymbol = cleanSymbol(options.symbol ?? "");
  if (!requestedSource && !requestedSymbol) return null;
  return rows.find((row) =>
    (!requestedSource || String(row.source ?? "") === requestedSource) &&
    (!requestedSymbol || symbolMatches(row.symbol, requestedSymbol))
  ) ?? null;
}

function eventBelongsToTrade(event, trade) {
  if (!trade) return false;
  if (String(event.source ?? "") !== String(trade.source ?? "")) return false;
  if (!symbolMatches(event.symbol, trade.symbol)) return false;
  const eventTime = toNumber(event.time, NaN);
  const firstTime = toNumber(trade.firstTime, NaN);
  const lastTime = toNumber(trade.lastTime, NaN);
  if (!Number.isFinite(eventTime)) return true;
  if (Number.isFinite(firstTime) && eventTime < firstTime) return false;
  if (Number.isFinite(lastTime) && eventTime > lastTime) return false;
  return true;
}

function limitedEvents(events, { limit }) {
  return events
    .slice()
    .sort((a, b) => toNumber(b.time) - toNumber(a.time))
    .slice(0, limit);
}

function scopeTitle(scope, symbol, selectedTrade, dataWindow) {
  if (scope === "trade") {
    const source = selectedTrade?.sourceLabel || selectedTrade?.source || "--";
    return `单笔交易复盘：${source} · ${selectedTrade?.symbol || symbol || "--"}`;
  }
  if (scope === "symbol") return `币种复盘：${symbol || "--"}`;
  if (scope === "range") {
    const start = dataWindow?.startTime ? new Date(dataWindow.startTime).toISOString() : "";
    const end = dataWindow?.endTime ? new Date(dataWindow.endTime).toISOString() : "";
    return `时间段复盘：${start || "--"} → ${end || "--"}`;
  }
  return "全部交易记录复盘";
}

export function prepareCodexTradeAnalysis(analysis, options = {}) {
  const scope = normalizeCodexScope(options.scope);
  const events = Array.isArray(analysis?.events) ? analysis.events : [];
  const positions = Array.isArray(analysis?.positions) ? analysis.positions : [];
  const selectedTrade = scope === "trade" ? findTradeRow(analysis, options) : null;

  if (scope === "trade" && !selectedTrade) {
    throw requestError("请先在交易记录表中选择一笔单笔交易。");
  }

  const requestedSymbol = cleanSymbol(options.symbol || analysis?.symbol || selectedTrade?.symbol || "");
  const targetSymbol = scope === "symbol" || scope === "trade"
    ? cleanSymbol(requestedSymbol || selectedTrade?.symbol)
    : requestedSymbol;

  if (scope === "symbol" && !targetSymbol) {
    throw requestError("请先输入币种，或先选中一条该币种的交易记录。");
  }

  let scopedEvents;
  let scopedPositions;
  if (scope === "trade") {
    scopedEvents = events.filter((event) => eventBelongsToTrade(event, selectedTrade));
    scopedPositions = positions.filter((position) =>
      String(position.source ?? "") === String(selectedTrade.source ?? "") &&
      symbolMatches(position.symbol, selectedTrade.symbol)
    );
  } else if (scope === "symbol" || (scope === "range" && targetSymbol)) {
    scopedEvents = events.filter((event) => symbolMatches(event.symbol, targetSymbol));
    scopedPositions = positions.filter((position) => symbolMatches(position.symbol, targetSymbol));
  } else {
    scopedEvents = events;
    scopedPositions = positions;
  }

  if (scope !== "all" && scope !== "range" && !scopedEvents.length && !scopedPositions.length) {
    throw requestError(`当前范围没有 ${targetSymbol} 的交易或持仓数据。`);
  }

  const contextLimit = Math.max(10, Math.min(MAX_CONTEXT_EVENTS, Number(options.contextEventLimit) || DEFAULT_CONTEXT_EVENTS));
  const contextEvents = limitedEvents(scopedEvents, { limit: contextLimit });
  const report = {
    title: scopeTitle(scope, targetSymbol, selectedTrade, analysis?.window),
    scope,
    generatedAt: new Date().toISOString(),
    dataWindow: analysis?.window ?? null,
    requestedSymbol: targetSymbol,
    selectedTrade: selectedTrade ? pickTrade(selectedTrade) : null,
    summary: summarizeEvents(scopedEvents),
    sourceStatus: Array.isArray(analysis?.sources) ? analysis.sources : [],
    positions: scopedPositions.map(pickPosition).slice(0, 40),
    eventsReturned: contextEvents.length,
    eventsAvailableInScope: scopedEvents.length,
    events: contextEvents.map(pickEvent)
  };

  const prompt = [
    "你是我的交易复盘教练。只根据下面 JSON 里的交易数据复盘，不要读取本地文件，不要执行命令，不要索要或猜测任何 API Key/Secret。",
    "用中文回答，语气直接、具体、短一点，像在帮我复盘一笔真实交易。不要写空话，不要保证收益。",
    "当 scope 为 trade 时，单笔交易指 selectedTrade 这条交易记录表行，不是单条账单/成交流水；events 只是这条记录的明细上下文。",
    "",
    "先判断这笔交易/这个时间段/全部记录是赚在哪里、亏在哪里，再指出最明显的 1-3 个问题，最后给出下次可执行的改法。",
    "请按这个格式输出，不要额外扩展长篇报告：",
    "结论：1-3 句话，直接说这次做得好还是不好，主要原因是什么。",
    "问题：列 1-3 条最明显的问题，必须结合数据，比如净收益、已实现、手续费、资金费、明细数、持仓。",
    "原因：说明这些问题可能来自什么交易行为。没有足够证据就写“证据不足”，不要硬猜。",
    "下次怎么做：给 3 条以内具体规则，尽量能直接执行。",
    "",
    "<trade_data_json>",
    JSON.stringify(report, null, 2),
    "</trade_data_json>"
  ].join("\n");

  return { prompt, report };
}

function appendLimited(current, chunk) {
  const next = current + chunk;
  if (Buffer.byteLength(next, "utf8") <= MAX_STDIO_BYTES) return next;
  return next.slice(0, MAX_STDIO_BYTES);
}

function codexEnv() {
  const allowed = [
    "HOME",
    "CODEX_HOME",
    "PATH",
    "SHELL",
    "TMPDIR",
    "TMP",
    "TEMP",
    "USER",
    "LOGNAME",
    "LANG",
    "LC_ALL",
    "HTTPS_PROXY",
    "HTTP_PROXY",
    "ALL_PROXY",
    "NO_PROXY",
    "SSL_CERT_FILE",
    "NODE_EXTRA_CA_CERTS"
  ];
  const env = {};
  for (const key of allowed) {
    if (process.env[key]) env[key] = process.env[key];
  }
  if (!env.PATH) env.PATH = "/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin";
  return env;
}

export function runCodexTradeAnalysis(prompt, options = {}) {
  const command = String(options.command || DEFAULT_CODEX_COMMAND).trim() || DEFAULT_CODEX_COMMAND;
  const timeoutMs = Math.max(30_000, Number(options.timeoutMs) || DEFAULT_TIMEOUT_MS);
  const cwd = options.cwd || os.tmpdir();
  const args = [
    "--ask-for-approval",
    "never",
    "exec",
    "--ephemeral",
    "--sandbox",
    "read-only",
    "--skip-git-repo-check",
    "-"
  ];

  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: codexEnv(),
      stdio: ["pipe", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      settled = true;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 1200).unref?.();
      reject(requestError(`Codex 分析超时（${Math.round(timeoutMs / 1000)} 秒），请稍后重试或缩小筛选范围。`, 504));
    }, timeoutMs);

    child.stdout.on("data", (chunk) => {
      stdout = appendLimited(stdout, chunk.toString("utf8"));
    });
    child.stderr.on("data", (chunk) => {
      stderr = appendLimited(stderr, chunk.toString("utf8"));
    });
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(requestError(`无法启动 Codex CLI：${error.message}`, 502));
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code === 0) {
        resolve({
          text: stdout.trim(),
          stderr: stderr.trim()
        });
        return;
      }
      const details = (stderr || stdout).trim().split("\n").slice(-8).join("\n");
      reject(requestError(`Codex 分析失败：${details || `退出码 ${code}`}`, 502));
    });
    child.stdin.end(prompt);
  });
}
