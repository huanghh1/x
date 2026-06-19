import assert from "node:assert/strict";
import test from "node:test";
import { normalizeHotRankSeenTokens, normalizeOptionalLimit } from "./db.js";

test("optional query limits keep null unbounded instead of coercing it to LIMIT 1", () => {
  assert.equal(normalizeOptionalLimit(null), null);
  assert.equal(normalizeOptionalLimit(undefined), null);
  assert.equal(normalizeOptionalLimit(""), null);
  assert.equal(normalizeOptionalLimit(20), 20);
  assert.equal(normalizeOptionalLimit("20"), 20);
  assert.equal(normalizeOptionalLimit(0), 1);
  assert.equal(normalizeOptionalLimit(999, 500), 500);
});

test("hot rank seen rows are deduped by symbol before database upsert", () => {
  const rows = normalizeHotRankSeenTokens([
    { symbol: "aero", chainLabel: "Base", rank: 5, heat: 20 },
    { symbol: "AERO", chainLabel: "BSC", rank: 3, heat: 10 },
    { symbol: "BROKEN", rank: 0, heat: "bad" },
    { symbol: "", rank: 1 }
  ]);

  assert.deepEqual(rows, [
    { symbol: "BROKEN", baseAsset: "BROKEN", chainLabel: "", rank: 1, heat: null },
    { symbol: "AERO", baseAsset: "AERO", chainLabel: "BSC", rank: 3, heat: 10 }
  ]);
});
