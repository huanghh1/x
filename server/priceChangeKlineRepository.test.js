import assert from "node:assert/strict";
import test from "node:test";
import {
  latestClosedPriceChangeOpenTimeAt,
  priceChange24hBaselineOpenTime,
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
