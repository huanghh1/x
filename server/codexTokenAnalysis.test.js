import assert from "node:assert/strict";
import test from "node:test";
import { normalizeTokenInterval, normalizeTokenPromptTemplate, prepareCodexTokenAnalysis } from "./codexTokenAnalysis.js";

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

test("normalizeTokenPromptTemplate falls back to the standard token prompt", () => {
  assert.equal(normalizeTokenPromptTemplate("yokai"), "standard");
  assert.equal(normalizeTokenPromptTemplate("STANDARD"), "standard");
  assert.equal(normalizeTokenPromptTemplate("bad"), "standard");
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
  assert.equal(prepared.report.promptTemplate, "standard");
  assert.equal(prepared.report.promptTemplateLabel, "常规看币");
  assert.equal(prepared.report.recentKlines.length, 220);
  assert.equal(prepared.report.summary.bars, 220);
  assert.equal(prepared.report.summary.movingAverages.ma100.side, "above");
  assert.equal(prepared.report.pageContext.noisy.length, 24);
  assert.equal(prepared.report.newsSearchHints, undefined);
  assert.match(prepared.prompt, /代币执行研判助理/);
  assert.match(prepared.prompt, /不是交易复盘教练/);
  assert.match(prepared.prompt, /不要联网/);
  assert.doesNotMatch(prepared.prompt, /实时网页搜索/);
  assert.doesNotMatch(prepared.prompt, /newsSearchHints/);
  assert.doesNotMatch(prepared.prompt, /Twitter|Binance Square|币安广场/);
  assert.doesNotMatch(prepared.prompt, /消息面/);
  assert.match(prepared.prompt, /试多\/试空/);
  assert.match(prepared.prompt, /低\/中\/高置信度/);
  assert.match(prepared.prompt, /确认条件和失效条件/);
  assert.doesNotMatch(prepared.prompt, /妖币 \/ 庄控风险/);
  assert.doesNotMatch(prepared.prompt, /Top10|Bundler|OI\/MCap|Vol\/OI/);
  assert.ok(prepared.prompt.includes("LEVEL1"));
});

test("prepareCodexTokenAnalysis always uses the standard token prompt", () => {
  const prepared = prepareCodexTokenAnalysis({
    symbol: "MYXUSDT",
    intervalCode: "15m",
    klinePayload: klinePayload(220),
    promptTemplate: "yokai",
    context: {
      funding: { currentFundingRate: -0.0007, fundingIntervalHours: 1 },
      openInterest: { changePercent: 180, currentOpenInterestValue: 12_000_000 }
    }
  });

  assert.equal(prepared.report.promptTemplate, "standard");
  assert.equal(prepared.report.promptTemplateLabel, "常规看币");
  assert.match(prepared.report.title, /代币图表分析/);
  assert.match(prepared.prompt, /代币执行研判助理/);
  assert.doesNotMatch(prepared.prompt, /妖币 \/ 庄控风险研判助理/);
  assert.doesNotMatch(prepared.prompt, /Top10|Bundler|OI\/MCap|Vol\/OI/);
  assert.match(prepared.prompt, /MYXUSDT/);
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

test("prepareCodexTokenAnalysis caps default kline context to keep prompts small", () => {
  const prepared = prepareCodexTokenAnalysis({
    symbol: "BTCUSDT",
    intervalCode: "1h",
    klinePayload: klinePayload(5000)
  });

  assert.equal(prepared.report.summary.bars, 5000);
  assert.equal(prepared.report.recentKlines.length, 360);
  assert.ok(prepared.prompt.length < 1_048_576);
});

test("prepareCodexTokenAnalysis caps oversized explicit kline limits", () => {
  const prepared = prepareCodexTokenAnalysis({
    symbol: "BTCUSDT",
    intervalCode: "1h",
    klinePayload: klinePayload(1000),
    contextKlineLimit: 5000
  });

  assert.equal(prepared.report.recentKlines.length, 720);
});

test("prepareCodexTokenAnalysis rejects empty kline payloads", () => {
  assert.throws(
    () => prepareCodexTokenAnalysis({ symbol: "BTCUSDT", intervalCode: "1h", klinePayload: { klines: [] } }),
    /K 线缓存/
  );
});
