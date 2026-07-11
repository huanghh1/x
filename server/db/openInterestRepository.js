import { config } from "../config.js";
import { evaluateOpenInterestSpike } from "../openInterestSpike.js";
import { getPool } from "./connection.js";
import { baseAssetFromSymbol, sanitizeDbSymbol } from "./symbols.js";

function hotRankActiveSeconds() {
  return Math.max(60, Math.floor(config.hotRank.activeMs / 1000));
}

function openInterestActiveSeconds() {
  return Math.max(60, Math.floor(config.openInterestMonitor.activeMs / 1000));
}

const OPEN_INTEREST_CATEGORIES = new Set(["A", "B"]);

export function normalizeOpenInterestCategories(categories) {
  if (categories === undefined || categories === null) return [...OPEN_INTEREST_CATEGORIES];
  const values = Array.isArray(categories) ? categories : String(categories).split(",");
  return [...new Set(values.map((value) => String(value).trim().toUpperCase()))]
    .filter((value) => OPEN_INTEREST_CATEGORIES.has(value));
}

function openInterestCategorySql(categories, tokenAlias = "t") {
  const safeCategories = normalizeOpenInterestCategories(categories);
  if (!safeCategories.length) return "0";
  return `${tokenAlias}.category_type IN (${safeCategories.map((category) => `'${category}'`).join(",")})`;
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

const OPEN_INTEREST_BASELINE_WINDOWS = [
  ["5m", 5 * 60 * 1000],
  ["15m", 15 * 60 * 1000],
  ["1h", 60 * 60 * 1000],
  ["4h", 4 * 60 * 60 * 1000],
  ["1d", 24 * 60 * 60 * 1000]
];
const OPEN_INTEREST_BASELINE_LAG_MS = 5 * 60 * 1000;

function emptyOpenInterestBaselines() {
  return Object.fromEntries(OPEN_INTEREST_BASELINE_WINDOWS.map(([window]) => [window, null]));
}

function mapOpenInterestSampleBaseline(row) {
  const openInterest = row?.openInterest;
  if (openInterest === null || openInterest === undefined) return null;
  const normalizedOpenInterest = Number(openInterest);
  const normalizedOpenInterestValue = Number(row.openInterestValue);
  const observedAt = row.observedAt ?? null;
  const observedMs = observedAt instanceof Date ? observedAt.getTime() : new Date(observedAt).getTime();
  if (!Number.isFinite(normalizedOpenInterest) || !Number.isFinite(observedMs)) return null;
  return {
    openInterest: normalizedOpenInterest,
    openInterestValue: Number.isFinite(normalizedOpenInterestValue) ? normalizedOpenInterestValue : null,
    observedAt,
    observedMs
  };
}

export function selectOpenInterestSampleBaselines(rows = [], observedAt) {
  const observedDate = observedAt instanceof Date ? observedAt : new Date(Number(observedAt) || observedAt);
  const output = emptyOpenInterestBaselines();
  if (Number.isNaN(observedDate.getTime())) return output;

  const sortedRows = (Array.isArray(rows) ? rows : [])
    .map(mapOpenInterestSampleBaseline)
    .filter(Boolean)
    .sort((a, b) => b.observedMs - a.observedMs);
  const observedMs = observedDate.getTime();
  for (const [window, duration] of OPEN_INTEREST_BASELINE_WINDOWS) {
    const targetMs = observedMs - duration;
    const baseline = sortedRows.find(
      (row) => row.observedMs <= targetMs && targetMs - row.observedMs < OPEN_INTEREST_BASELINE_LAG_MS
    );
    if (baseline) {
      output[window] = {
        openInterest: baseline.openInterest,
        openInterestValue: baseline.openInterestValue,
        observedAt: baseline.observedAt
      };
    }
  }
  return output;
}

export async function getOpenInterestSampleBaselines(symbol, observedAt) {
  const safeSymbol = sanitizeDbSymbol(symbol);
  const observedDate = observedAt instanceof Date ? observedAt : new Date(Number(observedAt) || observedAt);
  if (!safeSymbol || Number.isNaN(observedDate.getTime())) {
    return emptyOpenInterestBaselines();
  }
  const observedMs = observedDate.getTime();
  const params = { symbol: safeSymbol };
  for (const [window, duration] of OPEN_INTEREST_BASELINE_WINDOWS) {
    const key = window.replace(/\W/g, "");
    const targetMs = observedMs - duration;
    params[`target${key}`] = new Date(targetMs);
    params[`min${key}`] = new Date(targetMs - OPEN_INTEREST_BASELINE_LAG_MS);
  }
  const [rows] = await getPool().query(
    `(SELECT open_interest AS openInterest,
       open_interest_value AS openInterestValue,
       observed_at AS observedAt
      FROM open_interest_sample
      WHERE symbol=:symbol AND observed_at <= :target5m AND observed_at > :min5m
      ORDER BY observed_at DESC
      LIMIT 1)
     UNION ALL
     (SELECT open_interest AS openInterest,
       open_interest_value AS openInterestValue,
       observed_at AS observedAt
      FROM open_interest_sample
      WHERE symbol=:symbol AND observed_at <= :target15m AND observed_at > :min15m
      ORDER BY observed_at DESC
      LIMIT 1)
     UNION ALL
     (SELECT open_interest AS openInterest,
       open_interest_value AS openInterestValue,
       observed_at AS observedAt
      FROM open_interest_sample
      WHERE symbol=:symbol AND observed_at <= :target1h AND observed_at > :min1h
      ORDER BY observed_at DESC
      LIMIT 1)
     UNION ALL
     (SELECT open_interest AS openInterest,
       open_interest_value AS openInterestValue,
       observed_at AS observedAt
      FROM open_interest_sample
      WHERE symbol=:symbol AND observed_at <= :target4h AND observed_at > :min4h
      ORDER BY observed_at DESC
      LIMIT 1)
     UNION ALL
     (SELECT open_interest AS openInterest,
       open_interest_value AS openInterestValue,
       observed_at AS observedAt
      FROM open_interest_sample
      WHERE symbol=:symbol AND observed_at <= :target1d AND observed_at > :min1d
      ORDER BY observed_at DESC
      LIMIT 1)`,
    params
  );
  return selectOpenInterestSampleBaselines(rows, observedDate);
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
      oiChange1hPct: null,
      oiLastSpikeAlertAt: null,
      oiAlertPending: false
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
      change_1d_pct AS change1dPct,
      last_spike_alert_at AS lastSpikeAlertAt,
      last_spike_alert_signature AS lastSpikeAlertSignature
     FROM open_interest_monitor
     WHERE symbol=:symbol
       AND observed_at >= DATE_SUB(NOW(3), INTERVAL :activeSeconds SECOND)
     LIMIT 1`,
    { symbol: safeSymbol, activeSeconds: openInterestActiveSeconds() }
  );
  const oiSpike = evaluateOpenInterestSpike(oiRows[0], config.openInterestMonitor);
  let oiAlertPending = false;
  if (oiSpike.hit) {
    const [pendingRows] = await getPool().query(
      `SELECT 1 AS pending
       FROM telegram_alert_queue
       WHERE alert_type='OI_SPIKE'
         AND symbol=:symbol
         AND status IN ('PENDING','SENDING')
         AND created_at >= DATE_SUB(NOW(3), INTERVAL :activeSeconds SECOND)
       LIMIT 1`,
      { symbol: safeSymbol, activeSeconds: openInterestActiveSeconds() }
    );
    oiAlertPending = pendingRows.length > 0;
  }
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
    oiSpike1dHit: oiSpike.hit1d,
    oiLastSpikeAlertAt: oiRows[0]?.lastSpikeAlertAt ?? null,
    oiLastSpikeAlertSignature: oiRows[0]?.lastSpikeAlertSignature ?? null,
    oiAlertPending
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
  categories,
  page = 1,
  pageSize = 20
} = {}) {
  const safePage = Math.max(1, Number(page) || 1);
  const safePageSize = Math.max(1, Math.min(100, Number(pageSize) || 20));
  const column = oiChangeColumn(timeWindow);
  const direction = sort === "asc" ? "ASC" : "DESC";
  const categorySql = openInterestCategorySql(categories);
  const [countRows] = await getPool().query(
    `SELECT COUNT(*) AS total
     FROM open_interest_monitor oi
     JOIN token_list t ON t.symbol=oi.symbol AND t.is_active=1
     WHERE oi.${column} IS NOT NULL
       AND ${categorySql}`
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
       AND ${categorySql}
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
       AND oi.observed_at >= DATE_SUB(NOW(3), INTERVAL :activeSeconds SECOND)
     ORDER BY oi.${column} ${direction}, oi.observed_at DESC, oi.symbol
     LIMIT :limit`,
    { activeSeconds: openInterestActiveSeconds(), limit: safeLimit }
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
