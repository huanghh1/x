CREATE DATABASE IF NOT EXISTS binance_ma_monitor
  CHARACTER SET utf8mb4
  COLLATE utf8mb4_unicode_ci;

USE binance_ma_monitor;

CREATE TABLE IF NOT EXISTS token_list (
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
  KEY idx_token_base_active (base_asset, is_active, updated_at),
  KEY idx_token_inactive_since (is_active, inactive_since)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS kline_cache (
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
  CONSTRAINT fk_kline_token FOREIGN KEY (token_id) REFERENCES token_list(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS signal_result (
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
  KEY idx_signal_filter_page (category_type, alert_level, interval_code, updated_at, symbol),
  KEY idx_signal_symbol_time (symbol, signal_time),
  CONSTRAINT fk_signal_token FOREIGN KEY (token_id) REFERENCES token_list(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS maintenance_state (
  task_name VARCHAR(64) NOT NULL,
  last_run_at DATETIME(3) NULL,
  last_result TEXT NULL,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (task_name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS hot_rank_seen (
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
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS watchlist (
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
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uk_watch_symbol (symbol),
  KEY idx_watch_enabled (alert_enabled, updated_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS hot_ma_signal_alert (
  symbol VARCHAR(32) NOT NULL,
  interval_code ENUM('15m','1h','4h','1d') NOT NULL,
  alert_level ENUM('LEVEL1','LEVEL2') NOT NULL,
  signal_time DATETIME(3) NOT NULL,
  sent_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (symbol, interval_code),
  KEY idx_hot_ma_sent_at (sent_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS multi_cycle_history (
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
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS funding_interval_state (
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
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (symbol),
  KEY idx_funding_interval_hours (funding_interval_hours, one_hour_alerted_at),
  KEY idx_funding_last_changed (last_changed_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 触发历史记录表
CREATE TABLE IF NOT EXISTS signal_trigger_history (
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
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- OI（Open Interest，持仓量）监控表
CREATE TABLE IF NOT EXISTS open_interest_monitor (
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
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (symbol),
  KEY idx_oi_observed (observed_at),
  KEY idx_oi_5m (change_5m_pct, observed_at),
  KEY idx_oi_15m (change_15m_pct, observed_at),
  KEY idx_oi_1h (change_1h_pct, observed_at),
  KEY idx_oi_4h (change_4h_pct, observed_at),
  KEY idx_oi_1d (change_1d_pct, observed_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS hot_rank_snapshot (
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
  KEY idx_hot_snapshot_chain_time (chain_label, snapshot_time, rank_value),
  KEY idx_hot_snapshot_symbol_time (symbol, snapshot_time)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS token_unlock_cache (
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
  KEY idx_unlock_expiry (expires_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
