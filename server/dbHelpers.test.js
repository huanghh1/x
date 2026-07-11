import assert from "node:assert/strict";
import test from "node:test";
import {
  collectHotRankFundingSymbols,
  detectKlineTailGap,
  isNaturalKlineHistoryShortfall,
  normalizeFundingIntervalSnapshotItems,
  normalizeHotRankSeenTokens,
  normalizeOpenInterestCategories,
  normalizeOptionalLimit,
  selectOpenInterestSampleBaselines,
  summarizeTokenKlineCompletion
} from "./db.js";

const completionIntervals = ["15m", "1h", "4h", "1d"];
const completionRetentionLimits = { "15m": 200, "1h": 200, "4h": 200, "1d": 200 };

function intervalMs(intervalCode) {
  return {
    "15m": 15 * 60 * 1000,
    "1h": 60 * 60 * 1000,
    "4h": 4 * 60 * 60 * 1000,
    "1d": 24 * 60 * 60 * 1000
  }[intervalCode];
}

function completionTarget(intervalCode, now, expectedCount = 200) {
  const ms = intervalMs(intervalCode);
  const targetEndTime = Math.floor(now / ms) * ms - ms;
  return {
    targetEndTime,
    targetStartTime: targetEndTime - (expectedCount - 1) * ms
  };
}

test("optional query limits keep null unbounded instead of coercing it to LIMIT 1", () => {
  assert.equal(normalizeOptionalLimit(null), null);
  assert.equal(normalizeOptionalLimit(undefined), null);
  assert.equal(normalizeOptionalLimit(""), null);
  assert.equal(normalizeOptionalLimit(20), 20);
  assert.equal(normalizeOptionalLimit("20"), 20);
  assert.equal(normalizeOptionalLimit(0), 1);
  assert.equal(normalizeOptionalLimit(999, 500), 500);
});

test("OI category filters keep only supported token categories", () => {
  assert.deepEqual(normalizeOpenInterestCategories(undefined), ["A", "B"]);
  assert.deepEqual(normalizeOpenInterestCategories("B,A,B,bad"), ["B", "A"]);
  assert.deepEqual(normalizeOpenInterestCategories(""), []);
});

test("hot rank seen rows are deduped by symbol before database upsert", () => {
  const rows = normalizeHotRankSeenTokens([
    { symbol: "aero", chainLabel: "Base", rank: 5, heat: 20 },
    { symbol: "AERO", chainLabel: "BSC", rank: 3, heat: 10 },
    { symbol: "BROKEN", rank: 0, heat: "bad" },
    { symbol: "", rank: 1 }
  ]);

  assert.deepEqual(rows, [
    { symbol: "BROKEN", baseAsset: "BROKEN", chainLabel: "", rank: 1, heat: null, marketCap: null },
    { symbol: "AERO", baseAsset: "AERO", chainLabel: "BSC", rank: 3, heat: 10, marketCap: null }
  ]);
});

test("funding interval snapshot rows are normalized and deduped by symbol", () => {
  const rows = normalizeFundingIntervalSnapshotItems([
    { symbol: "aero/usdt", fundingIntervalHours: "1", currentFundingRate: "0.0001" },
    { symbol: "AEROUSDT", fundingIntervalHours: "4", currentFundingRate: "-0.0002" },
    { symbol: "BADUSDT", fundingIntervalHours: "0" },
    { symbol: "", fundingIntervalHours: "1" }
  ]);

  assert.deepEqual(rows, [
    {
      symbol: "AEROUSDT",
      fundingIntervalHours: 4,
      adjustedFundingRateCap: null,
      adjustedFundingRateFloor: null,
      currentFundingRate: -0.0002,
      nextFundingTime: null,
      disclaimer: 0
    }
  ]);
});

test("funding hot-rank matching handles multiplier-prefixed futures symbols", () => {
  const matches = collectHotRankFundingSymbols(
    ["1000AEROUSDT", "ETHUSDT"],
    [
      { symbol: "AERO", baseAsset: "AERO" },
      { symbol: "ETHUSDT", baseAsset: "ETH" }
    ]
  );

  assert.deepEqual([...matches].sort(), ["1000AEROUSDT", "ETHUSDT"]);
});

test("OI sample baselines choose the nearest sample at or before each target", () => {
  const observedAt = Date.UTC(2026, 0, 1, 12, 0, 0);
  const rows = [
    { openInterest: 999, observedAt: new Date(observedAt - 4 * 60 * 1000) },
    { openInterest: 130, openInterestValue: 1300, observedAt: new Date(observedAt - 6 * 60 * 1000) },
    { openInterest: 120, openInterestValue: 1200, observedAt: new Date(observedAt - 15 * 60 * 1000) },
    { openInterest: 100, openInterestValue: 1000, observedAt: new Date(observedAt - 17 * 60 * 1000) },
    { openInterest: 90, observedAt: new Date(observedAt - 60 * 60 * 1000) },
    { openInterest: "bad", observedAt: new Date(observedAt - 4 * 60 * 60 * 1000) },
    { openInterest: 80, observedAt: new Date(observedAt - 4 * 60 * 60 * 1000 - 2 * 60 * 1000) },
    { openInterest: 50, observedAt: new Date(observedAt - 24 * 60 * 60 * 1000) }
  ];

  const baselines = selectOpenInterestSampleBaselines(rows, observedAt);

  assert.equal(baselines["5m"].openInterest, 130);
  assert.equal(baselines["5m"].openInterestValue, 1300);
  assert.equal(baselines["15m"].openInterest, 120);
  assert.equal(baselines["15m"].openInterestValue, 1200);
  assert.equal(baselines["1h"].openInterest, 90);
  assert.equal(baselines["4h"].openInterest, 80);
  assert.equal(baselines["1d"].openInterest, 50);
});

test("natural kline history shortfall is not treated as a repairable gap", () => {
  const intervalMs = 24 * 60 * 60 * 1000;
  const targetStartTime = Date.UTC(2020, 0, 1);
  const firstAvailableOpenTime = Date.UTC(2024, 0, 1);

  assert.equal(
    isNaturalKlineHistoryShortfall({
      cachedCount: 500,
      expectedCount: 2190,
      earliestOpenTime: firstAvailableOpenTime,
      firstAvailableOpenTime,
      targetStartTime,
      intervalMsValue: intervalMs
    }),
    true
  );

  assert.equal(
    isNaturalKlineHistoryShortfall({
      cachedCount: 500,
      expectedCount: 2190,
      earliestOpenTime: firstAvailableOpenTime + intervalMs * 10,
      firstAvailableOpenTime,
      targetStartTime,
      intervalMsValue: intervalMs
    }),
    false
  );

  assert.equal(
    isNaturalKlineHistoryShortfall({
      cachedCount: 2189,
      expectedCount: 2190,
      earliestOpenTime: targetStartTime + intervalMs,
      firstAvailableOpenTime: targetStartTime + intervalMs,
      targetStartTime,
      intervalMsValue: intervalMs
    }),
    true
  );
});

test("tail kline gaps are detected when latest cached candle is stale", () => {
  const intervalMs = 60 * 60 * 1000;
  const latestOpenTime = Date.UTC(2026, 5, 29, 8);
  const targetEndTime = Date.UTC(2026, 5, 29, 11);

  assert.deepEqual(detectKlineTailGap(latestOpenTime, targetEndTime, intervalMs), {
    startTime: Date.UTC(2026, 5, 29, 9),
    endTime: targetEndTime,
    missingCount: 3
  });

  assert.equal(detectKlineTailGap(targetEndTime, targetEndTime, intervalMs), null);
  assert.equal(detectKlineTailGap(null, targetEndTime, intervalMs), null);
});

test("token kline completion requires target coverage and a fresh tail", () => {
  const now = Date.UTC(2026, 0, 1, 12, 30);
  const completeRows = completionIntervals.map((intervalCode) => {
    const target = completionTarget(intervalCode, now);
    return {
      intervalCode,
      cachedCount: 200,
      earliestOpenTime: target.targetStartTime,
      latestOpenTime: target.targetEndTime
    };
  });

  assert.deepEqual(
    summarizeTokenKlineCompletion(completeRows, { now, retentionLimits: completionRetentionLimits }).fetchStatus,
    "completed"
  );

  const sparseRows = completionIntervals.map((intervalCode) => {
    const target = completionTarget(intervalCode, now);
    return {
      intervalCode,
      cachedCount: 1,
      earliestOpenTime: target.targetEndTime,
      latestOpenTime: target.targetEndTime
    };
  });
  const sparseSummary = summarizeTokenKlineCompletion(sparseRows, { now, retentionLimits: completionRetentionLimits });
  assert.equal(sparseSummary.fetchStatus, "partial");
  assert.equal(sparseSummary.fetchedIntervalCount, 4);
  assert.equal(sparseSummary.completeIntervalCount, 0);
});

test("token kline completion accepts natural history shortfall for newly listed symbols", () => {
  const now = Date.UTC(2026, 0, 1, 12, 30);
  const naturalRows = completionIntervals.map((intervalCode) => {
    const ms = intervalMs(intervalCode);
    const target = completionTarget(intervalCode, now);
    const firstAvailableOpenTime = target.targetStartTime + 10 * ms;
    return {
      intervalCode,
      cachedCount: 190,
      earliestOpenTime: firstAvailableOpenTime,
      latestOpenTime: target.targetEndTime,
      firstAvailableOpenTime
    };
  });
  const summary = summarizeTokenKlineCompletion(naturalRows, { now, retentionLimits: completionRetentionLimits });

  assert.equal(summary.fetchStatus, "completed");
  assert.equal(summary.completeIntervalCount, 4);
});
