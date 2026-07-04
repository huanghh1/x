export function clamp(value, min, max) {
  return Math.max(min, Math.min(value, max));
}

export function formatNumber(value, digits = 6) {
  if (value === null || value === undefined || value === "") return "--";
  const number = Number(value);
  if (!Number.isFinite(number)) return "--";
  if (Math.abs(number) >= 1000) return number.toLocaleString("en-US", { maximumFractionDigits: 2 });
  return number.toLocaleString("en-US", { maximumFractionDigits: digits });
}

export function formatCompactUsd(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return "--";
  return `$${number.toLocaleString("en-US", { notation: "compact", maximumFractionDigits: 2 })}`;
}

export function formatCompactNumber(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return "--";
  return number.toLocaleString("en-US", { notation: "compact", maximumFractionDigits: 2 });
}

export function formatBytes(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return "0B";
  if (number >= 1024 * 1024) return `${(number / 1024 / 1024).toFixed(1)}MB`;
  if (number >= 1024) return `${(number / 1024).toFixed(1)}KB`;
  return `${number}B`;
}

export function formatPercent(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return "--";
  return `${number >= 0 ? "+" : ""}${number.toLocaleString("en-US", { maximumFractionDigits: 2 })}%`;
}

export function formatFundingPercent(value) {
  const number = Number(value);
  if (value === null || value === undefined || !Number.isFinite(number)) return "--";
  return `${number > 0 ? "+" : ""}${(number * 100).toFixed(4)}%`;
}

export function formatUsd(value, digits = 2) {
  const number = Number(value);
  if (!Number.isFinite(number)) return "--";
  const sign = number < 0 ? "-" : "";
  return `${sign}$${Math.abs(number).toLocaleString("en-US", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits
  })}`;
}

export function pnlClass(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number === 0) return "is-neutral";
  return number > 0 ? "is-positive" : "is-negative";
}

export function toDatetimeLocal(value) {
  const date = value ? new Date(value) : new Date();
  if (Number.isNaN(date.getTime())) return "";
  const offsetMs = date.getTimezoneOffset() * 60 * 1000;
  return new Date(date.getTime() - offsetMs).toISOString().slice(0, 16);
}

export function datetimeLocalToIso(value) {
  if (!value) return "";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "" : date.toISOString();
}

export function fundingRateTone(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number === 0) return "is-neutral";
  return number > 0 ? "is-positive" : "is-negative";
}

export function oiChangeSummary(row) {
  const intervals = [
    ["5m", row.oiChange5mPct, row.oiSpike5mHit],
    ["1h", row.oiChange1hPct, row.oiSpike1hHit],
    ["4h", row.oiChange4hPct, row.oiSpike4hHit],
    ["1d", row.oiChange1dPct, row.oiSpike1dHit]
  ];
  const available = intervals.filter(([, value]) => Number.isFinite(Number(value)));
  const hits = available.filter(([, , hit]) => hit);
  return (hits.length ? hits : available)
    .map(([label, value]) => `${label} ${formatPercent(value)}`)
    .join(" / ");
}

function cssVar(name, fallback) {
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return value || fallback;
}

export function chartPalette() {
  return {
    bg: cssVar("--chart-bg", "#0b1017"),
    panel: cssVar("--chart-panel", "#111923"),
    grid: cssVar("--chart-grid", "rgba(148, 163, 184, 0.16)"),
    gridStrong: cssVar("--chart-grid-strong", "rgba(148, 163, 184, 0.28)"),
    text: cssVar("--chart-text", "#e7eef7"),
    muted: cssVar("--chart-muted", "#8d99a8"),
    axis: cssVar("--chart-axis", "#2d3947"),
    up: cssVar("--chart-up", "#16c784"),
    down: cssVar("--chart-down", "#f6465d"),
    ma100: cssVar("--chart-ma100", "#f5b041"),
    ma200: cssVar("--chart-ma200", "#35a7ff"),
    crosshair: cssVar("--chart-crosshair", "rgba(231, 238, 247, 0.42)"),
    tooltipBg: cssVar("--chart-tooltip-bg", "rgba(15, 23, 32, 0.94)"),
    tooltipLine: cssVar("--chart-tooltip-line", "rgba(231, 238, 247, 0.14)")
  };
}

export function formatTime(value) {
  if (!value) return "--";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "--";
  return date.toLocaleString("zh-CN", { hour12: false });
}

export function crawlerStatusLabel(crawler = {}) {
  if (!crawler.running) return "空闲";
  if (crawler.runMode === "repair") return "缺口修复中";
  if (crawler.runMode === "manual") return crawler.includeIncremental ? "手动刷新中" : "手动修复中";
  return "增量刷新中";
}

export function crawlerMetaText(crawler = {}) {
  const status = crawlerStatusLabel(crawler);
  if (!crawler.running) return status;
  const symbol = crawler.currentSymbol || "等待队列";
  const interval = crawler.currentInterval ? ` ${crawler.currentInterval}` : "";
  return `${status} · ${symbol}${interval}`;
}

export function crawlerDetailText(crawler = {}) {
  const parts = [];
  if (crawler.lastError) parts.push(crawler.lastError);
  else if (crawler.lastAction) parts.push(crawler.lastAction);
  if (!crawler.lastError && Number(crawler.tailRefresh?.errorCount ?? 0) > 0) {
    parts.push(`快速追尾失败 ${crawler.tailRefresh.errorCount} 次`);
  }
  if (crawler.running && Number(crawler.processedTokenCount ?? 0) > 0) {
    parts.push(`本轮已处理 ${crawler.processedTokenCount} 个`);
  }
  if (crawler.running && crawler.incrementalCutoffAt) {
    parts.push(`增量截止 ${formatTime(crawler.incrementalCutoffAt)}`);
  }
  if (!crawler.running && crawler.runCompletedAt) {
    parts.push(`完成 ${formatTime(crawler.runCompletedAt)}`);
  }
  return parts.join(" · ") || "正常";
}

export function formatCompactTime(value) {
  if (!value) return "--";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "--";
  const now = new Date();
  const sameDay = date.toDateString() === now.toDateString();
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  const time = date.toLocaleTimeString("zh-CN", { hour12: false });
  if (sameDay) return time;
  if (date.toDateString() === yesterday.toDateString()) return `昨天 ${time.slice(0, 5)}`;
  return `${date.getMonth() + 1}/${date.getDate()} ${time.slice(0, 5)}`;
}

export function formatAge(value) {
  const date = new Date(value);
  const timestamp = date.getTime();
  if (!Number.isFinite(timestamp)) return "--";
  const seconds = Math.max(0, Math.floor((Date.now() - timestamp) / 1000));
  if (seconds < 90) return `${seconds}秒前`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 90) return `${minutes}分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}小时前`;
  return `${Math.floor(hours / 24)}天前`;
}

export function cssEscape(value) {
  const text = String(value ?? "");
  return window.CSS?.escape ? CSS.escape(text) : text.replace(/["\\]/g, "\\$&");
}
