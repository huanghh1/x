import { api } from "../api.js";
import { state } from "../state.js";
import { $, escapeHtml, setText } from "../utils/dom.js";
import { clamp, formatCompactUsd, formatNumber, formatPercent, formatTime } from "../utils/format.js";
import { bindCopyButtons, copyButton, searchButtons } from "../ui/symbolActions.js";

function sentimentLabel(value) {
  if (value === "Positive") return "正向";
  if (value === "Negative") return "负向";
  if (value === "Neutral") return "中性";
  return value || "未知";
}

function hotRankChainLabel(chain = state.hotRankChain) {
  return {
    all: "全部链",
    bsc: "BSC",
    base: "Base",
    solana: "Solana"
  }[chain] ?? "全部链";
}

export function hasCurrentHotRankData() {
  return Boolean(state.hotRankFetchedAt && state.hotRankLoadedChain === state.hotRankChain);
}

function hotRankTotalPages() {
  return Math.ceil(state.hotRankTotal / state.hotRankPageSize) || 1;
}

function clampHotRankPage() {
  state.hotRankPage = clamp(state.hotRankPage, 1, hotRankTotalPages());
}

export function renderHotRank() {
  const target = $("#hotRankRows");
  const status = $("#hotRankStatus");
  if (!target || !status) return;

  const hasCurrentData = hasCurrentHotRankData();
  const hasRows = hasCurrentData && state.hotRank.length > 0;
  setText("#heatRankCount", hasRows ? state.hotRankTotal : "--");
  const refreshButton = $("#refreshHotRankBtn");
  if (refreshButton) {
    refreshButton.disabled = state.hotRankLoading;
    refreshButton.textContent = state.hotRankLoading ? "刷新中" : "刷新热度";
  }
  document.querySelectorAll("[data-heat-chain]").forEach((button) => {
    button.classList.toggle("active", button.dataset.heatChain === state.hotRankChain);
  });

  if (state.hotRankLoading) {
    status.textContent = hasCurrentData
      ? `正在刷新${hotRankChainLabel()}热度排行，当前列表为上次结果...`
      : `正在读取${hotRankChainLabel()}热度排行...`;
    status.title = "";
    if (!hasCurrentData) {
      target.innerHTML = '<div class="heat-empty">正在读取热度数据。</div>';
      updateHeatPagination({ empty: true });
      return;
    }
  }

  if (!state.hotRankLoading && hasCurrentData) {
    const flags = [];
    if (state.hotRankStale) flags.push("使用上次缓存");
    else if (state.hotRankPartial) flags.push("部分链失败");
    if (state.hotRankErrors.length) flags.push(`错误 ${state.hotRankErrors.length} 条`);
    status.textContent = `来源：${state.hotRankSource || "Binance Web3 Social Hype"} · 更新时间 ${formatTime(state.hotRankFetchedAt)}${flags.length ? ` · ${flags.join(" · ")}` : ""}`;
    status.title = state.hotRankErrors.join("\n");
  } else {
    status.textContent = state.hotRankError || "等待刷新";
    status.title = state.hotRankError || "";
  }

  if (!hasRows) {
    target.innerHTML = '<div class="heat-empty">暂无热度数据。</div>';
    updateHeatPagination({ empty: true });
    return;
  }

  clampHotRankPage();
  const startIdx = (state.hotRankPage - 1) * state.hotRankPageSize;
  const endIdx = startIdx + state.hotRankPageSize;
  const pageData = state.hotRank.slice(startIdx, endIdx);

  target.innerHTML = pageData
    .map((token) => {
      const change = Number(token.priceChange);
      const changeClass = Number.isFinite(change) && change < 0 ? "down" : "up";
      const symbol = escapeHtml(token.symbol);
      return `
        <article class="heat-rank-row">
          <div class="heat-rank-num">#${escapeHtml(token.rank)}</div>
          <div class="heat-token">
            <div>
              <strong>${symbol}</strong>
              <span>市值 ${formatCompactUsd(token.marketCap)} · 情绪 ${escapeHtml(sentimentLabel(token.sentiment))}</span>
            </div>
          </div>
          <div class="heat-chain">${escapeHtml(token.chainLabel)}</div>
          <div class="heat-score" title="综合热度">${formatNumber(token.heat, 0)}</div>
          <div class="heat-change ${changeClass}">${formatPercent(change)}</div>
          <div class="heat-links">${copyButton(token.symbol)}${searchButtons(token.symbol)}</div>
          <div class="heat-summary" title="${escapeHtml(token.summary || "暂无讨论摘要")}">${escapeHtml(token.summary || "暂无讨论摘要")}</div>
        </article>
      `;
    })
    .join("");

  bindCopyButtons(target);
  updateHeatPagination();
}

function updateHeatPagination({ empty = false } = {}) {
  const hasRows = !empty && hasCurrentHotRankData() && state.hotRankTotal > 0;
  if (hasRows) clampHotRankPage();
  const totalPages = hasRows ? hotRankTotalPages() : 1;
  const displayPage = hasRows ? state.hotRankPage : 1;
  const summary = hasRows
    ? `第 ${displayPage} / ${totalPages} 页，共 ${state.hotRankTotal} 项`
    : "--";
  setText("#heatPaginationSummary", summary);
  setText("#heatPageIndicator", `${displayPage} / ${totalPages}`);

  const prevBtn = $("#prevHeatPageBtn");
  const nextBtn = $("#nextHeatPageBtn");
  if (prevBtn) prevBtn.disabled = state.hotRankLoading || !hasRows || state.hotRankPage <= 1;
  if (nextBtn) nextBtn.disabled = state.hotRankLoading || !hasRows || state.hotRankPage >= totalPages;

  document.querySelectorAll("[data-heat-pagesize]").forEach((btn) => {
    btn.classList.toggle("active", parseInt(btn.dataset.heatPagesize) === state.hotRankPageSize);
    btn.disabled = state.hotRankLoading && !hasRows;
  });
}

export async function loadHotRank({ silent = false } = {}) {
  const requestedChain = state.hotRankChain;
  const requestId = state.hotRankRequestId + 1;
  state.hotRankRequestId = requestId;
  state.hotRankController?.abort();
  const controller = new AbortController();
  state.hotRankController = controller;
  clearTimeout(state.hotRankRefreshTimer);
  state.hotRankLoading = true;
  if (!silent) renderHotRank();
  try {
    state.hotRankError = "";
    const payload = await api(`/api/hot-rank?chain=${encodeURIComponent(requestedChain)}&limit=100`, {
      signal: controller.signal
    });
    if (requestId !== state.hotRankRequestId || requestedChain !== state.hotRankChain) return;
    if (payload.chain !== requestedChain) throw new Error(`分链响应不匹配：请求 ${requestedChain}，返回 ${payload.chain}`);
    state.hotRank = payload.tokens ?? [];
    state.hotRankTotal = state.hotRank.length;
    state.hotRankSource = payload.source ?? "";
    state.hotRankLoadedChain = requestedChain;
    state.hotRankFetchedAt = payload.fetchedAt ?? new Date().toISOString();
    state.hotRankPartial = Boolean(payload.partial);
    state.hotRankStale = Boolean(payload.stale);
    state.hotRankErrors = Array.isArray(payload.errors) ? payload.errors : [];
  } catch (error) {
    if (controller.signal.aborted || requestId !== state.hotRankRequestId) return;
    const message = `热度数据读取失败：${error instanceof Error ? error.message : String(error)}`;
    if (state.hotRank.length && state.hotRankLoadedChain === requestedChain) {
      state.hotRankPartial = true;
      state.hotRankStale = true;
      state.hotRankErrors = [message, ...state.hotRankErrors].slice(0, 5);
    } else {
      state.hotRank = [];
      state.hotRankTotal = 0;
      state.hotRankSource = "";
      state.hotRankLoadedChain = "";
      state.hotRankFetchedAt = null;
      state.hotRankPartial = false;
      state.hotRankStale = false;
      state.hotRankErrors = [];
    }
    state.hotRankError = message;
  } finally {
    if (requestId !== state.hotRankRequestId) return;
    state.hotRankLoading = false;
    state.hotRankController = null;
    renderHotRank();
  }
}

export function bindHotRankControls() {
  for (const button of document.querySelectorAll("[data-heat-chain]")) {
    button.addEventListener("click", async () => {
      state.hotRankChain = button.dataset.heatChain ?? "all";
      state.hotRankPage = 1;
      clearTimeout(state.hotRankRefreshTimer);
      document.querySelectorAll("[data-heat-chain]").forEach((item) => item.classList.toggle("active", item === button));
      await loadHotRank();
    });
  }

  for (const button of document.querySelectorAll("[data-heat-pagesize]")) {
    button.addEventListener("click", () => {
      state.hotRankPageSize = Number(button.dataset.heatPagesize);
      state.hotRankPage = 1;
      document.querySelectorAll("[data-heat-pagesize]").forEach((item) => item.classList.toggle("active", item === button));
      renderHotRank();
    });
  }

  $("#prevHeatPageBtn")?.addEventListener("click", async () => {
    if (state.hotRankPage > 1) {
      state.hotRankPage -= 1;
      renderHotRank();
    }
  });

  $("#nextHeatPageBtn")?.addEventListener("click", async () => {
    const totalPages = Math.ceil(state.hotRankTotal / state.hotRankPageSize) || 1;
    if (state.hotRankPage < totalPages) {
      state.hotRankPage += 1;
      renderHotRank();
    }
  });

  $("#refreshHotRankBtn")?.addEventListener("click", () => loadHotRank());
}
