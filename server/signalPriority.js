export const SIGNAL_PRIORITY = Object.freeze({
  HIGHEST: 0,
  LEVEL1: 30,
  LEVEL2: 31,
  NONE: 99
});

export function resolveBestAlertLevel(values = []) {
  const levels = (Array.isArray(values) ? values : [values]).map((item) =>
    typeof item === "string" ? item : item?.alertLevel ?? item?.signal?.alertLevel
  );
  if (levels.includes("LEVEL1")) return "LEVEL1";
  if (levels.includes("LEVEL2")) return "LEVEL2";
  return null;
}

export function resolveSignalProfile({
  fundingOneHour = false,
  oiSpike = false,
  oiMatched = null,
  hotRank = false,
  multiCycleCount = 0,
  alertLevel = null
} = {}) {
  const multi = Number(multiCycleCount) >= 3;
  const oi = oiMatched === null ? Boolean(oiSpike) : Boolean(oiMatched);
  const validAlertLevel = alertLevel === "LEVEL1" || alertLevel === "LEVEL2" ? alertLevel : null;
  if (!validAlertLevel) {
    return { key: "NONE", label: "观察", priority: SIGNAL_PRIORITY.NONE, multi, sourceMask: 0, sources: [] };
  }
  const sourceMask =
    (fundingOneHour ? 8 : 0) +
    (oi ? 4 : 0) +
    (hotRank ? 2 : 0) +
    (multi ? 1 : 0);
  const sources = [
    fundingOneHour ? "资金费" : null,
    oi ? "OI" : null,
    hotRank ? "热度" : null,
    multi ? "多周期" : null
  ].filter(Boolean);
  const key = sourceMask ? `COMBO_${sourceMask}_${validAlertLevel}` : validAlertLevel;
  const levelLabel = validAlertLevel === "LEVEL1" ? "一级警报" : "二级警报";
  const priority = sourceMask
    ? (15 - sourceMask) * 2 + (validAlertLevel === "LEVEL2" ? 1 : 0)
    : SIGNAL_PRIORITY[validAlertLevel];

  return {
    key,
    label: sources.length ? `${sources.join(" + ")} · ${levelLabel}` : levelLabel,
    priority,
    multi,
    sourceMask,
    sources
  };
}
