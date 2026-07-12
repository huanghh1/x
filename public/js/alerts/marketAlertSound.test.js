import test from "node:test";
import assert from "node:assert/strict";

import { findNewMarketAlerts, marketAlertSnapshot } from "./marketAlertSound.js";

test("market alert snapshot tracks the latest successful TG event for each symbol", () => {
  const snapshot = marketAlertSnapshot({
    oiAlerts: [{ symbol: "btcusdt", windows: ["5m", "1h"], eventVersion: "oi-1" }],
    fundingAlerts: [{ symbol: "ethusdt", currentFundingRate: -0.002, eventVersion: "funding-1" }]
  });

  assert.deepEqual(Array.from(snapshot.entries()), [
    ["OI|BTCUSDT", { type: "OI", symbol: "BTCUSDT", window: "5m / 1h", eventVersion: "oi-1" }],
    ["FUNDING|ETHUSDT", {
      type: "FUNDING",
      symbol: "ETHUSDT",
      currentFundingRate: -0.002,
      eventVersion: "funding-1"
    }]
  ]);
});

test("first market alert snapshot only establishes the baseline", () => {
  const current = marketAlertSnapshot({ fundingAlerts: [{ symbol: "ETHUSDT" }] });
  assert.deepEqual(findNewMarketAlerts(null, current), []);
});

test("new successful TG event versions alert while unchanged events do not", () => {
  const previous = marketAlertSnapshot({
    oiAlerts: [{ symbol: "BTCUSDT", windows: ["5m"], eventVersion: "oi-1" }],
    fundingAlerts: [{ symbol: "ETHUSDT", currentFundingRate: -0.001, eventVersion: "funding-1" }]
  });
  const current = marketAlertSnapshot({
    oiAlerts: [{ symbol: "BTCUSDT", windows: ["5m", "1h"], eventVersion: "oi-2" }],
    fundingAlerts: [
      { symbol: "ETHUSDT", currentFundingRate: -0.004, eventVersion: "funding-1" },
      { symbol: "SOLUSDT", currentFundingRate: 0.002, eventVersion: "funding-1" }
    ]
  });

  assert.deepEqual(findNewMarketAlerts(previous, current), [
    { type: "OI", symbol: "BTCUSDT", window: "5m / 1h", eventVersion: "oi-2" },
    { type: "FUNDING", symbol: "SOLUSDT", currentFundingRate: 0.002, eventVersion: "funding-1" }
  ]);
});

test("a repeated funding TG push alerts when its send version increments", () => {
  const previous = marketAlertSnapshot({
    fundingAlerts: [{ symbol: "ETHUSDT", eventVersion: "1|1000" }]
  });
  const current = marketAlertSnapshot({
    fundingAlerts: [{ symbol: "ETHUSDT", eventVersion: "2|2000" }]
  });
  assert.deepEqual(findNewMarketAlerts(previous, current), [
    { type: "FUNDING", symbol: "ETHUSDT", currentFundingRate: null, eventVersion: "2|2000" }
  ]);
});
