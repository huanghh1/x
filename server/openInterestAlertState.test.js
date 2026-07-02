import assert from "node:assert/strict";
import test from "node:test";
import {
  buildOpenInterestAlertState,
  shouldBackfillOpenInterestSpikeAlertState,
  shouldSendOpenInterestSpikeAlert
} from "./openInterestMonitor.js";

test("OI Telegram state ignores refreshed values when hit windows and context stay unchanged", () => {
  const context = { intervals: ["15m"], alertLevel: "LEVEL2", multiCycleCount: 1 };
  const firstState = buildOpenInterestAlertState({ hit: true, hit5m: true }, context);
  const nextState = buildOpenInterestAlertState({ hit: true, hit5m: true }, context);

  assert.equal(nextState.signature, firstState.signature);
  assert.equal(
    shouldSendOpenInterestSpikeAlert({
      previous: {
        lastSpikeAlertAt: new Date(),
        lastSpikeAlertSignature: firstState.signature
      },
      previousSpike: { hit: true, hit5m: true },
      spike: { hit: true, hit5m: true },
      alertState: nextState
    }),
    false
  );
});

test("OI Telegram state sends when hit windows or combination context changes", () => {
  const firstState = buildOpenInterestAlertState({ hit: true, hit5m: true }, {
    intervals: ["15m"],
    alertLevel: "LEVEL2",
    multiCycleCount: 1
  });
  const widerWindowState = buildOpenInterestAlertState({ hit: true, hit5m: true, hit1h: true }, {
    intervals: ["15m"],
    alertLevel: "LEVEL2",
    multiCycleCount: 1
  });
  const hotRankState = buildOpenInterestAlertState({ hit: true, hit5m: true }, {
    intervals: ["15m"],
    alertLevel: "LEVEL2",
    multiCycleCount: 1,
    hotRank: true
  });
  const previous = {
    lastSpikeAlertAt: new Date(),
    lastSpikeAlertSignature: firstState.signature
  };

  assert.equal(
    shouldSendOpenInterestSpikeAlert({
      previous,
      previousSpike: { hit: true, hit5m: true },
      spike: { hit: true, hit5m: true, hit1h: true },
      alertState: widerWindowState
    }),
    true
  );
  assert.equal(
    shouldSendOpenInterestSpikeAlert({
      previous,
      previousSpike: { hit: true, hit5m: true },
      spike: { hit: true, hit5m: true },
      alertState: hotRankState
    }),
    true
  );
});

test("OI Telegram state sends again after leaving and re-entering the spike condition", () => {
  const alertState = buildOpenInterestAlertState({ hit: true, hit5m: true }, {});

  assert.equal(
    shouldSendOpenInterestSpikeAlert({
      previous: {
        lastSpikeAlertAt: new Date(),
        lastSpikeAlertSignature: alertState.signature
      },
      previousSpike: { hit: false },
      spike: { hit: true, hit5m: true },
      alertState
    }),
    true
  );
});

test("legacy OI Telegram rows are backfilled instead of resent while still in the same spike", () => {
  const alertState = buildOpenInterestAlertState({ hit: true, hit5m: true }, {});
  const previous = { lastSpikeAlertAt: new Date(), lastSpikeAlertSignature: null };
  const previousSpike = { hit: true, hit5m: true };

  assert.equal(shouldBackfillOpenInterestSpikeAlertState({ previous, previousSpike }), true);
  assert.equal(
    shouldSendOpenInterestSpikeAlert({
      previous,
      previousSpike,
      spike: { hit: true, hit5m: true },
      alertState
    }),
    false
  );
});
