import { config } from "./config.js";

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

let hotRankCache = new Map();
let lastHotRankPayload = null;
let twitterTokenCursor = 0;
const twitterTokenCooldownUntil = new Map();

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

function normalizeHotToken(item, chainId) {
  const meta = item.metaInfo ?? item.meta ?? {};
  const market = item.marketInfo ?? item.market ?? {};
  const hype = item.socialHypeInfo ?? item.social ?? {};
  const symbol = String(meta.symbol ?? item.symbol ?? "").toUpperCase();
  if (!symbol) return null;

  return {
    symbol,
    chainId: String(meta.chainId ?? item.chainId ?? chainId),
    chainLabel: CHAIN_LABELS[String(meta.chainId ?? item.chainId ?? chainId)] ?? String(chainId),
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
    tokenAge: numberValue(meta.tokenAge ?? item.tokenAge)
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
    const cooldownUntil = twitterTokenCooldownUntil.get(token) ?? 0;
    if (cooldownUntil > now) continue;
    twitterTokenCursor = (index + 1) % tokens.length;
    return token;
  }
  return null;
}

function coolDownTwitterToken(token) {
  if (!token) return;
  twitterTokenCooldownUntil.set(token, Date.now() + config.twitter.tokenCooldownMs);
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
  for (const candidate of candidates) {
    if (Array.isArray(candidate)) return candidate;
  }
  return [];
}

async function fetchTwitterHeatWithToken(symbol, token) {
  const baseAsset = String(symbol ?? "").toUpperCase().replace(/USDT$/, "");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.twitter.timeoutMs);
  try {
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
    if (!response.ok || json?.success === false || json?.ok === false) {
      const message = json?.message ?? json?.error ?? json?.description ?? `http_${response.status}`;
      const error = new Error(String(message));
      error.status = response.status;
      throw error;
    }
    const tweets = twitterRows(json);
    return {
      heat: twitterHeatScore(tweets),
      status: "ok",
      tweetCount: tweets.length
    };
  } finally {
    clearTimeout(timer);
  }
}

async function fetchTwitterHeat(symbol) {
  if (!config.twitter.heatEnabled || !twitterTokens().length) {
    return { heat: 0, status: "not_configured" };
  }
  const baseAsset = String(symbol ?? "").toUpperCase().replace(/USDT$/, "");
  if (!baseAsset) return { heat: 0, status: "empty_symbol" };

  const tokens = twitterTokens();
  const failures = [];
  for (let attempt = 0; attempt < tokens.length; attempt += 1) {
    const token = nextTwitterToken();
    if (!token) break;
    try {
      return await fetchTwitterHeatWithToken(symbol, token);
    } catch (error) {
      coolDownTwitterToken(token);
      failures.push(error instanceof Error ? error.message : String(error));
    }
  }
  return {
    heat: 0,
    status: failures.length ? `token_pool_failed:${failures.at(-1)}` : "token_pool_cooling_down"
  };
}

async function fetchHotRankChain(chainId, { targetLanguage, socialLanguage, timeRange }) {
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
    const list = json?.data?.leaderBoardList ?? json?.data?.list ?? json?.data ?? [];
    if (!Array.isArray(list)) return [];
    return list.map((item) => normalizeHotToken(item, chainId)).filter(Boolean);
  } finally {
    clearTimeout(timer);
  }
}

export async function getHotRank({ chain = "all", limit = 30, targetLanguage = "zh", socialLanguage = "ALL", timeRange = 1 } = {}) {
  const normalizedChain = Object.hasOwn(CHAIN_GROUPS, chain) ? chain : "all";
  const safeLimit = Math.max(5, Math.min(100, Number(limit) || 30));
  const safeTimeRange = Math.max(1, Number(timeRange) || 1);
  const cacheKey = JSON.stringify({ normalizedChain, safeLimit, targetLanguage, socialLanguage, safeTimeRange });
  const cached = hotRankCache.get(cacheKey);
  if (cached && Date.now() - cached.fetchedAt < config.binance.hotRankCacheMs) return cached.payload;

  const chains = CHAIN_GROUPS[normalizedChain];
  const results = await Promise.allSettled(
    chains.map((chainId) => fetchHotRankChain(chainId, { targetLanguage, socialLanguage, timeRange: safeTimeRange }))
  );
  const binanceTokens = results
    .flatMap((result) => (result.status === "fulfilled" ? result.value : []))
    .sort((a, b) => b.heat - a.heat)
    .slice(0, safeLimit);
  const errors = results
    .filter((result) => result.status === "rejected")
    .map((result) => (result.reason instanceof Error ? result.reason.message : String(result.reason)));

  if (!binanceTokens.length && errors.length) {
    if (lastHotRankPayload) {
      return {
        ...lastHotRankPayload,
        fetchedAt: new Date().toISOString(),
        partial: true,
        stale: true,
        errors
      };
    }
    return {
      ok: true,
      source: config.twitter.heatEnabled && twitterTokens().length ? "Binance Web3 Social Hype + Twitter/X" : "Binance Web3 Social Hype",
      twitterEnabled: Boolean(config.twitter.heatEnabled && twitterTokens().length),
      chain: normalizedChain,
      chains,
      fetchedAt: new Date().toISOString(),
      partial: true,
      stale: false,
      errors,
      tokens: []
    };
  }

  const twitterResults = await Promise.allSettled(binanceTokens.map((token) => fetchTwitterHeat(token.symbol)));
  const maxBinanceHeat = Math.max(...binanceTokens.map((token) => token.heat), 1);
  const maxTwitterHeat = Math.max(
    ...twitterResults.map((result) => (result.status === "fulfilled" ? result.value.heat : 0)),
    1
  );
  const tokens = binanceTokens
    .map((token, index) => {
      const twitter = twitterResults[index].status === "fulfilled" ? twitterResults[index].value : { heat: 0, status: "failed" };
      const binanceScore = (token.heat / maxBinanceHeat) * 70;
      const twitterScore = (twitter.heat / maxTwitterHeat) * 30;
      return {
        ...token,
        binanceHeat: token.heat,
        twitterHeat: twitter.heat,
        twitterStatus: twitter.status,
        twitterTweetCount: twitter.tweetCount ?? 0,
        heat: Number((binanceScore + twitterScore).toFixed(4))
      };
    })
    .sort((a, b) => b.heat - a.heat)
    .map((token, index) => ({ ...token, rank: index + 1 }));

  const payload = {
    ok: true,
    source: config.twitter.heatEnabled && twitterTokens().length ? "Binance Web3 Social Hype + Twitter/X" : "Binance Web3 Social Hype",
    twitterEnabled: Boolean(config.twitter.heatEnabled && twitterTokens().length),
    chain: normalizedChain,
    chains,
    fetchedAt: new Date().toISOString(),
    partial: errors.length > 0,
    errors,
    tokens
  };
  hotRankCache.set(cacheKey, { fetchedAt: Date.now(), payload });
  lastHotRankPayload = payload;
  return payload;
}
