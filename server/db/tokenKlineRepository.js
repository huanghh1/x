import { config } from "../config.js";
import { getPool } from "./connection.js";
import {
  KLINE_COMPLETION_INTERVALS,
  detectKlineTailGap,
  intervalMs,
  isNaturalKlineHistoryShortfall,
  klineCompletionTarget,
  latestClosedKlineOpenTime,
  normalizeIntervalCode,
  summarizeTokenKlineCompletion
} from "./klineCompletion.js";
import { sanitizeDbSymbol } from "./symbols.js";

export {
  detectKlineTailGap,
  isNaturalKlineHistoryShortfall,
  summarizeTokenKlineCompletion
} from "./klineCompletion.js";

function isRetryableDatabaseError(error) {
  const message = error instanceof Error ? error.message : String(error);
  const code = error?.code ?? error?.errno;
  return (
    code === "ER_LOCK_DEADLOCK" ||
    code === "ER_LOCK_WAIT_TIMEOUT" ||
    code === 1213 ||
    code === 1205 ||
    /deadlock|lock wait timeout/i.test(message)
  );
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function withRetryableDatabaseQuery(operation, attempts = 3) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (!isRetryableDatabaseError(error) || attempt >= attempts) break;
      await sleep(150 * 2 ** (attempt - 1));
    }
  }
  throw lastError;
}

export async function upsertTokens(tokens) {
  if (tokens.length === 0) return 0;
  const rows = tokens.map((token) => {
    const marketCap = Number(token.marketCap);
    const safeMarketCap = Number.isFinite(marketCap) && marketCap > 0 ? marketCap : null;
    return [
      token.symbol,
      token.baseAsset,
      "USDT",
      token.categoryType,
      token.categoryLabel,
      token.hasSpot ? 1 : 0,
      token.hasFutures ? 1 : 0,
      token.isAlpha ? 1 : 0,
      safeMarketCap,
      safeMarketCap === null ? null : new Date()
    ];
  });
  await getPool().query(
    `INSERT INTO token_list
      (symbol, base_asset, quote_asset, category_type, category_label, has_spot, has_futures, is_alpha, market_cap, market_cap_updated_at)
     VALUES ?
     ON DUPLICATE KEY UPDATE
      base_asset = VALUES(base_asset),
      category_type = VALUES(category_type),
      category_label = VALUES(category_label),
      has_spot = VALUES(has_spot),
      has_futures = VALUES(has_futures),
      is_alpha = VALUES(is_alpha),
      market_cap = COALESCE(VALUES(market_cap), market_cap),
      market_cap_updated_at = IF(VALUES(market_cap) IS NULL, market_cap_updated_at, VALUES(market_cap_updated_at))`,
    [rows]
  );
  const symbols = tokens.map((token) => token.symbol);
  if (symbols.length > 0) {
    await getPool().query(
      "UPDATE token_list SET is_active=1, inactive_since=NULL, universe_missing_count=0 WHERE symbol IN (?)",
      [symbols]
    );
    await getPool().query(
      `UPDATE token_list
       SET universe_missing_count=LEAST(255, universe_missing_count+1)
       WHERE symbol NOT IN (?) AND is_active=1`,
      [symbols]
    );
    await getPool().query(
      `UPDATE token_list
       SET is_active=0, inactive_since=COALESCE(inactive_since, NOW(3))
       WHERE symbol NOT IN (?)
         AND is_active=1
         AND universe_missing_count>=2`,
      [symbols]
    );
  }
  return rows.length;
}

export async function getTokenUniverseStats() {
  const [rows] = await getPool().query(
    `SELECT COUNT(*) AS total,
      SUM(category_type='A') AS categoryA,
      SUM(category_type='B') AS categoryB
     FROM token_list
     WHERE is_active=1`
  );
  return {
    total: Number(rows[0]?.total ?? 0),
    categoryA: Number(rows[0]?.categoryA ?? 0),
    categoryB: Number(rows[0]?.categoryB ?? 0)
  };
}

export async function queueActiveTokensForKlineAudit(symbols = []) {
  const safeSymbols = [...new Set(symbols.map(sanitizeDbSymbol).filter(Boolean))];
  if (!safeSymbols.length) return 0;
  const [result] = await getPool().query(
    `UPDATE token_list
     SET fetch_status='partial',
         current_interval=NULL,
         last_error='每日 K 线完整性审计已入队'
     WHERE is_active=1
       AND fetch_status<>'fetching'
       AND symbol IN (?)`,
    [safeSymbols]
  );
  return Number(result.affectedRows ?? 0);
}

export async function queueSymbolsForKlineRefresh(symbols = [], reason = "K 线缓存需要补齐") {
  const safeSymbols = [...new Set((Array.isArray(symbols) ? symbols : [symbols]).map(sanitizeDbSymbol).filter(Boolean))];
  if (!safeSymbols.length) return 0;
  const [result] = await getPool().query(
    `UPDATE token_list
     SET fetch_status='partial',
         current_interval=NULL,
         last_error=:reason
     WHERE is_active=1
       AND fetch_status<>'fetching'
       AND symbol IN (:symbols)
       AND NOT (
         fetch_status='partial'
         AND last_error=:reason
         AND updated_at > DATE_SUB(NOW(3), INTERVAL :cooldownSeconds SECOND)
       )`,
    { symbols: safeSymbols, reason: String(reason).slice(0, 1000), cooldownSeconds: 10 * 60 }
  );
  return Number(result.affectedRows ?? 0);
}

export async function getKlineAuditReport(retentionLimits = config.crawler.retentionLimits) {
  const auditIntervals = ["15m", "1h", "4h", "1d"];
  const latestClosed = {
    "15m": latestClosedKlineOpenTime("15m"),
    "1h": latestClosedKlineOpenTime("1h"),
    "4h": latestClosedKlineOpenTime("4h"),
    "1d": latestClosedKlineOpenTime("1d")
  };
  const expectedCounts = Object.fromEntries(
    auditIntervals.map((intervalCode) => [
      intervalCode,
      Math.max(200, Number(retentionLimits[intervalCode]) || 200)
    ])
  );
  const targetStart = Object.fromEntries(
    auditIntervals.map((intervalCode) => [
      intervalCode,
      latestClosed[intervalCode] - (expectedCounts[intervalCode] - 1) * intervalMs(intervalCode)
    ])
  );
  const [rows] = await getPool().query(
    `SELECT t.symbol, intervals.interval_code AS intervalCode,
      COUNT(k.id) AS cachedCount,
      MIN(k.open_time) AS earliestOpenTime,
      MAX(k.open_time) AS latestOpenTime
     FROM token_list t
     JOIN (
      SELECT '15m' AS interval_code
      UNION ALL SELECT '1h'
      UNION ALL SELECT '4h'
      UNION ALL SELECT '1d'
     ) intervals
     LEFT JOIN kline_cache k FORCE INDEX (uk_kline_symbol_interval_time)
       ON k.symbol=t.symbol
      AND k.interval_code=intervals.interval_code
      AND k.open_time >= CASE intervals.interval_code
        WHEN '15m' THEN :start15m
        WHEN '1h' THEN :start1h
        WHEN '4h' THEN :start4h
        WHEN '1d' THEN :start1d
      END
      AND k.open_time <= CASE intervals.interval_code
        WHEN '15m' THEN :latest15m
        WHEN '1h' THEN :latest1h
        WHEN '4h' THEN :latest4h
        WHEN '1d' THEN :latest1d
      END
     WHERE t.is_active=1
     GROUP BY t.symbol, intervals.interval_code
     ORDER BY t.symbol, FIELD(intervals.interval_code, '15m','1h','4h','1d')`,
    {
      start15m: targetStart["15m"],
      start1h: targetStart["1h"],
      start4h: targetStart["4h"],
      start1d: targetStart["1d"],
      latest15m: latestClosed["15m"],
      latest1h: latestClosed["1h"],
      latest4h: latestClosed["4h"],
      latest1d: latestClosed["1d"]
    }
  );
  const bySymbol = new Map();
  for (const row of rows) {
    if (!bySymbol.has(row.symbol)) bySymbol.set(row.symbol, new Map());
    if (row.intervalCode) bySymbol.get(row.symbol).set(row.intervalCode, row);
  }
  const availability = await getKlineAvailabilityMap([...bySymbol.keys()]);
  const deficient = [];
  for (const [symbol, intervals] of bySymbol) {
    for (const intervalCode of auditIntervals) {
      const row = intervals.get(intervalCode);
      const cachedCount = Number(row?.cachedCount ?? 0);
      const expectedCount = expectedCounts[intervalCode];
      const earliestOpenTime = row?.earliestOpenTime === null || row?.earliestOpenTime === undefined
        ? null
        : Number(row.earliestOpenTime);
      const latestOpenTime = row?.latestOpenTime === null || row?.latestOpenTime === undefined
        ? null
        : Number(row.latestOpenTime);
      const safeIntervalMs = intervalMs(intervalCode);
      const targetEndTime = latestClosed[intervalCode] ?? latestClosedKlineOpenTime(intervalCode);
      const targetStartTime = targetStart[intervalCode];
      const firstAvailableOpenTime = availability.get(`${symbol}|${intervalCode}`) ?? null;
      const naturalHistoryShortfall = isNaturalKlineHistoryShortfall({
        cachedCount,
        expectedCount,
        earliestOpenTime,
        firstAvailableOpenTime,
        targetStartTime,
        intervalMsValue: safeIntervalMs
      });
      const spanSlotCount =
        earliestOpenTime !== null && latestOpenTime !== null && latestOpenTime >= earliestOpenTime
          ? Math.floor((latestOpenTime - earliestOpenTime) / safeIntervalMs) + 1
          : cachedCount;
      const hasSpanGap = cachedCount > 1 && spanSlotCount > cachedCount;
      const internalGap = hasSpanGap
        ? await findKlineGap(symbol, intervalCode, safeIntervalMs, Math.max(targetStartTime, earliestOpenTime), targetEndTime)
        : null;
      const boundaryGap = internalGap ?? detectKlineTailGap(latestOpenTime, targetEndTime, safeIntervalMs);
      if ((cachedCount < expectedCount && !naturalHistoryShortfall) || boundaryGap) {
        deficient.push({
          symbol,
          intervalCode,
          cachedCount,
          expectedCount,
          missingCount: Math.max(0, expectedCount - cachedCount),
          earliestOpenTime,
          latestOpenTime,
          firstAvailableOpenTime,
          naturalHistoryShortfall,
          gapStartTime: boundaryGap?.startTime ?? null,
          gapEndTime: boundaryGap?.endTime ?? null,
          gapMissingCount: boundaryGap?.missingCount ?? 0,
          reason: boundaryGap ? "gap" : "count"
        });
      }
    }
  }
  return {
    activeTokenCount: bySymbol.size,
    checkedIntervalCount: bySymbol.size * 4,
    deficientIntervalCount: deficient.length,
    deficientTokenCount: new Set(deficient.map((item) => item.symbol)).size,
    deficient
  };
}

export async function cleanupInactiveTokens(retentionDays = 7) {
  const safeDays = Math.max(1, Math.floor(Number(retentionDays) || 7));
  const connection = await getPool().getConnection();
  try {
    await connection.beginTransaction();
    const [tokens] = await connection.query(
      `SELECT id, symbol
       FROM token_list
       WHERE is_active=0
         AND inactive_since IS NOT NULL
         AND inactive_since < DATE_SUB(NOW(3), INTERVAL :retentionDays DAY)
       FOR UPDATE`,
      { retentionDays: safeDays }
    );
    if (!tokens.length) {
      await connection.commit();
      return { retentionDays: safeDays, tokenCount: 0, deletedRows: 0, deletedByTable: {} };
    }

    const tokenIds = tokens.map((token) => token.id);
    const symbols = tokens.map((token) => token.symbol);
    const deletedByTable = {};
    for (const tableName of [
      "kline_availability",
      "hot_ma_signal_alert",
      "multi_cycle_history",
      "open_interest_monitor",
      "open_interest_sample",
      "funding_interval_state"
    ]) {
      const [result] = await connection.query(`DELETE FROM ${tableName} WHERE symbol IN (?)`, [symbols]);
      deletedByTable[tableName] = Number(result.affectedRows ?? 0);
    }
    const [unlockResult] = await connection.query(
      `DELETE FROM token_unlock_cache
       WHERE symbol IN (?)
         AND symbol NOT IN (SELECT symbol FROM watchlist)`,
      [symbols]
    );
    deletedByTable.token_unlock_cache = Number(unlockResult.affectedRows ?? 0);

    const [klineCountRows] = await connection.query(
      "SELECT COUNT(*) AS rowCount FROM kline_cache WHERE token_id IN (?)",
      [tokenIds]
    );
    const [tokenResult] = await connection.query("DELETE FROM token_list WHERE id IN (?)", [tokenIds]);
    deletedByTable.token_list = Number(tokenResult.affectedRows ?? 0);
    const deletedRows = Number(klineCountRows[0]?.rowCount ?? 0);
    await connection.commit();
    return {
      retentionDays: safeDays,
      tokenCount: tokens.length,
      deletedRows,
      deletedByTable
    };
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}

export async function countActiveTokens() {
  const [rows] = await getPool().query("SELECT COUNT(*) AS count FROM token_list WHERE is_active=1");
  return Number(rows[0]?.count ?? 0);
}

export async function resetInterruptedFetchingTokens(staleAfterMs) {
  const staleSeconds = Math.max(0, Math.floor((Number(staleAfterMs) || 0) / 1000));
  const [result] = await getPool().query(
    `UPDATE token_list
     SET fetch_status=IF(fetched_interval_count > 0, 'partial', 'pending'),
         current_interval=NULL,
         last_error=COALESCE(last_error, '上次抓取中断，已重新排队')
     WHERE fetch_status='fetching'
       AND updated_at < DATE_SUB(NOW(3), INTERVAL :staleSeconds SECOND)`,
    { staleSeconds }
  );
  return result.affectedRows ?? 0;
}

export async function claimNextTokenForFetch({ incrementalCutoffAt = null } = {}) {
  const connection = await getPool().getConnection();
  try {
    const incrementalRefreshCondition = incrementalCutoffAt
      ? `OR (fetch_status='completed' AND (cache_policy_key IS NULL OR cache_policy_key <> :cachePolicyKey))
          OR (fetch_status='completed' AND (cache_completed_at IS NULL OR cache_completed_at < :incrementalCutoffAt))`
      : "";
    await connection.beginTransaction();
    const [rows] = await connection.query(
      `SELECT * FROM token_list
     WHERE is_active=1
       AND (fetch_status IN ('pending','partial','failed')
          ${incrementalRefreshCondition})
       ORDER BY
        CASE fetch_status WHEN 'partial' THEN 0 WHEN 'failed' THEN 1 WHEN 'completed' THEN 2 ELSE 3 END,
        category_type ASC,
        updated_at ASC
       LIMIT 1
       FOR UPDATE SKIP LOCKED`,
      { cachePolicyKey: config.crawler.cachePolicyKey, incrementalCutoffAt }
    );
    const token = rows[0] ?? null;
    if (!token) {
      await connection.commit();
      return null;
    }
    await connection.query(
      `UPDATE token_list
       SET fetch_status='fetching', current_interval=NULL, last_error=NULL
       WHERE id=:tokenId`,
      { tokenId: token.id }
    );
    await connection.commit();
    return { ...token, fetch_status: "fetching", current_interval: null, last_error: null };
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}

export async function markTokenFetching(tokenId, intervalCode) {
  await getPool().query(
    `UPDATE token_list
     SET fetch_status='fetching', current_interval=:intervalCode, fetch_attempts=fetch_attempts+1, last_error=NULL
     WHERE id=:tokenId`,
    { tokenId, intervalCode }
  );
}

export async function markTokenPartial(tokenId, error) {
  await getPool().query(
    `UPDATE token_list
     SET fetch_status='partial', current_interval=NULL, last_error=:error
     WHERE id=:tokenId`,
    { tokenId, error: String(error).slice(0, 1000) }
  );
}

export async function refreshTokenFetchState(tokenId) {
  const intervalRowsSql = KLINE_COMPLETION_INTERVALS
    .map((_, index) => `SELECT :interval${index} AS interval_code, :targetStart${index} AS target_start_time, :targetEnd${index} AS target_end_time`)
    .join(" UNION ALL ");
  const params = { tokenId };
  KLINE_COMPLETION_INTERVALS.forEach((intervalCode, index) => {
    const target = klineCompletionTarget(intervalCode);
    params[`interval${index}`] = intervalCode;
    params[`targetStart${index}`] = target.targetStartTime;
    params[`targetEnd${index}`] = target.targetEndTime;
  });
  const [rows] = await getPool().query(
    `SELECT intervals.interval_code AS intervalCode,
      COUNT(k.id) AS cachedCount,
      MIN(k.open_time) AS earliestOpenTime,
      MAX(k.open_time) AS latestOpenTime,
      MAX(a.first_open_time) AS firstAvailableOpenTime
     FROM token_list t
     JOIN (${intervalRowsSql}) intervals
     LEFT JOIN kline_cache k FORCE INDEX (idx_kline_token_interval_time)
       ON k.token_id=t.id
      AND k.interval_code=intervals.interval_code
      AND k.open_time >= intervals.target_start_time
      AND k.open_time <= intervals.target_end_time
     LEFT JOIN kline_availability a
       ON a.symbol=t.symbol
      AND a.interval_code=intervals.interval_code
     WHERE t.id=:tokenId
     GROUP BY intervals.interval_code
     ORDER BY FIELD(intervals.interval_code, '15m','1h','4h','1d')`,
    params
  );
  const completion = summarizeTokenKlineCompletion(rows);
  await getPool().query(
    `UPDATE token_list
     SET fetched_interval_count=:fetchedIntervalCount,
         fetch_status=:fetchStatus,
         current_interval=NULL,
         cache_completed_at=IF(:completed, NOW(3), NULL),
         cache_policy_key=IF(:completed, :cachePolicyKey, NULL)
     WHERE id=:tokenId`,
    {
      tokenId,
      fetchedIntervalCount: completion.fetchedIntervalCount,
      fetchStatus: completion.fetchStatus,
      completed: completion.completed ? 1 : 0,
      cachePolicyKey: config.crawler.cachePolicyKey
    }
  );
  return completion.fetchedIntervalCount;
}

export async function klineStats(symbol, intervalCode) {
  const [rows] = await getPool().query(
    `SELECT
      COUNT(*) AS count,
      MIN(open_time) AS minOpenTime,
      MAX(open_time) AS maxOpenTime
     FROM kline_cache
     WHERE symbol=:symbol AND interval_code=:intervalCode`,
    { symbol, intervalCode }
  );
  const row = rows[0] ?? {};
  return {
    count: Number(row.count ?? 0),
    minOpenTime: row.minOpenTime === null || row.minOpenTime === undefined ? null : Number(row.minOpenTime),
    maxOpenTime: row.maxOpenTime === null || row.maxOpenTime === undefined ? null : Number(row.maxOpenTime)
  };
}

export async function listKlineTailRefreshTargets({
  intervals = ["15m", "1h", "4h", "1d"],
  limit = config.crawler.tailRefreshLimit
} = {}) {
  const safeIntervals = [
    ...new Set(
      (Array.isArray(intervals) ? intervals : [intervals])
        .map(normalizeIntervalCode)
        .filter(Boolean)
    )
  ];
  if (!safeIntervals.length) return [];

  const intervalRows = safeIntervals
    .map((_, index) => `SELECT :interval${index} AS interval_code, :targetEnd${index} AS target_end_time, :targetClose${index} AS target_close_time`)
    .join(" UNION ALL ");
  const params = {
    limit: Math.max(1, Math.min(10_000, Number(limit) || config.crawler.tailRefreshLimit))
  };
  safeIntervals.forEach((intervalCode, index) => {
    const targetEndTime = latestClosedKlineOpenTime(intervalCode);
    params[`interval${index}`] = intervalCode;
    params[`targetEnd${index}`] = targetEndTime;
    params[`targetClose${index}`] = new Date(targetEndTime + intervalMs(intervalCode) - 1);
  });

  const [rows] = await getPool().query(
    `SELECT t.id, t.symbol, t.base_asset AS baseAsset,
      t.category_type AS categoryType, t.category_label AS categoryLabel,
      intervals.interval_code AS intervalCode,
      s.signal_time AS signalTime,
      intervals.target_end_time AS targetEndTime
     FROM token_list t
     JOIN (${intervalRows}) intervals
     LEFT JOIN signal_result s
       ON s.symbol=t.symbol
      AND s.interval_code=intervals.interval_code
     WHERE t.is_active=1
       AND (s.signal_time IS NULL OR s.signal_time < intervals.target_close_time)
     ORDER BY
      FIELD(intervals.interval_code, '15m','1h','4h','1d'),
      s.signal_time IS NULL DESC,
      s.signal_time ASC,
      t.symbol ASC
     LIMIT :limit`,
    params
  );

  return rows.map((row) => {
    const signalTimeMs = row.signalTime === null || row.signalTime === undefined
      ? null
      : new Date(row.signalTime).getTime();
    const targetEndTime = Number(row.targetEndTime);
    const latestOpenTime = Number.isFinite(signalTimeMs)
      ? Math.floor(signalTimeMs / intervalMs(row.intervalCode)) * intervalMs(row.intervalCode)
      : null;
    const tailGap = latestOpenTime === null
      ? null
      : detectKlineTailGap(latestOpenTime, targetEndTime, intervalMs(row.intervalCode));
    return {
      id: row.id,
      symbol: sanitizeDbSymbol(row.symbol),
      baseAsset: row.baseAsset,
      categoryType: row.categoryType,
      categoryLabel: row.categoryLabel,
      intervalCode: row.intervalCode,
      latestOpenTime,
      targetEndTime,
      gapStartTime: tailGap?.startTime ?? null,
      gapEndTime: tailGap?.endTime ?? null,
      missingCount: tailGap?.missingCount ?? null
    };
  });
}

export async function markKlineAvailabilityStart(symbol, intervalCode, firstOpenTime, source = "binance") {
  const safeSymbol = sanitizeDbSymbol(symbol);
  const safeIntervalCode = normalizeIntervalCode(intervalCode);
  const safeFirstOpenTime = Math.max(0, Math.floor(Number(firstOpenTime) || 0));
  if (!safeSymbol || !safeIntervalCode || !safeFirstOpenTime) return false;
  await getPool().query(
    `INSERT INTO kline_availability (symbol, interval_code, first_open_time, source, last_checked_at)
     VALUES (:symbol, :intervalCode, :firstOpenTime, :source, NOW(3))
     ON DUPLICATE KEY UPDATE
      first_open_time=LEAST(first_open_time, VALUES(first_open_time)),
      source=VALUES(source),
      last_checked_at=NOW(3)`,
    {
      symbol: safeSymbol,
      intervalCode: safeIntervalCode,
      firstOpenTime: safeFirstOpenTime,
      source: String(source || "binance").slice(0, 32)
    }
  );
  return true;
}

async function getKlineAvailabilityRows(symbols = []) {
  const safeSymbols = [...new Set((Array.isArray(symbols) ? symbols : [symbols]).map(sanitizeDbSymbol).filter(Boolean))];
  const [rows] = safeSymbols.length
    ? await getPool().query(
        `SELECT symbol, interval_code AS intervalCode, first_open_time AS firstOpenTime
         FROM kline_availability
         WHERE symbol IN (:symbols)`,
        { symbols: safeSymbols }
      )
    : await getPool().query(
        `SELECT symbol, interval_code AS intervalCode, first_open_time AS firstOpenTime
         FROM kline_availability`
      );
  return rows.map((row) => ({
    symbol: sanitizeDbSymbol(row.symbol),
    intervalCode: row.intervalCode,
    firstOpenTime: Number(row.firstOpenTime)
  }));
}

async function getKlineAvailabilityMap(symbols = []) {
  const rows = await getKlineAvailabilityRows(symbols);
  const map = new Map();
  for (const row of rows) {
    map.set(`${row.symbol}|${row.intervalCode}`, row.firstOpenTime);
  }
  return map;
}

export async function findKlineGap(symbol, intervalCode, intervalMsValue, startTime, endTime) {
  const gaps = await listKlineGaps(symbol, intervalCode, intervalMsValue, startTime, endTime, 1);
  return gaps[0] ?? null;
}

export async function listKlineGaps(symbol, intervalCode, intervalMsValue, startTime, endTime, limit = 200) {
  const safeSymbol = String(symbol ?? "").toUpperCase().replace(/[^A-Z0-9_]/g, "");
  const [rows] = await getPool().query(
    `SELECT open_time AS openTime
     FROM kline_cache
     WHERE symbol=:symbol
       AND interval_code=:intervalCode
       AND open_time>=:startTime
       AND open_time<=:endTime
     ORDER BY open_time ASC`,
    {
      symbol: safeSymbol,
      intervalCode,
      startTime: Math.max(0, Number(startTime) || 0),
      endTime: Math.max(0, Number(endTime) || 0)
    }
  );
  if (rows.length < 2) return [];
  const safeLimit = Math.max(1, Math.min(1000, Number(limit) || 200));
  const gaps = [];
  let previousOpenTime = Number(rows[0].openTime);
  const safeIntervalMs = Math.max(1, Number(intervalMsValue) || 1);
  for (const row of rows.slice(1)) {
    const currentOpenTime = Number(row.openTime);
    const expectedOpenTime = previousOpenTime + safeIntervalMs;
    if (currentOpenTime > expectedOpenTime) {
      gaps.push({
        startTime: expectedOpenTime,
        endTime: currentOpenTime - safeIntervalMs,
        missingCount: Math.max(1, Math.round((currentOpenTime - expectedOpenTime) / safeIntervalMs))
      });
      if (gaps.length >= safeLimit) break;
    }
    previousOpenTime = currentOpenTime;
  }
  return gaps;
}

export async function upsertKlinePage(token, intervalCode, klines) {
  if (klines.length === 0) return 0;
  const rows = klines.map((kline) => [
    token.id,
    token.symbol,
    intervalCode,
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
  const [result] = await withRetryableDatabaseQuery(() =>
    getPool().query(
      `INSERT INTO kline_cache
        (token_id, symbol, interval_code, open_time, close_time, open_price, high_price, low_price, close_price, volume, quote_volume, trade_count)
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
    )
  );
  return result.affectedRows ?? 0;
}

export async function selectClosePrices(symbol, intervalCode) {
  const latestClosedOpenTime = latestClosedKlineOpenTime(intervalCode);
  const [rows] = await getPool().query(
    `SELECT closePrice, closeTime
     FROM (
       SELECT close_price AS closePrice, close_time AS closeTime, open_time
       FROM kline_cache
       WHERE symbol=:symbol AND interval_code=:intervalCode
         AND open_time<=:latestClosedOpenTime
       ORDER BY open_time DESC
       LIMIT 200
     ) recent
     ORDER BY open_time ASC`,
    { symbol, intervalCode, latestClosedOpenTime }
  );
  return rows.map((row) => ({
    close: Number(row.closePrice),
    closeTime: Number(row.closeTime)
  }));
}

export async function selectPreviousSignals(symbol) {
  const safeSymbol = sanitizeDbSymbol(symbol);
  if (!safeSymbol) return new Map();
  const [rows] = await getPool().query(
    "SELECT * FROM signal_result WHERE symbol=:symbol",
    { symbol: safeSymbol }
  );
  return new Map(rows.map((row) => [row.interval_code, row]));
}

export async function upsertSignals(token, signals) {
  const normalized = (signals ?? []).filter((signal) => signal?.intervalCode);
  if (!normalized.length) return 0;
  const rows = normalized.map((signal) => [
    token.id,
    token.symbol,
    token.category_type,
    signal.intervalCode,
    signal.ma100,
    signal.ma200,
    signal.currentPrice,
    signal.alertLevel,
    signal.proximityPct,
    signal.signalWeight,
    signal.signalStatus,
    signal.note,
    new Date(Number(signal.signalTime) || Date.now())
  ]);
  const [result] = await withRetryableDatabaseQuery(() =>
    getPool().query(
      `INSERT INTO signal_result
        (token_id, symbol, category_type, interval_code, ma100, ma200, current_price, alert_level, proximity_pct, signal_weight, signal_status, note, signal_time)
       VALUES ?
       ON DUPLICATE KEY UPDATE
        token_id=VALUES(token_id),
        category_type=VALUES(category_type),
        ma100=VALUES(ma100),
        ma200=VALUES(ma200),
        current_price=VALUES(current_price),
        proximity_pct=VALUES(proximity_pct),
        signal_weight=VALUES(signal_weight),
        signal_status=VALUES(signal_status),
        note=VALUES(note),
        signal_time=VALUES(signal_time),
        alert_level=VALUES(alert_level)`,
      [rows]
    )
  );
  return result.affectedRows ?? 0;
}

export async function upsertSignal(token, signal) {
  return upsertSignals(token, [signal]);
}

function rollingAverage(rows, index, size) {
  if (index + 1 < size) return null;
  let sum = 0;
  for (let offset = index - size + 1; offset <= index; offset += 1) {
    sum += rows[offset].close;
  }
  return Number((sum / size).toFixed(12));
}

function collectKlineGaps(rows, intervalCode) {
  const safeIntervalMs = intervalMs(intervalCode);
  const gaps = [];
  let previous = null;
  for (const row of rows) {
    if (previous) {
      const missingCount = Math.round((row.openTime - previous.openTime) / safeIntervalMs) - 1;
      if (missingCount > 0) {
        gaps.push({
          startTime: previous.openTime + safeIntervalMs,
          endTime: row.openTime - safeIntervalMs,
          missingCount
        });
      }
    }
    previous = row;
  }
  return gaps;
}

export async function getKlines({ symbol, intervalCode, limit = 240 }) {
  const safeSymbol = String(symbol ?? "").toUpperCase().replace(/[^A-Z0-9_]/g, "");
  const allRows = limit === "all";
  const expectedCount = Math.max(200, Number(config.crawler.retentionLimits[intervalCode]) || 200);
  const safeIntervalMs = intervalMs(intervalCode);
  const currentSlotOpenTime = Math.floor(Date.now() / safeIntervalMs) * safeIntervalMs;
  const latestExpectedOpenTime = currentSlotOpenTime - safeIntervalMs;
  const safeLimit = allRows
    ? Math.max(200, Math.min(20_000, expectedCount))
    : Math.max(50, Math.min(1000, Number(limit) || 240));
  const expandedLimit = allRows ? safeLimit : safeLimit + 199;
  const [rows] = await getPool().query(
    `SELECT open_time AS openTime, close_time AS closeTime,
      open_price AS openPrice, high_price AS highPrice, low_price AS lowPrice,
      close_price AS closePrice, volume
     FROM (
      SELECT *
      FROM kline_cache
      WHERE symbol=:symbol AND interval_code=:intervalCode
        AND open_time<:currentSlotOpenTime
      ORDER BY open_time DESC
      LIMIT :expandedLimit
     ) recent
     ORDER BY open_time ASC`,
    { symbol: safeSymbol, intervalCode, currentSlotOpenTime, expandedLimit }
  );
  const [currentRows] = await getPool().query(
    `SELECT open_time AS openTime, close_time AS closeTime,
      open_price AS openPrice, high_price AS highPrice, low_price AS lowPrice,
      close_price AS closePrice, volume
     FROM kline_cache
     WHERE symbol=:symbol AND interval_code=:intervalCode
       AND open_time=:currentSlotOpenTime
     LIMIT 1`,
    { symbol: safeSymbol, intervalCode, currentSlotOpenTime }
  );

  const normalizeRow = (row) => ({
    openTime: Number(row.openTime),
    closeTime: Number(row.closeTime),
    open: Number(row.openPrice),
    high: Number(row.highPrice),
    low: Number(row.lowPrice),
    close: Number(row.closePrice),
    volume: Number(row.volume)
  });

  const normalized = rows.map(normalizeRow);
  const currentKline = currentRows[0] ? { ...normalizeRow(currentRows[0]), isOpen: true } : null;
  const maSource = currentKline ? [...normalized, currentKline] : normalized;
  const gaps = collectKlineGaps(normalized, intervalCode);
  const gapStartTimes = new Set(gaps.map((gap) => gap.endTime + intervalMs(intervalCode)));
  const withMa = normalized.map((row, index) => ({
    ...row,
    gapBefore: gapStartTimes.has(row.openTime),
    ma100: rollingAverage(maSource, index, 100),
    ma200: rollingAverage(maSource, index, 200)
  }));
  const currentWithMa = currentKline
    ? {
        ...currentKline,
        gapBefore: normalized.at(-1)
          ? Math.round((currentKline.openTime - Number(normalized.at(-1).openTime)) / safeIntervalMs) > 1
          : false,
        ma100: rollingAverage(maSource, maSource.length - 1, 100),
        ma200: rollingAverage(maSource, maSource.length - 1, 200)
      }
    : null;
  const klines = allRows
    ? [...withMa, currentWithMa].filter(Boolean)
    : [...withMa.slice(-safeLimit), currentWithMa].filter(Boolean);
  const visibleStart = klines[0]?.openTime ?? null;
  const visibleEnd = klines.at(-1)?.openTime ?? null;
  const visibleGaps = gaps.filter((gap) =>
    visibleStart !== null &&
    visibleEnd !== null &&
    gap.endTime >= visibleStart &&
    gap.startTime <= visibleEnd
  );
  const staleBeforeOpenTime = latestExpectedOpenTime;
  const latestOpenTime = withMa.at(-1)?.openTime ?? null;
  const isStale = latestOpenTime === null || latestOpenTime < staleBeforeOpenTime;
  const availability = await getKlineAvailabilityMap([safeSymbol]);
  const firstAvailableOpenTime = availability.get(`${safeSymbol}|${intervalCode}`) ?? null;
  const naturalHistoryShortfall = isNaturalKlineHistoryShortfall({
    cachedCount: withMa.length,
    expectedCount,
    earliestOpenTime: withMa[0]?.openTime ?? null,
    firstAvailableOpenTime,
    targetStartTime: latestExpectedOpenTime - (expectedCount - 1) * safeIntervalMs,
    intervalMsValue: safeIntervalMs
  });
  const hasCoverageShortfall = withMa.length < expectedCount && !naturalHistoryShortfall;
  const needsRefresh = isStale || hasCoverageShortfall || gaps.length > 0;

  return {
    symbol: safeSymbol,
    intervalCode,
    limit: allRows ? "all" : safeLimit,
    expectedCount,
    cachedCount: withMa.length,
    coveragePercent: Number(Math.min(100, (withMa.length / expectedCount) * 100).toFixed(2)),
    earliestOpenTime: withMa[0]?.openTime ?? null,
    latestOpenTime,
    currentSlotOpenTime,
    currentKlineOpenTime: currentWithMa?.openTime ?? null,
    hasCurrentKline: Boolean(currentWithMa),
    firstAvailableOpenTime,
    naturalHistoryShortfall,
    latestExpectedOpenTime,
    staleBeforeOpenTime,
    isStale,
    needsRefresh,
    refreshReason: needsRefresh
      ? [
          isStale ? "stale_latest" : null,
          hasCoverageShortfall ? "coverage_shortfall" : null,
          gaps.length > 0 ? "gap" : null
        ].filter(Boolean).join(",")
      : null,
    hasMa200: withMa.length >= 200,
    gapCount: visibleGaps.length,
    missingKlineCount: visibleGaps.reduce((sum, gap) => sum + gap.missingCount, 0),
    gaps: visibleGaps,
    klines
  };
}
