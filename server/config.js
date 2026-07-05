import dotenv from "dotenv";

dotenv.config({ path: ".env.local", quiet: true });
dotenv.config({ quiet: true });

export function numberEnv(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const text = String(raw).trim();
  if (!text) return fallback;
  const value = Number(text);
  return Number.isFinite(value) ? value : fallback;
}

export function boolEnv(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const value = String(raw).trim().toLowerCase();
  if (!value) return fallback;
  if (["true", "1", "yes", "y", "on"].includes(value)) return true;
  if (["false", "0", "no", "n", "off"].includes(value)) return false;
  return fallback;
}

export function listEnv(name, fallback = []) {
  const value = process.env[name];
  if (value === undefined || !String(value).trim()) return fallback;
  return String(value)
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function integerEnv(name, fallback, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) {
  const safeMin = Math.max(1, Math.floor(Number(min) || 1));
  const safeMax = Math.max(safeMin, Math.floor(Number(max) || safeMin));
  const value = Math.floor(numberEnv(name, fallback));
  return Math.max(safeMin, Math.min(safeMax, Number.isFinite(value) ? value : fallback));
}

function validateUniqueServicePorts(service) {
  const entries = [
    ["API_PORT", service.apiPort],
    ["CRAWLER_PORT", service.crawlerPort],
    ["REALTIME_PORT", service.realtimePort],
    ["SCHEDULER_PORT", service.schedulerPort]
  ];
  const seen = new Map();
  for (const [name, port] of entries) {
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new Error(`${name} must be an integer between 1 and 65535`);
    }
    const previous = seen.get(port);
    if (previous) {
      throw new Error(`Service port conflict: ${previous} and ${name} both use ${port}`);
    }
    seen.set(port, name);
  }
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
const crawlerConcurrentTokens = integerEnv("CRAWLER_CONCURRENT_TOKENS", 4);

const SERVICE_ROLES = new Set(["api", "crawler", "realtime", "scheduler"]);
const requestedServiceRole = process.env.SERVICE_ROLE?.trim() || "api";
const serviceRole = SERVICE_ROLES.has(requestedServiceRole) ? requestedServiceRole : "api";
const defaultConnectionLimits = {
  api: 5,
  crawler: Math.max(4, crawlerConcurrentTokens + 3),
  realtime: 4,
  scheduler: 3
};
const connectionLimit = numberEnv(
  `MYSQL_${serviceRole.toUpperCase()}_CONNECTION_LIMIT`,
  numberEnv("MYSQL_CONNECTION_LIMIT", defaultConnectionLimits[serviceRole] ?? 3)
);

export const config = {
  service: {
    role: serviceRole,
    host: process.env.SERVICE_HOST?.trim() || "127.0.0.1",
    apiHost: process.env.API_HOST?.trim() || "127.0.0.1",
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
    password: process.env.MYSQL_PASSWORD ?? "",
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
    klineRequestRetries: numberEnv("BINANCE_KLINE_REQUEST_RETRIES", numberEnv("BINANCE_REQUEST_RETRIES", 4) + 4),
    retryDelayMs: numberEnv("BINANCE_RETRY_DELAY_MS", 1000),
    requestWeightBudgetPerMinute: numberEnv("BINANCE_REQUEST_WEIGHT_BUDGET_PER_MINUTE", 1800)
  },
  tradeAnalysis: {
    requestTimeoutMs: numberEnv("TRADE_ANALYSIS_REQUEST_TIMEOUT_MS", numberEnv("REQUEST_TIMEOUT_MS", 15000)),
    defaultLookbackDays: Math.max(1, numberEnv("TRADE_ANALYSIS_DEFAULT_LOOKBACK_DAYS", 90)),
    maxEventRows: Math.max(100, numberEnv("TRADE_ANALYSIS_EVENT_LIMIT", 5000)),
    positionPrefetchEnabled: boolEnv("TRADE_POSITION_PREFETCH_ENABLED", true),
    positionPrefetchIntervalMs: Math.max(10_000, numberEnv("TRADE_POSITION_PREFETCH_MS", 60_000)),
    positionPrefetchInitialDelayMs: Math.max(0, numberEnv("TRADE_POSITION_PREFETCH_INITIAL_DELAY_MS", 2_000)),
    positionCacheMs: Math.max(30_000, numberEnv("TRADE_POSITION_CACHE_MS", 5 * 60_000)),
    codex: {
      command: process.env.CODEX_CLI_PATH?.trim() || "/Applications/Codex.app/Contents/Resources/codex",
      timeoutMs: Math.max(30_000, numberEnv("TRADE_ANALYSIS_CODEX_TIMEOUT_MS", 180_000)),
      contextEventLimit: Math.max(10, Math.min(180, numberEnv("TRADE_ANALYSIS_CODEX_EVENT_LIMIT", 80))),
      tokenContextKlineLimit: Math.max(24, Math.min(720, numberEnv("TOKEN_ANALYSIS_CODEX_KLINE_LIMIT", 360)))
    },
    binance: {
      apiKey: process.env.BINANCE_API_KEY?.trim() ?? "",
      apiSecret: process.env.BINANCE_API_SECRET?.trim() ?? "",
      futuresBaseUrl: process.env.BINANCE_FUTURES_BASE_URL ?? "https://fapi.binance.com",
      recvWindowMs: numberEnv("BINANCE_RECV_WINDOW_MS", 5000),
      fundingRateConcurrency: integerEnv("TRADE_ANALYSIS_FUNDING_RATE_CONCURRENCY", 3, { max: 5 })
    },
    hyperliquid: {
      walletAddress: process.env.HYPERLIQUID_WALLET_ADDRESS?.trim() ?? "",
      infoBaseUrl: process.env.HYPERLIQUID_INFO_BASE_URL?.trim() || "https://api.hyperliquid.xyz/info",
      perpDexs: listEnv("HYPERLIQUID_PERP_DEXS")
    }
  },
  crawler: {
    autoStart: boolEnv("AUTO_START_CRAWLER", true),
    concurrentTokens: crawlerConcurrentTokens,
    watchlistMarketConcurrency: integerEnv("WATCHLIST_MARKET_CONCURRENCY", crawlerConcurrentTokens, {
      max: Math.min(8, Math.max(1, connectionLimit - 2))
    }),
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
    tailRefreshEnabled: boolEnv("KLINE_TAIL_REFRESH_ENABLED", true),
    tailRefreshLimit: Math.max(1, numberEnv("KLINE_TAIL_REFRESH_LIMIT", 2500)),
    tailRefreshKlineLimit: Math.max(2, Math.min(100, numberEnv("KLINE_TAIL_REFRESH_REQUEST_LIMIT", 20))),
    recoveryAuditMs: Math.max(5 * 60 * 1000, numberEnv("KLINE_RECOVERY_AUDIT_MS", 10 * 60 * 1000)),
    maxGapRepairPasses: Math.max(25, Math.min(500, numberEnv("KLINE_MAX_GAP_REPAIR_PASSES", 120))),
    onDemandMaxGapRepairPasses: Math.max(25, Math.min(1000, numberEnv("KLINE_ON_DEMAND_MAX_GAP_REPAIR_PASSES", 300))),
    tokenUniverseSyncMs: numberEnv("TOKEN_UNIVERSE_SYNC_MS", 6 * 60 * 60 * 1000),
    dailyAuditHour: Math.max(0, Math.min(23, numberEnv("KLINE_DAILY_AUDIT_HOUR", 0))),
    inactiveRetentionDays: Math.max(1, numberEnv("INACTIVE_TOKEN_KLINE_RETENTION_DAYS", 7))
  },
  maintenance: {
    cleanupIntervalDays: numberEnv("KLINE_CLEANUP_INTERVAL_DAYS", 7),
    checkIntervalMs: numberEnv("MAINTENANCE_CHECK_INTERVAL_MS", 60 * 60 * 1000),
    deleteBatchSize: numberEnv("MAINTENANCE_DELETE_BATCH_SIZE", 5000),
    hotRankRetentionDays: numberEnv("HOT_RANK_RETENTION_DAYS", 7),
    ioRetentionDays: numberEnv("IO_RETENTION_DAYS", 7),
    runtimeLogCleanupIntervalHours: Math.max(
      1,
      numberEnv("RUNTIME_LOG_CLEANUP_INTERVAL_HOURS", numberEnv("RECORD_CLEANUP_INTERVAL_HOURS", 4))
    )
  },
  fundingMonitor: {
    enabled: boolEnv("FUNDING_INTERVAL_MONITOR_ENABLED", true),
    scanIntervalMs: numberEnv("FUNDING_INTERVAL_SCAN_MS", 5 * 60 * 1000),
    alertPollMs: Math.max(10 * 1000, numberEnv("FUNDING_INTERVAL_ALERT_POLL_MS", 60 * 1000)),
    initialDelayMs: numberEnv("FUNDING_INTERVAL_INITIAL_DELAY_MS", 10 * 1000),
    alertConcurrency: integerEnv("FUNDING_ALERT_CONCURRENCY", 2, {
      max: Math.min(3, Math.max(1, connectionLimit - 1))
    }),
    targetIntervalHours: numberEnv("FUNDING_INTERVAL_TARGET_HOURS", 1),
    defaultIntervalHours: numberEnv("FUNDING_INTERVAL_DEFAULT_HOURS", 4)
  },
  openInterestMonitor: {
    enabled: boolEnv("OPEN_INTEREST_MONITOR_ENABLED", true),
    scanIntervalMs: openInterestScanIntervalMs,
    activeMs: numberEnv("OPEN_INTEREST_ACTIVE_MS", Math.max(15 * 60 * 1000, openInterestScanIntervalMs * 3)),
    initialDelayMs: numberEnv("OPEN_INTEREST_INITIAL_DELAY_MS", 20 * 1000),
    concurrency: Math.max(1, Math.min(32, numberEnv("OPEN_INTEREST_CONCURRENCY", 10))),
    scanLimitPerRun: Math.max(1, numberEnv("OPEN_INTEREST_SCAN_LIMIT_PER_RUN", 500)),
    runBudgetMs: Math.max(
      30 * 1000,
      numberEnv("OPEN_INTEREST_RUN_BUDGET_MS", Math.max(30 * 1000, openInterestScanIntervalMs - 30 * 1000))
    ),
    requestTimeoutMs: Math.max(1000, numberEnv("OPEN_INTEREST_REQUEST_TIMEOUT_MS", 8000)),
    requestRetries: Math.max(0, numberEnv("OPEN_INTEREST_REQUEST_RETRIES", 1)),
    requestLimitPerWindow: Math.max(1, Math.min(1000, numberEnv("OPEN_INTEREST_REQUEST_LIMIT_PER_5M", 900))),
    retryDelayMs: Math.max(5 * 1000, numberEnv("OPEN_INTEREST_RETRY_DELAY_MS", 30 * 1000)),
    historyLimit: Math.max(289, Math.min(500, numberEnv("OPEN_INTEREST_HISTORY_LIMIT", 289))),
    historyBootstrapLimitPerRun: Math.max(0, numberEnv("OPEN_INTEREST_HISTORY_BOOTSTRAP_LIMIT_PER_RUN", 80)),
    historyBootstrapRetryMs: Math.max(
      5 * 60 * 1000,
      numberEnv("OPEN_INTEREST_HISTORY_BOOTSTRAP_RETRY_MS", 30 * 60 * 1000)
    ),
    historyUnavailableRetryMs: Math.max(
      30 * 60 * 1000,
      numberEnv("OPEN_INTEREST_HISTORY_UNAVAILABLE_RETRY_MS", 6 * 60 * 60 * 1000)
    ),
    sampleRetentionDays: Math.max(2, numberEnv("OPEN_INTEREST_SAMPLE_RETENTION_DAYS", 3)),
    spike5mPct: numberEnv("OPEN_INTEREST_SPIKE_5M_PCT", 2),
    spike1hPct: numberEnv("OPEN_INTEREST_SPIKE_1H_PCT", 10),
    spike4hPct: numberEnv("OPEN_INTEREST_SPIKE_4H_PCT", 20),
    spike1dPct: numberEnv("OPEN_INTEREST_SPIKE_1D_PCT", 40),
    standaloneAlertEnabled: boolEnv("OPEN_INTEREST_STANDALONE_ALERT_ENABLED", true)
  },
  signal: {
    nearThresholdPct: numberEnv("MA_NEAR_THRESHOLD_PCT", 1)
  },
  realtime: {
    streamLimit: realtimeStreamLimit,
    tokenLimit: Math.max(1, Math.min(Math.floor(realtimeStreamLimit / 5), numberEnv("REALTIME_KLINE_TOKEN_LIMIT", Math.floor(realtimeStreamLimit / 5)))),
    watchlistAlertCooldownMs: Math.max(0, numberEnv("WATCHLIST_ALERT_COOLDOWN_MS", 10 * 60 * 1000))
  },
  app: {
    publicBaseUrl: process.env.PUBLIC_BASE_URL?.trim() ?? "",
    mutationToken: process.env.API_MUTATION_TOKEN?.trim() ?? ""
  },
  hotRank: {
    activeMs: numberEnv("HOT_RANK_ACTIVE_MS", Math.max(30 * 60 * 1000, numberEnv("BINANCE_HOT_RANK_CACHE_MS", 5 * 60 * 1000) * 3)),
    requestTimeoutMs: Math.max(1000, numberEnv("HOT_RANK_REQUEST_TIMEOUT_MS", numberEnv("REQUEST_TIMEOUT_MS", 15000))),
    requestRetries: Math.max(0, numberEnv("HOT_RANK_REQUEST_RETRIES", Math.min(2, numberEnv("BINANCE_REQUEST_RETRIES", 4)))),
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
    requestTimeoutMs: numberEnv("TOKEN_UNLOCK_REQUEST_TIMEOUT_MS", 15_000),
    concurrency: integerEnv("TOKEN_UNLOCK_CONCURRENCY", 2, {
      max: Math.min(5, Math.max(1, connectionLimit - 1))
    })
  },
  telegram: {
    enabled: boolEnv("TELEGRAM_ALERTS_ENABLED", false),
    botToken: process.env.TELEGRAM_BOT_TOKEN?.trim() ?? "",
    chatId: process.env.TELEGRAM_CHAT_ID?.trim() ?? "",
    timeoutMs: numberEnv("TELEGRAM_REQUEST_TIMEOUT_MS", 12000),
    retries: Math.max(1, numberEnv("TELEGRAM_REQUEST_RETRIES", 4)),
    retryDelayMs: Math.max(250, numberEnv("TELEGRAM_RETRY_DELAY_MS", 900)),
    alertQueuePollMs: Math.max(1000, numberEnv("TELEGRAM_ALERT_QUEUE_POLL_MS", 5000)),
    alertQueueBatchSize: Math.max(1, Math.min(50, numberEnv("TELEGRAM_ALERT_QUEUE_BATCH_SIZE", 10))),
    alertQueueMaxAttempts: Math.max(1, numberEnv("TELEGRAM_ALERT_QUEUE_MAX_ATTEMPTS", 8)),
    menuCacheMs: Math.max(1000, numberEnv("TELEGRAM_MENU_CACHE_MS", 30_000)),
    menuStaleMs: Math.max(30_000, numberEnv("TELEGRAM_MENU_STALE_MS", 5 * 60_000)),
    menuWarmIntervalMs: Math.max(10_000, numberEnv("TELEGRAM_MENU_WARM_INTERVAL_MS", 60_000))
  }
};

validateUniqueServicePorts(config.service);
