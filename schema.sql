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
