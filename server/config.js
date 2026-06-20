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

const openInterestScanIntervalMs = numberEnv("OPEN_INTEREST_SCAN_MS", 3 * 60 * 1000);
const realtimeStreamLimit = Math.max(5, Math.min(1024, numberEnv("REALTIME_STREAM_LIMIT", 900)));

const twitterTokenPool = Array.from(new Set([
  ...listEnv("OPENNEWS_TOKENS"),
  ...listEnv("TWITTER_TOKENS"),
  process.env.TWITTER_TOKEN?.trim() ?? "",
  process.env.OPENNEWS_TOKEN?.trim() ?? ""
].filter(Boolean)));

const SERVICE_ROLES = new Set(["api", "crawler", "realtime", "scheduler"]);
const requestedServiceRole = process.env.SERVICE_ROLE?.trim() || "api";
const serviceRole = SERVICE_ROLES.has(requestedServiceRole) ? requestedServiceRole : "api";
const defaultConnectionLimits = {
  api: 5,
  crawler: Math.max(4, numberEnv("CRAWLER_CONCURRENT_TOKENS", 1) + 3),
  realtime: 4,
  scheduler: 3
};
const connectionLimit = numberEnv(
  `MYSQL_${serviceRole.toUpperCase()}_CONNECTION_LIMIT`,
  numberEnv("MYSQL_CONNECTION_LIMIT", defaultConnectionLimits[serviceRole] ?? 3)
);

export const config = {
  port: numberEnv("PORT", 8787),
  service: {
    role: serviceRole,
    host: process.env.SERVICE_HOST?.trim() || "127.0.0.1",
    apiHost: process.env.API_HOST?.trim() || "0.0.0.0",
    apiPort: numberEnv("API_PORT", 8787),
    crawlerPort: numberEnv("CRAWLER_PORT", 8788),
    realtimePort: numberEnv("REALTIME_PORT", 8789),
    schedulerPort: numberEnv("SCHEDULER_PORT", 8790),
    requestTimeoutMs: numberEnv("SERVICE_REQUEST_TIMEOUT_MS", 5000),
    internalToken: process.env.INTERNAL_SERVICE_TOKEN?.trim() || ""
  },
  mysql: {
    host: process.env.MYSQL_HOST ?? "127.0.0.1",
    port: numberEnv("MYSQL_PORT", 3306),
    user: process.env.MYSQL_USER ?? "root",
    password: process.env.MYSQL_PASSWORD ?? "Wozh138286@",
    database: process.env.MYSQL_DATABASE ?? "binance_ma_monitor",
    connectionLimit,
    maxIdle: Math.min(connectionLimit, numberEnv("MYSQL_MAX_IDLE", defaultConnectionLimits[serviceRole] ?? 3)),
    idleTimeoutMs: numberEnv("MYSQL_IDLE_TIMEOUT_MS", 60_000),
    queueLimit: numberEnv("MYSQL_QUEUE_LIMIT", 200),
    connectTimeoutMs: numberEnv("MYSQL_CONNECT_TIMEOUT_MS", 10_000),
    keepAliveInitialDelayMs: numberEnv("MYSQL_KEEPALIVE_INITIAL_DELAY_MS", 10_000)
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
    requestWeightBudgetPerMinute: numberEnv("BINANCE_REQUEST_WEIGHT_BUDGET_PER_MINUTE", 1800)
  },
  crawler: {
    autoStart: boolEnv("AUTO_START_CRAWLER", true),
    concurrentTokens: numberEnv("CRAWLER_CONCURRENT_TOKENS", 4),
    lookbackDays: numberEnv("KLINE_LOOKBACK_DAYS", 90),
    intervalLookbackDays,
    retentionLimits,
    cachePolicyKey: `15m:${intervalLookbackDays["15m"]}/${retentionLimits["15m"]}|1h:${intervalLookbackDays["1h"]}/${retentionLimits["1h"]}|4h:${intervalLookbackDays["4h"]}/${retentionLimits["4h"]}|1d:${intervalLookbackDays["1d"]}/${retentionLimits["1d"]}`,
    klineLimit: numberEnv("KLINE_REQUEST_LIMIT", 499),
    incrementalKlineLimit: numberEnv("KLINE_INCREMENTAL_REQUEST_LIMIT", 50),
    pageDelayMs: numberEnv("KLINE_PAGE_DELAY_MS", 250),
    intervalDelayMs: numberEnv("INTERVAL_DELAY_MS", 300),
    tokenDelayMinMs: numberEnv("TOKEN_DELAY_MIN_MS", 500),
    tokenDelayMaxMs: numberEnv("TOKEN_DELAY_MAX_MS", 1500),
    staleFetchingAfterMs: numberEnv("STALE_FETCHING_AFTER_MS", 5 * 60 * 1000),
    incrementalRefreshMs: numberEnv("CRAWLER_INCREMENTAL_REFRESH_MS", 15 * 60 * 1000),
    tokenUniverseSyncMs: numberEnv("TOKEN_UNIVERSE_SYNC_MS", 6 * 60 * 60 * 1000),
    dailyAuditHour: Math.max(0, Math.min(23, numberEnv("KLINE_DAILY_AUDIT_HOUR", 0))),
    inactiveRetentionDays: Math.max(1, numberEnv("INACTIVE_TOKEN_KLINE_RETENTION_DAYS", 7))
  },
  maintenance: {
    cleanupIntervalDays: numberEnv("KLINE_CLEANUP_INTERVAL_DAYS", 7),
    checkIntervalMs: numberEnv("MAINTENANCE_CHECK_INTERVAL_MS", 60 * 60 * 1000),
    deleteBatchSize: numberEnv("MAINTENANCE_DELETE_BATCH_SIZE", 5000),
    signalHistoryRetentionDays: numberEnv("SIGNAL_HISTORY_RETENTION_DAYS", 180),
    hotRankRetentionDays: numberEnv("HOT_RANK_RETENTION_DAYS", 30),
    ioRetentionDays: numberEnv("IO_RETENTION_DAYS", 30)
  },
  fundingMonitor: {
    enabled: boolEnv("FUNDING_INTERVAL_MONITOR_ENABLED", true),
    scanIntervalMs: numberEnv("FUNDING_INTERVAL_SCAN_MS", 60 * 60 * 1000),
    initialDelayMs: numberEnv("FUNDING_INTERVAL_INITIAL_DELAY_MS", 10 * 1000),
    targetIntervalHours: numberEnv("FUNDING_INTERVAL_TARGET_HOURS", 1),
    defaultIntervalHours: numberEnv("FUNDING_INTERVAL_DEFAULT_HOURS", 4)
  },
  openInterestMonitor: {
    enabled: boolEnv("OPEN_INTEREST_MONITOR_ENABLED", true),
    scanIntervalMs: openInterestScanIntervalMs,
    activeMs: numberEnv("OPEN_INTEREST_ACTIVE_MS", Math.max(15 * 60 * 1000, openInterestScanIntervalMs * 3)),
    initialDelayMs: numberEnv("OPEN_INTEREST_INITIAL_DELAY_MS", 20 * 1000),
    concurrency: Math.max(1, numberEnv("OPEN_INTEREST_CONCURRENCY", 3)),
    requestLimitPerWindow: Math.max(1, Math.min(1000, numberEnv("OPEN_INTEREST_REQUEST_LIMIT_PER_5M", 900))),
    historyLimit: Math.max(289, Math.min(500, numberEnv("OPEN_INTEREST_HISTORY_LIMIT", 289))),
    spike5mPct: numberEnv("OPEN_INTEREST_SPIKE_5M_PCT", 2),
    spike1hPct: numberEnv("OPEN_INTEREST_SPIKE_1H_PCT", 10),
    spike4hPct: numberEnv("OPEN_INTEREST_SPIKE_4H_PCT", 20),
    spike1dPct: numberEnv("OPEN_INTEREST_SPIKE_1D_PCT", 40),
    alertCooldownMs: numberEnv("OPEN_INTEREST_ALERT_COOLDOWN_MS", 30 * 60 * 1000),
    standaloneAlertEnabled: boolEnv("OPEN_INTEREST_STANDALONE_ALERT_ENABLED", true)
  },
  signal: {
    nearThresholdPct: numberEnv("MA_NEAR_THRESHOLD_PCT", 1)
  },
  realtime: {
    streamLimit: realtimeStreamLimit,
    tokenLimit: Math.max(1, Math.min(Math.floor(realtimeStreamLimit / 5), numberEnv("REALTIME_KLINE_TOKEN_LIMIT", Math.floor(realtimeStreamLimit / 5))))
  },
  app: {
    publicBaseUrl: process.env.PUBLIC_BASE_URL?.trim() ?? ""
  },
  twitter: {
    token: process.env.TWITTER_TOKEN?.trim() ?? process.env.OPENNEWS_TOKEN?.trim() ?? "",
    tokens: twitterTokenPool,
    heatEnabled: false,
    tokenCooldownMs: numberEnv("TWITTER_TOKEN_COOLDOWN_MS", 10 * 60 * 1000),
    heatCacheMs: numberEnv("TWITTER_HEAT_CACHE_MS", 30 * 60 * 1000),
    failureCacheMs: numberEnv("TWITTER_HEAT_FAILURE_CACHE_MS", 2 * 60 * 1000),
    maxFreshPerRank: numberEnv("TWITTER_HEAT_MAX_FRESH_PER_RANK", 8),
    concurrentRequests: numberEnv("TWITTER_HEAT_CONCURRENT_REQUESTS", 1),
    requestSpacingMs: Math.max(0, numberEnv("TWITTER_REQUEST_SPACING_MS", 1600)),
    timeoutMs: numberEnv("TWITTER_REQUEST_TIMEOUT_MS", 12000)
  },
  hotRank: {
    activeMs: numberEnv("HOT_RANK_ACTIVE_MS", Math.max(30 * 60 * 1000, numberEnv("BINANCE_HOT_RANK_CACHE_MS", 5 * 60 * 1000) * 3)),
    marketCapTopUrl:
      process.env.MARKET_CAP_TOP_URL?.trim() ||
      "https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=10&page=1&sparkline=false",
    marketCapTopCacheMs: numberEnv("MARKET_CAP_TOP_CACHE_MS", 6 * 60 * 60 * 1000),
    marketCapTopTimeoutMs: numberEnv("MARKET_CAP_TOP_TIMEOUT_MS", 5000)
  },
  unlock: {
    enabled: boolEnv("TOKEN_UNLOCK_ENABLED", true),
    provider: process.env.TOKEN_UNLOCK_PROVIDER?.trim() || "official",
    customUrlTemplate: process.env.TOKEN_UNLOCK_URL_TEMPLATE?.trim() || "",
    bearerToken: process.env.TOKEN_UNLOCK_BEARER_TOKEN?.trim() || "",
    mobulaApiKey: process.env.MOBULA_API_KEY?.trim() || "",
    cacheMs: numberEnv("TOKEN_UNLOCK_CACHE_MS", 24 * 60 * 60 * 1000),
    retryCacheMs: numberEnv("TOKEN_UNLOCK_RETRY_CACHE_MS", 60 * 60 * 1000),
    scanIntervalMs: numberEnv("TOKEN_UNLOCK_SCAN_MS", 60 * 60 * 1000),
    requestTimeoutMs: numberEnv("TOKEN_UNLOCK_REQUEST_TIMEOUT_MS", 15_000)
  },
  telegram: {
    enabled: boolEnv("TELEGRAM_ALERTS_ENABLED", false),
    botToken: process.env.TELEGRAM_BOT_TOKEN?.trim() ?? "",
    chatId: process.env.TELEGRAM_CHAT_ID?.trim() ?? "",
    level1Enabled: boolEnv("TELEGRAM_LEVEL1_ENABLED", false),
    level2Enabled: boolEnv("TELEGRAM_LEVEL2_ENABLED", false),
    timeoutMs: numberEnv("TELEGRAM_REQUEST_TIMEOUT_MS", 12000),
    retries: Math.max(1, numberEnv("TELEGRAM_REQUEST_RETRIES", 4)),
    retryDelayMs: Math.max(250, numberEnv("TELEGRAM_RETRY_DELAY_MS", 900)),
    menuCacheMs: Math.max(1000, numberEnv("TELEGRAM_MENU_CACHE_MS", 30_000)),
    menuStaleMs: Math.max(30_000, numberEnv("TELEGRAM_MENU_STALE_MS", 5 * 60_000)),
    menuWarmIntervalMs: Math.max(10_000, numberEnv("TELEGRAM_MENU_WARM_INTERVAL_MS", 60_000))
  }
};
