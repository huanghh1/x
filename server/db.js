import { config } from "./config.js";
import { getPool } from "./db/connection.js";
import { cleanupPriceChangeKlineRetention } from "./db/priceChangeKlineRepository.js";
export { ensureDatabase, getPool, pingDatabase } from "./db/connection.js";
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
  listLatestHotRankSnapshot,
  markHotRankNotified,
  normalizeHotRankSeenTokens,
  recordHotRankSnapshot
} from "./db/hotRankRepository.js";
export {
  collectHotRankFundingSymbols,
  listFundingRealtimeTokens,
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
  normalizeOpenInterestCategories,
  normalizeOptionalLimit,
  selectOpenInterestSampleBaselines,
  upsertOpenInterestSamples,
  upsertOpenInterestSnapshot
} from "./db/openInterestRepository.js";
export {
  addWatchlistItemsIfMissing,
  clearWatchlistAlertSide,
  deleteAutoWatchlistItemsMissingFrom,
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
export {
  cleanupPriceChangeKlineRetention,
  latestClosedPriceChangeOpenTimeAt,
  listActivePriceChangeKlineTokens,
  listPriceChangeKlineGaps,
  priceChange24hBaselineOpenTime,
  priceChangeKlineStats,
  priceChangeKlineTarget,
  selectPriceChange24hBaselinePrice,
  selectPriceChange24hBaselineSnapshot,
  selectPriceChange24hBaselineSnapshots,
  upsertPriceChangeKlinePage
} from "./db/priceChangeKlineRepository.js";
export {
  claimNextTokenForFetch,
  cleanupInactiveTokenKlines,
  countActiveTokens,
  detectKlineTailGap,
  findKlineGap,
  getKlines,
  getKlineAuditReport,
  isNaturalKlineHistoryShortfall,
  klineStats,
  listKlineGaps,
  listKlineTailRefreshTargets,
  markKlineAvailabilityStart,
  markTokenFetching,
  markTokenPartial,
  queueActiveTokensForKlineAudit,
  queueSymbolsForKlineRefresh,
  refreshTokenFetchState,
  resetInterruptedFetchingTokens,
  selectClosePrices,
  selectPreviousSignals,
  summarizeTokenKlineCompletion,
  upsertKlinePage,
  upsertSignal,
  upsertSignals,
  upsertTokens
} from "./db/tokenKlineRepository.js";
export {
  getHotMaSignalsPage,
  getMultiCycleSignalsPage,
  getOverview,
  getSignalGroupsPage,
  getSignals,
  listMultiCycleHistory,
  listRealtimeKlineTokens,
  markHotMaSignalAlertSent,
  recordMultiCycleHistory,
  selectHotMaSignalAlert
} from "./db/signalRepository.js";


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

export async function cleanupExpiredData() {
  const hotRankDays = Math.max(1, Number(config.maintenance.hotRankRetentionDays) || 7);
  const ioDays = Math.max(1, Number(config.maintenance.ioRetentionDays) || 7);
  const oiSampleDays = Math.max(2, Number(config.openInterestMonitor.sampleRetentionDays) || 3);
  // trade_event_history is the durable archive for API-limited trade analysis data; do not expire it here.
  const [
    hotSnapshots,
    staleHotRows,
    staleOpenInterest,
    staleOpenInterestSamples,
    staleTelegramAlerts,
    staleUnlocks,
    priceChange1m
  ] = await Promise.all([
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
    ),
    cleanupPriceChangeKlineRetention()
  ]);
  return {
    hotSnapshots,
    staleHotRows,
    staleOpenInterest,
    staleOpenInterestSamples,
    staleTelegramAlerts,
    staleUnlocks,
    priceChange1m
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
