import assert from "node:assert/strict";
import test from "node:test";
import { config } from "./config.js";
import {
  normalizeWatchlistAlertPrice,
  normalizeWatchlistPayload
} from "./db.js";
import {
  resolveWatchlistAlertSide,
  shouldSendWatchlistPriceAlert
} from "./watchRealtime.js";

test("watchlist alert prices accept empty values and positive numbers", () => {
  assert.equal(normalizeWatchlistAlertPrice("", "alertAbove"), null);
  assert.equal(normalizeWatchlistAlertPrice(null, "alertBelow"), null);
  assert.equal(normalizeWatchlistAlertPrice("12.34", "alertAbove"), 12.34);
});

test("watchlist payload sanitizes symbol, note, and alert enabled flag", () => {
  const payload = normalizeWatchlistPayload({
    symbol: " eth-usdt ",
    note: "x".repeat(300),
    alertAbove: "3000",
    alertBelow: "2000",
    alertEnabled: "0"
  });

  assert.equal(payload.symbol, "ETHUSDT");
  assert.equal(payload.baseAsset, "ETH");
  assert.equal(payload.note.length, 255);
  assert.equal(payload.alertAbove, 3000);
  assert.equal(payload.alertBelow, 2000);
  assert.equal(payload.alertEnabled, 0);
});

test("watchlist payload rejects invalid alert ranges", () => {
  assert.throws(
    () => normalizeWatchlistPayload({ symbol: "BTCUSDT", alertAbove: "nope" }),
    /alertAbove must be a positive number/
  );
  assert.throws(
    () => normalizeWatchlistPayload({ symbol: "BTCUSDT", alertBelow: "0" }),
    /alertBelow must be a positive number/
  );
  assert.throws(
    () => normalizeWatchlistPayload({ symbol: "BTCUSDT", alertAbove: "10", alertBelow: "20" }),
    /alertAbove must be greater than alertBelow/
  );
});

test("watchlist price alert state suppresses repeated alerts on the same side", () => {
  const item = { alertAbove: 3000, alertBelow: 2000, lastAlertSide: null };

  assert.equal(resolveWatchlistAlertSide(item, 3100), "above");
  assert.equal(shouldSendWatchlistPriceAlert(item, "above"), true);
  assert.equal(shouldSendWatchlistPriceAlert({ ...item, lastAlertSide: "above" }, "above"), false);
  assert.equal(resolveWatchlistAlertSide({ ...item, lastAlertSide: "above" }, 2500), null);
  assert.equal(shouldSendWatchlistPriceAlert({ ...item, lastAlertSide: null }, "below"), true);
});

test("watchlist price alerts respect the global cooldown after a side reset", () => {
  const originalCooldown = config.realtime.watchlistAlertCooldownMs;
  config.realtime.watchlistAlertCooldownMs = 10 * 60 * 1000;
  try {
    const recentAlert = {
      lastAlertSide: null,
      lastAlertAt: new Date(Date.now() - 2 * 60 * 1000)
    };
    const oldAlert = {
      lastAlertSide: null,
      lastAlertAt: new Date(Date.now() - 11 * 60 * 1000)
    };

    assert.equal(shouldSendWatchlistPriceAlert(recentAlert, "above"), false);
    assert.equal(shouldSendWatchlistPriceAlert(oldAlert, "above"), true);

    config.realtime.watchlistAlertCooldownMs = 0;
    assert.equal(shouldSendWatchlistPriceAlert(recentAlert, "above"), true);
  } finally {
    config.realtime.watchlistAlertCooldownMs = originalCooldown;
  }
});
