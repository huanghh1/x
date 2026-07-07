import assert from "node:assert/strict";
import test from "node:test";
import { formatPercent } from "./format.js";

test("formatPercent preserves missing values", () => {
  assert.equal(formatPercent(null), "--");
  assert.equal(formatPercent(undefined), "--");
  assert.equal(formatPercent(""), "--");
});

test("formatPercent still renders real zero values", () => {
  assert.equal(formatPercent(0), "+0%");
  assert.equal(formatPercent("0"), "+0%");
});
