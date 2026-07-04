import { api } from "../api.js";
import { state } from "../state.js";
import { escapeHtml } from "../utils/dom.js";
import {
  formatCompactNumber,
  formatNumber,
  formatPercent
} from "../utils/format.js";
import {
  averageRecent,
  chartDefaults,
  chartElementId,
  chartKlineLength,
  intervalMsFromCode
} from "./klineCore.js";
import {
  configureKlineCodex,
  tokenCodexKey,
  tokenCodexPanelHtml
} from "./klineCodex.js";
import {
  bindChartTools,
  configureChartInteractions
} from "./klineInteractions.js";
import { drawChartForKey } from "./klineRenderer.js";

export { chartElementId, chartKlineLength, intervalMsFromCode } from "./klineCore.js";
export { drawChartForKey } from "./klineRenderer.js";

export function configureKlineChart({ copyText, signalProfile } = {}) {
  configureChartInteractions({ copyText });
  configureKlineCodex({ signalProfile, renderChart: loadAndRenderChart });
}

export function updateChartKline(symbol, interval, kline) {
  const key = `${symbol}|${interval}`;
  state.realtimeKlines.set(key, kline);
  const payload = state.chartCache.get(key);
  if (!payload?.klines?.length) return;
  const next = {
    openTime: Number(kline.t),
    closeTime: Number(kline.T),
    open: Number(kline.o),
    high: Number(kline.h),
    low: Number(kline.l),
    close: Number(kline.c),
    volume: Number(kline.v),
    isOpen: !Boolean(kline.x)
  };
  if (!Number.isFinite(next.openTime) || !Number.isFinite(next.close)) return;
  const klines = payload.klines;
  const last = klines.at(-1);
  if (last && last.openTime === next.openTime) {
    Object.assign(last, next);
  } else if (!last || next.openTime > last.openTime) {
    next.gapBefore = last
      ? Math.round((next.openTime - Number(last.openTime)) / intervalMsFromCode(interval)) > 1
      : false;
    klines.push(next);
    if (klines.length > 6000) klines.shift();
    payload._chartKlines = null;
    const settings = state.chartState.get(key);
    if (settings) {
      const length = chartKlineLength(payload);
      settings.start = Math.max(0, length - settings.visible);
    }
  } else {
    return;
  }
  const closes = klines.map((item) => item.close).filter(Number.isFinite);
  const target = klines.at(-1);
  target.ma100 = averageRecent(closes, 100);
  target.ma200 = averageRecent(closes, 200);
  payload.hasCurrentKline = Boolean(target.isOpen);
  payload.currentKlineOpenTime = target.isOpen ? target.openTime : null;
  payload._chartKlines = null;
  drawChartForKey(key);
}

export async function loadAndRenderChart(row, { force = false } = {}) {
  const key = `${row.symbol}|${row.intervalCode}`;
  const shell = document.getElementById(chartElementId(key));
  if (!shell) return;

  try {
    if (force) state.chartCache.delete(key);
    const cached = state.chartCache.get(key);
    const shouldRefreshCached =
      cached?.needsRefresh && Date.now() - Number(cached._fetchedAt ?? 0) > 60_000;
    if (shouldRefreshCached) state.chartCache.delete(key);
    if (!state.chartCache.has(key)) {
      const payload = await api(`/api/klines?symbol=${encodeURIComponent(row.symbol)}&interval=${encodeURIComponent(row.intervalCode)}&limit=all`);
      payload._fetchedAt = Date.now();
      state.chartCache.set(key, payload);
      state.chartState.set(key, chartDefaults(chartKlineLength(payload)));
    }
    const realtimeKline = state.realtimeKlines.get(key);
    if (realtimeKline) updateChartKline(row.symbol, row.intervalCode, realtimeKline);
    const payload = state.chartCache.get(key);
    const settings = state.chartState.get(key) ?? chartDefaults(chartKlineLength(payload));
    state.chartState.set(key, settings);

    if (!payload.klines.length) {
      shell.innerHTML = '<div class="chart-loading">这个交易对当前周期还没有可用 K 线缓存。</div>';
      return;
    }

    const tvSymbol = encodeURIComponent(payload.tradingViewSymbol ?? `BINANCE:${row.symbol}.P`);
    const last = payload.klines.at(-1);
    const previous = payload.klines.at(-2);
    const changePct = previous?.close ? ((Number(last?.close) - Number(previous.close)) / Number(previous.close)) * 100 : null;
    const changeClass = Number(changePct) >= 0 ? "is-up" : "is-down";
    const currentStatus = payload.hasCurrentKline
      ? " · 含当前未收盘K线"
      : " · 等待当前K线实时推送";
    const codexEntry = state.tokenCodex.get(tokenCodexKey(row.symbol, row.intervalCode));
    shell.innerHTML = `
      <div class="chart-toolbar">
        <div class="chart-title-block">
          <strong>${escapeHtml(row.symbol)} ${escapeHtml(row.intervalCode)} K线</strong>
          <span>已收盘 ${payload.cachedCount ?? payload.klines.length} 根 / 目标 ${payload.expectedCount ?? "--"} 根${currentStatus}${payload.gapCount ? ` · 历史缺口 ${payload.gapCount} 段/${payload.missingKlineCount} 根` : ""}${payload.isStale ? " · 最新已收盘K线落后，已请求后台补齐" : ""} · ${payload.hasMa200 ? "MA200 可用" : "新币历史不足 200 根"} · 按住图表自由平移，滚轮缩放时间轴，右侧价格轴单独缩放</span>
        </div>
        <div class="chart-tools" role="toolbar" aria-label="K线工具">
          <button class="${settings.crosshair ? "active" : ""}" type="button" data-tool="crosshair" title="显示或隐藏十字线">十字线</button>
          <button class="${settings.volume ? "active" : ""}" type="button" data-tool="volume" title="显示或隐藏成交量">成交量</button>
          <button class="${settings.ma100 ? "active" : ""}" type="button" data-tool="ma100" title="显示或隐藏 MA100">MA100</button>
          <button class="${settings.ma200 ? "active" : ""}" type="button" data-tool="ma200" title="显示或隐藏 MA200">MA200</button>
          <button class="chart-yokai-copy" type="button" data-tool="copy-yokai-prompt" data-token-codex-symbol="${escapeHtml(row.symbol)}" data-token-codex-interval="${escapeHtml(row.intervalCode)}" title="复制当前交易对的妖币排查话术">复制妖币话术</button>
          <button class="${codexEntry ? "active" : ""}" type="button" data-tool="token-codex" data-token-codex-symbol="${escapeHtml(row.symbol)}" data-token-codex-interval="${escapeHtml(row.intervalCode)}" title="让 Codex 看这个币的图表和信号" ${codexEntry?.loading ? "disabled" : ""}>${codexEntry?.loading ? "分析中" : "Codex看币"}</button>
          <a href="https://www.tradingview.com/chart/?symbol=${tvSymbol}" target="_blank" rel="noreferrer">TradingView</a>
        </div>
      </div>
      <div class="chart-meta">
        <span class="chart-meta-chip ${changeClass}">收盘 ${formatNumber(last?.close)}</span>
        <span class="chart-meta-chip ${changeClass}">涨跌 ${formatPercent(changePct)}</span>
        <span class="chart-meta-chip">高 ${formatNumber(last?.high)}</span>
        <span class="chart-meta-chip">低 ${formatNumber(last?.low)}</span>
        <span class="chart-meta-chip ma100">MA100 ${formatNumber(last?.ma100)}</span>
        <span class="chart-meta-chip ma200">MA200 ${formatNumber(last?.ma200)}</span>
        <span class="chart-meta-chip">量 ${formatCompactNumber(last?.volume)}</span>
        ${last?.isOpen ? '<span class="chart-meta-chip">当前K线</span>' : ""}
      </div>
      <canvas class="kline-canvas" data-key="${escapeHtml(key)}"></canvas>
      ${tokenCodexPanelHtml(row.symbol, row.intervalCode)}
    `;

    bindChartTools(shell, key, loadAndRenderChart);
    drawChartForKey(key);
    scheduleChartRefreshIfNeeded(key, row, payload);
  } catch (error) {
    shell.innerHTML = `<div class="chart-loading">K线读取失败：${escapeHtml(error instanceof Error ? error.message : String(error))}</div>`;
  }
}

function scheduleChartRefreshIfNeeded(key, row, payload) {
  if (!payload?.needsRefresh) {
    state.chartRefreshAttempts.delete(key);
    const timer = state.chartRefreshTimers.get(key);
    if (timer) clearTimeout(timer);
    state.chartRefreshTimers.delete(key);
    return;
  }
  if (state.chartRefreshTimers.has(key)) return;
  const attempts = Number(state.chartRefreshAttempts.get(key) ?? 0);
  if (attempts >= 6) return;
  const delayMs = attempts === 0 ? 12_000 : 25_000;
  const timer = setTimeout(() => {
    state.chartRefreshTimers.delete(key);
    state.chartRefreshAttempts.set(key, attempts + 1);
    const shell = document.getElementById(chartElementId(key));
    if (!shell) return;
    loadAndRenderChart(row, { force: true });
  }, delayMs);
  state.chartRefreshTimers.set(key, timer);
}
