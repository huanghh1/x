import { api } from "./js/api.js";
import {
  ALL_INTERVALS,
  DAY_MS,
  HOUR_MS,
  LABELS,
  OI_REALTIME_WINDOWS,
  SIGNAL_PROFILE_COLORS,
  TRADE_MAX_LOOKBACK_DAYS
} from "./js/constants.js";
import { enhanceCustomSelects, syncAllCustomSelects, syncCustomSelect } from "./js/components/customSelect.js";
import { state } from "./js/state.js";
import { $, closestElement, escapeHtml, setText } from "./js/utils/dom.js";
import {
  clamp,
  crawlerDetailText,
  crawlerMetaText,
  cssEscape,
  datetimeLocalToIso,
  formatAge,
  formatCompactNumber,
  formatCompactTime,
  formatCompactUsd,
  formatFundingPercent,
  formatNumber,
  formatPercent,
  formatTime,
  formatUsd,
  fundingRateTone,
  oiChangeSummary,
  pnlClass,
  toDatetimeLocal
} from "./js/utils/format.js";
import {
  chartElementId,
  chartKlineLength,
  configureKlineChart,
  drawChartForKey,
  intervalMsFromCode,
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
  addTradeJournalIntradayNote,
  applyTradeJournalSourceOption,
  configureTradeJournal,
  loadTradeJournal,
  loadTradeJournalSources,
  renderTradeJournalSourcePicker,
  resetTradeJournalForm,
  saveTradeJournal
} from "./js/pages/tradeJournal.js";
import { configureTriggerHistory, loadTriggerHistory, renderTriggerHistory } from "./js/pages/triggerHistory.js";

function watchOperationError(action, error) {
  return `${action}失败：${error instanceof Error ? error.message : String(error)}`;
}

function watchUnlockLabel(item) {
  if (item.unlockStatus === "available") return formatTime(item.nextUnlockAt);
  if (item.unlockStatus === "none") return "暂无未来解锁";
  if (item.unlockStatus === "undated") return "日期未公布";
  if (item.unlockStatus === "unconfigured") return "未配置";
  if (item.unlockStatus === "error") return "查询失败";
  return "--";
}

function watchUnlockTitle(item) {
  const parts = [];
  if (item.unlockProvider) parts.push(`来源：${item.unlockProvider}`);
  if (item.unlockPercent !== null && item.unlockPercent !== undefined) parts.push(`比例：${formatPercent(item.unlockPercent)}`);
  if (item.unlockAmount !== null && item.unlockAmount !== undefined) parts.push(`数量：${formatCompactNumber(item.unlockAmount)}`);
  if (item.unlockCheckedAt) parts.push(`核对：${formatTime(item.unlockCheckedAt)}`);
  if (item.unlockError) parts.push(`错误：${item.unlockError}`);
  return parts.join("\n");
}

function watchStatusText() {
  if (state.watchLoading) return "正在读取关注池";
  if (state.watchError) return state.watchError;
  const count = state.watchlist.length;
  if (!count) return "暂无关注代币";
  const liveCount = state.watchlist.filter((item) => item.currentPrice !== null && item.currentPrice !== undefined).length;
  const latestTime = Math.max(
    ...state.watchlist
      .map((item) => Number(item.currentCloseTime ?? item.realtimePriceTime ?? 0))
      .filter(Number.isFinite)
  );
  const suffix = Number.isFinite(latestTime) && latestTime > 0 ? `，最新价格时间 ${formatTime(latestTime)}` : "";
  return `共 ${count} 个关注，${liveCount} 个有价格缓存${suffix}`;
}

function updateWatchStatus() {
  setText("#watchStatus", watchStatusText());
}

function levelBadge(level) {
  if (level === "LEVEL1") return '<span class="level-badge level1">一级警报</span>';
  if (level === "LEVEL2") return '<span class="level-badge level2">二级预警</span>';
  if (level === "INSUFFICIENT") return '<span class="level-badge">样本不足</span>';
  return '<span class="level-badge none">观察中</span>';
}

function rowKey(row) {
  return String(row.displayKey ?? row.symbol ?? "");
}

function baseAsset(symbol) {
  return String(symbol ?? "").toUpperCase().replace(/USDT$/, "");
}

function twitterSearchUrl(symbol) {
  return `https://mobile.twitter.com/search?q=${encodeURIComponent(`$${baseAsset(symbol)}`)}&src=typed_query&f=live`;
}

function binanceSquareSearchUrl(symbol) {
  return `https://www.binance.com/en/square/search?s=${encodeURIComponent(baseAsset(symbol))}`;
}

function signalProfile(row) {
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

function searchButtons(symbol) {
  const safeSymbol = escapeHtml(symbol);
  return `
    <a class="mini-link" href="${escapeHtml(binanceSquareSearchUrl(symbol))}" target="_blank" rel="noreferrer" title="在币安广场搜索 ${safeSymbol}">广场</a>
    <a class="mini-link" href="${escapeHtml(twitterSearchUrl(symbol))}" target="_blank" rel="noreferrer" title="在推特搜索 ${safeSymbol}">推特</a>
  `;
}

function copyButton(symbol, label = "复制") {
  return `<button class="copy-symbol" type="button" data-symbol="${escapeHtml(symbol)}" title="复制交易对">${escapeHtml(label)}</button>`;
}

function watchSymbols() {
  return new Set(state.watchlist.map((item) => String(item.symbol ?? "").toUpperCase()));
}

function isWatchedSymbol(symbol) {
  return watchSymbols().has(String(symbol ?? "").toUpperCase());
}

function updateSignalWatchButtons() {
  const watched = watchSymbols();
  for (const button of document.querySelectorAll("[data-watch-symbol]")) {
    const symbol = String(button.dataset.watchSymbol ?? "").toUpperCase();
    const isWatched = watched.has(symbol);
    button.disabled = isWatched;
    button.classList.toggle("is-added", isWatched);
    button.textContent = isWatched ? "已关注" : "加关注";
    button.title = isWatched ? `${symbol} 已在关注池` : `加入关注池：${symbol}`;
    button.setAttribute("aria-pressed", isWatched ? "true" : "false");
  }
}

function watchButton(symbol, note) {
  const safeSymbol = escapeHtml(symbol);
  const watched = isWatchedSymbol(symbol);
  return `<button class="copy-symbol watch-add ${watched ? "is-added" : ""}" type="button" data-watch-symbol="${safeSymbol}" data-watch-note="${escapeHtml(note)}" title="${watched ? `${safeSymbol} 已在关注池` : `加入关注池：${safeSymbol}`}" aria-pressed="${watched ? "true" : "false"}" ${watched ? "disabled" : ""}>${watched ? "已关注" : "加关注"}</button>`;
}

function bindWatchButtons(root = document) {
  for (const button of root.querySelectorAll("[data-watch-symbol]:not([data-watch-bound])")) {
    button.dataset.watchBound = "true";
    button.addEventListener("click", async (event) => {
      event.stopPropagation();
      const symbol = button.dataset.watchSymbol ?? "";
      try {
        button.disabled = true;
        button.textContent = "加入中";
        button.classList.add("is-pending");
        if (!state.watchLoaded) await loadWatchlist({ silent: true });
        if (isWatchedSymbol(symbol)) {
          updateSignalWatchButtons();
          return;
        }
        await addWatchItem({ symbol, note: button.dataset.watchNote ?? "" });
        updateSignalWatchButtons();
      } catch {
        button.textContent = "失败";
        setTimeout(updateSignalWatchButtons, 1200);
      } finally {
        button.classList.remove("is-pending");
      }
    });
  }
}

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

function hasCurrentHotRankData() {
  return Boolean(state.hotRankFetchedAt && state.hotRankLoadedChain === state.hotRankChain);
}

function hotRankTotalPages() {
  return Math.ceil(state.hotRankTotal / state.hotRankPageSize) || 1;
}

function clampHotRankPage() {
  state.hotRankPage = clamp(state.hotRankPage, 1, hotRankTotalPages());
}

function renderHotRank() {
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

function updateFundingControls() {
  const refreshButton = $("#refreshFundingBtn");
  const scanButton = $("#scanFundingBtn");
  if (refreshButton) {
    refreshButton.disabled = state.fundingLoading || state.fundingScanning;
    refreshButton.textContent = state.fundingLoading ? "读取中" : "刷新资金费率";
  }
  if (scanButton) {
    scanButton.disabled = state.fundingLoading || state.fundingScanning;
    scanButton.textContent = state.fundingScanning ? "扫描中" : "立即扫描";
  }
}

function fundingStatusText() {
  const positiveCount = state.fundingTokens.filter((token) => Number(token.currentFundingRate) > 0).length;
  const negativeCount = state.fundingTokens.filter((token) => Number(token.currentFundingRate) < 0).length;
  const neutralCount = state.fundingTokens.length - positiveCount - negativeCount;
  const parts = [`当前共 ${state.fundingTokens.length} 个资金费率代币`];
  if (positiveCount || negativeCount || neutralCount) {
    parts.push(`正费率 ${positiveCount} / 负费率 ${negativeCount} / 持平或未知 ${neutralCount}`);
  }
  parts.push("按最近变化时间排序");
  return parts.join("，");
}

async function loadFundingRateTokens({ silent = false } = {}) {
  const requestId = state.fundingRequestId + 1;
  state.fundingRequestId = requestId;
  state.fundingLoading = true;
  state.fundingError = "";
  updateFundingControls();
  if (!silent) setText("#fundingStatus", "正在读取资金费率列表...");
  try {
    const payload = await api("/api/funding-rate-tokens");
    if (requestId !== state.fundingRequestId) return false;
    state.fundingTokens = payload.tokens || [];
    if (Number(payload.watchlistAdded ?? 0) > 0) {
      void loadWatchlist({ silent: true });
    }
    return true;
  } catch (error) {
    if (requestId !== state.fundingRequestId) return false;
    state.fundingError = error instanceof Error ? error.message : String(error);
    console.error("load funding rate tokens failed", error);
    return false;
  } finally {
    if (requestId !== state.fundingRequestId) return;
    state.fundingLoading = false;
    updateFundingControls();
    renderFundingRateTokens();
  }
}

function renderFundingRateTokens() {
  const target = $("#fundingRateRows");
  if (!target) return;
  updateFundingControls();

  if (state.fundingError && !state.fundingTokens.length) {
    target.innerHTML = `<div class="heat-empty">资金费率读取失败：${escapeHtml(state.fundingError)}</div>`;
    setText("#fundingStatus", "资金费率读取失败");
    return;
  }

  if (state.fundingLoading && !state.fundingTokens.length) {
    target.innerHTML = '<div class="heat-empty">正在读取资金费率列表...</div>';
    return;
  }

  if (!state.fundingTokens.length) {
    target.innerHTML = '<div class="heat-empty">当前没有资金费率代币。</div>';
    setText("#fundingStatus", "当前没有资金费率代币");
    return;
  }

  target.innerHTML = state.fundingTokens
    .map((token) => {
      const matches = [
        token.hotRank ? "热度" : null,
        Number(token.multiCycleCount ?? 0) >= 3
          ? `多周期 ${token.multiCycleCount}`
          : Number(token.multiCycleCount ?? 0) > 0
            ? `均线 ${token.multiCycleCount} 周期`
            : null,
        token.oiSpike
          ? `OI ${oiChangeSummary(token) || "暂无可用变化率"}`
          : null
      ].filter(Boolean);
      const expanded = state.fundingExpandedSymbol === token.symbol;
      const rateTone = fundingRateTone(token.currentFundingRate);
      return `
        <article class="funding-card">
          <div class="funding-symbol">
            <button class="market-symbol-button" type="button" data-market-chart="funding" data-market-symbol="${escapeHtml(token.symbol)}" aria-expanded="${expanded}">${escapeHtml(token.symbol)}</button>
          </div>
          <div><span>现价</span><b class="mono" data-market-price="${escapeHtml(token.symbol)}">${formatNumber(token.currentPrice)}</b></div>
          <div><span>关联信号</span><b>${escapeHtml(matches.join(" + ") || "暂无")}</b></div>
          <div><span>均线周期</span><b>${escapeHtml((token.intervals ?? []).join(" / ") || "--")}</b></div>
          <div><span>当前资金费率</span><b class="mono funding-rate ${rateTone}">${formatFundingPercent(token.currentFundingRate)}</b></div>
          <div><span>最近变化</span><b>${formatTime(token.lastChangedAt || token.lastSeenAt)}</b></div>
          <div class="heat-links">
            ${copyButton(token.symbol)}
            ${watchButton(token.symbol, "从资金费率监控加入")}
            ${searchButtons(token.symbol)}
          </div>
        </article>
        ${expanded ? marketChartPanel(token.symbol, state.fundingInterval, "funding") : ""}
      `;
    })
    .join("");
  bindWatchButtons(target);
  bindCopyButtons(target);
  bindMarketChartControls(target, "funding");
  setText("#fundingStatus", state.fundingError ? `列表为上次成功结果，最新读取失败：${state.fundingError}` : fundingStatusText());
}

async function scanFundingIntervals() {
  state.fundingScanning = true;
  state.fundingError = "";
  updateFundingControls();
  setText("#fundingStatus", "正在触发资金费率扫描...");
  try {
    const result = await api("/api/funding-interval/check", { method: "POST" });
    const refreshed = await loadFundingRateTokens({ silent: true });
    if (!refreshed) return;
    if (state.fundingError) {
      setText("#fundingStatus", `扫描已返回，但列表刷新失败：${state.fundingError}`);
      return;
    }
    const suffix = result?.skipped
      ? `扫描跳过：${result.reason || "未知原因"}`
      : `扫描完成，调整周期 ${Number(result?.seenCount ?? 0)} 个，回写默认周期 ${Number(result?.missingCount ?? 0)} 个，待提醒 ${Number(result?.pendingCount ?? 0)} 个`;
    setText("#fundingStatus", `${fundingStatusText()}，${suffix}`);
  } catch (error) {
    state.fundingError = error instanceof Error ? error.message : String(error);
    setText("#fundingStatus", `资金费率扫描失败：${state.fundingError}`);
  } finally {
    state.fundingScanning = false;
    updateFundingControls();
  }
}

async function loadIOMonitoring() {
  const requestId = state.ioRequestId + 1;
  state.ioRequestId = requestId;
  state.ioLoading = true;
  state.ioError = "";
  renderIOMonitoring();
  try {
    const params = new URLSearchParams({
      timeWindow: state.ioWindow,
      sort: state.ioSort,
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
  updateWatchRealtime();
}

function renderIOMonitoring() {
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
      const changeClass = Number.isFinite(change) ? (change >= 0 ? "up" : "down") : "";
      const expanded = state.ioExpandedSymbol === item.symbol;
      return `
        <article class="io-card">
          <div class="io-symbol"><button class="market-symbol-button" type="button" data-market-chart="io" data-market-symbol="${escapeHtml(item.symbol)}" aria-expanded="${expanded}">${escapeHtml(item.symbol)}</button><span>${escapeHtml(state.ioWindow)}</span></div>
          <div><span>现价</span><b class="mono" data-market-price="${escapeHtml(item.symbol)}">${formatNumber(item.currentPrice)}</b></div>
          <div><span>变化</span><b class="${changeClass}">${formatPercent(item.changePercent)}</b></div>
          <div><span>当前持仓量</span><b class="mono">${formatCompactNumber(item.currentOpenInterest)}</b></div>
          <div><span>持仓价值</span><b class="mono">${formatCompactUsd(item.currentOpenInterestValue)}</b></div>
          <div><span>同币种命中</span><b>${escapeHtml(matches.join(" + ") || "暂无")}</b></div>
          <div class="io-observed"><span>样本时间</span><b data-oi-observed="${escapeHtml(item.observedAt)}" data-oi-stale="${item.isStale ? "true" : "false"}" title="币安OI样本：${escapeHtml(formatTime(item.observedAt))}${item.fetchedAt ? `；本系统抓取：${escapeHtml(formatTime(item.fetchedAt))}` : ""}${item.isStale ? `；数据已过期，年龄约 ${Math.round(Number(item.observedAgeSeconds ?? 0) / 60)} 分钟` : ""}">${formatAge(item.observedAt)}${item.isStale ? " · 过期" : ""}</b><small>${formatCompactTime(item.observedAt)}</small></div>
          <div class="heat-links">
            ${copyButton(item.symbol)}
            ${watchButton(item.symbol, "从 OI 监控加入")}
            ${searchButtons(item.symbol)}
          </div>
        </article>
        ${expanded ? marketChartPanel(item.symbol, state.ioChartInterval, "io") : ""}
      `;
    })
    .join("");
  bindWatchButtons(target);
  bindCopyButtons(target);
  bindMarketChartControls(target, "io");
  const statusParts = [
    `${state.ioWindow} 变化率`,
    state.ioSort === "desc" ? "从高到低" : "从低到高",
    `${state.ioTotal} 个代币`
  ];
  if (state.ioMonitor?.running) statusParts.push("扫描中");
  if (Number(state.ioMonitor?.scannedCount ?? 0) > 0) {
    statusParts.push(`本轮已扫 ${state.ioMonitor.scannedCount}/${state.ioMonitor.totalTokenCount ?? "--"}`);
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

function updateOiAgeLabels() {
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

async function loadTradeAnalysis({ refresh = true, advanceWindow = refresh } = {}) {
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

function renderTradeAnalysis() {
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

function tradeAnalysisRows() {
  return state.tradeAnalysis?.tradeRows?.items ?? state.tradeAnalysis?.summary?.bySymbol ?? [];
}

function tradeSymbolRowKey(row = {}) {
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

function setTradeCodexScope(scope) {
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

async function runTradeCodexAnalysis() {
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
    target.innerHTML = '<tr><td colspan="11" class="empty">正在读取当前持仓。</td></tr>';
    return;
  }
  if (!positions.length) {
    target.innerHTML = '<tr><td colspan="11" class="empty">当前接口返回没有未平仓持仓。若你确定有仓位，请确认钱包地址和 Binance API 只读权限。</td></tr>';
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
      <td>${position.leverage ? `${formatNumber(position.leverage, 2)}x` : "--"}</td>
      <td>${formatNumber(position.liquidationPrice, 6)}</td>
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

function sortTradeSymbolRowsByTime(rows = []) {
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

configureTradeJournal({
  loadTradeAnalysis,
  tradeAnalysisRows,
  sortTradeSymbolRowsByTime,
  tradeSymbolRowKey
});

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

function setTradeWindow(value) {
  const windowOption = normalizeTradeWindow(value);
  if (!windowOption) return;
  state.tradeWindowKey = windowOption.key;
  applyTradeWindowInputs(windowOption);
  updateTradeWindowButtons(windowOption.key);
  state.tradeSymbolPage = 1;
  loadTradeAnalysis();
}

async function loadHotRank({ silent = false } = {}) {
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

function clampPage(totalPages) {
  state.page = clamp(state.page, 1, Math.max(1, totalPages));
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

function renderSignals() {
  const target = $("#signalRows");
  if (!target) return;
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
              ${watchButton(row.symbol, "从均线信号加入")}
              ${searchButtons(row.symbol)}
            </div>
          </td>
          <td>${escapeHtml(row.categoryLabel)}</td>
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
          <td>${formatTime(selectedDetail.signalTime || selectedDetail.updatedAt)}</td>
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
  updateWatchRealtime();
}

async function copyText(text) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }
  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  document.body.appendChild(textarea);
  textarea.select();
  document.execCommand("copy");
  textarea.remove();
}

configureKlineChart({ copyText, signalProfile });

function bindRowClicks() {
  bindCopyButtons();

  bindWatchButtons();

  for (const link of document.querySelectorAll(".signal-row .mini-link")) {
    link.addEventListener("click", (event) => event.stopPropagation());
  }

  for (const row of document.querySelectorAll(".signal-row")) {
    row.addEventListener("click", () => toggleRow(row.dataset.key));
  }
}

function bindCopyButtons(root = document) {
  for (const button of root.querySelectorAll("[data-symbol]:not([data-copy-bound])")) {
    button.dataset.copyBound = "true";
    button.addEventListener("click", async (event) => {
      event.stopPropagation();
      const symbol = button.dataset.symbol ?? "";
      try {
        await copyText(symbol);
        button.textContent = "已复制";
        setTimeout(() => {
          button.textContent = "复制";
        }, 1200);
      } catch {
        button.textContent = "复制失败";
      }
    });
  }
}

configureTriggerHistory({ copyButton, bindCopyButtons });

function renderWatchlist() {
  const target = $("#watchRows");
  if (!target) return;
  updateWatchStatus();
  if (state.watchLoading) {
    target.innerHTML = '<div class="heat-empty">正在读取关注池。</div>';
    return;
  }
  if (state.watchError) {
    target.innerHTML = `<div class="heat-empty">${escapeHtml(state.watchError)}</div>`;
    return;
  }
  if (!state.watchlist.length) {
    target.innerHTML = '<div class="heat-empty">暂无关注代币。</div>';
    return;
  }
  target.innerHTML = state.watchlist.map((item) => {
    const expanded = state.watchExpandedSymbol === item.symbol;
    const alertText = item.alertEnabled ? "已开启" : "已关闭";
    const safeSymbol = escapeHtml(item.symbol);
    const unlockLabel = watchUnlockLabel(item);
    const unlockTitle = watchUnlockTitle(item);
    const detail = expanded ? `
      <article class="watch-detail">
        <form class="watch-settings" data-watch-settings="${safeSymbol}">
          <label>
            <span>提醒开关</span>
            <input name="alertEnabled" type="checkbox" ${item.alertEnabled ? "checked" : ""} />
          </label>
          <label>
            <span>高于提醒</span>
            <input name="alertAbove" type="number" step="any" value="${escapeHtml(item.alertAbove ?? "")}" placeholder="价格上穿" />
          </label>
          <label>
            <span>低于提醒</span>
            <input name="alertBelow" type="number" step="any" value="${escapeHtml(item.alertBelow ?? "")}" placeholder="价格下破" />
          </label>
          <label>
            <span>备注</span>
            <input name="note" type="text" value="${escapeHtml(item.note ?? "")}" placeholder="等待确认、突破回踩..." autocomplete="off" />
          </label>
          <button class="ghost-button primary" type="submit">保存警报</button>
        </form>
        <div class="watch-chart-head">
          <div class="chart-tools">
            ${ALL_INTERVALS.map((interval) => `<button class="${state.watchInterval === interval ? "active" : ""}" type="button" data-watch-interval="${escapeHtml(interval)}" aria-pressed="${state.watchInterval === interval ? "true" : "false"}">${escapeHtml(interval)}</button>`).join("")}
          </div>
          <span data-watch-updated="${safeSymbol}">最新更新时间：${formatTime(item.currentCloseTime)}</span>
        </div>
        <div class="chart-shell" id="${chartElementId(`${item.symbol}|${state.watchInterval}`)}">
          <div class="chart-loading">正在读取 ${safeSymbol} ${escapeHtml(state.watchInterval)} K线...</div>
        </div>
      </article>
    ` : "";
    return `
      <article class="watch-row ${expanded ? "is-expanded" : ""}">
        <div>
          <button class="watch-symbol-button" type="button" data-edit-watch="${safeSymbol}" aria-expanded="${expanded ? "true" : "false"}">
            <strong>${safeSymbol}</strong>
            <span title="${escapeHtml(item.note || "")}">${escapeHtml(item.categoryLabel || item.baseAsset || "--")}${item.note ? ` · ${escapeHtml(item.note)}` : ""}</span>
          </button>
        </div>
        <div><span>现价</span><div class="mono" data-watch-price="${safeSymbol}">${formatNumber(item.currentPrice)}</div></div>
        <div><span>最新周期</span><div class="mono">${escapeHtml(item.latestInterval || "--")}</div></div>
        <div><span>高于提醒</span><div class="mono">${formatNumber(item.alertAbove)}</div></div>
        <div><span>低于提醒</span><div class="mono">${formatNumber(item.alertBelow)}</div></div>
        <div class="watch-unlock">
          <span>下次解锁</span>
          <div title="${escapeHtml(unlockTitle)}">
            ${
              item.unlockSourceUrl
                ? `<a class="unlock-value" href="${escapeHtml(item.unlockSourceUrl)}" target="_blank" rel="noreferrer">${escapeHtml(unlockLabel)}</a>`
                : `<span class="unlock-value">${escapeHtml(unlockLabel)}</span>`
            }
          </div>
        </div>
        <div><span>警报</span><div>${escapeHtml(alertText)}</div></div>
        <div class="watch-actions">
          ${searchButtons(item.symbol)}
          ${copyButton(item.symbol)}
          <button class="copy-symbol" type="button" data-remove-watch="${safeSymbol}">移除</button>
        </div>
      </article>
      ${detail}
    `;
  }).join("");

  for (const button of target.querySelectorAll("[data-edit-watch]")) {
    button.addEventListener("click", () => {
      const symbol = button.dataset.editWatch ?? "";
      state.watchExpandedSymbol = state.watchExpandedSymbol === symbol ? null : symbol;
      renderWatchlist();
    });
  }

  for (const button of target.querySelectorAll("[data-watch-interval]")) {
    button.addEventListener("click", () => {
      state.watchInterval = button.dataset.watchInterval ?? "15m";
      renderWatchlist();
    });
  }

  for (const form of target.querySelectorAll("[data-watch-settings]")) {
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      const data = new FormData(form);
      const submit = form.querySelector('button[type="submit"]');
      const originalText = submit?.textContent ?? "保存警报";
      try {
        if (submit) {
          submit.disabled = true;
          submit.textContent = "保存中";
        }
        await addWatchItem({
          symbol: form.dataset.watchSettings,
          note: data.get("note") ?? "",
          alertAbove: data.get("alertAbove") ?? "",
          alertBelow: data.get("alertBelow") ?? "",
          alertEnabled: data.get("alertEnabled") === "on"
        });
      } catch (error) {
        console.error("watchlist save failed", error);
        if (submit) {
          submit.disabled = false;
          submit.textContent = watchOperationError("保存", error);
          setTimeout(() => {
            submit.textContent = originalText;
          }, 1800);
        }
      }
    });
  }

  for (const button of target.querySelectorAll("[data-remove-watch]")) {
    button.addEventListener("click", async () => {
      const originalText = button.textContent;
      try {
        button.disabled = true;
        button.textContent = "移除中";
        await api(`/api/watchlist/${encodeURIComponent(button.dataset.removeWatch)}`, { method: "DELETE" });
        if (state.watchExpandedSymbol === button.dataset.removeWatch) state.watchExpandedSymbol = null;
        await loadWatchlist();
      } catch (error) {
        console.error("watchlist remove failed", error);
        button.disabled = false;
        button.textContent = "移除失败";
        setTimeout(() => {
          button.textContent = originalText;
        }, 1800);
      }
    });
  }
  bindCopyButtons(target);

  const expandedItem = state.watchlist.find((item) => item.symbol === state.watchExpandedSymbol);
  if (expandedItem) {
    loadAndRenderChart({ symbol: expandedItem.symbol, intervalCode: state.watchInterval }, { live: true });
  }
  updateWatchStatus();
  updateWatchRealtime();
}

function watchlistRenderSignature(items) {
  return (items ?? [])
    .map((item) =>
      [
        item.symbol,
        item.note ?? "",
        item.alertAbove ?? "",
        item.alertBelow ?? "",
        item.alertEnabled ? "1" : "0",
        item.categoryLabel ?? "",
        item.latestInterval ?? "",
        item.nextUnlockAt ?? "",
        item.unlockStatus ?? "",
        item.unlockSourceUrl ?? "",
        item.unlockError ?? "",
        item.unlockCheckedAt ?? "",
        item.unlockPercent ?? "",
        item.unlockAmount ?? ""
      ].join(":")
    )
    .join("|");
}

function mergeWatchlistItems(items) {
  const existingBySymbol = new Map(state.watchlist.map((item) => [item.symbol, item]));
  return (items ?? []).map((item) => {
    const existing = existingBySymbol.get(item.symbol);
    if (!existing) return item;
    const existingTime = Number(existing.currentCloseTime ?? existing.realtimePriceTime ?? 0);
    const nextTime = Number(item.currentCloseTime ?? item.realtimePriceTime ?? 0);
    if (existingTime > nextTime) {
      return {
        ...item,
        currentPrice: existing.currentPrice,
        currentCloseTime: existing.currentCloseTime,
        realtimePrice: existing.realtimePrice ?? item.realtimePrice,
        realtimePriceTime: existing.realtimePriceTime ?? item.realtimePriceTime
      };
    }
    return item;
  });
}

function updateWatchlistDomFromState() {
  for (const item of state.watchlist) {
    updateWatchPriceDom(item.symbol, item.currentPrice, item.currentCloseTime);
  }
  updateWatchStatus();
}

async function loadWatchlist({ silent = false } = {}) {
  if (state.watchLoadPromise) {
    const items = await state.watchLoadPromise;
    if (!silent) renderWatchlist();
    else updateWatchlistDomFromState();
    return items;
  }
  state.watchLoading = true;
  if (!silent) renderWatchlist();
  state.watchLoadPromise = (async () => {
    let shouldRender = false;
    const previousItems = state.watchlist;
    const hadLoadedItems = state.watchLoaded && previousItems.length > 0;
    try {
      state.watchError = "";
      const payload = await api("/api/watchlist");
      const nextItems = mergeWatchlistItems(payload.items ?? []);
      const nextSignature = watchlistRenderSignature(nextItems);
      shouldRender = !silent || !state.watchLoaded || nextSignature !== state.watchlistRenderSignature;
      state.watchlist = nextItems;
      state.watchlistRenderSignature = nextSignature;
      state.watchLoaded = true;
    } catch (error) {
      const preserveStaleList = silent && hadLoadedItems;
      state.watchError = preserveStaleList ? "" : watchOperationError("关注池读取", error);
      if (!preserveStaleList) {
        state.watchlist = [];
        state.watchlistRenderSignature = "";
        state.watchLoaded = false;
      }
      shouldRender = !silent || !preserveStaleList;
      console.warn("watchlist load failed", error);
    } finally {
      state.watchLoading = false;
      state.watchLoadPromise = null;
      if (shouldRender) renderWatchlist();
      else updateWatchlistDomFromState();
      updateSignalWatchButtons();
      updateWatchRealtime();
    }
    return state.watchlist;
  })();
  return state.watchLoadPromise;
}

async function addWatchItem({ symbol, note = "", alertAbove = "", alertBelow = "", alertEnabled = true }) {
  const payload = await api("/api/watchlist", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ symbol, note, alertAbove, alertBelow, alertEnabled })
  });
  state.watchError = "";
  state.watchlist = mergeWatchlistItems(payload.items ?? []);
  state.watchlistRenderSignature = watchlistRenderSignature(state.watchlist);
  state.watchLoaded = true;
  renderWatchlist();
  updateSignalWatchButtons();
  updateWatchRealtime();
}

function closeWatchRealtime() {
  if (state.watchRealtimeReconnectTimer) {
    clearTimeout(state.watchRealtimeReconnectTimer);
    state.watchRealtimeReconnectTimer = null;
  }
  if (state.watchRealtimeSocket) {
    state.watchRealtimeSocket.onclose = null;
    state.watchRealtimeSocket.close();
  }
  if (state.watchRealtimeSource) {
    state.watchRealtimeSource.close();
  }
  state.watchRealtimeSocket = null;
  state.watchRealtimeSource = null;
  state.watchRealtimeSignature = "";
}

function signalRealtimeIntervals(row) {
  const intervals = new Set();
  const selectedInterval = state.signalChartIntervals.get(row.symbol);
  for (const interval of [selectedInterval, row.intervalCode, ...(Array.isArray(row.intervals) ? row.intervals : [])]) {
    if (ALL_INTERVALS.includes(interval)) intervals.add(interval);
  }
  if (!intervals.size) intervals.add("15m");
  return intervals;
}

function oiRealtimeKlineInterval(timeWindow) {
  return timeWindow === "5m" ? "15m" : ALL_INTERVALS.includes(timeWindow) ? timeWindow : "15m";
}

function ioRealtimeSymbols() {
  return new Set(state.ioRealtimeRows.map((item) => String(item.symbol ?? "").toUpperCase()).filter(Boolean));
}

function watchRealtimeStreams() {
  const streams = new Set();
  if (state.currentView === "signals") {
    const signalRows = state.signalRealtimeRows.length ? state.signalRealtimeRows : state.signals;
    for (const row of signalRows) {
      const symbol = String(row.symbol ?? "").toLowerCase();
      if (!symbol) continue;
      streams.add(`${symbol}@ticker`);
      for (const interval of signalRealtimeIntervals(row)) {
        streams.add(`${symbol}@kline_${interval}`);
      }
    }
  }
  if (state.currentView === "watch") {
    for (const item of state.watchlist) {
      const symbol = String(item.symbol ?? "").toLowerCase();
      if (symbol) streams.add(`${symbol}@ticker`);
    }
    if (state.watchExpandedSymbol) {
      streams.add(`${state.watchExpandedSymbol.toLowerCase()}@kline_${state.watchInterval}`);
    }
  }
  if (state.currentView === "funding") {
    const interval = ALL_INTERVALS.includes(state.fundingInterval) ? state.fundingInterval : "15m";
    for (const token of state.fundingTokens) {
      const symbol = String(token.symbol ?? "").toLowerCase();
      if (!symbol) continue;
      streams.add(`${symbol}@ticker`);
      streams.add(`${symbol}@kline_${interval}`);
    }
  }
  if (state.currentView === "io") {
    for (const item of state.ioRealtimeRows) {
      const symbol = String(item.symbol ?? "").toLowerCase();
      if (!symbol) continue;
      streams.add(`${symbol}@ticker`);
      streams.add(`${symbol}@kline_${oiRealtimeKlineInterval(item.realtimeWindow)}`);
    }
  }
  const expandedCharts = [
    state.currentView === "signals" && state.expandedKey
      ? state.signals.find((row) => rowKey(row) === state.expandedKey)?.symbol
      : null,
    state.currentView === "funding" ? state.fundingExpandedSymbol : null,
    state.currentView === "io" && ioRealtimeSymbols().has(String(state.ioExpandedSymbol ?? "").toUpperCase())
      ? state.ioExpandedSymbol
      : null
  ].filter(Boolean);
  for (const symbol of expandedCharts) {
    const interval =
      state.currentView === "signals"
        ? state.signalChartIntervals.get(symbol) ?? "15m"
        : state.currentView === "funding"
          ? state.fundingInterval
          : state.ioChartInterval;
    streams.add(`${String(symbol).toLowerCase()}@ticker`);
    streams.add(`${String(symbol).toLowerCase()}@kline_${interval}`);
  }
  return Array.from(streams).sort();
}

function shouldUseServerRealtimeEvents() {
  return state.currentView === "watch";
}

function updateWatchPriceDom(symbol, price, eventTime = Date.now()) {
  const safeSymbol = String(symbol ?? "").toUpperCase();
  const item = state.watchlist.find((entry) => entry.symbol === safeSymbol);
  if (item) {
    item.currentPrice = price;
    item.currentCloseTime = eventTime;
  }
  const selectorSymbol = cssEscape(safeSymbol);
  for (const element of document.querySelectorAll(`[data-watch-price="${selectorSymbol}"]`)) {
    element.textContent = formatNumber(price);
  }
  for (const element of document.querySelectorAll(`[data-watch-updated="${selectorSymbol}"]`)) {
    element.textContent = `最新更新时间：${formatTime(eventTime)}`;
  }
  updateWatchStatus();
}

function updateSignalPriceDom(symbol, price, eventTime = Date.now()) {
  const safeSymbol = String(symbol ?? "").toUpperCase();
  const numericPrice = Number(price);
  if (!safeSymbol || !Number.isFinite(numericPrice)) return;
  for (const row of state.signals) {
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

function updateMarketPriceDom(symbol, price, eventTime = Date.now()) {
  const safeSymbol = String(symbol ?? "").toUpperCase();
  if (!safeSymbol || !Number.isFinite(Number(price))) return;
  for (const item of [...state.fundingTokens, ...state.ioData]) {
    if (String(item.symbol ?? "").toUpperCase() === safeSymbol) {
      item.currentPrice = price;
      item.currentCloseTime = eventTime;
    }
  }
  const selectorSymbol = cssEscape(safeSymbol);
  for (const element of document.querySelectorAll(`[data-market-price="${selectorSymbol}"]`)) {
    element.textContent = formatNumber(price);
    element.title = `最新更新时间：${formatTime(eventTime)}`;
  }
}

function averageRecent(values, size) {
  if (values.length < size) return null;
  const slice = values.slice(-size);
  return slice.reduce((sum, value) => sum + value, 0) / size;
}

function updateChartKline(symbol, interval, kline) {
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

function handleWatchRealtimeMessage(payload) {
  if (payload?.type === "price") {
    const symbol = String(payload.symbol ?? "").toUpperCase();
    const price = Number(payload.price);
    if (symbol && Number.isFinite(price)) {
      const eventTime = Number(payload.eventTime ?? Date.now());
      updateWatchPriceDom(symbol, price, eventTime);
      updateSignalPriceDom(symbol, price, eventTime);
      updateMarketPriceDom(symbol, price, eventTime);
    }
    return;
  }
  if (payload?.type === "kline" && payload.kline) {
    const symbol = String(payload.symbol ?? "").toUpperCase();
    const interval = String(payload.interval ?? payload.kline.i ?? "");
    const price = Number(payload.kline.c);
    const eventTime = Number(payload.eventTime ?? Date.now());
    if (symbol && Number.isFinite(price)) {
      updateWatchPriceDom(symbol, price, eventTime);
      updateSignalPriceDom(symbol, price, eventTime);
      updateMarketPriceDom(symbol, price, eventTime);
    }
    updateChartKline(symbol, interval, payload.kline);
    return;
  }
  const stream = String(payload?.stream ?? "");
  const data = payload?.data ?? payload;
  if (stream.endsWith("@ticker") || data?.e === "24hrTicker") {
    const symbol = String(data.s ?? "").toUpperCase();
    const price = Number(data.c);
    if (symbol && Number.isFinite(price)) {
      const eventTime = Number(data.E ?? Date.now());
      updateWatchPriceDom(symbol, price, eventTime);
      updateSignalPriceDom(symbol, price, eventTime);
      updateMarketPriceDom(symbol, price, eventTime);
    }
    return;
  }
  if (data?.e === "kline" && data.k) {
    const symbol = String(data.s ?? "").toUpperCase();
    const interval = String(data.k.i ?? "");
    const price = Number(data.k.c);
    const eventTime = Number(data.E ?? Date.now());
    if (symbol && Number.isFinite(price)) {
      updateWatchPriceDom(symbol, price, eventTime);
      updateSignalPriceDom(symbol, price, eventTime);
      updateMarketPriceDom(symbol, price, eventTime);
    }
    updateChartKline(symbol, interval, data.k);
  }
}

function updateWatchRealtime() {
  const streams = watchRealtimeStreams();
  if (!streams.length) {
    closeWatchRealtime();
    return;
  }
  if ("EventSource" in window && shouldUseServerRealtimeEvents()) {
    const signature = "sse:watch-realtime";
    if (state.watchRealtimeSource && state.watchRealtimeSignature === signature) return;
    closeWatchRealtime();
    state.watchRealtimeSignature = signature;
    const source = new EventSource("/api/watchlist/events");
    state.watchRealtimeSource = source;
    source.addEventListener("ready", () => {});
    source.addEventListener("ping", () => {});
    source.onmessage = (event) => {
      try {
        handleWatchRealtimeMessage(JSON.parse(event.data));
      } catch (error) {
        console.warn("watch realtime event failed", error);
      }
    };
    source.onerror = () => {
      if (!watchRealtimeStreams().length) return;
      source.close();
      state.watchRealtimeSource = null;
      state.watchRealtimeReconnectTimer = setTimeout(updateWatchRealtime, 3000);
    };
    return;
  }
  const signature = `ws:${streams.join("/")}`;
  if (state.watchRealtimeSocket && state.watchRealtimeSignature === signature) return;
  closeWatchRealtime();
  state.watchRealtimeSignature = signature;
  const fallbackSignature = streams.join("/");
  const url = `wss://fstream.binance.com/market/stream?streams=${fallbackSignature}`;
  const socket = new WebSocket(url);
  state.watchRealtimeSocket = socket;
  socket.onmessage = (event) => {
    try {
      handleWatchRealtimeMessage(JSON.parse(event.data));
    } catch (error) {
      console.warn("watch realtime message failed", error);
    }
  };
  socket.onclose = () => {
    if (!watchRealtimeStreams().length) return;
    state.watchRealtimeReconnectTimer = setTimeout(() => {
      state.watchRealtimeSocket = null;
      updateWatchRealtime();
    }, 3000);
  };
  socket.onerror = () => {
    socket.close();
  };
}

function pageFromHash() {
  if (window.location.hash === "#heatPage") return "heat";
  if (window.location.hash === "#watchPage") return "watch";
  if (window.location.hash === "#fundingPage") return "funding";
  if (window.location.hash === "#ioPage") return "io";
  if (window.location.hash === "#triggerHistoryPage") return "trigger-history";
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
  if (page === "trigger-history") loadTriggerHistory();
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

function toggleRow(key) {
  state.expandedKey = state.expandedKey === key ? null : key;
  renderSignals();
}

async function loadSignalsPage() {
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

async function loadSignalRealtimeRows() {
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
  updateWatchRealtime();
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

function updateFilterControls() {
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

for (const input of document.querySelectorAll(".filter-menu input[data-filter]")) {
  input.addEventListener("change", () => setFilter(input.dataset.filter, input.dataset.value, input.checked));
}

for (const button of document.querySelectorAll("[data-size]")) {
  button.addEventListener("click", () => {
    state.pageSize = Number(button.dataset.size);
    state.page = 1;
    document.querySelectorAll("[data-size]").forEach((item) => item.classList.toggle("active", item === button));
    refreshAll({ keepPage: true });
  });
}

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

document.querySelectorAll("[data-trigger-filter]").forEach((input) => {
  input.addEventListener("change", () => {
    if (input.checked) state.triggerTypes.add(input.dataset.value);
    else state.triggerTypes.delete(input.dataset.value);
    state.triggerHistoryPage = 1;
    state.selectedTriggerIds.clear();
    loadTriggerHistory();
  });
});

$("#selectAllTrigger")?.addEventListener("change", (event) => {
  const checked = event.currentTarget.checked;
  state.triggerHistory.forEach((item) => {
    if (checked) state.selectedTriggerIds.add(item.id);
    else state.selectedTriggerIds.delete(item.id);
  });
  renderTriggerHistory();
});

$("#deleteSelectedTriggerBtn")?.addEventListener("click", async () => {
  const ids = Array.from(state.selectedTriggerIds);
  if (!ids.length) return;
  await api("/api/trigger-history", {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ids })
  });
  state.selectedTriggerIds.clear();
  await loadTriggerHistory();
});

$("#refreshFundingBtn")?.addEventListener("click", () => loadFundingRateTokens());
$("#scanFundingBtn")?.addEventListener("click", () => scanFundingIntervals());
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
$("#refreshTriggerHistoryBtn")?.addEventListener("click", () => loadTriggerHistory());
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
$("#clearTriggerHistoryBtn")?.addEventListener("click", async () => {
  if (!confirm("确定要清空所有历史记录吗？")) return;
  try {
    await api("/api/trigger-history", { method: "DELETE" });
    state.triggerHistory = [];
    state.triggerHistoryTotal = 0;
    state.triggerHistoryPage = 1;
    state.selectedTriggerIds.clear();
    renderTriggerHistory();
  } catch (error) {
    console.error("clear trigger history failed", error);
  }
});

document.addEventListener("click", async (e) => {
  const deleteBtn = e.target.closest("[data-delete-trigger]");
  if (deleteBtn) {
    const id = deleteBtn.dataset.deleteTrigger;
    try {
      await api(`/api/trigger-history/${id}`, { method: "DELETE" });
      state.selectedTriggerIds.delete(Number(id));
      await loadTriggerHistory();
    } catch (error) {
      console.error("delete trigger history failed", error);
    }
  }
});

document.querySelectorAll("[data-trigger-pagesize]").forEach((btn) => {
  btn.addEventListener("click", () => {
    state.triggerHistoryPageSize = Number(btn.dataset.triggerPagesize);
    state.triggerHistoryPage = 1;
    document.querySelectorAll("[data-trigger-pagesize]").forEach((item) => item.classList.toggle("active", item === btn));
    loadTriggerHistory();
  });
});

$("#prevTriggerPageBtn")?.addEventListener("click", () => {
  if (state.triggerHistoryPage > 1) {
    state.triggerHistoryPage -= 1;
    loadTriggerHistory();
  }
});

$("#nextTriggerPageBtn")?.addEventListener("click", () => {
  const totalPages = Math.ceil(state.triggerHistoryTotal / state.triggerHistoryPageSize) || 1;
  if (state.triggerHistoryPage < totalPages) {
    state.triggerHistoryPage += 1;
    loadTriggerHistory();
  }
});

$("#refreshHotRankBtn")?.addEventListener("click", () => loadHotRank());
$("#refreshWatchBtn")?.addEventListener("click", async () => {
  const button = $("#refreshWatchBtn");
  if (button) {
    button.disabled = true;
    button.textContent = "刷新中";
  }
  try {
    await loadWatchlist();
  } finally {
    if (button) {
      button.disabled = false;
      button.textContent = "刷新关注池";
    }
  }
});
$("#refreshUnlockBtn")?.addEventListener("click", async () => {
  const button = $("#refreshUnlockBtn");
  if (button) {
    button.disabled = true;
    button.textContent = "查询中";
  }
  let failed = false;
  try {
    await api("/api/watchlist/unlock/refresh", { method: "POST" });
    await loadWatchlist();
  } catch (error) {
    failed = true;
    console.error("watchlist unlock refresh failed", error);
    if (button) {
      button.textContent = "刷新失败";
      setTimeout(() => {
        if (!button.disabled) button.textContent = "刷新解锁日期";
      }, 1800);
    }
  } finally {
    if (button) {
      button.disabled = false;
      if (!failed) button.textContent = "刷新解锁日期";
    }
  }
});

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
    "trigger-history": "#triggerHistoryPage",
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
scheduleVisiblePoll("signals refresh", 60 * 1000, () => {
  if (state.currentView === "signals") return refreshAll({ keepPage: true });
  return null;
});
scheduleVisiblePoll("oi monitoring refresh", 3 * 60 * 1000, () => {
  if (state.currentView === "io") return loadIOMonitoring();
  return null;
});
scheduleVisiblePoll("oi age labels", 30 * 1000, updateOiAgeLabels);
