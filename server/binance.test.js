import assert from "node:assert/strict";
import test from "node:test";
import { fetchKlinesPaged } from "./binance.js";

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
