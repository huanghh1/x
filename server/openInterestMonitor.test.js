import assert from "node:assert/strict";
import test from "node:test";
import { config } from "./config.js";
import {
  buildOpenInterestSnapshot,
  buildOpenInterestSnapshotFromSample,
  effectiveOpenInterestScanLimit,
  isOpenInterestHistoryUnavailable,
  selectScanBatch
} from "./openInterestMonitor.js";

test("buildOpenInterestSnapshot computes changes from aligned 5-minute history", () => {
  const base = Date.UTC(2026, 0, 1, 0, 0, 0);
  const rows = [
    { timestamp: base, sumOpenInterest: 100, sumOpenInterestValue: 1000 },
    { timestamp: base + 45 * 60 * 1000, sumOpenInterest: 110, sumOpenInterestValue: 1100 },
    { timestamp: base + 55 * 60 * 1000, sumOpenInterest: 121, sumOpenInterestValue: 1210 },
    { timestamp: base + 60 * 60 * 1000, sumOpenInterest: 150, sumOpenInterestValue: 1500 }
  ];

  const snapshot = buildOpenInterestSnapshot("TESTUSDT", rows);

  assert.equal(snapshot.symbol, "TESTUSDT");
  assert.equal(snapshot.change5mPct, 23.96694215);
  assert.equal(snapshot.change15mPct, 36.36363636);
  assert.equal(snapshot.change1hPct, 50);
});

test("buildOpenInterestSnapshot ignores stale baselines when history has gaps", () => {
  const base = Date.UTC(2026, 0, 1, 0, 0, 0);
  const rows = [
    { timestamp: base, sumOpenInterest: 100, sumOpenInterestValue: 1000 },
    { timestamp: base + 50 * 60 * 1000, sumOpenInterest: 120, sumOpenInterestValue: 1200 },
    { timestamp: base + 60 * 60 * 1000, sumOpenInterest: 150, sumOpenInterestValue: 1500 }
  ];

  const snapshot = buildOpenInterestSnapshot("GAPUSDT", rows);

  assert.equal(snapshot.change5mPct, null);
  assert.equal(snapshot.change15mPct, null);
  assert.equal(snapshot.change1hPct, 50);
});

test("buildOpenInterestSnapshotFromSample computes changes from local OI samples", () => {
  const observedAt = Date.UTC(2026, 0, 1, 1, 0, 0);
  const snapshot = buildOpenInterestSnapshotFromSample(
    {
      symbol: "CACHEUSDT",
      openInterest: 150,
      openInterestValue: 1500,
      observedAt
    },
    {
      "5m": { openInterest: 125, observedAt: new Date(observedAt - 5 * 60 * 1000) },
      "15m": { openInterest: 120, observedAt: new Date(observedAt - 15 * 60 * 1000) },
      "1h": { openInterest: 100, observedAt: new Date(observedAt - 60 * 60 * 1000) },
      "4h": null,
      "1d": null
    }
  );

  assert.equal(snapshot.symbol, "CACHEUSDT");
  assert.equal(snapshot.currentOpenInterest, 150);
  assert.equal(snapshot.currentOpenInterestValue, 1500);
  assert.equal(snapshot.change5mPct, 20);
  assert.equal(snapshot.change15mPct, 25);
  assert.equal(snapshot.change1hPct, 50);
  assert.equal(snapshot.change4hPct, null);
});

test("buildOpenInterestSnapshotFromSample ignores stale local baselines", () => {
  const observedAt = Date.UTC(2026, 0, 1, 1, 0, 0);
  const snapshot = buildOpenInterestSnapshotFromSample(
    { symbol: "STALEUSDT", openInterest: 150, observedAt },
    {
      "5m": { openInterest: 100, observedAt: new Date(observedAt - 11 * 60 * 1000) }
    }
  );

  assert.equal(snapshot.change5mPct, null);
});

test("OI history 403 is treated as endpoint unavailable", () => {
  assert.equal(
    isOpenInterestHistoryUnavailable(new Error("BTCUSDT open interest history HTTP 403: <html>Forbidden</html>")),
    true
  );
  assert.equal(isOpenInterestHistoryUnavailable(new Error("BTCUSDT open interest history HTTP 500")), false);
});

test("selectScanBatch scans the full token universe for current OI samples", () => {
  const originalLimit = config.openInterestMonitor.requestLimitPerWindow;
  const originalScanIntervalMs = config.openInterestMonitor.scanIntervalMs;
  config.openInterestMonitor.requestLimitPerWindow = 2;
  config.openInterestMonitor.scanIntervalMs = 5 * 60 * 1000;
  selectScanBatch([]);

  try {
    const tokens = ["AUSDT", "BUSDT", "CUSDT", "DUSDT"].map((symbol) => ({ symbol }));

    const result = selectScanBatch(tokens);
    assert.deepEqual(result.batch.map((token) => token.symbol), ["AUSDT", "BUSDT", "CUSDT", "DUSDT"]);
    assert.equal(result.deferredCount, 0);
  } finally {
    config.openInterestMonitor.requestLimitPerWindow = originalLimit;
    config.openInterestMonitor.scanIntervalMs = originalScanIntervalMs;
    selectScanBatch([]);
  }
});

test("effectiveOpenInterestScanLimit scans all tokens for current OI and can still spread history budget", () => {
  assert.equal(
    effectiveOpenInterestScanLimit({
      tokenCount: 1000,
      requestLimitPerWindow: 900,
      scanIntervalMs: 3 * 60 * 1000
    }),
    1000
  );
  assert.equal(
    effectiveOpenInterestScanLimit({
      tokenCount: 1000,
      requestLimitPerWindow: 900,
      scanIntervalMs: 3 * 60 * 1000,
      useHistoryBudget: true
    }),
    450
  );
  assert.equal(
    effectiveOpenInterestScanLimit({
      tokenCount: 1000,
      requestLimitPerWindow: 900,
      scanIntervalMs: 5 * 60 * 1000,
      useHistoryBudget: true
    }),
    900
  );
  assert.equal(
    effectiveOpenInterestScanLimit({
      tokenCount: 488,
      requestLimitPerWindow: 1000,
      scanIntervalMs: 3 * 60 * 1000
    }),
    488
  );
  assert.equal(
    effectiveOpenInterestScanLimit({
      tokenCount: 1000,
      requestLimitPerWindow: 900,
      scanIntervalMs: 30 * 1000,
      useHistoryBudget: true
    }),
    90
  );
});
