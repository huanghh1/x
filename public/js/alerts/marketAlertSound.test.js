import test from "node:test";
import assert from "node:assert/strict";

import { findNewMarketAlerts, marketAlertSnapshot } from "./marketAlertSound.js";

test("market alert snapshot tracks OI windows and funding symbols separately", () => {
  const snapshot = marketAlertSnapshot({
    oiAlerts: [{ symbol: "btcusdt", windows: ["5m", "1h"] }],
    fundingAlerts: [{ symbol: "ethusdt", currentFundingRate: -0.002 }]
  });

  assert.deepEqual(Array.from(snapshot.entries()), [
    ["OI|BTCUSDT|5m", { type: "OI", symbol: "BTCUSDT", window: "5m" }],
    ["OI|BTCUSDT|1h", { type: "OI", symbol: "BTCUSDT", window: "1h" }],
    ["FUNDING|ETHUSDT", { type: "FUNDING", symbol: "ETHUSDT", currentFundingRate: -0.002 }]
  ]);
});

test("first market alert snapshot only establishes the baseline", () => {
  const current = marketAlertSnapshot({ fundingAlerts: [{ symbol: "ETHUSDT" }] });
  assert.deepEqual(findNewMarketAlerts(null, current), []);
});

test("new OI windows and funding entries alert while unchanged states do not", () => {
  const previous = marketAlertSnapshot({
    oiAlerts: [{ symbol: "BTCUSDT", windows: ["5m"] }],
    fundingAlerts: [{ symbol: "ETHUSDT", currentFundingRate: -0.001 }]
  });
  const current = marketAlertSnapshot({
    oiAlerts: [{ symbol: "BTCUSDT", windows: ["5m", "1h"] }],
    fundingAlerts: [
      { symbol: "ETHUSDT", currentFundingRate: -0.004 },
      { symbol: "SOLUSDT", currentFundingRate: 0.002 }
    ]
  });

  assert.deepEqual(findNewMarketAlerts(previous, current), [
    { type: "OI", symbol: "BTCUSDT", window: "1h" },
    { type: "FUNDING", symbol: "SOLUSDT", currentFundingRate: 0.002 }
  ]);
});

test("an OI window alerts again after exiting and re-entering", () => {
  const exited = marketAlertSnapshot({ oiAlerts: [] });
  const reentered = marketAlertSnapshot({ oiAlerts: [{ symbol: "BTCUSDT", windows: ["5m"] }] });
  assert.deepEqual(findNewMarketAlerts(exited, reentered), [
    { type: "OI", symbol: "BTCUSDT", window: "5m" }
  ]);
});
