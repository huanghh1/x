import { api } from "../api.js";
import { ALL_INTERVALS, LABELS, SIGNAL_PROFILE_COLORS } from "../constants.js";
import { chartElementId, loadAndRenderChart } from "../chart/klineChart.js";
import { state } from "../state.js";
import { $, escapeHtml, setText } from "../utils/dom.js";
import { clamp, cssEscape, formatNumber, formatPercent, formatTime, oiChangeSummary } from "../utils/format.js";
import { sortSignalRowsByPriceChange } from "../utils/signalSort.js";
import { bindCopyButtons, searchButtons } from "../ui/symbolActions.js";

let deps = {
  bindWatchButtons: () => {},
  updateWatchRealtime: () => {},
  watchButton: () => ""
};

export function configureSignals(nextDeps = {}) {
  deps = { ...deps, ...nextDeps };
}

function levelBadge(level) {
  if (level === "LEVEL1") return '<span class="level-badge level1">一级警报</span>';
  if (level === "LEVEL2") return '<span class="level-badge level2">二级预警</span>';
  if (level === "INSUFFICIENT") return '<span class="level-badge">样本不足</span>';
  return '<span class="level-badge none">观察中</span>';
}

export function rowKey(row) {
  return String(row.displayKey ?? row.symbol ?? "");
}

export function signalProfile(row) {
  if (row.compositeProfile) {
    const sources = Array.isArray(row.compositeProfile.sources) ? row.compositeProfile.sources : [];
    const sourceMask = Number(row.compositeProfile.sourceMask ?? 0);
    return {
      label: row.compositeProfile.label ?? "观察",
      priority: Number(row.compositeProfile.priority ?? 99),
      color: signalProfileColor(sourceMask),
      classes: [
        sources.includes("资金费") ? "has-funding" : "",
        sources.includes("OI") ? "has-oi" : "",
        sources.includes("热度") ? "has-hot" : "",
        sources.includes("多周期") ? "has-multi" : ""
      ].filter(Boolean).join(" ")
    };
  }
  const funding = Boolean(row.fundingOneHour);
  const oi = Boolean(row.oiMatched ?? row.oiSpikeHit);
  const hot = Boolean(Number(row.hotRankHit ?? 0));
  const multi = Number(row.multiMatchCount ?? 0) >= 3;
  const alertLevel = row.bestAlertLevel === "LEVEL1" || row.bestAlertLevel === "LEVEL2"
    ? row.bestAlertLevel
    : row.alertLevel === "LEVEL1" || row.alertLevel === "LEVEL2"
      ? row.alertLevel
      : null;
  const sourceMask = (funding ? 8 : 0) + (oi ? 4 : 0) + (hot ? 2 : 0) + (multi ? 1 : 0);
  const sources = [
    funding ? "资金费" : null,
    oi ? "OI" : null,
    hot ? "热度" : null,
    multi ? "多周期" : null
  ].filter(Boolean);
  if (!alertLevel) {
    const standaloneMask = (funding ? 8 : 0) + (oi ? 4 : 0);
    if (standaloneMask === 4) {
      return {
        label: "OI · 独立信号",
        priority: 23,
        color: signalProfileColor(standaloneMask),
        classes: "has-oi"
      };
    }
    return { label: "观察", priority: 99, classes: "", color: signalProfileColor(0) };
  }
  const levelLabel = alertLevel === "LEVEL1" ? "一级警报" : "二级警报";
  return {
    label: sources.length ? `${sources.join(" + ")} · ${levelLabel}` : levelLabel,
    priority: sourceMask ? (15 - sourceMask) * 2 + (alertLevel === "LEVEL2" ? 1 : 0) : alertLevel === "LEVEL1" ? 30 : 31,
    color: signalProfileColor(sourceMask),
    classes: [
      funding ? "has-funding" : "",
      oi ? "has-oi" : "",
      hot ? "has-hot" : "",
      multi ? "has-multi" : ""
    ].filter(Boolean).join(" ")
  };
}

function signalProfileColor(sourceMask) {
  const color = SIGNAL_PROFILE_COLORS[Number(sourceMask) || "MA"] ?? SIGNAL_PROFILE_COLORS.MA;
  return `--profile-text:${color.text};--profile-border:${color.border};--profile-bg:${color.bg}`;
}

function changeClass(value) {
  if (value === null || value === undefined || value === "") return "";
  const number = Number(value);
  if (!Number.isFinite(number) || number === 0) return "";
  return number > 0 ? "up" : "down";
}

function clampPage(totalPages) {
  state.page = clamp(state.page, 1, Math.max(1, totalPages));
}

function applySignalPriceChangeSort() {
  if (!state.signalPriceChangeSort || !state.signalRealtimeRows.length) return;
  const sortedRows = sortSignalRowsByPriceChange(state.signalRealtimeRows, state.signalPriceChangeSort);
  const start = (state.page - 1) * state.pageSize;
  state.signals = sortedRows.slice(start, start + state.pageSize);
}

function updateSignalPriceChangeSortControl() {
  const direction = state.signalPriceChangeSort;
  const header = $("#signalPriceChangeSortHeader");
  const button = $("#signalPriceChangeSortBtn");
  const icon = button?.querySelector(".table-sort-icon");
  if (header) header.setAttribute("aria-sort", direction === "asc" ? "ascending" : direction === "desc" ? "descending" : "none");
  if (!button) return;
  button.classList.toggle("is-active", Boolean(direction));
  button.setAttribute(
    "aria-label",
    direction === "desc" ? "按 24 小时涨跌从低到高排序" : "按 24 小时涨跌从高到低排序"
  );
  button.title = direction === "desc" ? "当前从高到低，点击切换为从低到高" : direction === "asc"
    ? "当前从低到高，点击切换为从高到低"
    : "点击按 24 小时涨跌从高到低排序";
  if (icon) icon.textContent = direction === "desc" ? "↓" : direction === "asc" ? "↑" : "↕";
}

function renderPagination(totalRows, totalPages) {
  const start = totalRows === 0 ? 0 : (state.page - 1) * state.pageSize + 1;
  const end = Math.min(totalRows, state.page * state.pageSize);
  setText("#paginationSummary", `显示 ${start}-${end} / ${totalRows} 条`);
  setText("#pageIndicator", `${state.page} / ${Math.max(1, totalPages)}`);
  const prev = $("#prevPageBtn");
  const next = $("#nextPageBtn");
  if (prev) prev.disabled = state.page <= 1;
  if (next) next.disabled = state.page >= totalPages;
}

export function renderSignals() {
  const target = $("#signalRows");
  if (!target) return;
  updateSignalPriceChangeSortControl();
  const rows = state.signals;
  const totalPages = Math.ceil(state.totalSignals / state.pageSize);
  clampPage(totalPages);
  renderPagination(state.totalSignals, totalPages);

  if (!rows.length) {
    target.innerHTML = '<tr><td colspan="8" class="empty">当前筛选条件下暂无信号。可放宽等级、周期或分类筛选。</td></tr>';
    return;
  }

  target.innerHTML = rows
    .map((row) => {
      const key = rowKey(row);
      const expanded = state.expandedKey === key;
      const multiCount = Number(row.multiMatchCount ?? 0);
      const multiQualified = multiCount >= 3;
      const hotRankHit = Boolean(Number(row.hotRankHit ?? 0));
      const profile = signalProfile(row);
      const oiChangeText = row.oiMatched
        ? oiChangeSummary(row)
        : "";
      const details = Array.isArray(row.intervalDetails) ? row.intervalDetails : [];
      const triggered = details.filter((item) => ["LEVEL1", "LEVEL2"].includes(item.alertLevel));
      const availableIntervals = ALL_INTERVALS;
      const preferredInterval =
        state.signalChartIntervals.get(row.symbol) ??
        triggered[0]?.intervalCode ??
        row.intervalCode ??
        availableIntervals[0] ??
        "1h";
      const selectedInterval = availableIntervals.includes(preferredInterval) ? preferredInterval : "15m";
      state.signalChartIntervals.set(row.symbol, selectedInterval);
      const selectedDetail = details.find((item) => item.intervalCode === selectedInterval) ?? row;
      const bestLevel = row.bestAlertLevel ??
        (triggered.some((item) => item.alertLevel === "LEVEL1")
          ? "LEVEL1"
          : triggered.some((item) => item.alertLevel === "LEVEL2")
            ? "LEVEL2"
            : row.alertLevel);
      const sourceOnlySignal = !triggered.length && (Boolean(row.fundingOneHour) || Boolean(row.oiMatched ?? row.oiSpikeHit));
      const intervalBadges = triggered.length
        ? triggered.map((item) => `<span class="interval-badge interval-${escapeHtml(item.intervalCode)} ${item.alertLevel === "LEVEL1" ? "is-level1" : "is-level2"}">${escapeHtml(item.intervalCode)}</span>`).join("")
        : sourceOnlySignal
          ? '<span class="interval-badge">--</span>'
          : `<span class="interval-badge interval-${escapeHtml(row.intervalCode || "")}">${escapeHtml(row.intervalCode || "--")}</span>`;
      const signalRow = `
        <tr class="signal-row priority-${profile.priority} ${expanded ? "is-expanded" : ""} ${multiQualified ? "is-multi-hit" : ""} ${hotRankHit ? "is-hot-ma-hit" : ""}" data-key="${escapeHtml(key)}">
          <td>
            <div class="symbol-cell">
              <button class="symbol-button" type="button" data-key="${escapeHtml(key)}" title="查看K线">${escapeHtml(row.symbol)}</button>
              <button class="copy-symbol" type="button" data-symbol="${escapeHtml(row.symbol)}" title="复制交易对">复制</button>
              ${deps.watchButton(row.symbol, "从均线信号加入")}
              ${searchButtons(row.symbol)}
            </div>
          </td>
          <td>${escapeHtml(row.categoryLabel)}</td>
          <td class="mono ${changeClass(row.priceChange24hPct)}" data-signal-24h="${escapeHtml(row.symbol)}">${formatPercent(row.priceChange24hPct)}</td>
          <td><div class="interval-stack">${intervalBadges}</div></td>
          <td>
            <div class="signal-profile-stack">
              <span class="signal-profile priority-${profile.priority} ${profile.classes}" style="${profile.color}">${escapeHtml(profile.label)}</span>
              ${oiChangeText ? `<span class="signal-oi-change">OI暴涨 ${escapeHtml(oiChangeText)}</span>` : ""}
            </div>
          </td>
          <td>${levelBadge(bestLevel)}</td>
          <td class="mono" data-signal-price="${escapeHtml(row.symbol)}">${formatNumber(selectedDetail.currentPrice)}</td>
          <td class="mono"><span>MA100 ${formatNumber(selectedDetail.ma100)}</span><span>MA200 ${formatNumber(selectedDetail.ma200)}</span></td>
        </tr>
      `;
      if (!expanded) return signalRow;
      return `${signalRow}
        <tr class="chart-row">
          <td colspan="8">
            <div class="signal-chart-switch">
              <span>图表周期</span>
              ${availableIntervals.map((interval) => `<button type="button" class="${selectedInterval === interval ? "active" : ""}" data-signal-chart-interval="${escapeHtml(interval)}" data-signal-symbol="${escapeHtml(row.symbol)}">${escapeHtml(interval)}</button>`).join("")}
            </div>
            <div class="chart-shell" id="${chartElementId(`${row.symbol}|${selectedInterval}`)}">
              <div class="chart-loading">正在读取 ${escapeHtml(row.symbol)} ${escapeHtml(selectedInterval)} 全部 K 线缓存...</div>
            </div>
          </td>
        </tr>`;
    })
    .join("");

  bindRowClicks();
  document.querySelectorAll("[data-signal-chart-interval]").forEach((button) => {
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      state.signalChartIntervals.set(button.dataset.signalSymbol, button.dataset.signalChartInterval);
      renderSignals();
    });
  });
  if (state.expandedKey) {
    const expandedRow = rows.find((row) => rowKey(row) === state.expandedKey);
    if (expandedRow) {
      loadAndRenderChart({
        symbol: expandedRow.symbol,
        intervalCode: state.signalChartIntervals.get(expandedRow.symbol) ?? expandedRow.intervalCode ?? "1h"
      });
    }
  }
  deps.updateWatchRealtime();
}

function bindRowClicks() {
  bindCopyButtons();

  deps.bindWatchButtons();

  for (const link of document.querySelectorAll(".signal-row .mini-link")) {
    link.addEventListener("click", (event) => event.stopPropagation());
  }

  for (const row of document.querySelectorAll(".signal-row")) {
    row.addEventListener("click", () => toggleRow(row.dataset.key));
  }
}

function toggleRow(key) {
  state.expandedKey = state.expandedKey === key ? null : key;
  renderSignals();
}

export async function loadSignalsPage() {
  if (state.categories.size === 0 || state.levels.size === 0 || state.intervals.size === 0) {
    state.signals = [];
    state.signalRealtimeRows = [];
    state.signalRealtimeRequestId += 1;
    state.totalSignals = 0;
    return;
  }
  const params = new URLSearchParams({
    categories: Array.from(state.categories).join(","),
    levels: Array.from(state.levels).join(","),
    intervals: Array.from(state.intervals).join(","),
    page: String(state.page),
    pageSize: String(state.pageSize)
  });
  const response = await api(`/api/signals?${params.toString()}`);
  state.signals = response.signals;
  state.totalSignals = response.total;
  state.page = response.page;
  state.pageSize = response.pageSize ?? state.pageSize;
  const totalPages = Math.max(1, Math.ceil(state.totalSignals / state.pageSize));
  if (state.page > totalPages) {
    state.page = totalPages;
    await loadSignalsPage();
    return;
  }
  await loadSignalRealtimeRows();
}

export async function loadSignalRealtimeRows() {
  const requestId = state.signalRealtimeRequestId + 1;
  state.signalRealtimeRequestId = requestId;
  const pageSize = 100;
  const baseParams = {
    categories: Array.from(state.categories).join(","),
    levels: Array.from(state.levels).join(","),
    intervals: Array.from(state.intervals).join(","),
    pageSize: String(pageSize)
  };
  const rows = [];
  let page = 1;
  let total = state.totalSignals;
  while (rows.length < total || page === 1) {
    const params = new URLSearchParams({ ...baseParams, page: String(page) });
    const response = await api(`/api/signals?${params.toString()}`);
    rows.push(...(response.signals ?? []));
    total = Number(response.total ?? rows.length);
    if (!response.signals?.length || rows.length >= total) break;
    page += 1;
  }
  if (requestId !== state.signalRealtimeRequestId) return;
  state.signalRealtimeRows = rows;
  applySignalPriceChangeSort();
  deps.updateWatchRealtime();
}

async function setFilter(filter, value, checked) {
  const target = filter === "category" ? state.categories : filter === "level" ? state.levels : state.intervals;
  if (checked) target.add(value);
  else target.delete(value);
  state.page = 1;
  state.expandedKey = null;
  updateFilterControls();
  await loadSignalsPage();
  renderSignals();
}

function summarizeSet(set, labels, fallback) {
  if (set.size === 0) return "未选择";
  return Array.from(set)
    .map((value) => labels[value] ?? value)
    .join("、") || fallback;
}

export function updateFilterControls() {
  for (const input of document.querySelectorAll(".filter-menu input[data-filter]")) {
    const target =
      input.dataset.filter === "category"
        ? state.categories
        : input.dataset.filter === "level"
          ? state.levels
          : state.intervals;
    input.checked = target.has(input.dataset.value);
  }
  setText("#categoryFilterSummary", summarizeSet(state.categories, LABELS.category, "未选择"));
  setText("#levelFilterSummary", summarizeSet(state.levels, LABELS.level, "未选择"));
  setText("#intervalFilterSummary", summarizeSet(state.intervals, LABELS.interval, "未选择"));
}

export function updateSignalPriceDom(symbol, price, eventTime = Date.now()) {
  const safeSymbol = String(symbol ?? "").toUpperCase();
  const numericPrice = Number(price);
  if (!safeSymbol || !Number.isFinite(numericPrice)) return;
  for (const row of [...state.signals, ...state.signalRealtimeRows]) {
    if (String(row.symbol ?? "").toUpperCase() !== safeSymbol) continue;
    row.currentPrice = numericPrice;
    row.currentCloseTime = eventTime;
    if (Array.isArray(row.intervalDetails)) {
      for (const detail of row.intervalDetails) {
        detail.currentPrice = numericPrice;
        detail.currentCloseTime = eventTime;
      }
    }
  }
  const selectorSymbol = cssEscape(safeSymbol);
  for (const element of document.querySelectorAll(`[data-signal-price="${selectorSymbol}"]`)) {
    element.textContent = formatNumber(numericPrice);
    element.title = `实时价格：${formatTime(eventTime)}`;
  }
}

export function updateSignalPriceChangeDom(symbol, priceChange24hPct) {
  const safeSymbol = String(symbol ?? "").toUpperCase();
  const numericChange = priceChange24hPct === null || priceChange24hPct === undefined || priceChange24hPct === ""
    ? null
    : Number(priceChange24hPct);
  if (!safeSymbol || !Number.isFinite(numericChange)) return;
  for (const row of [...state.signals, ...state.signalRealtimeRows]) {
    if (String(row.symbol ?? "").toUpperCase() !== safeSymbol) continue;
    row.priceChange24hPct = numericChange;
    if (Array.isArray(row.intervalDetails)) {
      for (const detail of row.intervalDetails) detail.priceChange24hPct = numericChange;
    }
  }
  const selectorSymbol = cssEscape(safeSymbol);
  for (const element of document.querySelectorAll(`[data-signal-24h="${selectorSymbol}"]`)) {
    element.textContent = formatPercent(numericChange);
    element.classList.toggle("up", numericChange > 0);
    element.classList.toggle("down", numericChange < 0);
  }
}

export function bindSignalControls({ refreshAll } = {}) {
  $("#signalPriceChangeSortBtn")?.addEventListener("click", () => {
    state.signalPriceChangeSort = state.signalPriceChangeSort === "desc" ? "asc" : "desc";
    state.page = 1;
    state.expandedKey = null;
    applySignalPriceChangeSort();
    renderSignals();
  });

  for (const input of document.querySelectorAll(".filter-menu input[data-filter]")) {
    input.addEventListener("change", () => setFilter(input.dataset.filter, input.dataset.value, input.checked));
  }

  for (const button of document.querySelectorAll("[data-size]")) {
    button.addEventListener("click", () => {
      state.pageSize = Number(button.dataset.size);
      state.page = 1;
      document.querySelectorAll("[data-size]").forEach((item) => item.classList.toggle("active", item === button));
      refreshAll?.({ keepPage: true });
    });
  }

  $("#prevPageBtn")?.addEventListener("click", async () => {
    state.page -= 1;
    await loadSignalsPage();
    renderSignals();
  });

  $("#nextPageBtn")?.addEventListener("click", async () => {
    state.page += 1;
    await loadSignalsPage();
    renderSignals();
  });
}
