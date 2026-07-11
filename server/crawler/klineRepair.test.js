import assert from "node:assert/strict";
import test from "node:test";
import { recentKlineRefreshRange } from "./klineRepair.js";

test("recent kline refresh skips an interval that already reaches the target", () => {
  assert.equal(
    recentKlineRefreshRange({
      latestOpenTime: 10_000,
      targetStartTime: 1_000,
      targetEndTime: 10_000,
      intervalMsValue: 1_000
    }),
    null
  );
});

test("recent kline refresh starts after the latest cached candle", () => {
  assert.deepEqual(
    recentKlineRefreshRange({
      latestOpenTime: 8_000,
      targetStartTime: 1_000,
      targetEndTime: 10_000,
      intervalMsValue: 1_000
    }),
    { startTime: 9_000, endTime: 10_000 }
  );
});

test("recent kline refresh uses the target start for an empty cache", () => {
  assert.deepEqual(
    recentKlineRefreshRange({
      latestOpenTime: null,
      targetStartTime: 1_000,
      targetEndTime: 10_000,
      intervalMsValue: 1_000
    }),
    { startTime: 1_000, endTime: 10_000 }
  );
});
