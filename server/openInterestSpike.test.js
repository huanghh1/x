import assert from "node:assert/strict";
import test from "node:test";
import { evaluateOpenInterestSpike } from "./openInterestSpike.js";

test("OI spike matches when any configured threshold is reached", () => {
  assert.deepEqual(
    evaluateOpenInterestSpike(
      { change5mPct: 2.2, change1hPct: 4, change4hPct: 12, change1dPct: 22 },
      { spike5mPct: 2, spike1hPct: 10, spike4hPct: 20, spike1dPct: 40 }
    ),
    {
      hit: true,
      hit5m: true,
      hit1h: false,
      hit4h: false,
      hit1d: false,
      change5mPct: 2.2,
      change1hPct: 4,
      change4hPct: 12,
      change1dPct: 22
    }
  );
  assert.equal(
    evaluateOpenInterestSpike(
      { change5mPct: 1.5, change1hPct: 10.1 },
      { spike5mPct: 2, spike1hPct: 10, spike4hPct: 20, spike1dPct: 40 }
    ).hit,
    true
  );
  assert.equal(
    evaluateOpenInterestSpike(
      { change5mPct: 1.5, change1hPct: 9.9, change4hPct: 21 },
      { spike5mPct: 2, spike1hPct: 10, spike4hPct: 20, spike1dPct: 40 }
    ).hit,
    true
  );
  assert.equal(
    evaluateOpenInterestSpike(
      { change5mPct: 1.5, change1hPct: 9.9, change4hPct: 19.9, change1dPct: 42 },
      { spike5mPct: 2, spike1hPct: 10, spike4hPct: 20, spike1dPct: 40 }
    ).hit,
    true
  );
  assert.equal(
    evaluateOpenInterestSpike(
      { change5mPct: 1.99, change1hPct: 9.99, change4hPct: 19.99, change1dPct: 39.99 },
      { spike5mPct: 2, spike1hPct: 10, spike4hPct: 20, spike1dPct: 40 }
    ).hit,
    false
  );
});

test("OI spike ignores missing and non-numeric changes", () => {
  assert.deepEqual(evaluateOpenInterestSpike({ change5mPct: null, change1hPct: "bad", change4hPct: "", change1dPct: undefined }), {
    hit: false,
    hit5m: false,
    hit1h: false,
    hit4h: false,
    hit1d: false,
    change5mPct: null,
    change1hPct: null,
    change4hPct: null,
    change1dPct: null
  });
});
