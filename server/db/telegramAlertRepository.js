import { getPool } from "./connection.js";
import { sanitizeDbSymbol } from "./symbols.js";

const TELEGRAM_ALERT_TYPES = new Set(["OI_SPIKE"]);

function normalizeTelegramAlertQueueItem(item = {}) {
  const queueKey = String(item.queueKey ?? "").trim().slice(0, 191);
  const alertType = TELEGRAM_ALERT_TYPES.has(item.alertType) ? item.alertType : null;
  const symbol = sanitizeDbSymbol(item.symbol) || null;
  const payload = item.payload === null || item.payload === undefined ? null : JSON.stringify(item.payload);
  const nextAttemptAt =
    item.nextAttemptAt instanceof Date
      ? item.nextAttemptAt
      : new Date(Number(item.nextAttemptAt) || item.nextAttemptAt || Date.now());
  if (!queueKey || !alertType || !payload || Number.isNaN(nextAttemptAt.getTime())) return null;
  return { queueKey, alertType, symbol, payload, nextAttemptAt };
}

export async function enqueueTelegramAlert(item) {
  const normalized = normalizeTelegramAlertQueueItem(item);
  if (!normalized) return false;
  const [result] = await getPool().query(
    `INSERT INTO telegram_alert_queue
      (queue_key, alert_type, symbol, payload_json, status, next_attempt_at)
     VALUES
      (:queueKey, :alertType, :symbol, :payload, 'PENDING', :nextAttemptAt)
     ON DUPLICATE KEY UPDATE
      alert_type=VALUES(alert_type),
      symbol=VALUES(symbol),
      payload_json=VALUES(payload_json),
      status=IF(status='SENDING', status, 'PENDING'),
      next_attempt_at=IF(status='SENDING', next_attempt_at, LEAST(next_attempt_at, VALUES(next_attempt_at))),
      last_error=IF(status='SENDING', last_error, NULL),
      sent_at=NULL`,
    normalized
  );
  return (result.affectedRows ?? 0) > 0;
}

function parseJsonColumn(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === "object") return value;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

export async function claimTelegramAlerts(limit = 10, staleAfterMs = 5 * 60 * 1000) {
  const safeLimit = Math.max(1, Math.min(50, Number(limit) || 10));
  const staleSeconds = Math.max(60, Math.floor((Number(staleAfterMs) || 5 * 60 * 1000) / 1000));
  const connection = await getPool().getConnection();
  try {
    await connection.beginTransaction();
    const [rows] = await connection.query(
      `SELECT id, queue_key AS queueKey, alert_type AS alertType, symbol, payload_json AS payloadJson,
        attempt_count AS attemptCount, status
       FROM telegram_alert_queue
       WHERE (
          status='PENDING'
          OR (status='SENDING' AND locked_at < DATE_SUB(NOW(3), INTERVAL :staleSeconds SECOND))
        )
        AND next_attempt_at <= NOW(3)
       ORDER BY next_attempt_at ASC, id ASC
       LIMIT :limit
       FOR UPDATE SKIP LOCKED`,
      { staleSeconds, limit: safeLimit }
    );
    if (!rows.length) {
      await connection.commit();
      return [];
    }
    await connection.query(
      `UPDATE telegram_alert_queue
       SET status='SENDING',
           locked_at=NOW(3),
           attempt_count=attempt_count+1
       WHERE id IN (:ids)`,
      { ids: rows.map((row) => row.id) }
    );
    await connection.commit();
    return rows.map((row) => ({
      id: Number(row.id),
      queueKey: row.queueKey,
      alertType: row.alertType,
      symbol: row.symbol,
      payload: parseJsonColumn(row.payloadJson),
      attemptCount: Number(row.attemptCount ?? 0) + 1
    }));
  } catch (error) {
    await connection.rollback().catch(() => {});
    throw error;
  } finally {
    connection.release();
  }
}

export async function markTelegramAlertSent(id) {
  const safeId = Number(id);
  if (!Number.isInteger(safeId) || safeId <= 0) return 0;
  const [result] = await getPool().query(
    `UPDATE telegram_alert_queue
     SET status='SENT',
         sent_at=NOW(3),
         locked_at=NULL,
         last_error=NULL
     WHERE id=:id`,
    { id: safeId }
  );
  return result.affectedRows ?? 0;
}

export async function markTelegramAlertFailed(id, error, { maxAttempts = 8, retryDelayMs = 5000 } = {}) {
  const safeId = Number(id);
  if (!Number.isInteger(safeId) || safeId <= 0) return 0;
  const safeMaxAttempts = Math.max(1, Number(maxAttempts) || 8);
  const safeRetryDelayMs = Math.max(1000, Number(retryDelayMs) || 5000);
  const retrySeconds = Math.max(1, Math.ceil(safeRetryDelayMs / 1000));
  const message = error instanceof Error ? error.message : String(error ?? "unknown error");
  const [result] = await getPool().query(
    `UPDATE telegram_alert_queue
     SET status=IF(attempt_count >= :maxAttempts, 'FAILED', 'PENDING'),
         next_attempt_at=DATE_ADD(NOW(3), INTERVAL :retrySeconds SECOND),
         locked_at=NULL,
         last_error=:lastError
     WHERE id=:id`,
    {
      id: safeId,
      maxAttempts: safeMaxAttempts,
      retrySeconds,
      lastError: message.slice(0, 1000)
    }
  );
  return result.affectedRows ?? 0;
}

export async function getTelegramAlertQueueStats() {
  const [rows] = await getPool().query(
    `SELECT status, COUNT(*) AS count
     FROM telegram_alert_queue
     GROUP BY status`
  );
  const stats = { pending: 0, sending: 0, sent: 0, failed: 0 };
  for (const row of rows) {
    const key = String(row.status ?? "").toLowerCase();
    if (key in stats) stats[key] = Number(row.count ?? 0);
  }
  return stats;
}
