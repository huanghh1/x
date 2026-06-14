import assert from "node:assert/strict";
import test from "node:test";
import { resolveOfficialUnlock } from "./officialUnlocks.js";

test("resolves the next ZEST community claim from Binance TGE time", () => {
  const result = resolveOfficialUnlock({
    name: "Zest Protocol",
    symbol: "ZEST",
    chainId: "56",
    contractAddress: "0x5506599c722389a60580b5213ea1da60d64754a1",
    listingTime: Date.parse("2026-05-19T13:00:00.000Z")
  }, Date.parse("2026-06-13T00:00:00.000Z"));

  assert.equal(result.status, "available");
  assert.equal(result.nextUnlockAt.toISOString(), "2026-09-19T13:00:00.000Z");
  assert.equal(result.unlockAmount, 3_000_000);
  assert.equal(result.unlockPercent, 0.3);
});

test("resolves the next ELSA cliff end", () => {
  const result = resolveOfficialUnlock({
    name: "HeyElsa",
    symbol: "ELSA",
    chainId: "8453",
    contractAddress: "0x29cc30f9d113b356ce408667aa6433589cecbdca",
    listingTime: Date.parse("2026-01-20T08:00:00.000Z")
  }, Date.parse("2026-06-13T00:00:00.000Z"));

  assert.equal(result.status, "available");
  assert.equal(result.nextUnlockAt.toISOString(), "2026-11-20T08:00:00.000Z");
  assert.equal(result.unlockAmount, null);
});

test("keeps FOLKS undated when the official schedule has no exact batch date", () => {
  const result = resolveOfficialUnlock({
    name: "Folks Finance",
    symbol: "FOLKS",
    chainId: "56",
    contractAddress: "0xff7f8f301f7a706e3cfd3d2275f5dc0b9ee8009b",
    listingTime: Date.parse("2025-11-06T12:00:00.000Z")
  }, Date.parse("2026-06-13T00:00:00.000Z"));

  assert.equal(result.status, "undated");
  assert.equal(result.nextUnlockAt, null);
});
