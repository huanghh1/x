import mysql from "mysql2/promise";
import { config } from "./config.js";

let pool;

const TABLE_SQL = [
  `CREATE TABLE IF NOT EXISTS token_list (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    symbol VARCHAR(32) NOT NULL,
    base_asset VARCHAR(32) NOT NULL,
    quote_asset VARCHAR(16) NOT NULL DEFAULT 'USDT',
    category_type ENUM('A','B') NOT NULL,
    category_label VARCHAR(80) NOT NULL,
    has_spot TINYINT(1) NOT NULL DEFAULT 0,
    has_futures TINYINT(1) NOT NULL DEFAULT 1,
    is_alpha TINYINT(1) NOT NULL DEFAULT 0,
    is_active TINYINT(1) NOT NULL DEFAULT 1,
    fetch_status ENUM('pending','fetching','partial','completed','failed') NOT NULL DEFAULT 'pending',
    current_interval VARCHAR(8) NULL,
    fetched_interval_count TINYINT UNSIGNED NOT NULL DEFAULT 0,
    total_interval_count TINYINT UNSIGNED NOT NULL DEFAULT 4,
    fetch_attempts INT UNSIGNED NOT NULL DEFAULT 0,
    last_error TEXT NULL,
    cache_completed_at DATETIME(3) NULL,
    cache_policy_key VARCHAR(160) NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    UNIQUE KEY uk_token_symbol (symbol),
    KEY idx_token_category_status (category_type, fetch_status),
    KEY idx_token_status (fetch_status, updated_at)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
  `CREATE TABLE IF NOT EXISTS kline_cache (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    token_id BIGINT UNSIGNED NOT NULL,
    symbol VARCHAR(32) NOT NULL,
    interval_code ENUM('15m','1h','4h','1d') NOT NULL,
    open_time BIGINT UNSIGNED NOT NULL,
    close_time BIGINT UNSIGNED NOT NULL,
    open_price DECIMAL(32,12) NOT NULL,
    high_price DECIMAL(32,12) NOT NULL,
    low_price DECIMAL(32,12) NOT NULL,
    close_price DECIMAL(32,12) NOT NULL,
    volume DECIMAL(38,12) NOT NULL,
    quote_volume DECIMAL(38,12) NULL,
    trade_count BIGINT UNSIGNED NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    UNIQUE KEY uk_kline_symbol_interval_time (symbol, interval_code, open_time),
    KEY idx_kline_token_interval_time (token_id, interval_code, open_time),
    CONSTRAINT fk_kline_token FOREIGN KEY (token_id) REFERENCES token_list(id) ON DELETE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
  `CREATE TABLE IF NOT EXISTS signal_result (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    token_id BIGINT UNSIGNED NOT NULL,
    symbol VARCHAR(32) NOT NULL,
    category_type ENUM('A','B') NOT NULL,
    interval_code ENUM('15m','1h','4h','1d') NOT NULL,
    ma100 DECIMAL(32,12) NULL,
    ma200 DECIMAL(32,12) NULL,
    current_price DECIMAL(32,12) NULL,
    alert_level ENUM('LEVEL1','LEVEL2','NONE','INSUFFICIENT') NOT NULL DEFAULT 'NONE',
    proximity_pct DECIMAL(16,8) NULL,
    signal_weight DECIMAL(16,8) NULL,
    signal_status VARCHAR(48) NOT NULL,
    note VARCHAR(255) NOT NULL,
    signal_time DATETIME(3) NOT NULL,
    telegram_sent_at DATETIME(3) NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    UNIQUE KEY uk_signal_symbol_interval (symbol, interval_code),
    KEY idx_signal_category_level (category_type, alert_level, signal_weight),
    KEY idx_signal_time (signal_time),
    CONSTRAINT fk_signal_token FOREIGN KEY (token_id) REFERENCES token_list(id) ON DELETE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
  `CREATE TABLE IF NOT EXISTS maintenance_state (
    task_name VARCHAR(64) NOT NULL,
    last_run_at DATETIME(3) NULL,
    last_result TEXT NULL,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (task_name)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
  `CREATE TABLE IF NOT EXISTS hot_rank_seen (
    symbol VARCHAR(32) NOT NULL,
    base_asset VARCHAR(32) NOT NULL,
    chain_label VARCHAR(32) NULL,
    first_seen_rank INT UNSIGNED NULL,
    last_seen_rank INT UNSIGNED NULL,
    first_seen_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    last_seen_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    notified_at DATETIME(3) NULL,
    PRIMARY KEY (symbol),
    KEY idx_hot_rank_last_seen (last_seen_at)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
  `CREATE TABLE IF NOT EXISTS watchlist (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    symbol VARCHAR(32) NOT NULL,
    base_asset VARCHAR(32) NOT NULL,
    note VARCHAR(255) NULL,
    alert_above DECIMAL(32,12) NULL,
    alert_below DECIMAL(32,12) NULL,
    alert_enabled TINYINT(1) NOT NULL DEFAULT 1,
    last_alert_at DATETIME(3) NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    UNIQUE KEY uk_watch_symbol (symbol),
    KEY idx_watch_enabled (alert_enabled, updated_at)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`
];

export async function ensureDatabase() {
  const admin = await mysql.createConnection({
    host: config.mysql.host,
    port: config.mysql.port,
    user: config.mysql.user,
    password: config.mysql.password,
    charset: "utf8mb4"
  });
  await admin.query(
    `CREATE DATABASE IF NOT EXISTS \`${config.mysql.database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`
  );
  await admin.end();

  pool = mysql.createPool({
    host: config.mysql.host,
    port: config.mysql.port,
    user: config.mysql.user,
    password: config.mysql.password,
    database: config.mysql.database,
    waitForConnections: true,
    connectionLimit: config.mysql.connectionLimit,
    namedPlaceholders: true,
    charset: "utf8mb4"
  });

  for (const sql of TABLE_SQL) {
    await pool.query(sql);
  }
  await ensureTokenListPolicyColumn();
  await ensureTokenListActiveColumn();
  await deactivateExcludedTokens();
}

async function ensureTokenListPolicyColumn() {
  const [columns] = await pool.query("SHOW COLUMNS FROM token_list LIKE 'cache_policy_key'");
  if (columns.length > 0) return;
  await pool.query("ALTER TABLE token_list ADD COLUMN cache_policy_key VARCHAR(160) NULL AFTER cache_completed_at");
}

async function ensureTokenListActiveColumn() {
  const [columns] = await pool.query("SHOW COLUMNS FROM token_list LIKE 'is_active'");
  if (columns.length > 0) return;
  await pool.query("ALTER TABLE token_list ADD COLUMN is_active TINYINT(1) NOT NULL DEFAULT 1 AFTER is_alpha");
}

const EXCLUDED_BASE_ASSETS = [
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
];

async function deactivateExcludedTokens() {
  await pool.query(
    `UPDATE token_list
     SET is_active=0
     WHERE base_asset IN (?)
        OR base_asset REGEXP '^(USD|EUR|GBP|JPY|AUD|CAD|CHF|TRY|BRL|ARS|MXN|RUB|HKD|SGD|CNH)'
        OR base_asset REGEXP '(GOLD|SILVER|OIL|STOCK|ETF|BOND|TREASURY)$'`,
    [EXCLUDED_BASE_ASSETS]
  );
}

export function getPool() {
  if (!pool) throw new Error("Database has not been initialized");
  return pool;
}

export async function pingDatabase() {
  await getPool().query("SELECT 1 AS ok");
  return true;
}

export async function upsertTokens(tokens) {
  if (tokens.length === 0) return 0;
  const rows = tokens.map((token) => [
    token.symbol,
    token.baseAsset,
    "USDT",
    token.categoryType,
    token.categoryLabel,
    token.hasSpot ? 1 : 0,
    token.hasFutures ? 1 : 0,
    token.isAlpha ? 1 : 0
  ]);
  await getPool().query(
    `INSERT INTO token_list
      (symbol, base_asset, quote_asset, category_type, category_label, has_spot, has_futures, is_alpha)
     VALUES ?
     ON DUPLICATE KEY UPDATE
      base_asset = VALUES(base_asset),
      category_type = VALUES(category_type),
      category_label = VALUES(category_label),
      has_spot = VALUES(has_spot),
      has_futures = VALUES(has_futures),
      is_alpha = VALUES(is_alpha)`,
    [rows]
  );
  const symbols = tokens.map((token) => token.symbol);
  if (symbols.length > 0) {
    await getPool().query("UPDATE token_list SET is_active=1 WHERE symbol IN (?)", [symbols]);
    await getPool().query("UPDATE token_list SET is_active=0 WHERE symbol NOT IN (?)", [symbols]);
  }
  return rows.length;
}

export async function countActiveTokens() {
  const [rows] = await getPool().query("SELECT COUNT(*) AS count FROM token_list WHERE is_active=1");
  return Number(rows[0]?.count ?? 0);
}

export async function selectNextTokenForFetch() {
  const incrementalRefreshSeconds = Math.max(60, Math.floor(config.crawler.incrementalRefreshMs / 1000));
  const [rows] = await getPool().query(
    `SELECT * FROM token_list
     WHERE is_active=1
       AND (fetch_status IN ('pending','partial','failed','fetching')
        OR (fetch_status='completed' AND (cache_policy_key IS NULL OR cache_policy_key <> :cachePolicyKey))
        OR (fetch_status='completed' AND cache_completed_at < DATE_SUB(NOW(3), INTERVAL :incrementalRefreshSeconds SECOND)))
     ORDER BY
      CASE fetch_status WHEN 'partial' THEN 0 WHEN 'fetching' THEN 1 WHEN 'failed' THEN 2 ELSE 3 END,
      category_type ASC,
      updated_at ASC
     LIMIT 1`,
    { cachePolicyKey: config.crawler.cachePolicyKey, incrementalRefreshSeconds }
  );
  return rows[0] ?? null;
}

export async function resetInterruptedFetchingTokens(staleAfterMs) {
  const staleSeconds = Math.max(0, Math.floor((Number(staleAfterMs) || 0) / 1000));
  const [result] = await getPool().query(
    `UPDATE token_list
     SET fetch_status=IF(fetched_interval_count > 0, 'partial', 'pending'),
         current_interval=NULL,
         last_error=COALESCE(last_error, '上次抓取中断，已重新排队')
     WHERE fetch_status='fetching'
       AND updated_at < DATE_SUB(NOW(3), INTERVAL :staleSeconds SECOND)`,
    { staleSeconds }
  );
  return result.affectedRows ?? 0;
}

export async function claimNextTokenForFetch() {
  const connection = await getPool().getConnection();
  try {
    const incrementalRefreshSeconds = Math.max(60, Math.floor(config.crawler.incrementalRefreshMs / 1000));
    await connection.beginTransaction();
    const [rows] = await connection.query(
      `SELECT * FROM token_list
     WHERE is_active=1
       AND (fetch_status IN ('pending','partial','failed')
          OR (fetch_status='completed' AND (cache_policy_key IS NULL OR cache_policy_key <> :cachePolicyKey))
          OR (fetch_status='completed' AND cache_completed_at < DATE_SUB(NOW(3), INTERVAL :incrementalRefreshSeconds SECOND)))
       ORDER BY
        CASE fetch_status WHEN 'partial' THEN 0 WHEN 'failed' THEN 1 WHEN 'completed' THEN 2 ELSE 3 END,
        category_type ASC,
        updated_at ASC
       LIMIT 1
       FOR UPDATE`,
      { cachePolicyKey: config.crawler.cachePolicyKey, incrementalRefreshSeconds }
    );
    const token = rows[0] ?? null;
    if (!token) {
      await connection.commit();
      return null;
    }
    await connection.query(
      `UPDATE token_list
       SET fetch_status='fetching', current_interval=NULL, last_error=NULL
       WHERE id=:tokenId`,
      { tokenId: token.id }
    );
    await connection.commit();
    return { ...token, fetch_status: "fetching", current_interval: null, last_error: null };
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}

export async function markTokenFetching(tokenId, intervalCode) {
  await getPool().query(
    `UPDATE token_list
     SET fetch_status='fetching', current_interval=:intervalCode, fetch_attempts=fetch_attempts+1, last_error=NULL
     WHERE id=:tokenId`,
    { tokenId, intervalCode }
  );
}

export async function markTokenPartial(tokenId, error) {
  await getPool().query(
    `UPDATE token_list
     SET fetch_status='partial', current_interval=NULL, last_error=:error
     WHERE id=:tokenId`,
    { tokenId, error: String(error).slice(0, 1000) }
  );
}

export async function refreshTokenFetchState(tokenId) {
  const [counts] = await getPool().query(
    `SELECT COUNT(DISTINCT interval_code) AS intervalCount
     FROM kline_cache
     WHERE token_id=:tokenId`,
    { tokenId }
  );
  const intervalCount = Number(counts[0]?.intervalCount ?? 0);
  await getPool().query(
    `UPDATE token_list
     SET fetched_interval_count=:intervalCount,
         fetch_status=IF(:intervalCount >= total_interval_count, 'completed', IF(:intervalCount > 0, 'partial', fetch_status)),
         current_interval=NULL,
         cache_completed_at=IF(:intervalCount >= total_interval_count, NOW(3), cache_completed_at),
         cache_policy_key=IF(:intervalCount >= total_interval_count, :cachePolicyKey, cache_policy_key)
     WHERE id=:tokenId`,
    { tokenId, intervalCount, cachePolicyKey: config.crawler.cachePolicyKey }
  );
  return intervalCount;
}

export async function klineCount(symbol, intervalCode) {
  const [rows] = await getPool().query(
    `SELECT COUNT(*) AS count FROM kline_cache WHERE symbol=:symbol AND interval_code=:intervalCode`,
    { symbol, intervalCode }
  );
  return Number(rows[0]?.count ?? 0);
}

export async function klineStats(symbol, intervalCode) {
  const [rows] = await getPool().query(
    `SELECT
      COUNT(*) AS count,
      MIN(open_time) AS minOpenTime,
      MAX(open_time) AS maxOpenTime
     FROM kline_cache
     WHERE symbol=:symbol AND interval_code=:intervalCode`,
    { symbol, intervalCode }
  );
  const row = rows[0] ?? {};
  return {
    count: Number(row.count ?? 0),
    minOpenTime: row.minOpenTime === null || row.minOpenTime === undefined ? null : Number(row.minOpenTime),
    maxOpenTime: row.maxOpenTime === null || row.maxOpenTime === undefined ? null : Number(row.maxOpenTime)
  };
}

export async function findKlineGap(symbol, intervalCode, intervalMsValue, startTime, endTime) {
  const safeSymbol = String(symbol ?? "").toUpperCase().replace(/[^A-Z0-9_]/g, "");
  const [rows] = await getPool().query(
    `SELECT open_time AS openTime
     FROM kline_cache
     WHERE symbol=:symbol
       AND interval_code=:intervalCode
       AND open_time>=:startTime
       AND open_time<=:endTime
     ORDER BY open_time ASC`,
    {
      symbol: safeSymbol,
      intervalCode,
      startTime: Math.max(0, Number(startTime) || 0),
      endTime: Math.max(0, Number(endTime) || 0)
    }
  );
  if (rows.length < 2) return null;
  let previousOpenTime = Number(rows[0].openTime);
  const safeIntervalMs = Math.max(1, Number(intervalMsValue) || 1);
  for (const row of rows.slice(1)) {
    const currentOpenTime = Number(row.openTime);
    const expectedOpenTime = previousOpenTime + safeIntervalMs;
    if (currentOpenTime > expectedOpenTime) {
      return {
        startTime: expectedOpenTime,
        endTime: currentOpenTime - safeIntervalMs
      };
    }
    previousOpenTime = currentOpenTime;
  }
  return null;
}

export async function cleanupKlineRetention(symbol, intervalCode, retentionLimit) {
  const safeLimit = Math.max(200, Number(retentionLimit) || 0);
  const [cutoffRows] = await getPool().query(
    `SELECT open_time AS cutoffOpenTime
     FROM kline_cache
     WHERE symbol=:symbol AND interval_code=:intervalCode
     ORDER BY open_time DESC
     LIMIT 1 OFFSET :offset`,
    { symbol, intervalCode, offset: safeLimit - 1 }
  );
  const cutoffOpenTime = cutoffRows[0]?.cutoffOpenTime;
  if (cutoffOpenTime === undefined || cutoffOpenTime === null) return 0;

  const [result] = await getPool().query(
    `DELETE FROM kline_cache
     WHERE symbol=:symbol
       AND interval_code=:intervalCode
       AND open_time < :cutoffOpenTime`,
    { symbol, intervalCode, cutoffOpenTime: Number(cutoffOpenTime) }
  );
  return result.affectedRows ?? 0;
}

export async function cleanupAllKlineRetention(retentionLimits) {
  const results = [];
  for (const [intervalCode, retentionLimit] of Object.entries(retentionLimits)) {
    const [symbols] = await getPool().query(
      `SELECT symbol
       FROM kline_cache
       WHERE interval_code=:intervalCode
       GROUP BY symbol`,
      { intervalCode }
    );
    let deletedRows = 0;
    for (const row of symbols) {
      deletedRows += await cleanupKlineRetention(row.symbol, intervalCode, retentionLimit);
    }
    results.push({
      intervalCode,
      retentionLimit,
      symbolCount: symbols.length,
      deletedRows
    });
  }
  return results;
}

export async function getMaintenanceState(taskName) {
  const [rows] = await getPool().query(
    `SELECT task_name AS taskName, last_run_at AS lastRunAt, last_result AS lastResult
     FROM maintenance_state
     WHERE task_name=:taskName
     LIMIT 1`,
    { taskName }
  );
  return rows[0] ?? null;
}

export async function markMaintenanceState(taskName, result) {
  await getPool().query(
    `INSERT INTO maintenance_state (task_name, last_run_at, last_result)
     VALUES (:taskName, NOW(3), :result)
     ON DUPLICATE KEY UPDATE
      last_run_at=VALUES(last_run_at),
      last_result=VALUES(last_result)`,
    { taskName, result: String(result).slice(0, 2000) }
  );
}

export async function insertKlinePage(token, intervalCode, klines) {
  if (klines.length === 0) return 0;
  const rows = klines.map((kline) => [
    token.id,
    token.symbol,
    intervalCode,
    Number(kline[0]),
    Number(kline[6]),
    kline[1],
    kline[2],
    kline[3],
    kline[4],
    kline[5],
    kline[7] ?? null,
    kline[8] ?? null
  ]);
  const [result] = await getPool().query(
    `INSERT IGNORE INTO kline_cache
      (token_id, symbol, interval_code, open_time, close_time, open_price, high_price, low_price, close_price, volume, quote_volume, trade_count)
     VALUES ?`,
    [rows]
  );
  return result.affectedRows ?? 0;
}

export async function upsertKlinePage(token, intervalCode, klines) {
  if (klines.length === 0) return 0;
  const rows = klines.map((kline) => [
    token.id,
    token.symbol,
    intervalCode,
    Number(kline[0]),
    Number(kline[6]),
    kline[1],
    kline[2],
    kline[3],
    kline[4],
    kline[5],
    kline[7] ?? null,
    kline[8] ?? null
  ]);
  const [result] = await getPool().query(
    `INSERT INTO kline_cache
      (token_id, symbol, interval_code, open_time, close_time, open_price, high_price, low_price, close_price, volume, quote_volume, trade_count)
     VALUES ?
     ON DUPLICATE KEY UPDATE
      token_id=VALUES(token_id),
      close_time=VALUES(close_time),
      open_price=VALUES(open_price),
      high_price=VALUES(high_price),
      low_price=VALUES(low_price),
      close_price=VALUES(close_price),
      volume=VALUES(volume),
      quote_volume=VALUES(quote_volume),
      trade_count=VALUES(trade_count)`,
    [rows]
  );
  return result.affectedRows ?? 0;
}

export async function selectClosePrices(symbol, intervalCode) {
  const [rows] = await getPool().query(
    `SELECT close_price AS closePrice, close_time AS closeTime
     FROM kline_cache
     WHERE symbol=:symbol AND interval_code=:intervalCode
     ORDER BY open_time ASC`,
    { symbol, intervalCode }
  );
  return rows.map((row) => ({
    close: Number(row.closePrice),
    closeTime: Number(row.closeTime)
  }));
}

export async function selectPreviousSignal(symbol, intervalCode) {
  const [rows] = await getPool().query(
    `SELECT * FROM signal_result WHERE symbol=:symbol AND interval_code=:intervalCode LIMIT 1`,
    { symbol, intervalCode }
  );
  return rows[0] ?? null;
}

export async function upsertSignal(token, signal) {
  await getPool().query(
    `INSERT INTO signal_result
      (token_id, symbol, category_type, interval_code, ma100, ma200, current_price, alert_level, proximity_pct, signal_weight, signal_status, note, signal_time)
     VALUES
      (:tokenId, :symbol, :categoryType, :intervalCode, :ma100, :ma200, :currentPrice, :alertLevel, :proximityPct, :signalWeight, :signalStatus, :note, FROM_UNIXTIME(:signalTime / 1000))
     ON DUPLICATE KEY UPDATE
      token_id=VALUES(token_id),
      category_type=VALUES(category_type),
      ma100=VALUES(ma100),
      ma200=VALUES(ma200),
      current_price=VALUES(current_price),
      proximity_pct=VALUES(proximity_pct),
      signal_weight=VALUES(signal_weight),
      signal_status=VALUES(signal_status),
      note=VALUES(note),
      signal_time=VALUES(signal_time),
      telegram_sent_at=IF(alert_level <> VALUES(alert_level), NULL, telegram_sent_at),
      alert_level=VALUES(alert_level)`,
    {
      tokenId: token.id,
      symbol: token.symbol,
      categoryType: token.category_type,
      intervalCode: signal.intervalCode,
      ma100: signal.ma100,
      ma200: signal.ma200,
      currentPrice: signal.currentPrice,
      alertLevel: signal.alertLevel,
      proximityPct: signal.proximityPct,
      signalWeight: signal.signalWeight,
      signalStatus: signal.signalStatus,
      note: signal.note,
      signalTime: signal.signalTime
    }
  );
}

export async function markSignalTelegramSent(symbol, intervalCode) {
  await getPool().query(
    `UPDATE signal_result SET telegram_sent_at=NOW(3) WHERE symbol=:symbol AND interval_code=:intervalCode`,
    { symbol, intervalCode }
  );
}

export async function getOverview() {
  const [tokenRows] = await getPool().query(
    `SELECT
      COUNT(*) AS totalTokens,
      SUM(fetch_status='completed') AS cachedTokens,
      SUM(fetch_status<>'completed') AS pendingTokens
     FROM token_list
     WHERE is_active=1`
  );
  const [signalRows] = await getPool().query(
    `SELECT
      SUM(alert_level='LEVEL1') AS level1Signals,
      SUM(alert_level='LEVEL2') AS level2Signals
     FROM signal_result s
     JOIN token_list t ON t.id=s.token_id
     WHERE t.is_active=1`
  );
  const [categoryRows] = await getPool().query(
    `SELECT category_type AS categoryType,
      COUNT(*) AS total,
      SUM(fetch_status='completed') AS cached,
      SUM(fetch_status<>'completed') AS pending
     FROM token_list
     WHERE is_active=1
     GROUP BY category_type`
  );
  const [currentRows] = await getPool().query(
    `SELECT symbol, category_type AS categoryType, fetch_status AS fetchStatus, current_interval AS currentInterval,
      fetched_interval_count AS fetchedIntervalCount, total_interval_count AS totalIntervalCount, updated_at AS updatedAt, last_error AS lastError
     FROM token_list
     WHERE fetch_status='fetching'
       AND is_active=1
     ORDER BY updated_at DESC
     LIMIT 1`
  );
  const [lastRows] = await getPool().query(
    `SELECT MAX(updated_at) AS lastUpdatedAt FROM token_list WHERE is_active=1`
  );
  return {
    totals: {
      totalTokens: Number(tokenRows[0]?.totalTokens ?? 0),
      cachedTokens: Number(tokenRows[0]?.cachedTokens ?? 0),
      pendingTokens: Number(tokenRows[0]?.pendingTokens ?? 0),
      level1Signals: Number(signalRows[0]?.level1Signals ?? 0),
      level2Signals: Number(signalRows[0]?.level2Signals ?? 0)
    },
    categories: categoryRows.map((row) => ({
      categoryType: row.categoryType,
      total: Number(row.total ?? 0),
      cached: Number(row.cached ?? 0),
      pending: Number(row.pending ?? 0)
    })),
    currentFetch: currentRows[0] ?? null,
    lastUpdatedAt: lastRows[0]?.lastUpdatedAt ?? null
  };
}

export async function getSignals(categoryType) {
  const [rows] = await getPool().query(
    `SELECT s.symbol, s.category_type AS categoryType, t.category_label AS categoryLabel,
      s.interval_code AS intervalCode, s.alert_level AS alertLevel, s.ma100, s.ma200,
      s.current_price AS currentPrice, s.proximity_pct AS proximityPct, s.signal_weight AS signalWeight,
      s.signal_status AS signalStatus, s.note, s.signal_time AS signalTime, s.updated_at AS updatedAt
     FROM signal_result s
     JOIN token_list t ON t.id=s.token_id
     WHERE s.category_type=:categoryType
       AND t.is_active=1
     ORDER BY
      CASE s.alert_level WHEN 'LEVEL1' THEN 0 WHEN 'LEVEL2' THEN 1 WHEN 'NONE' THEN 2 ELSE 3 END,
      s.signal_weight DESC,
      s.updated_at DESC`,
    { categoryType }
  );
  return rows;
}

const SIGNAL_CATEGORIES = new Set(["A", "B"]);
const SIGNAL_LEVELS = new Set(["LEVEL1", "LEVEL2", "NONE", "INSUFFICIENT"]);
const SIGNAL_INTERVALS = new Set(["15m", "1h", "4h", "1d"]);

function normalizeList(values, allowedValues) {
  const input = Array.isArray(values) ? values : String(values ?? "").split(",");
  return input.map((item) => String(item).trim()).filter((item) => allowedValues.has(item));
}

function quotedList(values) {
  return values.map((item) => `'${item}'`).join(",");
}

export async function getSignalsPage({ categories, levels, intervals, page = 1, pageSize = 20 }) {
  const safeCategories = normalizeList(categories, SIGNAL_CATEGORIES);
  const safeLevels = normalizeList(levels, SIGNAL_LEVELS);
  const safeIntervals = normalizeList(intervals, SIGNAL_INTERVALS);
  const safePageSize = Math.max(1, Math.min(100, Number(pageSize) || 20));
  const safePage = Math.max(1, Number(page) || 1);
  const offset = (safePage - 1) * safePageSize;

  if (safeCategories.length === 0 || safeLevels.length === 0 || safeIntervals.length === 0) {
    return { signals: [], total: 0, page: safePage, pageSize: safePageSize };
  }

  const alarmLevels = safeLevels.filter((level) => ["LEVEL1", "LEVEL2"].includes(level));
  const multiRequired = safeIntervals.length > 1 && alarmLevels.length > 0 ? Math.min(3, safeIntervals.length) : 0;
  const multiJoinSql =
    multiRequired > 0
      ? `LEFT JOIN (
          SELECT
            s2.symbol,
            COUNT(DISTINCT s2.interval_code) AS multiMatchCount,
            MIN(CASE s2.alert_level WHEN 'LEVEL1' THEN 0 WHEN 'LEVEL2' THEN 1 WHEN 'NONE' THEN 2 ELSE 3 END) AS multiBestLevelRank,
            MAX(s2.signal_weight) AS multiBestWeight,
            MAX(s2.updated_at) AS multiLatestUpdatedAt
          FROM signal_result s2
          JOIN token_list t2 ON t2.id=s2.token_id
          WHERE s2.category_type IN (${quotedList(safeCategories)})
            AND s2.alert_level IN (${quotedList(alarmLevels)})
            AND s2.interval_code IN (${quotedList(safeIntervals)})
            AND t2.is_active=1
          GROUP BY s2.symbol
        ) mp ON mp.symbol=s.symbol`
      : "LEFT JOIN (SELECT NULL AS symbol, 0 AS multiMatchCount, 3 AS multiBestLevelRank, 0 AS multiBestWeight, NULL AS multiLatestUpdatedAt) mp ON mp.symbol=s.symbol";

  const whereSql = `s.category_type IN (${quotedList(safeCategories)})
    AND s.alert_level IN (${quotedList(safeLevels)})
    AND s.interval_code IN (${quotedList(safeIntervals)})
    AND t.is_active=1`;

  const [countRows] = await getPool().query(
    `SELECT COUNT(*) AS total
     FROM signal_result s
     JOIN token_list t ON t.id=s.token_id
     ${multiJoinSql}
     WHERE ${whereSql}`
  );

  const [rows] = await getPool().query(
    `SELECT s.symbol, s.category_type AS categoryType, t.category_label AS categoryLabel,
      s.interval_code AS intervalCode, s.alert_level AS alertLevel, s.ma100, s.ma200,
      s.current_price AS currentPrice, s.proximity_pct AS proximityPct, s.signal_weight AS signalWeight,
      s.signal_status AS signalStatus, s.note, s.signal_time AS signalTime, s.updated_at AS updatedAt,
      COALESCE(mp.multiMatchCount, 0) AS multiMatchCount,
      :multiRequired AS multiMatchRequired
     FROM signal_result s
     JOIN token_list t ON t.id=s.token_id
     ${multiJoinSql}
     WHERE ${whereSql}
     ORDER BY
      IF(COALESCE(mp.multiMatchCount, 0) >= :multiRequired AND :multiRequired > 1, COALESCE(mp.multiBestLevelRank, 3), CASE s.alert_level WHEN 'LEVEL1' THEN 0 WHEN 'LEVEL2' THEN 1 WHEN 'NONE' THEN 2 ELSE 3 END),
      IF(COALESCE(mp.multiMatchCount, 0) >= :multiRequired AND :multiRequired > 1, 0, 1),
      IF(COALESCE(mp.multiMatchCount, 0) >= :multiRequired AND :multiRequired > 1, COALESCE(mp.multiMatchCount, 0), 0) DESC,
      IF(COALESCE(mp.multiMatchCount, 0) >= :multiRequired AND :multiRequired > 1, COALESCE(mp.multiBestWeight, 0), s.signal_weight) DESC,
      IF(COALESCE(mp.multiMatchCount, 0) >= :multiRequired AND :multiRequired > 1, mp.multiLatestUpdatedAt, s.updated_at) DESC,
      IF(COALESCE(mp.multiMatchCount, 0) >= :multiRequired AND :multiRequired > 1, s.symbol, ''),
      CASE s.alert_level WHEN 'LEVEL1' THEN 0 WHEN 'LEVEL2' THEN 1 WHEN 'NONE' THEN 2 ELSE 3 END,
      CASE s.interval_code WHEN '15m' THEN 0 WHEN '1h' THEN 1 WHEN '4h' THEN 2 WHEN '1d' THEN 3 ELSE 4 END,
      s.signal_weight DESC,
      s.updated_at DESC
     LIMIT :pageSize OFFSET :offset`,
    { pageSize: safePageSize, offset, multiRequired }
  );

  return {
    signals: rows,
    total: Number(countRows[0]?.total ?? 0),
    page: safePage,
    pageSize: safePageSize
  };
}

function rollingAverage(rows, index, size) {
  if (index + 1 < size) return null;
  let sum = 0;
  for (let offset = index - size + 1; offset <= index; offset += 1) {
    sum += rows[offset].close;
  }
  return Number((sum / size).toFixed(12));
}

export async function getKlines({ symbol, intervalCode, limit = 240 }) {
  const safeSymbol = String(symbol ?? "").toUpperCase().replace(/[^A-Z0-9_]/g, "");
  const allRows = limit === "all";
  const safeLimit = allRows ? 6000 : Math.max(50, Math.min(1000, Number(limit) || 240));
  const expandedLimit = allRows ? safeLimit : safeLimit + 199;
  const [rows] = await getPool().query(
    `SELECT open_time AS openTime, close_time AS closeTime,
      open_price AS openPrice, high_price AS highPrice, low_price AS lowPrice,
      close_price AS closePrice, volume
     FROM (
      SELECT *
      FROM kline_cache
      WHERE symbol=:symbol AND interval_code=:intervalCode
      ORDER BY open_time DESC
      LIMIT :expandedLimit
     ) recent
     ORDER BY open_time ASC`,
    { symbol: safeSymbol, intervalCode, expandedLimit }
  );

  const normalized = rows.map((row) => ({
    openTime: Number(row.openTime),
    closeTime: Number(row.closeTime),
    open: Number(row.openPrice),
    high: Number(row.highPrice),
    low: Number(row.lowPrice),
    close: Number(row.closePrice),
    volume: Number(row.volume)
  }));

  const withMa = normalized.map((row, index) => ({
    ...row,
    ma100: rollingAverage(normalized, index, 100),
    ma200: rollingAverage(normalized, index, 200)
  }));

  return {
    symbol: safeSymbol,
    intervalCode,
    limit: allRows ? "all" : safeLimit,
    klines: allRows ? withMa : withMa.slice(-safeLimit)
  };
}

function sanitizeDbSymbol(value) {
  return String(value ?? "").toUpperCase().replace(/[^A-Z0-9_]/g, "").slice(0, 32);
}

function baseAssetFromSymbol(symbol) {
  return sanitizeDbSymbol(symbol).replace(/USDT$/, "");
}

export async function recordHotRankSnapshot(tokens) {
  const normalized = (tokens ?? [])
    .map((token) => ({
      symbol: sanitizeDbSymbol(token.symbol),
      baseAsset: baseAssetFromSymbol(token.symbol),
      chainLabel: String(token.chainLabel ?? "").slice(0, 32),
      rank: Math.max(1, Number(token.rank) || 0)
    }))
    .filter((token) => token.symbol && token.baseAsset);
  if (!normalized.length) return [];

  const [existingRows] = await getPool().query("SELECT symbol FROM hot_rank_seen WHERE symbol IN (?)", [
    normalized.map((token) => token.symbol)
  ]);
  const existing = new Set(existingRows.map((row) => row.symbol));
  const freshTokens = normalized.filter((token) => !existing.has(token.symbol));

  const rows = normalized.map((token) => [token.symbol, token.baseAsset, token.chainLabel, token.rank, token.rank]);
  await getPool().query(
    `INSERT INTO hot_rank_seen
      (symbol, base_asset, chain_label, first_seen_rank, last_seen_rank)
     VALUES ?
     ON DUPLICATE KEY UPDATE
      chain_label=VALUES(chain_label),
      last_seen_rank=VALUES(last_seen_rank),
      last_seen_at=NOW(3)`,
    [rows]
  );

  return freshTokens;
}

export async function markHotRankNotified(symbols) {
  const safeSymbols = (symbols ?? []).map(sanitizeDbSymbol).filter(Boolean);
  if (!safeSymbols.length) return 0;
  const [result] = await getPool().query("UPDATE hot_rank_seen SET notified_at=NOW(3) WHERE symbol IN (?)", [safeSymbols]);
  return result.affectedRows ?? 0;
}

export async function listWatchlist() {
  const [rows] = await getPool().query(
    `SELECT w.id, w.symbol, w.base_asset AS baseAsset, w.note,
      w.alert_above AS alertAbove, w.alert_below AS alertBelow,
      w.alert_enabled AS alertEnabled, w.last_alert_at AS lastAlertAt,
      w.created_at AS createdAt, w.updated_at AS updatedAt,
      t.category_label AS categoryLabel,
      COALESCE(
        (SELECT k.interval_code FROM kline_cache k WHERE k.symbol=w.symbol AND k.interval_code='15m' ORDER BY k.open_time DESC LIMIT 1),
        (SELECT k.interval_code FROM kline_cache k WHERE k.symbol=w.symbol ORDER BY k.open_time DESC LIMIT 1)
      ) AS latestInterval,
      COALESCE(
        (SELECT k.close_price FROM kline_cache k WHERE k.symbol=w.symbol AND k.interval_code='15m' ORDER BY k.open_time DESC LIMIT 1),
        (SELECT k.close_price FROM kline_cache k WHERE k.symbol=w.symbol ORDER BY k.open_time DESC LIMIT 1)
      ) AS currentPrice,
      COALESCE(
        (SELECT k.close_time FROM kline_cache k WHERE k.symbol=w.symbol AND k.interval_code='15m' ORDER BY k.open_time DESC LIMIT 1),
        (SELECT k.close_time FROM kline_cache k WHERE k.symbol=w.symbol ORDER BY k.open_time DESC LIMIT 1)
      ) AS currentCloseTime
     FROM watchlist w
     LEFT JOIN token_list t ON t.symbol=w.symbol
     ORDER BY w.updated_at DESC`
  );
  return rows.map((row) => ({
    ...row,
    alertEnabled: Boolean(row.alertEnabled),
    alertAbove: row.alertAbove === null || row.alertAbove === undefined ? null : Number(row.alertAbove),
    alertBelow: row.alertBelow === null || row.alertBelow === undefined ? null : Number(row.alertBelow),
    currentPrice: row.currentPrice === null || row.currentPrice === undefined ? null : Number(row.currentPrice),
    currentCloseTime:
      row.currentCloseTime === null || row.currentCloseTime === undefined ? null : Number(row.currentCloseTime)
  }));
}

export async function listWatchlistTokens() {
  const [rows] = await getPool().query(
    `SELECT t.*
     FROM watchlist w
     JOIN token_list t ON t.symbol=w.symbol
     WHERE t.is_active=1
     ORDER BY w.updated_at DESC`
  );
  return rows;
}

export async function upsertWatchlistItem({ symbol, note = "", alertAbove = null, alertBelow = null, alertEnabled = true }) {
  const safeSymbol = sanitizeDbSymbol(symbol);
  if (!safeSymbol) throw new Error("symbol is required");
  const baseAsset = baseAssetFromSymbol(safeSymbol);
  const above = alertAbove === "" || alertAbove === null || alertAbove === undefined ? null : Number(alertAbove);
  const below = alertBelow === "" || alertBelow === null || alertBelow === undefined ? null : Number(alertBelow);
  const enabled = alertEnabled === false || alertEnabled === "false" || alertEnabled === 0 || alertEnabled === "0" ? 0 : 1;
  await getPool().query(
    `INSERT INTO watchlist (symbol, base_asset, note, alert_above, alert_below, alert_enabled)
     VALUES (:symbol, :baseAsset, :note, :alertAbove, :alertBelow, :alertEnabled)
     ON DUPLICATE KEY UPDATE
      note=VALUES(note),
      alert_above=VALUES(alert_above),
      alert_below=VALUES(alert_below),
      alert_enabled=VALUES(alert_enabled),
      updated_at=NOW()`,
    {
      symbol: safeSymbol,
      baseAsset,
      note: String(note ?? "").slice(0, 255),
      alertAbove: Number.isFinite(above) ? above : null,
      alertBelow: Number.isFinite(below) ? below : null,
      alertEnabled: enabled
    }
  );
  return listWatchlist();
}

export async function deleteWatchlistItem(symbol) {
  const safeSymbol = sanitizeDbSymbol(symbol);
  if (!safeSymbol) return 0;
  const [result] = await getPool().query("DELETE FROM watchlist WHERE symbol=:symbol", { symbol: safeSymbol });
  return result.affectedRows ?? 0;
}

export async function markWatchlistAlertSent(symbol) {
  const safeSymbol = sanitizeDbSymbol(symbol);
  if (!safeSymbol) return;
  await getPool().query("UPDATE watchlist SET last_alert_at=NOW(3) WHERE symbol=:symbol", { symbol: safeSymbol });
}
