import assert from "node:assert/strict";
import test from "node:test";
import { config } from "./config.js";

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" }
  });
}

test("hot rank enforces chain and rotates away from empty exhausted Twitter tokens", async () => {
  const originalFetch = globalThis.fetch;
  const originalTwitter = { ...config.twitter, tokens: [...config.twitter.tokens] };
  const originalHotRank = { ...config.hotRank };
  let twitterCalls = 0;

  config.twitter.heatEnabled = true;
  config.twitter.tokens = ["empty-token", "working-token"];
  config.twitter.token = "";
  config.twitter.concurrentRequests = 1;
  config.twitter.requestSpacingMs = 0;
  config.twitter.maxFreshPerRank = 5;
  config.twitter.tokenCooldownMs = 60_000;
  config.twitter.failureCacheMs = 10;
  config.hotRank.marketCapTopCacheMs = 60_000;
  config.hotRank.marketCapTopTimeoutMs = 1_000;

  globalThis.fetch = async (url, options = {}) => {
    const target = String(url);
    if (target.includes("api.coingecko.com")) {
      return jsonResponse(
        ["BTC", "ETH", "USDT", "BNB", "USDC", "XRP", "SOL", "TRX", "DOGE", "ADA"].map((symbol) => ({
          symbol
        }))
      );
    }
    if (target.includes("web3.binance.com")) {
      return jsonResponse({
        data: {
          leaderBoardList: [
            {
              metaInfo: { symbol: "AERO", chainId: "8453", contractAddress: "0x1" },
              marketInfo: { marketCap: 10 },
              socialHypeInfo: { socialHype: 100 }
            },
            {
              metaInfo: { symbol: "WRONG", chainId: "56", contractAddress: "0x2" },
              marketInfo: { marketCap: 20 },
              socialHypeInfo: { socialHype: 200 }
            }
          ]
        }
      });
    }
    if (target.includes("ai.6551.io")) {
      twitterCalls += 1;
      const authorization = options.headers?.Authorization ?? "";
      if (authorization.includes("empty-token")) {
        return jsonResponse({ success: true, data: [], usage: { quota: "0" } });
      }
      return jsonResponse({
        success: true,
        data: [{ favoriteCount: 10, retweetCount: 2, replyCount: 1, viewCount: 100 }],
        usage: { quota: "3" }
      });
    }
    throw new Error(`unexpected URL ${target}`);
  };

  try {
    const module = await import(`./hotRank.js?test=${Date.now()}`);
    const first = await module.getHotRank({ chain: "base", limit: 5, timeRange: 98765 });
    assert.deepEqual(first.tokens.map((token) => token.symbol), ["AERO"]);
    assert.equal(first.tokens[0].chainId, "8453");
    assert.equal(first.tokens[0].twitterStatus, "pending_refresh");
    assert.equal(first.tokens[0].twitterHeat, null);

    await new Promise((resolve) => setTimeout(resolve, 25));
    const second = await module.getHotRank({ chain: "base", limit: 5, timeRange: 98765 });
    assert.equal(second.tokens[0].twitterStatus, "ok");
    assert.ok(second.tokens[0].twitterHeat > 0);
    assert.equal(twitterCalls, 2);
  } finally {
    globalThis.fetch = originalFetch;
    Object.assign(config.twitter, originalTwitter);
    config.twitter.tokens = originalTwitter.tokens;
    Object.assign(config.hotRank, originalHotRank);
  }
});

test("a failed chain never falls back to another chain's cached ranking", async () => {
  const originalFetch = globalThis.fetch;
  const originalTwitterEnabled = config.twitter.heatEnabled;
  const originalHotRank = { ...config.hotRank };
  config.twitter.heatEnabled = false;
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
    config.twitter.heatEnabled = originalTwitterEnabled;
    Object.assign(config.hotRank, originalHotRank);
  }
});

test("stale hot rank fallback is not capped by an earlier small request", async () => {
  const originalFetch = globalThis.fetch;
  const originalTwitterEnabled = config.twitter.heatEnabled;
  const originalHotRank = { ...config.hotRank };
  config.twitter.heatEnabled = false;
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
    config.twitter.heatEnabled = originalTwitterEnabled;
    Object.assign(config.hotRank, originalHotRank);
  }
});

test("hot rank base cache is shared across different limits", async () => {
  const originalFetch = globalThis.fetch;
  const originalTwitterEnabled = config.twitter.heatEnabled;
  const originalHotRank = { ...config.hotRank };
  config.twitter.heatEnabled = false;
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
    config.twitter.heatEnabled = originalTwitterEnabled;
    Object.assign(config.hotRank, originalHotRank);
  }
});
