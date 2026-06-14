import assert from "node:assert/strict";
import test from "node:test";
import { normalizeOptionalLimit } from "./db.js";

test("optional query limits keep null unbounded instead of coercing it to LIMIT 1", () => {
  assert.equal(normalizeOptionalLimit(null), null);
  assert.equal(normalizeOptionalLimit(undefined), null);
  assert.equal(normalizeOptionalLimit(""), null);
  assert.equal(normalizeOptionalLimit(20), 20);
  assert.equal(normalizeOptionalLimit("20"), 20);
  assert.equal(normalizeOptionalLimit(0), 1);
  assert.equal(normalizeOptionalLimit(999, 500), 500);
});
