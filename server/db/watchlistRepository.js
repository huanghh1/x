import { config } from "../config.js";
import { getPool } from "./connection.js";
import { baseAssetFromSymbol, sanitizeDbSymbol } from "./symbols.js";

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

export async function addWatchlistItemsIfMissing(items = [], { note = "" } = {}) {
  const safeNote = String(note ?? "").slice(0, 255);
  const bySymbol = new Map();
  for (const item of Array.isArray(items) ? items : [items]) {
    const symbol = sanitizeDbSymbol(typeof item === "string" ? item : item?.symbol);
    if (!symbol || bySymbol.has(symbol)) continue;
    bySymbol.set(symbol, [symbol, baseAssetFromSymbol(symbol), safeNote, 1]);
  }
  const rows = Array.from(bySymbol.values());
  if (!rows.length) return 0;
  const [result] = await getPool().query(
    `INSERT IGNORE INTO watchlist (symbol, base_asset, note, alert_enabled)
     VALUES ?`,
    [rows]
  );
  return Number(result.affectedRows ?? 0);
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
