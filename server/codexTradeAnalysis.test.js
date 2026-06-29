import assert from "node:assert/strict";
import test from "node:test";
import { normalizeCodexScope, prepareCodexTradeAnalysis } from "./codexTradeAnalysis.js";

const baseTime = Date.UTC(2026, 0, 1, 0, 0, 0);

function event(overrides) {
  return {
    id: overrides.id,
    source: "binance",
    sourceLabel: "Binance USD-M",
    symbol: overrides.symbol,
    time: overrides.time,
    type: "TRADE",
    side: overrides.side ?? "SELL",
    direction: overrides.direction ?? "Close Long",
    quantity: 1,
    price: 100,
    notional: 100,
    realizedPnl: overrides.realizedPnl ?? 0,
    funding: overrides.funding ?? 0,
    commission: overrides.commission ?? -0.1,
    net: (overrides.realizedPnl ?? 0) + (overrides.funding ?? 0) + (overrides.commission ?? -0.1),
    pnlIncluded: true,
    rawType: "USER_TRADE"
  };
}

function analysisFixture() {
  const events = [
    event({ id: "btc-1", symbol: "BTCUSDT", time: baseTime + 1000, realizedPnl: -10 }),
    event({ id: "eth-1", symbol: "ETHUSDT", time: baseTime + 2000, realizedPnl: 5 }),
    event({ id: "btc-2", symbol: "BTCUSDT", time: baseTime + 3000, realizedPnl: 4 })
  ];
  return {
    ok: true,
    window: {
      startTime: new Date(baseTime).toISOString(),
      endTime: new Date(baseTime + 60_000).toISOString()
    },
    symbol: "",
    sources: [{ id: "binance", ok: true, configured: true }],
    positions: [
      { id: "btc-pos", source: "binance", sourceLabel: "Binance USD-M", symbol: "BTCUSDT", notional: 500, unrealizedPnl: -12 },
      { id: "eth-pos", source: "binance", sourceLabel: "Binance USD-M", symbol: "ETHUSDT", notional: 300, unrealizedPnl: 8 }
    ],
    events,
    summary: {
      bySymbol: [
        {
          source: "binance",
          sourceLabel: "Binance USD-M",
          symbol: "BTCUSDT",
          firstTime: baseTime + 1000,
          lastTime: baseTime + 3000,
          events: 2,
          realizedPnl: -6,
          funding: 0,
          commission: -0.2,
          feeCost: 0.2,
          net: -6.2,
          notional: 200
        },
        {
          source: "binance",
          sourceLabel: "Binance USD-M",
          symbol: "ETHUSDT",
          firstTime: baseTime + 2000,
          lastTime: baseTime + 2000,
          events: 1,
          realizedPnl: 5,
          funding: 0,
          commission: -0.1,
          feeCost: 0.1,
          net: 4.9,
          notional: 100
        }
      ]
    }
  };
}

test("normalizeCodexScope falls back to all for unknown values", () => {
  assert.equal(normalizeCodexScope("event"), "trade");
  assert.equal(normalizeCodexScope("range"), "range");
  assert.equal(normalizeCodexScope("bad-value"), "all");
});

test("symbol scope keeps matching USDT and base coin data only", () => {
  const prepared = prepareCodexTradeAnalysis(analysisFixture(), {
    scope: "symbol",
    symbol: "BTC"
  });

  assert.equal(prepared.report.scope, "symbol");
  assert.equal(prepared.report.requestedSymbol, "BTC");
  assert.deepEqual(prepared.report.events.map((item) => item.id).sort(), ["btc-1", "btc-2"]);
  assert.deepEqual(prepared.report.positions.map((item) => item.id), ["btc-pos"]);
  assert.equal(prepared.report.summary.totals.events, 2);
});

test("trade scope includes the selected table record and its same-row detail", () => {
  const prepared = prepareCodexTradeAnalysis(analysisFixture(), {
    scope: "trade",
    tradeKey: JSON.stringify(["binance", "BTCUSDT", baseTime + 1000, baseTime + 3000]),
    contextEventLimit: 10
  });

  assert.equal(prepared.report.scope, "trade");
  assert.equal(prepared.report.selectedTrade.symbol, "BTCUSDT");
  assert.deepEqual(prepared.report.events.map((item) => item.id).sort(), ["btc-1", "btc-2"]);
  assert.ok(!prepared.prompt.includes("test-secret"));
});
