import { config } from "./config.js";
import { listLatestHotRankSnapshot } from "./db.js";
import { filterEligibleHotTokens } from "./hotRankFilters.js";
import { enrichRowsWithMarketMetadata } from "./marketMetadata.js";

const CHAIN_LABELS = {
  "56": "BSC",
  "8453": "Base",
  CT_501: "Solana"
};

const CHAIN_GROUPS = {
  all: ["56", "8453", "CT_501"],
  bsc: ["56"],
  base: ["8453"],
  solana: ["CT_501"]
};

const FALLBACK_TOP_MARKET_CAP_SYMBOLS = [
  "BTC",
  "ETH",
  "USDT",
  "BNB",
  "USDC",
  "XRP",
  "SOL",
  "TRX",
  "DOGE",
  "ADA"
];

const hotRankCache = new Map();
const hotRankInflight = new Map();
const hotRankChainCache = new Map();
const hotRankChainInflight = new Map();
const lastHotRankPayloadByChain = new Map();

let topMarketCapCache = {
  fetchedAt: 0,
  source: "fallback",
  symbols: new Set(FALLBACK_TOP_MARKET_CAP_SYMBOLS)
};

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function numberValue(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function describeFetchError(error) {
  const message = error instanceof Error ? error.message : String(error);
  const cause = error?.cause;
  const code = cause?.code ?? error?.code;
  const causeMessage = cause?.message && cause.message !== message ? `: ${cause.message}` : "";
  return `${message}${code ? ` (${code})` : ""}${causeMessage}`;
}

function hotRankRetryDelayMs(attempt) {
  const baseDelay = Math.max(250, Math.min(500, Number(config.binance.retryDelayMs) || 250));
  return Math.round(baseDelay * (attempt + 1));
}

function retryAfterMs(headers) {
  const retryAfter = headers.get("retry-after");
  if (!retryAfter) return null;
  const seconds = Number(retryAfter);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = new Date(retryAfter);
  return Number.isNaN(date.getTime()) ? null : Math.max(0, date.getTime() - Date.now());
}

function isRetryableHotRankStatus(status) {
  return [408, 429, 500, 502, 503, 504].includes(Number(status));
}

function hotRankSnapshotChainLabels(normalizedChain) {
  return (CHAIN_GROUPS[normalizedChain] ?? CHAIN_GROUPS.all).map((chainId) => CHAIN_LABELS[chainId] ?? chainId);
}

async function latestHotRankSnapshotPayload(normalizedChain, errors) {
  try {
    const rows = await listLatestHotRankSnapshot({
      chainLabels: hotRankSnapshotChainLabels(normalizedChain),
      limit: 100
    });
    if (!rows.length) return null;
    const snapshotTime = rows[0]?.snapshotTime instanceof Date
      ? rows[0].snapshotTime.toISOString()
      : new Date(rows[0]?.snapshotTime ?? Date.now()).toISOString();
    return {
      chain: normalizedChain,
      chains: CHAIN_GROUPS[normalizedChain],
      fetchedAt: snapshotTime,
      partial: true,
      stale: true,
      errors,
      filters: {
        excluded: {},
        topMarketCapSource: "snapshot",
        topMarketCapSymbols: []
      },
      binanceTokens: rows.map((row) => ({
        symbol: row.symbol,
        chainId: "",
        chainLabel: row.chainLabel,
        contractAddress: "",
        logo: "",
        heat: numberValue(row.heat),
        sentiment: "Neutral",
        summary: "",
        marketCap: 0,
        priceChange: 0,
        tokenAge: 0,
        tagInfoList: {}
      }))
    };
  } catch (error) {
    errors.push(`hot rank snapshot fallback failed: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

function logoUrl(value) {
  const path = String(value ?? "").trim();
  if (!path) return "";
  if (/^https?:\/\//i.test(path)) return path;
  return `https://bin.bnbstatic.com${path.startsWith("/") ? "" : "/"}${path}`;
}

function normalizeHotToken(item, requestedChainId) {
  const meta = item.metaInfo ?? item.meta ?? {};
  const market = item.marketInfo ?? item.market ?? {};
  const hype = item.socialHypeInfo ?? item.social ?? {};
  const symbol = String(meta.symbol ?? item.symbol ?? "").toUpperCase();
  const chainId = String(meta.chainId ?? item.chainId ?? requestedChainId);
  if (!symbol || chainId !== String(requestedChainId)) return null;

  return {
    symbol,
    chainId,
    chainLabel: CHAIN_LABELS[chainId] ?? chainId,
    contractAddress: String(meta.contractAddress ?? item.contractAddress ?? ""),
    logo: logoUrl(meta.logo ?? meta.icon ?? item.logo ?? item.icon),
    heat: numberValue(hype.socialHype ?? item.socialHype),
    sentiment: String(hype.sentiment ?? item.sentiment ?? "Neutral"),
    summary:
      String(
        hype.socialSummaryBriefTranslated ??
          hype.socialSummaryBrief ??
          hype.socialSummaryDetailTranslated ??
          hype.socialSummaryDetail ??
          ""
      ).trim(),
    marketCap: numberValue(market.marketCap ?? item.marketCap),
    priceChange: numberValue(market.priceChange ?? item.priceChange),
    tokenAge: numberValue(meta.tokenAge ?? item.tokenAge),
    tagInfoList: item.tagInfoList ?? {}
  };
}

async function requestHotRankChain(chainId, { targetLanguage, socialLanguage, timeRange }) {
  const url = new URL(config.binance.socialHypeRankUrl);
  url.searchParams.set("chainId", chainId);
  url.searchParams.set("sentiment", "All");
  url.searchParams.set("socialLanguage", socialLanguage);
  url.searchParams.set("targetLanguage", targetLanguage);
  url.searchParams.set("timeRange", String(timeRange));

  const retries = Math.max(0, Math.floor(Number(config.hotRank.requestRetries) || 0));
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), config.hotRank.requestTimeoutMs);
    try {
      const response = await fetch(url, {
        headers: { "Accept-Encoding": "identity" },
        signal: controller.signal
      });
      if (!response.ok) {
        const body = await response.text().catch(() => "");
        const error = new Error(`Binance social hype ${chainId} HTTP ${response.status}${body ? `: ${body.slice(0, 180)}` : ""}`);
        error.retryable = isRetryableHotRankStatus(response.status);
        error.retryAfterMs = retryAfterMs(response.headers);
        throw error;
      }
      const json = await response.json();
      if (json?.success === false || json?.ok === false) {
        const message = String(json?.message ?? json?.error ?? json?.description ?? "upstream rejected request");
        const error = new Error(`Binance social hype ${chainId}: ${message}`);
        error.retryable = false;
        throw error;
      }
      const list = json?.data?.leaderBoardList ?? json?.data?.list ?? json?.data ?? [];
      if (!Array.isArray(list)) {
        const message = String(json?.message ?? json?.error ?? json?.description ?? "invalid leaderboard payload");
        const error = new Error(`Binance social hype ${chainId}: ${message}`);
        error.retryable = false;
        throw error;
      }
      return list.map((item) => normalizeHotToken(item, chainId)).filter(Boolean);
    } catch (error) {
      if (error?.retryable === false) throw error;
      if (attempt >= retries) {
        throw new Error(`Binance social hype ${chainId}: ${describeFetchError(error)}`, { cause: error });
      }
      await sleep(error?.retryAfterMs ?? hotRankRetryDelayMs(attempt));
    } finally {
      clearTimeout(timer);
    }
  }
  return [];
}

async function fetchHotRankChain(chainId, options) {
  const cacheKey = JSON.stringify({ chainId, ...options });
  const cached = hotRankChainCache.get(cacheKey);
  if (cached && Date.now() - cached.fetchedAt < config.binance.hotRankCacheMs) return cached.tokens;

  let request = hotRankChainInflight.get(cacheKey);
  if (!request) {
    request = requestHotRankChain(chainId, options);
    hotRankChainInflight.set(cacheKey, request);
  }
  try {
    const tokens = await request;
    hotRankChainCache.set(cacheKey, { fetchedAt: Date.now(), tokens });
    return tokens;
  } finally {
    if (hotRankChainInflight.get(cacheKey) === request) hotRankChainInflight.delete(cacheKey);
  }
}

async function getTopMarketCapSymbols() {
  const cacheMs = Math.max(60_000, Number(config.hotRank.marketCapTopCacheMs) || 0);
  if (Date.now() - topMarketCapCache.fetchedAt < cacheMs) return topMarketCapCache;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.hotRank.marketCapTopTimeoutMs);
  try {
    const response = await fetch(config.hotRank.marketCapTopUrl, {
      headers: { Accept: "application/json" },
      signal: controller.signal
    });
    if (!response.ok) throw new Error(`market cap top 10 HTTP ${response.status}`);
    const json = await response.json();
    if (!Array.isArray(json) || json.length < 10) throw new Error("market cap top 10 returned incomplete data");
    const symbols = new Set(
      json
        .slice(0, 10)
        .map((item) => String(item?.symbol ?? "").toUpperCase())
        .filter(Boolean)
    );
    if (symbols.size < 10) throw new Error("market cap top 10 symbols are incomplete");
    topMarketCapCache = { fetchedAt: Date.now(), source: "coingecko", symbols };
  } catch (error) {
    topMarketCapCache = {
      fetchedAt: Date.now(),
      source: "fallback",
      symbols: topMarketCapCache.symbols.size
        ? topMarketCapCache.symbols
        : new Set(FALLBACK_TOP_MARKET_CAP_SYMBOLS),
      error: error instanceof Error ? error.message : String(error)
    };
  } finally {
    clearTimeout(timer);
  }
  return topMarketCapCache;
}

async function materializeHotRank(basePayload, safeLimit) {
  const tokens = (await enrichRowsWithMarketMetadata((basePayload.binanceTokens ?? [])
    .slice(0, safeLimit)
    .map((token, index) => ({
      ...token,
      binanceHeat: token.heat,
      rank: index + 1
    })))).map((token) => ({
      ...token,
      priceChange24hPct: Number.isFinite(Number(token.priceChange24hPct))
        ? token.priceChange24hPct
        : numberValue(token.priceChange, null)
    }));

  return {
    ok: true,
    source: "Binance Web3 Social Hype",
    chain: basePayload.chain,
    chains: basePayload.chains,
    fetchedAt: basePayload.fetchedAt,
    partial: basePayload.partial,
    stale: basePayload.stale,
    errors: basePayload.errors,
    filters: basePayload.filters,
    tokens
  };
}

async function fetchHotRankBase({ normalizedChain, targetLanguage, socialLanguage, safeTimeRange }) {
  const chains = CHAIN_GROUPS[normalizedChain];
  const [results, topMarketCap] = await Promise.all([
    Promise.allSettled(
      chains.map((chainId) =>
        fetchHotRankChain(chainId, {
          targetLanguage,
          socialLanguage,
          timeRange: safeTimeRange
        })
      )
    ),
    getTopMarketCapSymbols()
  ]);
  const rawTokens = results
    .flatMap((result) => (result.status === "fulfilled" ? result.value : []))
    .sort((a, b) => b.heat - a.heat);
  const filtered = filterEligibleHotTokens(rawTokens, topMarketCap.symbols);
  const errors = results
    .filter((result) => result.status === "rejected")
    .map((result) => (result.reason instanceof Error ? result.reason.message : String(result.reason)));
  const filters = {
    excluded: filtered.excluded,
    topMarketCapSource: topMarketCap.source,
    topMarketCapSymbols: [...topMarketCap.symbols],
    ...(topMarketCap.error ? { warning: topMarketCap.error } : {})
  };

  if (!rawTokens.length && errors.length) {
    const previous = lastHotRankPayloadByChain.get(normalizedChain);
    if (previous) {
      return {
        ...previous,
        fetchedAt: new Date().toISOString(),
        partial: true,
        stale: true,
        errors
      };
    }
    const snapshot = await latestHotRankSnapshotPayload(normalizedChain, errors);
    if (snapshot) return snapshot;
  }

  const basePayload = {
    chain: normalizedChain,
    chains,
    fetchedAt: new Date().toISOString(),
    partial: errors.length > 0,
    stale: false,
    errors,
    filters,
    binanceTokens: filtered.tokens
  };
  if (rawTokens.length) lastHotRankPayloadByChain.set(normalizedChain, basePayload);
  return basePayload;
}

export async function getHotRank({
  chain = "all",
  limit = 30,
  targetLanguage = "zh",
  socialLanguage = "ALL",
  timeRange = 1
} = {}) {
  const normalizedChain = Object.hasOwn(CHAIN_GROUPS, chain) ? chain : "all";
  const safeLimit = Math.max(5, Math.min(100, Number(limit) || 30));
  const safeTimeRange = Math.max(1, Number(timeRange) || 1);
  const cacheKey = JSON.stringify({
    normalizedChain,
    targetLanguage,
    socialLanguage,
    safeTimeRange
  });
  const cached = hotRankCache.get(cacheKey);
  if (cached && Date.now() - cached.fetchedAt < config.binance.hotRankCacheMs) {
    return await materializeHotRank(cached.basePayload, safeLimit);
  }

  let request = hotRankInflight.get(cacheKey);
  if (!request) {
    request = fetchHotRankBase({
      normalizedChain,
      targetLanguage,
      socialLanguage,
      safeTimeRange
    });
    hotRankInflight.set(cacheKey, request);
  }

  try {
    const basePayload = await request;
    hotRankCache.set(cacheKey, { fetchedAt: Date.now(), basePayload });
    return await materializeHotRank(basePayload, safeLimit);
  } finally {
    if (hotRankInflight.get(cacheKey) === request) hotRankInflight.delete(cacheKey);
  }
}
