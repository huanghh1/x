import crypto from "node:crypto";
import { readTradeEventHistoryAnalysis, upsertTradeEventHistory } from "./db.js";

const SOURCE_LABELS = {
  binance: "Binance USD-M",
  hyperliquid: "Hyperliquid"
};

const DAY_MS = 24 * 60 * 60 * 1000;
const BINANCE_MAX_LOOKBACK_MS = 90 * DAY_MS;
const SEVEN_DAY_CHUNK_MS = (7 * DAY_MS) - 1;
const THIRTY_DAY_CHUNK_MS = (30 * DAY_MS) - 1;
const HYPERLIQUID_PAGE_LIMIT = 2000;
const BINANCE_PAGE_LIMIT = 1000;
const BINANCE_MAX_INCOME_PAGES_PER_CHUNK = 100;
const BINANCE_MAX_TRADE_PAGES_PER_CHUNK = 50;
const BINANCE_PNL_INCOME_TYPES = new Set(["REALIZED_PNL", "FUNDING_FEE", "COMMISSION"]);
const TRADE_ANALYSIS_CACHE_MS = 60 * 1000;
const TRANSIENT_RETRY_DELAYS_MS = [350, 1000];
const tradeAnalysisCache = new Map();

const CONNECTIONS = [
  {
    id: "binance",
    label: SOURCE_LABELS.binance,
    docsUrl: "https://developers.binance.com/docs/derivatives/usds-margined-futures/account/rest-api/Get-Income-History",
    fields: [
      { env: "BINANCE_API_KEY", configKey: "apiKey", label: "API Key", secret: true },
      { env: "BINANCE_API_SECRET", configKey: "apiSecret", label: "API Secret", secret: true },
      { env: "BINANCE_FUTURES_BASE_URL", configKey: "futuresBaseUrl", label: "Futures Base URL", optional: true }
    ]
  },
  {
    id: "hyperliquid",
    label: SOURCE_LABELS.hyperliquid,
    docsUrl: "https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/info-endpoint/perpetuals",
    fields: [
      { env: "HYPERLIQUID_WALLET_ADDRESS", configKey: "walletAddress", label: "钱包地址" },
      { env: "HYPERLIQUID_INFO_BASE_URL", configKey: "infoBaseUrl", label: "Info Base URL", optional: true },
      { env: "HYPERLIQUID_PERP_DEXS", configKey: "perpDexs", label: "HIP-3 Perp Dexs", optional: true }
    ]
  }
];

function toNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function finiteOrNull(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function isConfigured(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function normalizeBaseUrl(url) {
  return String(url ?? "").replace(/\/+$/, "");
}

function parseTime(value, fallback) {
  if (value === undefined || value === null || value === "") return fallback;
  const direct = Number(value);
  if (Number.isFinite(direct) && direct > 0) return direct;
  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) ? parsed : fallback;
}

function normalizeWindow({ start, end, defaultLookbackDays = 90 }) {
  const now = Date.now();
  const fallbackEnd = now;
  const fallbackStart = now - (Math.max(1, Number(defaultLookbackDays) || 90) * DAY_MS);
  let startMs = parseTime(start, fallbackStart);
  let endMs = parseTime(end, fallbackEnd);
  if (startMs > endMs) [startMs, endMs] = [endMs, startMs];
  return { startMs, endMs };
}

function splitTimeRange(startMs, endMs, chunkMs) {
  const chunks = [];
  let cursor = startMs;
  while (cursor <= endMs) {
    const chunkEnd = Math.min(endMs, cursor + chunkMs);
    chunks.push({ startMs: cursor, endMs: chunkEnd });
    cursor = chunkEnd + 1;
  }
  return chunks;
}

function chunksForActivity(startMs, endMs, chunkMs, activityTimes = []) {
  const validTimes = activityTimes
    .map((value) => Number(value))
    .filter((value) => Number.isFinite(value) && value >= startMs && value <= endMs);
  if (!validTimes.length) return splitTimeRange(startMs, endMs, chunkMs);
  const stepMs = chunkMs + 1;
  const chunks = new Map();
  for (const time of validTimes) {
    const index = Math.floor((time - startMs) / stepMs);
    const chunkStart = startMs + (index * stepMs);
    chunks.set(index, {
      startMs: chunkStart,
      endMs: Math.min(endMs, chunkStart + chunkMs)
    });
  }
  return Array.from(chunks.entries())
    .sort((a, b) => a[0] - b[0])
    .map(([, chunk]) => chunk);
}

function uniqueById(items) {
  const seen = new Set();
  const result = [];
  for (const item of items) {
    const key = String(item.id ?? `${item.source}:${item.symbol}:${item.type}:${item.time}:${item.net}`);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(item);
  }
  return result;
}

async function mapLimit(items, limit, fn) {
  const results = Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      try {
        results[index] = { status: "fulfilled", value: await fn(items[index], index) };
      } catch (reason) {
        results[index] = { status: "rejected", reason };
      }
    }
  });
  await Promise.all(workers);
  return results;
}

function compactErrorPart(value) {
  return String(value ?? "").trim().replace(/\s+/g, " ");
}

function describeError(error) {
  const message = compactErrorPart(error instanceof Error ? error.message : error) || "unknown error";
  const cause = error instanceof Error && error.cause && typeof error.cause === "object" ? error.cause : null;
  const code = compactErrorPart(cause?.code ?? cause?.name);
  const causeMessage = compactErrorPart(cause?.message);
  const parts = [message];
  if (code && !message.includes(code)) parts.push(code);
  if (causeMessage && causeMessage !== message && !message.includes(causeMessage)) parts.push(causeMessage);
  return parts.join(" · ");
}

function isTransientFetchError(error) {
  return /(fetch failed|aborted|timeout|ECONNRESET|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|UND_ERR|socket|network|HTTP 429|HTTP 5\d\d)/i.test(describeError(error));
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function retryTransient(fn) {
  let lastError;
  for (let attempt = 0; attempt <= TRANSIENT_RETRY_DELAYS_MS.length; attempt += 1) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (attempt >= TRANSIENT_RETRY_DELAYS_MS.length || !isTransientFetchError(error)) throw error;
      await delay(TRANSIENT_RETRY_DELAYS_MS[attempt]);
    }
  }
  throw lastError;
}

function absNegative(value) {
  const number = toNumber(value);
  return number === 0 ? 0 : -Math.abs(number);
}

function nonPnlNote(note, rawType) {
  const detail = String(note || rawType || "").trim();
  return ["不计入收益", detail].filter(Boolean).join(" · ");
}

function normalizeTradeAction({ source, side, positionSide, direction, realizedPnl }) {
  const raw = String(direction || "").trim();
  if (raw) return raw;
  const sideUpper = String(side || "").toUpperCase();
  const posUpper = String(positionSide || "").toUpperCase();
  const hasClosePnl = Math.abs(toNumber(realizedPnl)) > 0;
  if (posUpper === "LONG") return sideUpper === "BUY" ? "Open Long" : "Close Long";
  if (posUpper === "SHORT") return sideUpper === "SELL" ? "Open Short" : "Close Short";
  if (source === "binance" && hasClosePnl) return sideUpper === "BUY" ? "Buy / Close" : "Sell / Close";
  if (sideUpper === "BUY" || sideUpper === "B") return "Buy";
  if (sideUpper === "SELL" || sideUpper === "S" || sideUpper === "A") return "Sell";
  return side || "";
}

function normalizeSymbolText(value) {
  return String(value ?? "").trim().toUpperCase();
}

function symbolLookupVariants(value) {
  const variants = new Set();
  function add(item) {
    const normalized = normalizeSymbolText(item);
    if (normalized) variants.add(normalized);
  }

  add(value);
  for (const item of Array.from(variants)) {
    if (item.includes("-")) add(item.split("-")[0]);
    if (item.includes(":")) add(item.split(":").pop());
    for (const quote of ["USDT", "USDC"]) {
      if (item.endsWith(quote) && item.length > quote.length) add(item.slice(0, -quote.length));
      if (item.endsWith(`-${quote}`) && item.length > quote.length + 1) add(item.slice(0, -(quote.length + 1)));
    }
  }
  for (const item of Array.from(variants)) {
    if (/^[A-Z]{3}$/.test(item)) add(`USD${item}`);
  }
  return variants;
}

function symbolMatchesValue(value, target) {
  if (!target) return true;
  const valueVariants = symbolLookupVariants(value);
  const targetVariants = symbolLookupVariants(target);
  for (const variant of valueVariants) {
    if (targetVariants.has(variant)) return true;
  }
  return false;
}

function sourceConnectionStatus(config) {
  const sources = {
    binance: config.tradeAnalysis.binance,
    hyperliquid: config.tradeAnalysis.hyperliquid
  };
  return CONNECTIONS.map((connection) => {
    const source = sources[connection.id] ?? {};
    const fields = connection.fields.map((field) => ({
      ...field,
      configured: field.optional || isConfigured(source[field.configKey] ?? "")
    }));
    const missing = fields.filter((field) => !field.optional && !field.configured).map((field) => field.env);
    return {
      id: connection.id,
      label: connection.label,
      docsUrl: connection.docsUrl,
      configured: missing.length === 0,
      missing,
      fields: fields.map(({ configKey: _configKey, ...field }) => field)
    };
  });
}

async function fetchJson(url, options = {}, timeoutMs = 15_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    const text = await response.text();
    let payload;
    try {
      payload = text ? JSON.parse(text) : null;
    } catch {
      payload = text;
    }
    if (!response.ok) {
      const message = typeof payload === "object" && payload?.msg
        ? payload.msg
        : typeof payload === "object" && payload?.message
          ? payload.message
          : `${response.status} ${response.statusText}`;
      throw new Error(message);
    }
    return payload;
  } finally {
    clearTimeout(timer);
  }
}

function hmacHex(secret, payload) {
  return crypto.createHmac("sha256", secret).update(payload).digest("hex");
}

async function fetchBinanceSigned(config, path, params) {
  const source = config.tradeAnalysis.binance;
  const query = new URLSearchParams({
    ...params,
    recvWindow: String(source.recvWindowMs),
    timestamp: String(Date.now())
  });
  const signature = hmacHex(source.apiSecret, query.toString());
  query.set("signature", signature);
  return fetchJson(`${normalizeBaseUrl(source.futuresBaseUrl)}${path}?${query.toString()}`, {
    headers: { "X-MBX-APIKEY": source.apiKey }
  }, config.tradeAnalysis.requestTimeoutMs);
}

function binanceIncomeEvent(item) {
  const amount = toNumber(item.income);
  const type = String(item.incomeType ?? "INCOME");
  const pnlIncluded = BINANCE_PNL_INCOME_TYPES.has(type);
  const event = {
    id: `binance:${item.tranId ?? item.tradeId ?? item.time}:${type}`,
    source: "binance",
    sourceLabel: SOURCE_LABELS.binance,
    symbol: item.symbol || "--",
    asset: item.asset || "USDT",
    time: Number(item.time) || null,
    type,
    side: "",
    direction: "",
    quantity: null,
    price: null,
    notional: null,
    fundingRate: null,
    realizedPnl: 0,
    funding: 0,
    commission: 0,
    feeAsset: item.asset || "USDT",
    net: amount,
    orderId: item.info || "",
    tradeId: item.tradeId || "",
    note: pnlIncluded ? item.info || "" : nonPnlNote(item.info, type),
    pnlIncluded,
    rawType: type
  };
  if (type === "REALIZED_PNL") event.realizedPnl = amount;
  else if (type === "FUNDING_FEE") event.funding = amount;
  else if (type === "COMMISSION") event.commission = amount;
  return event;
}

function binanceTradeEvent(item) {
  const price = finiteOrNull(item.price);
  const quantity = finiteOrNull(item.qty);
  const realizedPnl = toNumber(item.realizedPnl);
  const commission = absNegative(item.commission);
  const side = item.side || "";
  const positionSideValue = item.positionSide || "";
  return {
    id: `binance-trade:${item.symbol}:${item.id ?? item.tradeId ?? item.time}`,
    source: "binance",
    sourceLabel: SOURCE_LABELS.binance,
    symbol: item.symbol || "--",
    asset: item.commissionAsset || "USDT",
    time: Number(item.time) || null,
    type: "TRADE",
    side,
    direction: normalizeTradeAction({
      source: "binance",
      side,
      positionSide: positionSideValue,
      realizedPnl
    }),
    positionSide: positionSideValue,
    quantity,
    price,
    notional: finiteOrNull(item.quoteQty) ?? (price && quantity ? price * quantity : null),
    fundingRate: null,
    realizedPnl,
    funding: 0,
    commission,
    feeAsset: item.commissionAsset || "USDT",
    net: realizedPnl + commission,
    pnlIncluded: false,
    orderId: item.orderId || "",
    tradeId: item.id ?? item.tradeId ?? "",
    liquidity: item.maker ? "maker" : "taker",
    note: `成交明细，收益统计以 income 为准 · ${item.buyer ? "buyer" : "seller"}`,
    rawType: "USER_TRADE"
  };
}

function binanceFundingRateEvent(item, fundingRate) {
  return {
    ...binanceIncomeEvent(item),
    fundingRate: finiteOrNull(fundingRate)
  };
}

async function fetchBinanceIncomePaged(config, window) {
  const startMs = Math.max(window.startMs, window.endMs - BINANCE_MAX_LOOKBACK_MS);
  const rows = [];
  for (const chunk of splitTimeRange(startMs, window.endMs, THIRTY_DAY_CHUNK_MS)) {
    for (let page = 1; page <= BINANCE_MAX_INCOME_PAGES_PER_CHUNK; page += 1) {
      const payload = await fetchBinanceSigned(config, "/fapi/v1/income", {
        startTime: String(chunk.startMs),
        endTime: String(chunk.endMs),
        limit: String(BINANCE_PAGE_LIMIT),
        page: String(page)
      });
      const pageRows = Array.isArray(payload) ? payload : [];
      rows.push(...pageRows);
      if (pageRows.length < BINANCE_PAGE_LIMIT) break;
      if (page === BINANCE_MAX_INCOME_PAGES_PER_CHUNK) {
        throw new Error("Binance income 历史超过分页上限，请缩小交易分析时间窗口。");
      }
    }
  }
  return rows;
}

async function fetchBinanceTradesForSymbol(config, symbol, window, activityTimes = []) {
  const startMs = Math.max(window.startMs, window.endMs - BINANCE_MAX_LOOKBACK_MS);
  const rows = [];
  for (const chunk of chunksForActivity(startMs, window.endMs, SEVEN_DAY_CHUNK_MS, activityTimes)) {
    let fromId = null;
    for (let page = 1; page <= BINANCE_MAX_TRADE_PAGES_PER_CHUNK; page += 1) {
      const params = {
        symbol,
        startTime: String(chunk.startMs),
        endTime: String(chunk.endMs),
        limit: String(BINANCE_PAGE_LIMIT)
      };
      if (fromId !== null) params.fromId = String(fromId);
      const payload = await fetchBinanceSigned(config, "/fapi/v1/userTrades", params);
      const pageRows = Array.isArray(payload) ? payload : [];
      rows.push(...pageRows);
      if (pageRows.length < BINANCE_PAGE_LIMIT) break;
      const ids = pageRows
        .map((row) => Number(row.id ?? row.tradeId))
        .filter(Number.isFinite);
      const maxId = ids.length ? Math.max(...ids) : null;
      if (maxId === null || maxId < Number(fromId ?? -1)) break;
      fromId = maxId + 1;
      if (page === BINANCE_MAX_TRADE_PAGES_PER_CHUNK) {
        throw new Error(`${symbol} Binance 成交明细超过分页上限，请缩小交易分析时间窗口。`);
      }
    }
  }
  return rows;
}

async function fetchBinanceFundingRates(config, symbols, window) {
  const result = new Map();
  const source = config.tradeAnalysis.binance;
  for (const symbol of symbols) {
    try {
      const payload = await fetchJson(`${normalizeBaseUrl(source.futuresBaseUrl)}/fapi/v1/fundingRate?${new URLSearchParams({
        symbol,
        startTime: String(Math.max(window.startMs, window.endMs - BINANCE_MAX_LOOKBACK_MS)),
        endTime: String(window.endMs),
        limit: "1000"
      })}`, {}, config.tradeAnalysis.requestTimeoutMs);
      for (const row of Array.isArray(payload) ? payload : []) {
        result.set(`${symbol}:${Number(row.fundingTime) || 0}`, row.fundingRate);
      }
    } catch {
      // Funding rates are enrichment only; income rows still carry the actual funding fee.
    }
  }
  return result;
}

function positionSide(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number === 0) return "";
  return number > 0 ? "long" : "short";
}

function normalizePositionQuantity(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.abs(number) : null;
}

async function fetchBinancePositions(config, symbol) {
  const rows = await fetchBinanceSigned(config, "/fapi/v3/positionRisk", {});
  return (Array.isArray(rows) ? rows : [])
    .filter((item) => Math.abs(toNumber(item.positionAmt)) > 0)
    .filter((item) => !symbol || String(item.symbol ?? "").toUpperCase() === symbol)
    .map((item) => ({
      id: `binance-position:${item.symbol}:${item.positionSide ?? "BOTH"}`,
      source: "binance",
      sourceLabel: SOURCE_LABELS.binance,
      symbol: item.symbol || "--",
      asset: "USDT",
      side: String(item.positionSide ?? "").toLowerCase() || positionSide(item.positionAmt),
      quantity: normalizePositionQuantity(item.positionAmt),
      entryPrice: finiteOrNull(item.entryPrice),
      markPrice: finiteOrNull(item.markPrice),
      notional: Math.abs(toNumber(item.notional)),
      unrealizedPnl: toNumber(item.unRealizedProfit),
      leverage: finiteOrNull(item.leverage),
      liquidationPrice: finiteOrNull(item.liquidationPrice),
      marginMode: item.marginType || "",
      updatedAt: Number(item.updateTime) || null
    }));
}

async function fetchBinanceEvents(config, window, symbol) {
  const source = config.tradeAnalysis.binance;
  if (!source.apiKey || !source.apiSecret) return missingSource("binance", ["BINANCE_API_KEY", "BINANCE_API_SECRET"]);
  const [income, positionsResult] = await Promise.allSettled([
    fetchBinanceIncomePaged(config, window),
    fetchBinancePositions(config, symbol)
  ]);
  if (income.status === "rejected") throw income.reason;
  const incomeRows = (Array.isArray(income.value) ? income.value : [])
    .filter((item) => !symbol || String(item.symbol ?? "").toUpperCase() === symbol);
  const positionSymbols = positionsResult.status === "fulfilled" ? positionsResult.value.map((item) => item.symbol).filter(Boolean) : [];
  const tradeTimesBySymbol = new Map();
  for (const row of incomeRows) {
    const rowSymbol = String(row.symbol ?? "");
    if (!rowSymbol || !["COMMISSION", "REALIZED_PNL"].includes(row.incomeType)) continue;
    const times = tradeTimesBySymbol.get(rowSymbol) ?? [];
    times.push(Number(row.time));
    tradeTimesBySymbol.set(rowSymbol, times);
  }
  const tradeSymbols = Array.from(new Set([
    ...tradeTimesBySymbol.keys(),
    ...positionSymbols
  ])).filter((item) => !symbol || item === symbol);
  const tradeResults = await mapLimit(tradeSymbols, 3, (tradeSymbol) =>
    fetchBinanceTradesForSymbol(config, tradeSymbol, window, tradeTimesBySymbol.get(tradeSymbol) ?? [])
  );
  const tradeResultEntries = tradeResults.map((result, index) => ({ symbol: tradeSymbols[index], result }));
  const tradeRows = tradeResultEntries.flatMap(({ result }) => result.status === "fulfilled" ? result.value : []);
  const fundingSymbols = Array.from(new Set(incomeRows.filter((item) => item.incomeType === "FUNDING_FEE").map((item) => item.symbol).filter(Boolean)));
  const fundingRates = await fetchBinanceFundingRates(config, fundingSymbols, window);
  const tradeEvents = tradeRows.map(binanceTradeEvent);
  const incomeEvents = incomeRows
    .map((item) => item.incomeType === "FUNDING_FEE"
      ? binanceFundingRateEvent(item, fundingRates.get(`${item.symbol}:${Number(item.time) || 0}`))
      : binanceIncomeEvent(item));
  const events = uniqueById([...tradeEvents, ...incomeEvents]);
  const sourceResult = okSource("binance", events, positionsResult.status === "fulfilled" ? positionsResult.value : []);
  sourceResult.rawEventCount = incomeRows.length + tradeRows.length;
  sourceResult.rangeNote = "Binance 收益/成交历史最多覆盖最近约 3 个月；成交明细按 7 天切片抓取。";
  const rejectedTradeResults = tradeResultEntries.filter(({ result }) => result.status === "rejected");
  if (rejectedTradeResults.length) {
    const firstReason = rejectedTradeResults[0].result.reason;
    const firstError = firstReason instanceof Error ? firstReason.message : String(firstReason);
    sourceResult.tradeError = `成交明细 ${rejectedTradeResults.length} 个币种读取失败：${firstError}`;
  }
  if (positionsResult.status === "rejected") sourceResult.positionError = positionsResult.reason instanceof Error ? positionsResult.reason.message : String(positionsResult.reason);
  return sourceResult;
}

function hyperliquidFillEvent(item) {
  const fee = Math.abs(toNumber(item.fee));
  const price = finiteOrNull(item.px);
  const quantity = finiteOrNull(item.sz);
  const realizedPnl = toNumber(item.closedPnl);
  return {
    id: `hyperliquid:${item.hash ?? item.oid ?? item.time}:${item.tid ?? item.startPosition ?? ""}`,
    source: "hyperliquid",
    sourceLabel: SOURCE_LABELS.hyperliquid,
    symbol: item.coin || "--",
    asset: "USDC",
    time: Number(item.time) || null,
    type: item.dir || "fill",
    side: item.side || "",
    direction: item.dir || normalizeTradeAction({ source: "hyperliquid", side: item.side }),
    quantity,
    price,
    notional: price && quantity ? price * quantity : null,
    fundingRate: null,
    realizedPnl,
    funding: 0,
    commission: -fee,
    feeAsset: item.feeToken || "USDC",
    net: realizedPnl - fee,
    pnlIncluded: true,
    orderId: item.oid || "",
    tradeId: item.tid || "",
    liquidity: item.crossed ? "taker" : "maker",
    note: `start ${item.startPosition ?? "--"}`,
    rawType: "FILL"
  };
}

function hyperliquidFundingEvent(item) {
  const delta = item.delta ?? item;
  const amount = toNumber(delta.usdc ?? delta.funding ?? item.usdc);
  return {
    id: `hyperliquid-funding:${item.time ?? delta.time}:${delta.coin ?? item.coin}`,
    source: "hyperliquid",
    sourceLabel: SOURCE_LABELS.hyperliquid,
    symbol: delta.coin || item.coin || "--",
    asset: "USDC",
    time: Number(item.time ?? delta.time) || null,
    type: "funding",
    side: "",
    direction: "Funding",
    quantity: finiteOrNull(delta.szi),
    price: null,
    notional: null,
    fundingRate: finiteOrNull(delta.fundingRate),
    realizedPnl: 0,
    funding: amount,
    commission: 0,
    feeAsset: "USDC",
    net: amount,
    pnlIncluded: true,
    orderId: "",
    tradeId: item.hash || "",
    note: `samples ${delta.nSamples ?? "--"}`,
    rawType: "FUNDING"
  };
}

async function fetchHyperliquidInfo(config, body) {
  const source = config.tradeAnalysis.hyperliquid;
  return fetchJson(normalizeBaseUrl(source.infoBaseUrl), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  }, config.tradeAnalysis.requestTimeoutMs);
}

function hyperliquidPerpDexs(source) {
  const configuredDexs = Array.isArray(source.perpDexs)
    ? source.perpDexs
    : String(source.perpDexs ?? "").split(",");
  const dexs = ["", ...configuredDexs]
    .map((dex) => String(dex ?? "").trim())
    .filter((dex, index, all) => all.indexOf(dex) === index);
  return dexs.length ? dexs : [""];
}

function hyperliquidClearinghouseRequest(source, dex) {
  const request = {
    type: "clearinghouseState",
    user: source.walletAddress
  };
  if (dex) request.dex = dex;
  return request;
}

function hyperliquidPositionSymbol(position, dex) {
  const coin = String(position.coin || "").trim();
  if (!dex || !coin || coin.toLowerCase().startsWith(`${dex.toLowerCase()}:`)) return coin || "--";
  return `${dex}:${coin}`;
}

function hyperliquidPositionFromApi(position, payload, dex) {
  const symbol = hyperliquidPositionSymbol(position, dex);
  return {
    id: `hyperliquid-position:${dex || "default"}:${symbol}`,
    source: "hyperliquid",
    sourceLabel: SOURCE_LABELS.hyperliquid,
    symbol,
    asset: "USDC",
    side: positionSide(position.szi ?? position.size),
    quantity: normalizePositionQuantity(position.szi ?? position.size),
    entryPrice: finiteOrNull(position.entryPx),
    markPrice: null,
    notional: Math.abs(toNumber(position.positionValue)),
    unrealizedPnl: toNumber(position.unrealizedPnl),
    leverage: finiteOrNull(position.leverage?.value ?? position.leverage),
    liquidationPrice: finiteOrNull(position.liquidationPx),
    marginMode: position.leverage?.type || "",
    updatedAt: Number(payload.time) || null
  };
}

async function fetchHyperliquidPositions(config, symbol) {
  const source = config.tradeAnalysis.hyperliquid;
  const dexs = hyperliquidPerpDexs(source);
  const results = await Promise.allSettled(dexs.map(async (dex) => ({
    dex,
    payload: await fetchHyperliquidInfo(config, hyperliquidClearinghouseRequest(source, dex))
  })));
  const fulfilled = results.filter((result) => result.status === "fulfilled");
  if (!fulfilled.length) throw results[0]?.reason ?? new Error("Hyperliquid 持仓读取失败");
  const positions = fulfilled.flatMap(({ value }) =>
    (Array.isArray(value.payload?.assetPositions) ? value.payload.assetPositions : [])
      .map((item) => item.position ?? item)
      .filter((position) => Math.abs(toNumber(position.szi ?? position.size)) > 0)
      .map((position) => hyperliquidPositionFromApi(position, value.payload, value.dex))
      .filter((position) => symbolMatchesValue(position.symbol, symbol))
  );
  const rejected = results.filter((result) => result.status === "rejected");
  return {
    positions,
    error: rejected.length
      ? `部分 Hyperliquid dex 持仓读取失败：${rejected.map((result) => describeError(result.reason)).join("；")}`
      : ""
  };
}

async function fetchHyperliquidEvents(config, window, symbol) {
  const source = config.tradeAnalysis.hyperliquid;
  if (!source.walletAddress) return missingSource("hyperliquid", ["HYPERLIQUID_WALLET_ADDRESS"]);
  async function fetchFillsPaged() {
    const rows = [];
    let cursor = window.startMs;
    for (let page = 0; page < 25 && cursor <= window.endMs; page += 1) {
      const payload = await fetchHyperliquidInfo(config, {
        type: "userFillsByTime",
        user: source.walletAddress,
        startTime: cursor,
        endTime: window.endMs,
        aggregateByTime: true
      });
      const pageRows = Array.isArray(payload) ? payload : payload?.fills ?? payload?.data ?? [];
      rows.push(...pageRows);
      if (pageRows.length < HYPERLIQUID_PAGE_LIMIT) break;
      const lastTime = Math.max(...pageRows.map((row) => Number(row.time)).filter(Number.isFinite));
      if (!Number.isFinite(lastTime) || lastTime < cursor) break;
      cursor = lastTime + 1;
    }
    return rows;
  }
  async function fetchFundingPaged() {
    const rows = [];
    let cursor = window.startMs;
    for (let page = 0; page < 25 && cursor <= window.endMs; page += 1) {
      const payload = await fetchHyperliquidInfo(config, {
        type: "userFunding",
        user: source.walletAddress,
        startTime: cursor,
        endTime: window.endMs
      });
      const pageRows = Array.isArray(payload) ? payload : payload?.data ?? [];
      rows.push(...pageRows);
      if (pageRows.length < HYPERLIQUID_PAGE_LIMIT) break;
      const lastTime = Math.max(...pageRows.map((row) => Number(row.time)).filter(Number.isFinite));
      if (!Number.isFinite(lastTime) || lastTime < cursor) break;
      cursor = lastTime + 1;
    }
    return rows;
  }
  const [fillsResult, positionsResult] = await Promise.allSettled([
    fetchFillsPaged(),
    fetchHyperliquidPositions(config, symbol)
  ]);
  if (fillsResult.status === "rejected") throw fillsResult.reason;
  const fillsPayload = fillsResult.value;
  const fills = (Array.isArray(fillsPayload) ? fillsPayload : [])
    .filter((item) => symbolMatchesValue(item.coin, symbol))
    .map(hyperliquidFillEvent);
  let funding = [];
  try {
    const fundingPayload = await fetchFundingPaged();
    funding = (Array.isArray(fundingPayload) ? fundingPayload : [])
      .filter((item) => symbolMatchesValue(item.delta?.coin ?? item.coin, symbol))
      .map(hyperliquidFundingEvent);
  } catch (error) {
    funding = [];
  }
  const positionsPayload = positionsResult.status === "fulfilled" ? positionsResult.value : { positions: [], error: "" };
  const sourceResult = okSource("hyperliquid", [...fills, ...funding], positionsPayload.positions);
  sourceResult.rawEventCount = fills.length + funding.length;
  sourceResult.rangeNote = "Hyperliquid fills/funding 按时间向后分页抓取；fills 官方单次最多 2000 条，最近最多 10000 条。";
  if (positionsPayload.error) sourceResult.positionError = positionsPayload.error;
  if (positionsResult.status === "rejected") sourceResult.positionError = positionsResult.reason instanceof Error ? positionsResult.reason.message : String(positionsResult.reason);
  return sourceResult;
}

function missingSource(id, missing) {
  return {
    id,
    label: SOURCE_LABELS[id],
    configured: false,
    ok: false,
    missing,
    error: `缺少 ${missing.join("、")}`,
    eventCount: 0,
    positionCount: 0,
    events: [],
    positions: []
  };
}

function okSource(id, events, positions = []) {
  return {
    id,
    label: SOURCE_LABELS[id],
    configured: true,
    ok: true,
    missing: [],
    error: "",
    eventCount: events.length,
    positionCount: positions.length,
    events,
    positions
  };
}

function errorSource(id, error) {
  return {
    id,
    label: SOURCE_LABELS[id],
    configured: true,
    ok: false,
    missing: [],
    error: describeError(error),
    eventCount: 0,
    positionCount: 0,
    events: [],
    positions: []
  };
}

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

function buildTradeAnalysisPayload({
  window,
  safeSymbol,
  connectionStatus,
  sourceResults,
  history,
  positions,
  maxEventRows,
  mode
}) {
  const safePositions = Array.isArray(positions) ? positions : [];
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
    summary: history.summary,
    symbolSummary: history.symbolSummary,
    tradeRows: {
      items: history.summary.bySymbol,
      total: history.symbolSummary.total,
      page: history.symbolSummary.page,
      pageSize: history.symbolSummary.pageSize
    },
    positionSummary,
    positions: safePositions,
    persistence: {
      enabled: history.persisted,
      error: history.persisted ? "" : history.persistError
    },
    eventCount: history.eventCount + safePositions.length,
    eventLimit: maxEventRows,
    events: events.slice(0, maxEventRows)
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
    const sourceResults = snapshotSourceResults(connectionStatus);
    const history = await readTradeEventHistoryAnalysis({
      startMs: window.startMs,
      endMs: window.endMs,
      symbol: safeSymbol,
      page: safePage,
      pageSize: safePageSize,
      eventLimit: config.tradeAnalysis.maxEventRows
    });
    const snapshotHistory = {
      ...history,
      summary: {
        ...history.summary,
        bySource: mergeSourceSummaries(history.summary.bySource, sourceResults)
      },
      persisted: true,
      persistError: ""
    };
    return buildTradeAnalysisPayload({
      window,
      safeSymbol,
      connectionStatus,
      sourceResults,
      history: snapshotHistory,
      positions: [],
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
  if (cachedSync) {
    sourceResults = cachedSync.sourceResults;
    tradeEvents = cachedSync.tradeEvents;
    positions = cachedSync.positions;
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
  return buildTradeAnalysisPayload({
    window,
    safeSymbol,
    connectionStatus,
    sourceResults,
    history,
    positions,
    maxEventRows: config.tradeAnalysis.maxEventRows,
    mode: "refresh"
  });
}
