import { config } from "./config.js";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

class RequestWeightLimiter {
  constructor() {
    this.windowStartedAt = Date.now();
    this.usedWeight = 0;
    this.queue = Promise.resolve();
  }

  budget() {
    return Math.max(1, config.binance.requestWeightBudgetPerMinute);
  }

  resetIfNeeded() {
    if (Date.now() - this.windowStartedAt >= 60_000) {
      this.windowStartedAt = Date.now();
      this.usedWeight = 0;
    }
  }

  msUntilReset() {
    this.resetIfNeeded();
    return Math.max(0, 60_000 - (Date.now() - this.windowStartedAt));
  }

  async take(weight) {
    const safeWeight = Math.max(1, Number(weight) || 1);
    const run = async () => {
      while (true) {
        this.resetIfNeeded();
        if (this.usedWeight + safeWeight <= this.budget()) {
          this.usedWeight += safeWeight;
          return;
        }
        await sleep(this.msUntilReset() + 100);
      }
    };
    this.queue = this.queue.then(run, run);
    return this.queue;
  }

  syncFromHeaders(headers) {
    const used = Number(headers.get("x-mbx-used-weight-1m") ?? headers.get("X-MBX-USED-WEIGHT-1M"));
    if (!Number.isFinite(used)) return;
    if (used < this.usedWeight && Date.now() - this.windowStartedAt > 1000) {
      this.windowStartedAt = Date.now();
      this.usedWeight = used;
      return;
    }
    this.usedWeight = Math.max(this.usedWeight, used);
  }
}

const requestWeightLimiter = new RequestWeightLimiter();

function retryAfterMs(headers) {
  const retryAfter = headers.get("retry-after");
  if (!retryAfter) return null;
  const seconds = Number(retryAfter);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = new Date(retryAfter);
  return Number.isNaN(date.getTime()) ? null : Math.max(0, date.getTime() - Date.now());
}

function retryDelay(attempt) {
  const baseDelay = config.binance.retryDelayMs * 2 ** Math.max(0, attempt);
  return Math.round(baseDelay + Math.random() * baseDelay * 0.25);
}

function describeFetchError(error) {
  const message = error instanceof Error ? error.message : String(error);
  const cause = error?.cause;
  const code = cause?.code ?? error?.code;
  const causeMessage = cause?.message && cause.message !== message ? `: ${cause.message}` : "";
  return `${message}${code ? ` (${code})` : ""}${causeMessage}`;
}

async function fetchJson(url, label, options = {}) {
  const weight = options.weight ?? 1;
  const retries = options.retries ?? config.binance.requestRetries;
  const timeoutMs = options.timeoutMs ?? config.binance.requestTimeoutMs;

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    await requestWeightLimiter.take(weight);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, {
        signal: controller.signal,
        headers: options.headers ?? {}
      });
      requestWeightLimiter.syncFromHeaders(response.headers);
      if (response.ok) return await response.json();

      const body = await response.text().catch(() => "");
      if ([408, 429, 503].includes(response.status) && attempt < retries) {
        const waitMs =
          response.status === 429
            ? retryAfterMs(response.headers) ?? requestWeightLimiter.msUntilReset() + 1000
            : retryDelay(attempt);
        await sleep(waitMs);
        continue;
      }
      if (response.status === 418 && attempt < retries) {
        await sleep(retryAfterMs(response.headers) ?? 120_000);
        continue;
      }
      const error = new Error(`${label} HTTP ${response.status}${body ? `: ${body.slice(0, 300)}` : ""}`);
      error.retryable = false;
      throw error;
    } catch (error) {
      if (error?.retryable === false || attempt >= retries) {
        if (error?.retryable === false) throw error;
        const wrapped = new Error(`${label} ${describeFetchError(error)}`, { cause: error });
        wrapped.code = error?.cause?.code ?? error?.code;
        throw wrapped;
      }
      await sleep(retryDelay(attempt));
    } finally {
      clearTimeout(timer);
    }
  }
}

function normalizeBaseAsset(value) {
  return String(value ?? "")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");
}

function collectAlphaAssets(value, output = new Set()) {
  if (Array.isArray(value)) {
    for (const item of value) collectAlphaAssets(item, output);
    return output;
  }
  if (!value || typeof value !== "object") return output;

  for (const key of ["symbol", "tokenSymbol", "asset", "baseAsset", "name"]) {
    const normalized = normalizeBaseAsset(value[key]);
    if (normalized && normalized.length <= 16 && !normalized.endsWith("USDT")) output.add(normalized);
    if (normalized.endsWith("USDT")) output.add(normalized.slice(0, -4));
  }
  for (const nested of Object.values(value)) {
    if (Array.isArray(nested) || (nested && typeof nested === "object")) collectAlphaAssets(nested, output);
  }
  return output;
}

const EXCLUDED_BASE_ASSETS = new Set([
  "USDT",
  "USDC",
  "FDUSD",
  "TUSD",
  "USDP",
  "BUSD",
  "DAI",
  "USTC",
  "EUR",
  "EURI",
  "AEUR",
  "PAXG",
  "XAUT",
  "GOLD",
  "SILVER",
  "OIL",
  "WTI",
  "BRENT"
]);

function isAllowedCryptoAsset(asset) {
  const normalized = normalizeBaseAsset(asset);
  if (!normalized || EXCLUDED_BASE_ASSETS.has(normalized)) return false;
  if (/^(USD|EUR|GBP|JPY|AUD|CAD|CHF|TRY|BRL|ARS|MXN|RUB|HKD|SGD|CNH)/.test(normalized)) return false;
  if (/(GOLD|SILVER|OIL|STOCK|ETF|BOND|TREASURY)$/.test(normalized)) return false;
  return true;
}

export async function discoverTargetTokens() {
  const [futuresInfo, spotInfo, alphaInfo] = await Promise.all([
    fetchJson(`${config.binance.futuresBaseUrl}/fapi/v1/exchangeInfo`, "Binance futures exchangeInfo"),
    fetchJson(`${config.binance.spotBaseUrl}/api/v3/exchangeInfo`, "Binance spot exchangeInfo"),
    fetchJson(config.binance.alphaTokenListUrl, "Binance Alpha token list")
  ]);

  const futuresSymbols = new Map();
  for (const item of futuresInfo.symbols ?? []) {
    if (item.quoteAsset !== "USDT") continue;
    if (item.contractType && item.contractType !== "PERPETUAL") continue;
    if (item.status !== "TRADING") continue;
    if (!isAllowedCryptoAsset(item.baseAsset)) continue;
    futuresSymbols.set(item.symbol, {
      symbol: item.symbol,
      baseAsset: normalizeBaseAsset(item.baseAsset),
      hasFutures: true
    });
  }

  const spotSymbols = new Map();
  const spotBaseAssets = new Set();
  for (const item of spotInfo.symbols ?? []) {
    if (item.quoteAsset !== "USDT") continue;
    if (item.status !== "TRADING") continue;
    spotSymbols.set(item.symbol, item);
    spotBaseAssets.add(normalizeBaseAsset(item.baseAsset));
  }

  const alphaAssets = collectAlphaAssets(alphaInfo?.data ?? alphaInfo);
  const tokens = [];
  for (const token of futuresSymbols.values()) {
    const hasSpot = spotSymbols.has(token.symbol) || spotBaseAssets.has(token.baseAsset);
    const isAlpha = alphaAssets.has(token.baseAsset);
    if (isAlpha && !hasSpot) {
      tokens.push({
        ...token,
        categoryType: "A",
        categoryLabel: "Alpha合约无现货",
        hasSpot: false,
        isAlpha: true
      });
    } else if (hasSpot) {
      tokens.push({
        ...token,
        categoryType: "B",
        categoryLabel: "现货+合约",
        hasSpot: true,
        isAlpha
      });
    }
  }

  return tokens.sort((a, b) => a.categoryType.localeCompare(b.categoryType) || a.symbol.localeCompare(b.symbol));
}

function intervalMs(intervalCode) {
  return {
    "15m": 15 * 60 * 1000,
    "1h": 60 * 60 * 1000,
    "4h": 4 * 60 * 60 * 1000,
    "1d": 24 * 60 * 60 * 1000
  }[intervalCode];
}

function klineRequestWeight(limit) {
  if (limit < 100) return 1;
  if (limit < 500) return 2;
  if (limit <= 1000) return 5;
  return 10;
}

function klineLimit(value = config.crawler.klineLimit) {
  return Math.max(1, Math.min(1500, Math.floor(Number(value) || config.crawler.klineLimit)));
}

export async function fetchKlinesPaged({ symbol, intervalCode, startTime, endTime, limit: requestedLimit, onPage, shouldContinue }) {
  let cursor = startTime;
  let pageCount = 0;
  const limit = klineLimit(requestedLimit);
  while (cursor <= endTime && (!shouldContinue || shouldContinue())) {
    const url = new URL(`${config.binance.futuresBaseUrl}/fapi/v1/klines`);
    url.searchParams.set("symbol", symbol);
    url.searchParams.set("interval", intervalCode);
    url.searchParams.set("startTime", String(cursor));
    url.searchParams.set("endTime", String(endTime));
    url.searchParams.set("limit", String(limit));

    const page = await fetchJson(url.toString(), `${symbol} ${intervalCode} klines`, {
      weight: klineRequestWeight(limit),
      retries: config.binance.klineRequestRetries
    });
    if (!Array.isArray(page) || page.length === 0) break;
    await onPage(page);
    pageCount += 1;

    const lastOpenTime = Number(page[page.length - 1][0]);
    const nextCursor = lastOpenTime + intervalMs(intervalCode);
    if (!Number.isFinite(nextCursor) || nextCursor <= cursor) break;
    cursor = nextCursor;
    if (page.length < limit) break;
    await sleep(config.crawler.pageDelayMs);
  }
  return pageCount;
}

export async function fetchRecentKlines({ symbol, intervalCode, limit = 3 }) {
  const safeLimit = Math.max(1, Math.min(100, Number(limit) || 3));
  const url = new URL(`${config.binance.futuresBaseUrl}/fapi/v1/klines`);
  url.searchParams.set("symbol", symbol);
  url.searchParams.set("interval", intervalCode);
  url.searchParams.set("limit", String(safeLimit));
  const page = await fetchJson(url.toString(), `${symbol} ${intervalCode} recent klines`, {
    weight: klineRequestWeight(safeLimit),
    retries: config.binance.klineRequestRetries
  });
  return Array.isArray(page) ? page : [];
}

function normalizeFundingInfoItem(item) {
  const symbol = String(item?.symbol ?? "").toUpperCase().replace(/[^A-Z0-9_]/g, "");
  const fundingIntervalHours = Number(item?.fundingIntervalHours);
  if (!symbol || !Number.isFinite(fundingIntervalHours)) return null;
  return {
    symbol,
    fundingIntervalHours: Math.max(0, Math.floor(fundingIntervalHours)),
    adjustedFundingRateCap: item.adjustedFundingRateCap ?? null,
    adjustedFundingRateFloor: item.adjustedFundingRateFloor ?? null,
    disclaimer: Boolean(item.disclaimer)
  };
}

export async function fetchFundingInfo() {
  const data = await fetchJson(`${config.binance.futuresBaseUrl}/fapi/v1/fundingInfo`, "Binance funding info", {
    weight: 0
  });
  return Array.isArray(data) ? data.map(normalizeFundingInfoItem).filter(Boolean) : [];
}

export async function fetchCurrentFundingRates() {
  const data = await fetchJson(`${config.binance.futuresBaseUrl}/fapi/v1/premiumIndex`, "Binance premium index", {
    weight: 10
  });
  if (!Array.isArray(data)) return [];
  return data
    .map((item) => {
      const symbol = String(item?.symbol ?? "").toUpperCase().replace(/[^A-Z0-9_]/g, "");
      const currentFundingRate = Number(item?.lastFundingRate);
      const nextFundingTime = Number(item?.nextFundingTime);
      if (!symbol) return null;
      return {
        symbol,
        currentFundingRate: Number.isFinite(currentFundingRate) ? currentFundingRate : null,
        nextFundingTime: Number.isFinite(nextFundingTime) && nextFundingTime > 0 ? nextFundingTime : null
      };
    })
    .filter(Boolean);
}

export async function fetchMarkPrices(options = {}) {
  const data = await fetchJson(`${config.binance.futuresBaseUrl}/fapi/v1/premiumIndex`, "Binance premium index", {
    weight: 10,
    ...options
  });
  if (!Array.isArray(data)) return [];
  return data
    .map((item) => {
      const symbol = String(item?.symbol ?? "").toUpperCase().replace(/[^A-Z0-9_]/g, "");
      const markPrice = Number(item?.markPrice);
      if (!symbol || !Number.isFinite(markPrice)) return null;
      return { symbol, markPrice };
    })
    .filter(Boolean);
}

let futuresTicker24hCache = {
  expiresAt: 0,
  tickers: new Map()
};
const FUTURES_TICKER_24H_RETRY_MS = 5_000;

function futuresTicker24hCacheTtlMs() {
  return Math.max(1000, Number(config.binance.ticker24hCacheMs) || 30_000);
}

function hasFuturesTicker24hCache() {
  return futuresTicker24hCache.tickers instanceof Map && futuresTicker24hCache.tickers.size > 0;
}

function normalizeFuturesTicker24hr(item) {
  const symbol = String(item?.symbol ?? "").toUpperCase().replace(/[^A-Z0-9_]/g, "");
  const priceChange24hPct = Number(item?.priceChangePercent);
  const lastPrice = Number(item?.lastPrice);
  if (!symbol) return null;
  return {
    symbol,
    priceChange24hPct: Number.isFinite(priceChange24hPct) ? priceChange24hPct : null,
    lastPrice: Number.isFinite(lastPrice) ? lastPrice : null
  };
}

export function clearFuturesTicker24hrCache() {
  futuresTicker24hCache = {
    expiresAt: 0,
    tickers: new Map()
  };
}

export async function fetchFuturesTicker24hr(symbol) {
  const safeSymbol = String(symbol ?? "").toUpperCase().replace(/[^A-Z0-9_]/g, "");
  if (!safeSymbol) throw new Error("symbol is required for 24h ticker");
  const cached = futuresTicker24hCache.tickers.get(safeSymbol) ?? null;
  if (cached && Date.now() < futuresTicker24hCache.expiresAt) return cached;

  const url = new URL(`${config.binance.futuresBaseUrl}/fapi/v1/ticker/24hr`);
  url.searchParams.set("symbol", safeSymbol);
  try {
    const item = await fetchJson(url.toString(), `${safeSymbol} 24h ticker`, {
      weight: 1,
      retries: Math.min(1, config.binance.requestRetries),
      timeoutMs: Math.min(config.binance.requestTimeoutMs, 5000)
    });
    const normalized = normalizeFuturesTicker24hr(item);
    if (!normalized) throw new Error(`${safeSymbol} 24h ticker returned invalid payload`);
    futuresTicker24hCache.tickers.set(safeSymbol, normalized);
    futuresTicker24hCache.expiresAt = Date.now() + futuresTicker24hCacheTtlMs();
    return normalized;
  } catch (error) {
    if (cached) {
      futuresTicker24hCache.expiresAt = Date.now() + FUTURES_TICKER_24H_RETRY_MS;
      return cached;
    }
    throw error;
  }
}

export async function fetchFuturesTicker24hrMap(symbols = []) {
  const safeSymbols = [...new Set(
    (Array.isArray(symbols) ? symbols : [symbols])
      .map((symbol) => String(symbol ?? "").toUpperCase().replace(/[^A-Z0-9_]/g, ""))
      .filter(Boolean)
  )];
  if (!safeSymbols.length) return new Map();

  const now = Date.now();
  if (now >= futuresTicker24hCache.expiresAt) {
    try {
      const data = await fetchJson(`${config.binance.futuresBaseUrl}/fapi/v1/ticker/24hr`, "Binance 24h tickers", {
        weight: 40,
        retries: Math.min(1, config.binance.requestRetries),
        timeoutMs: Math.min(config.binance.requestTimeoutMs, 5000)
      });
      const tickers = new Map();
      if (Array.isArray(data)) {
        for (const item of data) {
          const normalized = normalizeFuturesTicker24hr(item);
          if (normalized) tickers.set(normalized.symbol, normalized);
        }
      }
      if (!tickers.size && hasFuturesTicker24hCache()) {
        futuresTicker24hCache.expiresAt = now + FUTURES_TICKER_24H_RETRY_MS;
      } else {
        futuresTicker24hCache = {
          expiresAt: now + futuresTicker24hCacheTtlMs(),
          tickers
        };
      }
    } catch (error) {
      if (!hasFuturesTicker24hCache()) throw error;
      futuresTicker24hCache.expiresAt = now + FUTURES_TICKER_24H_RETRY_MS;
    }
  }

  return new Map(safeSymbols.map((symbol) => [symbol, futuresTicker24hCache.tickers.get(symbol) ?? null]));
}

export async function fetchOpenInterest({ symbol }) {
  const safeSymbol = String(symbol ?? "").toUpperCase().replace(/[^A-Z0-9_]/g, "");
  if (!safeSymbol) throw new Error("symbol is required for open interest");
  const url = new URL(`${config.binance.futuresBaseUrl}/fapi/v1/openInterest`);
  url.searchParams.set("symbol", safeSymbol);
  const item = await fetchJson(url.toString(), `${safeSymbol} open interest`, {
    weight: 1,
    retries: config.openInterestMonitor.requestRetries,
    timeoutMs: config.openInterestMonitor.requestTimeoutMs
  });
  const openInterest = Number(item?.openInterest);
  const time = Number(item?.time);
  if (!Number.isFinite(openInterest) || !Number.isFinite(time)) {
    throw new Error(`${safeSymbol} open interest returned invalid payload`);
  }
  return {
    symbol: String(item?.symbol ?? safeSymbol).toUpperCase(),
    openInterest,
    time
  };
}

export async function fetchOpenInterestHistory({ symbol, period = "5m", limit = 289 }) {
  const safePeriod = ["5m", "15m", "30m", "1h", "2h", "4h", "6h", "12h", "1d"].includes(period)
    ? period
    : "5m";
  const safeLimit = Math.max(2, Math.min(500, Number(limit) || 289));
  const url = new URL(`${config.binance.futuresBaseUrl}/futures/data/openInterestHist`);
  url.searchParams.set("symbol", symbol);
  url.searchParams.set("period", safePeriod);
  url.searchParams.set("limit", String(safeLimit));
  const data = await fetchJson(url.toString(), `${symbol} open interest history`, {
    weight: 0,
    retries: config.openInterestMonitor.requestRetries,
    timeoutMs: config.openInterestMonitor.requestTimeoutMs
  });
  if (!Array.isArray(data)) return [];
  return data
    .map((item) => ({
      symbol: String(item?.symbol ?? symbol).toUpperCase(),
      sumOpenInterest: Number(item?.sumOpenInterest),
      sumOpenInterestValue: Number(item?.sumOpenInterestValue),
      timestamp: Number(item?.timestamp)
    }))
    .filter(
      (item) =>
        Number.isFinite(item.sumOpenInterest) &&
        Number.isFinite(item.sumOpenInterestValue) &&
        Number.isFinite(item.timestamp)
    )
    .sort((a, b) => a.timestamp - b.timestamp);
}
