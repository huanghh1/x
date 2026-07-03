import crypto from "node:crypto";
import { getPool } from "./connection.js";

function tradeText(value, maxLength, fallback = "") {
  const text = String(value ?? fallback).trim();
  return (text || fallback).slice(0, maxLength);
}

function tradeNullableText(value, maxLength) {
  const text = String(value ?? "").trim();
  return text ? text.slice(0, maxLength) : null;
}

function tradeNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function tradeNullableNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function tradeEventTimeMs(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : null;
}

function tradeEventDate(value) {
  const time = tradeEventTimeMs(value);
  return time === null ? null : new Date(time);
}

function tradeEventKey(event) {
  const source = tradeText(event?.source, 32);
  const raw = tradeText(event?.id ?? `${source}:${event?.symbol}:${event?.type}:${event?.time}:${event?.net}`, 512);
  if (!source || !raw) return "";
  const key = raw.includes(":") ? raw : `${source}:${raw}`;
  if (key.length <= 191) return key;
  const hash = crypto.createHash("sha256").update(key).digest("hex").slice(0, 24);
  return `${key.slice(0, 166)}:${hash}`;
}

function normalizeTradeHistoryEvent(event) {
  const eventKey = tradeEventKey(event);
  const source = tradeText(event?.source, 32);
  const symbol = tradeText(event?.symbol, 64, "--");
  if (!eventKey || !source || !symbol) return null;
  return [
    eventKey,
    source,
    tradeNullableText(event?.sourceLabel, 80),
    symbol,
    tradeNullableText(event?.asset, 32),
    tradeEventTimeMs(event?.time),
    tradeEventDate(event?.time),
    tradeNullableText(event?.type, 64),
    tradeNullableText(event?.side, 32),
    tradeNullableText(event?.direction, 80),
    tradeNullableText(event?.positionSide, 32),
    tradeNullableNumber(event?.quantity),
    tradeNullableNumber(event?.price),
    tradeNullableNumber(event?.markPrice),
    tradeNullableNumber(event?.notional),
    tradeNullableNumber(event?.fundingRate),
    tradeNumber(event?.realizedPnl),
    tradeNumber(event?.unrealizedPnl),
    tradeNumber(event?.funding),
    tradeNumber(event?.commission),
    tradeNullableText(event?.feeAsset, 32),
    tradeNumber(event?.net),
    tradeNullableText(event?.orderId, 128),
    tradeNullableText(event?.tradeId, 128),
    tradeNullableText(event?.liquidity, 32),
    tradeNullableText(event?.note, 1000),
    event?.pnlIncluded === false ? 0 : 1,
    tradeNullableText(event?.rawType, 64),
    event?.details === null || event?.details === undefined ? null : JSON.stringify(event.details)
  ];
}

export async function upsertTradeEventHistory(events) {
  const rows = (events ?? []).map(normalizeTradeHistoryEvent).filter(Boolean);
  if (!rows.length) return 0;
  const [result] = await getPool().query(
    `INSERT INTO trade_event_history
      (event_key, source, source_label, symbol, asset, event_time_ms, event_time, event_type, side,
       direction, position_side, quantity, price, mark_price, notional, funding_rate, realized_pnl,
       unrealized_pnl, funding, commission, fee_asset, net, order_id, trade_id, liquidity, note,
       pnl_included, raw_type, details)
     VALUES ?
     ON DUPLICATE KEY UPDATE
      source=VALUES(source),
      source_label=VALUES(source_label),
      symbol=VALUES(symbol),
      asset=VALUES(asset),
      event_time_ms=VALUES(event_time_ms),
      event_time=VALUES(event_time),
      event_type=VALUES(event_type),
      side=VALUES(side),
      direction=VALUES(direction),
      position_side=VALUES(position_side),
      quantity=VALUES(quantity),
      price=VALUES(price),
      mark_price=VALUES(mark_price),
      notional=VALUES(notional),
      funding_rate=VALUES(funding_rate),
      realized_pnl=VALUES(realized_pnl),
      unrealized_pnl=VALUES(unrealized_pnl),
      funding=VALUES(funding),
      commission=VALUES(commission),
      fee_asset=VALUES(fee_asset),
      net=VALUES(net),
      order_id=VALUES(order_id),
      trade_id=VALUES(trade_id),
      liquidity=VALUES(liquidity),
      note=VALUES(note),
      pnl_included=VALUES(pnl_included),
      raw_type=VALUES(raw_type),
      details=VALUES(details)`,
    [rows]
  );
  return Number(result.affectedRows ?? 0);
}

function cleanTradeFilterSymbol(value) {
  return String(value ?? "").trim().toUpperCase().replace(/[^A-Z0-9:_-]/g, "").slice(0, 64);
}

function tradeSymbolCandidates(symbol) {
  const compact = cleanTradeFilterSymbol(symbol).replace(/[_-]/g, "");
  if (!compact) return [];
  const candidates = new Set([compact]);
  if (compact.endsWith("USDT") && compact.length > 4) candidates.add(compact.slice(0, -4));
  else candidates.add(`${compact}USDT`);
  return Array.from(candidates);
}

function tradeHistoryWhere({ startMs, endMs, symbol, source } = {}) {
  const where = ["event_time_ms IS NOT NULL"];
  const params = {};
  const safeStart = tradeEventTimeMs(startMs);
  const safeEnd = tradeEventTimeMs(endMs);
  if (safeStart !== null) {
    where.push("event_time_ms >= :startMs");
    params.startMs = safeStart;
  }
  if (safeEnd !== null) {
    where.push("event_time_ms <= :endMs");
    params.endMs = safeEnd;
  }
  const sourceValue = tradeNullableText(source, 32);
  if (sourceValue) {
    where.push("source = :source");
    params.source = sourceValue;
  }
  const symbols = tradeSymbolCandidates(symbol);
  if (symbols.length) {
    where.push("REPLACE(REPLACE(UPPER(symbol), '_', ''), '-', '') IN (:symbols)");
    params.symbols = symbols;
  }
  return { whereSql: `WHERE ${where.join(" AND ")}`, params };
}

function tradeAggregateSelect() {
  return `COUNT(*) AS events,
    MIN(event_time_ms) AS firstTime,
    MAX(event_time_ms) AS lastTime,
    COALESCE(SUM(CASE WHEN pnl_included=1 THEN realized_pnl ELSE 0 END), 0) AS realizedPnl,
    COALESCE(SUM(CASE WHEN pnl_included=1 THEN funding ELSE 0 END), 0) AS funding,
    COALESCE(SUM(CASE WHEN pnl_included=1 THEN commission ELSE 0 END), 0) AS commission,
    COALESCE(SUM(CASE WHEN pnl_included=1 AND commission < 0 THEN -commission ELSE 0 END), 0) AS feeCost,
    COALESCE(SUM(CASE WHEN pnl_included=1 THEN realized_pnl + funding + commission ELSE 0 END), 0) AS net,
    COALESCE(SUM(CASE WHEN pnl_included=1 THEN notional ELSE 0 END), 0) AS notional`;
}

function tradeNumberFromRow(row, key) {
  const number = Number(row?.[key]);
  return Number.isFinite(number) ? number : 0;
}

function mapTradeSummaryRow(row) {
  return {
    source: row.source ?? "",
    sourceLabel: row.sourceLabel ?? row.source_label ?? "",
    symbol: row.symbol ?? "",
    firstTime: row.firstTime === null || row.firstTime === undefined ? null : Number(row.firstTime),
    lastTime: row.lastTime === null || row.lastTime === undefined ? null : Number(row.lastTime),
    events: tradeNumberFromRow(row, "events"),
    realizedPnl: tradeNumberFromRow(row, "realizedPnl"),
    funding: tradeNumberFromRow(row, "funding"),
    commission: tradeNumberFromRow(row, "commission"),
    feeCost: tradeNumberFromRow(row, "feeCost"),
    net: tradeNumberFromRow(row, "net"),
    notional: tradeNumberFromRow(row, "notional")
  };
}

function mapTradeEventRow(row) {
  return {
    id: row.eventKey,
    source: row.source ?? "",
    sourceLabel: row.sourceLabel ?? "",
    symbol: row.symbol ?? "",
    asset: row.asset ?? "",
    time: row.time === null || row.time === undefined ? null : Number(row.time),
    type: row.type ?? "",
    side: row.side ?? "",
    direction: row.direction ?? "",
    positionSide: row.positionSide ?? "",
    quantity: row.quantity === null || row.quantity === undefined ? null : Number(row.quantity),
    price: row.price === null || row.price === undefined ? null : Number(row.price),
    markPrice: row.markPrice === null || row.markPrice === undefined ? null : Number(row.markPrice),
    notional: row.notional === null || row.notional === undefined ? null : Number(row.notional),
    fundingRate: row.fundingRate === null || row.fundingRate === undefined ? null : Number(row.fundingRate),
    realizedPnl: tradeNumberFromRow(row, "realizedPnl"),
    unrealizedPnl: tradeNumberFromRow(row, "unrealizedPnl"),
    funding: tradeNumberFromRow(row, "funding"),
    commission: tradeNumberFromRow(row, "commission"),
    feeAsset: row.feeAsset ?? "",
    net: tradeNumberFromRow(row, "net"),
    orderId: row.orderId ?? "",
    tradeId: row.tradeId ?? "",
    liquidity: row.liquidity ?? "",
    note: row.note ?? "",
    pnlIncluded: Number(row.pnlIncluded) !== 0,
    rawType: row.rawType ?? "",
    details: (() => {
      if (typeof row.details !== "string") return row.details ?? null;
      try {
        return JSON.parse(row.details);
      } catch {
        return null;
      }
    })()
  };
}

export async function readTradeEventHistoryAnalysis({
  startMs,
  endMs,
  symbol = "",
  source = "",
  page = 1,
  pageSize = 20,
  eventLimit = 100
} = {}) {
  const safePage = Math.max(1, Number(page) || 1);
  const safePageSize = Math.max(1, Math.min(100, Number(pageSize) || 20));
  const safeEventLimit = Math.max(1, Math.min(500, Number(eventLimit) || 100));
  const { whereSql, params } = tradeHistoryWhere({ startMs, endMs, symbol, source });

  const [totalRows] = await getPool().query(
    `SELECT ${tradeAggregateSelect()}
     FROM trade_event_history
     ${whereSql}`,
    params
  );
  const totals = mapTradeSummaryRow({ ...(totalRows[0] ?? {}), source: "", sourceLabel: "全部", symbol: "" });

  const [sourceRows] = await getPool().query(
    `SELECT source, COALESCE(MAX(source_label), source) AS sourceLabel, '' AS symbol,
      ${tradeAggregateSelect()}
     FROM trade_event_history
     ${whereSql}
     GROUP BY source
     ORDER BY lastTime DESC, source ASC`,
    params
  );

  const [countRows] = await getPool().query(
    `SELECT COUNT(*) AS total
     FROM (
       SELECT source, symbol
       FROM trade_event_history
       ${whereSql}
       GROUP BY source, symbol
     ) grouped`,
    params
  );
  const symbolTotal = Number(countRows[0]?.total ?? 0);
  const symbolTotalPages = Math.max(1, Math.ceil(symbolTotal / safePageSize));
  const effectivePage = Math.min(safePage, symbolTotalPages);

  const [symbolRows] = await getPool().query(
    `SELECT source, COALESCE(MAX(source_label), source) AS sourceLabel, symbol,
      ${tradeAggregateSelect()}
     FROM trade_event_history
     ${whereSql}
     GROUP BY source, symbol
     ORDER BY lastTime DESC, firstTime DESC, source ASC, symbol ASC
     LIMIT :pageSize OFFSET :offset`,
    { ...params, pageSize: safePageSize, offset: (effectivePage - 1) * safePageSize }
  );

  const [eventRows] = await getPool().query(
    `SELECT event_key AS eventKey, source, source_label AS sourceLabel, symbol, asset,
      event_time_ms AS time, event_type AS type, side, direction, position_side AS positionSide,
      quantity, price, mark_price AS markPrice, notional, funding_rate AS fundingRate,
      realized_pnl AS realizedPnl, unrealized_pnl AS unrealizedPnl, funding, commission,
      fee_asset AS feeAsset, net, order_id AS orderId, trade_id AS tradeId, liquidity, note,
      pnl_included AS pnlIncluded, raw_type AS rawType, details
     FROM trade_event_history
     ${whereSql}
     ORDER BY event_time_ms DESC, id DESC
     LIMIT :eventLimit`,
    { ...params, eventLimit: safeEventLimit }
  );

  return {
    summary: {
      totals,
      bySource: sourceRows.map(mapTradeSummaryRow),
      bySymbol: symbolRows.map(mapTradeSummaryRow)
    },
    symbolSummary: {
      total: symbolTotal,
      page: effectivePage,
      pageSize: safePageSize
    },
    events: eventRows.map(mapTradeEventRow),
    eventCount: totals.events
  };
}
