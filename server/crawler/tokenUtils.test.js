import assert from "node:assert/strict";
import test from "node:test";
import { validateTokenUniverseSnapshot } from "./tokenUtils.js";

function token(symbol, categoryType) {
  return { symbol, categoryType };
}

test("token universe validation accepts a healthy snapshot", () => {
  const tokens = [
    ...Array.from({ length: 70 }, (_, index) => token(`A${index}USDT`, "A")),
    ...Array.from({ length: 300 }, (_, index) => token(`B${index}USDT`, "B"))
  ];
  assert.deepEqual(
    validateTokenUniverseSnapshot(tokens, { total: 400, categoryA: 80, categoryB: 320 }),
    { total: 370, categoryA: 70, categoryB: 300 }
  );
});

test("token universe validation rejects an incomplete category snapshot", () => {
  const tokens = [
    ...Array.from({ length: 5 }, (_, index) => token(`A${index}USDT`, "A")),
    ...Array.from({ length: 300 }, (_, index) => token(`B${index}USDT`, "B"))
  ];
  assert.throws(
    () => validateTokenUniverseSnapshot(tokens, { total: 400, categoryA: 80, categoryB: 320 }),
    /categoryA dropped/
  );
});

test("token universe validation rejects duplicate or empty snapshots", () => {
  assert.throws(() => validateTokenUniverseSnapshot([], {}), /snapshot is empty/);
  assert.throws(
    () => validateTokenUniverseSnapshot([token("BTCUSDT", "B"), token("BTCUSDT", "B")], {}),
    /Invalid token universe row/
  );
});
