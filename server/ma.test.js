import assert from "node:assert/strict";
import test from "node:test";
import { calculateSignal } from "./ma.js";

function closeRows(values) {
  const start = 1_700_000_000_000;
  return values.map((close, index) => ({
    close,
    closeTime: start + index * 60_000
  }));
}

test("MA signal ignores invalid closes and reports insufficient samples safely", () => {
  const signal = calculateSignal({
    intervalCode: "15m",
    closes: [null, { close: 0, closeTime: 1 }, { close: "bad", closeTime: 2 }, { close: 10, closeTime: 3 }]
  });

  assert.equal(signal.alertLevel, "INSUFFICIENT");
  assert.equal(signal.currentPrice, 10);
  assert.match(signal.note, /1 根有效K线/);
});

test("MA signal sorts by close time before calculating the latest price", () => {
  const values = [
    ...Array.from({ length: 100 }, () => 80),
    ...Array.from({ length: 99 }, () => 120),
    100
  ];
  const rows = closeRows(values).reverse();
  const signal = calculateSignal({ intervalCode: "1h", closes: rows });

  assert.equal(signal.alertLevel, "LEVEL1");
  assert.equal(signal.currentPrice, 100);
  assert.equal(signal.signalStatus, "一级警报");
});

test("MA signal handles missing close arrays without throwing", () => {
  const signal = calculateSignal({ intervalCode: "4h" });

  assert.equal(signal.alertLevel, "INSUFFICIENT");
  assert.equal(signal.ma100, null);
  assert.equal(signal.ma200, null);
});
