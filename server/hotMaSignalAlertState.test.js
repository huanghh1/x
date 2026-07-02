import assert from "node:assert/strict";
import test from "node:test";
import {
  buildHotMaSignalAlertState,
  shouldBackfillHotMaSignalAlertState,
  shouldSuppressHotMaSignalAfterOiAlert,
  shouldSendHotMaSignalAlert
} from "./crawler.js";

function signal(intervalCode, alertLevel, signalTime = 1_700_000_000_000) {
  return {
    intervalCode,
    signal: {
      intervalCode,
      alertLevel,
      signalTime
    }
  };
}

test("hot MA Telegram state ignores new kline time when level and context stay unchanged", () => {
  const context = { hotRank: true, alertLevel: "LEVEL2" };
  const firstState = buildHotMaSignalAlertState([signal("15m", "LEVEL2", 1_700_000_000_000)], context);
  const nextState = buildHotMaSignalAlertState([signal("15m", "LEVEL2", 1_700_000_900_000)], context);

  assert.equal(nextState.contextSignature, firstState.contextSignature);
  assert.equal(
    shouldSendHotMaSignalAlert({
      previousAlert: {
        alertLevel: "LEVEL2",
        profileKey: firstState.profileKey,
        sourceMask: firstState.sourceMask,
        contextSignature: firstState.contextSignature
      },
      signal: { alertLevel: "LEVEL2", signalTime: 1_700_000_900_000 },
      alertState: nextState
    }),
    false
  );
});

test("hot MA Telegram state sends when level or combination context changes", () => {
  const firstState = buildHotMaSignalAlertState([signal("15m", "LEVEL2")], {
    hotRank: true,
    alertLevel: "LEVEL2"
  });
  const oiState = buildHotMaSignalAlertState([signal("15m", "LEVEL2")], {
    hotRank: true,
    oiSpike: true,
    oiSpike1hHit: true,
    alertLevel: "LEVEL2"
  });
  const previousAlert = {
    alertLevel: "LEVEL2",
    profileKey: firstState.profileKey,
    sourceMask: firstState.sourceMask,
    contextSignature: firstState.contextSignature
  };

  assert.equal(
    shouldSendHotMaSignalAlert({
      previousAlert,
      signal: { alertLevel: "LEVEL1" },
      signalChanged: true,
      alertState: firstState
    }),
    true
  );
  assert.equal(
    shouldSendHotMaSignalAlert({
      previousAlert,
      signal: { alertLevel: "LEVEL2" },
      alertState: oiState
    }),
    true
  );
});

test("legacy hot MA Telegram rows are backfilled instead of resent only for missing state fields", () => {
  const alertState = buildHotMaSignalAlertState([signal("15m", "LEVEL2")], {
    hotRank: true,
    alertLevel: "LEVEL2"
  });
  const legacyAlert = { alertLevel: "LEVEL2", signalTime: new Date() };

  assert.equal(shouldBackfillHotMaSignalAlertState(legacyAlert), true);
  assert.equal(
    shouldSendHotMaSignalAlert({
      previousAlert: legacyAlert,
      signal: { alertLevel: "LEVEL2" },
      alertState
    }),
    false
  );
});

test("hot MA Telegram is suppressed after an OI alert is already sent or pending", () => {
  assert.equal(
    shouldSuppressHotMaSignalAfterOiAlert({
      oiSpike: true,
      oiLastSpikeAlertAt: new Date()
    }),
    true
  );
  assert.equal(
    shouldSuppressHotMaSignalAfterOiAlert({
      oiSpike: true,
      oiAlertPending: true
    }),
    true
  );
  assert.equal(
    shouldSuppressHotMaSignalAfterOiAlert({
      oiSpike: true,
      oiLastSpikeAlertAt: null,
      oiAlertPending: false
    }),
    false
  );
  assert.equal(
    shouldSuppressHotMaSignalAfterOiAlert({
      oiSpike: false,
      oiLastSpikeAlertAt: new Date()
    }),
    false
  );
});
