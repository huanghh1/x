import { getPool } from "./connection.js";
import { sanitizeDbSymbol } from "./symbols.js";

function normalizeList(values, allowedValues) {
  const input = Array.isArray(values) ? values : String(values ?? "").split(",");
  return input.map((item) => String(item).trim()).filter((item) => allowedValues.has(item));
}

function quotedList(values) {
  return values.map((item) => `'${item}'`).join(",");
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
