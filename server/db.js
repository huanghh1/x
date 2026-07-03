import { config } from "./config.js";
import { evaluateOpenInterestSpike } from "./openInterestSpike.js";
import { resolveBestAlertLevel, resolveSignalProfile, SIGNAL_PRIORITY } from "./signalPriority.js";
import { getPool } from "./db/connection.js";
import { baseAssetAliases, baseAssetFromSymbol, sanitizeDbSymbol } from "./db/symbols.js";
export { ensureDatabase, getPool, pingDatabase } from "./db/connection.js";
export {
  clearTriggerHistory,
  deleteTriggerHistory,
  listTriggerHistory,
  recordTriggerHistory,
  recordTriggerHistoryBatch
} from "./db/triggerHistoryRepository.js";
export {
  claimTelegramAlerts,
  enqueueTelegramAlert,
  getTelegramAlertQueueStats,
  markTelegramAlertFailed,
  markTelegramAlertSent
} from "./db/telegramAlertRepository.js";
export {
  createTradeJournalEntry,
  createTradeJournalIntradayNote,
  deleteTradeJournalEntry,
  getTradeJournalEntry,
  listTradeJournal,
  updateTradeJournalEntry
} from "./db/tradeJournalRepository.js";
export {
  readTradeEventHistoryAnalysis,
  upsertTradeEventHistory
} from "./db/tradeHistoryRepository.js";
export {
  markHotRankNotified,
  normalizeHotRankSeenTokens,
  recordHotRankSnapshot
} from "./db/hotRankRepository.js";
export {
  collectHotRankFundingSymbols,
  listOneHourFundingIntervals,
  listPendingFundingIntervalAlerts,
  listTopFundingRealtimeTokens,
  markFundingIntervalAlertConfirmed,
  markFundingIntervalAlertSent,
  markFundingIntervalsMissingFromSnapshot,
  normalizeFundingIntervalSnapshotItems,
  recordFundingIntervalSnapshot
} from "./db/fundingIntervalRepository.js";
export {
  getActiveTokenBySymbol,
  getOpenInterestMonitorItem,
  getOpenInterestSampleBaselines,
  getSignalCorrelationContext,
  listOpenInterestMonitor,
  listOpenInterestMonitorPage,
  listOpenInterestScanTokens,
  listTopOpenInterestRealtimeTokens,
  markOpenInterestSpikeAlertSent,
  normalizeOptionalLimit,
  selectOpenInterestSampleBaselines,
  upsertOpenInterestSamples,
  upsertOpenInterestSnapshot
} from "./db/openInterestRepository.js";
export {
  addWatchlistItemsIfMissing,
  clearWatchlistAlertSide,
  deleteWatchlistItem,
  getTokenUnlockCache,
  listWatchlist,
  listWatchlistTokens,
  listWatchlistUnlockTargets,
  markWatchlistAlertSent,
  normalizeWatchlistAlertPrice,
  normalizeWatchlistPayload,
  updateWatchlistRealtimePrice,
  upsertTokenUnlockCache,
  upsertWatchlistItem
} from "./db/watchlistRepository.js";

const KLINE_COMPLETION_INTERVALS = ["15m", "1h", "4h", "1d"];

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
  const rows = tokens.map((token) => [
    token.symbol,
    token.baseAsset,
    "USDT",
    token.categoryType,
    token.categoryLabel,
    token.hasSpot ? 1 : 0,
    token.hasFutures ? 1 : 0,
    token.isAlpha ? 1 : 0
  ]);
  await getPool().query(
    `INSERT INTO token_list
      (symbol, base_asset, quote_asset, category_type, category_label, has_spot, has_futures, is_alpha)
     VALUES ?
     ON DUPLICATE KEY UPDATE
      base_asset = VALUES(base_asset),
      category_type = VALUES(category_type),
      category_label = VALUES(category_label),
      has_spot = VALUES(has_spot),
      has_futures = VALUES(has_futures),
      is_alpha = VALUES(is_alpha)`,
    [rows]
  );
  const symbols = tokens.map((token) => token.symbol);
  if (symbols.length > 0) {
    await getPool().query(
      "UPDATE token_list SET is_active=1, inactive_since=NULL WHERE symbol IN (?)",
      [symbols]
    );
    await getPool().query(
      `UPDATE token_list
       SET is_active=0, inactive_since=COALESCE(inactive_since, NOW(3))
       WHERE symbol NOT IN (?) AND is_active=1`,
      [symbols]
    );
  }
  return rows.length;
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

export async function cleanupInactiveTokenKlines(retentionDays = 7) {
  const safeDays = Math.max(1, Math.floor(Number(retentionDays) || 7));
  const [countRows] = await getPool().query(
    `SELECT COUNT(*) AS rowCount, COUNT(DISTINCT token_id) AS tokenCount
     FROM kline_cache
     WHERE token_id IN (
       SELECT id FROM token_list
       WHERE is_active=0
         AND inactive_since IS NOT NULL
         AND inactive_since < DATE_SUB(NOW(3), INTERVAL :retentionDays DAY)
     )`,
    { retentionDays: safeDays }
  );
  const [result] = await getPool().query(
    `DELETE FROM kline_cache
     WHERE token_id IN (
       SELECT id FROM token_list
       WHERE is_active=0
         AND inactive_since IS NOT NULL
         AND inactive_since < DATE_SUB(NOW(3), INTERVAL :retentionDays DAY)
     )`,
    { retentionDays: safeDays }
  );
  return {
    retentionDays: safeDays,
    tokenCount: Number(countRows[0]?.tokenCount ?? 0),
    deletedRows: Number(result.affectedRows ?? 0)
  };
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

function intervalMs(intervalCode) {
  return {
    "15m": 15 * 60 * 1000,
    "1h": 60 * 60 * 1000,
    "4h": 4 * 60 * 60 * 1000,
    "1d": 24 * 60 * 60 * 1000
  }[intervalCode] ?? 60 * 60 * 1000;
}

function latestClosedKlineOpenTimeAt(intervalCode, now = Date.now()) {
  const ms = intervalMs(intervalCode);
  return Math.floor(Number(now) / ms) * ms - ms;
}

function latestClosedKlineOpenTime(intervalCode) {
  return latestClosedKlineOpenTimeAt(intervalCode);
}

function klineCompletionTarget(intervalCode, retentionLimits = config.crawler.retentionLimits, now = Date.now()) {
  const expectedCount = Math.max(200, Number(retentionLimits?.[intervalCode]) || 200);
  const targetEndTime = latestClosedKlineOpenTimeAt(intervalCode, now);
  return {
    expectedCount,
    targetEndTime,
    targetStartTime: targetEndTime - (expectedCount - 1) * intervalMs(intervalCode)
  };
}

function nullableNumber(value) {
  if (value === null || value === undefined) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

export function summarizeTokenKlineCompletion(rows = [], {
  retentionLimits = config.crawler.retentionLimits,
  now = Date.now()
} = {}) {
  const rowByInterval = new Map(
    (Array.isArray(rows) ? rows : [])
      .map((row) => [normalizeIntervalCode(row?.intervalCode ?? row?.interval_code), row])
      .filter(([intervalCode]) => intervalCode)
  );
  let fetchedIntervalCount = 0;
  let completeIntervalCount = 0;
  const incompleteIntervals = [];

  for (const intervalCode of KLINE_COMPLETION_INTERVALS) {
    const row = rowByInterval.get(intervalCode) ?? {};
    const cachedCount = Math.max(0, Number(row.cachedCount ?? row.cached_count ?? 0) || 0);
    const earliestOpenTime = nullableNumber(row.earliestOpenTime ?? row.earliest_open_time);
    const latestOpenTime = nullableNumber(row.latestOpenTime ?? row.latest_open_time);
    const firstAvailableOpenTime = nullableNumber(row.firstAvailableOpenTime ?? row.first_available_open_time);
    const target = klineCompletionTarget(intervalCode, retentionLimits, now);
    const hasRows = cachedCount > 0;
    if (hasRows) fetchedIntervalCount += 1;
    const naturalHistoryShortfall = isNaturalKlineHistoryShortfall({
      cachedCount,
      expectedCount: target.expectedCount,
      earliestOpenTime,
      firstAvailableOpenTime,
      targetStartTime: target.targetStartTime,
      intervalMsValue: intervalMs(intervalCode)
    });
    const hasFreshTail = latestOpenTime !== null && latestOpenTime >= target.targetEndTime;
    const hasTargetCoverage = cachedCount >= target.expectedCount || naturalHistoryShortfall;
    if (hasRows && hasFreshTail && hasTargetCoverage) {
      completeIntervalCount += 1;
    } else {
      incompleteIntervals.push({
        intervalCode,
        cachedCount,
        expectedCount: target.expectedCount,
        latestOpenTime,
        targetEndTime: target.targetEndTime,
        naturalHistoryShortfall
      });
    }
  }

  const completed = completeIntervalCount >= KLINE_COMPLETION_INTERVALS.length;
  return {
    fetchedIntervalCount,
    completeIntervalCount,
    completed,
    fetchStatus: completed ? "completed" : (fetchedIntervalCount > 0 ? "partial" : "pending"),
    incompleteIntervals
  };
}

function normalizeIntervalCode(value) {
  return ["15m", "1h", "4h", "1d"].includes(value) ? value : null;
}

export function isNaturalKlineHistoryShortfall({
  cachedCount,
  expectedCount,
  earliestOpenTime,
  firstAvailableOpenTime,
  targetStartTime,
  intervalMsValue
} = {}) {
  const safeCachedCount = Number(cachedCount);
  const safeExpectedCount = Number(expectedCount);
  const safeEarliestOpenTime = Number(earliestOpenTime);
  const safeFirstAvailableOpenTime = Number(firstAvailableOpenTime);
  const safeTargetStartTime = Number(targetStartTime);
  const safeIntervalMs = Math.max(1, Number(intervalMsValue) || 1);
  if (!Number.isFinite(safeCachedCount) || !Number.isFinite(safeExpectedCount)) return false;
  if (safeCachedCount <= 0 || safeCachedCount >= safeExpectedCount) return false;
  if (
    !Number.isFinite(safeEarliestOpenTime) ||
    !Number.isFinite(safeFirstAvailableOpenTime) ||
    !Number.isFinite(safeTargetStartTime)
  ) {
    return false;
  }
  if (safeFirstAvailableOpenTime <= safeTargetStartTime) return false;
  return Math.abs(safeEarliestOpenTime - safeFirstAvailableOpenTime) <= safeIntervalMs;
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

export function detectKlineTailGap(latestOpenTime, targetEndTime, intervalMsValue) {
  if (latestOpenTime === null || latestOpenTime === undefined || targetEndTime === null || targetEndTime === undefined) {
    return null;
  }
  const safeLatestOpenTime = Number(latestOpenTime);
  const safeTargetEndTime = Number(targetEndTime);
  const safeIntervalMs = Math.max(1, Number(intervalMsValue) || 1);
  if (!Number.isFinite(safeLatestOpenTime) || !Number.isFinite(safeTargetEndTime)) return null;
  const startTime = safeLatestOpenTime + safeIntervalMs;
  if (startTime > safeTargetEndTime) return null;
  return {
    startTime,
    endTime: safeTargetEndTime,
    missingCount: Math.max(1, Math.round((safeTargetEndTime - startTime) / safeIntervalMs) + 1)
  };
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

function nextTurn() {
  return new Promise((resolve) => setImmediate(resolve));
}

async function deleteInBatches(sql, params, batchSize = config.maintenance.deleteBatchSize) {
  const safeBatchSize = Math.max(100, Math.min(20_000, Number(batchSize) || 5000));
  let deletedRows = 0;
  while (true) {
    const [result] = await getPool().query(`${sql} LIMIT :deleteBatchSize`, {
      ...params,
      deleteBatchSize: safeBatchSize
    });
    const affectedRows = Number(result.affectedRows ?? 0);
    deletedRows += affectedRows;
    if (affectedRows < safeBatchSize) break;
    await nextTurn();
  }
  return deletedRows;
}

export async function cleanupKlineRetention(symbol, intervalCode, retentionLimit) {
  const safeLimit = Math.max(200, Number(retentionLimit) || 0);
  const [cutoffRows] = await getPool().query(
    `SELECT open_time AS cutoffOpenTime
     FROM kline_cache
     WHERE symbol=:symbol AND interval_code=:intervalCode
     ORDER BY open_time DESC
     LIMIT 1 OFFSET :offset`,
    { symbol, intervalCode, offset: safeLimit - 1 }
  );
  const cutoffOpenTime = cutoffRows[0]?.cutoffOpenTime;
  if (cutoffOpenTime === undefined || cutoffOpenTime === null) return 0;

  return deleteInBatches(
    `DELETE FROM kline_cache
     WHERE symbol=:symbol
       AND interval_code=:intervalCode
       AND open_time < :cutoffOpenTime`,
    { symbol, intervalCode, cutoffOpenTime: Number(cutoffOpenTime) }
  );
}

export async function cleanupAllKlineRetention(retentionLimits) {
  const results = [];
  for (const [intervalCode, retentionLimit] of Object.entries(retentionLimits)) {
    const [symbols] = await getPool().query(
      `SELECT symbol
       FROM kline_cache
       WHERE interval_code=:intervalCode
       GROUP BY symbol`,
      { intervalCode }
    );
    let deletedRows = 0;
    for (const row of symbols) {
      deletedRows += await cleanupKlineRetention(row.symbol, intervalCode, retentionLimit);
      await nextTurn();
    }
    results.push({
      intervalCode,
      retentionLimit,
      symbolCount: symbols.length,
      deletedRows
    });
  }
  return results;
}

export async function cleanupTriggerHistoryRetention(
  retentionHours = config.maintenance.triggerHistoryRetentionHours
) {
  const safeHours = Math.max(1, Number(retentionHours) || 4);
  return deleteInBatches(
    "DELETE FROM signal_trigger_history WHERE trigger_time < DATE_SUB(NOW(3), INTERVAL :retentionHours HOUR)",
    { retentionHours: safeHours }
  );
}

export async function cleanupExpiredData() {
  const hotRankDays = Math.max(1, Number(config.maintenance.hotRankRetentionDays) || 7);
  const ioDays = Math.max(1, Number(config.maintenance.ioRetentionDays) || 7);
  const oiSampleDays = Math.max(2, Number(config.openInterestMonitor.sampleRetentionDays) || 3);
  // trade_event_history is the durable archive for API-limited trade analysis data; do not expire it here.
  const [triggerHistory, hotSnapshots, staleHotRows, staleOpenInterest, staleOpenInterestSamples, staleTelegramAlerts, staleUnlocks] = await Promise.all([
    cleanupTriggerHistoryRetention(),
    deleteInBatches(
      "DELETE FROM hot_rank_snapshot WHERE snapshot_time < DATE_SUB(NOW(3), INTERVAL :retentionDays DAY)",
      { retentionDays: hotRankDays }
    ),
    deleteInBatches(
      "DELETE FROM hot_rank_seen WHERE last_seen_at < DATE_SUB(NOW(3), INTERVAL :retentionDays DAY)",
      { retentionDays: hotRankDays }
    ),
    deleteInBatches(
      "DELETE FROM open_interest_monitor WHERE observed_at < DATE_SUB(NOW(3), INTERVAL :retentionDays DAY)",
      { retentionDays: ioDays }
    ),
    deleteInBatches(
      "DELETE FROM open_interest_sample WHERE observed_at < DATE_SUB(NOW(3), INTERVAL :retentionDays DAY)",
      { retentionDays: oiSampleDays }
    ),
    deleteInBatches(
      `DELETE FROM telegram_alert_queue
       WHERE status IN ('SENT','FAILED')
         AND updated_at < DATE_SUB(NOW(3), INTERVAL :retentionDays DAY)`,
      { retentionDays: hotRankDays }
    ),
    deleteInBatches(
      `DELETE FROM token_unlock_cache
       WHERE symbol NOT IN (SELECT symbol FROM watchlist)
         AND checked_at < DATE_SUB(NOW(3), INTERVAL :retentionDays DAY)`,
      { retentionDays: hotRankDays }
    )
  ]);
  return {
    triggerHistory,
    hotSnapshots,
    staleHotRows,
    staleOpenInterest,
    staleOpenInterestSamples,
    staleTelegramAlerts,
    staleUnlocks
  };
}

export async function getMaintenanceState(taskName) {
  const [rows] = await getPool().query(
    `SELECT task_name AS taskName, last_run_at AS lastRunAt, last_result AS lastResult
     FROM maintenance_state
     WHERE task_name=:taskName
     LIMIT 1`,
    { taskName }
  );
  return rows[0] ?? null;
}

export async function markMaintenanceState(taskName, result) {
  await getPool().query(
    `INSERT INTO maintenance_state (task_name, last_run_at, last_result)
     VALUES (:taskName, NOW(3), :result)
     ON DUPLICATE KEY UPDATE
      last_run_at=VALUES(last_run_at),
      last_result=VALUES(last_result)`,
    { taskName, result: String(result).slice(0, 2000) }
  );
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

export async function getOverview() {
  const [tokenRows] = await getPool().query(
    `SELECT
      COUNT(*) AS totalTokens,
      SUM(fetch_status='completed') AS cachedTokens,
      SUM(fetch_status<>'completed') AS pendingTokens
     FROM token_list
     WHERE is_active=1`
  );
  const [signalRows] = await getPool().query(
    `SELECT
      SUM(alert_level='LEVEL1') AS level1Signals,
      SUM(alert_level='LEVEL2') AS level2Signals
     FROM signal_result s
     JOIN token_list t ON t.id=s.token_id
     WHERE t.is_active=1`
  );
  const [categoryRows] = await getPool().query(
    `SELECT category_type AS categoryType,
      COUNT(*) AS total,
      SUM(fetch_status='completed') AS cached,
      SUM(fetch_status<>'completed') AS pending
     FROM token_list
     WHERE is_active=1
     GROUP BY category_type`
  );
  const [currentRows] = await getPool().query(
    `SELECT symbol, category_type AS categoryType, fetch_status AS fetchStatus, current_interval AS currentInterval,
      fetched_interval_count AS fetchedIntervalCount, total_interval_count AS totalIntervalCount, updated_at AS updatedAt, last_error AS lastError
     FROM token_list
     WHERE fetch_status='fetching'
       AND is_active=1
     ORDER BY updated_at DESC
     LIMIT 1`
  );
  const [lastRows] = await getPool().query(
    `SELECT MAX(updated_at) AS lastUpdatedAt FROM token_list WHERE is_active=1`
  );
  return {
    totals: {
      totalTokens: Number(tokenRows[0]?.totalTokens ?? 0),
      cachedTokens: Number(tokenRows[0]?.cachedTokens ?? 0),
      pendingTokens: Number(tokenRows[0]?.pendingTokens ?? 0),
      level1Signals: Number(signalRows[0]?.level1Signals ?? 0),
      level2Signals: Number(signalRows[0]?.level2Signals ?? 0)
    },
    categories: categoryRows.map((row) => ({
      categoryType: row.categoryType,
      total: Number(row.total ?? 0),
      cached: Number(row.cached ?? 0),
      pending: Number(row.pending ?? 0)
    })),
    currentFetch: currentRows[0] ?? null,
    lastUpdatedAt: lastRows[0]?.lastUpdatedAt ?? null
  };
}

export async function getSignals(categoryType) {
  const [rows] = await getPool().query(
    `SELECT s.symbol, s.category_type AS categoryType, t.category_label AS categoryLabel,
      s.interval_code AS intervalCode, s.alert_level AS alertLevel, s.ma100, s.ma200,
      s.current_price AS currentPrice, s.proximity_pct AS proximityPct, s.signal_weight AS signalWeight,
      s.signal_status AS signalStatus, s.note, s.signal_time AS signalTime, s.updated_at AS updatedAt
     FROM signal_result s
     JOIN token_list t ON t.id=s.token_id
     WHERE s.category_type=:categoryType
       AND t.is_active=1
     ORDER BY
      CASE s.alert_level WHEN 'LEVEL1' THEN 0 WHEN 'LEVEL2' THEN 1 WHEN 'NONE' THEN 2 ELSE 3 END,
      s.signal_weight DESC,
      s.updated_at DESC`,
    { categoryType }
  );
  return rows;
}

const SIGNAL_CATEGORIES = new Set(["A", "B"]);
const SIGNAL_LEVELS = new Set(["LEVEL1", "LEVEL2", "NONE", "INSUFFICIENT"]);
const SIGNAL_INTERVALS = new Set(["15m", "1h", "4h", "1d"]);

function normalizeList(values, allowedValues) {
  const input = Array.isArray(values) ? values : String(values ?? "").split(",");
  return input.map((item) => String(item).trim()).filter((item) => allowedValues.has(item));
}

function quotedList(values) {
  return values.map((item) => `'${item}'`).join(",");
}

function hotRankActiveSeconds() {
  return Math.max(60, Math.floor(config.hotRank.activeMs / 1000));
}

function openInterestActiveSeconds() {
  return Math.max(60, Math.floor(config.openInterestMonitor.activeMs / 1000));
}

function openInterestSpikeConditionSql(alias = "oi") {
  return `(
    ${alias}.change_5m_pct >= :oiSpike5mPct
    OR ${alias}.change_1h_pct >= :oiSpike1hPct
    OR ${alias}.change_4h_pct >= :oiSpike4hPct
    OR ${alias}.change_1d_pct >= :oiSpike1dPct
  )`;
}

function activeOpenInterestSpikeSql(alias = "oi", activeSecondsParam = "oiActiveSeconds") {
  return `${alias}.observed_at >= DATE_SUB(NOW(3), INTERVAL :${activeSecondsParam} SECOND)
    AND ${openInterestSpikeConditionSql(alias)}`;
}

function openInterestSpikeQueryParams(extra = {}) {
  return {
    oiActiveSeconds: openInterestActiveSeconds(),
    oiSpike5mPct: config.openInterestMonitor.spike5mPct,
    oiSpike1hPct: config.openInterestMonitor.spike1hPct,
    oiSpike4hPct: config.openInterestMonitor.spike4hPct,
    oiSpike1dPct: config.openInterestMonitor.spike1dPct,
    ...extra
  };
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

function hotRankHitSql(tokenAlias, activeSecondsParam = "hotRankActiveSeconds") {
  return `EXISTS(
    SELECT 1
    FROM hot_rank_seen h
    WHERE ${hotRankTokenMatchSql("h", tokenAlias)}
      AND h.last_seen_at >= DATE_SUB(NOW(3), INTERVAL :${activeSecondsParam} SECOND)
  )`;
}

function hotRankValueSql(tokenAlias, expression, activeSecondsParam = "hotRankActiveSeconds") {
  return `(
    SELECT ${expression}
    FROM hot_rank_seen h
    WHERE ${hotRankTokenMatchSql("h", tokenAlias)}
      AND h.last_seen_at >= DATE_SUB(NOW(3), INTERVAL :${activeSecondsParam} SECOND)
  )`;
}

function hotRankSignalMatchSql(hotAlias, signalAlias) {
  const baseAsset = `REPLACE(${signalAlias}.symbol, 'USDT', '')`;
  return `(
    ${hotAlias}.symbol=${signalAlias}.symbol
    OR ${hotAlias}.base_asset=${baseAsset}
    OR (${baseAsset} LIKE '1000%' AND ${hotAlias}.base_asset=SUBSTRING(${baseAsset}, 5))
    OR (${hotAlias}.base_asset LIKE '1000%' AND ${baseAsset}=SUBSTRING(${hotAlias}.base_asset, 5))
    OR (${baseAsset} LIKE '1000000%' AND ${hotAlias}.base_asset=SUBSTRING(${baseAsset}, 8))
    OR (${hotAlias}.base_asset LIKE '1000000%' AND ${baseAsset}=SUBSTRING(${hotAlias}.base_asset, 8))
  )`;
}

export async function getSignalGroupsPage({ categories, levels, intervals, page = 1, pageSize = 20 }) {
  const safeCategories = normalizeList(categories, SIGNAL_CATEGORIES);
  const safeLevels = normalizeList(levels, SIGNAL_LEVELS);
  const safeIntervals = normalizeList(intervals, SIGNAL_INTERVALS);
  const safePageSize = Math.max(1, Math.min(100, Number(pageSize) || 20));
  const safePage = Math.max(1, Number(page) || 1);
  if (!safeCategories.length || !safeLevels.length || !safeIntervals.length) {
    return { signals: [], total: 0, page: safePage, pageSize: safePageSize };
  }

  const whereSql = `s.category_type IN (${quotedList(safeCategories)})
    AND s.alert_level IN (${quotedList(safeLevels)})
    AND s.interval_code IN (${quotedList(safeIntervals)})
    AND t.is_active=1`;
  const alarmLevels = safeLevels.filter((level) => ["LEVEL1", "LEVEL2"].includes(level));
  const multiJoinSql = alarmLevels.length
    ? `LEFT JOIN (
      SELECT s2.symbol,
        COUNT(DISTINCT s2.interval_code) AS multiMatchCount,
        MIN(CASE s2.alert_level WHEN 'LEVEL1' THEN 0 WHEN 'LEVEL2' THEN 1 ELSE 2 END) AS bestAlertRank
      FROM signal_result s2
      JOIN token_list t2 ON t2.id=s2.token_id
      WHERE s2.category_type IN (${quotedList(safeCategories)})
        AND s2.alert_level IN (${quotedList(alarmLevels)})
        AND s2.interval_code IN (${quotedList(safeIntervals)})
        AND t2.is_active=1
      GROUP BY s2.symbol
    ) mp ON mp.symbol=s.symbol`
    : "LEFT JOIN (SELECT NULL AS symbol, 0 AS multiMatchCount, 2 AS bestAlertRank) mp ON mp.symbol=s.symbol";
  const fundingBitSql =
    "IF(EXISTS(SELECT 1 FROM funding_interval_state f WHERE f.symbol=s.symbol AND f.funding_interval_hours=1 AND f.source_present=1), 8, 0)";
  const oiBitSql =
    `IF(EXISTS(
      SELECT 1 FROM open_interest_monitor oi
      WHERE oi.symbol=s.symbol
        AND ${activeOpenInterestSpikeSql("oi")}
    ), 4, 0)`;
  const hotBitSql = `IF(EXISTS(
    SELECT 1 FROM hot_rank_seen h
    WHERE ${hotRankSignalMatchSql("h", "s")}
      AND h.last_seen_at >= DATE_SUB(NOW(3), INTERVAL :activeSeconds SECOND)
  ), 2, 0)`;
  const multiBitSql = "IF(COALESCE(mp.multiMatchCount, 0) >= 3, 1, 0)";
  const sourceMaskSql = `(${fundingBitSql} + ${oiBitSql} + ${hotBitSql} + ${multiBitSql})`;
  const bestAlertRankSql = "COALESCE(mp.bestAlertRank, 2)";
  const groupSql = `
    SELECT s.symbol,
      MIN(t.category_type) AS categoryType,
      MIN(t.category_label) AS categoryLabel,
      COUNT(DISTINCT s.interval_code) AS matchingIntervalCount,
      COALESCE(mp.multiMatchCount, 0) AS multiMatchCount,
      ${sourceMaskSql} AS sourceMask,
      MAX(s.updated_at) AS latestUpdatedAt,
      MIN(CASE s.alert_level WHEN 'LEVEL1' THEN 0 WHEN 'LEVEL2' THEN 1 WHEN 'NONE' THEN 2 ELSE 3 END) AS bestLevelRank,
      MAX(s.signal_weight) AS bestWeight,
      CASE
        WHEN ${bestAlertRankSql} > 1 THEN 99
        WHEN ${sourceMaskSql} > 0 THEN (15 - ${sourceMaskSql}) * 2 + ${bestAlertRankSql}
        WHEN ${bestAlertRankSql}=0 THEN 30
        WHEN ${bestAlertRankSql}=1 THEN 31
        ELSE 99
      END AS priorityRank,
      'COMPOSITE' AS displayKind
    FROM signal_result s
    JOIN token_list t ON t.id=s.token_id
    ${multiJoinSql}
    WHERE ${whereSql}
    GROUP BY s.symbol, mp.multiMatchCount, mp.bestAlertRank
    HAVING sourceMask > 0`;
  const standaloneMaAlertExistsSql = alarmLevels.length
    ? `EXISTS(
        SELECT 1 FROM signal_result sx
        JOIN token_list tx ON tx.id=sx.token_id
        WHERE sx.symbol=t.symbol
          AND sx.category_type IN (${quotedList(safeCategories)})
          AND sx.alert_level IN (${quotedList(alarmLevels)})
          AND sx.interval_code IN (${quotedList(safeIntervals)})
          AND tx.is_active=1
      )`
    : "0";
  const standaloneOiSql = `
    SELECT t.symbol,
      t.category_type AS categoryType,
      t.category_label AS categoryLabel,
      0 AS matchingIntervalCount,
      0 AS multiMatchCount,
      4 AS sourceMask,
      oi.observed_at AS latestUpdatedAt,
      2 AS bestLevelRank,
      0 AS bestWeight,
      ${SIGNAL_PRIORITY.STANDALONE} AS priorityRank,
      'STANDALONE' AS displayKind
    FROM token_list t
    JOIN open_interest_monitor oi
      ON oi.symbol=t.symbol
      AND ${activeOpenInterestSpikeSql("oi")}
    WHERE t.category_type IN (${quotedList(safeCategories)})
      AND t.is_active=1
      AND NOT ${standaloneMaAlertExistsSql}`;
  const candidateSql = `${groupSql}\nUNION ALL\n${standaloneOiSql}`;
  const [countRows] = await getPool().query(
    `SELECT COUNT(*) AS total FROM (${candidateSql}) grouped`,
    openInterestSpikeQueryParams({ activeSeconds: hotRankActiveSeconds() })
  );
  const [symbolRows] = await getPool().query(
    `${candidateSql}
     ORDER BY
      priorityRank,
      bestLevelRank,
      bestWeight DESC,
      latestUpdatedAt DESC,
      symbol
     LIMIT :pageSize OFFSET :offset`,
    openInterestSpikeQueryParams({
      pageSize: safePageSize,
      offset: (safePage - 1) * safePageSize,
      activeSeconds: hotRankActiveSeconds()
    })
  );
  const symbols = symbolRows.map((row) => sanitizeDbSymbol(row.symbol)).filter(Boolean);
  const uniqueSymbols = [...new Set(symbols)];
  if (!symbols.length) {
    return {
      signals: [],
      total: Number(countRows[0]?.total ?? 0),
      page: safePage,
      pageSize: safePageSize
    };
  }

  const [rows] = await getPool().query(
    `SELECT s.symbol, s.category_type AS categoryType, t.category_label AS categoryLabel,
      s.interval_code AS intervalCode, s.alert_level AS alertLevel, s.ma100, s.ma200,
      s.current_price AS currentPrice, s.proximity_pct AS proximityPct, s.signal_weight AS signalWeight,
      s.signal_status AS signalStatus, s.note, s.signal_time AS signalTime, s.updated_at AS updatedAt
     FROM signal_result s
     JOIN token_list t ON t.id=s.token_id
     WHERE s.symbol IN (${quotedList(uniqueSymbols)})
       AND t.is_active=1
       AND s.category_type IN (${quotedList(safeCategories)})
       AND s.interval_code IN (${quotedList(safeIntervals)})
     ORDER BY FIELD(s.interval_code, '15m', '1h', '4h', '1d')`
  );
  const [hotRows] = await getPool().query(
    `SELECT t.symbol, MIN(h.last_seen_rank) AS hotRank
     FROM hot_rank_seen h
     JOIN token_list t ON ${hotRankTokenMatchSql("h", "t")}
     WHERE t.symbol IN (${quotedList(uniqueSymbols)})
       AND t.is_active=1
       AND h.last_seen_at >= DATE_SUB(NOW(3), INTERVAL :activeSeconds SECOND)
     GROUP BY t.symbol`,
    { activeSeconds: hotRankActiveSeconds() }
  );
  const [oiRows] = await getPool().query(
    `SELECT symbol,
      change_5m_pct AS oiChange5mPct,
      change_1h_pct AS oiChange1hPct,
      change_4h_pct AS oiChange4hPct,
      change_1d_pct AS oiChange1dPct
     FROM open_interest_monitor
     WHERE symbol IN (${quotedList(uniqueSymbols)})
       AND observed_at >= DATE_SUB(NOW(3), INTERVAL :activeSeconds SECOND)`,
    { activeSeconds: openInterestActiveSeconds() }
  );
  const [fundingRows] = await getPool().query(
    `SELECT symbol
     FROM funding_interval_state
     WHERE symbol IN (${quotedList(uniqueSymbols)})
       AND funding_interval_hours=1
       AND source_present=1`
  );
  const hotBySymbol = new Map(hotRows.map((row) => [row.symbol, row]));
  const oiBySymbol = new Map(oiRows.map((row) => [row.symbol, row]));
  const fundingSymbols = new Set(fundingRows.map((row) => row.symbol));
  const rowsBySymbol = new Map();
  for (const row of rows) {
    if (!rowsBySymbol.has(row.symbol)) rowsBySymbol.set(row.symbol, []);
    rowsBySymbol.get(row.symbol).push(row);
  }
  const signals = symbolRows.map((meta, index) => {
    const symbol = sanitizeDbSymbol(meta.symbol);
    const isStandalone = meta.displayKind === "STANDALONE";
    const metaSourceMask = Number(meta.sourceMask ?? 0);
    const rawDetails = rowsBySymbol.get(symbol) ?? [];
    const matchingDetails = isStandalone
      ? rawDetails.map((row) => ({ ...row, alertLevel: "NONE" }))
      : rawDetails.filter((row) => safeLevels.includes(row.alertLevel));
    const representative =
      matchingDetails.find((row) => row.alertLevel === "LEVEL1") ??
      matchingDetails.find((row) => row.alertLevel === "LEVEL2") ??
      matchingDetails[0] ??
      {
        symbol,
        categoryType: meta.categoryType ?? null,
        categoryLabel: meta.categoryLabel ?? "",
        intervalCode: safeIntervals[0] ?? null,
        alertLevel: "NONE",
        ma100: null,
        ma200: null,
        currentPrice: null,
        proximityPct: null,
        signalWeight: 0,
        signalStatus: "independent",
        note: "资金费率/OI 独立命中",
        signalTime: meta.latestUpdatedAt ?? null,
        updatedAt: meta.latestUpdatedAt ?? null
      };
    const hot = hotBySymbol.get(symbol);
    const oi = oiBySymbol.get(symbol);
    const triggeredDetails = isStandalone ? [] : matchingDetails.filter((row) => ["LEVEL1", "LEVEL2"].includes(row.alertLevel));
    const bestAlertLevel = isStandalone ? null : resolveBestAlertLevel(triggeredDetails);
    const oiSpike = evaluateOpenInterestSpike(
      {
        change5mPct: oi?.oiChange5mPct,
        change1hPct: oi?.oiChange1hPct,
        change4hPct: oi?.oiChange4hPct,
        change1dPct: oi?.oiChange1dPct
      },
      config.openInterestMonitor
    );
    const oiMatched = isStandalone ? metaSourceMask === 4 && oiSpike.hit : oiSpike.hit;
    const fundingOneHour = isStandalone ? metaSourceMask === 8 : fundingSymbols.has(symbol);
    const oiSpikeHit = oiMatched;
    const compositeProfile = resolveSignalProfile({
      fundingOneHour,
      oiMatched,
      hotRank: Boolean(hot),
      multiCycleCount: triggeredDetails.length,
      alertLevel: bestAlertLevel
    });
    return {
      ...representative,
      symbol,
      bestAlertLevel,
      intervals: triggeredDetails.map((row) => row.intervalCode),
      intervalDetails: matchingDetails,
      multiMatchCount: triggeredDetails.length,
      multiMatchRequired: 3,
      displayKind: meta.displayKind ?? "COMPOSITE",
      displayKey: `${symbol}:${meta.displayKind ?? "COMPOSITE"}:${metaSourceMask || "MA"}:${index}`,
      sourceMask: metaSourceMask,
      hotRankHit: hot ? 1 : 0,
      hotRank: hot?.hotRank ?? null,
      fundingOneHour,
      oiChange5mPct: oiSpike.change5mPct,
      oiChange1hPct: oiSpike.change1hPct,
      oiChange4hPct: oiSpike.change4hPct,
      oiChange1dPct: oiSpike.change1dPct,
      oiMatched,
      oiSpikeHit,
      oiSpike5mHit: oiSpike.hit5m,
      oiSpike1hHit: oiSpike.hit1h,
      oiSpike4hHit: oiSpike.hit4h,
      oiSpike1dHit: oiSpike.hit1d,
      compositeProfile
    };
  });
  return {
    signals,
    total: Number(countRows[0]?.total ?? 0),
    page: safePage,
    pageSize: safePageSize
  };
}

export async function getMultiCycleSignalsPage({ categories, levels, intervals, page = 1, pageSize = 4 }) {
  const safeCategories = normalizeList(categories, SIGNAL_CATEGORIES);
  const safeLevels = normalizeList(levels, SIGNAL_LEVELS).filter((level) => ["LEVEL1", "LEVEL2"].includes(level));
  const safeIntervals = normalizeList(intervals, SIGNAL_INTERVALS);
  const safePageSize = Math.max(1, Math.min(10, Number(pageSize) || 4));
  const safePage = Math.max(1, Number(page) || 1);
  const offset = (safePage - 1) * safePageSize;
  const multiRequired = safeIntervals.length > 1 && safeLevels.length > 0 ? Math.min(3, safeIntervals.length) : 0;

  if (safeCategories.length === 0 || safeLevels.length === 0 || safeIntervals.length === 0 || multiRequired < 2) {
    return { groups: [], total: 0, page: safePage, pageSize: safePageSize, multiMatchRequired: multiRequired };
  }

  const groupWhereSql = `s.category_type IN (${quotedList(safeCategories)})
    AND s.alert_level IN (${quotedList(safeLevels)})
    AND s.interval_code IN (${quotedList(safeIntervals)})
    AND t.is_active=1`;

  const groupSql = `
    SELECT
      s.symbol,
      COUNT(DISTINCT s.interval_code) AS multiMatchCount,
      MIN(CASE s.alert_level WHEN 'LEVEL1' THEN 0 WHEN 'LEVEL2' THEN 1 ELSE 3 END) AS bestLevelRank,
      MAX(s.signal_weight) AS bestWeight,
      MAX(s.updated_at) AS latestUpdatedAt
    FROM signal_result s
    JOIN token_list t ON t.id=s.token_id
    WHERE ${groupWhereSql}
    GROUP BY s.symbol
    HAVING COUNT(DISTINCT s.interval_code) >= :multiRequired`;

  const [countRows] = await getPool().query(`SELECT COUNT(*) AS total FROM (${groupSql}) m`, { multiRequired });
  const [symbolRows] = await getPool().query(
    `${groupSql}
     ORDER BY bestLevelRank, multiMatchCount DESC, bestWeight DESC, latestUpdatedAt DESC, symbol
     LIMIT :pageSize OFFSET :offset`,
    { multiRequired, pageSize: safePageSize, offset }
  );

  const symbols = symbolRows.map((row) => String(row.symbol ?? "").toUpperCase().replace(/[^A-Z0-9_]/g, "")).filter(Boolean);
  if (!symbols.length) {
    return {
      groups: [],
      total: Number(countRows[0]?.total ?? 0),
      page: safePage,
      pageSize: safePageSize,
      multiMatchRequired: multiRequired
    };
  }

  const [rows] = await getPool().query(
    `SELECT s.symbol, s.category_type AS categoryType, t.category_label AS categoryLabel,
      s.interval_code AS intervalCode, s.alert_level AS alertLevel, s.ma100, s.ma200,
      s.current_price AS currentPrice, s.proximity_pct AS proximityPct, s.signal_weight AS signalWeight,
      s.signal_status AS signalStatus, s.note, s.signal_time AS signalTime, s.updated_at AS updatedAt
     FROM signal_result s
     JOIN token_list t ON t.id=s.token_id
     WHERE s.symbol IN (${quotedList(symbols)})
       AND ${groupWhereSql}
     ORDER BY
      CASE s.interval_code WHEN '15m' THEN 0 WHEN '1h' THEN 1 WHEN '4h' THEN 2 WHEN '1d' THEN 3 ELSE 4 END,
      CASE s.alert_level WHEN 'LEVEL1' THEN 0 WHEN 'LEVEL2' THEN 1 ELSE 3 END,
      s.signal_weight DESC`
  );

  const rowsBySymbol = new Map();
  for (const row of rows) {
    if (!rowsBySymbol.has(row.symbol)) rowsBySymbol.set(row.symbol, []);
    rowsBySymbol.get(row.symbol).push(row);
  }

  return {
    groups: symbolRows.map((row) => ({
      symbol: row.symbol,
      multiMatchCount: Number(row.multiMatchCount ?? 0),
      multiMatchRequired: multiRequired,
      rows: rowsBySymbol.get(row.symbol) ?? []
    })),
    total: Number(countRows[0]?.total ?? 0),
    page: safePage,
    pageSize: safePageSize,
    multiMatchRequired: multiRequired
  };
}

export async function getHotMaSignalsPage({ categories = "A,B", levels = "LEVEL1,LEVEL2", intervals = "15m,1h,4h,1d", page = 1, pageSize = 6 } = {}) {
  const safeCategories = normalizeList(categories, SIGNAL_CATEGORIES);
  const safeLevels = normalizeList(levels, SIGNAL_LEVELS).filter((level) => ["LEVEL1", "LEVEL2"].includes(level));
  const safeIntervals = normalizeList(intervals, SIGNAL_INTERVALS);
  const safePageSize = Math.max(1, Math.min(20, Number(pageSize) || 6));
  const safePage = Math.max(1, Number(page) || 1);
  const offset = (safePage - 1) * safePageSize;

  if (safeCategories.length === 0 || safeLevels.length === 0 || safeIntervals.length === 0) {
    return { signals: [], total: 0, page: safePage, pageSize: safePageSize };
  }

  const whereSql = `s.category_type IN (${quotedList(safeCategories)})
    AND s.alert_level IN (${quotedList(safeLevels)})
    AND s.interval_code IN (${quotedList(safeIntervals)})
    AND t.is_active=1
    AND ${hotRankHitSql("t")}`;

  const params = {
    hotRankActiveSeconds: hotRankActiveSeconds(),
    pageSize: safePageSize,
    offset
  };
  const [countRows] = await getPool().query(
    `SELECT COUNT(*) AS total
     FROM signal_result s
     JOIN token_list t ON t.id=s.token_id
     WHERE ${whereSql}`,
    params
  );
  const [rows] = await getPool().query(
    `SELECT s.symbol, s.category_type AS categoryType, t.category_label AS categoryLabel,
      s.interval_code AS intervalCode, s.alert_level AS alertLevel, s.ma100, s.ma200,
      s.current_price AS currentPrice, s.proximity_pct AS proximityPct, s.signal_weight AS signalWeight,
      s.signal_status AS signalStatus, s.note, s.signal_time AS signalTime, s.updated_at AS updatedAt,
      ${hotRankValueSql("t", "MIN(h.last_seen_rank)")} AS hotRank,
      ${hotRankValueSql("t", "MAX(h.last_seen_at)")} AS hotRankLastSeenAt
     FROM signal_result s
     JOIN token_list t ON t.id=s.token_id
     WHERE ${whereSql}
     ORDER BY
      CASE s.alert_level WHEN 'LEVEL1' THEN 0 WHEN 'LEVEL2' THEN 1 ELSE 2 END,
      hotRank ASC,
      s.signal_weight DESC,
      s.updated_at DESC
     LIMIT :pageSize OFFSET :offset`,
    params
  );
  return {
    signals: rows,
    total: Number(countRows[0]?.total ?? 0),
    page: safePage,
    pageSize: safePageSize
  };
}

export async function selectHotMaSignalAlert(symbol, intervalCode) {
  const safeSymbol = sanitizeDbSymbol(symbol);
  if (!safeSymbol) return null;
  const [rows] = await getPool().query(
    `SELECT symbol, interval_code AS intervalCode, alert_level AS alertLevel, signal_time AS signalTime,
      profile_key AS profileKey, source_mask AS sourceMask, context_signature AS contextSignature, sent_at AS sentAt
     FROM hot_ma_signal_alert
     WHERE symbol=:symbol AND interval_code=:intervalCode
     LIMIT 1`,
    { symbol: safeSymbol, intervalCode }
  );
  return rows[0] ?? null;
}

export async function markHotMaSignalAlertSent(symbol, intervalCode, signal, alertState = {}) {
  const safeSymbol = sanitizeDbSymbol(symbol);
  if (!safeSymbol || !["LEVEL1", "LEVEL2"].includes(signal?.alertLevel)) return;
  const signalTime = Number(signal.signalTime ?? Date.now());
  const profileKey = alertState.profileKey ? String(alertState.profileKey).slice(0, 80) : null;
  const sourceMask = Number.isFinite(Number(alertState.sourceMask)) ? Number(alertState.sourceMask) : 0;
  const contextSignature = alertState.contextSignature ? String(alertState.contextSignature).slice(0, 255) : null;
  const sentAtUpdate = alertState.preserveSentAt ? "sent_at=sent_at" : "sent_at=NOW(3)";
  await getPool().query(
    `INSERT INTO hot_ma_signal_alert
      (symbol, interval_code, alert_level, signal_time, profile_key, source_mask, context_signature, sent_at)
     VALUES
      (:symbol, :intervalCode, :alertLevel, FROM_UNIXTIME(:signalTime / 1000), :profileKey, :sourceMask, :contextSignature, NOW(3))
     ON DUPLICATE KEY UPDATE
      alert_level=VALUES(alert_level),
      signal_time=VALUES(signal_time),
      profile_key=VALUES(profile_key),
      source_mask=VALUES(source_mask),
      context_signature=VALUES(context_signature),
      ${sentAtUpdate}`,
    { symbol: safeSymbol, intervalCode, alertLevel: signal.alertLevel, signalTime, profileKey, sourceMask, contextSignature }
  );
}

export async function recordMultiCycleHistory(token, signals, required = 2) {
  const hits = (signals ?? [])
    .filter(({ signal }) => ["LEVEL1", "LEVEL2"].includes(signal.alertLevel))
    .sort((a, b) => SIGNAL_INTERVALS_ORDER.indexOf(a.intervalCode) - SIGNAL_INTERVALS_ORDER.indexOf(b.intervalCode));
  if (hits.length < required) return false;
  const bestAlertLevel = hits.some(({ signal }) => signal.alertLevel === "LEVEL1") ? "LEVEL1" : "LEVEL2";
  const intervals = hits.map(({ intervalCode }) => intervalCode).join(",");
  await getPool().query(
    `INSERT INTO multi_cycle_history
      (symbol, base_asset, category_label, multi_match_count, intervals, best_alert_level)
     VALUES (:symbol, :baseAsset, :categoryLabel, :multiMatchCount, :intervals, :bestAlertLevel)
     ON DUPLICATE KEY UPDATE
      category_label=VALUES(category_label),
      last_triggered_at=NOW(3),
      multi_match_count=VALUES(multi_match_count),
      intervals=VALUES(intervals),
      best_alert_level=VALUES(best_alert_level)`,
    {
      symbol: sanitizeDbSymbol(token.symbol),
      baseAsset: baseAssetFromSymbol(token.symbol),
      categoryLabel: String(token.category_label ?? token.categoryLabel ?? "").slice(0, 80),
      multiMatchCount: hits.length,
      intervals,
      bestAlertLevel
    }
  );
  return true;
}

const SIGNAL_INTERVALS_ORDER = ["15m", "1h", "4h", "1d"];

export async function listMultiCycleHistory({ limit = 50 } = {}) {
  const safeLimit = Math.max(1, Math.min(200, Number(limit) || 50));
  const [rows] = await getPool().query(
    `SELECT symbol, base_asset AS baseAsset, category_label AS categoryLabel,
      first_triggered_at AS firstTriggeredAt, last_triggered_at AS lastTriggeredAt,
      multi_match_count AS multiMatchCount, intervals, best_alert_level AS bestAlertLevel
     FROM multi_cycle_history
     ORDER BY last_triggered_at DESC, multi_match_count DESC, symbol
     LIMIT :limit`,
    { limit: safeLimit }
  );
  return rows.map((row) => ({
    ...row,
    multiMatchCount: Number(row.multiMatchCount ?? 0)
  }));
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

export async function listRealtimeKlineTokens() {
  const [rows] = await getPool().query(
    `SELECT DISTINCT t.*
     FROM token_list t
     WHERE t.is_active=1
       AND (
         EXISTS(SELECT 1 FROM watchlist w WHERE w.symbol=t.symbol)
         OR EXISTS(
           SELECT 1
           FROM signal_result s
           LEFT JOIN (
             SELECT symbol, COUNT(DISTINCT interval_code) AS multiMatchCount
             FROM signal_result
             WHERE alert_level IN ('LEVEL1','LEVEL2')
             GROUP BY symbol
           ) mp ON mp.symbol=s.symbol
           WHERE s.symbol=t.symbol
             AND s.alert_level IN ('LEVEL1','LEVEL2')
             AND (
               COALESCE(mp.multiMatchCount, 0) >= 3
               OR EXISTS(
                 SELECT 1 FROM funding_interval_state f
                 WHERE f.symbol=s.symbol
                   AND f.funding_interval_hours=1
                   AND f.source_present=1
               )
               OR EXISTS(
                 SELECT 1 FROM open_interest_monitor oi
                 WHERE oi.symbol=s.symbol
                   AND ${activeOpenInterestSpikeSql("oi")}
               )
               OR EXISTS(
                 SELECT 1 FROM hot_rank_seen h
                 WHERE ${hotRankTokenMatchSql("h", "t")}
                   AND h.last_seen_at >= DATE_SUB(NOW(3), INTERVAL :hotRankActiveSeconds SECOND)
               )
             )
         )
       )
     ORDER BY t.symbol`,
    openInterestSpikeQueryParams({ hotRankActiveSeconds: hotRankActiveSeconds() })
  );
  return rows;
}
