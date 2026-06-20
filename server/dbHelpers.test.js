import assert from "node:assert/strict";
import test from "node:test";
import {
  collectHotRankFundingSymbols,
  isNaturalKlineHistoryShortfall,
  normalizeFundingIntervalSnapshotItems,
  normalizeHotRankSeenTokens,
  normalizeOptionalLimit
} from "./db.js";

test("optional query limits keep null unbounded instead of coercing it to LIMIT 1", () => {
  assert.equal(normalizeOptionalLimit(null), null);
  assert.equal(normalizeOptionalLimit(undefined), null);
  assert.equal(normalizeOptionalLimit(""), null);
  assert.equal(normalizeOptionalLimit(20), 20);
  assert.equal(normalizeOptionalLimit("20"), 20);
  assert.equal(normalizeOptionalLimit(0), 1);
  assert.equal(normalizeOptionalLimit(999, 500), 500);
});

test("hot rank seen rows are deduped by symbol before database upsert", () => {
  const rows = normalizeHotRankSeenTokens([
    { symbol: "aero", chainLabel: "Base", rank: 5, heat: 20 },
    { symbol: "AERO", chainLabel: "BSC", rank: 3, heat: 10 },
    { symbol: "BROKEN", rank: 0, heat: "bad" },
    { symbol: "", rank: 1 }
  ]);

  assert.deepEqual(rows, [
    { symbol: "BROKEN", baseAsset: "BROKEN", chainLabel: "", rank: 1, heat: null },
    { symbol: "AERO", baseAsset: "AERO", chainLabel: "BSC", rank: 3, heat: 10 }
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
});
