import assert from "node:assert/strict";
import test from "node:test";
import { attachMarketMetadata } from "./marketMetadata.js";

test("attachMarketMetadata does not coerce missing 24h change to zero", () => {
  const missing = attachMarketMetadata({ symbol: "MISSUSDT", priceChange24hPct: null });

  assert.equal(missing.priceChange24hPct, null);
});

test("attachMarketMetadata keeps explicit zero 24h change", () => {
  const zero = attachMarketMetadata({ symbol: "ZEROUSDT", priceChange24hPct: "0" });

  assert.equal(zero.priceChange24hPct, 0);
});
