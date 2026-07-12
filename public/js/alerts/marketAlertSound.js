const SOUND_ALERT_STORAGE_KEY = "signal-monitor:market-alert-sound-enabled:v2";
const LEGACY_STORAGE_KEYS = [
  "signal-monitor:market-alert-sound-enabled:v1",
  "signal-monitor:oi-alert-sound-enabled:v1",
  "signal-monitor:funding-alert-sound-enabled:v1"
];
const ALERT_POLL_MS = 15 * 1000;

export function marketAlertSnapshot(payload = {}) {
  const snapshot = new Map();
  for (const row of payload.oiAlerts ?? []) {
    const symbol = String(row?.symbol ?? "").trim().toUpperCase();
    if (!symbol) continue;
    for (const window of row.windows ?? []) {
      const safeWindow = String(window ?? "").trim();
      if (!safeWindow) continue;
      snapshot.set(`OI|${symbol}|${safeWindow}`, {
        type: "OI",
        symbol,
        window: safeWindow
      });
    }
  }
  for (const row of payload.fundingAlerts ?? []) {
    const symbol = String(row?.symbol ?? "").trim().toUpperCase();
    if (!symbol) continue;
    snapshot.set(`FUNDING|${symbol}`, {
      type: "FUNDING",
      symbol,
      currentFundingRate: row.currentFundingRate ?? null
    });
  }
  return snapshot;
}

export function findNewMarketAlerts(previous, current) {
  if (!(previous instanceof Map)) return [];
  return Array.from(current.entries())
    .filter(([key]) => !previous.has(key))
    .map(([, alert]) => alert);
}

function storedEnabled() {
  try {
    const stored = localStorage.getItem(SOUND_ALERT_STORAGE_KEY);
    if (stored !== null) return stored === "1";
    return LEGACY_STORAGE_KEYS.some((key) => localStorage.getItem(key) === "1");
  } catch {
    return false;
  }
}

function saveEnabled(enabled) {
  try {
    localStorage.setItem(SOUND_ALERT_STORAGE_KEY, enabled ? "1" : "0");
  } catch {
    // Storage can be unavailable in private or restricted browser contexts.
  }
}

function audioContextClass() {
  return window.AudioContext || window.webkitAudioContext || null;
}

function playPoliceSiren(context) {
  const start = context.currentTime + 0.03;
  const duration = 2.4;
  const oscillator = context.createOscillator();
  const overtone = context.createOscillator();
  const volume = context.createGain();
  const overtoneVolume = context.createGain();

  oscillator.type = "triangle";
  overtone.type = "sine";
  oscillator.frequency.setValueAtTime(620, start);
  overtone.frequency.setValueAtTime(930, start);
  for (let offset = 0.3; offset <= duration; offset += 0.3) {
    const rising = Math.round(offset / 0.3) % 2 === 1;
    oscillator.frequency.linearRampToValueAtTime(rising ? 980 : 620, start + offset);
    overtone.frequency.linearRampToValueAtTime(rising ? 1470 : 930, start + offset);
  }

  volume.gain.setValueAtTime(0.0001, start);
  volume.gain.exponentialRampToValueAtTime(0.11, start + 0.04);
  volume.gain.setValueAtTime(0.11, start + duration - 0.08);
  volume.gain.exponentialRampToValueAtTime(0.0001, start + duration);
  overtoneVolume.gain.setValueAtTime(0.0001, start);
  overtoneVolume.gain.exponentialRampToValueAtTime(0.025, start + 0.04);
  overtoneVolume.gain.setValueAtTime(0.025, start + duration - 0.08);
  overtoneVolume.gain.exponentialRampToValueAtTime(0.0001, start + duration);

  oscillator.connect(volume);
  overtone.connect(overtoneVolume);
  volume.connect(context.destination);
  overtoneVolume.connect(context.destination);
  oscillator.start(start);
  overtone.start(start);
  oscillator.stop(start + duration + 0.02);
  overtone.stop(start + duration + 0.02);
}

function alertSummary(alerts) {
  const oi = alerts.filter((alert) => alert.type === "OI");
  const funding = alerts.filter((alert) => alert.type === "FUNDING");
  const parts = [];
  if (oi.length) {
    const examples = oi.slice(0, 2).map((alert) => `${alert.symbol} ${alert.window}`).join("、");
    parts.push(`OI ${oi.length} 条（${examples}${oi.length > 2 ? "…" : ""}）`);
  }
  if (funding.length) {
    const examples = funding.slice(0, 2).map((alert) => alert.symbol).join("、");
    parts.push(`资金费率 ${funding.length} 条（${examples}${funding.length > 2 ? "…" : ""}）`);
  }
  return parts.join("；");
}

export function initMarketAlertSounds({ api, button }) {
  if (!button || typeof window === "undefined") return () => {};

  let enabled = storedEnabled();
  let activated = false;
  let unsupported = false;
  let context = null;
  let previousSnapshot = null;
  let polling = false;
  let lastAlertText = "";

  const renderButton = () => {
    button.classList.toggle("active", enabled && activated);
    button.classList.toggle("is-pending", enabled && !activated && !unsupported);
    button.setAttribute("aria-pressed", enabled ? "true" : "false");
    if (unsupported) {
      button.textContent = "当前浏览器不支持声音";
      button.title = "请改用支持网页音频的 Chrome、Edge 或 Safari";
      button.disabled = true;
    } else if (!enabled) {
      button.textContent = "警报声音：关";
      button.title = "点击开启 OI 和资金费率警报声音";
    } else if (!activated) {
      button.textContent = "警报声音：待激活";
      button.title = "浏览器需要你点击一次，才能播放警报声音";
    } else {
      button.textContent = "警报声音：开";
      button.title = lastAlertText || "OI 和资金费率出现新警报时播放声音";
    }
  };

  const activateAudio = async ({ preview = false } = {}) => {
    const AudioContext = audioContextClass();
    if (!AudioContext) {
      unsupported = true;
      enabled = false;
      saveEnabled(false);
      renderButton();
      return false;
    }
    try {
      context ??= new AudioContext();
      await context.resume();
      activated = context.state === "running";
      if (activated && preview) playPoliceSiren(context);
    } catch (error) {
      activated = false;
      console.warn("market alert audio activation failed", error);
    }
    renderButton();
    return activated;
  };

  const poll = async () => {
    if (polling) return;
    polling = true;
    try {
      const payload = await api("/api/browser-alerts");
      const currentSnapshot = marketAlertSnapshot(payload);
      const newAlerts = findNewMarketAlerts(previousSnapshot, currentSnapshot);
      previousSnapshot = currentSnapshot;
      if (!enabled || !activated || !context || !newAlerts.length) return;
      playPoliceSiren(context);
      lastAlertText = `刚刚新增：${alertSummary(newAlerts)}`;
      button.title = lastAlertText;
      button.classList.remove("is-ringing");
      requestAnimationFrame(() => button.classList.add("is-ringing"));
      window.setTimeout(() => button.classList.remove("is-ringing"), 1400);
    } catch (error) {
      console.warn("browser alert poll failed", error);
    } finally {
      polling = false;
    }
  };

  button.addEventListener("click", async () => {
    if (enabled && !activated) {
      await activateAudio({ preview: true });
      return;
    }
    enabled = !enabled;
    saveEnabled(enabled);
    renderButton();
    if (enabled) await activateAudio({ preview: true });
    else if (context?.state === "running") await context.suspend();
    renderButton();
  });

  renderButton();
  void poll();
  const timer = window.setInterval(poll, ALERT_POLL_MS);
  return () => {
    window.clearInterval(timer);
    context?.close().catch(() => {});
  };
}
