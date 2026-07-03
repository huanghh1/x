import { getPool } from "./connection.js";
import { sanitizeDbSymbol } from "./symbols.js";

const TRADE_JOURNAL_STATUSES = new Set(["OPEN", "ENDED", "REVIEWED"]);
const TRADE_JOURNAL_SIDES = new Set(["LONG", "SHORT", "SPOT", "OTHER"]);

function tradeJournalText(value, maxLength, fallback = "") {
  const text = String(value ?? "").trim();
  return (text || fallback).slice(0, maxLength);
}

function tradeJournalNullableDate(value, fieldName) {
  if (value === "" || value === null || value === undefined) return null;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`${fieldName} must be a valid date`);
  }
  return date;
}

function normalizeTradeJournalPayload(payload = {}) {
  const symbol = sanitizeDbSymbol(payload.symbol);
  const side = String(payload.side ?? "").toUpperCase();
  const status = String(payload.status ?? "OPEN").toUpperCase();
  const openReason = tradeJournalText(payload.openReason, 8000);
  if (!openReason) throw new Error("开仓理由不能为空");
  return {
    title: tradeJournalText(payload.title, 160, symbol ? `${symbol} 交易日记` : "交易日记"),
    symbol: symbol || null,
    side: TRADE_JOURNAL_SIDES.has(side) ? side : null,
    status: TRADE_JOURNAL_STATUSES.has(status) ? status : "OPEN",
    openedAt: tradeJournalNullableDate(payload.openedAt, "openedAt"),
    closedAt: tradeJournalNullableDate(payload.closedAt, "closedAt"),
    openReason,
    closeReason: tradeJournalText(payload.closeReason, 8000) || null,
    reviewSummary: tradeJournalText(payload.reviewSummary, 12000) || null
  };
}

function normalizeTradeJournalIntradayNote(payload = {}) {
  const noteText = tradeJournalText(payload.noteText ?? payload.text ?? payload.note, 8000);
  if (!noteText) throw new Error("盘中确定不能为空");
  return {
    noteText,
    notedAt: tradeJournalNullableDate(payload.notedAt, "notedAt") ?? new Date()
  };
}

function mapTradeJournalIntradayNote(row) {
  return {
    id: Number(row.id),
    journalId: Number(row.journalId),
    noteText: row.noteText ?? "",
    notedAt: row.notedAt ?? null,
    createdAt: row.createdAt ?? null
  };
}

function mapTradeJournalRow(row) {
  return {
    id: Number(row.id),
    title: row.title ?? "",
    symbol: row.symbol ?? "",
    side: row.side ?? "",
    status: row.status ?? "OPEN",
    openedAt: row.openedAt ?? null,
    closedAt: row.closedAt ?? null,
    openReason: row.openReason ?? "",
    closeReason: row.closeReason ?? "",
    reviewSummary: row.reviewSummary ?? "",
    intradayNotes: [],
    createdAt: row.createdAt ?? null,
    updatedAt: row.updatedAt ?? null
  };
}

async function attachTradeJournalIntradayNotes(items) {
  const journalIds = items
    .map((item) => Number(item.id))
    .filter((id) => Number.isInteger(id) && id > 0);
  if (!journalIds.length) return items;
  const [rows] = await getPool().query(
    `SELECT id, journal_id AS journalId, note_text AS noteText,
      noted_at AS notedAt, created_at AS createdAt
     FROM trade_journal_intraday_notes
     WHERE journal_id IN (?)
     ORDER BY noted_at ASC, id ASC`,
    [journalIds]
  );
  const notesByJournalId = new Map();
  for (const row of rows) {
    const note = mapTradeJournalIntradayNote(row);
    const notes = notesByJournalId.get(note.journalId) ?? [];
    notes.push(note);
    notesByJournalId.set(note.journalId, notes);
  }
  for (const item of items) {
    item.intradayNotes = notesByJournalId.get(Number(item.id)) ?? [];
  }
  return items;
}

export async function listTradeJournal({
  page = 1,
  pageSize = 20,
  keyword = "",
  status = ""
} = {}) {
  const safePage = Math.max(1, Number(page) || 1);
  const safePageSize = Math.max(1, Math.min(100, Number(pageSize) || 20));
  const safeKeyword = String(keyword ?? "").trim().slice(0, 120);
  const safeStatus = TRADE_JOURNAL_STATUSES.has(String(status ?? "").toUpperCase())
    ? String(status).toUpperCase()
    : "";
  const clauses = [];
  const params = {
    pageSize: safePageSize,
    offset: (safePage - 1) * safePageSize
  };
  if (safeStatus) {
    clauses.push("status=:status");
    params.status = safeStatus;
  }
  if (safeKeyword) {
    clauses.push(`(
      title LIKE :keyword
      OR symbol LIKE :keyword
      OR open_reason LIKE :keyword
      OR close_reason LIKE :keyword
      OR review_summary LIKE :keyword
      OR EXISTS (
        SELECT 1
        FROM trade_journal_intraday_notes
        WHERE trade_journal_intraday_notes.journal_id = trade_journal.id
          AND trade_journal_intraday_notes.note_text LIKE :keyword
      )
    )`);
    params.keyword = `%${safeKeyword}%`;
  }
  const whereSql = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const [countRows] = await getPool().query(`SELECT COUNT(*) AS total FROM trade_journal ${whereSql}`, params);
  const [rows] = await getPool().query(
    `SELECT id, title, symbol, side, status,
      opened_at AS openedAt, closed_at AS closedAt,
      open_reason AS openReason, close_reason AS closeReason, review_summary AS reviewSummary,
      created_at AS createdAt, updated_at AS updatedAt
     FROM trade_journal
     ${whereSql}
     ORDER BY COALESCE(opened_at, created_at) DESC, id DESC
     LIMIT :pageSize OFFSET :offset`,
    params
  );
  const items = await attachTradeJournalIntradayNotes(rows.map(mapTradeJournalRow));
  return {
    items,
    total: Number(countRows[0]?.total ?? 0),
    page: safePage,
    pageSize: safePageSize
  };
}

export async function getTradeJournalEntry(id) {
  const safeId = Number(id);
  if (!Number.isInteger(safeId) || safeId <= 0) return null;
  const [rows] = await getPool().query(
    `SELECT id, title, symbol, side, status,
      opened_at AS openedAt, closed_at AS closedAt,
      open_reason AS openReason, close_reason AS closeReason, review_summary AS reviewSummary,
      created_at AS createdAt, updated_at AS updatedAt
     FROM trade_journal
     WHERE id=:id
     LIMIT 1`,
    { id: safeId }
  );
  if (!rows[0]) return null;
  const [item] = await attachTradeJournalIntradayNotes([mapTradeJournalRow(rows[0])]);
  return item;
}

export async function createTradeJournalEntry(payload = {}) {
  const item = normalizeTradeJournalPayload(payload);
  const [result] = await getPool().query(
    `INSERT INTO trade_journal
      (title, symbol, side, status, opened_at, closed_at, open_reason, close_reason, review_summary)
     VALUES
      (:title, :symbol, :side, :status, :openedAt, :closedAt, :openReason, :closeReason, :reviewSummary)`,
    item
  );
  return getTradeJournalEntry(result.insertId);
}

export async function updateTradeJournalEntry(id, payload = {}) {
  const safeId = Number(id);
  if (!Number.isInteger(safeId) || safeId <= 0) throw new Error("id is required");
  const item = normalizeTradeJournalPayload(payload);
  const [result] = await getPool().query(
    `UPDATE trade_journal
     SET title=:title,
       symbol=:symbol,
       side=:side,
       status=:status,
       opened_at=:openedAt,
       closed_at=:closedAt,
       open_reason=:openReason,
       close_reason=:closeReason,
       review_summary=:reviewSummary,
       updated_at=NOW()
     WHERE id=:id`,
    { ...item, id: safeId }
  );
  if (!result.affectedRows) return null;
  return getTradeJournalEntry(safeId);
}

export async function deleteTradeJournalEntry(id) {
  const safeId = Number(id);
  if (!Number.isInteger(safeId) || safeId <= 0) return 0;
  const [result] = await getPool().query("DELETE FROM trade_journal WHERE id=:id", { id: safeId });
  return result.affectedRows ?? 0;
}

export async function createTradeJournalIntradayNote(journalId, payload = {}) {
  const safeJournalId = Number(journalId);
  if (!Number.isInteger(safeJournalId) || safeJournalId <= 0) throw new Error("journal id is required");
  const note = normalizeTradeJournalIntradayNote(payload);
  const [entryRows] = await getPool().query(
    "SELECT id FROM trade_journal WHERE id=:journalId LIMIT 1",
    { journalId: safeJournalId }
  );
  if (!entryRows.length) return null;
  const [result] = await getPool().query(
    `INSERT INTO trade_journal_intraday_notes (journal_id, note_text, noted_at)
     VALUES (:journalId, :noteText, :notedAt)`,
    { journalId: safeJournalId, ...note }
  );
  const [rows] = await getPool().query(
    `SELECT id, journal_id AS journalId, note_text AS noteText,
      noted_at AS notedAt, created_at AS createdAt
     FROM trade_journal_intraday_notes
     WHERE id=:id
     LIMIT 1`,
    { id: result.insertId }
  );
  return rows[0] ? mapTradeJournalIntradayNote(rows[0]) : null;
}
