import assert from "node:assert/strict";
import test from "node:test";
import {
  filterEligibleHotTokens,
  isStablecoinToken,
  isTokenizedStockToken
} from "./hotRankFilters.js";

test("stablecoins are detected by symbol or Binance tags", () => {
  assert.equal(isStablecoinToken({ symbol: "USDC" }), true);
  assert.equal(
    isStablecoinToken({
      symbol: "NEWUSD",
      tagInfoList: {
        "Stablecoin Category": [{ tagName: "Stablecoin" }]
      }
    }),
    true
  );
  assert.equal(isStablecoinToken({ symbol: "AERO" }), false);
});

test("tokenized stocks are detected from Binance stock metadata", () => {
  assert.equal(
    isTokenizedStockToken({
      symbol: "TSM",
      tagInfoList: {
        "Tokenized Stocks Category": [{ tagName: "Top Tech Stocks" }]
      }
    }),
    true
  );
  assert.equal(
    isTokenizedStockToken({
      symbol: "SPACEX",
      tagInfoList: {
        "Tokenized Stocks Launch Platform": [{ tagName: "PreStocks" }]
      }
    }),
    true
  );
  assert.equal(isTokenizedStockToken({ symbol: "TRUMP", tagInfoList: {} }), false);
});

test("eligible hot rank keeps only non-top-10 crypto tokens", () => {
  const result = filterEligibleHotTokens(
    [
      { symbol: "BTC", tagInfoList: {} },
      { symbol: "USD1", tagInfoList: { "Stablecoin Category": [{ tagName: "Stablecoin" }] } },
      { symbol: "TSM", tagInfoList: { "Tokenized Stocks Category": [{ tagName: "AI Stock" }] } },
      { symbol: "AERO", tagInfoList: {}, heat: 42 }
    ],
    new Set(["BTC", "ETH"])
  );

  assert.deepEqual(result.excluded, {
    topMarketCap: 1,
    stablecoin: 1,
    tokenizedStock: 1
  });
  assert.deepEqual(result.tokens, [{ symbol: "AERO", heat: 42, assetType: "crypto" }]);
});
