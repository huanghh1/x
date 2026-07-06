import assert from "node:assert/strict";
import test from "node:test";
import { config } from "./config.js";
import {
  clearFuturesTicker24hrCache,
  collectSpotProductMarketData,
  fetchFuturesTicker24hr,
  fetchFuturesTicker24hrMap,
  fetchKlinesPaged
} from "./binance.js";

test("paged kline fetch includes a single-candle inclusive range", async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  try {
    globalThis.fetch = async (url) => {
      calls.push(new URL(url));
      return {
        ok: true,
        headers: { get: () => null },
        json: async () => [[1780912800000, "1", "2", "0.5", "1.5", "10", 1780913699999, "15", 3]]
      };
    };

    const pages = [];
    const pageCount = await fetchKlinesPaged({
      symbol: "SOONUSDT",
      intervalCode: "15m",
      startTime: 1780912800000,
      endTime: 1780912800000,
      limit: 10,
      onPage: async (page) => pages.push(page)
    });

    assert.equal(pageCount, 1);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].searchParams.get("startTime"), "1780912800000");
    assert.equal(calls[0].searchParams.get("endTime"), "1780912800000");
    assert.equal(pages[0][0][0], 1780912800000);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("futures current price ticker ignores Binance 24h change percent", async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  try {
    clearFuturesTicker24hrCache();
    globalThis.fetch = async (url) => {
      calls.push(new URL(url));
      return {
        ok: true,
        headers: { get: () => null },
        json: async () => ({ symbol: "ZZZUNITTESTUSDT", priceChangePercent: "3.210", markPrice: "60000.5" })
      };
    };

    const ticker = await fetchFuturesTicker24hr("zzzunittestusdt");

    assert.equal(calls.length, 1);
    assert.equal(calls[0].pathname, "/fapi/v1/premiumIndex");
    assert.equal(calls[0].searchParams.get("symbol"), "ZZZUNITTESTUSDT");
    assert.equal(ticker.symbol, "ZZZUNITTESTUSDT");
    assert.equal(ticker.priceChange24hPct, null);
    assert.equal("priceChange24hBinancePct" in ticker, false);
    assert.equal("priceChange24hLocalPct" in ticker, false);
    assert.equal("priceChange24hDiffPct" in ticker, false);
    assert.equal("priceChange24hSource" in ticker, false);
    assert.equal(ticker.lastPrice, 60000.5);
  } finally {
    clearFuturesTicker24hrCache();
    globalThis.fetch = originalFetch;
  }
});

test("spot product market data derives market cap from circulating supply and price", () => {
  const data = collectSpotProductMarketData([
    { s: "YFIUSDT", b: "YFI", q: "USDT", c: "2377", cs: "33628" },
    { s: "YFITRY", b: "YFI", q: "TRY", c: "100000", cs: "33628" },
    { s: "CVXUSDT", b: "CVX", q: "USDT", marketCap: "121872784.27", c: "1.24", cs: "98616685" }
  ]);

  assert.equal(data.get("YFIUSDT").marketCap, 79933756);
  assert.equal(data.get("YFI").marketCap, 79933756);
  assert.equal(data.get("CVX").marketCap, 121872784.27);
  assert.equal(data.has("YFITRY"), false);
});

test("futures current price map caches the bulk price snapshot", async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  try {
    clearFuturesTicker24hrCache();
    globalThis.fetch = async (url) => {
      calls.push(new URL(url));
      return {
        ok: true,
        headers: { get: () => null },
        json: async () => [
          { symbol: "ZZZUNITAUSDT", priceChangePercent: "1.23", markPrice: "61000" },
          { symbol: "ZZZUNITBUSDT", priceChangePercent: "-2.50", markPrice: "3300" }
        ]
      };
    };

    const first = await fetchFuturesTicker24hrMap(["zzzunitausdt", "ZZZUNITBUSDT"]);
    const second = await fetchFuturesTicker24hrMap(["ZZZUNITBUSDT"]);

    assert.equal(calls.length, 1);
    assert.equal(calls[0].pathname, "/fapi/v1/premiumIndex");
    assert.equal(first.get("ZZZUNITAUSDT").priceChange24hPct, null);
    assert.equal(first.get("ZZZUNITBUSDT").priceChange24hPct, null);
    assert.equal(second.get("ZZZUNITBUSDT").lastPrice, 3300);
  } finally {
    clearFuturesTicker24hrCache();
    globalThis.fetch = originalFetch;
  }
});

test("futures current price map does not use Binance change percent or remote kline fallback", async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  try {
    clearFuturesTicker24hrCache();
    globalThis.fetch = async (url) => {
      const parsed = new URL(url);
      calls.push(parsed);
      return {
        ok: true,
        headers: { get: () => null },
        json: async () => [
          { symbol: "ZZZUNITCUSDT", priceChangePercent: "0.000", markPrice: "105" }
        ]
      };
    };

    const tickers = await fetchFuturesTicker24hrMap(["ZZZUNITCUSDT"]);

    assert.equal(tickers.get("ZZZUNITCUSDT").priceChange24hPct, null);
    assert.equal(tickers.get("ZZZUNITCUSDT").lastPrice, 105);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].pathname, "/fapi/v1/premiumIndex");
  } finally {
    clearFuturesTicker24hrCache();
    globalThis.fetch = originalFetch;
  }
});

test("futures 24h ticker map serves stale values when refresh fails", async () => {
  const originalFetch = globalThis.fetch;
  const originalCacheMs = config.binance.ticker24hCacheMs;
  let shouldFail = false;
  try {
    clearFuturesTicker24hrCache();
    config.binance.ticker24hCacheMs = 1;
    globalThis.fetch = async () => {
      if (shouldFail) throw new Error("network down");
      return {
        ok: true,
        headers: { get: () => null },
        json: async () => [
          { symbol: "ZZZUNITDUSDT", priceChangePercent: "4.56", markPrice: "62000" }
        ]
      };
    };

    const fresh = await fetchFuturesTicker24hrMap(["ZZZUNITDUSDT"]);
    await new Promise((resolve) => setTimeout(resolve, 5));
    shouldFail = true;
    const stale = await fetchFuturesTicker24hrMap(["ZZZUNITDUSDT"]);

    assert.equal(fresh.get("ZZZUNITDUSDT").priceChange24hPct, null);
    assert.equal(stale.get("ZZZUNITDUSDT").priceChange24hPct, null);
    assert.equal(stale.get("ZZZUNITDUSDT").lastPrice, 62000);
  } finally {
    config.binance.ticker24hCacheMs = originalCacheMs;
    clearFuturesTicker24hrCache();
    globalThis.fetch = originalFetch;
  }
});
