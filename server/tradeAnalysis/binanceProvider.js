import crypto from "node:crypto";
import {
  absNegative,
  chunksForActivity,
  describeError,
  fetchJson,
  finiteOrNull,
  mapLimit,
  missingSource,
  nonPnlNote,
  normalizeBaseUrl,
  normalizePositionQuantity,
  normalizeTradeAction,
  okSource,
  positionSide,
  retryTransient,
  SOURCE_LABELS,
  splitTimeRange,
  symbolMatchesValue,
  toNumber,
  uniqueById
} from "./shared.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const BINANCE_MAX_LOOKBACK_MS = 90 * DAY_MS;
const SEVEN_DAY_CHUNK_MS = (7 * DAY_MS) - 1;
const THIRTY_DAY_CHUNK_MS = (30 * DAY_MS) - 1;
const BINANCE_PAGE_LIMIT = 1000;
const BINANCE_MAX_INCOME_PAGES_PER_CHUNK = 100;
const BINANCE_MAX_TRADE_PAGES_PER_CHUNK = 50;
const BINANCE_PNL_INCOME_TYPES = new Set(["REALIZED_PNL", "FUNDING_FEE", "COMMISSION"]);

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
  const settled = await mapLimit(symbols, source.fundingRateConcurrency, async (symbol) => {
    const payload = await fetchJson(`${normalizeBaseUrl(source.futuresBaseUrl)}/fapi/v1/fundingRate?${new URLSearchParams({
      symbol,
      startTime: String(Math.max(window.startMs, window.endMs - BINANCE_MAX_LOOKBACK_MS)),
      endTime: String(window.endMs),
      limit: "1000"
    })}`, {}, config.tradeAnalysis.requestTimeoutMs);
    return { symbol, rows: Array.isArray(payload) ? payload : [] };
  });
  for (const item of settled) {
    if (item.status !== "fulfilled") continue;
    try {
      for (const row of item.value.rows) {
        result.set(`${item.value.symbol}:${Number(row.fundingTime) || 0}`, row.fundingRate);
      }
    } catch {
      // Funding rates are enrichment only; income rows still carry the actual funding fee.
    }
  }
  return result;
}

function positionFundingWindow(config) {
  const lookbackDays = Math.max(1, Number(config.tradeAnalysis.defaultLookbackDays) || 90);
  const lookbackMs = Math.min(BINANCE_MAX_LOOKBACK_MS, lookbackDays * DAY_MS);
  const endMs = Date.now();
  return { startMs: endMs - lookbackMs + 1, endMs };
}

async function fetchBinanceSettledFundingBySymbol(config, symbols = []) {
  const safeSymbols = new Set(
    symbols
      .map((symbol) => String(symbol ?? "").toUpperCase().replace(/[^A-Z0-9_]/g, ""))
      .filter(Boolean)
  );
  if (!safeSymbols.size) return new Map();
  const source = config.tradeAnalysis.binance;
  const window = positionFundingWindow(config);
  const settled = await mapLimit(
    Array.from(safeSymbols),
    source.fundingRateConcurrency,
    async (symbol) => {
      let total = 0;
      for (const chunk of splitTimeRange(window.startMs, window.endMs, THIRTY_DAY_CHUNK_MS)) {
        for (let page = 1; page <= BINANCE_MAX_INCOME_PAGES_PER_CHUNK; page += 1) {
          const payload = await fetchBinanceSigned(config, "/fapi/v1/income", {
            symbol,
            incomeType: "FUNDING_FEE",
            startTime: String(chunk.startMs),
            endTime: String(chunk.endMs),
            limit: String(BINANCE_PAGE_LIMIT),
            page: String(page)
          });
          const pageRows = Array.isArray(payload) ? payload : [];
          for (const row of pageRows) {
            if (row.incomeType === "FUNDING_FEE" && symbolMatchesValue(row.symbol, symbol)) {
              total += toNumber(row.income);
            }
          }
          if (pageRows.length < BINANCE_PAGE_LIMIT) break;
          if (page === BINANCE_MAX_INCOME_PAGES_PER_CHUNK) {
            throw new Error(`${symbol} Binance 资金费历史超过分页上限，请缩短交易分析默认窗口。`);
          }
        }
      }
      return { symbol, total };
    }
  );
  const result = new Map();
  for (const item of settled) {
    if (item.status === "fulfilled") result.set(item.value.symbol, item.value.total);
  }
  return result;
}

async function fetchBinancePositions(config, symbol) {
  const rows = await fetchBinanceSigned(config, "/fapi/v3/positionRisk", {});
  const positions = (Array.isArray(rows) ? rows : [])
    .filter((item) => Math.abs(toNumber(item.positionAmt)) > 0)
    .filter((item) => symbolMatchesValue(item.symbol, symbol))
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
  if (!positions.length) return positions;
  let fundingBySymbol = null;
  try {
    fundingBySymbol = await fetchBinanceSettledFundingBySymbol(config, positions.map((position) => position.symbol));
  } catch {
    fundingBySymbol = null;
  }
  return positions.map((position) => ({
    ...position,
    settledFunding: fundingBySymbol ? fundingBySymbol.get(position.symbol) ?? 0 : null
  }));
}

export async function fetchBinanceEvents(config, window, symbol) {
  const source = config.tradeAnalysis.binance;
  if (!source.apiKey || !source.apiSecret) return missingSource("binance", ["BINANCE_API_KEY", "BINANCE_API_SECRET"]);
  const [income, positionsResult] = await Promise.allSettled([
    fetchBinanceIncomePaged(config, window),
    retryTransient(() => fetchBinancePositions(config, symbol))
  ]);
  if (income.status === "rejected") throw income.reason;
  const incomeRows = (Array.isArray(income.value) ? income.value : [])
    .filter((item) => symbolMatchesValue(item.symbol, symbol));
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
  ])).filter((item) => symbolMatchesValue(item, symbol));
  const tradeResults = await mapLimit(tradeSymbols, 3, (tradeSymbol) =>
    retryTransient(() => fetchBinanceTradesForSymbol(config, tradeSymbol, window, tradeTimesBySymbol.get(tradeSymbol) ?? []))
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
    sourceResult.tradeError = `成交明细 ${rejectedTradeResults.length} 个币种读取失败：${describeError(firstReason)}`;
  }
  if (positionsResult.status === "rejected") sourceResult.positionError = describeError(positionsResult.reason);
  return sourceResult;
}

export async function fetchBinancePositionSource(config, symbol = "") {
  const source = config.tradeAnalysis.binance;
  if (!source.apiKey || !source.apiSecret) return missingSource("binance", ["BINANCE_API_KEY", "BINANCE_API_SECRET"]);
  const positions = await fetchBinancePositions(config, symbol);
  return okSource("binance", [], positions);
}
