import { getPool } from "./connection.js";
import { baseAssetFromSymbol, sanitizeDbSymbol } from "./symbols.js";

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

export async function listLatestHotRankSnapshot({ chainLabels = [], limit = 100 } = {}) {
  const safeLimit = Math.max(1, Math.min(100, Number(limit) || 100));
  const labels = [...new Set((Array.isArray(chainLabels) ? chainLabels : []).map((item) => String(item ?? "").trim()).filter(Boolean))];
  const chainFilter = labels.length ? "WHERE chain_label IN (:chainLabels)" : "";
  const params = { chainLabels: labels, limit: safeLimit };
  const [rows] = await getPool().query(
    `SELECT symbol,
      base_asset AS baseAsset,
      chain_label AS chainLabel,
      rank_value AS rankValue,
      heat_value AS heat,
      snapshot_time AS snapshotTime
     FROM hot_rank_snapshot
     WHERE snapshot_time=(
       SELECT MAX(snapshot_time)
       FROM hot_rank_snapshot
       ${chainFilter}
     )
       ${labels.length ? "AND chain_label IN (:chainLabels)" : ""}
     ORDER BY rank_value ASC, heat_value DESC, symbol
     LIMIT :limit`,
    params
  );
  return rows.map((row) => ({
    symbol: row.symbol,
    baseAsset: row.baseAsset,
    chainLabel: row.chainLabel,
    rank: Number(row.rankValue),
    heat: row.heat === null ? null : Number(row.heat),
    snapshotTime: row.snapshotTime
  }));
}
