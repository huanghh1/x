import { api } from "../api.js";
import { DAY_MS, HOUR_MS, TRADE_MAX_LOOKBACK_DAYS } from "../constants.js";
import { syncCustomSelect } from "../components/customSelect.js";
import { state } from "../state.js";
import { $, escapeHtml, setText } from "../utils/dom.js";
import { datetimeLocalToIso, formatNumber, formatPercent, formatTime, formatUsd, pnlClass, toDatetimeLocal } from "../utils/format.js";

function ensureTradeAnalysisInputs() {
  if (state.tradeAnalysisInitialized) return;
  state.tradeAnalysisInitialized = true;
  const end = new Date();
  const start = new Date(end.getTime() - TRADE_MAX_LOOKBACK_DAYS * DAY_MS);
  const startInput = $("#tradeStartInput");
  const endInput = $("#tradeEndInput");
  if (startInput && !startInput.value) startInput.value = toDatetimeLocal(start);
  if (endInput && !endInput.value) endInput.value = toDatetimeLocal(end);
  updateTradeWindowButtons("max");
}

function tradeAnalysisQuery(extraParams = {}) {
  ensureTradeAnalysisInputs();
  const params = new URLSearchParams();
  const { start, end, symbol } = tradeFilterValues();
  if (start) params.set("start", start);
  if (end) params.set("end", end);
  if (symbol) params.set("symbol", symbol);
  params.set("page", String(state.tradeSymbolPage));
  params.set("pageSize", String(state.tradeSymbolPageSize));
  Object.entries(extraParams).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== "") params.set(key, String(value));
  });
  return params.toString();
}

function tradeFilterValues() {
  ensureTradeAnalysisInputs();
  return {
    start: datetimeLocalToIso($("#tradeStartInput")?.value),
    end: datetimeLocalToIso($("#tradeEndInput")?.value),
    symbol: String($("#tradeSymbolInput")?.value ?? "").trim().toUpperCase()
  };
}

function applyTradeAnalysisPayload(payload) {
  state.tradeAnalysis = payload;
  state.tradeSymbolTotal = Number(payload?.tradeRows?.total ?? payload?.symbolSummary?.total ?? tradeAnalysisRows().length);
  state.tradeSymbolPage = Number(payload?.tradeRows?.page ?? payload?.symbolSummary?.page ?? state.tradeSymbolPage);
  state.tradeSymbolPageSize = Number(payload?.tradeRows?.pageSize ?? payload?.symbolSummary?.pageSize ?? state.tradeSymbolPageSize);
  if (state.selectedTradeSymbolKey && !tradeSymbolRowByKey(state.selectedTradeSymbolKey)) {
    state.selectedTradeSymbolKey = "";
  }
  state.tradeCodexError = "";
  state.tradeCodexResult = null;
}

export async function loadTradeAnalysis({ refresh = true, advanceWindow = refresh } = {}) {
  ensureTradeAnalysisInputs();
  if (advanceWindow) advanceTradeWindowToNow();
  const requestId = state.tradeAnalysisRequestId + 1;
  state.tradeAnalysisRequestId = requestId;
  state.tradeAnalysisLoading = true;
  state.tradeAnalysisRefreshing = false;
  state.tradeAnalysisError = "";
  renderTradeAnalysis();
  let snapshotShown = false;
  try {
    const snapshotQuery = tradeAnalysisQuery({ mode: "snapshot" });
    const snapshot = await api(`/api/trade-analysis${snapshotQuery ? `?${snapshotQuery}` : ""}`);
    if (requestId !== state.tradeAnalysisRequestId) return;
    applyTradeAnalysisPayload(snapshot);
    snapshotShown = true;
    state.tradeAnalysisLoading = false;
    state.tradeAnalysisRefreshing = refresh;
    renderTradeAnalysis();
  } catch (error) {
    if (requestId !== state.tradeAnalysisRequestId) return;
    const message = error instanceof Error ? error.message : String(error);
    if (!refresh) {
      state.tradeAnalysisError = message;
      state.tradeAnalysisLoading = false;
      state.tradeAnalysisRefreshing = false;
      renderTradeAnalysis();
      return;
    }
    state.tradeAnalysisError = `本地记录读取失败：${message}`;
    renderTradeAnalysis();
  }

  if (!refresh) return;

  try {
    const query = tradeAnalysisQuery();
    const payload = await api(`/api/trade-analysis${query ? `?${query}` : ""}`);
    if (requestId !== state.tradeAnalysisRequestId) return;
    applyTradeAnalysisPayload(payload);
    state.tradeAnalysisError = "";
  } catch (error) {
    if (requestId !== state.tradeAnalysisRequestId) return;
    const message = error instanceof Error ? error.message : String(error);
    state.tradeAnalysisError = snapshotShown ? `最新同步失败：${message}` : message;
  } finally {
    if (requestId !== state.tradeAnalysisRequestId) return;
    state.tradeAnalysisLoading = false;
    state.tradeAnalysisRefreshing = false;
    renderTradeAnalysis();
  }
}

export function renderTradeAnalysis() {
  const payload = state.tradeAnalysis;
  renderTradeConnections(payload?.connections ?? []);
  renderTradeTotals(payload?.summary?.totals);
  renderTradeSources(payload?.summary?.bySource ?? [], payload?.sources ?? []);
  renderTradePositions(payload?.positions ?? [], payload?.positionSummary);
  renderTradeSymbolRows(tradeAnalysisRows());
  renderTradeCodexPanel();
  updateTradeSymbolPagination();
  updateTradeAnalysisStatus(payload);
}

export function tradeAnalysisRows() {
  return state.tradeAnalysis?.tradeRows?.items ?? state.tradeAnalysis?.summary?.bySymbol ?? [];
}

export function tradeSymbolRowKey(row = {}) {
  return JSON.stringify([row.source || "", row.symbol || "", row.firstTime ?? null, row.lastTime ?? null]);
}

function tradeSymbolRowByKey(key) {
  if (!key) return null;
  return tradeAnalysisRows().find((row) => tradeSymbolRowKey(row) === key) ?? null;
}

function selectedTradeSymbolRow() {
  return tradeSymbolRowByKey(state.selectedTradeSymbolKey);
}

function tradeCodexSymbolTarget() {
  const { symbol } = tradeFilterValues();
  return selectedTradeSymbolRow()?.symbol || symbol || "";
}

function tradeCodexScopeLabel(scope = state.tradeCodexScope) {
  if (scope === "all") return "全部交易记录";
  if (scope === "trade") return "交易组";
  if (scope === "range") return "时间段";
  if (scope === "symbol") return "选中币种";
  return "全部交易记录";
}

function tradeCodexCanRun() {
  if (state.tradeCodexLoading || state.tradeAnalysisLoading || state.tradeAnalysisRefreshing || !state.tradeAnalysis) return false;
  if (state.tradeCodexScope === "trade") return Boolean(selectedTradeSymbolRow());
  if (state.tradeCodexScope === "symbol") return Boolean(tradeCodexSymbolTarget());
  return true;
}

export function setTradeCodexScope(scope) {
  state.tradeCodexScope = ["all", "trade", "range", "symbol"].includes(scope) ? scope : "all";
  if (!["trade", "symbol"].includes(state.tradeCodexScope)) state.selectedTradeSymbolKey = "";
  state.tradeCodexError = "";
  state.tradeCodexResult = null;
}

function tradeSymbolOptionLabel(row) {
  return `${row.sourceLabel || row.source || "--"} · ${row.symbol || "--"} · ${formatTime(row.firstTime)} → ${formatTime(row.lastTime)} · 净收益 ${formatUsd(row.net)}`;
}

function renderTradeSymbolSelect() {
  const select = $("#tradeSymbolSelect");
  if (!select) return;
  const rows = sortTradeSymbolRowsByTime(tradeAnalysisRows());
  const selected = selectedTradeSymbolRow();
  const canSelectRow = ["trade", "symbol"].includes(state.tradeCodexScope);
  const label = $("#tradeSymbolSelectLabel");
  if (label) {
    label.textContent = state.tradeCodexScope === "symbol" ? "选择币种汇总" : "选择交易组";
  }
  select.disabled = !canSelectRow || state.tradeAnalysisLoading || state.tradeAnalysisRefreshing || !rows.length;
  const placeholder = canSelectRow
    ? rows.length
      ? state.tradeCodexScope === "symbol" ? "选择一个币种汇总" : "选择一个交易组"
      : "暂无可选交易记录"
    : state.tradeCodexScope === "all"
      ? "全部复盘不需要选择"
      : "当前复盘范围不需要选择";
  const placeholderDisabled = canSelectRow && rows.length ? " disabled" : "";
  select.innerHTML = [
    `<option value=""${placeholderDisabled}>${placeholder}</option>`,
    ...rows.map((row) => `<option value="${escapeHtml(tradeSymbolRowKey(row))}">${escapeHtml(tradeSymbolOptionLabel(row))}</option>`)
  ].join("");
  select.value = canSelectRow && selected ? tradeSymbolRowKey(selected) : "";
  syncCustomSelect(select);
}

function renderTradeCodexPanel() {
  document.querySelectorAll("[data-trade-codex-scope]").forEach((button) => {
    const active = button.dataset.tradeCodexScope === state.tradeCodexScope;
    button.classList.toggle("active", active);
    button.setAttribute("aria-pressed", active ? "true" : "false");
  });
  renderTradeSymbolSelect();

  const rangeControls = $("#tradeCodexRangeControls");
  if (rangeControls) {
    rangeControls.hidden = state.tradeCodexScope !== "range";
    rangeControls.querySelectorAll("button").forEach((button) => {
      button.disabled = state.tradeCodexScope !== "range" || state.tradeCodexLoading;
    });
  }

  const selected = selectedTradeSymbolRow();
  const selection = $("#tradeCodexSelection");
  if (selection) {
    const filters = tradeFilterValues();
    if (state.tradeCodexScope === "trade") {
      selection.textContent = selected
        ? `已选交易组 ${selected.sourceLabel || selected.source || "--"} · ${selected.symbol || "--"} · ${formatTime(selected.firstTime)} → ${formatTime(selected.lastTime)} · 净收益 ${formatUsd(selected.net)}`
        : tradeAnalysisRows().length
          ? "请选择下方交易记录表的一行，或在下拉框选择一个交易组。"
          : "当前时间窗口暂无可选交易记录。";
    } else if (state.tradeCodexScope === "range") {
      selection.textContent = `时间段 ${formatTime(filters.start)} → ${formatTime(filters.end)}${filters.symbol ? ` · ${filters.symbol}` : ""}`;
    } else if (state.tradeCodexScope === "symbol") {
      selection.textContent = selected
        ? `已选币种 ${selected.sourceLabel || selected.source || "--"} · ${selected.symbol || "--"} · 净收益 ${formatUsd(selected.net)}`
        : tradeAnalysisRows().length
          ? "当前未选中币种。可以在下拉框选择，或点击下方交易记录行。"
          : "当前筛选没有可选币种。";
    } else {
      selection.textContent = `将复盘近 ${TRADE_MAX_LOOKBACK_DAYS} 天最大窗口内的全部交易记录。`;
    }
  }

  const statusParts = [];
  if (state.tradeCodexLoading) statusParts.push("分析中");
  statusParts.push(tradeCodexScopeLabel());
  if (state.tradeCodexResult?.generatedAt) statusParts.push(formatTime(state.tradeCodexResult.generatedAt));
  if (state.tradeCodexError) statusParts.push(`失败：${state.tradeCodexError}`);
  setText("#tradeCodexStatus", statusParts.join(" · ") || "等待生成");

  const runButton = $("#runTradeCodexBtn");
  if (runButton) {
    runButton.disabled = !tradeCodexCanRun();
    runButton.textContent = state.tradeCodexLoading ? "Codex 分析中" : "生成 Codex 复盘";
  }

  const result = $("#tradeCodexResult");
  if (!result) return;
  if (state.tradeCodexLoading) {
    result.textContent = "Codex 正在分析交易数据，请稍等。";
    return;
  }
  if (state.tradeCodexError) {
    result.textContent = state.tradeCodexError;
    return;
  }
  result.textContent = state.tradeCodexResult?.analysis || "Codex 复盘结果会显示在这里。";
}

export async function runTradeCodexAnalysis() {
  if (!tradeCodexCanRun()) {
    if (state.tradeCodexScope === "trade") state.tradeCodexError = "请先在交易记录表中选择一个交易组。";
    else if (state.tradeCodexScope === "symbol") state.tradeCodexError = "请先在上方选择一个币种汇总，或输入币种。";
    renderTradeCodexPanel();
    return;
  }

  const filters = tradeFilterValues();
  const selected = selectedTradeSymbolRow();
  const scope = state.tradeCodexScope;
  state.tradeCodexLoading = true;
  state.tradeCodexError = "";
  state.tradeCodexResult = null;
  renderTradeCodexPanel();
  try {
    const payload = await api("/api/trade-analysis/codex", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        scope,
        start: scope === "all" ? "" : filters.start,
        end: scope === "all" ? "" : filters.end,
        symbol: scope === "trade" ? selected?.symbol || "" : scope === "symbol" ? tradeCodexSymbolTarget() : scope === "range" ? filters.symbol : "",
        source: scope === "trade" ? selected?.source || "" : "",
        tradeKey: scope === "trade" && selected ? tradeSymbolRowKey(selected) : ""
      })
    });
    state.tradeCodexResult = payload;
  } catch (error) {
    state.tradeCodexError = error instanceof Error ? error.message : String(error);
  } finally {
    state.tradeCodexLoading = false;
    renderTradeCodexPanel();
  }
}

function updateTradeAnalysisStatus(payload) {
  const parts = [];
  if (state.tradeAnalysisLoading) parts.push("读取中");
  else if (state.tradeAnalysisRefreshing) parts.push("同步最新");
  if (payload?.snapshot) parts.push("本地记录");
  if (payload?.generatedAt) parts.push(`更新时间 ${formatTime(payload.generatedAt)}`);
  if (payload?.positionSnapshot?.cached) parts.push(`仓位缓存 ${formatTime(payload.positionSnapshot.updatedAt)}`);
  if (payload?.window?.startTime && payload?.window?.endTime) {
    parts.push(`${formatTime(payload.window.startTime)} → ${formatTime(payload.window.endTime)}`);
  }
  const missingCount = (payload?.sources ?? []).filter((source) => !source.configured).length;
  const errorCount = (payload?.sources ?? []).filter((source) => source.configured && !source.ok).length;
  if (missingCount) parts.push(`待配置 ${missingCount} 个来源`);
  if (errorCount) parts.push(`异常 ${errorCount} 个来源`);
  if (payload?.positions) parts.push(`${payload.positions.length} 个持仓`);
  if (payload?.tradeRows) parts.push(`交易记录 ${payload.tradeRows.total ?? 0} 项`);
  if (payload?.persistence?.enabled) parts.push(payload?.snapshot ? "来自数据库" : "已入库");
  else if (payload?.persistence?.error) parts.push(`${payload?.snapshot ? "数据库读取失败" : "入库失败"}：${payload.persistence.error}`);
  if (state.tradeAnalysisError) parts.push(`失败：${state.tradeAnalysisError}`);
  setText("#tradeAnalysisStatus", parts.join(" · ") || "等待读取");
  const refreshButton = $("#refreshTradeAnalysisBtn");
  if (refreshButton) {
    refreshButton.disabled = state.tradeAnalysisLoading || state.tradeAnalysisRefreshing;
    refreshButton.textContent = state.tradeAnalysisLoading
      ? "读取中"
      : state.tradeAnalysisRefreshing ? "同步中" : "刷新交易分析";
  }
}

function renderTradeConnections(connections) {
  const target = $("#tradeConnectionCards");
  if (!target) return;
  if (!connections.length) {
    target.innerHTML = '<div class="heat-empty">等待配置检查。</div>';
    return;
  }
  target.innerHTML = connections.map((connection) => {
    const fieldHtml = connection.fields.map((field) => `
      <span class="trade-field-chip ${field.configured ? "is-ok" : "is-missing"}">
        ${escapeHtml(field.env)} · ${field.configured ? "已配置" : field.optional ? "可选" : "待填写"}
      </span>
    `).join("");
    return `
      <article class="trade-connection-card ${connection.configured ? "is-ok" : "is-missing"}">
        <div>
          <span>${escapeHtml(connection.configured ? "可读取" : "待配置")}</span>
          <strong>${escapeHtml(connection.label)}</strong>
        </div>
        <div class="trade-field-list">${fieldHtml}</div>
        <a class="mini-link" href="${escapeHtml(connection.docsUrl)}" target="_blank" rel="noreferrer">官方文档</a>
      </article>
    `;
  }).join("");
}

function renderTradeTotals(totals = {}) {
  const net = Number(totals.net);
  const realized = Number(totals.realizedPnl);
  const feeCost = Number(totals.feeCost);
  const funding = Number(totals.funding);
  setTradeMetric("#tradeNetPnl", net);
  setTradeMetric("#tradeRealizedPnl", realized);
  setTradeMetric("#tradeFeeCost", feeCost, { cost: true });
  setTradeMetric("#tradeFundingPnl", funding);
}

function setTradeMetric(selector, value, { cost = false } = {}) {
  const target = $(selector);
  if (!target) return;
  target.textContent = formatUsd(value);
  target.classList.remove("is-positive", "is-negative", "is-neutral", "is-cost");
  target.classList.add(cost ? "is-cost" : pnlClass(value));
}

function renderPositionFunding(position = {}) {
  const fee = Number(position.settledFunding);
  const hasFee = position.settledFunding !== null && position.settledFunding !== undefined && Number.isFinite(fee);
  return `
    <div class="trade-position-funding">
      <strong class="${hasFee ? pnlClass(fee) : "is-neutral"}">${hasFee ? formatUsd(fee) : "--"}</strong>
    </div>
  `;
}

function sourceStatusText(source) {
  if (!source) return "";
  if (!source.configured) return `缺少 ${source.missing?.join("、") || "配置"}`;
  if (!source.ok) return source.error || "读取失败";
  const bits = [];
  if (source.positionCount) bits.push(`${source.positionCount} 个持仓`);
  if (source.rangeNote) bits.push(source.rangeNote);
  if (source.tradeError) bits.push(`成交明细异常：${source.tradeError}`);
  if (source.billError) bits.push(`账单异常：${source.billError}`);
  if (source.fillError) bits.push(`成交异常：${source.fillError}`);
  if (source.orderError) bits.push(`历史订单异常：${source.orderError}`);
  if (source.positionError) bits.push(`持仓异常：${source.positionError}`);
  if (source.utaError) bits.push(`UTA异常：${source.utaError}`);
  return bits.join(" · ") || "读取正常";
}

function renderTradeSources(groups, sources) {
  const target = $("#tradeSourceCards");
  if (!target) return;
  if (!groups.length && !sources.length) {
    target.innerHTML = '<div class="heat-empty">暂无交易所汇总。</div>';
    return;
  }
  const sourceById = new Map(sources.map((source) => [source.id, source]));
  target.innerHTML = groups.map((group) => {
    const source = sourceById.get(group.source);
    return `
      <article class="trade-source-card ${source?.ok ? "is-ok" : source?.configured === false ? "is-missing" : "is-error"}">
        <span>${escapeHtml(group.sourceLabel || source?.label || group.source || "--")}</span>
        <strong class="${pnlClass(group.net)}">${formatUsd(group.net)}</strong>
        <p>${escapeHtml(sourceStatusText(source))}</p>
        <div>
          <b>手续费 ${formatUsd(group.feeCost)}</b>
          <b>资金费 ${formatUsd(group.funding)}</b>
        </div>
      </article>
    `;
  }).join("");
}

function renderTradePositions(positions, summary = {}) {
  const target = $("#tradePositionRows");
  if (!target) return;
  setText("#tradePositionCount", formatNumber(summary.count ?? positions.length, 0));
  const notionalTarget = $("#tradePositionNotional");
  if (notionalTarget) notionalTarget.textContent = formatUsd(summary.notional ?? 0);
  setTradeMetric("#tradePositionPnl", Number(summary.unrealizedPnl ?? 0));

  if ((state.tradeAnalysisLoading || state.tradeAnalysisRefreshing) && !positions.length) {
    target.innerHTML = '<tr><td colspan="10" class="empty">正在读取当前持仓。</td></tr>';
    return;
  }
  if (!positions.length) {
    target.innerHTML = '<tr><td colspan="10" class="empty">当前接口返回没有未平仓持仓。若你确定有仓位，请确认钱包地址和 Binance API 只读权限。</td></tr>';
    return;
  }
  target.innerHTML = positions.map((position) => `
    <tr>
      <td>${escapeHtml(position.sourceLabel || position.source || "--")}</td>
      <td><span class="mono">${escapeHtml(position.symbol || "--")}</span></td>
      <td><span class="trade-side ${String(position.side).toLowerCase().includes("short") ? "is-short" : "is-long"}">${escapeHtml(position.side || "--")}</span></td>
      <td>${formatNumber(position.quantity, 6)}</td>
      <td>${formatNumber(position.entryPrice, 6)}</td>
      <td>${formatNumber(position.markPrice, 6)}</td>
      <td>${formatUsd(position.notional)}</td>
      <td><strong class="${pnlClass(position.unrealizedPnl)}">${formatUsd(position.unrealizedPnl)}</strong></td>
      <td>${renderPositionFunding(position)}</td>
      <td>${formatTime(position.updatedAt)}</td>
    </tr>
  `).join("");
}

function tradeSymbolRowTime(row, key) {
  const value = Number(row?.[key]);
  if (Number.isFinite(value)) return value;
  const parsed = Date.parse(String(row?.[key] ?? ""));
  return Number.isFinite(parsed) ? parsed : 0;
}

export function sortTradeSymbolRowsByTime(rows = []) {
  return [...rows].sort((a, b) =>
    tradeSymbolRowTime(b, "lastTime") - tradeSymbolRowTime(a, "lastTime") ||
    tradeSymbolRowTime(b, "firstTime") - tradeSymbolRowTime(a, "firstTime") ||
    String(a.source ?? "").localeCompare(String(b.source ?? "")) ||
    String(a.symbol ?? "").localeCompare(String(b.symbol ?? ""))
  );
}

function renderTradeSymbolRows(rows) {
  const target = $("#tradeSymbolRows");
  if (!target) return;
  if ((state.tradeAnalysisLoading || state.tradeAnalysisRefreshing) && !rows.length) {
    target.innerHTML = '<tr><td colspan="8" class="empty">正在读取交易分析。</td></tr>';
    return;
  }
  if (!rows.length) {
    target.innerHTML = '<tr><td colspan="8" class="empty">当前时间窗口暂无可汇总的交易数据。先填写上方 API / 钱包地址，再点击刷新。</td></tr>';
    return;
  }
  target.innerHTML = sortTradeSymbolRowsByTime(rows).map((row) => {
    const key = tradeSymbolRowKey(row);
    const rowSelectable = ["trade", "symbol"].includes(state.tradeCodexScope);
    const selected = rowSelectable && state.selectedTradeSymbolKey === key;
    return `
    <tr class="${[rowSelectable ? "is-trade-selectable" : "", selected ? "is-selected-trade-symbol" : ""].filter(Boolean).join(" ")}" data-trade-symbol-key="${escapeHtml(key)}">
      <td>${escapeHtml(row.sourceLabel || row.source || "--")}</td>
      <td><span class="mono">${escapeHtml(row.symbol || "--")}</span></td>
      <td>${formatTime(row.firstTime)}</td>
      <td>${formatTime(row.lastTime)}</td>
      <td><strong class="${pnlClass(row.net)}">${formatUsd(row.net)}</strong></td>
      <td><span class="${pnlClass(row.realizedPnl)}">${formatUsd(row.realizedPnl)}</span></td>
      <td>${formatUsd(row.feeCost)}</td>
      <td><span class="${pnlClass(row.funding)}">${formatUsd(row.funding)}</span></td>
    </tr>
  `;
  }).join("");
  bindTradeSymbolSelection(target);
}

function updateTradeSymbolPagination() {
  const total = Number(state.tradeAnalysis?.tradeRows?.total ?? state.tradeAnalysis?.symbolSummary?.total ?? state.tradeSymbolTotal ?? 0);
  const pageSize = Number(state.tradeAnalysis?.tradeRows?.pageSize ?? state.tradeAnalysis?.symbolSummary?.pageSize ?? state.tradeSymbolPageSize);
  const page = Number(state.tradeAnalysis?.tradeRows?.page ?? state.tradeAnalysis?.symbolSummary?.page ?? state.tradeSymbolPage);
  const totalPages = Math.ceil(total / pageSize) || 1;
  const summary = total ? `第 ${page} / ${totalPages} 页，共 ${total} 项` : "--";
  setText("#tradeSymbolPaginationSummary", summary);
  setText("#tradeSymbolPageIndicator", `${page} / ${totalPages}`);

  const prevBtn = $("#prevTradeSymbolPageBtn");
  const nextBtn = $("#nextTradeSymbolPageBtn");
  if (prevBtn) prevBtn.disabled = state.tradeAnalysisLoading || state.tradeAnalysisRefreshing || page <= 1;
  if (nextBtn) nextBtn.disabled = state.tradeAnalysisLoading || state.tradeAnalysisRefreshing || page >= totalPages;

  document.querySelectorAll("[data-trade-symbol-pagesize]").forEach((btn) => {
    btn.classList.toggle("active", Number(btn.dataset.tradeSymbolPagesize) === pageSize);
  });
}

function bindTradeSymbolSelection(root) {
  root.querySelectorAll("[data-trade-symbol-key]").forEach((row) => {
    row.addEventListener("click", () => {
      if (!["trade", "symbol"].includes(state.tradeCodexScope)) return;
      state.selectedTradeSymbolKey = state.selectedTradeSymbolKey === row.dataset.tradeSymbolKey ? "" : row.dataset.tradeSymbolKey || "";
      state.tradeCodexError = "";
      state.tradeCodexResult = null;
      renderTradeAnalysis();
    });
  });
}


function normalizeTradeWindow(value) {
  if (value === "max") {
    return { key: "max", lookbackMs: TRADE_MAX_LOOKBACK_DAYS * DAY_MS };
  }
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return { key: `${value}d`, lookbackMs: value * DAY_MS };
  }
  const text = String(value ?? "").trim().toLowerCase();
  const hourMatch = text.match(/^(\d+(?:\.\d+)?)h$/);
  if (hourMatch) {
    const hours = Number(hourMatch[1]);
    if (Number.isFinite(hours) && hours > 0) return { key: `${hours}h`, lookbackMs: hours * HOUR_MS };
  }
  const dayMatch = text.match(/^(\d+(?:\.\d+)?)d$/);
  if (dayMatch) {
    const days = Number(dayMatch[1]);
    if (Number.isFinite(days) && days > 0) return { key: `${days}d`, lookbackMs: days * DAY_MS };
  }
  return null;
}

function updateTradeWindowButtons(activeKey) {
  document.querySelectorAll("[data-trade-window], [data-trade-codex-window]").forEach((button) => {
    const key = button.dataset.tradeWindow || button.dataset.tradeCodexWindow || "";
    button.classList.toggle("active", key === activeKey);
  });
}

function applyTradeWindowInputs(windowOption) {
  const end = new Date();
  const start = new Date(end.getTime() - windowOption.lookbackMs);
  const startInput = $("#tradeStartInput");
  const endInput = $("#tradeEndInput");
  if (startInput) startInput.value = toDatetimeLocal(start);
  if (endInput) endInput.value = toDatetimeLocal(end);
}

function advanceTradeWindowToNow() {
  const windowOption = normalizeTradeWindow(state.tradeWindowKey);
  if (!windowOption) return;
  applyTradeWindowInputs(windowOption);
  updateTradeWindowButtons(windowOption.key);
}

export function setTradeWindow(value) {
  const windowOption = normalizeTradeWindow(value);
  if (!windowOption) return;
  state.tradeWindowKey = windowOption.key;
  applyTradeWindowInputs(windowOption);
  updateTradeWindowButtons(windowOption.key);
  state.tradeSymbolPage = 1;
  loadTradeAnalysis();
}
