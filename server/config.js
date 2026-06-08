import dotenv from "dotenv";

dotenv.config({ path: ".env.local" });
dotenv.config();

function numberEnv(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) ? value : fallback;
}

function boolEnv(name, fallback) {
  const value = process.env[name];
  if (value === undefined) return fallback;
  return value === "true";
}

function listEnv(name) {
  return String(process.env[name] ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

const intervalLookbackDays = {
  "15m": numberEnv("KLINE_15M_LOOKBACK_DAYS", 60),
  "1h": numberEnv("KLINE_1H_LOOKBACK_DAYS", 183),
  "4h": numberEnv("KLINE_4H_LOOKBACK_DAYS", 730),
  "1d": numberEnv("KLINE_1D_LOOKBACK_DAYS", 2190)
};

const retentionLimits = {
  "15m": numberEnv("KLINE_15M_RETENTION_LIMIT", 5760),
  "1h": numberEnv("KLINE_1H_RETENTION_LIMIT", 4392),
  "4h": numberEnv("KLINE_4H_RETENTION_LIMIT", 4380),
  "1d": numberEnv("KLINE_1D_RETENTION_LIMIT", 2190)
};

const twitterTokenPool = Array.from(new Set([
  ...listEnv("OPENNEWS_TOKENS"),
  ...listEnv("TWITTER_TOKENS"),
  process.env.TWITTER_TOKEN?.trim() ?? "",
  process.env.OPENNEWS_TOKEN?.trim() ?? ""
].filter(Boolean)));

export const config = {
  port: numberEnv("PORT", 8787),
  mysql: {
    host: process.env.MYSQL_HOST ?? "127.0.0.1",
    port: numberEnv("MYSQL_PORT", 3306),
    user: process.env.MYSQL_USER ?? "root",
    password: process.env.MYSQL_PASSWORD ?? "Wozh138286@",
    database: process.env.MYSQL_DATABASE ?? "binance_ma_monitor",
    connectionLimit: numberEnv("MYSQL_CONNECTION_LIMIT", Math.max(6, numberEnv("CRAWLER_CONCURRENT_TOKENS", 4) + 4))
  },
  binance: {
    spotBaseUrl: process.env.BINANCE_SPOT_BASE_URL ?? "https://api.binance.com",
    futuresBaseUrl: process.env.BINANCE_FUTURES_BASE_URL ?? "https://fapi.binance.com",
    alphaTokenListUrl:
      process.env.BINANCE_ALPHA_TOKEN_LIST_URL ??
      "https://www.binance.com/bapi/defi/v1/public/wallet-direct/buw/wallet/cex/alpha/all/token/list",
    socialHypeRankUrl:
      process.env.BINANCE_SOCIAL_HYPE_RANK_URL ??
      "https://web3.binance.com/bapi/defi/v1/public/wallet-direct/buw/wallet/market/token/pulse/social/hype/rank/leaderboard",
    hotRankCacheMs: numberEnv("BINANCE_HOT_RANK_CACHE_MS", 5 * 60 * 1000),
    requestTimeoutMs: numberEnv("REQUEST_TIMEOUT_MS", 15000),
    requestRetries: numberEnv("BINANCE_REQUEST_RETRIES", 4),
    retryDelayMs: numberEnv("BINANCE_RETRY_DELAY_MS", 1000),
    requestWeightBudgetPerMinute: numberEnv("BINANCE_REQUEST_WEIGHT_BUDGET_PER_MINUTE", 900)
  },
  crawler: {
    autoStart: boolEnv("AUTO_START_CRAWLER", true),
    concurrentTokens: numberEnv("CRAWLER_CONCURRENT_TOKENS", 1),
    lookbackDays: numberEnv("KLINE_LOOKBACK_DAYS", 90),
    intervalLookbackDays,
    retentionLimits,
    cachePolicyKey: `15m:${intervalLookbackDays["15m"]}/${retentionLimits["15m"]}|1h:${intervalLookbackDays["1h"]}/${retentionLimits["1h"]}|4h:${intervalLookbackDays["4h"]}/${retentionLimits["4h"]}|1d:${intervalLookbackDays["1d"]}/${retentionLimits["1d"]}`,
    klineLimit: numberEnv("KLINE_REQUEST_LIMIT", 499),
    pageDelayMs: numberEnv("KLINE_PAGE_DELAY_MS", 1200),
    intervalDelayMs: numberEnv("INTERVAL_DELAY_MS", 2000),
    tokenDelayMinMs: numberEnv("TOKEN_DELAY_MIN_MS", 8000),
    tokenDelayMaxMs: numberEnv("TOKEN_DELAY_MAX_MS", 12000),
    staleFetchingAfterMs: numberEnv("STALE_FETCHING_AFTER_MS", 5 * 60 * 1000),
    incrementalRefreshMs: numberEnv("CRAWLER_INCREMENTAL_REFRESH_MS", 15 * 60 * 1000),
    tokenUniverseSyncMs: numberEnv("TOKEN_UNIVERSE_SYNC_MS", 6 * 60 * 60 * 1000)
  },
  maintenance: {
    cleanupIntervalDays: numberEnv("KLINE_CLEANUP_INTERVAL_DAYS", 7),
    checkIntervalMs: numberEnv("MAINTENANCE_CHECK_INTERVAL_MS", 60 * 60 * 1000)
  },
  signal: {
    nearThresholdPct: numberEnv("MA_NEAR_THRESHOLD_PCT", 1)
  },
  app: {
    publicBaseUrl: process.env.PUBLIC_BASE_URL?.trim() ?? ""
  },
  twitter: {
    token: process.env.TWITTER_TOKEN?.trim() ?? process.env.OPENNEWS_TOKEN?.trim() ?? "",
    tokens: twitterTokenPool,
    heatEnabled: boolEnv("TWITTER_HEAT_ENABLED", Boolean(process.env.OPENNEWS_TOKENS || process.env.TWITTER_TOKENS || process.env.TWITTER_TOKEN || process.env.OPENNEWS_TOKEN)),
    tokenCooldownMs: numberEnv("TWITTER_TOKEN_COOLDOWN_MS", 10 * 60 * 1000),
    heatCacheMs: numberEnv("TWITTER_HEAT_CACHE_MS", 30 * 60 * 1000),
    failureCacheMs: numberEnv("TWITTER_HEAT_FAILURE_CACHE_MS", 2 * 60 * 1000),
    maxFreshPerRank: numberEnv("TWITTER_HEAT_MAX_FRESH_PER_RANK", 8),
    concurrentRequests: numberEnv("TWITTER_HEAT_CONCURRENT_REQUESTS", 2),
    timeoutMs: numberEnv("TWITTER_REQUEST_TIMEOUT_MS", 12000)
  },
  hotRank: {
    activeMs: numberEnv("HOT_RANK_ACTIVE_MS", Math.max(30 * 60 * 1000, numberEnv("BINANCE_HOT_RANK_CACHE_MS", 5 * 60 * 1000) * 3))
  },
  telegram: {
    enabled: boolEnv("TELEGRAM_ALERTS_ENABLED", false),
    botToken: process.env.TELEGRAM_BOT_TOKEN?.trim() ?? "",
    chatId: process.env.TELEGRAM_CHAT_ID?.trim() ?? "",
    level1Enabled: boolEnv("TELEGRAM_LEVEL1_ENABLED", true),
    level2Enabled: boolEnv("TELEGRAM_LEVEL2_ENABLED", false),
    timeoutMs: numberEnv("TELEGRAM_REQUEST_TIMEOUT_MS", 12000)
  }
};
