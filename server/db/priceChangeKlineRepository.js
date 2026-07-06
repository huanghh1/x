import { config } from "../config.js";
import { getPool } from "./connection.js";
import { sanitizeDbSymbol } from "./symbols.js";

export const PRICE_CHANGE_1M_INTERVAL_MS = 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

export function latestClosedPriceChangeOpenTimeAt(now = Date.now()) {
  return Math.floor(Number(now) / PRICE_CHANGE_1M_INTERVAL_MS) * PRICE_CHANGE_1M_INTERVAL_MS - PRICE_CHANGE_1M_INTERVAL_MS;
}

export function priceChangeKlineTarget({
  retentionHours = config.priceChangeKline.retentionHours,
  now = Date.now()
} = {}) {
  const safeRetentionHours = Math.max(25, Number(retentionHours) || 25);
  const expectedCount = Math.ceil(safeRetentionHours * 60);
  const targetEndTime = latestClosedPriceChangeOpenTimeAt(now);
  return {
    expectedCount,
    targetEndTime,
    targetStartTime: targetEndTime - (expectedCount - 1) * PRICE_CHANGE_1M_INTERVAL_MS
  };
}

export function priceChange24hBaselineOpenTime(now = Date.now()) {
  return Math.floor((Number(now) - DAY_MS) / PRICE_CHANGE_1M_INTERVAL_MS) * PRICE_CHANGE_1M_INTERVAL_MS;
}

export async function listActivePriceChangeKlineTokens() {
  const [rows] = await getPool().query(
    `SELECT id, symbol, base_asset AS baseAsset, category_type AS categoryType, category_label AS categoryLabel
     FROM token_list
     WHERE is_active=1
     ORDER BY category_type ASC, symbol ASC`
  );
  return rows;
}

export async function upsertPriceChangeKlinePage(token, klines = []) {
  if (!Array.isArray(klines) || klines.length === 0) return 0;
  const rows = klines.map((kline) => [
    token.id,
    token.symbol,
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
    `INSERT INTO price_change_1m_kline
      (token_id, symbol, open_time, close_time, open_price, high_price, low_price, close_price, volume, quote_volume, trade_count)
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
  return Number(result.affectedRows ?? 0);
}

export async function priceChangeKlineStats(symbol, {
  startTime = priceChangeKlineTarget().targetStartTime,
  endTime = priceChangeKlineTarget().targetEndTime
} = {}) {
  const safeSymbol = sanitizeDbSymbol(symbol);
  const [rows] = await getPool().query(
    `SELECT COUNT(*) AS count,
      MIN(open_time) AS minOpenTime,
      MAX(open_time) AS maxOpenTime
     FROM price_change_1m_kline
     WHERE symbol=:symbol
       AND open_time>=:startTime
       AND open_time<=:endTime`,
    {
      symbol: safeSymbol,
      startTime: Math.max(0, Number(startTime) || 0),
      endTime: Math.max(0, Number(endTime) || 0)
    }
  );
  const row = rows[0] ?? {};
  return {
    count: Number(row.count ?? 0),
    minOpenTime: row.minOpenTime === null || row.minOpenTime === undefined ? null : Number(row.minOpenTime),
    maxOpenTime: row.maxOpenTime === null || row.maxOpenTime === undefined ? null : Number(row.maxOpenTime)
  };
}

export async function listPriceChangeKlineGaps(symbol, startTime, endTime, limit = 300) {
  const safeSymbol = sanitizeDbSymbol(symbol);
  const [rows] = await getPool().query(
    `SELECT open_time AS openTime
     FROM price_change_1m_kline
     WHERE symbol=:symbol
       AND open_time>=:startTime
       AND open_time<=:endTime
     ORDER BY open_time ASC`,
    {
      symbol: safeSymbol,
      startTime: Math.max(0, Number(startTime) || 0),
      endTime: Math.max(0, Number(endTime) || 0)
    }
  );
  if (rows.length < 2) return [];
  const safeLimit = Math.max(1, Math.min(1000, Number(limit) || 300));
  const gaps = [];
  let previousOpenTime = Number(rows[0].openTime);
  for (const row of rows.slice(1)) {
    const currentOpenTime = Number(row.openTime);
    const expectedOpenTime = previousOpenTime + PRICE_CHANGE_1M_INTERVAL_MS;
    if (currentOpenTime > expectedOpenTime) {
      gaps.push({
        startTime: expectedOpenTime,
        endTime: currentOpenTime - PRICE_CHANGE_1M_INTERVAL_MS,
        missingCount: Math.max(1, Math.round((currentOpenTime - expectedOpenTime) / PRICE_CHANGE_1M_INTERVAL_MS))
      });
      if (gaps.length >= safeLimit) break;
    }
    previousOpenTime = currentOpenTime;
  }
  return gaps;
}

export async function selectPriceChange24hBaselineSnapshot(symbol, now = Date.now()) {
  const safeSymbol = sanitizeDbSymbol(symbol);
  if (!safeSymbol) return null;
  const baselineOpenTime = priceChange24hBaselineOpenTime(now);
  const [rows] = await getPool().query(
    `SELECT open_price AS openPrice
     FROM price_change_1m_kline
     WHERE symbol=:symbol AND open_time=:baselineOpenTime
     LIMIT 1`,
    { symbol: safeSymbol, baselineOpenTime }
  );
  const price = Number(rows[0]?.openPrice);
  return Number.isFinite(price) && price > 0
    ? { baselinePrice: price, baselineOpenTime }
    : null;
}

export async function selectPriceChange24hBaselinePrice(symbol, now = Date.now()) {
  const snapshot = await selectPriceChange24hBaselineSnapshot(symbol, now);
  return snapshot?.baselinePrice ?? null;
}

export async function cleanupPriceChangeKlineRetention({
  retentionHours = config.priceChangeKline.retentionHours,
  now = Date.now()
} = {}) {
  const target = priceChangeKlineTarget({ retentionHours, now });
  const [result] = await getPool().query(
    `DELETE FROM price_change_1m_kline
     WHERE open_time < :cutoffOpenTime`,
    { cutoffOpenTime: target.targetStartTime }
  );
  return {
    retentionHours: Math.max(25, Number(retentionHours) || 25),
    cutoffOpenTime: target.targetStartTime,
    deletedRows: Number(result.affectedRows ?? 0)
  };
}
