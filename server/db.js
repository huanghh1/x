import crypto from "node:crypto";
import mysql from "mysql2/promise";
import { config } from "./config.js";
import { evaluateOpenInterestSpike } from "./openInterestSpike.js";
import { resolveBestAlertLevel, resolveSignalProfile, SIGNAL_PRIORITY } from "./signalPriority.js";

let pool;
let databaseInitPromise;

function escapeIdentifier(value) {
  return mysql.escapeId(String(value));
}

async function getColumn(tableName, columnName) {
  const [rows] = await pool.query(
    `SELECT COLUMN_TYPE AS columnType
     FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA=DATABASE()
       AND TABLE_NAME=:tableName
       AND COLUMN_NAME=:columnName
     LIMIT 1`,
    { tableName, columnName }
  );
  return rows[0] ?? null;
}

async function columnExists(tableName, columnName) {
  return Boolean(await getColumn(tableName, columnName));
}

async function tableExists(tableName) {
  const [rows] = await pool.query(
    `SELECT 1
     FROM information_schema.TABLES
     WHERE TABLE_SCHEMA=DATABASE()
       AND TABLE_NAME=:tableName
     LIMIT 1`,
    { tableName }
  );
  return rows.length > 0;
}

async function indexExists(tableName, indexName) {
  const [rows] = await pool.query(
    `SELECT 1
     FROM information_schema.STATISTICS
     WHERE TABLE_SCHEMA=DATABASE()
       AND TABLE_NAME=:tableName
       AND INDEX_NAME=:indexName
     LIMIT 1`,
    { tableName, indexName }
  );
  return rows.length > 0;
}

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
    inactive_since DATETIME(3) NULL,
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
    KEY idx_token_status (fetch_status, updated_at),
    KEY idx_token_active_status (is_active, fetch_status, category_type, updated_at),
    KEY idx_token_base_active (base_asset, is_active, updated_at),
    KEY idx_token_inactive_since (is_active, inactive_since)
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
    KEY idx_kline_symbol_interval_close (symbol, interval_code, close_time),
    KEY idx_kline_interval_symbol (interval_code, symbol),
    CONSTRAINT fk_kline_token FOREIGN KEY (token_id) REFERENCES token_list(id) ON DELETE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
  `CREATE TABLE IF NOT EXISTS kline_availability (
    symbol VARCHAR(32) NOT NULL,
    interval_code ENUM('15m','1h','4h','1d') NOT NULL,
    first_open_time BIGINT UNSIGNED NOT NULL,
    source VARCHAR(32) NOT NULL DEFAULT 'binance',
    last_checked_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (symbol, interval_code),
    KEY idx_kline_availability_checked (last_checked_at)
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
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    UNIQUE KEY uk_signal_symbol_interval (symbol, interval_code),
    KEY idx_signal_category_level (category_type, alert_level, signal_weight),
    KEY idx_signal_time (signal_time),
    KEY idx_signal_filter_page (category_type, alert_level, interval_code, updated_at, symbol),
    KEY idx_signal_symbol_time (symbol, signal_time),
    KEY idx_signal_symbol_level_interval (symbol, alert_level, interval_code),
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
    KEY idx_hot_rank_last_seen (last_seen_at),
    KEY idx_hot_base_seen (base_asset, last_seen_at, last_seen_rank),
    KEY idx_hot_chain_seen (chain_label, last_seen_at, last_seen_rank)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
  `CREATE TABLE IF NOT EXISTS watchlist (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    symbol VARCHAR(32) NOT NULL,
    base_asset VARCHAR(32) NOT NULL,
    note VARCHAR(255) NULL,
    alert_above DECIMAL(32,12) NULL,
    alert_below DECIMAL(32,12) NULL,
    alert_enabled TINYINT(1) NOT NULL DEFAULT 1,
    current_price DECIMAL(32,12) NULL,
    current_price_time DATETIME(3) NULL,
    last_alert_at DATETIME(3) NULL,
    last_alert_side ENUM('above','below') NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    UNIQUE KEY uk_watch_symbol (symbol),
    KEY idx_watch_enabled (alert_enabled, updated_at),
    KEY idx_watch_updated (updated_at, symbol)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
  `CREATE TABLE IF NOT EXISTS hot_ma_signal_alert (
    symbol VARCHAR(32) NOT NULL,
    interval_code ENUM('15m','1h','4h','1d') NOT NULL,
    alert_level ENUM('LEVEL1','LEVEL2') NOT NULL,
    signal_time DATETIME(3) NOT NULL,
    profile_key VARCHAR(80) NULL,
    source_mask TINYINT UNSIGNED NOT NULL DEFAULT 0,
    context_signature VARCHAR(255) NULL,
    sent_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    PRIMARY KEY (symbol, interval_code),
    KEY idx_hot_ma_sent_at (sent_at)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
  `CREATE TABLE IF NOT EXISTS multi_cycle_history (
    symbol VARCHAR(32) NOT NULL,
    base_asset VARCHAR(32) NOT NULL,
    category_label VARCHAR(80) NULL,
    first_triggered_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    last_triggered_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    multi_match_count TINYINT UNSIGNED NOT NULL DEFAULT 0,
    intervals VARCHAR(64) NOT NULL,
    best_alert_level ENUM('LEVEL1','LEVEL2') NOT NULL DEFAULT 'LEVEL2',
    PRIMARY KEY (symbol),
    KEY idx_multi_history_last (last_triggered_at),
    KEY idx_multi_history_count (multi_match_count, last_triggered_at)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
  `CREATE TABLE IF NOT EXISTS funding_interval_state (
    symbol VARCHAR(32) NOT NULL,
    funding_interval_hours SMALLINT UNSIGNED NOT NULL,
    previous_funding_interval_hours SMALLINT UNSIGNED NULL,
    adjusted_funding_rate_cap DECIMAL(18,10) NULL,
    adjusted_funding_rate_floor DECIMAL(18,10) NULL,
    current_funding_rate DECIMAL(18,10) NULL,
    next_funding_time BIGINT UNSIGNED NULL,
    disclaimer TINYINT(1) NOT NULL DEFAULT 0,
    source_present TINYINT(1) NOT NULL DEFAULT 1,
    first_seen_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    last_seen_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    last_changed_at DATETIME(3) NULL,
    one_hour_alerted_at DATETIME(3) NULL,
    one_hour_confirmed_at DATETIME(3) NULL,
    next_one_hour_alert_at DATETIME(3) NULL,
    one_hour_alert_count INT UNSIGNED NOT NULL DEFAULT 0,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (symbol),
    KEY idx_funding_interval_hours (funding_interval_hours, one_hour_alerted_at),
    KEY idx_funding_last_changed (last_changed_at),
    KEY idx_funding_interval_changed (funding_interval_hours, last_changed_at, symbol),
    KEY idx_funding_pending_alerts (funding_interval_hours, source_present, one_hour_confirmed_at, next_one_hour_alert_at)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
  `CREATE TABLE IF NOT EXISTS signal_trigger_history (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    event_key VARCHAR(191) NOT NULL,
    symbol VARCHAR(32) NOT NULL,
    trigger_type ENUM('MA_SIGNAL','HOT_RANK','FUNDING_RATE','OI_SPIKE','COMPOSITE') NOT NULL,
    intervals_triggered VARCHAR(100) NULL,
    signal_level VARCHAR(32) NULL,
    trigger_time DATETIME(3) NOT NULL,
    details JSON NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    UNIQUE KEY uk_trigger_event (event_key),
    KEY idx_trigger_time (trigger_time),
    KEY idx_trigger_time_id (trigger_time, id),
    KEY idx_trigger_symbol_time (symbol, trigger_time),
    KEY idx_trigger_type_time (trigger_type, trigger_time),
    KEY idx_trigger_type_time_id (trigger_type, trigger_time, id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
  `CREATE TABLE IF NOT EXISTS trade_event_history (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    event_key VARCHAR(191) NOT NULL,
    source VARCHAR(32) NOT NULL,
    source_label VARCHAR(80) NULL,
    symbol VARCHAR(64) NOT NULL,
    asset VARCHAR(32) NULL,
    event_time_ms BIGINT UNSIGNED NULL,
    event_time DATETIME(3) NULL,
    event_type VARCHAR(64) NULL,
    side VARCHAR(32) NULL,
    direction VARCHAR(80) NULL,
    position_side VARCHAR(32) NULL,
    quantity DECIMAL(38,12) NULL,
    price DECIMAL(38,12) NULL,
    mark_price DECIMAL(38,12) NULL,
    notional DECIMAL(38,12) NULL,
    funding_rate DECIMAL(24,12) NULL,
    realized_pnl DECIMAL(38,12) NOT NULL DEFAULT 0,
    unrealized_pnl DECIMAL(38,12) NOT NULL DEFAULT 0,
    funding DECIMAL(38,12) NOT NULL DEFAULT 0,
    commission DECIMAL(38,12) NOT NULL DEFAULT 0,
    fee_asset VARCHAR(32) NULL,
    net DECIMAL(38,12) NOT NULL DEFAULT 0,
    order_id VARCHAR(128) NULL,
    trade_id VARCHAR(128) NULL,
    liquidity VARCHAR(32) NULL,
    note VARCHAR(1000) NULL,
    pnl_included TINYINT(1) NOT NULL DEFAULT 1,
    raw_type VARCHAR(64) NULL,
    details JSON NULL,
    first_seen_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    UNIQUE KEY uk_trade_event (event_key),
    KEY idx_trade_time_id (event_time_ms, id),
    KEY idx_trade_source_time (source, event_time_ms, id),
    KEY idx_trade_symbol_time (symbol, event_time_ms, id),
    KEY idx_trade_source_symbol_time (source, symbol, event_time_ms, id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
  `CREATE TABLE IF NOT EXISTS open_interest_monitor (
    symbol VARCHAR(32) NOT NULL,
    current_open_interest DECIMAL(38,12) NULL,
    current_open_interest_value DECIMAL(38,12) NULL,
    change_5m_pct DECIMAL(18,8) NULL,
    change_15m_pct DECIMAL(18,8) NULL,
    change_1h_pct DECIMAL(18,8) NULL,
    change_4h_pct DECIMAL(18,8) NULL,
    change_1d_pct DECIMAL(18,8) NULL,
    observed_at DATETIME(3) NOT NULL,
    last_spike_alert_at DATETIME(3) NULL,
    last_spike_alert_signature VARCHAR(255) NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (symbol),
    KEY idx_oi_observed (observed_at),
    KEY idx_oi_5m (change_5m_pct, observed_at),
    KEY idx_oi_15m (change_15m_pct, observed_at),
    KEY idx_oi_1h (change_1h_pct, observed_at),
    KEY idx_oi_4h (change_4h_pct, observed_at),
    KEY idx_oi_1d (change_1d_pct, observed_at)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
  `CREATE TABLE IF NOT EXISTS open_interest_sample (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    symbol VARCHAR(32) NOT NULL,
    open_interest DECIMAL(38,12) NOT NULL,
    open_interest_value DECIMAL(38,12) NULL,
    observed_at DATETIME(3) NOT NULL,
    source ENUM('current','history') NOT NULL DEFAULT 'current',
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    UNIQUE KEY uk_oi_sample_symbol_time (symbol, observed_at),
    KEY idx_oi_sample_symbol_observed (symbol, observed_at),
    KEY idx_oi_sample_observed (observed_at)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
  `CREATE TABLE IF NOT EXISTS telegram_alert_queue (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    queue_key VARCHAR(191) NOT NULL,
    alert_type ENUM('OI_SPIKE') NOT NULL,
    symbol VARCHAR(32) NULL,
    status ENUM('PENDING','SENDING','SENT','FAILED') NOT NULL DEFAULT 'PENDING',
    payload_json JSON NOT NULL,
    attempt_count INT UNSIGNED NOT NULL DEFAULT 0,
    next_attempt_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    locked_at DATETIME(3) NULL,
    sent_at DATETIME(3) NULL,
    last_error VARCHAR(1000) NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    UNIQUE KEY uk_telegram_alert_queue_key (queue_key),
    KEY idx_telegram_alert_pending (status, next_attempt_at, id),
    KEY idx_telegram_alert_symbol (symbol, created_at)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
  `CREATE TABLE IF NOT EXISTS hot_rank_snapshot (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    symbol VARCHAR(32) NOT NULL,
    base_asset VARCHAR(32) NOT NULL,
    chain_label VARCHAR(32) NOT NULL DEFAULT '',
    rank_value INT UNSIGNED NOT NULL,
    heat_value DECIMAL(20,4) NULL,
    snapshot_time DATETIME NOT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    UNIQUE KEY uk_hot_snapshot (symbol, chain_label, snapshot_time),
    KEY idx_hot_snapshot_time (snapshot_time),
    KEY idx_hot_snapshot_chain_time (chain_label, snapshot_time, rank_value),
    KEY idx_hot_snapshot_symbol_time (symbol, snapshot_time)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
  `CREATE TABLE IF NOT EXISTS token_unlock_cache (
    symbol VARCHAR(32) NOT NULL,
    base_asset VARCHAR(32) NOT NULL,
    next_unlock_at DATETIME(3) NULL,
    unlock_amount DECIMAL(38,12) NULL,
    unlock_percent DECIMAL(12,6) NULL,
    provider VARCHAR(32) NOT NULL,
    source_url VARCHAR(512) NULL,
    status ENUM('available','none','undated','unconfigured','error') NOT NULL DEFAULT 'unconfigured',
    error_message VARCHAR(500) NULL,
    raw_payload JSON NULL,
    checked_at DATETIME(3) NOT NULL,
    expires_at DATETIME(3) NOT NULL,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (symbol),
    KEY idx_unlock_base_asset (base_asset),
    KEY idx_unlock_next (next_unlock_at, symbol),
    KEY idx_unlock_expiry (expires_at),
    KEY idx_unlock_checked (checked_at)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
  `CREATE TABLE IF NOT EXISTS trade_journal (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    title VARCHAR(160) NOT NULL,
    symbol VARCHAR(32) NULL,
    side VARCHAR(24) NULL,
    status ENUM('OPEN','ENDED','REVIEWED') NOT NULL DEFAULT 'OPEN',
    opened_at DATETIME(3) NULL,
    closed_at DATETIME(3) NULL,
    open_reason TEXT NOT NULL,
    close_reason TEXT NULL,
    review_summary TEXT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    KEY idx_trade_journal_status_time (status, opened_at, id),
    KEY idx_trade_journal_symbol_time (symbol, opened_at, id),
    KEY idx_trade_journal_updated (updated_at, id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
  `CREATE TABLE IF NOT EXISTS trade_journal_intraday_notes (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    journal_id BIGINT UNSIGNED NOT NULL,
    note_text TEXT NOT NULL,
    noted_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    KEY idx_trade_journal_intraday_time (journal_id, noted_at, id),
    CONSTRAINT fk_trade_journal_intraday_journal FOREIGN KEY (journal_id) REFERENCES trade_journal(id) ON DELETE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`
];

export async function ensureDatabase() {
  if (databaseInitPromise) {
    await databaseInitPromise;
    return;
  }
  if (pool) return;
  if (!databaseInitPromise) {
    databaseInitPromise = initializeDatabase().finally(() => {
      databaseInitPromise = null;
    });
  }
  await databaseInitPromise;
}

async function initializeDatabase() {
  const admin = await mysql.createConnection({
    host: config.mysql.host,
    port: config.mysql.port,
    user: config.mysql.user,
    password: config.mysql.password,
    charset: "utf8mb4"
  });
  try {
    await admin.query(
      `CREATE DATABASE IF NOT EXISTS ${escapeIdentifier(config.mysql.database)} CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`
    );
  } finally {
    await admin.end();
  }

  const nextPool = mysql.createPool({
    host: config.mysql.host,
    port: config.mysql.port,
    user: config.mysql.user,
    password: config.mysql.password,
    database: config.mysql.database,
    waitForConnections: true,
    connectionLimit: config.mysql.connectionLimit,
    maxIdle: config.mysql.maxIdle,
    idleTimeout: config.mysql.idleTimeoutMs,
    queueLimit: config.mysql.queueLimit,
    connectTimeout: config.mysql.connectTimeoutMs,
    enableKeepAlive: true,
    keepAliveInitialDelay: config.mysql.keepAliveInitialDelayMs,
    namedPlaceholders: true,
    charset: "utf8mb4"
  });
  pool = nextPool;

  try {
    const migrationConnection = await pool.getConnection();
    const lockName = `${config.mysql.database}:schema_migration`;
    try {
      const [lockRows] = await migrationConnection.query("SELECT GET_LOCK(?, 60) AS acquired", [lockName]);
      if (Number(lockRows[0]?.acquired) !== 1) throw new Error("Timed out waiting for database schema lock");
      for (const sql of TABLE_SQL) {
        await migrationConnection.query(sql);
      }
      await ensureTokenListPolicyColumn();
      await ensureTokenListActiveColumn();
      await ensureTokenListInactiveSinceColumn();
      await ensureWatchlistRealtimeColumns();
      await ensureFundingRateColumns();
      await ensureFundingAlertConfirmationColumns();
      await ensureTokenUnlockStatusSchema();
      await ensureHotMaSignalAlertSchema();
      await ensureOpenInterestAlertSchema();
      await ensureTriggerHistorySchema();
      await ensureTradeEventHistorySchema();
      await ensurePerformanceIndexes();
      await deactivateExcludedTokens();
    } finally {
      await migrationConnection.query("SELECT RELEASE_LOCK(?)", [lockName]).catch(() => {});
      migrationConnection.release();
    }
  } catch (error) {
    pool = undefined;
    await nextPool.end().catch(() => {});
    throw error;
  }
}

async function ensureTokenListPolicyColumn() {
  if (await columnExists("token_list", "cache_policy_key")) return;
  await pool.query("ALTER TABLE token_list ADD COLUMN cache_policy_key VARCHAR(160) NULL AFTER cache_completed_at");
}

async function ensureTokenListActiveColumn() {
  if (await columnExists("token_list", "is_active")) return;
  await pool.query("ALTER TABLE token_list ADD COLUMN is_active TINYINT(1) NOT NULL DEFAULT 1 AFTER is_alpha");
}

async function ensureTokenListInactiveSinceColumn() {
  if (!(await columnExists("token_list", "inactive_since"))) {
    await pool.query("ALTER TABLE token_list ADD COLUMN inactive_since DATETIME(3) NULL AFTER is_active");
  }
  await pool.query(
    "UPDATE token_list SET inactive_since=COALESCE(inactive_since, updated_at, NOW(3)) WHERE is_active=0"
  );
}

async function ensureWatchlistRealtimeColumns() {
  if (!(await columnExists("watchlist", "current_price"))) {
    await pool.query("ALTER TABLE watchlist ADD COLUMN current_price DECIMAL(32,12) NULL AFTER alert_enabled");
  }
  if (!(await columnExists("watchlist", "current_price_time"))) {
    await pool.query("ALTER TABLE watchlist ADD COLUMN current_price_time DATETIME(3) NULL AFTER current_price");
  }
  if (!(await columnExists("watchlist", "last_alert_side"))) {
    await pool.query("ALTER TABLE watchlist ADD COLUMN last_alert_side ENUM('above','below') NULL AFTER last_alert_at");
  }
}

async function ensureFundingRateColumns() {
  if (!(await columnExists("funding_interval_state", "current_funding_rate"))) {
    await pool.query(
      "ALTER TABLE funding_interval_state ADD COLUMN current_funding_rate DECIMAL(18,10) NULL AFTER adjusted_funding_rate_floor"
    );
  }
  if (!(await columnExists("funding_interval_state", "next_funding_time"))) {
    await pool.query(
      "ALTER TABLE funding_interval_state ADD COLUMN next_funding_time BIGINT UNSIGNED NULL AFTER current_funding_rate"
    );
  }
}

async function ensureFundingAlertConfirmationColumns() {
  const columns = [
    ["one_hour_confirmed_at", "ALTER TABLE funding_interval_state ADD COLUMN one_hour_confirmed_at DATETIME(3) NULL AFTER one_hour_alerted_at"],
    ["next_one_hour_alert_at", "ALTER TABLE funding_interval_state ADD COLUMN next_one_hour_alert_at DATETIME(3) NULL AFTER one_hour_confirmed_at"],
    ["one_hour_alert_count", "ALTER TABLE funding_interval_state ADD COLUMN one_hour_alert_count INT UNSIGNED NOT NULL DEFAULT 0 AFTER next_one_hour_alert_at"]
  ];
  for (const [column, sql] of columns) {
    if (!(await columnExists("funding_interval_state", column))) await pool.query(sql);
  }
}

async function ensureTokenUnlockStatusSchema() {
  const statusColumn = await getColumn("token_unlock_cache", "status");
  if (!statusColumn) {
    const afterSourceUrl = await columnExists("token_unlock_cache", "source_url") ? " AFTER source_url" : "";
    await pool.query(
      `ALTER TABLE token_unlock_cache ADD COLUMN status ENUM('available','none','undated','unconfigured','error') NOT NULL DEFAULT 'unconfigured'${afterSourceUrl}`
    );
  }
  const type = String((statusColumn ?? await getColumn("token_unlock_cache", "status"))?.columnType ?? "");
  if (type && !type.includes("'undated'")) {
    await pool.query(
      "ALTER TABLE token_unlock_cache MODIFY status ENUM('available','none','undated','unconfigured','error') NOT NULL DEFAULT 'unconfigured'"
    );
  }
  if (!(await columnExists("token_unlock_cache", "error_message"))) {
    await pool.query("ALTER TABLE token_unlock_cache ADD COLUMN error_message VARCHAR(500) NULL AFTER status");
  }
  if (!(await columnExists("token_unlock_cache", "raw_payload"))) {
    await pool.query("ALTER TABLE token_unlock_cache ADD COLUMN raw_payload JSON NULL AFTER error_message");
  }
}

async function ensureHotMaSignalAlertSchema() {
  if (!(await tableExists("hot_ma_signal_alert"))) return;
  const columns = [
    ["profile_key", "ALTER TABLE hot_ma_signal_alert ADD COLUMN profile_key VARCHAR(80) NULL AFTER signal_time"],
    ["source_mask", "ALTER TABLE hot_ma_signal_alert ADD COLUMN source_mask TINYINT UNSIGNED NOT NULL DEFAULT 0 AFTER profile_key"],
    ["context_signature", "ALTER TABLE hot_ma_signal_alert ADD COLUMN context_signature VARCHAR(255) NULL AFTER source_mask"]
  ];
  for (const [column, sql] of columns) {
    if (!(await columnExists("hot_ma_signal_alert", column))) await pool.query(sql);
  }
}

async function ensureOpenInterestAlertSchema() {
  if (!(await tableExists("open_interest_monitor"))) return;
  if (!(await columnExists("open_interest_monitor", "last_spike_alert_signature"))) {
    await pool.query(
      "ALTER TABLE open_interest_monitor ADD COLUMN last_spike_alert_signature VARCHAR(255) NULL AFTER last_spike_alert_at"
    );
  }
}

async function ensureTriggerHistorySchema() {
  if (!(await tableExists("signal_trigger_history"))) return;
  if (!(await columnExists("signal_trigger_history", "event_key"))) {
    await pool.query("ALTER TABLE signal_trigger_history ADD COLUMN event_key VARCHAR(191) NULL AFTER id");
    await pool.query("UPDATE signal_trigger_history SET event_key=CONCAT('legacy:', id) WHERE event_key IS NULL");
    await pool.query("ALTER TABLE signal_trigger_history MODIFY event_key VARCHAR(191) NOT NULL");
  }
  const triggerType = String((await getColumn("signal_trigger_history", "trigger_type"))?.columnType ?? "");
  if (triggerType.includes("IO_SPIKE")) {
    if (!triggerType.includes("OI_SPIKE")) {
      await pool.query(
        "ALTER TABLE signal_trigger_history MODIFY trigger_type ENUM('MA_SIGNAL','HOT_RANK','FUNDING_RATE','IO_SPIKE','OI_SPIKE','COMPOSITE') NOT NULL"
      );
    }
    await pool.query("UPDATE signal_trigger_history SET trigger_type='OI_SPIKE' WHERE trigger_type='IO_SPIKE'");
  }
  const currentTriggerType = String((await getColumn("signal_trigger_history", "trigger_type"))?.columnType ?? "");
  if (currentTriggerType && (!currentTriggerType.includes("OI_SPIKE") || currentTriggerType.includes("IO_SPIKE"))) {
    await pool.query(
      "ALTER TABLE signal_trigger_history MODIFY trigger_type ENUM('MA_SIGNAL','HOT_RANK','FUNDING_RATE','OI_SPIKE','COMPOSITE') NOT NULL"
    );
  }
  if (!(await indexExists("signal_trigger_history", "uk_trigger_event"))) {
    await pool.query("ALTER TABLE signal_trigger_history ADD UNIQUE KEY uk_trigger_event (event_key)");
  }
}

async function ensureTradeEventHistorySchema() {
  if (!(await tableExists("trade_event_history"))) return;
  const columns = [
    ["source_label", "ALTER TABLE trade_event_history ADD COLUMN source_label VARCHAR(80) NULL AFTER source"],
    ["asset", "ALTER TABLE trade_event_history ADD COLUMN asset VARCHAR(32) NULL AFTER symbol"],
    ["event_time", "ALTER TABLE trade_event_history ADD COLUMN event_time DATETIME(3) NULL AFTER event_time_ms"],
    ["mark_price", "ALTER TABLE trade_event_history ADD COLUMN mark_price DECIMAL(38,12) NULL AFTER price"],
    ["unrealized_pnl", "ALTER TABLE trade_event_history ADD COLUMN unrealized_pnl DECIMAL(38,12) NOT NULL DEFAULT 0 AFTER realized_pnl"],
    ["details", "ALTER TABLE trade_event_history ADD COLUMN details JSON NULL AFTER raw_type"]
  ];
  for (const [column, sql] of columns) {
    if (!(await columnExists("trade_event_history", column))) await pool.query(sql);
  }
  if (!(await indexExists("trade_event_history", "uk_trade_event"))) {
    await pool.query("ALTER TABLE trade_event_history ADD UNIQUE KEY uk_trade_event (event_key)");
  }
}

async function ensureIndex(tableName, indexName, definition) {
  if (await indexExists(tableName, indexName)) return;
  await pool.query(`ALTER TABLE ${escapeIdentifier(tableName)} ADD INDEX ${escapeIdentifier(indexName)} ${definition}`);
}

async function ensurePerformanceIndexes() {
  await ensureIndex("token_list", "idx_token_active_status", "(is_active, fetch_status, category_type, updated_at)");
  await ensureIndex("token_list", "idx_token_base_active", "(base_asset, is_active, updated_at)");
  await ensureIndex("token_list", "idx_token_inactive_since", "(is_active, inactive_since)");
  await ensureIndex("kline_cache", "idx_kline_interval_symbol", "(interval_code, symbol)");
  await ensureIndex(
    "signal_result",
    "idx_signal_filter_page",
    "(category_type, alert_level, interval_code, updated_at, symbol)"
  );
  await ensureIndex("signal_result", "idx_signal_symbol_time", "(symbol, signal_time)");
  await ensureIndex("signal_result", "idx_signal_symbol_level_interval", "(symbol, alert_level, interval_code)");
  await ensureIndex("hot_rank_seen", "idx_hot_base_seen", "(base_asset, last_seen_at, last_seen_rank)");
  await ensureIndex("hot_rank_seen", "idx_hot_chain_seen", "(chain_label, last_seen_at, last_seen_rank)");
  await ensureIndex(
    "funding_interval_state",
    "idx_funding_interval_changed",
    "(funding_interval_hours, last_changed_at, symbol)"
  );
  await ensureIndex(
    "funding_interval_state",
    "idx_funding_pending_alerts",
    "(funding_interval_hours, source_present, one_hour_confirmed_at, next_one_hour_alert_at)"
  );
  await ensureIndex("watchlist", "idx_watch_updated", "(updated_at, symbol)");
  await ensureIndex("open_interest_monitor", "idx_oi_5m", "(change_5m_pct, observed_at)");
  await ensureIndex("open_interest_monitor", "idx_oi_15m", "(change_15m_pct, observed_at)");
  await ensureIndex("open_interest_monitor", "idx_oi_1h", "(change_1h_pct, observed_at)");
  await ensureIndex("open_interest_monitor", "idx_oi_4h", "(change_4h_pct, observed_at)");
  await ensureIndex("open_interest_monitor", "idx_oi_1d", "(change_1d_pct, observed_at)");
  await ensureIndex("signal_trigger_history", "idx_trigger_time_id", "(trigger_time, id)");
  await ensureIndex("signal_trigger_history", "idx_trigger_type_time_id", "(trigger_type, trigger_time, id)");
  await ensureIndex("trade_event_history", "idx_trade_time_id", "(event_time_ms, id)");
  await ensureIndex("trade_event_history", "idx_trade_source_time", "(source, event_time_ms, id)");
  await ensureIndex("trade_event_history", "idx_trade_symbol_time", "(symbol, event_time_ms, id)");
  await ensureIndex("trade_event_history", "idx_trade_source_symbol_time", "(source, symbol, event_time_ms, id)");
  await ensureIndex("trade_journal", "idx_trade_journal_status_time", "(status, opened_at, id)");
  await ensureIndex("trade_journal", "idx_trade_journal_symbol_time", "(symbol, opened_at, id)");
  await ensureIndex("trade_journal", "idx_trade_journal_updated", "(updated_at, id)");
  await ensureIndex("trade_journal_intraday_notes", "idx_trade_journal_intraday_time", "(journal_id, noted_at, id)");
  await ensureIndex("kline_cache", "idx_kline_symbol_interval_close", "(symbol, interval_code, close_time)");
  await ensureIndex("hot_rank_snapshot", "idx_hot_snapshot_time", "(snapshot_time)");
  await ensureIndex("token_unlock_cache", "idx_unlock_checked", "(checked_at)");
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
     SET is_active=0, inactive_since=COALESCE(inactive_since, NOW(3))
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
    await getPool().query(
      "UPDATE token_list SET is_active=1, inactive_since=NULL WHERE symbol IN (?)",
      [symbols]
    );
    await getPool().query(
      `UPDATE token_list
       SET is_active=0, inactive_since=COALESCE(inactive_since, NOW(3))
       WHERE symbol NOT IN (?) AND is_active=1`,
      [symbols]
    );
  }
  return rows.length;
}

export async function queueActiveTokensForKlineAudit(symbols = []) {
  const safeSymbols = [...new Set(symbols.map(sanitizeDbSymbol).filter(Boolean))];
  if (!safeSymbols.length) return 0;
  const [result] = await getPool().query(
    `UPDATE token_list
     SET fetch_status='partial',
         current_interval=NULL,
         last_error='每日 K 线完整性审计已入队'
     WHERE is_active=1
       AND fetch_status<>'fetching'
       AND symbol IN (?)`,
    [safeSymbols]
  );
  return Number(result.affectedRows ?? 0);
}

export async function queueSymbolsForKlineRefresh(symbols = [], reason = "K 线缓存需要补齐") {
  const safeSymbols = [...new Set((Array.isArray(symbols) ? symbols : [symbols]).map(sanitizeDbSymbol).filter(Boolean))];
  if (!safeSymbols.length) return 0;
  const [result] = await getPool().query(
    `UPDATE token_list
     SET fetch_status='partial',
         current_interval=NULL,
         last_error=:reason
     WHERE is_active=1
       AND fetch_status<>'fetching'
       AND symbol IN (:symbols)
       AND NOT (
         fetch_status='partial'
         AND last_error=:reason
         AND updated_at > DATE_SUB(NOW(3), INTERVAL :cooldownSeconds SECOND)
       )`,
    { symbols: safeSymbols, reason: String(reason).slice(0, 1000), cooldownSeconds: 10 * 60 }
  );
  return Number(result.affectedRows ?? 0);
}

export async function getKlineAuditReport(retentionLimits = config.crawler.retentionLimits) {
  const auditIntervals = ["15m", "1h", "4h", "1d"];
  const latestClosed = {
    "15m": latestClosedKlineOpenTime("15m"),
    "1h": latestClosedKlineOpenTime("1h"),
    "4h": latestClosedKlineOpenTime("4h"),
    "1d": latestClosedKlineOpenTime("1d")
  };
  const expectedCounts = Object.fromEntries(
    auditIntervals.map((intervalCode) => [
      intervalCode,
      Math.max(200, Number(retentionLimits[intervalCode]) || 200)
    ])
  );
  const targetStart = Object.fromEntries(
    auditIntervals.map((intervalCode) => [
      intervalCode,
      latestClosed[intervalCode] - (expectedCounts[intervalCode] - 1) * intervalMs(intervalCode)
    ])
  );
  const [rows] = await getPool().query(
    `SELECT t.symbol, intervals.interval_code AS intervalCode,
      COUNT(k.id) AS cachedCount,
      MIN(k.open_time) AS earliestOpenTime,
      MAX(k.open_time) AS latestOpenTime
     FROM token_list t
     JOIN (
      SELECT '15m' AS interval_code
      UNION ALL SELECT '1h'
      UNION ALL SELECT '4h'
      UNION ALL SELECT '1d'
     ) intervals
     LEFT JOIN kline_cache k FORCE INDEX (uk_kline_symbol_interval_time)
       ON k.symbol=t.symbol
      AND k.interval_code=intervals.interval_code
      AND k.open_time >= CASE intervals.interval_code
        WHEN '15m' THEN :start15m
        WHEN '1h' THEN :start1h
        WHEN '4h' THEN :start4h
        WHEN '1d' THEN :start1d
      END
      AND k.open_time <= CASE intervals.interval_code
        WHEN '15m' THEN :latest15m
        WHEN '1h' THEN :latest1h
        WHEN '4h' THEN :latest4h
        WHEN '1d' THEN :latest1d
      END
     WHERE t.is_active=1
     GROUP BY t.symbol, intervals.interval_code
     ORDER BY t.symbol, FIELD(intervals.interval_code, '15m','1h','4h','1d')`,
    {
      start15m: targetStart["15m"],
      start1h: targetStart["1h"],
      start4h: targetStart["4h"],
      start1d: targetStart["1d"],
      latest15m: latestClosed["15m"],
      latest1h: latestClosed["1h"],
      latest4h: latestClosed["4h"],
      latest1d: latestClosed["1d"]
    }
  );
  const bySymbol = new Map();
  for (const row of rows) {
    if (!bySymbol.has(row.symbol)) bySymbol.set(row.symbol, new Map());
    if (row.intervalCode) bySymbol.get(row.symbol).set(row.intervalCode, row);
  }
  const availability = await getKlineAvailabilityMap([...bySymbol.keys()]);
  const deficient = [];
  for (const [symbol, intervals] of bySymbol) {
    for (const intervalCode of auditIntervals) {
      const row = intervals.get(intervalCode);
      const cachedCount = Number(row?.cachedCount ?? 0);
      const expectedCount = expectedCounts[intervalCode];
      const earliestOpenTime = row?.earliestOpenTime === null || row?.earliestOpenTime === undefined
        ? null
        : Number(row.earliestOpenTime);
      const latestOpenTime = row?.latestOpenTime === null || row?.latestOpenTime === undefined
        ? null
        : Number(row.latestOpenTime);
      const safeIntervalMs = intervalMs(intervalCode);
      const targetEndTime = latestClosed[intervalCode] ?? latestClosedKlineOpenTime(intervalCode);
      const targetStartTime = targetStart[intervalCode];
      const firstAvailableOpenTime = availability.get(`${symbol}|${intervalCode}`) ?? null;
      const naturalHistoryShortfall = isNaturalKlineHistoryShortfall({
        cachedCount,
        expectedCount,
        earliestOpenTime,
        firstAvailableOpenTime,
        targetStartTime,
        intervalMsValue: safeIntervalMs
      });
      const spanSlotCount =
        earliestOpenTime !== null && latestOpenTime !== null && latestOpenTime >= earliestOpenTime
          ? Math.floor((latestOpenTime - earliestOpenTime) / safeIntervalMs) + 1
          : cachedCount;
      const hasSpanGap = cachedCount > 1 && spanSlotCount > cachedCount;
      const internalGap = hasSpanGap
        ? await findKlineGap(symbol, intervalCode, safeIntervalMs, Math.max(targetStartTime, earliestOpenTime), targetEndTime)
        : null;
      const boundaryGap = internalGap ?? detectKlineTailGap(latestOpenTime, targetEndTime, safeIntervalMs);
      if ((cachedCount < expectedCount && !naturalHistoryShortfall) || boundaryGap) {
        deficient.push({
          symbol,
          intervalCode,
          cachedCount,
          expectedCount,
          missingCount: Math.max(0, expectedCount - cachedCount),
          earliestOpenTime,
          latestOpenTime,
          firstAvailableOpenTime,
          naturalHistoryShortfall,
          gapStartTime: boundaryGap?.startTime ?? null,
          gapEndTime: boundaryGap?.endTime ?? null,
          gapMissingCount: boundaryGap?.missingCount ?? 0,
          reason: boundaryGap ? "gap" : "count"
        });
      }
    }
  }
  return {
    activeTokenCount: bySymbol.size,
    checkedIntervalCount: bySymbol.size * 4,
    deficientIntervalCount: deficient.length,
    deficientTokenCount: new Set(deficient.map((item) => item.symbol)).size,
    deficient
  };
}

export async function cleanupInactiveTokenKlines(retentionDays = 7) {
  const safeDays = Math.max(1, Math.floor(Number(retentionDays) || 7));
  const [countRows] = await getPool().query(
    `SELECT COUNT(*) AS rowCount, COUNT(DISTINCT token_id) AS tokenCount
     FROM kline_cache
     WHERE token_id IN (
       SELECT id FROM token_list
       WHERE is_active=0
         AND inactive_since IS NOT NULL
         AND inactive_since < DATE_SUB(NOW(3), INTERVAL :retentionDays DAY)
     )`,
    { retentionDays: safeDays }
  );
  const [result] = await getPool().query(
    `DELETE FROM kline_cache
     WHERE token_id IN (
       SELECT id FROM token_list
       WHERE is_active=0
         AND inactive_since IS NOT NULL
         AND inactive_since < DATE_SUB(NOW(3), INTERVAL :retentionDays DAY)
     )`,
    { retentionDays: safeDays }
  );
  return {
    retentionDays: safeDays,
    tokenCount: Number(countRows[0]?.tokenCount ?? 0),
    deletedRows: Number(result.affectedRows ?? 0)
  };
}

export async function countActiveTokens() {
  const [rows] = await getPool().query("SELECT COUNT(*) AS count FROM token_list WHERE is_active=1");
  return Number(rows[0]?.count ?? 0);
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

export async function claimNextTokenForFetch({ incrementalCutoffAt = null } = {}) {
  const connection = await getPool().getConnection();
  try {
    const incrementalRefreshCondition = incrementalCutoffAt
      ? `OR (fetch_status='completed' AND (cache_policy_key IS NULL OR cache_policy_key <> :cachePolicyKey))
          OR (fetch_status='completed' AND (cache_completed_at IS NULL OR cache_completed_at < :incrementalCutoffAt))`
      : "";
    await connection.beginTransaction();
    const [rows] = await connection.query(
      `SELECT * FROM token_list
     WHERE is_active=1
       AND (fetch_status IN ('pending','partial','failed')
          ${incrementalRefreshCondition})
       ORDER BY
        CASE fetch_status WHEN 'partial' THEN 0 WHEN 'failed' THEN 1 WHEN 'completed' THEN 2 ELSE 3 END,
        category_type ASC,
        updated_at ASC
       LIMIT 1
       FOR UPDATE SKIP LOCKED`,
      { cachePolicyKey: config.crawler.cachePolicyKey, incrementalCutoffAt }
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

function intervalMs(intervalCode) {
  return {
    "15m": 15 * 60 * 1000,
    "1h": 60 * 60 * 1000,
    "4h": 4 * 60 * 60 * 1000,
    "1d": 24 * 60 * 60 * 1000
  }[intervalCode] ?? 60 * 60 * 1000;
}

function latestClosedKlineOpenTime(intervalCode) {
  const ms = intervalMs(intervalCode);
  return Math.floor(Date.now() / ms) * ms - ms;
}

function normalizeIntervalCode(value) {
  return ["15m", "1h", "4h", "1d"].includes(value) ? value : null;
}

export function isNaturalKlineHistoryShortfall({
  cachedCount,
  expectedCount,
  earliestOpenTime,
  firstAvailableOpenTime,
  targetStartTime,
  intervalMsValue
} = {}) {
  const safeCachedCount = Number(cachedCount);
  const safeExpectedCount = Number(expectedCount);
  const safeEarliestOpenTime = Number(earliestOpenTime);
  const safeFirstAvailableOpenTime = Number(firstAvailableOpenTime);
  const safeTargetStartTime = Number(targetStartTime);
  const safeIntervalMs = Math.max(1, Number(intervalMsValue) || 1);
  if (!Number.isFinite(safeCachedCount) || !Number.isFinite(safeExpectedCount)) return false;
  if (safeCachedCount <= 0 || safeCachedCount >= safeExpectedCount) return false;
  if (
    !Number.isFinite(safeEarliestOpenTime) ||
    !Number.isFinite(safeFirstAvailableOpenTime) ||
    !Number.isFinite(safeTargetStartTime)
  ) {
    return false;
  }
  if (safeFirstAvailableOpenTime <= safeTargetStartTime) return false;
  return Math.abs(safeEarliestOpenTime - safeFirstAvailableOpenTime) <= safeIntervalMs;
}

export async function listKlineTailRefreshTargets({
  intervals = ["15m", "1h", "4h", "1d"],
  limit = config.crawler.tailRefreshLimit
} = {}) {
  const safeIntervals = [
    ...new Set(
      (Array.isArray(intervals) ? intervals : [intervals])
        .map(normalizeIntervalCode)
        .filter(Boolean)
    )
  ];
  if (!safeIntervals.length) return [];

  const intervalRows = safeIntervals
    .map((_, index) => `SELECT :interval${index} AS interval_code, :targetEnd${index} AS target_end_time, :targetClose${index} AS target_close_time`)
    .join(" UNION ALL ");
  const params = {
    limit: Math.max(1, Math.min(10_000, Number(limit) || config.crawler.tailRefreshLimit))
  };
  safeIntervals.forEach((intervalCode, index) => {
    const targetEndTime = latestClosedKlineOpenTime(intervalCode);
    params[`interval${index}`] = intervalCode;
    params[`targetEnd${index}`] = targetEndTime;
    params[`targetClose${index}`] = new Date(targetEndTime + intervalMs(intervalCode) - 1);
  });

  const [rows] = await getPool().query(
    `SELECT t.id, t.symbol, t.base_asset AS baseAsset,
      t.category_type AS categoryType, t.category_label AS categoryLabel,
      intervals.interval_code AS intervalCode,
      s.signal_time AS signalTime,
      intervals.target_end_time AS targetEndTime
     FROM token_list t
     JOIN (${intervalRows}) intervals
     LEFT JOIN signal_result s
       ON s.symbol=t.symbol
      AND s.interval_code=intervals.interval_code
     WHERE t.is_active=1
       AND (s.signal_time IS NULL OR s.signal_time < intervals.target_close_time)
     ORDER BY
      FIELD(intervals.interval_code, '15m','1h','4h','1d'),
      s.signal_time IS NULL DESC,
      s.signal_time ASC,
      t.symbol ASC
     LIMIT :limit`,
    params
  );

  return rows.map((row) => {
    const signalTimeMs = row.signalTime === null || row.signalTime === undefined
      ? null
      : new Date(row.signalTime).getTime();
    const targetEndTime = Number(row.targetEndTime);
    const latestOpenTime = Number.isFinite(signalTimeMs)
      ? Math.floor(signalTimeMs / intervalMs(row.intervalCode)) * intervalMs(row.intervalCode)
      : null;
    const tailGap = latestOpenTime === null
      ? null
      : detectKlineTailGap(latestOpenTime, targetEndTime, intervalMs(row.intervalCode));
    return {
      id: row.id,
      symbol: sanitizeDbSymbol(row.symbol),
      baseAsset: row.baseAsset,
      categoryType: row.categoryType,
      categoryLabel: row.categoryLabel,
      intervalCode: row.intervalCode,
      latestOpenTime,
      targetEndTime,
      gapStartTime: tailGap?.startTime ?? null,
      gapEndTime: tailGap?.endTime ?? null,
      missingCount: tailGap?.missingCount ?? null
    };
  });
}

export async function markKlineAvailabilityStart(symbol, intervalCode, firstOpenTime, source = "binance") {
  const safeSymbol = sanitizeDbSymbol(symbol);
  const safeIntervalCode = normalizeIntervalCode(intervalCode);
  const safeFirstOpenTime = Math.max(0, Math.floor(Number(firstOpenTime) || 0));
  if (!safeSymbol || !safeIntervalCode || !safeFirstOpenTime) return false;
  await getPool().query(
    `INSERT INTO kline_availability (symbol, interval_code, first_open_time, source, last_checked_at)
     VALUES (:symbol, :intervalCode, :firstOpenTime, :source, NOW(3))
     ON DUPLICATE KEY UPDATE
      first_open_time=LEAST(first_open_time, VALUES(first_open_time)),
      source=VALUES(source),
      last_checked_at=NOW(3)`,
    {
      symbol: safeSymbol,
      intervalCode: safeIntervalCode,
      firstOpenTime: safeFirstOpenTime,
      source: String(source || "binance").slice(0, 32)
    }
  );
  return true;
}

async function getKlineAvailabilityRows(symbols = []) {
  const safeSymbols = [...new Set((Array.isArray(symbols) ? symbols : [symbols]).map(sanitizeDbSymbol).filter(Boolean))];
  const [rows] = safeSymbols.length
    ? await getPool().query(
        `SELECT symbol, interval_code AS intervalCode, first_open_time AS firstOpenTime
         FROM kline_availability
         WHERE symbol IN (:symbols)`,
        { symbols: safeSymbols }
      )
    : await getPool().query(
        `SELECT symbol, interval_code AS intervalCode, first_open_time AS firstOpenTime
         FROM kline_availability`
      );
  return rows.map((row) => ({
    symbol: sanitizeDbSymbol(row.symbol),
    intervalCode: row.intervalCode,
    firstOpenTime: Number(row.firstOpenTime)
  }));
}

async function getKlineAvailabilityMap(symbols = []) {
  const rows = await getKlineAvailabilityRows(symbols);
  const map = new Map();
  for (const row of rows) {
    map.set(`${row.symbol}|${row.intervalCode}`, row.firstOpenTime);
  }
  return map;
}

export async function findKlineGap(symbol, intervalCode, intervalMsValue, startTime, endTime) {
  const gaps = await listKlineGaps(symbol, intervalCode, intervalMsValue, startTime, endTime, 1);
  return gaps[0] ?? null;
}

export function detectKlineTailGap(latestOpenTime, targetEndTime, intervalMsValue) {
  if (latestOpenTime === null || latestOpenTime === undefined || targetEndTime === null || targetEndTime === undefined) {
    return null;
  }
  const safeLatestOpenTime = Number(latestOpenTime);
  const safeTargetEndTime = Number(targetEndTime);
  const safeIntervalMs = Math.max(1, Number(intervalMsValue) || 1);
  if (!Number.isFinite(safeLatestOpenTime) || !Number.isFinite(safeTargetEndTime)) return null;
  const startTime = safeLatestOpenTime + safeIntervalMs;
  if (startTime > safeTargetEndTime) return null;
  return {
    startTime,
    endTime: safeTargetEndTime,
    missingCount: Math.max(1, Math.round((safeTargetEndTime - startTime) / safeIntervalMs) + 1)
  };
}

export async function listKlineGaps(symbol, intervalCode, intervalMsValue, startTime, endTime, limit = 200) {
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
  if (rows.length < 2) return [];
  const safeLimit = Math.max(1, Math.min(1000, Number(limit) || 200));
  const gaps = [];
  let previousOpenTime = Number(rows[0].openTime);
  const safeIntervalMs = Math.max(1, Number(intervalMsValue) || 1);
  for (const row of rows.slice(1)) {
    const currentOpenTime = Number(row.openTime);
    const expectedOpenTime = previousOpenTime + safeIntervalMs;
    if (currentOpenTime > expectedOpenTime) {
      gaps.push({
        startTime: expectedOpenTime,
        endTime: currentOpenTime - safeIntervalMs,
        missingCount: Math.max(1, Math.round((currentOpenTime - expectedOpenTime) / safeIntervalMs))
      });
      if (gaps.length >= safeLimit) break;
    }
    previousOpenTime = currentOpenTime;
  }
  return gaps;
}

function nextTurn() {
  return new Promise((resolve) => setImmediate(resolve));
}

async function deleteInBatches(sql, params, batchSize = config.maintenance.deleteBatchSize) {
  const safeBatchSize = Math.max(100, Math.min(20_000, Number(batchSize) || 5000));
  let deletedRows = 0;
  while (true) {
    const [result] = await getPool().query(`${sql} LIMIT :deleteBatchSize`, {
      ...params,
      deleteBatchSize: safeBatchSize
    });
    const affectedRows = Number(result.affectedRows ?? 0);
    deletedRows += affectedRows;
    if (affectedRows < safeBatchSize) break;
    await nextTurn();
  }
  return deletedRows;
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

  return deleteInBatches(
    `DELETE FROM kline_cache
     WHERE symbol=:symbol
       AND interval_code=:intervalCode
       AND open_time < :cutoffOpenTime`,
    { symbol, intervalCode, cutoffOpenTime: Number(cutoffOpenTime) }
  );
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
      await nextTurn();
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

export async function cleanupTriggerHistoryRetention(
  retentionHours = config.maintenance.triggerHistoryRetentionHours
) {
  const safeHours = Math.max(1, Number(retentionHours) || 4);
  return deleteInBatches(
    "DELETE FROM signal_trigger_history WHERE trigger_time < DATE_SUB(NOW(3), INTERVAL :retentionHours HOUR)",
    { retentionHours: safeHours }
  );
}

export async function cleanupExpiredData() {
  const hotRankDays = Math.max(1, Number(config.maintenance.hotRankRetentionDays) || 30);
  const ioDays = Math.max(1, Number(config.maintenance.ioRetentionDays) || 30);
  const oiSampleDays = Math.max(2, Number(config.openInterestMonitor.sampleRetentionDays) || 3);
  const [triggerHistory, hotSnapshots, staleHotRows, staleOpenInterest, staleOpenInterestSamples, staleTelegramAlerts, staleUnlocks] = await Promise.all([
    cleanupTriggerHistoryRetention(),
    deleteInBatches(
      "DELETE FROM hot_rank_snapshot WHERE snapshot_time < DATE_SUB(NOW(3), INTERVAL :retentionDays DAY)",
      { retentionDays: hotRankDays }
    ),
    deleteInBatches(
      "DELETE FROM hot_rank_seen WHERE last_seen_at < DATE_SUB(NOW(3), INTERVAL :retentionDays DAY)",
      { retentionDays: hotRankDays }
    ),
    deleteInBatches(
      "DELETE FROM open_interest_monitor WHERE observed_at < DATE_SUB(NOW(3), INTERVAL :retentionDays DAY)",
      { retentionDays: ioDays }
    ),
    deleteInBatches(
      "DELETE FROM open_interest_sample WHERE observed_at < DATE_SUB(NOW(3), INTERVAL :retentionDays DAY)",
      { retentionDays: oiSampleDays }
    ),
    deleteInBatches(
      `DELETE FROM telegram_alert_queue
       WHERE status IN ('SENT','FAILED')
         AND updated_at < DATE_SUB(NOW(3), INTERVAL :retentionDays DAY)`,
      { retentionDays: hotRankDays }
    ),
    deleteInBatches(
      `DELETE FROM token_unlock_cache
       WHERE symbol NOT IN (SELECT symbol FROM watchlist)
         AND checked_at < DATE_SUB(NOW(3), INTERVAL :retentionDays DAY)`,
      { retentionDays: hotRankDays }
    )
  ]);
  return {
    triggerHistory,
    hotSnapshots,
    staleHotRows,
    staleOpenInterest,
    staleOpenInterestSamples,
    staleTelegramAlerts,
    staleUnlocks
  };
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

function normalizedFundingIntervalItem(item) {
  const symbol = sanitizeDbSymbol(item?.symbol);
  const fundingIntervalHours = Math.max(0, Math.floor(Number(item?.fundingIntervalHours) || 0));
  if (!symbol || fundingIntervalHours <= 0) return null;
  const cap = Number(item?.adjustedFundingRateCap);
  const floor = Number(item?.adjustedFundingRateFloor);
  const currentFundingRate = Number(item?.currentFundingRate);
  const nextFundingTime = Number(item?.nextFundingTime);
  return {
    symbol,
    fundingIntervalHours,
    adjustedFundingRateCap: Number.isFinite(cap) ? cap : null,
    adjustedFundingRateFloor: Number.isFinite(floor) ? floor : null,
    currentFundingRate: Number.isFinite(currentFundingRate) ? currentFundingRate : null,
    nextFundingTime: Number.isFinite(nextFundingTime) && nextFundingTime > 0 ? Math.floor(nextFundingTime) : null,
    disclaimer: item?.disclaimer ? 1 : 0
  };
}

export function normalizeFundingIntervalSnapshotItems(items) {
  const bySymbol = new Map();
  for (const item of items ?? []) {
    const normalized = normalizedFundingIntervalItem(item);
    if (normalized) bySymbol.set(normalized.symbol, normalized);
  }
  return Array.from(bySymbol.values());
}

export async function recordFundingIntervalSnapshot(items) {
  const normalized = normalizeFundingIntervalSnapshotItems(items);
  if (!normalized.length) return { seenCount: 0, symbols: [] };

  const rows = normalized.map((item) => [
    item.symbol,
    item.fundingIntervalHours,
    item.adjustedFundingRateCap,
    item.adjustedFundingRateFloor,
    item.currentFundingRate,
    item.nextFundingTime,
    item.disclaimer,
    1
  ]);

  await getPool().query(
    `INSERT INTO funding_interval_state
      (symbol, funding_interval_hours, adjusted_funding_rate_cap, adjusted_funding_rate_floor, current_funding_rate, next_funding_time, disclaimer, source_present)
     VALUES ?
     ON DUPLICATE KEY UPDATE
      previous_funding_interval_hours=IF(funding_interval_hours <> VALUES(funding_interval_hours), funding_interval_hours, previous_funding_interval_hours),
      last_changed_at=IF(funding_interval_hours <> VALUES(funding_interval_hours), NOW(3), last_changed_at),
      one_hour_alerted_at=IF(VALUES(funding_interval_hours) <> 1 AND funding_interval_hours <> VALUES(funding_interval_hours), NULL, one_hour_alerted_at),
      one_hour_confirmed_at=IF(funding_interval_hours <> VALUES(funding_interval_hours), NULL, one_hour_confirmed_at),
      next_one_hour_alert_at=IF(funding_interval_hours <> VALUES(funding_interval_hours), NULL, next_one_hour_alert_at),
      one_hour_alert_count=IF(funding_interval_hours <> VALUES(funding_interval_hours), 0, one_hour_alert_count),
      funding_interval_hours=VALUES(funding_interval_hours),
      adjusted_funding_rate_cap=VALUES(adjusted_funding_rate_cap),
      adjusted_funding_rate_floor=VALUES(adjusted_funding_rate_floor),
      current_funding_rate=VALUES(current_funding_rate),
      next_funding_time=VALUES(next_funding_time),
      disclaimer=VALUES(disclaimer),
      source_present=1,
      last_seen_at=NOW(3)`,
    [rows]
  );

  return { seenCount: normalized.length, symbols: normalized.map((item) => item.symbol) };
}

export async function markFundingIntervalsMissingFromSnapshot(symbols, defaultIntervalHours = 4) {
  const safeSymbols = (symbols ?? []).map(sanitizeDbSymbol).filter(Boolean);
  const safeDefault = Math.max(1, Math.floor(Number(defaultIntervalHours) || 4));
  const params = { defaultIntervalHours: safeDefault };
  const whereSql = safeSymbols.length
    ? "source_present=1 AND symbol NOT IN (:symbols)"
    : "source_present=1";
  if (safeSymbols.length) params.symbols = safeSymbols;
  const [result] = await getPool().query(
    `UPDATE funding_interval_state
     SET previous_funding_interval_hours=IF(funding_interval_hours <> :defaultIntervalHours, funding_interval_hours, previous_funding_interval_hours),
         last_changed_at=IF(funding_interval_hours <> :defaultIntervalHours, NOW(3), last_changed_at),
         one_hour_alerted_at=IF(funding_interval_hours = 1 AND :defaultIntervalHours <> 1, NULL, one_hour_alerted_at),
         one_hour_confirmed_at=IF(funding_interval_hours <> :defaultIntervalHours, NULL, one_hour_confirmed_at),
         next_one_hour_alert_at=IF(funding_interval_hours <> :defaultIntervalHours, NULL, next_one_hour_alert_at),
         one_hour_alert_count=IF(funding_interval_hours <> :defaultIntervalHours, 0, one_hour_alert_count),
         funding_interval_hours=:defaultIntervalHours,
         source_present=0
     WHERE ${whereSql}`,
    params
  );
  return result.affectedRows ?? 0;
}

export async function listPendingFundingIntervalAlerts(targetIntervalHours = 1, limit = 100) {
  const safeTarget = Math.max(1, Math.floor(Number(targetIntervalHours) || 1));
  const safeLimit = Math.max(1, Math.min(500, Number(limit) || 100));
  const [rows] = await getPool().query(
    `SELECT symbol,
      previous_funding_interval_hours AS previousFundingIntervalHours,
      funding_interval_hours AS fundingIntervalHours,
      adjusted_funding_rate_cap AS adjustedFundingRateCap,
      adjusted_funding_rate_floor AS adjustedFundingRateFloor,
      current_funding_rate AS currentFundingRate,
      next_funding_time AS nextFundingTime,
      disclaimer,
      source_present AS sourcePresent,
      first_seen_at AS firstSeenAt,
      last_seen_at AS lastSeenAt,
      last_changed_at AS lastChangedAt,
      one_hour_alerted_at AS oneHourAlertedAt,
      one_hour_confirmed_at AS oneHourConfirmedAt,
      next_one_hour_alert_at AS nextOneHourAlertAt,
      one_hour_alert_count AS oneHourAlertCount
     FROM funding_interval_state
     WHERE funding_interval_hours=:targetIntervalHours
       AND source_present=1
       AND one_hour_confirmed_at IS NULL
       AND (
         one_hour_alerted_at IS NULL
         OR next_one_hour_alert_at IS NULL
         OR next_one_hour_alert_at <= NOW(3)
       )
     ORDER BY COALESCE(last_changed_at, first_seen_at) ASC, symbol ASC
     LIMIT :limit`,
    { targetIntervalHours: safeTarget, limit: safeLimit }
  );
  return rows.map((row) => ({
    ...row,
    previousFundingIntervalHours:
      row.previousFundingIntervalHours === null || row.previousFundingIntervalHours === undefined
        ? null
        : Number(row.previousFundingIntervalHours),
    fundingIntervalHours: Number(row.fundingIntervalHours),
    adjustedFundingRateCap:
      row.adjustedFundingRateCap === null || row.adjustedFundingRateCap === undefined
        ? null
        : Number(row.adjustedFundingRateCap),
    adjustedFundingRateFloor:
      row.adjustedFundingRateFloor === null || row.adjustedFundingRateFloor === undefined
        ? null
        : Number(row.adjustedFundingRateFloor),
    currentFundingRate:
      row.currentFundingRate === null || row.currentFundingRate === undefined
        ? null
        : Number(row.currentFundingRate),
    nextFundingTime: row.nextFundingTime === null || row.nextFundingTime === undefined ? null : Number(row.nextFundingTime),
    disclaimer: Boolean(row.disclaimer),
    sourcePresent: Boolean(row.sourcePresent),
    oneHourAlertedAt: row.oneHourAlertedAt ?? null,
    oneHourConfirmedAt: row.oneHourConfirmedAt ?? null,
    nextOneHourAlertAt: row.nextOneHourAlertAt ?? null,
    oneHourAlertCount: Number(row.oneHourAlertCount ?? 0)
  }));
}

export async function markFundingIntervalAlertSent(symbols, repeatAfterMs = 5 * 60 * 1000) {
  const safeSymbols = (Array.isArray(symbols) ? symbols : [symbols]).map(sanitizeDbSymbol).filter(Boolean);
  if (!safeSymbols.length) return 0;
  const repeatSeconds = Math.max(60, Math.floor((Number(repeatAfterMs) || 5 * 60 * 1000) / 1000));
  const [result] = await getPool().query(
    `UPDATE funding_interval_state
     SET one_hour_alerted_at=NOW(3),
         next_one_hour_alert_at=DATE_ADD(NOW(3), INTERVAL :repeatSeconds SECOND),
         one_hour_alert_count=one_hour_alert_count+1
     WHERE symbol IN (:symbols)`,
    { symbols: safeSymbols, repeatSeconds }
  );
  return result.affectedRows ?? 0;
}

export async function markFundingIntervalAlertConfirmed(symbols) {
  const safeSymbols = (Array.isArray(symbols) ? symbols : [symbols]).map(sanitizeDbSymbol).filter(Boolean);
  if (!safeSymbols.length) return 0;
  const [result] = await getPool().query(
    `UPDATE funding_interval_state
     SET one_hour_confirmed_at=NOW(3),
         next_one_hour_alert_at=NULL
     WHERE symbol IN (:symbols)
       AND funding_interval_hours=1
       AND source_present=1`,
    { symbols: safeSymbols }
  );
  return result.affectedRows ?? 0;
}

function baseAssetAliases(value) {
  const baseAsset = sanitizeDbSymbol(value);
  if (!baseAsset) return [];
  const aliases = new Set([baseAsset]);
  for (const prefix of ["1000000", "1000"]) {
    if (baseAsset.startsWith(prefix) && baseAsset.length > prefix.length) {
      aliases.add(baseAsset.slice(prefix.length));
    }
  }
  return Array.from(aliases);
}

export function collectHotRankFundingSymbols(symbols, hotRows) {
  const symbolSet = new Set((symbols ?? []).map(sanitizeDbSymbol).filter(Boolean));
  const symbolsByBaseAsset = new Map();
  for (const symbol of symbolSet) {
    for (const alias of baseAssetAliases(baseAssetFromSymbol(symbol))) {
      const matches = symbolsByBaseAsset.get(alias) ?? new Set();
      matches.add(symbol);
      symbolsByBaseAsset.set(alias, matches);
    }
  }

  const matched = new Set();
  for (const row of hotRows ?? []) {
    const rowSymbol = sanitizeDbSymbol(row?.symbol);
    if (symbolSet.has(rowSymbol)) matched.add(rowSymbol);
    for (const alias of baseAssetAliases(row?.baseAsset)) {
      for (const symbol of symbolsByBaseAsset.get(alias) ?? []) matched.add(symbol);
    }
  }
  return matched;
}

export async function listOneHourFundingIntervals() {
  const [rows] = await getPool().query(
    `SELECT symbol,
      funding_interval_hours AS fundingIntervalHours,
      previous_funding_interval_hours AS previousFundingIntervalHours,
      adjusted_funding_rate_cap AS adjustedFundingRateCap,
      adjusted_funding_rate_floor AS adjustedFundingRateFloor,
      current_funding_rate AS currentFundingRate,
      next_funding_time AS nextFundingTime,
      (
        SELECT k.close_price
        FROM kline_cache k
        WHERE k.symbol=funding_interval_state.symbol AND k.interval_code='15m'
        ORDER BY k.open_time DESC
        LIMIT 1
      ) AS currentPrice,
      (
        SELECT k.close_time
        FROM kline_cache k
        WHERE k.symbol=funding_interval_state.symbol AND k.interval_code='15m'
        ORDER BY k.open_time DESC
        LIMIT 1
      ) AS currentCloseTime,
      source_present AS sourcePresent,
      first_seen_at AS firstSeenAt,
      last_seen_at AS lastSeenAt,
      last_changed_at AS lastChangedAt
     FROM funding_interval_state
     WHERE funding_interval_hours=1
       AND source_present=1
     ORDER BY COALESCE(last_changed_at, last_seen_at) DESC, symbol`
  );
  const symbols = rows.map((row) => sanitizeDbSymbol(row.symbol)).filter(Boolean);
  if (!symbols.length) return [];
  const baseAssets = [...new Set(symbols.flatMap((symbol) => baseAssetAliases(baseAssetFromSymbol(symbol))))];
  const [signalResult, hotResult, oiResult] = await Promise.all([
    getPool().query(
      `SELECT symbol,
        COUNT(*) AS multiCycleCount,
        GROUP_CONCAT(interval_code ORDER BY FIELD(interval_code, '15m','1h','4h','1d') SEPARATOR ',') AS intervals,
        SUBSTRING_INDEX(
          GROUP_CONCAT(alert_level ORDER BY FIELD(alert_level, 'LEVEL1','LEVEL2') SEPARATOR ','),
          ',',
          1
        ) AS alertLevel
       FROM signal_result
       WHERE symbol IN (?) AND alert_level IN ('LEVEL1','LEVEL2')
       GROUP BY symbol`,
      [symbols]
    ),
    getPool().query(
      `SELECT symbol, base_asset AS baseAsset
       FROM hot_rank_seen
       WHERE (symbol IN (?) OR base_asset IN (?))
         AND last_seen_at >= DATE_SUB(NOW(3), INTERVAL ? SECOND)`,
      [symbols, baseAssets, hotRankActiveSeconds()]
    ),
    getPool().query(
      `SELECT symbol,
        change_5m_pct AS change5mPct,
        change_1h_pct AS change1hPct,
        change_4h_pct AS change4hPct,
        change_1d_pct AS change1dPct
       FROM open_interest_monitor
       WHERE symbol IN (?)
         AND observed_at >= DATE_SUB(NOW(3), INTERVAL ? SECOND)`,
      [symbols, openInterestActiveSeconds()]
    )
  ]);
  const signalBySymbol = new Map(signalResult[0].map((row) => [row.symbol, row]));
  const hotSymbols = collectHotRankFundingSymbols(symbols, hotResult[0]);
  const oiBySymbol = new Map(oiResult[0].map((row) => [row.symbol, row]));

  return rows.map((row) => {
    const signal = signalBySymbol.get(row.symbol);
    const oiSpike = evaluateOpenInterestSpike(oiBySymbol.get(row.symbol), config.openInterestMonitor);
    const oiMatched = oiSpike.hit;
    return {
      ...row,
      fundingIntervalHours: Number(row.fundingIntervalHours),
      previousFundingIntervalHours:
        row.previousFundingIntervalHours === null ? null : Number(row.previousFundingIntervalHours),
      adjustedFundingRateCap: row.adjustedFundingRateCap === null ? null : Number(row.adjustedFundingRateCap),
      adjustedFundingRateFloor: row.adjustedFundingRateFloor === null ? null : Number(row.adjustedFundingRateFloor),
      currentFundingRate: row.currentFundingRate === null ? null : Number(row.currentFundingRate),
      nextFundingTime: row.nextFundingTime === null ? null : Number(row.nextFundingTime),
      currentPrice: row.currentPrice === null ? null : Number(row.currentPrice),
      currentCloseTime: row.currentCloseTime === null ? null : Number(row.currentCloseTime),
      sourcePresent: Boolean(row.sourcePresent),
      hotRank: hotSymbols.has(row.symbol),
      fundingOneHour: true,
      multiCycleCount: Number(signal?.multiCycleCount ?? 0),
      intervals: String(signal?.intervals ?? "").split(",").filter(Boolean),
      alertLevel: signal?.alertLevel ?? null,
      oiChange5mPct: oiSpike.change5mPct,
      oiChange1hPct: oiSpike.change1hPct,
      oiChange4hPct: oiSpike.change4hPct,
      oiChange1dPct: oiSpike.change1dPct,
      oiMatched,
      oiSpike: oiSpike.hit,
      oiSpike5mHit: oiSpike.hit5m,
      oiSpike1hHit: oiSpike.hit1h,
      oiSpike4hHit: oiSpike.hit4h,
      oiSpike1dHit: oiSpike.hit1d
    };
  });
}

export async function listTopFundingRealtimeTokens(limit = 5) {
  const safeLimit = Math.max(1, Math.min(20, Number(limit) || 5));
  const [rows] = await getPool().query(
    `SELECT t.*
     FROM funding_interval_state f
     JOIN token_list t ON t.symbol=f.symbol AND t.is_active=1
     WHERE f.funding_interval_hours=1
       AND f.source_present=1
     ORDER BY COALESCE(f.last_changed_at, f.last_seen_at) DESC, f.symbol
     LIMIT :limit`,
    { limit: safeLimit }
  );
  return rows;
}

const TRIGGER_TYPES = new Set(["MA_SIGNAL", "HOT_RANK", "FUNDING_RATE", "OI_SPIKE", "COMPOSITE"]);

function normalizeTriggerHistoryItem(item) {
  const safeSymbol = sanitizeDbSymbol(item?.symbol);
  const safeTriggerType = TRIGGER_TYPES.has(item?.triggerType) ? item.triggerType : null;
  const safeEventKey = String(item?.eventKey ?? "").trim().slice(0, 191);
  if (!safeSymbol || !safeTriggerType || !safeEventKey) return null;
  const date =
    item.triggerTime instanceof Date
      ? item.triggerTime
      : new Date(Number(item?.triggerTime) || item?.triggerTime);
  return [
    safeEventKey,
    safeSymbol,
    safeTriggerType,
    String(item?.intervals ?? "").slice(0, 100) || null,
    item?.signalLevel ? String(item.signalLevel).slice(0, 32) : null,
    Number.isNaN(date.getTime()) ? new Date() : date,
    item?.details === null || item?.details === undefined ? null : JSON.stringify(item.details)
  ];
}

export async function recordTriggerHistoryBatch(items) {
  const rows = (items ?? []).map(normalizeTriggerHistoryItem).filter(Boolean);
  if (!rows.length) return 0;
  const [result] = await getPool().query(
    `INSERT INTO signal_trigger_history
      (event_key, symbol, trigger_type, intervals_triggered, signal_level, trigger_time, details)
     VALUES ?
     ON DUPLICATE KEY UPDATE
      intervals_triggered=VALUES(intervals_triggered),
      signal_level=VALUES(signal_level),
      trigger_time=VALUES(trigger_time),
      details=VALUES(details)`,
    [rows]
  );
  return result.affectedRows ?? 0;
}

export async function recordTriggerHistory(item) {
  return (await recordTriggerHistoryBatch([item])) > 0;
}

export async function listTriggerHistory({ page = 1, pageSize = 20, triggerTypes = [] } = {}) {
  const safePage = Math.max(1, Number(page) || 1);
  const safePageSize = Math.max(1, Math.min(100, Number(pageSize) || 20));
  const safeTypes = normalizeList(triggerTypes, TRIGGER_TYPES);
  const whereSql = safeTypes.length ? `WHERE trigger_type IN (${quotedList(safeTypes)})` : "";
  const [countRows] = await getPool().query(
    `SELECT COUNT(*) AS total FROM signal_trigger_history ${whereSql}`
  );
  const [rows] = await getPool().query(
    `SELECT id, symbol, trigger_type AS triggerType,
      intervals_triggered AS intervalsTriggered,
      signal_level AS signalLevel,
      trigger_time AS triggerTime,
      details
     FROM signal_trigger_history
     ${whereSql}
     ORDER BY trigger_time DESC, id DESC
     LIMIT :pageSize OFFSET :offset`,
    { pageSize: safePageSize, offset: (safePage - 1) * safePageSize }
  );
  return {
    items: rows.map((row) => ({
      ...row,
      id: Number(row.id),
      details: (() => {
        if (typeof row.details !== "string") return row.details;
        try {
          return JSON.parse(row.details);
        } catch {
          return null;
        }
      })()
    })),
    total: Number(countRows[0]?.total ?? 0),
    page: safePage,
    pageSize: safePageSize
  };
}

export async function deleteTriggerHistory(ids) {
  const safeIds = (Array.isArray(ids) ? ids : [ids])
    .map((id) => Number(id))
    .filter((id) => Number.isInteger(id) && id > 0);
  if (!safeIds.length) return 0;
  const [result] = await getPool().query("DELETE FROM signal_trigger_history WHERE id IN (?)", [safeIds]);
  return result.affectedRows ?? 0;
}

export async function clearTriggerHistory() {
  const [result] = await getPool().query("DELETE FROM signal_trigger_history");
  return result.affectedRows ?? 0;
}

const TELEGRAM_ALERT_TYPES = new Set(["OI_SPIKE"]);

function normalizeTelegramAlertQueueItem(item = {}) {
  const queueKey = String(item.queueKey ?? "").trim().slice(0, 191);
  const alertType = TELEGRAM_ALERT_TYPES.has(item.alertType) ? item.alertType : null;
  const symbol = sanitizeDbSymbol(item.symbol) || null;
  const payload = item.payload === null || item.payload === undefined ? null : JSON.stringify(item.payload);
  const nextAttemptAt =
    item.nextAttemptAt instanceof Date
      ? item.nextAttemptAt
      : new Date(Number(item.nextAttemptAt) || item.nextAttemptAt || Date.now());
  if (!queueKey || !alertType || !payload || Number.isNaN(nextAttemptAt.getTime())) return null;
  return { queueKey, alertType, symbol, payload, nextAttemptAt };
}

export async function enqueueTelegramAlert(item) {
  const normalized = normalizeTelegramAlertQueueItem(item);
  if (!normalized) return false;
  const [result] = await getPool().query(
    `INSERT INTO telegram_alert_queue
      (queue_key, alert_type, symbol, payload_json, status, next_attempt_at)
     VALUES
      (:queueKey, :alertType, :symbol, :payload, 'PENDING', :nextAttemptAt)
     ON DUPLICATE KEY UPDATE
      alert_type=VALUES(alert_type),
      symbol=VALUES(symbol),
      payload_json=VALUES(payload_json),
      status=IF(status='SENDING', status, 'PENDING'),
      next_attempt_at=IF(status='SENDING', next_attempt_at, LEAST(next_attempt_at, VALUES(next_attempt_at))),
      last_error=IF(status='SENDING', last_error, NULL),
      sent_at=NULL`,
    normalized
  );
  return (result.affectedRows ?? 0) > 0;
}

function parseJsonColumn(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === "object") return value;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

export async function claimTelegramAlerts(limit = 10, staleAfterMs = 5 * 60 * 1000) {
  const safeLimit = Math.max(1, Math.min(50, Number(limit) || 10));
  const staleSeconds = Math.max(60, Math.floor((Number(staleAfterMs) || 5 * 60 * 1000) / 1000));
  const connection = await getPool().getConnection();
  try {
    await connection.beginTransaction();
    const [rows] = await connection.query(
      `SELECT id, queue_key AS queueKey, alert_type AS alertType, symbol, payload_json AS payloadJson,
        attempt_count AS attemptCount, status
       FROM telegram_alert_queue
       WHERE (
          status='PENDING'
          OR (status='SENDING' AND locked_at < DATE_SUB(NOW(3), INTERVAL :staleSeconds SECOND))
        )
        AND next_attempt_at <= NOW(3)
       ORDER BY next_attempt_at ASC, id ASC
       LIMIT :limit
       FOR UPDATE SKIP LOCKED`,
      { staleSeconds, limit: safeLimit }
    );
    if (!rows.length) {
      await connection.commit();
      return [];
    }
    await connection.query(
      `UPDATE telegram_alert_queue
       SET status='SENDING',
           locked_at=NOW(3),
           attempt_count=attempt_count+1
       WHERE id IN (:ids)`,
      { ids: rows.map((row) => row.id) }
    );
    await connection.commit();
    return rows.map((row) => ({
      id: Number(row.id),
      queueKey: row.queueKey,
      alertType: row.alertType,
      symbol: row.symbol,
      payload: parseJsonColumn(row.payloadJson),
      attemptCount: Number(row.attemptCount ?? 0) + 1
    }));
  } catch (error) {
    await connection.rollback().catch(() => {});
    throw error;
  } finally {
    connection.release();
  }
}

export async function markTelegramAlertSent(id) {
  const safeId = Number(id);
  if (!Number.isInteger(safeId) || safeId <= 0) return 0;
  const [result] = await getPool().query(
    `UPDATE telegram_alert_queue
     SET status='SENT',
         sent_at=NOW(3),
         locked_at=NULL,
         last_error=NULL
     WHERE id=:id`,
    { id: safeId }
  );
  return result.affectedRows ?? 0;
}

export async function markTelegramAlertFailed(id, error, { maxAttempts = 8, retryDelayMs = 5000 } = {}) {
  const safeId = Number(id);
  if (!Number.isInteger(safeId) || safeId <= 0) return 0;
  const safeMaxAttempts = Math.max(1, Number(maxAttempts) || 8);
  const safeRetryDelayMs = Math.max(1000, Number(retryDelayMs) || 5000);
  const retrySeconds = Math.max(1, Math.ceil(safeRetryDelayMs / 1000));
  const message = error instanceof Error ? error.message : String(error ?? "unknown error");
  const [result] = await getPool().query(
    `UPDATE telegram_alert_queue
     SET status=IF(attempt_count >= :maxAttempts, 'FAILED', 'PENDING'),
         next_attempt_at=DATE_ADD(NOW(3), INTERVAL :retrySeconds SECOND),
         locked_at=NULL,
         last_error=:lastError
     WHERE id=:id`,
    {
      id: safeId,
      maxAttempts: safeMaxAttempts,
      retrySeconds,
      lastError: message.slice(0, 1000)
    }
  );
  return result.affectedRows ?? 0;
}

export async function getTelegramAlertQueueStats() {
  const [rows] = await getPool().query(
    `SELECT status, COUNT(*) AS count
     FROM telegram_alert_queue
     GROUP BY status`
  );
  const stats = { pending: 0, sending: 0, sent: 0, failed: 0 };
  for (const row of rows) {
    const key = String(row.status ?? "").toLowerCase();
    if (key in stats) stats[key] = Number(row.count ?? 0);
  }
  return stats;
}

const TRADE_JOURNAL_STATUSES = new Set(["OPEN", "ENDED", "REVIEWED"]);
const TRADE_JOURNAL_SIDES = new Set(["LONG", "SHORT", "SPOT", "OTHER"]);

function tradeJournalText(value, maxLength, fallback = "") {
  const text = String(value ?? "").trim();
  return (text || fallback).slice(0, maxLength);
}

function tradeJournalNullableDate(value, fieldName) {
  if (value === "" || value === null || value === undefined) return null;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`${fieldName} must be a valid date`);
  }
  return date;
}

function normalizeTradeJournalPayload(payload = {}) {
  const symbol = sanitizeDbSymbol(payload.symbol);
  const side = String(payload.side ?? "").toUpperCase();
  const status = String(payload.status ?? "OPEN").toUpperCase();
  const openReason = tradeJournalText(payload.openReason, 8000);
  if (!openReason) throw new Error("开仓理由不能为空");
  return {
    title: tradeJournalText(payload.title, 160, symbol ? `${symbol} 交易日记` : "交易日记"),
    symbol: symbol || null,
    side: TRADE_JOURNAL_SIDES.has(side) ? side : null,
    status: TRADE_JOURNAL_STATUSES.has(status) ? status : "OPEN",
    openedAt: tradeJournalNullableDate(payload.openedAt, "openedAt"),
    closedAt: tradeJournalNullableDate(payload.closedAt, "closedAt"),
    openReason,
    closeReason: tradeJournalText(payload.closeReason, 8000) || null,
    reviewSummary: tradeJournalText(payload.reviewSummary, 12000) || null
  };
}

function normalizeTradeJournalIntradayNote(payload = {}) {
  const noteText = tradeJournalText(payload.noteText ?? payload.text ?? payload.note, 8000);
  if (!noteText) throw new Error("盘中确定不能为空");
  return {
    noteText,
    notedAt: tradeJournalNullableDate(payload.notedAt, "notedAt") ?? new Date()
  };
}

function mapTradeJournalIntradayNote(row) {
  return {
    id: Number(row.id),
    journalId: Number(row.journalId),
    noteText: row.noteText ?? "",
    notedAt: row.notedAt ?? null,
    createdAt: row.createdAt ?? null
  };
}

function mapTradeJournalRow(row) {
  return {
    id: Number(row.id),
    title: row.title ?? "",
    symbol: row.symbol ?? "",
    side: row.side ?? "",
    status: row.status ?? "OPEN",
    openedAt: row.openedAt ?? null,
    closedAt: row.closedAt ?? null,
    openReason: row.openReason ?? "",
    closeReason: row.closeReason ?? "",
    reviewSummary: row.reviewSummary ?? "",
    intradayNotes: [],
    createdAt: row.createdAt ?? null,
    updatedAt: row.updatedAt ?? null
  };
}

async function attachTradeJournalIntradayNotes(items) {
  const journalIds = items
    .map((item) => Number(item.id))
    .filter((id) => Number.isInteger(id) && id > 0);
  if (!journalIds.length) return items;
  const [rows] = await getPool().query(
    `SELECT id, journal_id AS journalId, note_text AS noteText,
      noted_at AS notedAt, created_at AS createdAt
     FROM trade_journal_intraday_notes
     WHERE journal_id IN (?)
     ORDER BY noted_at ASC, id ASC`,
    [journalIds]
  );
  const notesByJournalId = new Map();
  for (const row of rows) {
    const note = mapTradeJournalIntradayNote(row);
    const notes = notesByJournalId.get(note.journalId) ?? [];
    notes.push(note);
    notesByJournalId.set(note.journalId, notes);
  }
  for (const item of items) {
    item.intradayNotes = notesByJournalId.get(Number(item.id)) ?? [];
  }
  return items;
}

export async function listTradeJournal({
  page = 1,
  pageSize = 20,
  keyword = "",
  status = ""
} = {}) {
  const safePage = Math.max(1, Number(page) || 1);
  const safePageSize = Math.max(1, Math.min(100, Number(pageSize) || 20));
  const safeKeyword = String(keyword ?? "").trim().slice(0, 120);
  const safeStatus = TRADE_JOURNAL_STATUSES.has(String(status ?? "").toUpperCase())
    ? String(status).toUpperCase()
    : "";
  const clauses = [];
  const params = {
    pageSize: safePageSize,
    offset: (safePage - 1) * safePageSize
  };
  if (safeStatus) {
    clauses.push("status=:status");
    params.status = safeStatus;
  }
  if (safeKeyword) {
    clauses.push(`(
      title LIKE :keyword
      OR symbol LIKE :keyword
      OR open_reason LIKE :keyword
      OR close_reason LIKE :keyword
      OR review_summary LIKE :keyword
      OR EXISTS (
        SELECT 1
        FROM trade_journal_intraday_notes
        WHERE trade_journal_intraday_notes.journal_id = trade_journal.id
          AND trade_journal_intraday_notes.note_text LIKE :keyword
      )
    )`);
    params.keyword = `%${safeKeyword}%`;
  }
  const whereSql = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const [countRows] = await getPool().query(`SELECT COUNT(*) AS total FROM trade_journal ${whereSql}`, params);
  const [rows] = await getPool().query(
    `SELECT id, title, symbol, side, status,
      opened_at AS openedAt, closed_at AS closedAt,
      open_reason AS openReason, close_reason AS closeReason, review_summary AS reviewSummary,
      created_at AS createdAt, updated_at AS updatedAt
     FROM trade_journal
     ${whereSql}
     ORDER BY COALESCE(opened_at, created_at) DESC, id DESC
     LIMIT :pageSize OFFSET :offset`,
    params
  );
  const items = await attachTradeJournalIntradayNotes(rows.map(mapTradeJournalRow));
  return {
    items,
    total: Number(countRows[0]?.total ?? 0),
    page: safePage,
    pageSize: safePageSize
  };
}

export async function getTradeJournalEntry(id) {
  const safeId = Number(id);
  if (!Number.isInteger(safeId) || safeId <= 0) return null;
  const [rows] = await getPool().query(
    `SELECT id, title, symbol, side, status,
      opened_at AS openedAt, closed_at AS closedAt,
      open_reason AS openReason, close_reason AS closeReason, review_summary AS reviewSummary,
      created_at AS createdAt, updated_at AS updatedAt
     FROM trade_journal
     WHERE id=:id
     LIMIT 1`,
    { id: safeId }
  );
  if (!rows[0]) return null;
  const [item] = await attachTradeJournalIntradayNotes([mapTradeJournalRow(rows[0])]);
  return item;
}

export async function createTradeJournalEntry(payload = {}) {
  const item = normalizeTradeJournalPayload(payload);
  const [result] = await getPool().query(
    `INSERT INTO trade_journal
      (title, symbol, side, status, opened_at, closed_at, open_reason, close_reason, review_summary)
     VALUES
      (:title, :symbol, :side, :status, :openedAt, :closedAt, :openReason, :closeReason, :reviewSummary)`,
    item
  );
  return getTradeJournalEntry(result.insertId);
}

export async function updateTradeJournalEntry(id, payload = {}) {
  const safeId = Number(id);
  if (!Number.isInteger(safeId) || safeId <= 0) throw new Error("id is required");
  const item = normalizeTradeJournalPayload(payload);
  const [result] = await getPool().query(
    `UPDATE trade_journal
     SET title=:title,
       symbol=:symbol,
       side=:side,
       status=:status,
       opened_at=:openedAt,
       closed_at=:closedAt,
       open_reason=:openReason,
       close_reason=:closeReason,
       review_summary=:reviewSummary,
       updated_at=NOW()
     WHERE id=:id`,
    { ...item, id: safeId }
  );
  if (!result.affectedRows) return null;
  return getTradeJournalEntry(safeId);
}

export async function deleteTradeJournalEntry(id) {
  const safeId = Number(id);
  if (!Number.isInteger(safeId) || safeId <= 0) return 0;
  const [result] = await getPool().query("DELETE FROM trade_journal WHERE id=:id", { id: safeId });
  return result.affectedRows ?? 0;
}

export async function createTradeJournalIntradayNote(journalId, payload = {}) {
  const safeJournalId = Number(journalId);
  if (!Number.isInteger(safeJournalId) || safeJournalId <= 0) throw new Error("journal id is required");
  const note = normalizeTradeJournalIntradayNote(payload);
  const [entryRows] = await getPool().query(
    "SELECT id FROM trade_journal WHERE id=:journalId LIMIT 1",
    { journalId: safeJournalId }
  );
  if (!entryRows.length) return null;
  const [result] = await getPool().query(
    `INSERT INTO trade_journal_intraday_notes (journal_id, note_text, noted_at)
     VALUES (:journalId, :noteText, :notedAt)`,
    { journalId: safeJournalId, ...note }
  );
  const [rows] = await getPool().query(
    `SELECT id, journal_id AS journalId, note_text AS noteText,
      noted_at AS notedAt, created_at AS createdAt
     FROM trade_journal_intraday_notes
     WHERE id=:id
     LIMIT 1`,
    { id: result.insertId }
  );
  return rows[0] ? mapTradeJournalIntradayNote(rows[0]) : null;
}

function tradeText(value, maxLength, fallback = "") {
  const text = String(value ?? fallback).trim();
  return (text || fallback).slice(0, maxLength);
}

function tradeNullableText(value, maxLength) {
  const text = String(value ?? "").trim();
  return text ? text.slice(0, maxLength) : null;
}

function tradeNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function tradeNullableNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function tradeEventTimeMs(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : null;
}

function tradeEventDate(value) {
  const time = tradeEventTimeMs(value);
  return time === null ? null : new Date(time);
}

function tradeEventKey(event) {
  const source = tradeText(event?.source, 32);
  const raw = tradeText(event?.id ?? `${source}:${event?.symbol}:${event?.type}:${event?.time}:${event?.net}`, 512);
  if (!source || !raw) return "";
  const key = raw.includes(":") ? raw : `${source}:${raw}`;
  if (key.length <= 191) return key;
  const hash = crypto.createHash("sha256").update(key).digest("hex").slice(0, 24);
  return `${key.slice(0, 166)}:${hash}`;
}

function normalizeTradeHistoryEvent(event) {
  const eventKey = tradeEventKey(event);
  const source = tradeText(event?.source, 32);
  const symbol = tradeText(event?.symbol, 64, "--");
  if (!eventKey || !source || !symbol) return null;
  return [
    eventKey,
    source,
    tradeNullableText(event?.sourceLabel, 80),
    symbol,
    tradeNullableText(event?.asset, 32),
    tradeEventTimeMs(event?.time),
    tradeEventDate(event?.time),
    tradeNullableText(event?.type, 64),
    tradeNullableText(event?.side, 32),
    tradeNullableText(event?.direction, 80),
    tradeNullableText(event?.positionSide, 32),
    tradeNullableNumber(event?.quantity),
    tradeNullableNumber(event?.price),
    tradeNullableNumber(event?.markPrice),
    tradeNullableNumber(event?.notional),
    tradeNullableNumber(event?.fundingRate),
    tradeNumber(event?.realizedPnl),
    tradeNumber(event?.unrealizedPnl),
    tradeNumber(event?.funding),
    tradeNumber(event?.commission),
    tradeNullableText(event?.feeAsset, 32),
    tradeNumber(event?.net),
    tradeNullableText(event?.orderId, 128),
    tradeNullableText(event?.tradeId, 128),
    tradeNullableText(event?.liquidity, 32),
    tradeNullableText(event?.note, 1000),
    event?.pnlIncluded === false ? 0 : 1,
    tradeNullableText(event?.rawType, 64),
    event?.details === null || event?.details === undefined ? null : JSON.stringify(event.details)
  ];
}

export async function upsertTradeEventHistory(events) {
  const rows = (events ?? []).map(normalizeTradeHistoryEvent).filter(Boolean);
  if (!rows.length) return 0;
  const [result] = await getPool().query(
    `INSERT INTO trade_event_history
      (event_key, source, source_label, symbol, asset, event_time_ms, event_time, event_type, side,
       direction, position_side, quantity, price, mark_price, notional, funding_rate, realized_pnl,
       unrealized_pnl, funding, commission, fee_asset, net, order_id, trade_id, liquidity, note,
       pnl_included, raw_type, details)
     VALUES ?
     ON DUPLICATE KEY UPDATE
      source=VALUES(source),
      source_label=VALUES(source_label),
      symbol=VALUES(symbol),
      asset=VALUES(asset),
      event_time_ms=VALUES(event_time_ms),
      event_time=VALUES(event_time),
      event_type=VALUES(event_type),
      side=VALUES(side),
      direction=VALUES(direction),
      position_side=VALUES(position_side),
      quantity=VALUES(quantity),
      price=VALUES(price),
      mark_price=VALUES(mark_price),
      notional=VALUES(notional),
      funding_rate=VALUES(funding_rate),
      realized_pnl=VALUES(realized_pnl),
      unrealized_pnl=VALUES(unrealized_pnl),
      funding=VALUES(funding),
      commission=VALUES(commission),
      fee_asset=VALUES(fee_asset),
      net=VALUES(net),
      order_id=VALUES(order_id),
      trade_id=VALUES(trade_id),
      liquidity=VALUES(liquidity),
      note=VALUES(note),
      pnl_included=VALUES(pnl_included),
      raw_type=VALUES(raw_type),
      details=VALUES(details)`,
    [rows]
  );
  return Number(result.affectedRows ?? 0);
}

function cleanTradeFilterSymbol(value) {
  return String(value ?? "").trim().toUpperCase().replace(/[^A-Z0-9:_-]/g, "").slice(0, 64);
}

function tradeSymbolCandidates(symbol) {
  const compact = cleanTradeFilterSymbol(symbol).replace(/[_-]/g, "");
  if (!compact) return [];
  const candidates = new Set([compact]);
  if (compact.endsWith("USDT") && compact.length > 4) candidates.add(compact.slice(0, -4));
  else candidates.add(`${compact}USDT`);
  return Array.from(candidates);
}

function tradeHistoryWhere({ startMs, endMs, symbol, source } = {}) {
  const where = ["event_time_ms IS NOT NULL"];
  const params = {};
  const safeStart = tradeEventTimeMs(startMs);
  const safeEnd = tradeEventTimeMs(endMs);
  if (safeStart !== null) {
    where.push("event_time_ms >= :startMs");
    params.startMs = safeStart;
  }
  if (safeEnd !== null) {
    where.push("event_time_ms <= :endMs");
    params.endMs = safeEnd;
  }
  const sourceValue = tradeNullableText(source, 32);
  if (sourceValue) {
    where.push("source = :source");
    params.source = sourceValue;
  }
  const symbols = tradeSymbolCandidates(symbol);
  if (symbols.length) {
    where.push("REPLACE(REPLACE(UPPER(symbol), '_', ''), '-', '') IN (:symbols)");
    params.symbols = symbols;
  }
  return { whereSql: `WHERE ${where.join(" AND ")}`, params };
}

function tradeAggregateSelect() {
  return `COUNT(*) AS events,
    MIN(event_time_ms) AS firstTime,
    MAX(event_time_ms) AS lastTime,
    COALESCE(SUM(CASE WHEN pnl_included=1 THEN realized_pnl ELSE 0 END), 0) AS realizedPnl,
    COALESCE(SUM(CASE WHEN pnl_included=1 THEN funding ELSE 0 END), 0) AS funding,
    COALESCE(SUM(CASE WHEN pnl_included=1 THEN commission ELSE 0 END), 0) AS commission,
    COALESCE(SUM(CASE WHEN pnl_included=1 AND commission < 0 THEN -commission ELSE 0 END), 0) AS feeCost,
    COALESCE(SUM(CASE WHEN pnl_included=1 THEN realized_pnl + funding + commission ELSE 0 END), 0) AS net,
    COALESCE(SUM(CASE WHEN pnl_included=1 THEN notional ELSE 0 END), 0) AS notional`;
}

function tradeNumberFromRow(row, key) {
  const number = Number(row?.[key]);
  return Number.isFinite(number) ? number : 0;
}

function mapTradeSummaryRow(row) {
  return {
    source: row.source ?? "",
    sourceLabel: row.sourceLabel ?? row.source_label ?? "",
    symbol: row.symbol ?? "",
    firstTime: row.firstTime === null || row.firstTime === undefined ? null : Number(row.firstTime),
    lastTime: row.lastTime === null || row.lastTime === undefined ? null : Number(row.lastTime),
    events: tradeNumberFromRow(row, "events"),
    realizedPnl: tradeNumberFromRow(row, "realizedPnl"),
    funding: tradeNumberFromRow(row, "funding"),
    commission: tradeNumberFromRow(row, "commission"),
    feeCost: tradeNumberFromRow(row, "feeCost"),
    net: tradeNumberFromRow(row, "net"),
    notional: tradeNumberFromRow(row, "notional")
  };
}

function mapTradeEventRow(row) {
  return {
    id: row.eventKey,
    source: row.source ?? "",
    sourceLabel: row.sourceLabel ?? "",
    symbol: row.symbol ?? "",
    asset: row.asset ?? "",
    time: row.time === null || row.time === undefined ? null : Number(row.time),
    type: row.type ?? "",
    side: row.side ?? "",
    direction: row.direction ?? "",
    positionSide: row.positionSide ?? "",
    quantity: row.quantity === null || row.quantity === undefined ? null : Number(row.quantity),
    price: row.price === null || row.price === undefined ? null : Number(row.price),
    markPrice: row.markPrice === null || row.markPrice === undefined ? null : Number(row.markPrice),
    notional: row.notional === null || row.notional === undefined ? null : Number(row.notional),
    fundingRate: row.fundingRate === null || row.fundingRate === undefined ? null : Number(row.fundingRate),
    realizedPnl: tradeNumberFromRow(row, "realizedPnl"),
    unrealizedPnl: tradeNumberFromRow(row, "unrealizedPnl"),
    funding: tradeNumberFromRow(row, "funding"),
    commission: tradeNumberFromRow(row, "commission"),
    feeAsset: row.feeAsset ?? "",
    net: tradeNumberFromRow(row, "net"),
    orderId: row.orderId ?? "",
    tradeId: row.tradeId ?? "",
    liquidity: row.liquidity ?? "",
    note: row.note ?? "",
    pnlIncluded: Number(row.pnlIncluded) !== 0,
    rawType: row.rawType ?? "",
    details: (() => {
      if (typeof row.details !== "string") return row.details ?? null;
      try {
        return JSON.parse(row.details);
      } catch {
        return null;
      }
    })()
  };
}

export async function readTradeEventHistoryAnalysis({
  startMs,
  endMs,
  symbol = "",
  source = "",
  page = 1,
  pageSize = 20,
  eventLimit = 100
} = {}) {
  const safePage = Math.max(1, Number(page) || 1);
  const safePageSize = Math.max(1, Math.min(100, Number(pageSize) || 20));
  const safeEventLimit = Math.max(1, Math.min(500, Number(eventLimit) || 100));
  const { whereSql, params } = tradeHistoryWhere({ startMs, endMs, symbol, source });

  const [totalRows] = await getPool().query(
    `SELECT ${tradeAggregateSelect()}
     FROM trade_event_history
     ${whereSql}`,
    params
  );
  const totals = mapTradeSummaryRow({ ...(totalRows[0] ?? {}), source: "", sourceLabel: "全部", symbol: "" });

  const [sourceRows] = await getPool().query(
    `SELECT source, COALESCE(MAX(source_label), source) AS sourceLabel, '' AS symbol,
      ${tradeAggregateSelect()}
     FROM trade_event_history
     ${whereSql}
     GROUP BY source
     ORDER BY lastTime DESC, source ASC`,
    params
  );

  const [countRows] = await getPool().query(
    `SELECT COUNT(*) AS total
     FROM (
       SELECT source, symbol
       FROM trade_event_history
       ${whereSql}
       GROUP BY source, symbol
     ) grouped`,
    params
  );
  const symbolTotal = Number(countRows[0]?.total ?? 0);
  const symbolTotalPages = Math.max(1, Math.ceil(symbolTotal / safePageSize));
  const effectivePage = Math.min(safePage, symbolTotalPages);

  const [symbolRows] = await getPool().query(
    `SELECT source, COALESCE(MAX(source_label), source) AS sourceLabel, symbol,
      ${tradeAggregateSelect()}
     FROM trade_event_history
     ${whereSql}
     GROUP BY source, symbol
     ORDER BY lastTime DESC, firstTime DESC, source ASC, symbol ASC
     LIMIT :pageSize OFFSET :offset`,
    { ...params, pageSize: safePageSize, offset: (effectivePage - 1) * safePageSize }
  );

  const [eventRows] = await getPool().query(
    `SELECT event_key AS eventKey, source, source_label AS sourceLabel, symbol, asset,
      event_time_ms AS time, event_type AS type, side, direction, position_side AS positionSide,
      quantity, price, mark_price AS markPrice, notional, funding_rate AS fundingRate,
      realized_pnl AS realizedPnl, unrealized_pnl AS unrealizedPnl, funding, commission,
      fee_asset AS feeAsset, net, order_id AS orderId, trade_id AS tradeId, liquidity, note,
      pnl_included AS pnlIncluded, raw_type AS rawType, details
     FROM trade_event_history
     ${whereSql}
     ORDER BY event_time_ms DESC, id DESC
     LIMIT :eventLimit`,
    { ...params, eventLimit: safeEventLimit }
  );

  return {
    summary: {
      totals,
      bySource: sourceRows.map(mapTradeSummaryRow),
      bySymbol: symbolRows.map(mapTradeSummaryRow)
    },
    symbolSummary: {
      total: symbolTotal,
      page: effectivePage,
      pageSize: safePageSize
    },
    events: eventRows.map(mapTradeEventRow),
    eventCount: totals.events
  };
}

export async function listOpenInterestScanTokens() {
  const [rows] = await getPool().query(
    `SELECT t.id, t.symbol, t.base_asset AS baseAsset, t.category_type AS categoryType, t.category_label AS categoryLabel,
      oi.observed_at AS observedAt
     FROM token_list t
     LEFT JOIN open_interest_monitor oi ON oi.symbol=t.symbol
     WHERE t.is_active=1
     ORDER BY
      oi.observed_at IS NULL DESC,
      oi.observed_at ASC,
      t.symbol`
  );
  return rows;
}

function normalizeOpenInterestSample(item) {
  const symbol = sanitizeDbSymbol(item?.symbol);
  const openInterest = Number(item?.openInterest ?? item?.sumOpenInterest);
  const openInterestValue = Number(item?.openInterestValue ?? item?.sumOpenInterestValue);
  const observedAt =
    item?.observedAt instanceof Date
      ? item.observedAt
      : new Date(Number(item?.observedAt ?? item?.timestamp ?? item?.time) || item?.observedAt);
  const source = item?.source === "history" ? "history" : "current";
  if (!symbol || !Number.isFinite(openInterest) || Number.isNaN(observedAt.getTime())) return null;
  return [
    symbol,
    openInterest,
    Number.isFinite(openInterestValue) ? openInterestValue : null,
    observedAt,
    source
  ];
}

export async function upsertOpenInterestSamples(samples = []) {
  const rows = (Array.isArray(samples) ? samples : [samples]).map(normalizeOpenInterestSample).filter(Boolean);
  if (!rows.length) return 0;
  const [result] = await getPool().query(
    `INSERT INTO open_interest_sample
      (symbol, open_interest, open_interest_value, observed_at, source)
     VALUES ?
     ON DUPLICATE KEY UPDATE
      open_interest=VALUES(open_interest),
      open_interest_value=COALESCE(VALUES(open_interest_value), open_interest_value),
      source=IF(source='current', source, VALUES(source))`,
    [rows]
  );
  return result.affectedRows ?? 0;
}

function mapOpenInterestBaseline(row, prefix) {
  const openInterest = row?.[`${prefix}OpenInterest`];
  if (openInterest === null || openInterest === undefined) return null;
  return {
    openInterest: Number(openInterest),
    openInterestValue:
      row[`${prefix}OpenInterestValue`] === null || row[`${prefix}OpenInterestValue`] === undefined
        ? null
        : Number(row[`${prefix}OpenInterestValue`]),
    observedAt: row[`${prefix}ObservedAt`] ?? null
  };
}

export async function getOpenInterestSampleBaselines(symbol, observedAt) {
  const safeSymbol = sanitizeDbSymbol(symbol);
  const observedDate = observedAt instanceof Date ? observedAt : new Date(Number(observedAt) || observedAt);
  if (!safeSymbol || Number.isNaN(observedDate.getTime())) {
    return { "5m": null, "15m": null, "1h": null, "4h": null, "1d": null };
  }
  const observedMs = observedDate.getTime();
  const params = {
    symbol: safeSymbol,
    target5m: new Date(observedMs - 5 * 60 * 1000),
    target15m: new Date(observedMs - 15 * 60 * 1000),
    target1h: new Date(observedMs - 60 * 60 * 1000),
    target4h: new Date(observedMs - 4 * 60 * 60 * 1000),
    target1d: new Date(observedMs - 24 * 60 * 60 * 1000)
  };
  const [rows] = await getPool().query(
    `SELECT
      (SELECT open_interest FROM open_interest_sample WHERE symbol=:symbol AND observed_at <= :target5m ORDER BY observed_at DESC LIMIT 1) AS baseline5mOpenInterest,
      (SELECT open_interest_value FROM open_interest_sample WHERE symbol=:symbol AND observed_at <= :target5m ORDER BY observed_at DESC LIMIT 1) AS baseline5mOpenInterestValue,
      (SELECT observed_at FROM open_interest_sample WHERE symbol=:symbol AND observed_at <= :target5m ORDER BY observed_at DESC LIMIT 1) AS baseline5mObservedAt,
      (SELECT open_interest FROM open_interest_sample WHERE symbol=:symbol AND observed_at <= :target15m ORDER BY observed_at DESC LIMIT 1) AS baseline15mOpenInterest,
      (SELECT open_interest_value FROM open_interest_sample WHERE symbol=:symbol AND observed_at <= :target15m ORDER BY observed_at DESC LIMIT 1) AS baseline15mOpenInterestValue,
      (SELECT observed_at FROM open_interest_sample WHERE symbol=:symbol AND observed_at <= :target15m ORDER BY observed_at DESC LIMIT 1) AS baseline15mObservedAt,
      (SELECT open_interest FROM open_interest_sample WHERE symbol=:symbol AND observed_at <= :target1h ORDER BY observed_at DESC LIMIT 1) AS baseline1hOpenInterest,
      (SELECT open_interest_value FROM open_interest_sample WHERE symbol=:symbol AND observed_at <= :target1h ORDER BY observed_at DESC LIMIT 1) AS baseline1hOpenInterestValue,
      (SELECT observed_at FROM open_interest_sample WHERE symbol=:symbol AND observed_at <= :target1h ORDER BY observed_at DESC LIMIT 1) AS baseline1hObservedAt,
      (SELECT open_interest FROM open_interest_sample WHERE symbol=:symbol AND observed_at <= :target4h ORDER BY observed_at DESC LIMIT 1) AS baseline4hOpenInterest,
      (SELECT open_interest_value FROM open_interest_sample WHERE symbol=:symbol AND observed_at <= :target4h ORDER BY observed_at DESC LIMIT 1) AS baseline4hOpenInterestValue,
      (SELECT observed_at FROM open_interest_sample WHERE symbol=:symbol AND observed_at <= :target4h ORDER BY observed_at DESC LIMIT 1) AS baseline4hObservedAt,
      (SELECT open_interest FROM open_interest_sample WHERE symbol=:symbol AND observed_at <= :target1d ORDER BY observed_at DESC LIMIT 1) AS baseline1dOpenInterest,
      (SELECT open_interest_value FROM open_interest_sample WHERE symbol=:symbol AND observed_at <= :target1d ORDER BY observed_at DESC LIMIT 1) AS baseline1dOpenInterestValue,
      (SELECT observed_at FROM open_interest_sample WHERE symbol=:symbol AND observed_at <= :target1d ORDER BY observed_at DESC LIMIT 1) AS baseline1dObservedAt`,
    params
  );
  const row = rows[0] ?? {};
  return {
    "5m": mapOpenInterestBaseline(row, "baseline5m"),
    "15m": mapOpenInterestBaseline(row, "baseline15m"),
    "1h": mapOpenInterestBaseline(row, "baseline1h"),
    "4h": mapOpenInterestBaseline(row, "baseline4h"),
    "1d": mapOpenInterestBaseline(row, "baseline1d")
  };
}

export async function getActiveTokenBySymbol(symbol) {
  const safeSymbol = sanitizeDbSymbol(symbol);
  if (!safeSymbol) return null;
  const [rows] = await getPool().query(
    `SELECT id, symbol, base_asset AS baseAsset, category_type AS categoryType, category_label AS categoryLabel
     FROM token_list
     WHERE is_active=1 AND symbol=:symbol
     LIMIT 1`,
    { symbol: safeSymbol }
  );
  return rows[0] ?? null;
}

export async function getSignalCorrelationContext(symbol) {
  const safeSymbol = sanitizeDbSymbol(symbol);
  if (!safeSymbol) {
    return {
      hotRank: false,
      fundingOneHour: false,
      multiCycleCount: 0,
      intervals: [],
      oiSpike: false,
      oiChange5mPct: null,
      oiChange1hPct: null
    };
  }
  const [signalRows] = await getPool().query(
    `SELECT interval_code AS intervalCode, alert_level AS alertLevel
     FROM signal_result
     WHERE symbol=:symbol AND alert_level IN ('LEVEL1','LEVEL2')
     ORDER BY FIELD(alert_level, 'LEVEL1', 'LEVEL2'), FIELD(interval_code, '15m', '1h', '4h', '1d')`,
    { symbol: safeSymbol }
  );
  const baseAsset = baseAssetFromSymbol(safeSymbol);
  const unscaledBaseAsset = baseAsset.replace(/^(1000000|1000)/, "");
  const [hotRows] = await getPool().query(
    `SELECT 1 AS hit
     FROM hot_rank_seen
     WHERE (symbol=:symbol OR base_asset IN (:baseAsset, :unscaledBaseAsset))
       AND last_seen_at >= DATE_SUB(NOW(3), INTERVAL :activeSeconds SECOND)
     LIMIT 1`,
    {
      symbol: safeSymbol,
      baseAsset,
      unscaledBaseAsset,
      activeSeconds: hotRankActiveSeconds()
    }
  );
  const [fundingRows] = await getPool().query(
    `SELECT 1 AS hit
     FROM funding_interval_state
     WHERE symbol=:symbol AND funding_interval_hours=1 AND source_present=1
     LIMIT 1`,
    { symbol: safeSymbol }
  );
  const [oiRows] = await getPool().query(
    `SELECT change_5m_pct AS change5mPct,
      change_1h_pct AS change1hPct,
      change_4h_pct AS change4hPct,
      change_1d_pct AS change1dPct
     FROM open_interest_monitor
     WHERE symbol=:symbol
       AND observed_at >= DATE_SUB(NOW(3), INTERVAL :activeSeconds SECOND)
     LIMIT 1`,
    { symbol: safeSymbol, activeSeconds: openInterestActiveSeconds() }
  );
  const oiSpike = evaluateOpenInterestSpike(oiRows[0], config.openInterestMonitor);
  return {
    hotRank: hotRows.length > 0,
    fundingOneHour: fundingRows.length > 0,
    multiCycleCount: signalRows.length,
    intervals: signalRows.map((row) => row.intervalCode),
    alertLevel: signalRows[0]?.alertLevel ?? null,
    oiChange5mPct: oiSpike.change5mPct,
    oiChange1hPct: oiSpike.change1hPct,
    oiChange4hPct: oiSpike.change4hPct,
    oiChange1dPct: oiSpike.change1dPct,
    oiSpike: oiSpike.hit,
    oiSpike5mHit: oiSpike.hit5m,
    oiSpike1hHit: oiSpike.hit1h,
    oiSpike4hHit: oiSpike.hit4h,
    oiSpike1dHit: oiSpike.hit1d
  };
}

function oiChangeColumn(timeWindow) {
  return {
    "5m": "change_5m_pct",
    "15m": "change_15m_pct",
    "1h": "change_1h_pct",
    "4h": "change_4h_pct",
    "1d": "change_1d_pct"
  }[timeWindow] ?? "change_5m_pct";
}

export function normalizeOptionalLimit(limit, max = 500) {
  if (limit === null || limit === undefined || limit === "") return null;
  const numeric = Number(limit);
  if (!Number.isInteger(numeric)) return null;
  return Math.max(1, Math.min(Math.max(1, Number(max) || 500), numeric));
}

function mapOpenInterestMonitorRow(row) {
  return {
    ...row,
    currentOpenInterest: row.currentOpenInterest === null ? null : Number(row.currentOpenInterest),
    currentOpenInterestValue: row.currentOpenInterestValue === null ? null : Number(row.currentOpenInterestValue),
    changePercent: row.changePercent === null ? null : Number(row.changePercent),
    change5mPct: row.change5mPct === null ? null : Number(row.change5mPct),
    change15mPct: row.change15mPct === null ? null : Number(row.change15mPct),
    change1hPct: row.change1hPct === null ? null : Number(row.change1hPct),
    change4hPct: row.change4hPct === null ? null : Number(row.change4hPct),
    change1dPct: row.change1dPct === null ? null : Number(row.change1dPct),
    currentPrice: row.currentPrice === null ? null : Number(row.currentPrice),
    currentCloseTime: row.currentCloseTime === null ? null : Number(row.currentCloseTime),
    isStale: Boolean(row.isStale),
    observedAgeSeconds: Number(row.observedAgeSeconds ?? 0),
    hotRankHit: Boolean(row.hotRankHit),
    fundingOneHour: Boolean(row.fundingOneHour),
    multiCycleCount: Number(row.multiCycleCount ?? 0),
    signalIntervals: String(row.signalIntervals ?? "")
      .split(",")
      .filter(Boolean)
  };
}

export async function upsertOpenInterestSnapshot(item) {
  const safeSymbol = sanitizeDbSymbol(item?.symbol);
  if (!safeSymbol) return false;
  await getPool().query(
    `INSERT INTO open_interest_monitor
      (symbol, current_open_interest, current_open_interest_value,
       change_5m_pct, change_15m_pct, change_1h_pct, change_4h_pct, change_1d_pct, observed_at)
     VALUES
      (:symbol, :currentOpenInterest, :currentOpenInterestValue,
       :change5mPct, :change15mPct, :change1hPct, :change4hPct, :change1dPct, :observedAt)
     ON DUPLICATE KEY UPDATE
      current_open_interest=VALUES(current_open_interest),
      current_open_interest_value=VALUES(current_open_interest_value),
      change_5m_pct=VALUES(change_5m_pct),
      change_15m_pct=VALUES(change_15m_pct),
      change_1h_pct=VALUES(change_1h_pct),
      change_4h_pct=VALUES(change_4h_pct),
      change_1d_pct=VALUES(change_1d_pct),
      observed_at=VALUES(observed_at)`,
    {
      symbol: safeSymbol,
      currentOpenInterest: item.currentOpenInterest,
      currentOpenInterestValue: item.currentOpenInterestValue,
      change5mPct: item.change5mPct,
      change15mPct: item.change15mPct,
      change1hPct: item.change1hPct,
      change4hPct: item.change4hPct,
      change1dPct: item.change1dPct,
      observedAt: new Date(Number(item.observedAt) || Date.now())
    }
  );
  return true;
}

export async function listOpenInterestMonitor({ timeWindow = "5m", sort = "desc", limit = null } = {}) {
  const column = oiChangeColumn(timeWindow);
  const direction = sort === "asc" ? "ASC" : "DESC";
  const safeLimit = normalizeOptionalLimit(limit, 500);
  const [rows] = await getPool().query(
    `SELECT oi.symbol,
      oi.current_open_interest AS currentOpenInterest,
      oi.current_open_interest_value AS currentOpenInterestValue,
      oi.${column} AS changePercent,
      oi.change_5m_pct AS change5mPct,
      oi.change_15m_pct AS change15mPct,
      oi.change_1h_pct AS change1hPct,
      oi.change_4h_pct AS change4hPct,
      oi.change_1d_pct AS change1dPct,
      (
        SELECT k.close_price
        FROM kline_cache k
        WHERE k.symbol=oi.symbol AND k.interval_code='15m'
        ORDER BY k.open_time DESC
        LIMIT 1
      ) AS currentPrice,
      (
        SELECT k.close_time
        FROM kline_cache k
        WHERE k.symbol=oi.symbol AND k.interval_code='15m'
        ORDER BY k.open_time DESC
        LIMIT 1
      ) AS currentCloseTime,
      oi.observed_at AS observedAt,
      oi.updated_at AS fetchedAt,
      oi.observed_at < DATE_SUB(NOW(3), INTERVAL :oiActiveSeconds SECOND) AS isStale,
      TIMESTAMPDIFF(SECOND, oi.observed_at, NOW(3)) AS observedAgeSeconds,
      oi.last_spike_alert_at AS lastSpikeAlertAt,
      EXISTS(
        SELECT 1 FROM hot_rank_seen h
        WHERE ${hotRankTokenMatchSql("h", "t")}
          AND h.last_seen_at >= DATE_SUB(NOW(3), INTERVAL :activeSeconds SECOND)
      ) AS hotRankHit,
      EXISTS(
        SELECT 1 FROM funding_interval_state f
        WHERE f.symbol=oi.symbol
          AND f.funding_interval_hours=1
          AND f.source_present=1
      ) AS fundingOneHour,
      (
        SELECT COUNT(DISTINCT s.interval_code)
        FROM signal_result s
        WHERE s.symbol=oi.symbol AND s.alert_level IN ('LEVEL1','LEVEL2')
      ) AS multiCycleCount,
      (
        SELECT GROUP_CONCAT(s.interval_code ORDER BY FIELD(s.interval_code, '15m','1h','4h','1d') SEPARATOR ',')
        FROM signal_result s
        WHERE s.symbol=oi.symbol AND s.alert_level IN ('LEVEL1','LEVEL2')
      ) AS signalIntervals
     FROM open_interest_monitor oi
     JOIN token_list t ON t.symbol=oi.symbol AND t.is_active=1
     WHERE oi.${column} IS NOT NULL
     ORDER BY oi.${column} ${direction}, oi.observed_at DESC, oi.symbol
     ${safeLimit === null ? "" : "LIMIT :limit"}`
    ,
    { activeSeconds: hotRankActiveSeconds(), oiActiveSeconds: openInterestActiveSeconds(), limit: safeLimit }
  );
  return rows.map(mapOpenInterestMonitorRow);
}

export async function listOpenInterestMonitorPage({
  timeWindow = "5m",
  sort = "desc",
  page = 1,
  pageSize = 20
} = {}) {
  const safePage = Math.max(1, Number(page) || 1);
  const safePageSize = Math.max(1, Math.min(100, Number(pageSize) || 20));
  const column = oiChangeColumn(timeWindow);
  const direction = sort === "asc" ? "ASC" : "DESC";
  const [countRows] = await getPool().query(
    `SELECT COUNT(*) AS total
     FROM open_interest_monitor oi
     JOIN token_list t ON t.symbol=oi.symbol AND t.is_active=1
     WHERE oi.${column} IS NOT NULL`
  );
  const total = Number(countRows[0]?.total ?? 0);
  const totalPages = Math.max(1, Math.ceil(total / safePageSize));
  const effectivePage = Math.min(safePage, totalPages);
  const params = {
    activeSeconds: hotRankActiveSeconds(),
    oiActiveSeconds: openInterestActiveSeconds(),
    pageSize: safePageSize,
    offset: (effectivePage - 1) * safePageSize
  };
  const [rows] = await getPool().query(
    `SELECT oi.symbol,
      oi.current_open_interest AS currentOpenInterest,
      oi.current_open_interest_value AS currentOpenInterestValue,
      oi.${column} AS changePercent,
      oi.change_5m_pct AS change5mPct,
      oi.change_15m_pct AS change15mPct,
      oi.change_1h_pct AS change1hPct,
      oi.change_4h_pct AS change4hPct,
      oi.change_1d_pct AS change1dPct,
      (
        SELECT k.close_price
        FROM kline_cache k
        WHERE k.symbol=oi.symbol AND k.interval_code='15m'
        ORDER BY k.open_time DESC
        LIMIT 1
      ) AS currentPrice,
      (
        SELECT k.close_time
        FROM kline_cache k
        WHERE k.symbol=oi.symbol AND k.interval_code='15m'
        ORDER BY k.open_time DESC
        LIMIT 1
      ) AS currentCloseTime,
      oi.observed_at AS observedAt,
      oi.observed_at < DATE_SUB(NOW(3), INTERVAL :oiActiveSeconds SECOND) AS isStale,
      TIMESTAMPDIFF(SECOND, oi.observed_at, NOW(3)) AS observedAgeSeconds,
      oi.last_spike_alert_at AS lastSpikeAlertAt,
      EXISTS(
        SELECT 1 FROM hot_rank_seen h
        WHERE ${hotRankTokenMatchSql("h", "t")}
          AND h.last_seen_at >= DATE_SUB(NOW(3), INTERVAL :activeSeconds SECOND)
      ) AS hotRankHit,
      EXISTS(
        SELECT 1 FROM funding_interval_state f
        WHERE f.symbol=oi.symbol
          AND f.funding_interval_hours=1
          AND f.source_present=1
      ) AS fundingOneHour,
      (
        SELECT COUNT(DISTINCT s.interval_code)
        FROM signal_result s
        WHERE s.symbol=oi.symbol AND s.alert_level IN ('LEVEL1','LEVEL2')
      ) AS multiCycleCount,
      (
        SELECT GROUP_CONCAT(s.interval_code ORDER BY FIELD(s.interval_code, '15m','1h','4h','1d') SEPARATOR ',')
        FROM signal_result s
        WHERE s.symbol=oi.symbol AND s.alert_level IN ('LEVEL1','LEVEL2')
      ) AS signalIntervals
     FROM open_interest_monitor oi
     JOIN token_list t ON t.symbol=oi.symbol AND t.is_active=1
     WHERE oi.${column} IS NOT NULL
     ORDER BY oi.${column} ${direction}, oi.observed_at DESC, oi.symbol
     LIMIT :pageSize OFFSET :offset`,
    params
  );
  return {
    data: rows.map(mapOpenInterestMonitorRow),
    total,
    page: effectivePage,
    pageSize: safePageSize
  };
}

export async function listTopOpenInterestRealtimeTokens({ timeWindow = "5m", sort = "desc", limit = 5 } = {}) {
  const column = oiChangeColumn(timeWindow);
  const direction = sort === "asc" ? "ASC" : "DESC";
  const safeLimit = Math.max(1, Math.min(20, Number(limit) || 5));
  const [rows] = await getPool().query(
    `SELECT t.*
     FROM open_interest_monitor oi
     JOIN token_list t ON t.symbol=oi.symbol AND t.is_active=1
     WHERE oi.${column} IS NOT NULL
     ORDER BY oi.${column} ${direction}, oi.observed_at DESC, oi.symbol
     LIMIT :limit`,
    { limit: safeLimit }
  );
  return rows;
}

export async function getOpenInterestMonitorItem(symbol) {
  const safeSymbol = sanitizeDbSymbol(symbol);
  if (!safeSymbol) return null;
  const [rows] = await getPool().query(
    `SELECT symbol,
      change_5m_pct AS change5mPct,
      change_1h_pct AS change1hPct,
      change_4h_pct AS change4hPct,
      change_1d_pct AS change1dPct,
      observed_at AS observedAt,
      last_spike_alert_at AS lastSpikeAlertAt,
      last_spike_alert_signature AS lastSpikeAlertSignature
     FROM open_interest_monitor
     WHERE symbol=:symbol
     LIMIT 1`,
    { symbol: safeSymbol }
  );
  const row = rows[0];
  if (!row) return null;
  return {
    ...row,
    change5mPct: row.change5mPct === null ? null : Number(row.change5mPct),
    change1hPct: row.change1hPct === null ? null : Number(row.change1hPct),
    change4hPct: row.change4hPct === null ? null : Number(row.change4hPct),
    change1dPct: row.change1dPct === null ? null : Number(row.change1dPct)
  };
}

export async function markOpenInterestSpikeAlertSent(symbol, alertState = {}) {
  const safeSymbol = sanitizeDbSymbol(symbol);
  if (!safeSymbol) return 0;
  const signature = alertState.signature ? String(alertState.signature).slice(0, 255) : null;
  const alertAtUpdate = alertState.preserveAlertAt ? "last_spike_alert_at=last_spike_alert_at" : "last_spike_alert_at=NOW(3)";
  const [result] = await getPool().query(
    `UPDATE open_interest_monitor
     SET ${alertAtUpdate},
         last_spike_alert_signature=:signature
     WHERE symbol=:symbol`,
    { symbol: safeSymbol, signature }
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
  const latestClosedOpenTime = latestClosedKlineOpenTime(intervalCode);
  const [rows] = await getPool().query(
    `SELECT closePrice, closeTime
     FROM (
       SELECT close_price AS closePrice, close_time AS closeTime, open_time
       FROM kline_cache
       WHERE symbol=:symbol AND interval_code=:intervalCode
         AND open_time<=:latestClosedOpenTime
       ORDER BY open_time DESC
       LIMIT 200
     ) recent
     ORDER BY open_time ASC`,
    { symbol, intervalCode, latestClosedOpenTime }
  );
  return rows.map((row) => ({
    close: Number(row.closePrice),
    closeTime: Number(row.closeTime)
  }));
}

export async function selectPreviousSignals(symbol) {
  const safeSymbol = sanitizeDbSymbol(symbol);
  if (!safeSymbol) return new Map();
  const [rows] = await getPool().query(
    "SELECT * FROM signal_result WHERE symbol=:symbol",
    { symbol: safeSymbol }
  );
  return new Map(rows.map((row) => [row.interval_code, row]));
}

export async function upsertSignals(token, signals) {
  const normalized = (signals ?? []).filter((signal) => signal?.intervalCode);
  if (!normalized.length) return 0;
  const rows = normalized.map((signal) => [
    token.id,
    token.symbol,
    token.category_type,
    signal.intervalCode,
    signal.ma100,
    signal.ma200,
    signal.currentPrice,
    signal.alertLevel,
    signal.proximityPct,
    signal.signalWeight,
    signal.signalStatus,
    signal.note,
    new Date(Number(signal.signalTime) || Date.now())
  ]);
  const [result] = await getPool().query(
    `INSERT INTO signal_result
      (token_id, symbol, category_type, interval_code, ma100, ma200, current_price, alert_level, proximity_pct, signal_weight, signal_status, note, signal_time)
     VALUES ?
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
      alert_level=VALUES(alert_level)`,
    [rows]
  );
  return result.affectedRows ?? 0;
}

export async function upsertSignal(token, signal) {
  return upsertSignals(token, [signal]);
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

function hotRankActiveSeconds() {
  return Math.max(60, Math.floor(config.hotRank.activeMs / 1000));
}

function openInterestActiveSeconds() {
  return Math.max(60, Math.floor(config.openInterestMonitor.activeMs / 1000));
}

function hotRankTokenMatchSql(hotAlias, tokenAlias) {
  return `(
    ${hotAlias}.symbol=${tokenAlias}.symbol
    OR ${hotAlias}.base_asset=${tokenAlias}.base_asset
    OR (${tokenAlias}.base_asset LIKE '1000%' AND ${hotAlias}.base_asset=SUBSTRING(${tokenAlias}.base_asset, 5))
    OR (${hotAlias}.base_asset LIKE '1000%' AND ${tokenAlias}.base_asset=SUBSTRING(${hotAlias}.base_asset, 5))
    OR (${tokenAlias}.base_asset LIKE '1000000%' AND ${hotAlias}.base_asset=SUBSTRING(${tokenAlias}.base_asset, 8))
    OR (${hotAlias}.base_asset LIKE '1000000%' AND ${tokenAlias}.base_asset=SUBSTRING(${hotAlias}.base_asset, 8))
  )`;
}

function hotRankHitSql(tokenAlias, activeSecondsParam = "hotRankActiveSeconds") {
  return `EXISTS(
    SELECT 1
    FROM hot_rank_seen h
    WHERE ${hotRankTokenMatchSql("h", tokenAlias)}
      AND h.last_seen_at >= DATE_SUB(NOW(3), INTERVAL :${activeSecondsParam} SECOND)
  )`;
}

function hotRankValueSql(tokenAlias, expression, activeSecondsParam = "hotRankActiveSeconds") {
  return `(
    SELECT ${expression}
    FROM hot_rank_seen h
    WHERE ${hotRankTokenMatchSql("h", tokenAlias)}
      AND h.last_seen_at >= DATE_SUB(NOW(3), INTERVAL :${activeSecondsParam} SECOND)
  )`;
}

function hotRankSignalMatchSql(hotAlias, signalAlias) {
  const baseAsset = `REPLACE(${signalAlias}.symbol, 'USDT', '')`;
  return `(
    ${hotAlias}.symbol=${signalAlias}.symbol
    OR ${hotAlias}.base_asset=${baseAsset}
    OR (${baseAsset} LIKE '1000%' AND ${hotAlias}.base_asset=SUBSTRING(${baseAsset}, 5))
    OR (${hotAlias}.base_asset LIKE '1000%' AND ${baseAsset}=SUBSTRING(${hotAlias}.base_asset, 5))
    OR (${baseAsset} LIKE '1000000%' AND ${hotAlias}.base_asset=SUBSTRING(${baseAsset}, 8))
    OR (${hotAlias}.base_asset LIKE '1000000%' AND ${baseAsset}=SUBSTRING(${hotAlias}.base_asset, 8))
  )`;
}

export async function getSignalGroupsPage({ categories, levels, intervals, page = 1, pageSize = 20 }) {
  const safeCategories = normalizeList(categories, SIGNAL_CATEGORIES);
  const safeLevels = normalizeList(levels, SIGNAL_LEVELS);
  const safeIntervals = normalizeList(intervals, SIGNAL_INTERVALS);
  const safePageSize = Math.max(1, Math.min(100, Number(pageSize) || 20));
  const safePage = Math.max(1, Number(page) || 1);
  if (!safeCategories.length || !safeLevels.length || !safeIntervals.length) {
    return { signals: [], total: 0, page: safePage, pageSize: safePageSize };
  }

  const whereSql = `s.category_type IN (${quotedList(safeCategories)})
    AND s.alert_level IN (${quotedList(safeLevels)})
    AND s.interval_code IN (${quotedList(safeIntervals)})
    AND t.is_active=1`;
  const alarmLevels = safeLevels.filter((level) => ["LEVEL1", "LEVEL2"].includes(level));
  const multiJoinSql = alarmLevels.length
    ? `LEFT JOIN (
      SELECT s2.symbol,
        COUNT(DISTINCT s2.interval_code) AS multiMatchCount,
        MIN(CASE s2.alert_level WHEN 'LEVEL1' THEN 0 WHEN 'LEVEL2' THEN 1 ELSE 2 END) AS bestAlertRank
      FROM signal_result s2
      JOIN token_list t2 ON t2.id=s2.token_id
      WHERE s2.category_type IN (${quotedList(safeCategories)})
        AND s2.alert_level IN (${quotedList(alarmLevels)})
        AND s2.interval_code IN (${quotedList(safeIntervals)})
        AND t2.is_active=1
      GROUP BY s2.symbol
    ) mp ON mp.symbol=s.symbol`
    : "LEFT JOIN (SELECT NULL AS symbol, 0 AS multiMatchCount, 2 AS bestAlertRank) mp ON mp.symbol=s.symbol";
  const fundingBitSql =
    "IF(EXISTS(SELECT 1 FROM funding_interval_state f WHERE f.symbol=s.symbol AND f.funding_interval_hours=1 AND f.source_present=1), 8, 0)";
  const oiBitSql =
    `IF(EXISTS(
      SELECT 1 FROM open_interest_monitor oi
      WHERE oi.symbol=s.symbol
        AND oi.observed_at >= DATE_SUB(NOW(3), INTERVAL :oiActiveSeconds SECOND)
        AND (
          oi.change_5m_pct >= :oiSpike5mPct
          OR oi.change_1h_pct >= :oiSpike1hPct
          OR oi.change_4h_pct >= :oiSpike4hPct
          OR oi.change_1d_pct >= :oiSpike1dPct
        )
    ), 4, 0)`;
  const hotBitSql = `IF(EXISTS(
    SELECT 1 FROM hot_rank_seen h
    WHERE ${hotRankSignalMatchSql("h", "s")}
      AND h.last_seen_at >= DATE_SUB(NOW(3), INTERVAL :activeSeconds SECOND)
  ), 2, 0)`;
  const multiBitSql = "IF(COALESCE(mp.multiMatchCount, 0) >= 3, 1, 0)";
  const sourceMaskSql = `(${fundingBitSql} + ${oiBitSql} + ${hotBitSql} + ${multiBitSql})`;
  const bestAlertRankSql = "COALESCE(mp.bestAlertRank, 2)";
  const groupSql = `
    SELECT s.symbol,
      MIN(t.category_type) AS categoryType,
      MIN(t.category_label) AS categoryLabel,
      COUNT(DISTINCT s.interval_code) AS matchingIntervalCount,
      COALESCE(mp.multiMatchCount, 0) AS multiMatchCount,
      ${sourceMaskSql} AS sourceMask,
      MAX(s.updated_at) AS latestUpdatedAt,
      MIN(CASE s.alert_level WHEN 'LEVEL1' THEN 0 WHEN 'LEVEL2' THEN 1 WHEN 'NONE' THEN 2 ELSE 3 END) AS bestLevelRank,
      MAX(s.signal_weight) AS bestWeight,
      CASE
        WHEN ${bestAlertRankSql} > 1 THEN 99
        WHEN ${sourceMaskSql} > 0 THEN (15 - ${sourceMaskSql}) * 2 + ${bestAlertRankSql}
        WHEN ${bestAlertRankSql}=0 THEN 30
        WHEN ${bestAlertRankSql}=1 THEN 31
        ELSE 99
      END AS priorityRank,
      'COMPOSITE' AS displayKind
    FROM signal_result s
    JOIN token_list t ON t.id=s.token_id
    ${multiJoinSql}
    WHERE ${whereSql}
    GROUP BY s.symbol, mp.multiMatchCount, mp.bestAlertRank
    HAVING sourceMask > 0`;
  const standaloneMaAlertExistsSql = alarmLevels.length
    ? `EXISTS(
        SELECT 1 FROM signal_result sx
        JOIN token_list tx ON tx.id=sx.token_id
        WHERE sx.symbol=t.symbol
          AND sx.category_type IN (${quotedList(safeCategories)})
          AND sx.alert_level IN (${quotedList(alarmLevels)})
          AND sx.interval_code IN (${quotedList(safeIntervals)})
          AND tx.is_active=1
      )`
    : "0";
  const standaloneOiSql = `
    SELECT t.symbol,
      t.category_type AS categoryType,
      t.category_label AS categoryLabel,
      0 AS matchingIntervalCount,
      0 AS multiMatchCount,
      4 AS sourceMask,
      oi.observed_at AS latestUpdatedAt,
      2 AS bestLevelRank,
      0 AS bestWeight,
      ${SIGNAL_PRIORITY.STANDALONE} AS priorityRank,
      'STANDALONE' AS displayKind
    FROM token_list t
    JOIN open_interest_monitor oi
      ON oi.symbol=t.symbol
      AND oi.observed_at >= DATE_SUB(NOW(3), INTERVAL :oiActiveSeconds SECOND)
      AND (
        oi.change_5m_pct >= :oiSpike5mPct
        OR oi.change_1h_pct >= :oiSpike1hPct
        OR oi.change_4h_pct >= :oiSpike4hPct
        OR oi.change_1d_pct >= :oiSpike1dPct
      )
    WHERE t.category_type IN (${quotedList(safeCategories)})
      AND t.is_active=1
      AND NOT ${standaloneMaAlertExistsSql}`;
  const candidateSql = `${groupSql}\nUNION ALL\n${standaloneOiSql}`;
  const [countRows] = await getPool().query(
    `SELECT COUNT(*) AS total FROM (${candidateSql}) grouped`,
    {
      activeSeconds: hotRankActiveSeconds(),
      oiActiveSeconds: openInterestActiveSeconds(),
      oiSpike5mPct: config.openInterestMonitor.spike5mPct,
      oiSpike1hPct: config.openInterestMonitor.spike1hPct,
      oiSpike4hPct: config.openInterestMonitor.spike4hPct,
      oiSpike1dPct: config.openInterestMonitor.spike1dPct
    }
  );
  const [symbolRows] = await getPool().query(
    `${candidateSql}
     ORDER BY
      priorityRank,
      bestLevelRank,
      bestWeight DESC,
      latestUpdatedAt DESC,
      symbol
     LIMIT :pageSize OFFSET :offset`,
    {
      pageSize: safePageSize,
      offset: (safePage - 1) * safePageSize,
      activeSeconds: hotRankActiveSeconds(),
      oiActiveSeconds: openInterestActiveSeconds(),
      oiSpike5mPct: config.openInterestMonitor.spike5mPct,
      oiSpike1hPct: config.openInterestMonitor.spike1hPct,
      oiSpike4hPct: config.openInterestMonitor.spike4hPct,
      oiSpike1dPct: config.openInterestMonitor.spike1dPct
    }
  );
  const symbols = symbolRows.map((row) => sanitizeDbSymbol(row.symbol)).filter(Boolean);
  const uniqueSymbols = [...new Set(symbols)];
  if (!symbols.length) {
    return {
      signals: [],
      total: Number(countRows[0]?.total ?? 0),
      page: safePage,
      pageSize: safePageSize
    };
  }

  const [rows] = await getPool().query(
    `SELECT s.symbol, s.category_type AS categoryType, t.category_label AS categoryLabel,
      s.interval_code AS intervalCode, s.alert_level AS alertLevel, s.ma100, s.ma200,
      s.current_price AS currentPrice, s.proximity_pct AS proximityPct, s.signal_weight AS signalWeight,
      s.signal_status AS signalStatus, s.note, s.signal_time AS signalTime, s.updated_at AS updatedAt
     FROM signal_result s
     JOIN token_list t ON t.id=s.token_id
     WHERE s.symbol IN (${quotedList(uniqueSymbols)})
       AND t.is_active=1
       AND s.category_type IN (${quotedList(safeCategories)})
       AND s.interval_code IN (${quotedList(safeIntervals)})
     ORDER BY FIELD(s.interval_code, '15m', '1h', '4h', '1d')`
  );
  const [hotRows] = await getPool().query(
    `SELECT t.symbol, MIN(h.last_seen_rank) AS hotRank
     FROM hot_rank_seen h
     JOIN token_list t ON ${hotRankTokenMatchSql("h", "t")}
     WHERE t.symbol IN (${quotedList(uniqueSymbols)})
       AND t.is_active=1
       AND h.last_seen_at >= DATE_SUB(NOW(3), INTERVAL :activeSeconds SECOND)
     GROUP BY t.symbol`,
    { activeSeconds: hotRankActiveSeconds() }
  );
  const [oiRows] = await getPool().query(
    `SELECT symbol,
      change_5m_pct AS oiChange5mPct,
      change_1h_pct AS oiChange1hPct,
      change_4h_pct AS oiChange4hPct,
      change_1d_pct AS oiChange1dPct
     FROM open_interest_monitor
     WHERE symbol IN (${quotedList(uniqueSymbols)})
       AND observed_at >= DATE_SUB(NOW(3), INTERVAL :activeSeconds SECOND)`,
    { activeSeconds: openInterestActiveSeconds() }
  );
  const [fundingRows] = await getPool().query(
    `SELECT symbol
     FROM funding_interval_state
     WHERE symbol IN (${quotedList(uniqueSymbols)})
       AND funding_interval_hours=1
       AND source_present=1`
  );
  const hotBySymbol = new Map(hotRows.map((row) => [row.symbol, row]));
  const oiBySymbol = new Map(oiRows.map((row) => [row.symbol, row]));
  const fundingSymbols = new Set(fundingRows.map((row) => row.symbol));
  const rowsBySymbol = new Map();
  for (const row of rows) {
    if (!rowsBySymbol.has(row.symbol)) rowsBySymbol.set(row.symbol, []);
    rowsBySymbol.get(row.symbol).push(row);
  }
  const signals = symbolRows.map((meta, index) => {
    const symbol = sanitizeDbSymbol(meta.symbol);
    const isStandalone = meta.displayKind === "STANDALONE";
    const metaSourceMask = Number(meta.sourceMask ?? 0);
    const rawDetails = rowsBySymbol.get(symbol) ?? [];
    const matchingDetails = isStandalone
      ? rawDetails.map((row) => ({ ...row, alertLevel: "NONE" }))
      : rawDetails.filter((row) => safeLevels.includes(row.alertLevel));
    const representative =
      matchingDetails.find((row) => row.alertLevel === "LEVEL1") ??
      matchingDetails.find((row) => row.alertLevel === "LEVEL2") ??
      matchingDetails[0] ??
      {
        symbol,
        categoryType: meta.categoryType ?? null,
        categoryLabel: meta.categoryLabel ?? "",
        intervalCode: safeIntervals[0] ?? null,
        alertLevel: "NONE",
        ma100: null,
        ma200: null,
        currentPrice: null,
        proximityPct: null,
        signalWeight: 0,
        signalStatus: "independent",
        note: "资金费率/OI 独立命中",
        signalTime: meta.latestUpdatedAt ?? null,
        updatedAt: meta.latestUpdatedAt ?? null
      };
    const hot = hotBySymbol.get(symbol);
    const oi = oiBySymbol.get(symbol);
    const triggeredDetails = isStandalone ? [] : matchingDetails.filter((row) => ["LEVEL1", "LEVEL2"].includes(row.alertLevel));
    const bestAlertLevel = isStandalone ? null : resolveBestAlertLevel(triggeredDetails);
    const oiSpike = evaluateOpenInterestSpike(
      {
        change5mPct: oi?.oiChange5mPct,
        change1hPct: oi?.oiChange1hPct,
        change4hPct: oi?.oiChange4hPct,
        change1dPct: oi?.oiChange1dPct
      },
      config.openInterestMonitor
    );
    const oiMatched = isStandalone ? metaSourceMask === 4 && oiSpike.hit : oiSpike.hit;
    const fundingOneHour = isStandalone ? metaSourceMask === 8 : fundingSymbols.has(symbol);
    const oiSpikeHit = oiMatched;
    const compositeProfile = resolveSignalProfile({
      fundingOneHour,
      oiMatched,
      hotRank: Boolean(hot),
      multiCycleCount: triggeredDetails.length,
      alertLevel: bestAlertLevel
    });
    return {
      ...representative,
      symbol,
      bestAlertLevel,
      intervals: triggeredDetails.map((row) => row.intervalCode),
      intervalDetails: matchingDetails,
      multiMatchCount: triggeredDetails.length,
      multiMatchRequired: 3,
      displayKind: meta.displayKind ?? "COMPOSITE",
      displayKey: `${symbol}:${meta.displayKind ?? "COMPOSITE"}:${metaSourceMask || "MA"}:${index}`,
      sourceMask: metaSourceMask,
      hotRankHit: hot ? 1 : 0,
      hotRank: hot?.hotRank ?? null,
      fundingOneHour,
      oiChange5mPct: oiSpike.change5mPct,
      oiChange1hPct: oiSpike.change1hPct,
      oiChange4hPct: oiSpike.change4hPct,
      oiChange1dPct: oiSpike.change1dPct,
      oiMatched,
      oiSpikeHit,
      oiSpike5mHit: oiSpike.hit5m,
      oiSpike1hHit: oiSpike.hit1h,
      oiSpike4hHit: oiSpike.hit4h,
      oiSpike1dHit: oiSpike.hit1d,
      compositeProfile
    };
  });
  return {
    signals,
    total: Number(countRows[0]?.total ?? 0),
    page: safePage,
    pageSize: safePageSize
  };
}

export async function getMultiCycleSignalsPage({ categories, levels, intervals, page = 1, pageSize = 4 }) {
  const safeCategories = normalizeList(categories, SIGNAL_CATEGORIES);
  const safeLevels = normalizeList(levels, SIGNAL_LEVELS).filter((level) => ["LEVEL1", "LEVEL2"].includes(level));
  const safeIntervals = normalizeList(intervals, SIGNAL_INTERVALS);
  const safePageSize = Math.max(1, Math.min(10, Number(pageSize) || 4));
  const safePage = Math.max(1, Number(page) || 1);
  const offset = (safePage - 1) * safePageSize;
  const multiRequired = safeIntervals.length > 1 && safeLevels.length > 0 ? Math.min(3, safeIntervals.length) : 0;

  if (safeCategories.length === 0 || safeLevels.length === 0 || safeIntervals.length === 0 || multiRequired < 2) {
    return { groups: [], total: 0, page: safePage, pageSize: safePageSize, multiMatchRequired: multiRequired };
  }

  const groupWhereSql = `s.category_type IN (${quotedList(safeCategories)})
    AND s.alert_level IN (${quotedList(safeLevels)})
    AND s.interval_code IN (${quotedList(safeIntervals)})
    AND t.is_active=1`;

  const groupSql = `
    SELECT
      s.symbol,
      COUNT(DISTINCT s.interval_code) AS multiMatchCount,
      MIN(CASE s.alert_level WHEN 'LEVEL1' THEN 0 WHEN 'LEVEL2' THEN 1 ELSE 3 END) AS bestLevelRank,
      MAX(s.signal_weight) AS bestWeight,
      MAX(s.updated_at) AS latestUpdatedAt
    FROM signal_result s
    JOIN token_list t ON t.id=s.token_id
    WHERE ${groupWhereSql}
    GROUP BY s.symbol
    HAVING COUNT(DISTINCT s.interval_code) >= :multiRequired`;

  const [countRows] = await getPool().query(`SELECT COUNT(*) AS total FROM (${groupSql}) m`, { multiRequired });
  const [symbolRows] = await getPool().query(
    `${groupSql}
     ORDER BY bestLevelRank, multiMatchCount DESC, bestWeight DESC, latestUpdatedAt DESC, symbol
     LIMIT :pageSize OFFSET :offset`,
    { multiRequired, pageSize: safePageSize, offset }
  );

  const symbols = symbolRows.map((row) => String(row.symbol ?? "").toUpperCase().replace(/[^A-Z0-9_]/g, "")).filter(Boolean);
  if (!symbols.length) {
    return {
      groups: [],
      total: Number(countRows[0]?.total ?? 0),
      page: safePage,
      pageSize: safePageSize,
      multiMatchRequired: multiRequired
    };
  }

  const [rows] = await getPool().query(
    `SELECT s.symbol, s.category_type AS categoryType, t.category_label AS categoryLabel,
      s.interval_code AS intervalCode, s.alert_level AS alertLevel, s.ma100, s.ma200,
      s.current_price AS currentPrice, s.proximity_pct AS proximityPct, s.signal_weight AS signalWeight,
      s.signal_status AS signalStatus, s.note, s.signal_time AS signalTime, s.updated_at AS updatedAt
     FROM signal_result s
     JOIN token_list t ON t.id=s.token_id
     WHERE s.symbol IN (${quotedList(symbols)})
       AND ${groupWhereSql}
     ORDER BY
      CASE s.interval_code WHEN '15m' THEN 0 WHEN '1h' THEN 1 WHEN '4h' THEN 2 WHEN '1d' THEN 3 ELSE 4 END,
      CASE s.alert_level WHEN 'LEVEL1' THEN 0 WHEN 'LEVEL2' THEN 1 ELSE 3 END,
      s.signal_weight DESC`
  );

  const rowsBySymbol = new Map();
  for (const row of rows) {
    if (!rowsBySymbol.has(row.symbol)) rowsBySymbol.set(row.symbol, []);
    rowsBySymbol.get(row.symbol).push(row);
  }

  return {
    groups: symbolRows.map((row) => ({
      symbol: row.symbol,
      multiMatchCount: Number(row.multiMatchCount ?? 0),
      multiMatchRequired: multiRequired,
      rows: rowsBySymbol.get(row.symbol) ?? []
    })),
    total: Number(countRows[0]?.total ?? 0),
    page: safePage,
    pageSize: safePageSize,
    multiMatchRequired: multiRequired
  };
}

export async function getHotMaSignalsPage({ categories = "A,B", levels = "LEVEL1,LEVEL2", intervals = "15m,1h,4h,1d", page = 1, pageSize = 6 } = {}) {
  const safeCategories = normalizeList(categories, SIGNAL_CATEGORIES);
  const safeLevels = normalizeList(levels, SIGNAL_LEVELS).filter((level) => ["LEVEL1", "LEVEL2"].includes(level));
  const safeIntervals = normalizeList(intervals, SIGNAL_INTERVALS);
  const safePageSize = Math.max(1, Math.min(20, Number(pageSize) || 6));
  const safePage = Math.max(1, Number(page) || 1);
  const offset = (safePage - 1) * safePageSize;

  if (safeCategories.length === 0 || safeLevels.length === 0 || safeIntervals.length === 0) {
    return { signals: [], total: 0, page: safePage, pageSize: safePageSize };
  }

  const whereSql = `s.category_type IN (${quotedList(safeCategories)})
    AND s.alert_level IN (${quotedList(safeLevels)})
    AND s.interval_code IN (${quotedList(safeIntervals)})
    AND t.is_active=1
    AND ${hotRankHitSql("t")}`;

  const params = {
    hotRankActiveSeconds: hotRankActiveSeconds(),
    pageSize: safePageSize,
    offset
  };
  const [countRows] = await getPool().query(
    `SELECT COUNT(*) AS total
     FROM signal_result s
     JOIN token_list t ON t.id=s.token_id
     WHERE ${whereSql}`,
    params
  );
  const [rows] = await getPool().query(
    `SELECT s.symbol, s.category_type AS categoryType, t.category_label AS categoryLabel,
      s.interval_code AS intervalCode, s.alert_level AS alertLevel, s.ma100, s.ma200,
      s.current_price AS currentPrice, s.proximity_pct AS proximityPct, s.signal_weight AS signalWeight,
      s.signal_status AS signalStatus, s.note, s.signal_time AS signalTime, s.updated_at AS updatedAt,
      ${hotRankValueSql("t", "MIN(h.last_seen_rank)")} AS hotRank,
      ${hotRankValueSql("t", "MAX(h.last_seen_at)")} AS hotRankLastSeenAt
     FROM signal_result s
     JOIN token_list t ON t.id=s.token_id
     WHERE ${whereSql}
     ORDER BY
      CASE s.alert_level WHEN 'LEVEL1' THEN 0 WHEN 'LEVEL2' THEN 1 ELSE 2 END,
      hotRank ASC,
      s.signal_weight DESC,
      s.updated_at DESC
     LIMIT :pageSize OFFSET :offset`,
    params
  );
  return {
    signals: rows,
    total: Number(countRows[0]?.total ?? 0),
    page: safePage,
    pageSize: safePageSize
  };
}

export async function selectHotMaSignalAlert(symbol, intervalCode) {
  const safeSymbol = sanitizeDbSymbol(symbol);
  if (!safeSymbol) return null;
  const [rows] = await getPool().query(
    `SELECT symbol, interval_code AS intervalCode, alert_level AS alertLevel, signal_time AS signalTime,
      profile_key AS profileKey, source_mask AS sourceMask, context_signature AS contextSignature, sent_at AS sentAt
     FROM hot_ma_signal_alert
     WHERE symbol=:symbol AND interval_code=:intervalCode
     LIMIT 1`,
    { symbol: safeSymbol, intervalCode }
  );
  return rows[0] ?? null;
}

export async function markHotMaSignalAlertSent(symbol, intervalCode, signal, alertState = {}) {
  const safeSymbol = sanitizeDbSymbol(symbol);
  if (!safeSymbol || !["LEVEL1", "LEVEL2"].includes(signal?.alertLevel)) return;
  const signalTime = Number(signal.signalTime ?? Date.now());
  const profileKey = alertState.profileKey ? String(alertState.profileKey).slice(0, 80) : null;
  const sourceMask = Number.isFinite(Number(alertState.sourceMask)) ? Number(alertState.sourceMask) : 0;
  const contextSignature = alertState.contextSignature ? String(alertState.contextSignature).slice(0, 255) : null;
  const sentAtUpdate = alertState.preserveSentAt ? "sent_at=sent_at" : "sent_at=NOW(3)";
  await getPool().query(
    `INSERT INTO hot_ma_signal_alert
      (symbol, interval_code, alert_level, signal_time, profile_key, source_mask, context_signature, sent_at)
     VALUES
      (:symbol, :intervalCode, :alertLevel, FROM_UNIXTIME(:signalTime / 1000), :profileKey, :sourceMask, :contextSignature, NOW(3))
     ON DUPLICATE KEY UPDATE
      alert_level=VALUES(alert_level),
      signal_time=VALUES(signal_time),
      profile_key=VALUES(profile_key),
      source_mask=VALUES(source_mask),
      context_signature=VALUES(context_signature),
      ${sentAtUpdate}`,
    { symbol: safeSymbol, intervalCode, alertLevel: signal.alertLevel, signalTime, profileKey, sourceMask, contextSignature }
  );
}

export async function recordMultiCycleHistory(token, signals, required = 2) {
  const hits = (signals ?? [])
    .filter(({ signal }) => ["LEVEL1", "LEVEL2"].includes(signal.alertLevel))
    .sort((a, b) => SIGNAL_INTERVALS_ORDER.indexOf(a.intervalCode) - SIGNAL_INTERVALS_ORDER.indexOf(b.intervalCode));
  if (hits.length < required) return false;
  const bestAlertLevel = hits.some(({ signal }) => signal.alertLevel === "LEVEL1") ? "LEVEL1" : "LEVEL2";
  const intervals = hits.map(({ intervalCode }) => intervalCode).join(",");
  await getPool().query(
    `INSERT INTO multi_cycle_history
      (symbol, base_asset, category_label, multi_match_count, intervals, best_alert_level)
     VALUES (:symbol, :baseAsset, :categoryLabel, :multiMatchCount, :intervals, :bestAlertLevel)
     ON DUPLICATE KEY UPDATE
      category_label=VALUES(category_label),
      last_triggered_at=NOW(3),
      multi_match_count=VALUES(multi_match_count),
      intervals=VALUES(intervals),
      best_alert_level=VALUES(best_alert_level)`,
    {
      symbol: sanitizeDbSymbol(token.symbol),
      baseAsset: baseAssetFromSymbol(token.symbol),
      categoryLabel: String(token.category_label ?? token.categoryLabel ?? "").slice(0, 80),
      multiMatchCount: hits.length,
      intervals,
      bestAlertLevel
    }
  );
  return true;
}

const SIGNAL_INTERVALS_ORDER = ["15m", "1h", "4h", "1d"];

export async function listMultiCycleHistory({ limit = 50 } = {}) {
  const safeLimit = Math.max(1, Math.min(200, Number(limit) || 50));
  const [rows] = await getPool().query(
    `SELECT symbol, base_asset AS baseAsset, category_label AS categoryLabel,
      first_triggered_at AS firstTriggeredAt, last_triggered_at AS lastTriggeredAt,
      multi_match_count AS multiMatchCount, intervals, best_alert_level AS bestAlertLevel
     FROM multi_cycle_history
     ORDER BY last_triggered_at DESC, multi_match_count DESC, symbol
     LIMIT :limit`,
    { limit: safeLimit }
  );
  return rows.map((row) => ({
    ...row,
    multiMatchCount: Number(row.multiMatchCount ?? 0)
  }));
}

function rollingAverage(rows, index, size) {
  if (index + 1 < size) return null;
  let sum = 0;
  for (let offset = index - size + 1; offset <= index; offset += 1) {
    sum += rows[offset].close;
  }
  return Number((sum / size).toFixed(12));
}

function collectKlineGaps(rows, intervalCode) {
  const safeIntervalMs = intervalMs(intervalCode);
  const gaps = [];
  let previous = null;
  for (const row of rows) {
    if (previous) {
      const missingCount = Math.round((row.openTime - previous.openTime) / safeIntervalMs) - 1;
      if (missingCount > 0) {
        gaps.push({
          startTime: previous.openTime + safeIntervalMs,
          endTime: row.openTime - safeIntervalMs,
          missingCount
        });
      }
    }
    previous = row;
  }
  return gaps;
}

export async function getKlines({ symbol, intervalCode, limit = 240 }) {
  const safeSymbol = String(symbol ?? "").toUpperCase().replace(/[^A-Z0-9_]/g, "");
  const allRows = limit === "all";
  const expectedCount = Math.max(200, Number(config.crawler.retentionLimits[intervalCode]) || 200);
  const safeIntervalMs = intervalMs(intervalCode);
  const currentSlotOpenTime = Math.floor(Date.now() / safeIntervalMs) * safeIntervalMs;
  const latestExpectedOpenTime = currentSlotOpenTime - safeIntervalMs;
  const safeLimit = allRows
    ? Math.max(200, Math.min(20_000, expectedCount))
    : Math.max(50, Math.min(1000, Number(limit) || 240));
  const expandedLimit = allRows ? safeLimit : safeLimit + 199;
  const [rows] = await getPool().query(
    `SELECT open_time AS openTime, close_time AS closeTime,
      open_price AS openPrice, high_price AS highPrice, low_price AS lowPrice,
      close_price AS closePrice, volume
     FROM (
      SELECT *
      FROM kline_cache
      WHERE symbol=:symbol AND interval_code=:intervalCode
        AND open_time<:currentSlotOpenTime
      ORDER BY open_time DESC
      LIMIT :expandedLimit
     ) recent
     ORDER BY open_time ASC`,
    { symbol: safeSymbol, intervalCode, currentSlotOpenTime, expandedLimit }
  );
  const [currentRows] = await getPool().query(
    `SELECT open_time AS openTime, close_time AS closeTime,
      open_price AS openPrice, high_price AS highPrice, low_price AS lowPrice,
      close_price AS closePrice, volume
     FROM kline_cache
     WHERE symbol=:symbol AND interval_code=:intervalCode
       AND open_time=:currentSlotOpenTime
     LIMIT 1`,
    { symbol: safeSymbol, intervalCode, currentSlotOpenTime }
  );

  const normalizeRow = (row) => ({
    openTime: Number(row.openTime),
    closeTime: Number(row.closeTime),
    open: Number(row.openPrice),
    high: Number(row.highPrice),
    low: Number(row.lowPrice),
    close: Number(row.closePrice),
    volume: Number(row.volume)
  });

  const normalized = rows.map(normalizeRow);
  const currentKline = currentRows[0] ? { ...normalizeRow(currentRows[0]), isOpen: true } : null;
  const maSource = currentKline ? [...normalized, currentKline] : normalized;
  const gaps = collectKlineGaps(normalized, intervalCode);
  const gapStartTimes = new Set(gaps.map((gap) => gap.endTime + intervalMs(intervalCode)));
  const withMa = normalized.map((row, index) => ({
    ...row,
    gapBefore: gapStartTimes.has(row.openTime),
    ma100: rollingAverage(maSource, index, 100),
    ma200: rollingAverage(maSource, index, 200)
  }));
  const currentWithMa = currentKline
    ? {
        ...currentKline,
        gapBefore: normalized.at(-1)
          ? Math.round((currentKline.openTime - Number(normalized.at(-1).openTime)) / safeIntervalMs) > 1
          : false,
        ma100: rollingAverage(maSource, maSource.length - 1, 100),
        ma200: rollingAverage(maSource, maSource.length - 1, 200)
      }
    : null;
  const klines = allRows
    ? [...withMa, currentWithMa].filter(Boolean)
    : [...withMa.slice(-safeLimit), currentWithMa].filter(Boolean);
  const visibleStart = klines[0]?.openTime ?? null;
  const visibleEnd = klines.at(-1)?.openTime ?? null;
  const visibleGaps = gaps.filter((gap) =>
    visibleStart !== null &&
    visibleEnd !== null &&
    gap.endTime >= visibleStart &&
    gap.startTime <= visibleEnd
  );
  const staleBeforeOpenTime = latestExpectedOpenTime;
  const latestOpenTime = withMa.at(-1)?.openTime ?? null;
  const isStale = latestOpenTime === null || latestOpenTime < staleBeforeOpenTime;
  const availability = await getKlineAvailabilityMap([safeSymbol]);
  const firstAvailableOpenTime = availability.get(`${safeSymbol}|${intervalCode}`) ?? null;
  const naturalHistoryShortfall = isNaturalKlineHistoryShortfall({
    cachedCount: withMa.length,
    expectedCount,
    earliestOpenTime: withMa[0]?.openTime ?? null,
    firstAvailableOpenTime,
    targetStartTime: latestExpectedOpenTime - (expectedCount - 1) * safeIntervalMs,
    intervalMsValue: safeIntervalMs
  });
  const hasCoverageShortfall = withMa.length < expectedCount && !naturalHistoryShortfall;
  const needsRefresh = isStale || hasCoverageShortfall || gaps.length > 0;

  return {
    symbol: safeSymbol,
    intervalCode,
    limit: allRows ? "all" : safeLimit,
    expectedCount,
    cachedCount: withMa.length,
    coveragePercent: Number(Math.min(100, (withMa.length / expectedCount) * 100).toFixed(2)),
    earliestOpenTime: withMa[0]?.openTime ?? null,
    latestOpenTime,
    currentSlotOpenTime,
    currentKlineOpenTime: currentWithMa?.openTime ?? null,
    hasCurrentKline: Boolean(currentWithMa),
    firstAvailableOpenTime,
    naturalHistoryShortfall,
    latestExpectedOpenTime,
    staleBeforeOpenTime,
    isStale,
    needsRefresh,
    refreshReason: needsRefresh
      ? [
          isStale ? "stale_latest" : null,
          hasCoverageShortfall ? "coverage_shortfall" : null,
          gaps.length > 0 ? "gap" : null
        ].filter(Boolean).join(",")
      : null,
    hasMa200: withMa.length >= 200,
    gapCount: visibleGaps.length,
    missingKlineCount: visibleGaps.reduce((sum, gap) => sum + gap.missingCount, 0),
    gaps: visibleGaps,
    klines
  };
}

function sanitizeDbSymbol(value) {
  return String(value ?? "").toUpperCase().replace(/[^A-Z0-9_]/g, "").slice(0, 32);
}

function baseAssetFromSymbol(symbol) {
  return sanitizeDbSymbol(symbol).replace(/USDT$/, "");
}

export function normalizeWatchlistAlertPrice(value, fieldName) {
  if (value === "" || value === null || value === undefined) return null;
  const price = Number(value);
  if (!Number.isFinite(price) || price <= 0) {
    throw new Error(`${fieldName} must be a positive number`);
  }
  return price;
}

export function normalizeWatchlistPayload({ symbol, note = "", alertAbove = null, alertBelow = null, alertEnabled = true } = {}) {
  const safeSymbol = sanitizeDbSymbol(symbol);
  if (!safeSymbol) throw new Error("symbol is required");
  const above = normalizeWatchlistAlertPrice(alertAbove, "alertAbove");
  const below = normalizeWatchlistAlertPrice(alertBelow, "alertBelow");
  if (above !== null && below !== null && above <= below) {
    throw new Error("alertAbove must be greater than alertBelow");
  }
  const enabled = alertEnabled === false || alertEnabled === "false" || alertEnabled === 0 || alertEnabled === "0" ? 0 : 1;
  return {
    symbol: safeSymbol,
    baseAsset: baseAssetFromSymbol(safeSymbol),
    note: String(note ?? "").slice(0, 255),
    alertAbove: above,
    alertBelow: below,
    alertEnabled: enabled
  };
}

function normalizeHotRankToken(token) {
  const symbol = sanitizeDbSymbol(token?.symbol);
  const baseAsset = baseAssetFromSymbol(symbol);
  if (!symbol || !baseAsset) return null;
  const rank = Math.max(1, Number(token?.rank) || 0);
  const heat = Number(token?.heat);
  return {
    symbol,
    baseAsset,
    chainLabel: String(token?.chainLabel ?? "").slice(0, 32),
    rank,
    heat: Number.isFinite(heat) ? heat : null
  };
}

function preferHotRankToken(current, candidate) {
  if (!current) return candidate;
  if (candidate.rank !== current.rank) return candidate.rank < current.rank ? candidate : current;
  if ((candidate.heat ?? -Infinity) !== (current.heat ?? -Infinity)) {
    return (candidate.heat ?? -Infinity) > (current.heat ?? -Infinity) ? candidate : current;
  }
  return candidate.chainLabel.localeCompare(current.chainLabel) < 0 ? candidate : current;
}

export function normalizeHotRankSeenTokens(tokens) {
  const bySymbol = new Map();
  for (const token of tokens ?? []) {
    const normalized = normalizeHotRankToken(token);
    if (!normalized) continue;
    bySymbol.set(normalized.symbol, preferHotRankToken(bySymbol.get(normalized.symbol), normalized));
  }
  return Array.from(bySymbol.values()).sort((a, b) => a.rank - b.rank || a.symbol.localeCompare(b.symbol));
}

function normalizeHotRankSnapshotTokens(tokens) {
  const byKey = new Map();
  for (const token of tokens ?? []) {
    const normalized = normalizeHotRankToken(token);
    if (!normalized) continue;
    const key = `${normalized.symbol}\0${normalized.chainLabel}`;
    byKey.set(key, preferHotRankToken(byKey.get(key), normalized));
  }
  return Array.from(byKey.values()).sort((a, b) => a.rank - b.rank || a.symbol.localeCompare(b.symbol));
}

export async function recordHotRankSnapshot(tokens) {
  const normalized = normalizeHotRankSeenTokens(tokens);
  const snapshotTokens = normalizeHotRankSnapshotTokens(tokens);
  if (!normalized.length) return [];

  const [existingRows] = await getPool().query("SELECT symbol FROM hot_rank_seen WHERE symbol IN (?)", [
    normalized.map((token) => token.symbol)
  ]);
  const existing = new Set(existingRows.map((row) => row.symbol));
  const freshTokens = normalized.filter((token) => !existing.has(token.symbol));

  const rows = normalized.map((token) => [token.symbol, token.baseAsset, token.chainLabel, token.rank, token.rank]);
  const snapshotTime = new Date(Math.floor(Date.now() / (5 * 60 * 1000)) * 5 * 60 * 1000);
  const snapshotRows = snapshotTokens.map((token) => [
    token.symbol,
    token.baseAsset,
    token.chainLabel,
    token.rank,
    token.heat,
    snapshotTime
  ]);
  await Promise.all([
    getPool().query(
      `INSERT INTO hot_rank_seen
        (symbol, base_asset, chain_label, first_seen_rank, last_seen_rank)
       VALUES ?
       ON DUPLICATE KEY UPDATE
        base_asset=VALUES(base_asset),
        chain_label=VALUES(chain_label),
        last_seen_rank=VALUES(last_seen_rank),
        last_seen_at=NOW(3)`,
      [rows]
    ),
    getPool().query(
      `INSERT INTO hot_rank_snapshot
        (symbol, base_asset, chain_label, rank_value, heat_value, snapshot_time)
       VALUES ?
       ON DUPLICATE KEY UPDATE
        base_asset=VALUES(base_asset),
        rank_value=VALUES(rank_value),
        heat_value=VALUES(heat_value)`,
      [snapshotRows]
    )
  ]);

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
      w.alert_enabled AS alertEnabled, w.last_alert_at AS lastAlertAt, w.last_alert_side AS lastAlertSide,
      w.current_price AS realtimePrice, UNIX_TIMESTAMP(w.current_price_time) * 1000 AS realtimePriceTime,
      w.created_at AS createdAt, w.updated_at AS updatedAt,
      t.category_label AS categoryLabel,
      (
        SELECT k.interval_code FROM kline_cache k
        WHERE k.symbol=w.symbol
        ORDER BY FIELD(k.interval_code, '15m', '1h', '4h', '1d'), k.open_time DESC LIMIT 1
      ) AS latestInterval,
      COALESCE(w.current_price, (
        SELECT k.close_price FROM kline_cache k
        WHERE k.symbol=w.symbol
        ORDER BY FIELD(k.interval_code, '15m', '1h', '4h', '1d'), k.open_time DESC LIMIT 1
      )) AS currentPrice,
      COALESCE(UNIX_TIMESTAMP(w.current_price_time) * 1000, (
        SELECT k.close_time FROM kline_cache k
        WHERE k.symbol=w.symbol
        ORDER BY FIELD(k.interval_code, '15m', '1h', '4h', '1d'), k.open_time DESC LIMIT 1
      )) AS currentCloseTime,
      u.next_unlock_at AS nextUnlockAt,
      u.unlock_amount AS unlockAmount,
      u.unlock_percent AS unlockPercent,
      u.provider AS unlockProvider,
      u.source_url AS unlockSourceUrl,
      u.status AS unlockStatus,
      u.error_message AS unlockError,
      u.checked_at AS unlockCheckedAt,
      u.expires_at AS unlockExpiresAt
     FROM watchlist w
     LEFT JOIN token_list t ON t.symbol=w.symbol
     LEFT JOIN token_unlock_cache u ON u.symbol=w.symbol
     ORDER BY w.updated_at DESC`
  );
  return rows.map((row) => ({
    ...row,
    alertEnabled: Boolean(row.alertEnabled),
    alertAbove: row.alertAbove === null || row.alertAbove === undefined ? null : Number(row.alertAbove),
    alertBelow: row.alertBelow === null || row.alertBelow === undefined ? null : Number(row.alertBelow),
    realtimePrice: row.realtimePrice === null || row.realtimePrice === undefined ? null : Number(row.realtimePrice),
    realtimePriceTime:
      row.realtimePriceTime === null || row.realtimePriceTime === undefined ? null : Number(row.realtimePriceTime),
    currentPrice: row.currentPrice === null || row.currentPrice === undefined ? null : Number(row.currentPrice),
    currentCloseTime:
      row.currentCloseTime === null || row.currentCloseTime === undefined ? null : Number(row.currentCloseTime),
    unlockAmount: row.unlockAmount === null || row.unlockAmount === undefined ? null : Number(row.unlockAmount),
    unlockPercent: row.unlockPercent === null || row.unlockPercent === undefined ? null : Number(row.unlockPercent)
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

export async function listRealtimeKlineTokens() {
  const [rows] = await getPool().query(
    `SELECT DISTINCT t.*
     FROM token_list t
     WHERE t.is_active=1
       AND (
         EXISTS(SELECT 1 FROM watchlist w WHERE w.symbol=t.symbol)
         OR EXISTS(
           SELECT 1
           FROM signal_result s
           LEFT JOIN (
             SELECT symbol, COUNT(DISTINCT interval_code) AS multiMatchCount
             FROM signal_result
             WHERE alert_level IN ('LEVEL1','LEVEL2')
             GROUP BY symbol
           ) mp ON mp.symbol=s.symbol
           WHERE s.symbol=t.symbol
             AND s.alert_level IN ('LEVEL1','LEVEL2')
             AND (
               COALESCE(mp.multiMatchCount, 0) >= 3
               OR EXISTS(
                 SELECT 1 FROM funding_interval_state f
                 WHERE f.symbol=s.symbol
                   AND f.funding_interval_hours=1
                   AND f.source_present=1
               )
               OR EXISTS(
                 SELECT 1 FROM open_interest_monitor oi
                 WHERE oi.symbol=s.symbol
                   AND oi.observed_at >= DATE_SUB(NOW(3), INTERVAL :oiActiveSeconds SECOND)
                   AND (
                     oi.change_5m_pct >= :oiSpike5mPct
                     OR oi.change_1h_pct >= :oiSpike1hPct
                     OR oi.change_4h_pct >= :oiSpike4hPct
                     OR oi.change_1d_pct >= :oiSpike1dPct
                   )
               )
               OR EXISTS(
                 SELECT 1 FROM hot_rank_seen h
                 WHERE ${hotRankTokenMatchSql("h", "t")}
                   AND h.last_seen_at >= DATE_SUB(NOW(3), INTERVAL :hotRankActiveSeconds SECOND)
               )
             )
         )
       )
     ORDER BY t.symbol`,
    {
      oiActiveSeconds: openInterestActiveSeconds(),
      oiSpike5mPct: config.openInterestMonitor.spike5mPct,
      oiSpike1hPct: config.openInterestMonitor.spike1hPct,
      oiSpike4hPct: config.openInterestMonitor.spike4hPct,
      oiSpike1dPct: config.openInterestMonitor.spike1dPct,
      hotRankActiveSeconds: hotRankActiveSeconds()
    }
  );
  return rows;
}

export async function listWatchlistUnlockTargets({ expiredOnly = false } = {}) {
  const [rows] = await getPool().query(
    `SELECT w.symbol, w.base_asset AS baseAsset
     FROM watchlist w
     LEFT JOIN token_unlock_cache u ON u.symbol=w.symbol
     ${expiredOnly ? "WHERE u.symbol IS NULL OR u.expires_at <= NOW(3)" : ""}
     ORDER BY COALESCE(u.checked_at, '1970-01-01') ASC, w.symbol`
  );
  return rows;
}

export async function getTokenUnlockCache(symbol) {
  const safeSymbol = sanitizeDbSymbol(symbol);
  if (!safeSymbol) return null;
  const [rows] = await getPool().query(
    `SELECT symbol, base_asset AS baseAsset, next_unlock_at AS nextUnlockAt,
      unlock_amount AS unlockAmount, unlock_percent AS unlockPercent,
      provider, source_url AS sourceUrl, status, error_message AS error,
      checked_at AS checkedAt, expires_at AS expiresAt
     FROM token_unlock_cache
     WHERE symbol=:symbol
     LIMIT 1`,
    { symbol: safeSymbol }
  );
  const row = rows[0];
  if (!row) return null;
  return {
    ...row,
    unlockAmount: row.unlockAmount === null ? null : Number(row.unlockAmount),
    unlockPercent: row.unlockPercent === null ? null : Number(row.unlockPercent)
  };
}

export async function upsertTokenUnlockCache(item) {
  const symbol = sanitizeDbSymbol(item?.symbol);
  if (!symbol) throw new Error("symbol is required");
  const baseAsset = sanitizeDbSymbol(item?.baseAsset || baseAssetFromSymbol(symbol));
  const allowedStatuses = new Set(["available", "none", "undated", "unconfigured", "error"]);
  const status = allowedStatuses.has(item?.status) ? item.status : "error";
  const unlockAmount = item?.unlockAmount === null || item?.unlockAmount === undefined
    ? null
    : Number(item.unlockAmount);
  const unlockPercent = item?.unlockPercent === null || item?.unlockPercent === undefined
    ? null
    : Number(item.unlockPercent);
  const checkedAt = item?.checkedAt instanceof Date ? item.checkedAt : new Date(item?.checkedAt || Date.now());
  const expiresAt = item?.expiresAt instanceof Date
    ? item.expiresAt
    : new Date(item?.expiresAt || checkedAt.getTime() + config.unlock.cacheMs);
  await getPool().query(
    `INSERT INTO token_unlock_cache
      (symbol, base_asset, next_unlock_at, unlock_amount, unlock_percent, provider,
       source_url, status, error_message, raw_payload, checked_at, expires_at)
     VALUES
      (:symbol, :baseAsset, :nextUnlockAt, :unlockAmount, :unlockPercent, :provider,
       :sourceUrl, :status, :error, :rawPayload, :checkedAt, :expiresAt)
     ON DUPLICATE KEY UPDATE
      base_asset=VALUES(base_asset),
      next_unlock_at=VALUES(next_unlock_at),
      unlock_amount=VALUES(unlock_amount),
      unlock_percent=VALUES(unlock_percent),
      provider=VALUES(provider),
      source_url=VALUES(source_url),
      status=VALUES(status),
      error_message=VALUES(error_message),
      raw_payload=VALUES(raw_payload),
      checked_at=VALUES(checked_at),
      expires_at=VALUES(expires_at)`,
    {
      symbol,
      baseAsset,
      nextUnlockAt: item?.nextUnlockAt || null,
      unlockAmount: Number.isFinite(unlockAmount) ? unlockAmount : null,
      unlockPercent: Number.isFinite(unlockPercent) ? unlockPercent : null,
      provider: String(item?.provider || config.unlock.provider).slice(0, 32),
      sourceUrl: item?.sourceUrl ? String(item.sourceUrl).slice(0, 512) : null,
      status,
      error: item?.error ? String(item.error).slice(0, 500) : null,
      rawPayload: item?.rawPayload === undefined ? null : JSON.stringify(item.rawPayload),
      checkedAt,
      expiresAt
    }
  );
  return getTokenUnlockCache(symbol);
}

export async function upsertWatchlistItem({ symbol, note = "", alertAbove = null, alertBelow = null, alertEnabled = true }) {
  const normalized = normalizeWatchlistPayload({ symbol, note, alertAbove, alertBelow, alertEnabled });
  await getPool().query(
    `INSERT INTO watchlist (symbol, base_asset, note, alert_above, alert_below, alert_enabled)
     VALUES (:symbol, :baseAsset, :note, :alertAbove, :alertBelow, :alertEnabled)
     ON DUPLICATE KEY UPDATE
      note=VALUES(note),
      alert_above=VALUES(alert_above),
      alert_below=VALUES(alert_below),
      alert_enabled=VALUES(alert_enabled),
      last_alert_side=NULL,
      updated_at=NOW()`,
    {
      symbol: normalized.symbol,
      baseAsset: normalized.baseAsset,
      note: normalized.note,
      alertAbove: normalized.alertAbove,
      alertBelow: normalized.alertBelow,
      alertEnabled: normalized.alertEnabled
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

export async function updateWatchlistRealtimePrice(symbol, price, eventTime = Date.now()) {
  const safeSymbol = sanitizeDbSymbol(symbol);
  const safePrice = Number(price);
  const safeEventTime = Number(eventTime);
  if (!safeSymbol || !Number.isFinite(safePrice)) return 0;
  const priceTime = new Date(Number.isFinite(safeEventTime) ? safeEventTime : Date.now());
  const [result] = await getPool().query(
    `UPDATE watchlist
     SET current_price=:price, current_price_time=:priceTime, updated_at=updated_at
     WHERE symbol=:symbol`,
    { symbol: safeSymbol, price: safePrice, priceTime }
  );
  return result.affectedRows ?? 0;
}

export async function markWatchlistAlertSent(symbol, side = null) {
  const safeSymbol = sanitizeDbSymbol(symbol);
  if (!safeSymbol) return;
  const safeSide = side === "above" || side === "below" ? side : null;
  await getPool().query(
    "UPDATE watchlist SET last_alert_at=NOW(3), last_alert_side=:side WHERE symbol=:symbol",
    { symbol: safeSymbol, side: safeSide }
  );
}

export async function clearWatchlistAlertSide(symbol) {
  const safeSymbol = sanitizeDbSymbol(symbol);
  if (!safeSymbol) return 0;
  const [result] = await getPool().query(
    "UPDATE watchlist SET last_alert_side=NULL WHERE symbol=:symbol AND last_alert_side IS NOT NULL",
    { symbol: safeSymbol }
  );
  return result.affectedRows ?? 0;
}
