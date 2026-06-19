import assert from "node:assert/strict";
import test from "node:test";
import { hasReliableFundingIntervalSnapshot } from "./fundingMonitor.js";

test("funding interval snapshot is reliable when either endpoint returns data", () => {
  assert.equal(hasReliableFundingIntervalSnapshot([{ symbol: "BTCUSDT" }], []), true);
  assert.equal(hasReliableFundingIntervalSnapshot([], [{ symbol: "BTCUSDT" }]), true);
});

test("funding interval snapshot rejects empty or malformed endpoint results", () => {
  assert.equal(hasReliableFundingIntervalSnapshot([], []), false);
  assert.equal(hasReliableFundingIntervalSnapshot(null, []), false);
  assert.equal(hasReliableFundingIntervalSnapshot([], null), false);
});
