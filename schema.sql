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
  KEY idx_hot_rank_last_seen (last_seen_at)
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
  symbol VARCHAR(32) NOT NULL,
  trigger_type ENUM('MA_SIGNAL', 'HOT_RANK', 'FUNDING_RATE', 'IO_SPIKE', 'COMPOSITE') NOT NULL,
  intervals_triggered VARCHAR(100),
  signal_level VARCHAR(20),
  trigger_time DATETIME NOT NULL,
  details JSON,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_symbol_time (symbol, trigger_time DESC),
  KEY idx_trigger_type_time (trigger_type, trigger_time DESC)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 资金费率代币表
CREATE TABLE IF NOT EXISTS funding_rate_tokens (
  id INT PRIMARY KEY AUTO_INCREMENT,
  symbol VARCHAR(32) NOT NULL UNIQUE,
  funding_interval VARCHAR(50),
  next_settlement_time DATETIME,
  is_1hour BOOLEAN,
  last_check_at DATETIME,
  KEY idx_1hour_check (is_1hour, last_check_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- IO监控表
CREATE TABLE IF NOT EXISTS io_monitoring (
  id INT PRIMARY KEY AUTO_INCREMENT,
  symbol VARCHAR(32) NOT NULL,
  time_window VARCHAR(20),
  spike_value DECIMAL(18,8),
  spike_percent DECIMAL(10,2),
  spike_time DATETIME,
  telegram_sent_at DATETIME NULL,
  KEY idx_window_value (time_window, spike_value DESC, spike_time DESC),
  KEY idx_symbol_window_time (symbol, time_window, spike_time DESC)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 添加优化索引
ALTER TABLE signal_result ADD INDEX IF NOT EXISTS idx_symbol_interval_time (symbol, interval_code, signal_time DESC);
ALTER TABLE signal_result ADD INDEX IF NOT EXISTS idx_alert_level_weight (alert_level, signal_weight DESC, signal_time DESC);
ALTER TABLE kline_cache ADD INDEX IF NOT EXISTS idx_symbol_interval_time (symbol, interval_code, open_time DESC);
ALTER TABLE hot_rank_seen ADD INDEX IF NOT EXISTS idx_last_seen (last_seen_at DESC);
ALTER TABLE token_list ADD INDEX IF NOT EXISTS idx_fetch_status (fetch_status, updated_at);
