import mysql from "mysql2/promise";
import { config } from "../config.js";

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
    market_cap DECIMAL(38,12) NULL,
    market_cap_updated_at DATETIME(3) NULL,
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
  `CREATE TABLE IF NOT EXISTS price_change_1m_kline (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    token_id BIGINT UNSIGNED NOT NULL,
    symbol VARCHAR(32) NOT NULL,
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
    UNIQUE KEY uk_price_change_1m_symbol_time (symbol, open_time),
    KEY idx_price_change_1m_token_time (token_id, open_time),
    KEY idx_price_change_1m_open_time (open_time),
    CONSTRAINT fk_price_change_1m_token FOREIGN KEY (token_id) REFERENCES token_list(id) ON DELETE CASCADE
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
      await migrationConnection.query("DROP TABLE IF EXISTS signal_trigger_history");
      await ensureTokenListPolicyColumn();
      await ensureTokenListActiveColumn();
      await ensureTokenListMarketCapColumns();
      await ensureTokenListInactiveSinceColumn();
      await ensureWatchlistRealtimeColumns();
      await ensureFundingRateColumns();
      await ensureFundingAlertConfirmationColumns();
      await ensureTokenUnlockStatusSchema();
      await ensureHotMaSignalAlertSchema();
      await ensureOpenInterestAlertSchema();
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

async function ensureTokenListMarketCapColumns() {
  if (!(await columnExists("token_list", "market_cap"))) {
    await pool.query("ALTER TABLE token_list ADD COLUMN market_cap DECIMAL(38,12) NULL AFTER is_alpha");
  }
  if (!(await columnExists("token_list", "market_cap_updated_at"))) {
    await pool.query("ALTER TABLE token_list ADD COLUMN market_cap_updated_at DATETIME(3) NULL AFTER market_cap");
  }
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
  await ensureIndex("price_change_1m_kline", "idx_price_change_1m_token_time", "(token_id, open_time)");
  await ensureIndex("price_change_1m_kline", "idx_price_change_1m_open_time", "(open_time)");
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
