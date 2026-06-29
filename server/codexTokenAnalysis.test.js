import assert from "node:assert/strict";
import test from "node:test";
import { normalizeTokenInterval, prepareCodexTokenAnalysis } from "./codexTokenAnalysis.js";

function kline(index, overrides = {}) {
  const close = 100 + index;
  return {
    openTime: Date.UTC(2026, 0, 1, index, 0, 0),
    closeTime: Date.UTC(2026, 0, 1, index, 59, 59),
    open: close - 1,
    high: close + 2,
    low: close - 3,
    close,
    volume: 1000 + index * 10,
    ma100: 90 + index * 0.5,
    ma200: 80 + index * 0.25,
    ...overrides
  };
}

function klinePayload(length = 220) {
  return {
    symbol: "BTCUSDT",
    intervalCode: "1h",
    cachedCount: length,
    expectedCount: 500,
    coveragePercent: 44,
    hasMa200: length >= 200,
    needsRefresh: false,
    klines: Array.from({ length }, (_, index) => kline(index))
  };
}

test("normalizeTokenInterval falls back to 1h for unsupported values", () => {
  assert.equal(normalizeTokenInterval("15m"), "15m");
  assert.equal(normalizeTokenInterval("bad"), "1h");
});

test("prepareCodexTokenAnalysis summarizes and returns all cached klines by default", () => {
  const prepared = prepareCodexTokenAnalysis({
    symbol: "BTCUSDT",
    intervalCode: "1h",
    klinePayload: klinePayload(220),
    context: {
      signal: { bestAlertLevel: "LEVEL1", note: "near ma" },
      noisy: Array.from({ length: 80 }, (_, index) => `item-${index}`)
    }
  });

  assert.equal(prepared.report.scope, "token");
  assert.equal(prepared.report.symbol, "BTCUSDT");
  assert.equal(prepared.report.recentKlines.length, 220);
  assert.equal(prepared.report.summary.bars, 220);
  assert.equal(prepared.report.summary.movingAverages.ma100.side, "above");
  assert.equal(prepared.report.pageContext.noisy.length, 24);
  assert.match(prepared.prompt, /代币信号研究助理/);
  assert.match(prepared.prompt, /不是交易复盘教练/);
  assert.match(prepared.prompt, /低\/中\/高置信度/);
  assert.match(prepared.prompt, /确认条件和失效条件/);
  assert.ok(prepared.prompt.includes("LEVEL1"));
});

test("prepareCodexTokenAnalysis honors explicit kline context limits", () => {
  const prepared = prepareCodexTokenAnalysis({
    symbol: "BTCUSDT",
    intervalCode: "1h",
    klinePayload: klinePayload(),
    contextKlineLimit: 50
  });

  assert.equal(prepared.report.recentKlines.length, 50);
});

test("prepareCodexTokenAnalysis rejects empty kline payloads", () => {
  assert.throws(
    () => prepareCodexTokenAnalysis({ symbol: "BTCUSDT", intervalCode: "1h", klinePayload: { klines: [] } }),
    /K 线缓存/
  );
});
