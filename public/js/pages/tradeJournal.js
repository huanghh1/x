import { api } from "../api.js";
import { syncAllCustomSelects, syncCustomSelect } from "../components/customSelect.js";
import { state } from "../state.js";
import { $, escapeHtml, setText } from "../utils/dom.js";
import { datetimeLocalToIso, formatNumber, formatTime, formatUsd, toDatetimeLocal } from "../utils/format.js";

const tradeJournalDeps = {
  loadTradeAnalysis: async () => {},
  tradeAnalysisRows: () => [],
  sortTradeSymbolRowsByTime: (rows) => rows,
  tradeSymbolRowKey: () => ""
};

export function configureTradeJournal(deps = {}) {
  Object.assign(tradeJournalDeps, deps);
}

function tradeJournalComparableSymbol(value) {
  const compact = String(value ?? "").trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
  return compact.endsWith("USDT") && compact.length > 4 ? compact.slice(0, -4) : compact;
}

function tradeJournalSymbolsMatch(left, right) {
  const a = tradeJournalComparableSymbol(left);
  const b = tradeJournalComparableSymbol(right);
  return Boolean(a && b && a === b);
}

function tradeJournalSourceSide(value) {
  const text = String(value ?? "").toLowerCase();
  if (text.includes("short") || text.includes("sell")) return "SHORT";
  if (text.includes("long") || text.includes("buy")) return "LONG";
  if (text.includes("spot")) return "SPOT";
  return "";
}

function tradeJournalSourceKey(kind, item = {}) {
  return JSON.stringify([
    kind,
    item.id || item.key || "",
    item.source || "",
    item.symbol || "",
    item.openedAt ?? item.firstTime ?? null,
    item.closedAt ?? item.lastTime ?? null
  ]);
}

function tradeJournalEventsForSourceSymbol(source, symbol) {
  return (state.tradeAnalysis?.events ?? [])
    .filter((event) =>
      String(event.source ?? "") === String(source ?? "") &&
      tradeJournalSymbolsMatch(event.symbol, symbol) &&
      Number.isFinite(Number(event.time))
    )
    .sort((a, b) => Number(a.time) - Number(b.time));
}

function tradeJournalEventMatchesSide(event, journalSide) {
  if (!journalSide) return true;
  const text = [
    event.direction,
    event.positionSide,
    event.side,
    event.type,
    event.rawType
  ].join(" ").toLowerCase();
  if (journalSide === "LONG") return text.includes("long") || text.includes("buy");
  if (journalSide === "SHORT") return text.includes("short") || text.includes("sell");
  return true;
}

function inferTradeJournalPositionOpenedAt(position) {
  const side = tradeJournalSourceSide(position.side);
  const events = tradeJournalEventsForSourceSymbol(position.source, position.symbol)
    .filter((event) => String(event.rawType ?? "") !== "CURRENT_POSITION")
    .filter((event) => /trade|fill|user_trade/i.test(`${event.type ?? ""} ${event.rawType ?? ""} ${event.direction ?? ""}`))
    .filter((event) => tradeJournalEventMatchesSide(event, side));
  const openEvents = events.filter((event) => /open|buy|sell|long|short/i.test(`${event.direction ?? ""} ${event.positionSide ?? ""} ${event.side ?? ""}`));
  const firstOpen = openEvents[0] ?? events[0];
  return firstOpen?.time ?? position.updatedAt ?? null;
}

function inferTradeJournalRowSide(row) {
  const events = tradeJournalEventsForSourceSymbol(row.source, row.symbol);
  const directional = events.find((event) => tradeJournalSourceSide(`${event.direction ?? ""} ${event.positionSide ?? ""} ${event.side ?? ""}`));
  return tradeJournalSourceSide(`${directional?.direction ?? ""} ${directional?.positionSide ?? ""} ${directional?.side ?? ""}`);
}

function tradeJournalOpenPositionForRow(row) {
  return (state.tradeAnalysis?.positions ?? []).find((position) =>
    String(position.source ?? "") === String(row.source ?? "") &&
    tradeJournalSymbolsMatch(position.symbol, row.symbol)
  ) ?? null;
}

function tradeJournalSourceOptions() {
  const positions = Array.isArray(state.tradeAnalysis?.positions) ? state.tradeAnalysis.positions : [];
  const positionOptions = positions.map((position) => {
    const side = tradeJournalSourceSide(position.side);
    const openedAt = inferTradeJournalPositionOpenedAt(position);
    const label = `${position.sourceLabel || position.source || "--"} · ${position.symbol || "--"} · 当前持仓 · ${tradeJournalSideLabel(side)}`;
    return {
      kind: "position",
      key: tradeJournalSourceKey("position", { ...position, openedAt }),
      label,
      symbol: position.symbol || "",
      side,
      status: "OPEN",
      openedAt,
      closedAt: null,
      detail: `数量 ${formatNumber(position.quantity, 6)} · 开仓均价 ${formatNumber(position.entryPrice, 6)} · 未实现 ${formatUsd(position.unrealizedPnl)}`
    };
  });

  const rows = tradeJournalDeps.sortTradeSymbolRowsByTime(tradeJournalDeps.tradeAnalysisRows());
  const rowOptions = rows.map((row) => {
    const openPosition = tradeJournalOpenPositionForRow(row);
    const side = openPosition ? tradeJournalSourceSide(openPosition.side) : inferTradeJournalRowSide(row);
    const openedAt = row.firstTime ?? null;
    const closedAt = openPosition ? null : row.lastTime ?? null;
    const label = `${row.sourceLabel || row.source || "--"} · ${row.symbol || "--"} · ${formatTime(row.firstTime)} → ${openPosition ? "开单中" : formatTime(row.lastTime)} · 净收益 ${formatUsd(row.net)}`;
    return {
      kind: "trade",
      key: tradeJournalSourceKey("trade", { ...row, key: tradeJournalDeps.tradeSymbolRowKey(row), openedAt, closedAt }),
      label,
      symbol: row.symbol || "",
      side,
      status: openPosition ? "OPEN" : "ENDED",
      openedAt,
      closedAt,
      detail: `交易组 · 已实现 ${formatUsd(row.realizedPnl)} · 手续费 ${formatUsd(row.feeCost)} · 资金费 ${formatUsd(row.funding)}`
    };
  });

  return {
    positions: positionOptions,
    trades: rowOptions,
    all: [...positionOptions, ...rowOptions]
  };
}

function selectedTradeJournalSourceOption() {
  if (!state.selectedTradeJournalSourceKey) return null;
  return tradeJournalSourceOptions().all.find((option) => option.key === state.selectedTradeJournalSourceKey) ?? null;
}

export function renderTradeJournalSourcePicker() {
  const select = $("#tradeJournalSourceSelect");
  if (!select) return;
  const options = tradeJournalSourceOptions();
  if (state.selectedTradeJournalSourceKey && !options.all.some((option) => option.key === state.selectedTradeJournalSourceKey)) {
    state.selectedTradeJournalSourceKey = "";
  }
  const placeholder = state.tradeJournalSourceLoading
    ? "正在同步交易来源"
    : options.all.length ? "选择一笔交易来源" : "暂无可选交易来源";
  const positionHtml = options.positions.length
    ? `<optgroup label="当前持仓">${options.positions.map((option) => `<option value="${escapeHtml(option.key)}">${escapeHtml(option.label)}</option>`).join("")}</optgroup>`
    : "";
  const tradeHtml = options.trades.length
    ? `<optgroup label="交易组">${options.trades.map((option) => `<option value="${escapeHtml(option.key)}">${escapeHtml(option.label)}</option>`).join("")}</optgroup>`
    : "";
  const placeholderDisabled = options.all.length ? " disabled" : "";
  select.innerHTML = `<option value=""${placeholderDisabled}>${escapeHtml(placeholder)}</option>${positionHtml}${tradeHtml}`;
  select.value = state.selectedTradeJournalSourceKey;
  select.disabled = state.tradeJournalSourceLoading || !options.all.length;
  syncCustomSelect(select);

  const refreshButton = $("#refreshTradeJournalSourcesBtn");
  if (refreshButton) {
    refreshButton.disabled = state.tradeJournalSourceLoading || state.tradeAnalysisLoading || state.tradeAnalysisRefreshing;
    refreshButton.textContent = state.tradeJournalSourceLoading || state.tradeAnalysisLoading || state.tradeAnalysisRefreshing
      ? "同步中"
      : "同步来源";
  }

  const hint = $("#tradeJournalSourceHint");
  if (!hint) return;
  const selected = selectedTradeJournalSourceOption();
  if (state.tradeJournalSourceError) {
    hint.textContent = `交易来源同步失败：${state.tradeJournalSourceError}`;
  } else if (selected) {
    hint.textContent = `已选择 ${selected.label}；${selected.detail}`;
  } else if (state.tradeAnalysis?.generatedAt) {
    hint.textContent = `来源来自交易分析 ${formatTime(state.tradeAnalysis.generatedAt)}；可选择当前持仓或交易组自动回填。`;
  } else {
    hint.textContent = "可选择当前持仓或交易分析里的交易组，自动回填交易对、方向、开仓与结束时间。";
  }
}

export function applyTradeJournalSourceOption(key) {
  state.selectedTradeJournalSourceKey = key || "";
  const option = selectedTradeJournalSourceOption();
  renderTradeJournalSourcePicker();
  if (!option) return;

  const symbolInput = $("#tradeJournalSymbolInput");
  if (symbolInput) symbolInput.value = String(option.symbol ?? "").toUpperCase().replace(/[^A-Z0-9_]/g, "");
  const sideInput = $("#tradeJournalSideInput");
  if (sideInput) sideInput.value = option.side || "";
  const statusInput = $("#tradeJournalStatusInput");
  if (statusInput) statusInput.value = option.status || "OPEN";
  const openedInput = $("#tradeJournalOpenedAtInput");
  if (openedInput) openedInput.value = option.openedAt ? toDatetimeLocal(option.openedAt) : "";
  const closedInput = $("#tradeJournalClosedAtInput");
  if (closedInput) closedInput.value = option.closedAt ? toDatetimeLocal(option.closedAt) : "";
  syncAllCustomSelects();
}

export async function loadTradeJournalSources({ refresh = false } = {}) {
  if (state.tradeJournalSourceLoading) return;
  state.tradeJournalSourceLoading = true;
  state.tradeJournalSourceError = "";
  renderTradeJournalSourcePicker();
  updateTradeJournalStatus();
  try {
    await tradeJournalDeps.loadTradeAnalysis({ refresh, advanceWindow: refresh });
    state.tradeJournalSourceError = state.tradeAnalysisError || "";
  } catch (error) {
    state.tradeJournalSourceError = error instanceof Error ? error.message : String(error);
  } finally {
    state.tradeJournalSourceLoading = false;
    renderTradeJournalSourcePicker();
    updateTradeJournalStatus();
  }
}

function tradeJournalStatusLabel(status) {
  if (status === "OPEN") return "开单中";
  if (status === "ENDED") return "已结束";
  if (status === "REVIEWED") return "已复盘";
  return "未归类";
}

function tradeJournalSideLabel(side) {
  if (side === "LONG") return "做多";
  if (side === "SHORT") return "做空";
  if (side === "SPOT") return "现货";
  if (side === "OTHER") return "其他";
  return "未填写";
}

function tradeJournalById(id) {
  const numericId = Number(id);
  return state.tradeJournal.find((item) => Number(item.id) === numericId) ?? null;
}

function tradeJournalFilters() {
  return {
    keyword: String($("#tradeJournalSearchInput")?.value ?? "").trim(),
    status: String($("#tradeJournalStatusFilter")?.value ?? "").trim()
  };
}

function tradeJournalQuery() {
  const params = new URLSearchParams();
  const filters = tradeJournalFilters();
  if (filters.keyword) params.set("keyword", filters.keyword);
  if (filters.status) params.set("status", filters.status);
  params.set("page", String(state.tradeJournalPage));
  params.set("pageSize", String(state.tradeJournalPageSize));
  return params.toString();
}

export async function loadTradeJournal() {
  state.tradeJournalLoading = true;
  state.tradeJournalError = "";
  renderTradeJournal();
  try {
    const query = tradeJournalQuery();
    const payload = await api(`/api/trade-journal${query ? `?${query}` : ""}`);
    state.tradeJournal = payload.items ?? [];
    state.tradeJournalTotal = Number(payload.total ?? 0);
    state.tradeJournalPage = Number(payload.page ?? state.tradeJournalPage);
    state.tradeJournalPageSize = Number(payload.pageSize ?? state.tradeJournalPageSize);
  } catch (error) {
    state.tradeJournalError = error instanceof Error ? error.message : String(error);
  } finally {
    state.tradeJournalLoading = false;
    renderTradeJournal();
  }
}

function tradeJournalTextHtml(value, fallback = "未填写") {
  const text = String(value ?? "").trim();
  if (!text) return `<p class="trade-journal-empty-text">${fallback}</p>`;
  return `<p>${escapeHtml(text).replaceAll("\n", "<br>")}</p>`;
}

function tradeJournalIntradayNotes(item) {
  return Array.isArray(item?.intradayNotes) ? item.intradayNotes : [];
}

function tradeJournalExcerpt(value, maxLength = 84) {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  if (!text) return "未填写";
  return text.length > maxLength ? `${text.slice(0, maxLength)}...` : text;
}

function tradeJournalIntradayExcerpt(item) {
  const notes = tradeJournalIntradayNotes(item);
  if (!notes.length) return "未填写";
  const latest = notes[notes.length - 1];
  return `${notes.length} 条 · ${formatTime(latest.notedAt)} · ${tradeJournalExcerpt(latest.noteText, 52)}`;
}

function tradeJournalIntradayNotesHtml(notes, fallback = "暂无盘中确定") {
  if (!notes.length) return `<p class="trade-journal-empty-text">${fallback}</p>`;
  return `
    <ol class="trade-journal-intraday-list">
      ${notes.map((note) => `
        <li>
          <time>${escapeHtml(formatTime(note.notedAt))}</time>
          ${tradeJournalTextHtml(note.noteText)}
        </li>
      `).join("")}
    </ol>
  `;
}

export function renderTradeJournal() {
  renderTradeJournalSourcePicker();
  updateTradeJournalStatus();
  const target = $("#tradeJournalRows");
  if (!target) return;
  if (state.tradeJournalLoading && !state.tradeJournal.length) {
    target.innerHTML = '<div class="heat-empty">正在读取交易日记。</div>';
    updateTradeJournalPagination();
    return;
  }
  if (state.tradeJournalError && !state.tradeJournal.length) {
    target.innerHTML = `<div class="heat-empty">读取失败：${escapeHtml(state.tradeJournalError)}</div>`;
    updateTradeJournalPagination();
    return;
  }
  if (!state.tradeJournal.length) {
    target.innerHTML = '<div class="heat-empty">暂无交易日记。左侧写下第一条开仓理由吧。</div>';
    updateTradeJournalPagination();
    return;
  }
  target.innerHTML = state.tradeJournal.map((item) => `
    <article class="trade-journal-card" data-trade-journal-id="${Number(item.id)}">
      <div class="trade-journal-card-head">
        <div>
          <h3>${escapeHtml(item.title || "交易日记")}</h3>
          <div class="trade-journal-meta">
            <span>${escapeHtml(item.symbol || "未填交易对")}</span>
            <span>${escapeHtml(tradeJournalSideLabel(item.side))}</span>
            <span>开仓 ${escapeHtml(formatTime(item.openedAt))}</span>
            ${item.closedAt ? `<span>结束 ${escapeHtml(formatTime(item.closedAt))}</span>` : ""}
          </div>
        </div>
        <span class="trade-journal-badge is-${escapeHtml(String(item.status || "OPEN").toLowerCase())}">${escapeHtml(tradeJournalStatusLabel(item.status))}</span>
      </div>
      <div class="trade-journal-card-body">
        <section>
          <strong>开仓理由</strong>
          <p>${escapeHtml(tradeJournalExcerpt(item.openReason))}</p>
        </section>
        <section>
          <strong>盘中确定</strong>
          <p>${escapeHtml(tradeJournalIntradayExcerpt(item))}</p>
        </section>
        <section>
          <strong>结束理由</strong>
          <p>${escapeHtml(tradeJournalExcerpt(item.closeReason))}</p>
        </section>
        <section>
          <strong>复盘总结</strong>
          <p>${escapeHtml(tradeJournalExcerpt(item.reviewSummary))}</p>
        </section>
      </div>
      <details class="trade-journal-detail">
        <summary>展开全文</summary>
        <div>
          <section>
            <strong>开仓理由</strong>
            ${tradeJournalTextHtml(item.openReason)}
          </section>
          <section>
            <strong>盘中确定</strong>
            ${tradeJournalIntradayNotesHtml(tradeJournalIntradayNotes(item))}
          </section>
          <section>
            <strong>结束理由</strong>
            ${tradeJournalTextHtml(item.closeReason)}
          </section>
          <section>
            <strong>后续追加复盘总结</strong>
            ${tradeJournalTextHtml(item.reviewSummary)}
          </section>
        </div>
      </details>
      <div class="trade-journal-card-actions">
        <button class="mini-link" type="button" data-trade-journal-action="edit" data-id="${Number(item.id)}">编辑</button>
        <button class="mini-link" type="button" data-trade-journal-action="intraday" data-id="${Number(item.id)}">添加盘中确定</button>
        <button class="mini-link" type="button" data-trade-journal-action="append" data-id="${Number(item.id)}">追加复盘</button>
        <button class="mini-link danger" type="button" data-trade-journal-action="delete" data-id="${Number(item.id)}">删除</button>
      </div>
    </article>
  `).join("");
  bindTradeJournalActions(target);
  updateTradeJournalPagination();
}

function updateTradeJournalStatus() {
  const parts = [];
  if (state.tradeJournalLoading) parts.push("读取中");
  if (state.tradeJournalSaving) parts.push("保存中");
  if (state.tradeJournalIntradaySaving) parts.push("追加中");
  if (state.tradeJournalSourceLoading) parts.push("同步交易来源");
  if (state.tradeJournalTotal) parts.push(`共 ${state.tradeJournalTotal} 条`);
  if (state.tradeJournalSourceError) parts.push(`来源失败：${state.tradeJournalSourceError}`);
  if (state.tradeJournalError) parts.push(`失败：${state.tradeJournalError}`);
  setText("#tradeJournalStatus", parts.join(" · ") || "等待读取");
  const saveButton = $("#saveTradeJournalBtn");
  if (saveButton) saveButton.disabled = state.tradeJournalSaving;
  const refreshButton = $("#refreshTradeJournalBtn");
  if (refreshButton) refreshButton.disabled = state.tradeJournalLoading;
  const addIntradayButton = $("#addTradeJournalIntradayBtn");
  if (addIntradayButton) {
    addIntradayButton.disabled = state.tradeJournalIntradaySaving || !$("#tradeJournalIdInput")?.value;
  }
}

function updateTradeJournalPagination() {
  const total = Number(state.tradeJournalTotal ?? 0);
  const pageSize = Number(state.tradeJournalPageSize ?? 2);
  const page = Number(state.tradeJournalPage ?? 1);
  const totalPages = Math.ceil(total / pageSize) || 1;
  setText("#tradeJournalPaginationSummary", total ? `第 ${page} / ${totalPages} 页，共 ${total} 条` : "--");
  setText("#tradeJournalPageIndicator", `${page} / ${totalPages}`);
  const prevBtn = $("#prevTradeJournalPageBtn");
  const nextBtn = $("#nextTradeJournalPageBtn");
  if (prevBtn) prevBtn.disabled = state.tradeJournalLoading || page <= 1;
  if (nextBtn) nextBtn.disabled = state.tradeJournalLoading || page >= totalPages;
  document.querySelectorAll("[data-trade-journal-pagesize]").forEach((btn) => {
    btn.classList.toggle("active", Number(btn.dataset.tradeJournalPagesize) === pageSize);
  });
}

function tradeJournalFormPayload() {
  return {
    title: $("#tradeJournalTitleInput")?.value ?? "",
    symbol: String($("#tradeJournalSymbolInput")?.value ?? "").toUpperCase().replace(/[^A-Z0-9_]/g, ""),
    side: $("#tradeJournalSideInput")?.value ?? "",
    status: $("#tradeJournalStatusInput")?.value ?? "OPEN",
    openedAt: datetimeLocalToIso($("#tradeJournalOpenedAtInput")?.value),
    closedAt: datetimeLocalToIso($("#tradeJournalClosedAtInput")?.value),
    openReason: $("#tradeJournalOpenReasonInput")?.value ?? "",
    closeReason: $("#tradeJournalCloseReasonInput")?.value ?? "",
    reviewSummary: $("#tradeJournalReviewInput")?.value ?? ""
  };
}

function renderTradeJournalIntradayEditor(entry = {}) {
  const panel = $("#tradeJournalIntradayPanel");
  if (!panel) return;
  const hasEntry = Boolean(entry?.id);
  panel.hidden = !hasEntry;
  const target = $("#tradeJournalIntradayNotes");
  if (target) {
    target.innerHTML = hasEntry ? tradeJournalIntradayNotesHtml(tradeJournalIntradayNotes(entry)) : "";
  }
  const addButton = $("#addTradeJournalIntradayBtn");
  if (addButton) addButton.disabled = state.tradeJournalIntradaySaving || !hasEntry;
}

function setTradeJournalForm(item = null, { focusReview = false, focusIntraday = false } = {}) {
  const entry = item ?? {};
  state.selectedTradeJournalSourceKey = "";
  const idInput = $("#tradeJournalIdInput");
  if (idInput) idInput.value = entry.id ? String(entry.id) : "";
  const titleInput = $("#tradeJournalTitleInput");
  if (titleInput) titleInput.value = entry.title ?? "";
  const symbolInput = $("#tradeJournalSymbolInput");
  if (symbolInput) symbolInput.value = entry.symbol ?? "";
  const sideInput = $("#tradeJournalSideInput");
  if (sideInput) sideInput.value = entry.side ?? "";
  const statusInput = $("#tradeJournalStatusInput");
  if (statusInput) statusInput.value = entry.status ?? "OPEN";
  const openedInput = $("#tradeJournalOpenedAtInput");
  if (openedInput) openedInput.value = entry.openedAt ? toDatetimeLocal(entry.openedAt) : toDatetimeLocal(new Date());
  const closedInput = $("#tradeJournalClosedAtInput");
  if (closedInput) closedInput.value = entry.closedAt ? toDatetimeLocal(entry.closedAt) : "";
  const openReasonInput = $("#tradeJournalOpenReasonInput");
  if (openReasonInput) openReasonInput.value = entry.openReason ?? "";
  const closeReasonInput = $("#tradeJournalCloseReasonInput");
  if (closeReasonInput) closeReasonInput.value = entry.closeReason ?? "";
  const reviewInput = $("#tradeJournalReviewInput");
  if (reviewInput) reviewInput.value = entry.reviewSummary ?? "";
  const intradayInput = $("#tradeJournalIntradayInput");
  if (intradayInput) intradayInput.value = "";
  renderTradeJournalIntradayEditor(entry);
  renderTradeJournalSourcePicker();
  syncAllCustomSelects();
  setText("#tradeJournalFormTitle", entry.id ? `编辑交易日记 #${entry.id}` : "新建交易日记");
  const saveButton = $("#saveTradeJournalBtn");
  if (saveButton) saveButton.textContent = entry.id ? "保存修改" : "保存日记";
  if (focusReview && reviewInput) {
    requestAnimationFrame(() => {
      reviewInput.focus();
      reviewInput.selectionStart = reviewInput.selectionEnd = reviewInput.value.length;
    });
  }
  if (focusIntraday && intradayInput) {
    requestAnimationFrame(() => {
      intradayInput.focus();
      intradayInput.selectionStart = intradayInput.selectionEnd = intradayInput.value.length;
    });
  }
}

export function resetTradeJournalForm() {
  setTradeJournalForm(null);
}

export async function saveTradeJournal(event) {
  event?.preventDefault();
  const id = $("#tradeJournalIdInput")?.value;
  const payload = tradeJournalFormPayload();
  state.tradeJournalSaving = true;
  state.tradeJournalError = "";
  updateTradeJournalStatus();
  try {
    const saved = await api(id ? `/api/trade-journal/${encodeURIComponent(id)}` : "/api/trade-journal", {
      method: id ? "PUT" : "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    setTradeJournalForm(saved.item ?? null);
    await loadTradeJournal();
  } catch (error) {
    state.tradeJournalError = error instanceof Error ? error.message : String(error);
    renderTradeJournal();
  } finally {
    state.tradeJournalSaving = false;
    updateTradeJournalStatus();
  }
}

export async function addTradeJournalIntradayNote() {
  const id = $("#tradeJournalIdInput")?.value;
  const input = $("#tradeJournalIntradayInput");
  const noteText = String(input?.value ?? "").trim();
  if (!id) return;
  if (!noteText) {
    state.tradeJournalError = "盘中确定不能为空";
    updateTradeJournalStatus();
    input?.focus();
    return;
  }
  state.tradeJournalIntradaySaving = true;
  state.tradeJournalError = "";
  updateTradeJournalStatus();
  renderTradeJournalIntradayEditor(tradeJournalById(id) ?? { id });
  try {
    await api(`/api/trade-journal/${encodeURIComponent(id)}/intraday-notes`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ noteText })
    });
    if (input) input.value = "";
    await loadTradeJournal();
    const refreshed = tradeJournalById(id);
    if (refreshed) {
      setTradeJournalForm(refreshed, { focusIntraday: true });
    }
  } catch (error) {
    state.tradeJournalError = error instanceof Error ? error.message : String(error);
    renderTradeJournal();
  } finally {
    state.tradeJournalIntradaySaving = false;
    updateTradeJournalStatus();
    const current = tradeJournalById(id);
    if (current) renderTradeJournalIntradayEditor(current);
  }
}

function bindTradeJournalActions(root) {
  root.querySelectorAll("[data-trade-journal-action]").forEach((button) => {
    button.addEventListener("click", async () => {
      const item = tradeJournalById(button.dataset.id);
      const action = button.dataset.tradeJournalAction;
      if (!item) return;
      if (action === "edit" || action === "append" || action === "intraday") {
        setTradeJournalForm(item, {
          focusReview: action === "append",
          focusIntraday: action === "intraday"
        });
        $("#tradeJournalForm")?.scrollIntoView({ behavior: "smooth", block: "start" });
        return;
      }
      if (action === "delete") {
        const confirmed = window.confirm(`确定删除这条交易日记吗？\n${item.title || item.symbol || `#${item.id}`}`);
        if (!confirmed) return;
        try {
          await api(`/api/trade-journal/${encodeURIComponent(item.id)}`, { method: "DELETE" });
          if (state.tradeJournal.length === 1 && state.tradeJournalPage > 1) state.tradeJournalPage -= 1;
          await loadTradeJournal();
        } catch (error) {
          state.tradeJournalError = error instanceof Error ? error.message : String(error);
          renderTradeJournal();
        }
      }
    });
  });
}
