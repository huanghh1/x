import assert from "node:assert/strict";
import test from "node:test";
import { evaluateOpenInterestSpike } from "./openInterestSpike.js";

test("OI spike matches when either the 5-minute or 1-hour threshold is reached", () => {
  assert.deepEqual(
    evaluateOpenInterestSpike(
      { change5mPct: 5.2, change1hPct: 4 },
      { spike5mPct: 5, spike1hPct: 10 }
    ),
    { hit: true, hit5m: true, hit1h: false, change5mPct: 5.2, change1hPct: 4 }
  );
  assert.equal(
    evaluateOpenInterestSpike(
      { change5mPct: 1.5, change1hPct: 10.1 },
      { spike5mPct: 5, spike1hPct: 10 }
    ).hit,
    true
  );
  assert.equal(
    evaluateOpenInterestSpike(
      { change5mPct: 4.99, change1hPct: 9.99 },
      { spike5mPct: 5, spike1hPct: 10 }
    ).hit,
    false
  );
});

test("OI spike ignores missing and non-numeric changes", () => {
  assert.deepEqual(evaluateOpenInterestSpike({ change5mPct: null, change1hPct: "bad" }), {
    hit: false,
    hit5m: false,
    hit1h: false,
    change5mPct: null,
    change1hPct: null
  });
});
