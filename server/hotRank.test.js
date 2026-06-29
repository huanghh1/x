import assert from "node:assert/strict";
import test from "node:test";
import { config } from "./config.js";

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" }
  });
}

test("a failed chain never falls back to another chain's cached ranking", async () => {
  const originalFetch = globalThis.fetch;
  const originalHotRank = { ...config.hotRank };
  config.hotRank.marketCapTopCacheMs = 60_000;
  config.hotRank.marketCapTopTimeoutMs = 1_000;

  globalThis.fetch = async (url) => {
    const target = String(url);
    if (target.includes("api.coingecko.com")) {
      return jsonResponse(
        ["BTC", "ETH", "USDT", "BNB", "USDC", "XRP", "SOL", "TRX", "DOGE", "ADA"].map((symbol) => ({
          symbol
        }))
      );
    }
    if (target.includes("web3.binance.com")) {
      const chainId = new URL(target).searchParams.get("chainId");
      if (chainId === "8453") return jsonResponse({ error: "upstream unavailable" }, 503);
      return jsonResponse({
        data: {
          leaderBoardList: [
            {
              metaInfo: { symbol: "BSCONLY", chainId: "56", contractAddress: "0x1" },
              marketInfo: { marketCap: 10 },
              socialHypeInfo: { socialHype: 100 }
            }
          ]
        }
      });
    }
    throw new Error(`unexpected URL ${target}`);
  };

  try {
    const module = await import(`./hotRank.js?fallback-test=${Date.now()}`);
    const bsc = await module.getHotRank({ chain: "bsc", limit: 5, timeRange: 54321 });
    const base = await module.getHotRank({ chain: "base", limit: 5, timeRange: 54321 });
    assert.deepEqual(bsc.tokens.map((token) => token.symbol), ["BSCONLY"]);
    assert.equal(base.chain, "base");
    assert.deepEqual(base.tokens, []);
    assert.equal(base.partial, true);
  } finally {
    globalThis.fetch = originalFetch;
    Object.assign(config.hotRank, originalHotRank);
  }
});

test("stale hot rank fallback is not capped by an earlier small request", async () => {
  const originalFetch = globalThis.fetch;
  const originalHotRank = { ...config.hotRank };
  config.hotRank.marketCapTopCacheMs = 60_000;
  config.hotRank.marketCapTopTimeoutMs = 1_000;
  let upstreamBroken = false;

  globalThis.fetch = async (url) => {
    const target = String(url);
    if (target.includes("api.coingecko.com")) {
      return jsonResponse(
        ["BTC", "ETH", "USDT", "BNB", "USDC", "XRP", "SOL", "TRX", "DOGE", "ADA"].map((symbol) => ({
          symbol
        }))
      );
    }
    if (target.includes("web3.binance.com")) {
      if (upstreamBroken) return jsonResponse({ data: { message: "maintenance" } });
      return jsonResponse({
        data: {
          leaderBoardList: Array.from({ length: 8 }, (_, index) => ({
            metaInfo: { symbol: `HOT${index + 1}`, chainId: "56", contractAddress: `0x${index + 1}` },
            marketInfo: { marketCap: 100 + index },
            socialHypeInfo: { socialHype: 1000 - index }
          }))
        }
      });
    }
    throw new Error(`unexpected URL ${target}`);
  };

  try {
    const module = await import(`./hotRank.js?stale-limit-test=${Date.now()}`);
    const small = await module.getHotRank({ chain: "bsc", limit: 5, timeRange: 111 });
    assert.equal(small.tokens.length, 5);

    upstreamBroken = true;
    const stale = await module.getHotRank({ chain: "bsc", limit: 8, timeRange: 222 });
    assert.equal(stale.stale, true);
    assert.equal(stale.partial, true);
    assert.equal(stale.tokens.length, 8);
    assert.deepEqual(stale.tokens.map((token) => token.symbol), [
      "HOT1",
      "HOT2",
      "HOT3",
      "HOT4",
      "HOT5",
      "HOT6",
      "HOT7",
      "HOT8"
    ]);
    assert.match(stale.errors[0], /invalid leaderboard payload/);
  } finally {
    globalThis.fetch = originalFetch;
    Object.assign(config.hotRank, originalHotRank);
  }
});

test("hot rank base cache is shared across different limits", async () => {
  const originalFetch = globalThis.fetch;
  const originalHotRank = { ...config.hotRank };
  config.hotRank.marketCapTopCacheMs = 60_000;
  config.hotRank.marketCapTopTimeoutMs = 1_000;
  let binanceCalls = 0;

  globalThis.fetch = async (url) => {
    const target = String(url);
    if (target.includes("api.coingecko.com")) {
      return jsonResponse(
        ["BTC", "ETH", "USDT", "BNB", "USDC", "XRP", "SOL", "TRX", "DOGE", "ADA"].map((symbol) => ({
          symbol
        }))
      );
    }
    if (target.includes("web3.binance.com")) {
      binanceCalls += 1;
      return jsonResponse({
        data: {
          leaderBoardList: Array.from({ length: 12 }, (_, index) => ({
            metaInfo: { symbol: `LIMIT${index + 1}`, chainId: "56", contractAddress: `0x${index + 1}` },
            marketInfo: { marketCap: 100 + index },
            socialHypeInfo: { socialHype: 1000 - index }
          }))
        }
      });
    }
    throw new Error(`unexpected URL ${target}`);
  };

  try {
    const module = await import(`./hotRank.js?limit-cache-test=${Date.now()}`);
    const small = await module.getHotRank({ chain: "bsc", limit: 5, timeRange: 333 });
    const large = await module.getHotRank({ chain: "bsc", limit: 10, timeRange: 333 });
    assert.equal(small.tokens.length, 5);
    assert.equal(large.tokens.length, 10);
    assert.equal(binanceCalls, 1);
  } finally {
    globalThis.fetch = originalFetch;
    Object.assign(config.hotRank, originalHotRank);
  }
});
