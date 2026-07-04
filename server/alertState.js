const ALERT_LEVEL_RANK = {
  LEVEL2: 1,
  LEVEL1: 2
};

export function normalizeAlertLevel(level) {
  return level === "LEVEL1" || level === "LEVEL2" ? level : null;
}

export function isAlertLevelEntryOrUpgrade(previousLevel, currentLevel) {
  const current = normalizeAlertLevel(currentLevel);
  if (!current) return false;
  const previous = normalizeAlertLevel(previousLevel);
  if (!previous) return true;
  return ALERT_LEVEL_RANK[current] > ALERT_LEVEL_RANK[previous];
}

export function parseKeyValueSignature(signature) {
  const state = new Map();
  for (const part of String(signature ?? "").split(";")) {
    const separatorIndex = part.indexOf("=");
    if (separatorIndex <= 0) continue;
    state.set(part.slice(0, separatorIndex), part.slice(separatorIndex + 1));
  }
  return state;
}

export function parseSignatureList(value) {
  const text = String(value ?? "").trim();
  if (!text || text === "none") return [];
  return text.split(",").map((item) => item.trim()).filter(Boolean);
}

export function hasNewListItem(currentItems = [], previousItems = []) {
  const previous = new Set(previousItems);
  return currentItems.some((item) => !previous.has(item));
}

export function parseIntervalLevelSignature(value) {
  const result = new Map();
  for (const item of parseSignatureList(value)) {
    const [intervalCode, level] = item.split(":");
    if (!intervalCode) continue;
    result.set(intervalCode, normalizeAlertLevel(level));
  }
  return result;
}

export function hasNewOrUpgradedIntervalSignal(currentIntervals, previousIntervals) {
  for (const [intervalCode, currentLevel] of currentIntervals) {
    if (!previousIntervals.has(intervalCode)) return true;
    if (isAlertLevelEntryOrUpgrade(previousIntervals.get(intervalCode), currentLevel)) return true;
  }
  return false;
}
