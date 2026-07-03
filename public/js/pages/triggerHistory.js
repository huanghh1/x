import { api } from "../api.js";
import { state } from "../state.js";
import { $, escapeHtml, setText } from "../utils/dom.js";
import { formatTime } from "../utils/format.js";

let copyButtonRenderer = (symbol) => String(symbol ?? "");
let bindCopyButtonsHandler = () => {};

export function configureTriggerHistory({ copyButton, bindCopyButtons } = {}) {
  if (typeof copyButton === "function") copyButtonRenderer = copyButton;
  if (typeof bindCopyButtons === "function") bindCopyButtonsHandler = bindCopyButtons;
}

export async function loadTriggerHistory() {
  try {
    const params = new URLSearchParams({
      page: String(state.triggerHistoryPage),
      pageSize: String(state.triggerHistoryPageSize),
      triggerTypes: Array.from(state.triggerTypes).join(",")
    });
    const payload = await api(`/api/trigger-history?${params.toString()}`);
    state.triggerHistory = payload.items || [];
    state.triggerHistoryTotal = payload.total || 0;
    state.selectedTriggerIds = new Set(
      Array.from(state.selectedTriggerIds).filter((id) => state.triggerHistory.some((item) => item.id === id))
    );
    renderTriggerHistory();
  } catch (error) {
    console.error("load trigger history failed", error);
  }
}

export function renderTriggerHistory() {
  const target = $("#triggerHistoryRows");
  if (!target) return;

  if (!state.triggerHistory.length) {
    target.innerHTML = '<tr><td colspan="7" class="empty">暂无记录</td></tr>';
    updateTriggerSelectionUi();
    updateTriggerHistoryPagination();
    return;
  }

  target.innerHTML = state.triggerHistory
    .map((item) => `
      <tr>
        <td><input type="checkbox" data-trigger-id="${item.id}" ${state.selectedTriggerIds.has(item.id) ? "checked" : ""} /></td>
        <td><div class="symbol-cell compact">${escapeHtml(item.symbol)} ${copyButtonRenderer(item.symbol)}</div></td>
        <td>${escapeHtml(triggerTypeLabel(item.triggerType))}</td>
        <td>${escapeHtml(item.intervalsTriggered || "-")}</td>
        <td>${escapeHtml(item.signalLevel || "-")}</td>
        <td>${formatTime(item.triggerTime)}</td>
        <td><button class="ghost-button" data-delete-trigger="${item.id}">删除</button></td>
      </tr>
    `)
    .join("");

  bindTriggerSelection();
  bindCopyButtonsHandler(target);
  updateTriggerHistoryPagination();
}

function triggerTypeLabel(type) {
  return {
    MA_SIGNAL: "均线一级",
    HOT_RANK: "热度上榜",
    FUNDING_RATE: "1h资金费率",
    OI_SPIKE: "OI暴涨",
    COMPOSITE: "复合信号"
  }[type] ?? type ?? "--";
}

function updateTriggerSelectionUi() {
  const count = state.selectedTriggerIds.size;
  setText("#selectedTriggerCount", `已选 ${count} 条`);
  const deleteButton = $("#deleteSelectedTriggerBtn");
  if (deleteButton) deleteButton.disabled = count === 0;
  const selectAll = $("#selectAllTrigger");
  if (selectAll) {
    const visibleIds = state.triggerHistory.map((item) => item.id);
    selectAll.checked = visibleIds.length > 0 && visibleIds.every((id) => state.selectedTriggerIds.has(id));
    selectAll.indeterminate = visibleIds.some((id) => state.selectedTriggerIds.has(id)) && !selectAll.checked;
  }
}

function bindTriggerSelection() {
  document.querySelectorAll("[data-trigger-id]").forEach((input) => {
    input.addEventListener("change", () => {
      const id = Number(input.dataset.triggerId);
      if (input.checked) state.selectedTriggerIds.add(id);
      else state.selectedTriggerIds.delete(id);
      updateTriggerSelectionUi();
    });
  });
  updateTriggerSelectionUi();
}

function updateTriggerHistoryPagination() {
  const totalPages = Math.ceil(state.triggerHistoryTotal / state.triggerHistoryPageSize) || 1;
  const summary = state.triggerHistoryTotal
    ? `第 ${state.triggerHistoryPage} / ${totalPages} 页，共 ${state.triggerHistoryTotal} 项`
    : "--";
  setText("#triggerHistoryPaginationSummary", summary);
  setText("#triggerPageIndicator", `${state.triggerHistoryPage} / ${totalPages}`);

  const prevBtn = $("#prevTriggerPageBtn");
  const nextBtn = $("#nextTriggerPageBtn");
  if (prevBtn) prevBtn.disabled = state.triggerHistoryPage <= 1;
  if (nextBtn) nextBtn.disabled = state.triggerHistoryPage >= totalPages;

  document.querySelectorAll("[data-trigger-pagesize]").forEach((btn) => {
    btn.classList.toggle("active", parseInt(btn.dataset.triggerPagesize) === state.triggerHistoryPageSize);
  });
}
