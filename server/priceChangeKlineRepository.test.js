import assert from "node:assert/strict";
import test from "node:test";
import {
  latestClosedPriceChangeOpenTimeAt,
  pickNearestPriceChange24hBaselineSnapshot,
  priceChange24hBaselineOpenTime,
  priceChange24hBaselineLookupRange,
  priceChangeKlineTarget
} from "./db/priceChangeKlineRepository.js";

test("price change 1m target keeps a 25 hour closed-candle window", () => {
  const now = Date.UTC(2026, 0, 2, 1, 0, 30);
  const target = priceChangeKlineTarget({ now, retentionHours: 25 });

  assert.equal(target.expectedCount, 1500);
  assert.equal(target.targetEndTime, Date.UTC(2026, 0, 2, 0, 59, 0));
  assert.equal(target.targetStartTime, Date.UTC(2026, 0, 1, 0, 0, 0));
});

test("price change 24h baseline aligns to the 1m candle open time", () => {
  const now = Date.UTC(2026, 0, 2, 1, 0, 30);

  assert.equal(latestClosedPriceChangeOpenTimeAt(now), Date.UTC(2026, 0, 2, 0, 59, 0));
  assert.equal(priceChange24hBaselineOpenTime(now), Date.UTC(2026, 0, 1, 1, 0, 0));
});

test("price change 24h baseline lookup keeps a small nearby fallback window", () => {
  const now = Date.UTC(2026, 0, 2, 1, 0, 30);
  const range = priceChange24hBaselineLookupRange(now, 2);

  assert.equal(range.baselineOpenTime, Date.UTC(2026, 0, 1, 1, 0, 0));
  assert.equal(range.startTime, Date.UTC(2026, 0, 1, 0, 58, 0));
  assert.equal(range.endTime, Date.UTC(2026, 0, 1, 1, 2, 0));
});

test("price change 24h baseline picker prefers the exact minute", () => {
  const baselineOpenTime = Date.UTC(2026, 0, 1, 1, 0, 0);
  const snapshot = pickNearestPriceChange24hBaselineSnapshot([
    { openTime: baselineOpenTime - 60_000, openPrice: "90" },
    { openTime: baselineOpenTime, openPrice: "100" },
    { openTime: baselineOpenTime + 60_000, openPrice: "110" }
  ], baselineOpenTime);

  assert.equal(snapshot.baselinePrice, 100);
  assert.equal(snapshot.baselineOpenTime, baselineOpenTime);
  assert.equal(snapshot.baselineOffsetMs, 0);
});

test("price change 24h baseline picker uses the nearest minute when exact is missing", () => {
  const baselineOpenTime = Date.UTC(2026, 0, 1, 1, 0, 0);
  const snapshot = pickNearestPriceChange24hBaselineSnapshot([
    { openTime: baselineOpenTime + 60_000, openPrice: "110" },
    { openTime: baselineOpenTime - 60_000, openPrice: "90" },
    { openTime: baselineOpenTime - 120_000, openPrice: "80" }
  ], baselineOpenTime);

  assert.equal(snapshot.baselinePrice, 90);
  assert.equal(snapshot.baselineOpenTime, baselineOpenTime - 60_000);
  assert.equal(snapshot.baselineOffsetMs, -60_000);
});
