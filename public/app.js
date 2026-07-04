import { api } from "./js/api.js";
import { ALL_INTERVALS } from "./js/constants.js";
import { enhanceCustomSelects, syncCustomSelect } from "./js/components/customSelect.js";
import { state } from "./js/state.js";
import { $, escapeHtml, setText } from "./js/utils/dom.js";
import {
  crawlerDetailText,
  crawlerMetaText,
  formatTime
} from "./js/utils/format.js";
import {
  chartElementId,
  configureKlineChart,
  drawChartForKey,
  loadAndRenderChart
} from "./js/chart/klineChart.js";
import {
  deleteRuntimeLogs,
  loadRuntimeLogs,
  renderRuntimeLogs,
  runtimeLogId,
  selectedRuntimeLogFiles
} from "./js/pages/runtimeLogs.js";
import {
  bindFundingControls,
  configureFundingMonitor,
  loadFundingRateTokens,
  renderFundingRateTokens
} from "./js/pages/fundingMonitor.js";
import { bindHotRankControls, hasCurrentHotRankData, loadHotRank } from "./js/pages/hotRank.js";
import {
  bindOpenInterestControls,
  configureOpenInterestMonitor,
  loadIOMonitoring,
  renderIOMonitoring,
  updateOiAgeLabels
} from "./js/pages/openInterestMonitor.js";
import {
  bindSignalControls,
  configureSignals,
  loadSignalsPage,
  renderSignals,
  signalProfile,
  updateFilterControls
} from "./js/pages/signals.js";
import {
  bindWatchButtons,
  bindWatchlistControls,
  configureWatchlist,
  loadWatchlist,
  renderWatchlist,
  updateSignalWatchButtons,
  watchButton
} from "./js/pages/watchlist.js";
import {
  loadTradeAnalysis,
  renderTradeAnalysis,
  runTradeCodexAnalysis,
  setTradeCodexScope,
  setTradeWindow,
  sortTradeSymbolRowsByTime,
  tradeAnalysisRows,
  tradeSymbolRowKey
} from "./js/pages/tradeAnalysis.js";
import {
  addTradeJournalIntradayNote,
  applyTradeJournalSourceOption,
  configureTradeJournal,
  loadTradeJournal,
  loadTradeJournalSources,
  renderTradeJournalSourcePicker,
  resetTradeJournalForm,
  saveTradeJournal
} from "./js/pages/tradeJournal.js";
import { updateWatchRealtime } from "./js/realtime/watchRealtime.js";
import { copyText } from "./js/ui/symbolActions.js";

async function bootstrap() {
  if (state.previewMode || state.bootstrapped) return;
  state.bootstrapped = true;
  try {
    await api("/api/bootstrap", { method: "POST" });
  } catch (error) {
    console.warn("bootstrap failed", error);
  }
}

function renderOverview(payload) {
  const { overview, database, crawler } = payload;
  const totals = overview.totals;
  setText("#totalTokens", totals.totalTokens);
  setText("#level1Signals", totals.level1Signals);
  setText("#level2Signals", totals.level2Signals);
  setText("#totalTokensMirror", totals.totalTokens);

  const catA = overview.categories.find((item) => item.categoryType === "A");
  const catB = overview.categories.find((item) => item.categoryType === "B");
  setText("#catAStat", catA ? `${catA.cached}/${catA.total}` : "--");
  setText("#catBStat", catB ? `${catB.cached}/${catB.total}` : "--");

  const dbState = $("#dbState");
  if (dbState) {
    dbState.textContent = database === "connected" ? "数据库已连接" : "数据库异常";
    dbState.classList.toggle("is-ok", database === "connected");
    dbState.classList.toggle("is-bad", database !== "connected");
  }
  setText("#dbBadge", database === "connected" ? "正常" : "异常");
  setText("#footerDb", `数据库连接状态：${database === "connected" ? "正常" : "异常"}`);
  setText("#footerTime", formatTime(overview.lastUpdatedAt));
  setText("#crawlerStatus", crawlerMetaText(crawler ?? {}));
  setText("#crawlerAction", crawlerDetailText(crawler ?? {}));
}

function marketChartPanel(symbol, intervalCode, kind) {
  return `
    <article class="market-chart-detail">
      <div class="market-chart-head">
        <strong>${escapeHtml(symbol)} K线</strong>
        <div class="signal-chart-switch" aria-label="${escapeHtml(symbol)} 图表周期">
          ${ALL_INTERVALS.map((interval) => `<button type="button" class="${intervalCode === interval ? "active" : ""}" data-market-chart-interval="${interval}" data-market-chart-kind="${kind}">${interval}</button>`).join("")}
        </div>
      </div>
      <div class="chart-shell" id="${chartElementId(`${symbol}|${intervalCode}`)}">
        <div class="chart-loading">正在读取 ${escapeHtml(symbol)} ${escapeHtml(intervalCode)} K线...</div>
      </div>
    </article>
  `;
}

function bindMarketChartControls(target, kind) {
  for (const button of target.querySelectorAll(`[data-market-chart="${kind}"]`)) {
    button.addEventListener("click", () => {
      const symbol = button.dataset.marketSymbol ?? "";
      if (kind === "funding") {
        state.fundingExpandedSymbol = state.fundingExpandedSymbol === symbol ? null : symbol;
        renderFundingRateTokens();
      } else {
        state.ioExpandedSymbol = state.ioExpandedSymbol === symbol ? null : symbol;
        renderIOMonitoring();
      }
    });
  }
  for (const button of target.querySelectorAll(`[data-market-chart-kind="${kind}"]`)) {
    button.addEventListener("click", () => {
      if (kind === "funding") {
        state.fundingInterval = button.dataset.marketChartInterval ?? "15m";
        renderFundingRateTokens();
      } else {
        state.ioChartInterval = button.dataset.marketChartInterval ?? "15m";
        renderIOMonitoring();
      }
    });
  }
  const symbol = kind === "funding" ? state.fundingExpandedSymbol : state.ioExpandedSymbol;
  const intervalCode = kind === "funding" ? state.fundingInterval : state.ioChartInterval;
  if (symbol) loadAndRenderChart({ symbol, intervalCode });
  updateWatchRealtime();
}

configureFundingMonitor({
  bindMarketChartControls,
  bindWatchButtons,
  loadWatchlist,
  marketChartPanel,
  watchButton
});

configureOpenInterestMonitor({
  bindMarketChartControls,
  bindWatchButtons,
  marketChartPanel,
  updateWatchRealtime,
  watchButton
});

configureSignals({
  bindWatchButtons,
  updateWatchRealtime,
  watchButton
});

configureWatchlist({ updateWatchRealtime });

configureTradeJournal({
  loadTradeAnalysis,
  tradeAnalysisRows,
  sortTradeSymbolRowsByTime,
  tradeSymbolRowKey
});

configureKlineChart({ copyText, signalProfile });

function pageFromHash() {
  if (window.location.hash === "#heatPage") return "heat";
  if (window.location.hash === "#watchPage") return "watch";
  if (window.location.hash === "#fundingPage") return "funding";
  if (window.location.hash === "#ioPage") return "io";
  if (window.location.hash === "#runtimeLogsPage") return "runtime-logs";
  if (window.location.hash === "#tradeAnalysisPage") return "trade-analysis";
  if (window.location.hash === "#tradeJournalPage") return "trade-journal";
  if (window.location.hash === "#overview") {
    window.history.replaceState(null, "", "#signalsPage");
  }
  return "signals";
}

function alignTradeAnalysisAnchor() {
  const align = () => {
    const target = $("#tradeAnalysisPage");
    if (!target) return;
    const navHeight = $(".app-nav")?.getBoundingClientRect().height ?? 80;
    const top = target.getBoundingClientRect().top + window.scrollY - navHeight - 16;
    window.scrollTo({ top: Math.max(0, top), behavior: "auto" });
  };
  requestAnimationFrame(align);
  setTimeout(align, 120);
}

function setPage(page) {
  state.currentView = page;
  document.body.dataset.page = page;
  if (page !== "signals" && state.expandedKey) {
    state.expandedKey = null;
    renderSignals();
  }
  if (page !== "watch" && state.watchExpandedSymbol) {
    state.watchExpandedSymbol = null;
    renderWatchlist();
  }
  if (page !== "funding" && state.fundingExpandedSymbol) {
    state.fundingExpandedSymbol = null;
    renderFundingRateTokens();
  }
  if (page !== "io" && state.ioExpandedSymbol) {
    state.ioExpandedSymbol = null;
    renderIOMonitoring();
  }
  document.querySelectorAll("[data-nav-page]").forEach((link) => {
    link.classList.toggle("active", link.dataset.navPage === page);
  });
  const mobileSelect = $("#mobilePageSelect");
  if (mobileSelect) {
    mobileSelect.value = page;
    syncCustomSelect(mobileSelect);
  }
  if (page === "heat" && !state.hotRankLoading) loadHotRank({ silent: hasCurrentHotRankData() });
  if (page === "watch") loadWatchlist();
  else updateWatchRealtime();
  if (page === "funding") loadFundingRateTokens();
  if (page === "io") loadIOMonitoring();
  if (page === "runtime-logs") loadRuntimeLogs();
  if (page === "trade-analysis") {
    alignTradeAnalysisAnchor();
    loadTradeAnalysis();
  }
  if (page === "trade-journal") {
    loadTradeJournal();
    if (!state.tradeAnalysis && !state.tradeJournalSourceLoading) {
      loadTradeJournalSources({ refresh: false });
    } else {
      renderTradeJournalSourcePicker();
    }
  }
}

async function refreshAll({ keepPage = true } = {}) {
  try {
    const overview = await api("/api/overview");
    renderOverview(overview);
    if (state.currentView !== "signals") return;
    if (!keepPage) state.page = 1;
    await loadSignalsPage();
    renderSignals();
  } catch (error) {
    const dbState = $("#dbState");
    if (dbState) {
      dbState.textContent = "服务未连接";
      dbState.classList.add("is-bad");
    }
    setText("#dbBadge", "异常");
    setText("#crawlerAction", error instanceof Error ? error.message : String(error));
  }
}

$("#refreshRuntimeLogsBtn")?.addEventListener("click", () => loadRuntimeLogs());
$("#refreshTradeAnalysisBtn")?.addEventListener("click", () => loadTradeAnalysis());
$("#applyTradeFilterBtn")?.addEventListener("click", () => {
  state.tradeSymbolPage = 1;
  loadTradeAnalysis();
});
["#tradeStartInput", "#tradeEndInput"].forEach((selector) => {
  $(selector)?.addEventListener("change", () => {
    state.tradeWindowKey = "";
    updateTradeWindowButtons("");
  });
});
$("#runTradeCodexBtn")?.addEventListener("click", () => runTradeCodexAnalysis());
$("#tradeSymbolSelect")?.addEventListener("change", (event) => {
  if (!["trade", "symbol"].includes(state.tradeCodexScope)) {
    event.currentTarget.value = "";
    state.selectedTradeSymbolKey = "";
    renderTradeAnalysis();
    return;
  }
  state.selectedTradeSymbolKey = event.currentTarget.value || "";
  state.tradeCodexError = "";
  state.tradeCodexResult = null;
  renderTradeAnalysis();
});
document.querySelectorAll("[data-trade-codex-scope]").forEach((button) => {
  button.addEventListener("click", () => {
    setTradeCodexScope(button.dataset.tradeCodexScope || "all");
    renderTradeAnalysis();
  });
});
document.querySelectorAll("[data-trade-codex-window]").forEach((button) => {
  button.addEventListener("click", () => {
    setTradeCodexScope("range");
    setTradeWindow(button.dataset.tradeCodexWindow || "30d");
  });
});
document.querySelectorAll("[data-trade-window]").forEach((button) => {
  button.addEventListener("click", () => {
    setTradeWindow(button.dataset.tradeWindow || "max");
  });
});
document.querySelectorAll("[data-trade-symbol-pagesize]").forEach((btn) => {
  btn.addEventListener("click", () => {
    state.tradeSymbolPageSize = Number(btn.dataset.tradeSymbolPagesize);
    state.tradeSymbolPage = 1;
    loadTradeAnalysis({ refresh: false });
  });
});
$("#prevTradeSymbolPageBtn")?.addEventListener("click", () => {
  if (state.tradeSymbolPage > 1) {
    state.tradeSymbolPage -= 1;
    loadTradeAnalysis({ refresh: false });
  }
});
$("#nextTradeSymbolPageBtn")?.addEventListener("click", () => {
  const totalPages = Math.ceil(state.tradeSymbolTotal / state.tradeSymbolPageSize) || 1;
  if (state.tradeSymbolPage < totalPages) {
    state.tradeSymbolPage += 1;
    loadTradeAnalysis({ refresh: false });
  }
});
$("#tradeSymbolInput")?.addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    state.tradeSymbolPage = 1;
    loadTradeAnalysis();
  }
});
$("#tradeJournalForm")?.addEventListener("submit", saveTradeJournal);
$("#newTradeJournalBtn")?.addEventListener("click", () => {
  resetTradeJournalForm();
  $("#tradeJournalForm")?.scrollIntoView({ behavior: "smooth", block: "start" });
});
$("#resetTradeJournalFormBtn")?.addEventListener("click", resetTradeJournalForm);
$("#addTradeJournalIntradayBtn")?.addEventListener("click", addTradeJournalIntradayNote);
$("#refreshTradeJournalBtn")?.addEventListener("click", () => loadTradeJournal());
$("#refreshTradeJournalSourcesBtn")?.addEventListener("click", () => loadTradeJournalSources({ refresh: true }));
$("#tradeJournalSourceSelect")?.addEventListener("change", (event) => {
  applyTradeJournalSourceOption(event.currentTarget.value);
});
$("#applyTradeJournalFilterBtn")?.addEventListener("click", () => {
  state.tradeJournalPage = 1;
  loadTradeJournal();
});
$("#tradeJournalSearchInput")?.addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    state.tradeJournalPage = 1;
    loadTradeJournal();
  }
});
$("#tradeJournalStatusFilter")?.addEventListener("change", () => {
  state.tradeJournalPage = 1;
  loadTradeJournal();
});
document.querySelectorAll("[data-trade-journal-pagesize]").forEach((btn) => {
  btn.addEventListener("click", () => {
    state.tradeJournalPageSize = Number(btn.dataset.tradeJournalPagesize);
    state.tradeJournalPage = 1;
    loadTradeJournal();
  });
});
$("#prevTradeJournalPageBtn")?.addEventListener("click", () => {
  if (state.tradeJournalPage > 1) {
    state.tradeJournalPage -= 1;
    loadTradeJournal();
  }
});
$("#nextTradeJournalPageBtn")?.addEventListener("click", () => {
  const totalPages = Math.ceil(state.tradeJournalTotal / state.tradeJournalPageSize) || 1;
  if (state.tradeJournalPage < totalPages) {
    state.tradeJournalPage += 1;
    loadTradeJournal();
  }
});
$("#selectAllRuntimeLogs")?.addEventListener("change", (event) => {
  const checked = event.currentTarget.checked;
  state.runtimeLogs.forEach((item) => {
    if (item.source !== "pm2" || !item.file) return;
    const id = runtimeLogId(item);
    if (checked) state.selectedRuntimeLogIds.add(id);
    else state.selectedRuntimeLogIds.delete(id);
  });
  renderRuntimeLogs();
});
$("#deleteSelectedRuntimeLogsBtn")?.addEventListener("click", async () => {
  const files = selectedRuntimeLogFiles();
  if (!files.length) return;
  if (!confirm(`确定要清空所选 ${files.length} 个日志文件吗？`)) return;
  await deleteRuntimeLogs(files);
});
$("#clearRuntimeLogsBtn")?.addEventListener("click", async () => {
  if (!confirm("确定要清空全部 PM2 运行日志吗？")) return;
  await deleteRuntimeLogs();
});
$("#refreshBtn")?.addEventListener("click", () => refreshAll({ keepPage: false }));

for (const anchor of document.querySelectorAll('a[href^="#"]')) {
  anchor.addEventListener("click", (event) => {
    if (anchor.dataset.navPage) return;
    const id = anchor.getAttribute("href");
    if (!id || id === "#") return;
    const target = document.querySelector(id);
    if (!target) return;
    event.preventDefault();
    target.scrollIntoView({ behavior: "smooth", block: "start" });
  });
}

window.addEventListener("hashchange", () => setPage(pageFromHash()));

$("#mobilePageSelect")?.addEventListener("change", (event) => {
  const page = event.currentTarget.value;
  const hashes = {
    signals: "#signalsPage",
    heat: "#heatPage",
    watch: "#watchPage",
    funding: "#fundingPage",
    io: "#ioPage",
    "runtime-logs": "#runtimeLogsPage",
    "trade-analysis": "#tradeAnalysisPage",
    "trade-journal": "#tradeJournalPage"
  };
  window.location.hash = hashes[page] ?? "#signalsPage";
});

window.addEventListener("resize", () => {
  for (const canvas of document.querySelectorAll(".kline-canvas[data-key]")) {
    drawChartForKey(canvas.dataset.key);
  }
});

function scheduleVisiblePoll(label, intervalMs, callback) {
  let lastRunAt = Date.now();
  const run = () => {
    if (document.visibilityState === "hidden") return;
    lastRunAt = Date.now();
    Promise.resolve()
      .then(callback)
      .catch((error) => console.error(`${label} failed`, error));
  };
  setInterval(run, intervalMs);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && Date.now() - lastRunAt >= intervalMs) run();
  });
}

enhanceCustomSelects();
bindHotRankControls();
bindFundingControls();
bindOpenInterestControls();
bindSignalControls({ refreshAll });
bindWatchlistControls();
updateFilterControls();
setPage(pageFromHash());
void bootstrap();
void refreshAll({ keepPage: false });
if (state.currentView !== "heat") void loadHotRank({ silent: true });
void loadWatchlist();
scheduleVisiblePoll("hot rank refresh", 5 * 60 * 1000, () => loadHotRank({ silent: true }));
scheduleVisiblePoll("watchlist refresh", 60 * 1000, () => {
  if (state.currentView === "watch") return loadWatchlist({ silent: true });
  return null;
});
scheduleVisiblePoll("funding refresh", 60 * 1000, () => {
  if (state.currentView === "funding" && !state.fundingLoading && !state.fundingScanning) {
    return loadFundingRateTokens({ silent: true });
  }
  return null;
});
scheduleVisiblePoll("signals refresh", 60 * 1000, () => {
  if (state.currentView === "signals") return refreshAll({ keepPage: true });
  return null;
});
scheduleVisiblePoll("oi monitoring refresh", 3 * 60 * 1000, () => {
  if (state.currentView === "io") return loadIOMonitoring();
  return null;
});
scheduleVisiblePoll("oi age labels", 30 * 1000, updateOiAgeLabels);
