import { config } from "../config.js";

export const KLINE_COMPLETION_INTERVALS = ["15m", "1h", "4h", "1d"];

export function intervalMs(intervalCode) {
  return {
    "15m": 15 * 60 * 1000,
    "1h": 60 * 60 * 1000,
    "4h": 4 * 60 * 60 * 1000,
    "1d": 24 * 60 * 60 * 1000
  }[intervalCode] ?? 60 * 60 * 1000;
}

export function latestClosedKlineOpenTimeAt(intervalCode, now = Date.now()) {
  const ms = intervalMs(intervalCode);
  return Math.floor(Number(now) / ms) * ms - ms;
}

export function latestClosedKlineOpenTime(intervalCode) {
  return latestClosedKlineOpenTimeAt(intervalCode);
}

export function klineCompletionTarget(intervalCode, retentionLimits = config.crawler.retentionLimits, now = Date.now()) {
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

export function normalizeIntervalCode(value) {
  return ["15m", "1h", "4h", "1d"].includes(value) ? value : null;
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
