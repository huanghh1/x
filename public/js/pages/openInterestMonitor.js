import { api } from "../api.js";
import { LABELS, OI_REALTIME_WINDOWS } from "../constants.js";
import { state } from "../state.js";
import { $, escapeHtml, setText } from "../utils/dom.js";
import {
  formatAge,
  formatCompactNumber,
  formatCompactTime,
  formatCompactUsd,
  formatMarketTokenMeta,
  formatNumber,
  formatPercent,
  formatTime
} from "../utils/format.js";
import { bindCopyButtons, copyButton, searchButtons } from "../ui/symbolActions.js";

let deps = {
  bindMarketChartControls: () => {},
  bindWatchButtons: () => {},
  marketChartPanel: () => "",
  updateWatchRealtime: () => {},
  watchButton: () => ""
};

export function configureOpenInterestMonitor(nextDeps = {}) {
  deps = { ...deps, ...nextDeps };
}

function changeClass(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number === 0) return "";
  return number > 0 ? "up" : "down";
}

export async function loadIOMonitoring() {
  const requestId = state.ioRequestId + 1;
  state.ioRequestId = requestId;
  state.ioLoading = true;
  state.ioError = "";
  renderIOMonitoring();
  try {
    const params = new URLSearchParams({
      timeWindow: state.ioWindow,
      sort: state.ioSort,
      categories: Array.from(state.ioCategories).join(","),
      page: String(state.ioPage),
      pageSize: String(state.ioPageSize)
    });
    const payload = await api(`/api/oi-monitoring?${params.toString()}`);
    if (requestId !== state.ioRequestId) return;
    state.ioData = payload.data || [];
    state.ioTotal = payload.total || 0;
    state.ioPage = payload.page || state.ioPage;
    state.ioPageSize = payload.pageSize || state.ioPageSize;
    state.ioMonitor = payload.monitor || null;
    state.ioLastLoadedAt = payload.generatedAt || new Date().toISOString();
    await loadIORealtimeRows();
  } catch (error) {
    if (requestId !== state.ioRequestId) return;
    state.ioError = `OI 数据读取失败：${error instanceof Error ? error.message : String(error)}`;
    console.error("load io monitoring failed", error);
  } finally {
    if (requestId !== state.ioRequestId) return;
    state.ioLoading = false;
    renderIOMonitoring();
  }
}

async function loadIORealtimeRows() {
  const requestId = state.ioRealtimeRequestId + 1;
  state.ioRealtimeRequestId = requestId;
  const rows = [];
  const results = await Promise.allSettled(OI_REALTIME_WINDOWS.map(async (timeWindow) => {
    const params = new URLSearchParams({
      timeWindow,
      sort: "desc",
      categories: Array.from(state.ioCategories).join(","),
      page: "1",
      pageSize: "5"
    });
    const payload = await api(`/api/oi-monitoring?${params.toString()}`);
    for (const item of payload.data ?? []) {
      rows.push({ ...item, realtimeWindow: timeWindow });
    }
  }));
  const failures = results.filter((result) => result.status === "rejected");
  if (failures.length) {
    console.warn("load OI realtime top rows partially failed", failures.map((result) => result.reason));
  }
  if (requestId !== state.ioRealtimeRequestId) return;
  state.ioRealtimeRows = rows;
  deps.updateWatchRealtime();
}

export function renderIOMonitoring() {
  const target = $("#ioRows");
  if (!target) return;

  updateIoControls();

  if (state.ioLoading && !state.ioData.length) {
    target.innerHTML = '<div class="heat-empty">正在读取 OI 数据。</div>';
    setText("#ioStatus", "正在刷新 OI 监控数据...");
    updateIoPagination();
    return;
  }

  if (state.ioError && !state.ioData.length) {
    target.innerHTML = `<div class="heat-empty">${escapeHtml(state.ioError)}</div>`;
    setText("#ioStatus", state.ioError);
    updateIoPagination();
    return;
  }

  if (!state.ioData.length) {
    target.innerHTML = '<div class="heat-empty">暂无 OI 数据。</div>';
    setText("#ioStatus", "暂无 OI 扫描数据");
    updateIoPagination();
    return;
  }

  target.innerHTML = state.ioData
    .map((item) => {
      const matches = [
        item.hotRankHit ? "热度" : null,
        item.fundingOneHour ? "1h资金费率" : null,
        Number(item.multiCycleCount ?? 0) >= 3
          ? `多周期 ${item.multiCycleCount}`
          : Number(item.multiCycleCount ?? 0) > 0
            ? `均线 ${item.multiCycleCount} 周期`
            : null
      ].filter(Boolean);
      const change = Number(item.changePercent);
      const oiChangeClass = Number.isFinite(change) ? (change >= 0 ? "up" : "down") : "";
      const expanded = state.ioExpandedSymbol === item.symbol;
      return `
        <article class="io-card">
          <div class="io-symbol">
            <div class="market-symbol-line">
              <button class="market-symbol-button" type="button" data-market-chart="io" data-market-symbol="${escapeHtml(item.symbol)}" aria-expanded="${expanded}">${escapeHtml(item.symbol)}</button>
              <span>${escapeHtml(state.ioWindow)}</span>
            </div>
            <small class="market-token-meta">${escapeHtml(formatMarketTokenMeta(item))}</small>
          </div>
          <div><span>现价</span><b class="mono" data-market-price="${escapeHtml(item.symbol)}">${formatNumber(item.currentPrice)}</b></div>
          <div><span>24h涨跌</span><b class="mono ${changeClass(item.priceChange24hPct)}" data-market-24h="${escapeHtml(item.symbol)}">${formatPercent(item.priceChange24hPct)}</b></div>
          <div><span>变化</span><b class="${oiChangeClass}">${formatPercent(item.changePercent)}</b></div>
          <div><span>当前持仓量</span><b class="mono">${formatCompactNumber(item.currentOpenInterest)}</b></div>
          <div><span>持仓价值</span><b class="mono">${formatCompactUsd(item.currentOpenInterestValue)}</b></div>
          <div><span>同币种命中</span><b>${escapeHtml(matches.join(" + ") || "暂无")}</b></div>
          <div class="io-observed"><span>样本时间</span><b data-oi-observed="${escapeHtml(item.observedAt)}" data-oi-stale="${item.isStale ? "true" : "false"}" title="币安OI样本：${escapeHtml(formatTime(item.observedAt))}${item.fetchedAt ? `；本系统抓取：${escapeHtml(formatTime(item.fetchedAt))}` : ""}${item.isStale ? `；数据已过期，年龄约 ${Math.round(Number(item.observedAgeSeconds ?? 0) / 60)} 分钟` : ""}">${formatAge(item.observedAt)}${item.isStale ? " · 过期" : ""}</b><small>${formatCompactTime(item.observedAt)}</small></div>
          <div class="heat-links">
            ${copyButton(item.symbol)}
            ${deps.watchButton(item.symbol, "从 OI 监控加入")}
            ${searchButtons(item.symbol)}
          </div>
        </article>
        ${expanded ? deps.marketChartPanel(item.symbol, state.ioChartInterval, "io") : ""}
      `;
    })
    .join("");
  deps.bindWatchButtons(target);
  bindCopyButtons(target);
  deps.bindMarketChartControls(target, "io");
  const statusParts = [
    `${state.ioWindow} 变化率`,
    state.ioSort === "desc" ? "从高到低" : "从低到高",
    summarizeIoCategories(),
    `${state.ioTotal} 个代币`
  ];
  if (state.ioMonitor?.running) statusParts.push("扫描中");
  if (Number(state.ioMonitor?.scannedCount ?? 0) > 0) {
    const selectedCount = Number(state.ioMonitor?.selectedCount ?? 0);
    const selectedSuffix = selectedCount > Number(state.ioMonitor.scannedCount ?? 0) ? `，选中 ${selectedCount}` : "";
    const concurrency = Number(state.ioMonitor?.concurrency ?? 0);
    statusParts.push(`本轮已扫 ${state.ioMonitor.scannedCount}/${state.ioMonitor.totalTokenCount ?? "--"}${selectedSuffix}${concurrency > 0 ? ` · 并发 ${concurrency}` : ""}`);
  }
  if (state.ioMonitor?.runBudgetHit) {
    statusParts.push("时间预算命中，下轮续扫");
  }
  if (Number(state.ioMonitor?.retryPendingCount ?? 0) > 0) {
    statusParts.push(`待重试 ${state.ioMonitor.retryPendingCount}`);
  }
  if (Number(state.ioMonitor?.alertPendingCount ?? 0) > 0) {
    statusParts.push(`TG待发送 ${state.ioMonitor.alertPendingCount}`);
  }
  if (state.ioLastLoadedAt) statusParts.push(`本地读取 ${formatTime(state.ioLastLoadedAt)}`);
  if (state.ioScanning) statusParts.push("正在触发扫描");
  if (state.ioLoading) statusParts.push("刷新中");
  if (state.ioError) statusParts.push("上次刷新失败，保留当前结果");
  if (state.ioData.some((item) => item.isStale)) statusParts.push(`本页 ${state.ioData.filter((item) => item.isStale).length} 项过期`);
  if (state.ioMonitor?.errors?.length) statusParts.push(`抓取错误 ${state.ioMonitor.errors.length} 条`);
  setText("#ioStatus", statusParts.join(" · "));
  updateIoPagination();
}

export function updateOiAgeLabels() {
  for (const element of document.querySelectorAll("[data-oi-observed]")) {
    const observedAt = element.dataset.oiObserved;
    const stale = element.dataset.oiStale === "true";
    element.textContent = `${formatAge(observedAt)}${stale ? " · 过期" : ""}`;
    const detail = element.parentElement?.querySelector("small");
    if (detail) detail.textContent = formatCompactTime(observedAt);
  }
  if (state.currentView === "io" && state.ioLastLoadedAt) {
    const status = $("#ioStatus");
    if (status && !status.textContent.includes("本地读取")) {
      renderIOMonitoring();
    }
  }
}

function updateIoControls() {
  document.querySelectorAll("[data-io-window]").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.ioWindow === state.ioWindow);
  });
  document.querySelectorAll("[data-io-sort]").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.ioSort === state.ioSort);
  });
  document.querySelectorAll("[data-io-category]").forEach((input) => {
    input.checked = state.ioCategories.has(input.dataset.ioCategory);
  });
  setText("#ioCategoryFilterSummary", summarizeIoCategories());
  const refresh = $("#refreshIoBtn");
  if (refresh) {
    refresh.disabled = state.ioLoading;
    refresh.textContent = state.ioLoading ? "刷新中" : "刷新数据";
  }
  const scan = $("#scanIoBtn");
  if (scan) {
    scan.disabled = state.ioLoading || state.ioScanning;
    scan.textContent = state.ioScanning ? "扫描中" : "立即扫描";
  }
}

function summarizeIoCategories() {
  if (!state.ioCategories.size) return "未选择分类";
  return Array.from(state.ioCategories)
    .map((category) => LABELS.category[category] ?? category)
    .join("、");
}

function updateIoPagination() {
  const totalPages = Math.ceil(state.ioTotal / state.ioPageSize) || 1;
  setText("#ioPaginationSummary", state.ioTotal ? `第 ${state.ioPage} / ${totalPages} 页，共 ${state.ioTotal} 项` : "--");
  setText("#ioPageIndicator", `${state.ioPage} / ${totalPages}`);
  const prev = $("#prevIoPageBtn");
  const next = $("#nextIoPageBtn");
  if (prev) prev.disabled = state.ioPage <= 1;
  if (next) next.disabled = state.ioPage >= totalPages;
  document.querySelectorAll("[data-io-pagesize]").forEach((btn) => {
    btn.classList.toggle("active", Number(btn.dataset.ioPagesize) === state.ioPageSize);
  });
}

export function bindOpenInterestControls() {
  document.querySelectorAll("[data-io-category]").forEach((input) => {
    input.addEventListener("change", () => {
      if (input.checked) state.ioCategories.add(input.dataset.ioCategory);
      else state.ioCategories.delete(input.dataset.ioCategory);
      state.ioPage = 1;
      state.ioExpandedSymbol = null;
      loadIOMonitoring();
    });
  });

  document.querySelectorAll("[data-io-window]").forEach((btn) => {
    btn.addEventListener("click", () => {
      state.ioWindow = btn.dataset.ioWindow;
      state.ioPage = 1;
      document.querySelectorAll("[data-io-window]").forEach((b) => {
        b.classList.toggle("active", b === btn);
      });
      loadIOMonitoring();
    });
  });

  document.querySelectorAll("[data-io-sort]").forEach((btn) => {
    btn.addEventListener("click", () => {
      state.ioSort = btn.dataset.ioSort;
      state.ioPage = 1;
      document.querySelectorAll("[data-io-sort]").forEach((item) => item.classList.toggle("active", item === btn));
      loadIOMonitoring();
    });
  });

  document.querySelectorAll("[data-io-pagesize]").forEach((btn) => {
    btn.addEventListener("click", () => {
      state.ioPageSize = Number(btn.dataset.ioPagesize);
      state.ioPage = 1;
      document.querySelectorAll("[data-io-pagesize]").forEach((item) => item.classList.toggle("active", item === btn));
      loadIOMonitoring();
    });
  });

  $("#prevIoPageBtn")?.addEventListener("click", () => {
    if (state.ioPage > 1) {
      state.ioPage -= 1;
      loadIOMonitoring();
    }
  });

  $("#nextIoPageBtn")?.addEventListener("click", () => {
    const totalPages = Math.ceil(state.ioTotal / state.ioPageSize) || 1;
    if (state.ioPage < totalPages) {
      state.ioPage += 1;
      loadIOMonitoring();
    }
  });

  $("#refreshIoBtn")?.addEventListener("click", () => loadIOMonitoring());
  $("#scanIoBtn")?.addEventListener("click", async () => {
    state.ioScanning = true;
    renderIOMonitoring();
    try {
      await api("/api/open-interest/check", { method: "POST" });
      await loadIOMonitoring();
    } catch (error) {
      state.ioError = `OI 扫描失败：${error instanceof Error ? error.message : String(error)}`;
      renderIOMonitoring();
    } finally {
      state.ioScanning = false;
      renderIOMonitoring();
    }
  });
}
