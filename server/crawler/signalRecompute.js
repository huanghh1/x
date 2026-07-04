import {
  getSignalCorrelationContext,
  markHotMaSignalAlertSent,
  recordMultiCycleHistory,
  selectClosePrices,
  selectHotMaSignalAlert,
  selectPreviousSignals,
  upsertSignals
} from "../db.js";
import { calculateSignal, INTERVALS } from "../ma.js";
import { resolveBestAlertLevel, resolveSignalProfile } from "../signalPriority.js";
import { sendHotMaSignalTelegram } from "../telegram.js";
import {
  buildHotMaSignalAlertState,
  shouldRefreshHotMaSignalAlertState,
  shouldSendHotMaSignalAlert,
  shouldSuppressHotMaSignalAfterOiAlert
} from "./hotMaAlertState.js";
import { normalizeCrawlerToken } from "./tokenUtils.js";

const hotMaAlertingSymbols = new Set();

export async function recomputeAndNotifyToken(token) {
  token = normalizeCrawlerToken(token);
  const [previousByInterval, closeGroups] = await Promise.all([
    selectPreviousSignals(token.symbol),
    Promise.all(
      INTERVALS.map(async (intervalCode) => ({
        intervalCode,
        closes: await selectClosePrices(token.symbol, intervalCode)
      }))
    )
  ]);
  const computedSignals = closeGroups.map(({ intervalCode, closes }) => ({
    intervalCode,
    previous: previousByInterval.get(intervalCode) ?? null,
    signal: calculateSignal({ intervalCode, closes })
  }));
  await upsertSignals(token, computedSignals.map(({ signal }) => signal));

  const multiCycleSignals = computedSignals.filter(({ signal }) => ["LEVEL1", "LEVEL2"].includes(signal.alertLevel));
  const telegramContext = {
    multiCycleCount: multiCycleSignals.length,
    multiCycleIntervals: multiCycleSignals.map(({ intervalCode }) => intervalCode)
  };
  await recordMultiCycleHistory(token, computedSignals, 3);

  const newAlertSignals = computedSignals.filter(
    ({ previous, signal }) =>
      ["LEVEL1", "LEVEL2"].includes(signal.alertLevel) && previous?.alert_level !== signal.alertLevel
  );

  const correlation = await getSignalCorrelationContext(token.symbol);
  const hotRankActive = multiCycleSignals.length > 0 && correlation.hotRank;
  const bestAlertLevel = resolveBestAlertLevel(multiCycleSignals);
  const profile = resolveSignalProfile({
    fundingOneHour: correlation.fundingOneHour,
    hotRank: hotRankActive,
    multiCycleCount: multiCycleSignals.length,
    alertLevel: bestAlertLevel,
    oiSpike: correlation.oiSpike
  });
  telegramContext.fundingOneHour = correlation.fundingOneHour;
  telegramContext.hotRank = hotRankActive;
  telegramContext.oiSpike = correlation.oiSpike;
  telegramContext.oiChange5mPct = correlation.oiChange5mPct;
  telegramContext.oiChange1hPct = correlation.oiChange1hPct;
  telegramContext.oiChange4hPct = correlation.oiChange4hPct;
  telegramContext.oiChange1dPct = correlation.oiChange1dPct;
  telegramContext.oiSpike5mHit = correlation.oiSpike5mHit;
  telegramContext.oiSpike1hHit = correlation.oiSpike1hHit;
  telegramContext.oiSpike4hHit = correlation.oiSpike4hHit;
  telegramContext.oiSpike1dHit = correlation.oiSpike1dHit;
  telegramContext.oiLastSpikeAlertAt = correlation.oiLastSpikeAlertAt;
  telegramContext.oiAlertPending = correlation.oiAlertPending;
  telegramContext.alertLevel = bestAlertLevel;
  telegramContext.profile = profile;
  if (multiCycleSignals.length > 0 && profile.sourceMask > 0) {
    if (hotMaAlertingSymbols.has(token.symbol)) return;
    hotMaAlertingSymbols.add(token.symbol);
    try {
      const alertState = buildHotMaSignalAlertState(multiCycleSignals, telegramContext);
      const changedIntervals = new Set(newAlertSignals.map(({ intervalCode }) => intervalCode));
      const alertStates = await Promise.all(
        multiCycleSignals.map(async ({ intervalCode, previous, signal }) => {
          const previousAlert = await selectHotMaSignalAlert(token.symbol, intervalCode);
          return {
            shouldSend: shouldSendHotMaSignalAlert({
              previousAlert,
              previousSignalLevel: previous?.alert_level,
              signal,
              signalChanged: changedIntervals.has(intervalCode),
              alertState
            }),
            shouldRefresh: shouldRefreshHotMaSignalAlertState(previousAlert, alertState)
          };
        })
      );
      if (alertStates.some(({ shouldSend }) => shouldSend)) {
        if (shouldSuppressHotMaSignalAfterOiAlert(telegramContext)) {
          await Promise.all(
            multiCycleSignals.map(({ intervalCode, signal }) =>
              markHotMaSignalAlertSent(token.symbol, intervalCode, signal, alertState)
            )
          );
        } else {
          const representative = multiCycleSignals.find(({ signal }) => signal.alertLevel === bestAlertLevel)
            ?? multiCycleSignals[0];
          const result = await sendHotMaSignalTelegram(token, representative.signal, telegramContext);
          if (!result.skipped) {
            await Promise.all(
              multiCycleSignals.map(({ intervalCode, signal }) =>
                markHotMaSignalAlertSent(token.symbol, intervalCode, signal, alertState)
              )
            );
          }
        }
      } else if (alertStates.some(({ shouldRefresh }) => shouldRefresh)) {
        await Promise.all(
          multiCycleSignals.map(({ intervalCode, signal }) =>
            markHotMaSignalAlertSent(token.symbol, intervalCode, signal, { ...alertState, preserveSentAt: true })
          )
        );
      }
    } finally {
      hotMaAlertingSymbols.delete(token.symbol);
    }
  }
}
