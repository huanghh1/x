import { config } from "./config.js";
import { filterEligibleHotTokens } from "./hotRankFilters.js";

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
const twitterTokenCooldownUntil = new Map();
const twitterHeatCache = new Map();
const twitterRefreshInflight = new Map();
const twitterRefreshQueue = [];

let twitterTokenCursor = 0;
let twitterActiveRequests = 0;
let twitterLastRequestAt = 0;
let twitterRequestGate = Promise.resolve();
let twitterGlobalBackoffUntil = 0;
let topMarketCapCache = {
  fetchedAt: 0,
  source: "fallback",
  symbols: new Set(FALLBACK_TOP_MARKET_CAP_SYMBOLS)
};

function numberValue(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
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

function twitterHeatScore(tweets) {
  if (!Array.isArray(tweets) || tweets.length === 0) return 0;
  return tweets.reduce((sum, tweet) => {
    const favorite = numberValue(tweet.favoriteCount ?? tweet.likeCount);
    const retweet = numberValue(tweet.retweetCount);
    const reply = numberValue(tweet.replyCount);
    const quote = numberValue(tweet.quoteCount);
    const view = numberValue(tweet.viewCount);
    return sum + favorite + retweet * 2 + reply * 1.5 + quote * 2 + Math.log10(view + 1) * 8;
  }, 0);
}

function twitterTokens() {
  return Array.from(new Set(config.twitter.tokens.length ? config.twitter.tokens : [config.twitter.token].filter(Boolean)));
}

function nextTwitterToken() {
  const tokens = twitterTokens();
  if (!tokens.length) return null;
  const now = Date.now();
  for (let attempt = 0; attempt < tokens.length; attempt += 1) {
    const index = (twitterTokenCursor + attempt) % tokens.length;
    const token = tokens[index];
    if ((twitterTokenCooldownUntil.get(token) ?? 0) > now) continue;
    twitterTokenCursor = (index + 1) % tokens.length;
    return token;
  }
  return null;
}

function coolDownTwitterToken(token) {
  if (!token) return;
  twitterTokenCooldownUntil.set(token, Date.now() + config.twitter.tokenCooldownMs);
}

function twitterCacheKey(symbol) {
  return String(symbol ?? "").toUpperCase().replace(/USDT$/, "");
}

function getCachedTwitterHeat(symbol, { allowFailure = true, allowStaleOk = false } = {}) {
  const cached = twitterHeatCache.get(twitterCacheKey(symbol));
  if (!cached) return null;
  const isOk = cached.result.status === "ok";
  if (!allowFailure && !isOk) return null;
  const maxAge = isOk
    ? config.twitter.heatCacheMs
    : cached.result.status === "rate_limited_retrying"
      ? Math.min(config.twitter.failureCacheMs, 15_000)
      : config.twitter.failureCacheMs;
  const age = Date.now() - cached.fetchedAt;
  if (age > maxAge) {
    if (!allowStaleOk || !isOk || age > maxAge * 4) return null;
    return { ...cached.result, status: "stale_cache", cached: true };
  }
  return { ...cached.result, cached: true };
}

function setCachedTwitterHeat(symbol, result) {
  const key = twitterCacheKey(symbol);
  if (!key) return result;
  twitterHeatCache.set(key, { fetchedAt: Date.now(), result });
  return result;
}

function twitterRows(json) {
  const candidates = [
    json?.data,
    json?.data?.items,
    json?.data?.list,
    json?.tweets,
    json?.items,
    json?.list,
    json
  ];
  return candidates.find(Array.isArray) ?? [];
}

function quotaRemaining(json) {
  const value = Number(json?.usage?.quota ?? json?.usage?.remaining ?? json?.quota);
  return Number.isFinite(value) ? value : null;
}

function waitForTwitterRequestSlot() {
  const task = twitterRequestGate.then(async () => {
    const waitMs = Math.max(0, config.twitter.requestSpacingMs - (Date.now() - twitterLastRequestAt));
    if (waitMs > 0) await new Promise((resolve) => setTimeout(resolve, waitMs));
    twitterLastRequestAt = Date.now();
  });
  twitterRequestGate = task.catch(() => {});
  return task;
}

function twitterSemanticError(json, httpStatus) {
  const message = String(json?.message ?? json?.error ?? json?.description ?? "").trim();
  if (!message) return null;
  if (/insufficient quota|quota exceeded|余额不足/i.test(message)) {
    const error = new Error(message);
    error.status = 429;
    error.kind = "quota";
    return error;
  }
  if (/rate limit|too frequently|频繁/i.test(message)) {
    const error = new Error(message);
    error.status = 429;
    error.kind = "rate";
    return error;
  }
  if (/unauthorized|invalid token|forbidden/i.test(message)) {
    const error = new Error(message);
    error.status = httpStatus === 200 ? 401 : httpStatus;
    return error;
  }
  return null;
}

async function fetchTwitterHeatWithToken(symbol, token) {
  const baseAsset = twitterCacheKey(symbol);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.twitter.timeoutMs);
  try {
    await waitForTwitterRequestSlot();
    const response = await fetch("https://ai.6551.io/open/twitter_search", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json"
      },
      signal: controller.signal,
      body: JSON.stringify({
        keywords: `$${baseAsset}`,
        product: "Top",
        maxResults: 20,
        excludeReplies: true,
        excludeRetweets: true
      })
    });
    const json = await response.json().catch(() => ({}));
    const semanticError = twitterSemanticError(json, response.status);
    if (semanticError) throw semanticError;
    if (!response.ok || json?.success === false || json?.ok === false) {
      const message = json?.message ?? json?.error ?? json?.description ?? `http_${response.status}`;
      const error = new Error(String(message));
      error.status = response.status;
      throw error;
    }
    const tweets = twitterRows(json);
    const quota = quotaRemaining(json);
    if (tweets.length === 0 && quota !== null && quota <= 0) {
      const error = new Error("insufficient quota");
      error.status = 429;
      error.kind = "quota";
      throw error;
    }
    return {
      heat: twitterHeatScore(tweets),
      status: tweets.length ? "ok" : "no_results",
      tweetCount: tweets.length,
      quotaRemaining: quota
    };
  } finally {
    clearTimeout(timer);
  }
}

async function fetchTwitterHeat(symbol) {
  const cached = getCachedTwitterHeat(symbol);
  if (cached) return cached;
  if (!config.twitter.heatEnabled || !twitterTokens().length) {
    return { heat: null, status: "not_configured", tweetCount: 0 };
  }
  const baseAsset = twitterCacheKey(symbol);
  if (!baseAsset) return { heat: null, status: "empty_symbol", tweetCount: 0 };
  if (Date.now() < twitterGlobalBackoffUntil) {
    return setCachedTwitterHeat(symbol, { heat: null, status: "rate_limited_retrying", tweetCount: 0 });
  }

  const failures = [];
  let failureStatus = "quota_pool_exhausted";
  for (let attempt = 0; attempt < twitterTokens().length; attempt += 1) {
    const token = nextTwitterToken();
    if (!token) break;
    try {
      const result = await fetchTwitterHeatWithToken(symbol, token);
      if (result.quotaRemaining !== null && result.quotaRemaining <= 0) coolDownTwitterToken(token);
      const { quotaRemaining: _quotaRemaining, ...publicResult } = result;
      return setCachedTwitterHeat(symbol, publicResult);
    } catch (error) {
      const status = Number(error?.status ?? 0);
      if (error?.kind === "rate" || (status === 429 && error?.kind !== "quota")) {
        twitterGlobalBackoffUntil = Date.now() + 30_000;
        failureStatus = "rate_limited_retrying";
        failures.push(error instanceof Error ? error.message : String(error));
        break;
      }
      if (error?.kind === "quota" || [401, 403].includes(status)) {
        coolDownTwitterToken(token);
        failureStatus = "quota_pool_exhausted";
      }
      failures.push(error instanceof Error ? error.message : String(error));
      if (![401, 403, 429].includes(status)) {
        failureStatus = "rate_limited_retrying";
        twitterGlobalBackoffUntil = Date.now() + 15_000;
        break;
      }
    }
  }

  const stale = getCachedTwitterHeat(symbol, { allowFailure: false, allowStaleOk: true });
  if (stale) return stale;
  return setCachedTwitterHeat(symbol, {
    heat: null,
    status: failureStatus,
    tweetCount: 0
  });
}

function drainTwitterRefreshQueue() {
  const concurrency = Math.max(1, Number(config.twitter.concurrentRequests) || 1);
  while (twitterActiveRequests < concurrency && twitterRefreshQueue.length) {
    const task = twitterRefreshQueue.shift();
    twitterActiveRequests += 1;
    void fetchTwitterHeat(task.symbol)
      .catch((error) => {
        setCachedTwitterHeat(task.symbol, {
          heat: null,
          status: `token_pool_failed:${error instanceof Error ? error.message : String(error)}`,
          tweetCount: 0
        });
      })
      .finally(() => {
        twitterActiveRequests -= 1;
        twitterRefreshInflight.delete(task.key);
        task.resolve();
        drainTwitterRefreshQueue();
      });
  }
}

function queueTwitterRefresh(symbol) {
  const key = twitterCacheKey(symbol);
  if (!key || getCachedTwitterHeat(symbol) || twitterRefreshInflight.has(key)) return;
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  twitterRefreshInflight.set(key, promise);
  twitterRefreshQueue.push({ key, symbol, resolve });
  drainTwitterRefreshQueue();
}

function scheduleTwitterRefresh(tokens) {
  if (!config.twitter.heatEnabled || !twitterTokens().length) return;
  const candidates = (tokens ?? [])
    .filter((token) => !getCachedTwitterHeat(token.symbol) && !twitterRefreshInflight.has(twitterCacheKey(token.symbol)))
    .slice(0, Math.max(0, Number(config.twitter.maxFreshPerRank) || 0));
  candidates.forEach((token) => queueTwitterRefresh(token.symbol));
}

async function requestHotRankChain(chainId, { targetLanguage, socialLanguage, timeRange }) {
  const url = new URL(config.binance.socialHypeRankUrl);
  url.searchParams.set("chainId", chainId);
  url.searchParams.set("sentiment", "All");
  url.searchParams.set("socialLanguage", socialLanguage);
  url.searchParams.set("targetLanguage", targetLanguage);
  url.searchParams.set("timeRange", String(timeRange));

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.binance.requestTimeoutMs);
  try {
    const response = await fetch(url, {
      headers: { "Accept-Encoding": "identity" },
      signal: controller.signal
    });
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(`Binance social hype ${chainId} HTTP ${response.status}${body ? `: ${body.slice(0, 180)}` : ""}`);
    }
    const json = await response.json();
    if (json?.success === false || json?.ok === false) {
      const message = String(json?.message ?? json?.error ?? json?.description ?? "upstream rejected request");
      throw new Error(`Binance social hype ${chainId}: ${message}`);
    }
    const list = json?.data?.leaderBoardList ?? json?.data?.list ?? json?.data ?? [];
    if (!Array.isArray(list)) {
      const message = String(json?.message ?? json?.error ?? json?.description ?? "invalid leaderboard payload");
      throw new Error(`Binance social hype ${chainId}: ${message}`);
    }
    return list.map((item) => normalizeHotToken(item, chainId)).filter(Boolean);
  } finally {
    clearTimeout(timer);
  }
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

function materializeHotRank(basePayload, safeLimit) {
  const binanceTokens = (basePayload.binanceTokens ?? []).slice(0, safeLimit);
  if (!config.twitter.heatEnabled || !twitterTokens().length) {
    const tokens = binanceTokens.map((token, index) => ({
      ...token,
      binanceHeat: token.heat,
      twitterHeat: null,
      twitterStatus: "disabled",
      twitterTweetCount: 0,
      rank: index + 1
    }));
    return {
      ok: true,
      source: "Binance Web3 Social Hype",
      twitterEnabled: false,
      twitterPendingCount: 0,
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
  scheduleTwitterRefresh(binanceTokens);
  const twitterResults = binanceTokens.map((token) =>
    getCachedTwitterHeat(token.symbol) ?? { heat: null, status: "pending_refresh", tweetCount: 0 }
  );
  const maxBinanceHeat = Math.max(...binanceTokens.map((token) => token.heat), 1);
  const availableTwitterHeat = twitterResults
    .map((result) => result.heat === null || result.heat === undefined ? Number.NaN : Number(result.heat))
    .filter(Number.isFinite);
  const maxTwitterHeat = Math.max(...availableTwitterHeat, 1);
  const tokens = binanceTokens
    .map((token, index) => {
      const twitter = twitterResults[index];
      const binanceScore = (token.heat / maxBinanceHeat) * 70;
      const twitterHeat =
        twitter.heat === null || twitter.heat === undefined ? Number.NaN : Number(twitter.heat);
      const twitterScore = Number.isFinite(twitterHeat) ? (twitterHeat / maxTwitterHeat) * 30 : 0;
      return {
        ...token,
        binanceHeat: token.heat,
        twitterHeat: Number.isFinite(twitterHeat) ? twitterHeat : null,
        twitterStatus: twitter.status,
        twitterTweetCount: twitter.tweetCount ?? 0,
        heat: Number((binanceScore + twitterScore).toFixed(4))
      };
    })
    .sort((a, b) => b.heat - a.heat)
    .map((token, index) => ({ ...token, rank: index + 1 }));

  return {
    ok: true,
    source: config.twitter.heatEnabled && twitterTokens().length
      ? "Binance Web3 Social Hype + Twitter/X"
      : "Binance Web3 Social Hype",
    twitterEnabled: Boolean(config.twitter.heatEnabled && twitterTokens().length),
    twitterPendingCount: twitterResults.filter(
      (result) => result.status === "pending_refresh" || result.status === "rate_limited_retrying"
    ).length,
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
    return materializeHotRank(cached.basePayload, safeLimit);
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
    return materializeHotRank(basePayload, safeLimit);
  } finally {
    if (hotRankInflight.get(cacheKey) === request) hotRankInflight.delete(cacheKey);
  }
}
