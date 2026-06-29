import assert from "node:assert/strict";
import test from "node:test";
import { config } from "./config.js";
import { buildOpenInterestSnapshot, isOpenInterestHistoryUnavailable, selectScanBatch } from "./openInterestMonitor.js";

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

test("OI history 403 is treated as endpoint unavailable", () => {
  assert.equal(
    isOpenInterestHistoryUnavailable(new Error("BTCUSDT open interest history HTTP 403: <html>Forbidden</html>")),
    true
  );
  assert.equal(isOpenInterestHistoryUnavailable(new Error("BTCUSDT open interest history HTTP 500")), false);
});

test("selectScanBatch rotates through tokens when request window is smaller than the universe", () => {
  const originalLimit = config.openInterestMonitor.requestLimitPerWindow;
  config.openInterestMonitor.requestLimitPerWindow = 2;
  selectScanBatch([]);

  try {
    const tokens = ["AUSDT", "BUSDT", "CUSDT", "DUSDT"].map((symbol) => ({ symbol }));

    assert.deepEqual(selectScanBatch(tokens).batch.map((token) => token.symbol), ["AUSDT", "BUSDT"]);
    assert.deepEqual(selectScanBatch(tokens).batch.map((token) => token.symbol), ["CUSDT", "DUSDT"]);
    assert.deepEqual(selectScanBatch(tokens).batch.map((token) => token.symbol), ["AUSDT", "BUSDT"]);
  } finally {
    config.openInterestMonitor.requestLimitPerWindow = originalLimit;
    selectScanBatch([]);
  }
});
