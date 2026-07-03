import { config } from "../config.js";
import { evaluateOpenInterestSpike } from "../openInterestSpike.js";
import { getPool } from "./connection.js";
import { baseAssetAliases, baseAssetFromSymbol, sanitizeDbSymbol } from "./symbols.js";

function hotRankActiveSeconds() {
  return Math.max(60, Math.floor(config.hotRank.activeMs / 1000));
}

function openInterestActiveSeconds() {
  return Math.max(60, Math.floor(config.openInterestMonitor.activeMs / 1000));
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
