import test from "node:test";
import assert from "node:assert/strict";
import { signalPriceChangePage, sortSignalRowsByPriceChange } from "./signalSort.js";

const rows = [
  { symbol: "FLATUSDT", priceChange24hPct: 0 },
  { symbol: "UPUSDT", priceChange24hPct: "12.5" },
  { symbol: "MISSUSDT", priceChange24hPct: null },
  { symbol: "DOWNUSDT", priceChange24hPct: -7.25 }
];

test("24h signal sorting toggles between descending and ascending", () => {
  assert.deepEqual(
    sortSignalRowsByPriceChange(rows, "desc").map((row) => row.symbol),
    ["UPUSDT", "FLATUSDT", "DOWNUSDT", "MISSUSDT"]
  );
  assert.deepEqual(
    sortSignalRowsByPriceChange(rows, "asc").map((row) => row.symbol),
    ["DOWNUSDT", "FLATUSDT", "UPUSDT", "MISSUSDT"]
  );
});

test("24h signal sorting does not mutate rows and keeps the default order", () => {
  assert.notEqual(sortSignalRowsByPriceChange(rows, "desc"), rows);
  assert.deepEqual(sortSignalRowsByPriceChange(rows), rows);
  assert.deepEqual(rows.map((row) => row.symbol), ["FLATUSDT", "UPUSDT", "MISSUSDT", "DOWNUSDT"]);
});

test("24h realtime changes can move a signal across sorted page boundaries", () => {
  const realtimeRows = rows.map((row) => ({ ...row }));
  assert.deepEqual(
    signalPriceChangePage(realtimeRows, "desc", 1, 2).map((row) => row.symbol),
    ["UPUSDT", "FLATUSDT"]
  );

  realtimeRows.find((row) => row.symbol === "DOWNUSDT").priceChange24hPct = 20;

  assert.deepEqual(
    signalPriceChangePage(realtimeRows, "desc", 1, 2).map((row) => row.symbol),
    ["DOWNUSDT", "UPUSDT"]
  );
  assert.deepEqual(
    signalPriceChangePage(realtimeRows, "desc", 2, 2).map((row) => row.symbol),
    ["FLATUSDT", "MISSUSDT"]
  );
});
