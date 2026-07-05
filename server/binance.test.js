import assert from "node:assert/strict";
import test from "node:test";
import { config } from "./config.js";
import {
  clearFuturesTicker24hrCache,
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

test("futures 24h ticker normalizes price change percent", async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  try {
    clearFuturesTicker24hrCache();
    globalThis.fetch = async (url) => {
      calls.push(new URL(url));
      return {
        ok: true,
        headers: { get: () => null },
        json: async () => ({ symbol: "BTCUSDT", priceChangePercent: "3.210", lastPrice: "60000.5" })
      };
    };

    const ticker = await fetchFuturesTicker24hr("btcusdt");

    assert.equal(calls.length, 1);
    assert.equal(calls[0].searchParams.get("symbol"), "BTCUSDT");
    assert.deepEqual(ticker, {
      symbol: "BTCUSDT",
      priceChange24hPct: 3.21,
      lastPrice: 60000.5
    });
  } finally {
    clearFuturesTicker24hrCache();
    globalThis.fetch = originalFetch;
  }
});

test("futures 24h ticker map caches the bulk ticker snapshot", async () => {
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
          { symbol: "BTCUSDT", priceChangePercent: "1.23", lastPrice: "61000" },
          { symbol: "ETHUSDT", priceChangePercent: "-2.50", lastPrice: "3300" }
        ]
      };
    };

    const first = await fetchFuturesTicker24hrMap(["btcusdt", "ETHUSDT"]);
    const second = await fetchFuturesTicker24hrMap(["ETHUSDT"]);

    assert.equal(calls.length, 1);
    assert.equal(first.get("BTCUSDT").priceChange24hPct, 1.23);
    assert.equal(first.get("ETHUSDT").priceChange24hPct, -2.5);
    assert.equal(second.get("ETHUSDT").lastPrice, 3300);
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
          { symbol: "BTCUSDT", priceChangePercent: "4.56", lastPrice: "62000" }
        ]
      };
    };

    const fresh = await fetchFuturesTicker24hrMap(["BTCUSDT"]);
    await new Promise((resolve) => setTimeout(resolve, 5));
    shouldFail = true;
    const stale = await fetchFuturesTicker24hrMap(["BTCUSDT"]);

    assert.equal(fresh.get("BTCUSDT").priceChange24hPct, 4.56);
    assert.equal(stale.get("BTCUSDT").priceChange24hPct, 4.56);
    assert.equal(stale.get("BTCUSDT").lastPrice, 62000);
  } finally {
    config.binance.ticker24hCacheMs = originalCacheMs;
    clearFuturesTicker24hrCache();
    globalThis.fetch = originalFetch;
  }
});
