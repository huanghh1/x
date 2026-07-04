import {
  hasNewListItem,
  hasNewOrUpgradedIntervalSignal,
  isAlertLevelEntryOrUpgrade,
  normalizeAlertLevel,
  parseIntervalLevelSignature,
  parseKeyValueSignature,
  parseSignatureList
} from "../alertState.js";
import { INTERVALS } from "../ma.js";
import { resolveBestAlertLevel, resolveSignalProfile } from "../signalPriority.js";

function intervalSortIndex(intervalCode) {
  const index = INTERVALS.indexOf(intervalCode);
  return index === -1 ? INTERVALS.length : index;
}

function hasComparableHotMaAlertState(previousAlert) {
  return Boolean(previousAlert?.profileKey && previousAlert?.contextSignature && Number(previousAlert?.sourceMask) > 0);
}

function parseHotMaAlertSignature(signature, sourceMask = 0) {
  const state = parseKeyValueSignature(signature);
  return {
    sourceMask: Number(sourceMask || state.get("sources") || 0) || 0,
    level: normalizeAlertLevel(state.get("level")),
    fundingOneHour: state.get("funding") === "1",
    hotRank: state.get("hot") === "1",
    oiSpike: state.get("oi") === "1",
    oiWindows: parseSignatureList(state.get("oiWindows")),
    intervals: parseIntervalLevelSignature(state.get("intervals"))
  };
}

function hasNewHotMaAlertEntry(previousAlert, alertState = {}) {
  const previousState = parseHotMaAlertSignature(previousAlert?.contextSignature, previousAlert?.sourceMask);
  const currentState = parseHotMaAlertSignature(alertState.contextSignature, alertState.sourceMask);
  return (
    (currentState.sourceMask & ~previousState.sourceMask) !== 0 ||
    (!previousState.fundingOneHour && currentState.fundingOneHour) ||
    (!previousState.hotRank && currentState.hotRank) ||
    (!previousState.oiSpike && currentState.oiSpike) ||
    hasNewListItem(currentState.oiWindows, previousState.oiWindows) ||
    hasNewOrUpgradedIntervalSignal(currentState.intervals, previousState.intervals) ||
    isAlertLevelEntryOrUpgrade(previousState.level, currentState.level)
  );
}

export function buildHotMaSignalAlertState(multiCycleSignals = [], context = {}) {
  const intervalStates = (Array.isArray(multiCycleSignals) ? multiCycleSignals : [])
    .map(({ intervalCode, signal }) => ({
      intervalCode: String(intervalCode ?? signal?.intervalCode ?? ""),
      alertLevel: signal?.alertLevel
    }))
    .filter(({ intervalCode, alertLevel }) => INTERVALS.includes(intervalCode) && ["LEVEL1", "LEVEL2"].includes(alertLevel))
    .sort((a, b) => intervalSortIndex(a.intervalCode) - intervalSortIndex(b.intervalCode));
  const alertLevel = ["LEVEL1", "LEVEL2"].includes(context.alertLevel)
    ? context.alertLevel
    : resolveBestAlertLevel(intervalStates.map(({ alertLevel: level }) => level));
  const profile = context.profile ?? resolveSignalProfile({
    fundingOneHour: context.fundingOneHour,
    hotRank: context.hotRank,
    multiCycleCount: intervalStates.length,
    alertLevel,
    oiSpike: context.oiSpike
  });
  const oiWindows = [
    context.oiSpike5mHit ? "5m" : null,
    context.oiSpike1hHit ? "1h" : null,
    context.oiSpike4hHit ? "4h" : null,
    context.oiSpike1dHit ? "1d" : null
  ].filter(Boolean);
  const intervalSignature = intervalStates
    .map(({ intervalCode, alertLevel: level }) => `${intervalCode}:${level}`)
    .join(",");
  const sourceMask = Number(profile.sourceMask ?? 0);
  const profileKey = String(profile.key ?? "");
  const contextSignature = [
    `profile=${profileKey}`,
    `level=${alertLevel ?? "none"}`,
    `sources=${sourceMask}`,
    `funding=${context.fundingOneHour ? 1 : 0}`,
    `hot=${context.hotRank ? 1 : 0}`,
    `oi=${context.oiSpike ? 1 : 0}`,
    `oiWindows=${oiWindows.join(",") || "none"}`,
    `intervals=${intervalSignature || "none"}`
  ].join(";");

  return {
    profileKey,
    sourceMask,
    contextSignature,
    intervalSignature,
    alertLevel
  };
}

export function shouldSendHotMaSignalAlert({
  previousAlert,
  previousSignalLevel = null,
  signal,
  signalChanged = false,
  alertState
}) {
  const currentLevel = normalizeAlertLevel(signal?.alertLevel);
  if (!currentLevel) return false;
  if (!previousAlert) return true;
  if (signalChanged && isAlertLevelEntryOrUpgrade(previousSignalLevel, currentLevel)) return true;
  if (previousAlert.alertLevel !== currentLevel && isAlertLevelEntryOrUpgrade(previousAlert.alertLevel, currentLevel)) {
    return true;
  }
  if (!hasComparableHotMaAlertState(previousAlert)) return false;
  return hasNewHotMaAlertEntry(previousAlert, alertState);
}

export function shouldBackfillHotMaSignalAlertState(previousAlert) {
  return Boolean(previousAlert && !hasComparableHotMaAlertState(previousAlert));
}

export function shouldRefreshHotMaSignalAlertState(previousAlert, alertState = {}) {
  if (!previousAlert || !alertState?.contextSignature) return false;
  if (!hasComparableHotMaAlertState(previousAlert)) return true;
  return (
    String(previousAlert.profileKey) !== String(alertState.profileKey ?? "") ||
    Number(previousAlert.sourceMask ?? 0) !== Number(alertState.sourceMask ?? 0) ||
    String(previousAlert.contextSignature) !== String(alertState.contextSignature)
  );
}

export function shouldSuppressHotMaSignalAfterOiAlert(context = {}) {
  return Boolean(context?.oiSpike && (context.oiLastSpikeAlertAt || context.oiAlertPending));
}
