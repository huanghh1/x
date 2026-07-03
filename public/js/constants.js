export const ALL_CATEGORIES = ["A", "B"];
export const ALL_LEVELS = ["LEVEL1", "LEVEL2"];
export const ALL_INTERVALS = ["15m", "1h", "4h", "1d"];
export const OI_REALTIME_WINDOWS = ["5m", "15m", "1h", "4h", "1d"];
export const DAY_MS = 24 * 60 * 60 * 1000;
export const HOUR_MS = 60 * 60 * 1000;
export const TRADE_MAX_LOOKBACK_DAYS = 90;
export const API_MUTATION_TOKEN_STORAGE_KEY = "signal.monitor.apiMutationToken";
export const TOKEN_CODEX_PROMPT_TEMPLATE = "standard";

export const LABELS = {
  category: { A: "A类", B: "B类" },
  level: { LEVEL1: "一级", LEVEL2: "二级" },
  interval: { "15m": "15m", "1h": "1h", "4h": "4h", "1d": "1d" }
};

export const SIGNAL_PROFILE_COLORS = {
  MA: { text: "#7a2148", border: "#f3b5cf", bg: "#fff0f6" },
  1: { text: "#6842ad", border: "#cbbbf2", bg: "#f7f2ff" },
  2: { text: "#8a5405", border: "#f1c27a", bg: "#fff4e4" },
  3: { text: "#8c3f76", border: "#ddb1d3", bg: "#fff2fb" },
  4: { text: "#176da3", border: "#afd9f7", bg: "#eef8ff" },
  5: { text: "#335f96", border: "#b5c9ec", bg: "#eff5ff" },
  6: { text: "#26706a", border: "#acdcd6", bg: "#ecfbf8" },
  7: { text: "#4b698d", border: "#bfd1e7", bg: "#f0f6ff" },
  8: { text: "#b8185d", border: "#f0a8cb", bg: "#fff0f7" },
  9: { text: "#8c356d", border: "#e4afd2", bg: "#fff1fa" },
  10: { text: "#a64720", border: "#ecb197", bg: "#fff1eb" },
  11: { text: "#754f96", border: "#d1b6e8", bg: "#f8f1ff" },
  12: { text: "#17736f", border: "#a9ddd7", bg: "#effbf8" },
  13: { text: "#4d6b8f", border: "#bfd0e6", bg: "#f1f6ff" },
  14: { text: "#9d3c37", border: "#e5aaa7", bg: "#fff1f0" },
  15: { text: "#211721", border: "#d8ccd4", bg: "#f8f3f6" }
};

export function normalizeTokenCodexTemplate(_value) {
  return TOKEN_CODEX_PROMPT_TEMPLATE;
}

export function tokenCodexTemplateLabel() {
  return "常规看币";
}
