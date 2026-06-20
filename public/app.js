const ALL_CATEGORIES = ["A", "B"];
const ALL_LEVELS = ["LEVEL1", "LEVEL2", "NONE", "INSUFFICIENT"];
const ALL_INTERVALS = ["15m", "1h", "4h", "1d"];

const LABELS = {
  category: { A: "A类", B: "B类" },
  level: { LEVEL1: "一级", LEVEL2: "二级", NONE: "观察", INSUFFICIENT: "样本不足" },
  interval: { "15m": "15m", "1h": "1h", "4h": "4h", "1d": "1d" }
};

const SIGNAL_PROFILE_COLORS = {
  MA: { text: "#7a2148", border: "#f3b5cf", bg: "#fff0f6" },
  1: { text: "#6842ad", border: "#cbbbf2", bg: "#f7f2ff" },
  2: { text: "#8a5405", border: "#f1c27a", bg: "#fff4e4" },
  3: { text: "#8c3f76", border: "#ddb1d3", bg: "#fff2fb" },
  4: { text: "#176da3", border: "#afd9f7", bg: "#eef8ff" },
  5: { text: "#335f96", border: "#b5c9ec", bg: "#eff5ff" },
  6: { text: "#26706a", border: "#acdcd6", bg: "#ecfbf8" },
  7: { text: "#4b698d", border: "#bfd1e7", bg: "#f0f6ff" },
  8: { text: "#b8185d", border: "#f0a8cb", bg: "#fff0f7" },
  9: { text: "#8c356d", border: "#e4afd2", bg: "#fff1fa" },
  10: { text: "#a64720", border: "#ecb197", bg: "#fff1eb" },
  11: { text: "#754f96", border: "#d1b6e8", bg: "#f8f1ff" },
  12: { text: "#17736f", border: "#a9ddd7", bg: "#effbf8" },
  13: { text: "#4d6b8f", border: "#bfd0e6", bg: "#f1f6ff" },
  14: { text: "#9d3c37", border: "#e5aaa7", bg: "#fff1f0" },
  15: { text: "#211721", border: "#d8ccd4", bg: "#f8f3f6" }
};

const state = {
  categories: new Set(ALL_CATEGORIES),
  levels: new Set(["LEVEL1", "LEVEL2"]),
  intervals: new Set(ALL_INTERVALS),
  signals: [],
  totalSignals: 0,
  page: 1,
  pageSize: 20,
  expandedKey: null,
  signalChartIntervals: new Map(),
  chartCache: new Map(),
  chartState: new Map(),
  currentView: "signals",
  watchlist: [],
  watchLoaded: false,
  watchLoading: false,
  watchLoadPromise: null,
  watchError: "",
  watchExpandedSymbol: null,
  watchInterval: "15m",
  hotRankChain: "all",
  hotRank: [],
  hotRankSource: "",
  hotRankLoadedChain: "",
  hotRankFetchedAt: null,
  hotRankPartial: false,
  hotRankStale: false,
  hotRankErrors: [],
  hotRankLoading: false,
  hotRankError: "",
  hotRankRequestId: 0,
  hotRankController: null,
  hotRankRefreshTimer: null,
  hotRankTwitterPending: 0,
  hotRankPage: 1,
  hotRankPageSize: 20,
  hotRankTotal: 0,
  fundingTokens: [],
  fundingExpandedSymbol: null,
  fundingInterval: "15m",
  fundingLoading: false,
  fundingError: "",
  fundingScanning: false,
  ioData: [],
  ioPage: 1,
  ioPageSize: 20,
  ioTotal: 0,
  ioLoading: false,
  ioError: "",
  ioRequestId: 0,
  ioWindow: "5m",
  ioSort: "desc",
  ioExpandedSymbol: null,
  ioChartInterval: "15m",
  triggerHistory: [],
  triggerHistoryPage: 1,
  triggerHistoryPageSize: 20,
  triggerHistoryTotal: 0,
  selectedTriggerIds: new Set(),
  triggerTypes: new Set(["MA_SIGNAL", "HOT_RANK", "FUNDING_RATE", "OI_SPIKE", "COMPOSITE"]),
  watchRealtimeSocket: null,
  watchRealtimeSource: null,
  watchRealtimeSignature: "",
  watchRealtimeReconnectTimer: null,
  watchlistRenderSignature: "",
  bootstrapped: false,
  previewMode: new URLSearchParams(window.location.search).get("preview") === "true"
};

const $ = (selector) => document.querySelector(selector);

function setText(selector, value) {
  const element = $(selector);
  if (element) element.textContent = value;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(value, max));
}

function formatNumber(value, digits = 6) {
  if (value === null || value === undefined || value === "") return "--";
  const number = Number(value);
  if (!Number.isFinite(number)) return "--";
  if (Math.abs(number) >= 1000) return number.toLocaleString("en-US", { maximumFractionDigits: 2 });
  return number.toLocaleString("en-US", { maximumFractionDigits: digits });
}

function formatCompactUsd(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return "--";
  return `$${number.toLocaleString("en-US", { notation: "compact", maximumFractionDigits: 2 })}`;
}

function formatCompactNumber(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return "--";
  return number.toLocaleString("en-US", { notation: "compact", maximumFractionDigits: 2 });
}

function formatPercent(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return "--";
  return `${number >= 0 ? "+" : ""}${number.toLocaleString("en-US", { maximumFractionDigits: 2 })}%`;
}

function formatFundingPercent(value) {
  const number = Number(value);
  if (value === null || value === undefined || !Number.isFinite(number)) return "--";
  return `${number > 0 ? "+" : ""}${(number * 100).toFixed(4)}%`;
}

function fundingRateTone(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number === 0) return "is-neutral";
  return number > 0 ? "is-positive" : "is-negative";
}

function cssVar(name, fallback) {
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return value || fallback;
}

function chartPalette() {
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

function formatTime(value) {
  if (!value) return "--";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "--";
  return date.toLocaleString("zh-CN", { hour12: false });
}

function cssEscape(value) {
  const text = String(value ?? "");
  return window.CSS?.escape ? CSS.escape(text) : text.replace(/["\\]/g, "\\$&");
}

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

function levelBadge(level) {
  if (level === "LEVEL1") return '<span class="level-badge level1">一级警报</span>';
  if (level === "LEVEL2") return '<span class="level-badge level2">二级预警</span>';
  if (level === "INSUFFICIENT") return '<span class="level-badge">样本不足</span>';
  return '<span class="level-badge none">观察中</span>';
}

function rowKey(row) {
  return String(row.symbol ?? "");
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
  if (!alertLevel) return { label: "观察", priority: 99, classes: "", color: signalProfileColor(0) };
  const sourceMask = (funding ? 8 : 0) + (oi ? 4 : 0) + (hot ? 2 : 0) + (multi ? 1 : 0);
  const sources = [
    funding ? "资金费" : null,
    oi ? "OI" : null,
    hot ? "热度" : null,
    multi ? "多周期" : null
  ].filter(Boolean);
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

function chartElementId(key) {
  return `chart-${key.replace(/[^a-zA-Z0-9_-]/g, "-")}`;
}

async function api(path, options) {
  const response = await fetch(path, options);
  if (!response.ok) {
    let message = `${path} ${response.status}`;
    try {
      const payload = await response.clone().json();
      if (payload?.error) message = payload.error;
    } catch {
      const text = await response.text().catch(() => "");
      if (text) message = text.slice(0, 220);
    }
    throw new Error(message);
  }
  return response.json();
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
  const { overview, database } = payload;
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
}

function sentimentLabel(value) {
  if (value === "Positive") return "正向";
  if (value === "Negative") return "负向";
  if (value === "Neutral") return "中性";
  return value || "未知";
}

function twitterStatusLabel(token) {
  if (!token.twitterStatus) return "推特未启用";
  if (token.twitterStatus === "ok") return `推特 ${formatNumber(token.twitterHeat, 0)}`;
  if (token.twitterStatus === "no_results") return "推特暂无结果";
  if (token.twitterStatus === "not_configured") return "推特未配置";
  if (token.twitterStatus === "rate_limited_retrying") return "推特限频，自动重试中";
  if (token.twitterStatus === "quota_pool_exhausted") return "推特额度池暂不可用";
  if (token.twitterStatus === "token_pool_cooling_down") return "推特额度池暂不可用";
  if (token.twitterStatus.includes("insufficient quota")) return "推特额度不足";
  if (token.twitterStatus.startsWith("token_pool_failed")) return "推特请求失败";
  if (token.twitterStatus === "pending_refresh") return "推特待刷新";
  if (token.twitterStatus === "stale_cache") return `推特缓存 ${formatNumber(token.twitterHeat, 0)}`;
  if (token.twitterStatus === "failed") return "推特请求失败";
  if (token.twitterStatus === "empty_symbol") return "推特无关键词";
  return `推特${token.twitterStatus}`;
}

function hotRankTotalPages() {
  return Math.ceil(state.hotRankTotal / state.hotRankPageSize) || 1;
}

function clampHotRankPage() {
  state.hotRankPage = clamp(state.hotRankPage, 1, hotRankTotalPages());
}

function hotRankFallbackText(symbol) {
  return String(symbol ?? "")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "")
    .slice(0, 2) || "--";
}

function replaceHotRankLogo(image) {
  const fallback = document.createElement("span");
  fallback.className = "heat-token-mark";
  fallback.textContent = image.dataset.hotRankLogoFallback || "--";
  image.replaceWith(fallback);
}

function bindHotRankLogoFallbacks(root) {
  for (const image of root.querySelectorAll("img[data-hot-rank-logo-fallback]")) {
    image.addEventListener("error", () => replaceHotRankLogo(image), { once: true });
    if (image.complete && image.naturalWidth === 0) replaceHotRankLogo(image);
  }
}

function renderHotRank() {
  const target = $("#hotRankRows");
  const status = $("#hotRankStatus");
  if (!target || !status) return;

  setText("#heatRankCount", state.hotRankTotal || "--");
  const refreshButton = $("#refreshHotRankBtn");
  if (refreshButton) {
    refreshButton.disabled = state.hotRankLoading;
    refreshButton.textContent = state.hotRankLoading ? "刷新中" : "刷新热度";
  }
  document.querySelectorAll("[data-heat-chain]").forEach((button) => {
    button.classList.toggle("active", button.dataset.heatChain === state.hotRankChain);
  });

  if (state.hotRankLoading) {
    status.textContent = "正在刷新热度排行...";
    target.innerHTML = '<div class="heat-empty">正在读取热度数据。</div>';
    updateHeatPagination();
    return;
  }

  if (state.hotRankFetchedAt) {
    const flags = [];
    if (state.hotRankStale) flags.push("使用上次缓存");
    else if (state.hotRankPartial) flags.push("部分链失败");
    if (state.hotRankTwitterPending > 0) flags.push(`推特后台更新 ${state.hotRankTwitterPending} 项`);
    if (state.hotRankErrors.length) flags.push(`错误 ${state.hotRankErrors.length} 条`);
    status.textContent = `来源：${state.hotRankSource || "Binance Web3 Social Hype"} · 更新时间 ${formatTime(state.hotRankFetchedAt)}${flags.length ? ` · ${flags.join(" · ")}` : ""}`;
    status.title = state.hotRankErrors.join("\n");
  } else {
    status.textContent = state.hotRankError || "等待刷新";
    status.title = state.hotRankError || "";
  }

  if (!state.hotRank.length) {
    target.innerHTML = '<div class="heat-empty">暂无热度数据。</div>';
    updateHeatPagination();
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
      const fallback = escapeHtml(hotRankFallbackText(token.symbol));
      const logo = token.logo
        ? `<img src="${escapeHtml(token.logo)}" alt="" loading="lazy" data-hot-rank-logo-fallback="${fallback}" />`
        : `<span class="heat-token-mark">${fallback}</span>`;
      return `
        <article class="heat-rank-row">
          <div class="heat-rank-num">#${escapeHtml(token.rank)}</div>
          <div class="heat-token">
            ${logo}
            <div>
              <strong>${symbol}</strong>
              <span>市值 ${formatCompactUsd(token.marketCap)} · 情绪 ${escapeHtml(sentimentLabel(token.sentiment))}</span>
            </div>
          </div>
          <div class="heat-chain">${escapeHtml(token.chainLabel)}</div>
          <div class="heat-score">${formatNumber(token.heat, 0)}</div>
          <div class="heat-change ${changeClass}">${formatPercent(change)}</div>
          <div class="heat-links">${copyButton(token.symbol)}${searchButtons(token.symbol)}</div>
          <div class="heat-summary" title="${escapeHtml(token.summary || "暂无讨论摘要")}">${escapeHtml(token.summary || "暂无讨论摘要")}</div>
        </article>
      `;
    })
    .join("");

  bindCopyButtons(target);
  bindHotRankLogoFallbacks(target);
  updateHeatPagination();
}

function updateHeatPagination() {
  clampHotRankPage();
  const totalPages = hotRankTotalPages();
  const summary = state.hotRankTotal
    ? `第 ${state.hotRankPage} / ${totalPages} 页，共 ${state.hotRankTotal} 项`
    : "--";
  setText("#heatPaginationSummary", summary);
  setText("#heatPageIndicator", `${state.hotRankPage} / ${totalPages}`);

  const prevBtn = $("#prevHeatPageBtn");
  const nextBtn = $("#nextHeatPageBtn");
  if (prevBtn) prevBtn.disabled = state.hotRankPage <= 1;
  if (nextBtn) nextBtn.disabled = state.hotRankPage >= totalPages;

  document.querySelectorAll("[data-heat-pagesize]").forEach((btn) => {
    btn.classList.toggle("active", parseInt(btn.dataset.heatPagesize) === state.hotRankPageSize);
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
  const parts = [`当前共 ${state.fundingTokens.length} 个 1 小时结算周期代币`];
  if (positiveCount || negativeCount || neutralCount) {
    parts.push(`正费率 ${positiveCount} / 负费率 ${negativeCount} / 持平或未知 ${neutralCount}`);
  }
  parts.push("按最近变化时间排序");
  return parts.join("，");
}

async function loadFundingRateTokens({ silent = false } = {}) {
  state.fundingLoading = true;
  state.fundingError = "";
  updateFundingControls();
  if (!silent) setText("#fundingStatus", "正在读取资金费率列表...");
  try {
    const payload = await api("/api/funding-rate-tokens");
    state.fundingTokens = payload.tokens || [];
  } catch (error) {
    state.fundingError = error instanceof Error ? error.message : String(error);
    console.error("load funding rate tokens failed", error);
  } finally {
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
    target.innerHTML = '<div class="heat-empty">当前没有 1 小时结算周期的代币。</div>';
    setText("#fundingStatus", "当前没有 1 小时结算周期的代币");
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
          ? `OI 5m ${formatPercent(token.oiChange5mPct)} / 1h ${formatPercent(token.oiChange1hPct)}`
          : null
      ].filter(Boolean);
      const expanded = state.fundingExpandedSymbol === token.symbol;
      const rateTone = fundingRateTone(token.currentFundingRate);
      return `
        <article class="funding-card">
          <div class="funding-symbol">
            <button class="market-symbol-button" type="button" data-market-chart="funding" data-market-symbol="${escapeHtml(token.symbol)}" aria-expanded="${expanded}">${escapeHtml(token.symbol)}</button>
            <span class="level-badge level1">${escapeHtml(token.fundingIntervalHours ?? 1)} 小时结算</span>
          </div>
          <div><span>现价</span><b class="mono" data-market-price="${escapeHtml(token.symbol)}">${formatNumber(token.currentPrice)}</b></div>
          <div><span>关联信号</span><b>${escapeHtml(matches.join(" + ") || "暂无")}</b></div>
          <div><span>均线周期</span><b>${escapeHtml((token.intervals ?? []).join(" / ") || "--")}</b></div>
          <div><span>当前资金费率</span><b class="mono funding-rate ${rateTone}">${formatFundingPercent(token.currentFundingRate)}</b></div>
          <div><span>下次结算</span><b>${formatTime(token.nextFundingTime)}</b></div>
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
    await loadFundingRateTokens({ silent: true });
    if (state.fundingError) {
      setText("#fundingStatus", `扫描已返回，但列表刷新失败：${state.fundingError}`);
      return;
    }
    const suffix = result?.skipped ? `扫描跳过：${result.reason || "未知原因"}` : `扫描完成，发现 ${Number(result?.seenCount ?? 0)} 个调整周期合约`;
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
          <div><span>更新时间</span><b>${formatTime(item.observedAt)}</b></div>
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
  if (state.ioLoading) statusParts.push("刷新中");
  if (state.ioError) statusParts.push("上次刷新失败，保留当前结果");
  setText("#ioStatus", statusParts.join(" · "));
  updateIoPagination();
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

async function loadTriggerHistory() {
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

function renderTriggerHistory() {
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
        <td><div class="symbol-cell compact">${escapeHtml(item.symbol)} ${copyButton(item.symbol)}</div></td>
        <td>${escapeHtml(triggerTypeLabel(item.triggerType))}</td>
        <td>${escapeHtml(item.intervalsTriggered || "-")}</td>
        <td>${escapeHtml(item.signalLevel || "-")}</td>
        <td>${formatTime(item.triggerTime)}</td>
        <td><button class="ghost-button" data-delete-trigger="${item.id}">删除</button></td>
      </tr>
    `)
    .join("");

  bindTriggerSelection();
  bindCopyButtons(target);
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
    state.hotRankTwitterPending = Math.max(0, Number(payload.twitterPendingCount) || 0);
    if (state.hotRankTwitterPending > 0) {
      state.hotRankRefreshTimer = setTimeout(() => {
        if (state.hotRankChain === requestedChain) loadHotRank({ silent: true });
      }, 2500);
    }
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
    state.hotRankTwitterPending = 0;
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
        ? `5m ${formatPercent(row.oiChange5mPct)} / 1h ${formatPercent(row.oiChange1hPct)}`
        : "";
      const details = Array.isArray(row.intervalDetails) ? row.intervalDetails : [];
      const triggered = details.filter((item) => ["LEVEL1", "LEVEL2"].includes(item.alertLevel));
      const availableIntervals = details.map((item) => item.intervalCode).filter(Boolean);
      const preferredInterval =
        state.signalChartIntervals.get(row.symbol) ??
        triggered[0]?.intervalCode ??
        row.intervalCode ??
        availableIntervals[0] ??
        "1h";
      const selectedInterval = availableIntervals.includes(preferredInterval) ? preferredInterval : availableIntervals[0] ?? "1h";
      state.signalChartIntervals.set(row.symbol, selectedInterval);
      const selectedDetail = details.find((item) => item.intervalCode === selectedInterval) ?? row;
      const bestLevel = row.bestAlertLevel ??
        (triggered.some((item) => item.alertLevel === "LEVEL1")
          ? "LEVEL1"
          : triggered.some((item) => item.alertLevel === "LEVEL2")
            ? "LEVEL2"
            : row.alertLevel);
      const intervalBadges = triggered.length
        ? triggered.map((item) => `<span class="interval-badge interval-${escapeHtml(item.intervalCode)} ${item.alertLevel === "LEVEL1" ? "is-level1" : "is-level2"}">${escapeHtml(item.intervalCode)}</span>`).join("")
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
          <td class="mono">${formatNumber(selectedDetail.currentPrice)}</td>
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

function renderWatchlist() {
  const target = $("#watchRows");
  if (!target) return;
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

function watchRealtimeStreams() {
  const streams = new Set();
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
    for (const token of state.fundingTokens.slice(0, 5)) {
      const symbol = String(token.symbol ?? "").toLowerCase();
      if (symbol) streams.add(`${symbol}@ticker`);
    }
  }
  if (state.currentView === "io") {
    for (const item of state.ioData.slice(0, 5)) {
      const symbol = String(item.symbol ?? "").toLowerCase();
      if (symbol) streams.add(`${symbol}@ticker`);
    }
  }
  const expandedCharts = [
    state.currentView === "signals" && state.expandedKey
      ? state.signals.find((row) => rowKey(row) === state.expandedKey)?.symbol
      : null,
    state.currentView === "funding" ? state.fundingExpandedSymbol : null,
    state.currentView === "io" ? state.ioExpandedSymbol : null
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
  const payload = state.chartCache.get(key);
  if (!payload?.klines?.length) return;
  const next = {
    openTime: Number(kline.t),
    closeTime: Number(kline.T),
    open: Number(kline.o),
    high: Number(kline.h),
    low: Number(kline.l),
    close: Number(kline.c),
    volume: Number(kline.v)
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
      updateMarketPriceDom(symbol, price, eventTime);
    }
    return;
  }
  if (payload?.type === "kline" && payload.kline) {
    const symbol = String(payload.symbol ?? "").toUpperCase();
    const interval = String(payload.interval ?? payload.kline.i ?? "");
    const price = Number(payload.kline.c);
    const eventTime = Number(payload.eventTime ?? Date.now());
    updateWatchPriceDom(symbol, price, eventTime);
    updateMarketPriceDom(symbol, price, eventTime);
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
      updateMarketPriceDom(symbol, price, eventTime);
    }
    return;
  }
  if (data?.e === "kline" && data.k) {
    const symbol = String(data.s ?? "").toUpperCase();
    const interval = String(data.k.i ?? "");
    const price = Number(data.k.c);
    const eventTime = Number(data.E ?? Date.now());
    updateWatchPriceDom(symbol, price, eventTime);
    updateMarketPriceDom(symbol, price, eventTime);
    updateChartKline(symbol, interval, data.k);
  }
}

function updateWatchRealtime() {
  const streams = watchRealtimeStreams();
  if (!streams.length) {
    closeWatchRealtime();
    return;
  }
  if ("EventSource" in window) {
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
  if (window.location.hash === "#overview") {
    window.history.replaceState(null, "", "#signalsPage");
  }
  return "signals";
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
  if (mobileSelect) mobileSelect.value = page;
  if (page === "heat") loadHotRank({ silent: true });
  if (page === "watch") loadWatchlist();
  else updateWatchRealtime();
  if (page === "funding") loadFundingRateTokens();
  if (page === "io") loadIOMonitoring();
  if (page === "trigger-history") loadTriggerHistory();
}

function toggleRow(key) {
  state.expandedKey = state.expandedKey === key ? null : key;
  renderSignals();
}

async function loadSignalsPage() {
  if (state.categories.size === 0 || state.levels.size === 0 || state.intervals.size === 0) {
    state.signals = [];
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

function chartDefaults(dataLength) {
  const visible = Math.max(1, Math.min(dataLength, 180));
  return {
    crosshair: true,
    volume: true,
    ma100: true,
    ma200: true,
    drawTool: null,
    drawings: [],
    draftDrawing: null,
    visible,
    start: Math.max(0, dataLength - visible),
    priceScale: 1,
    priceOffset: 0,
    hoverIndex: null,
    hoverXRatio: null,
    hoverYRatio: null,
    dragging: false,
    activePointerId: null,
    dragMode: null,
    dragStartX: 0,
    dragStartY: 0,
    dragStartStart: 0,
    dragStartScale: 1,
    dragStartOffset: 0,
    dragStartSpan: 0
  };
}

function chartRightSpaceSlots(visible) {
  if (visible <= 1) return 0;
  return Math.max(1, Math.round(visible * 1.5));
}

function chartMaxStart(length, visible) {
  if (length <= 0) return 0;
  const rightSpace = chartRightSpaceSlots(visible);
  return Math.max(0, Math.min(length - 1, length + rightSpace - visible));
}

function chartLayout(width, height, settings) {
  const volumeHeight = settings.volume ? Math.max(56, Math.min(78, Math.round(height * 0.17))) : 0;
  const plotLeft = width < 520 ? 48 : 62;
  const plotRight = Math.max(plotLeft + 80, width - (width < 520 ? 58 : 76));
  const plotTop = 24;
  const plotBottom = Math.max(plotTop + 90, height - 36 - volumeHeight);
  return {
    plotLeft,
    plotRight,
    plotTop,
    plotBottom,
    volumeTop: plotBottom + 16,
    volumeHeight,
    width: Math.max(1, plotRight - plotLeft),
    height: Math.max(1, plotBottom - plotTop)
  };
}

function intervalMsFromCode(intervalCode) {
  return {
    "15m": 15 * 60 * 1000,
    "1h": 60 * 60 * 1000,
    "4h": 4 * 60 * 60 * 1000,
    "1d": 24 * 60 * 60 * 1000
  }[intervalCode] ?? 60 * 60 * 1000;
}

function buildChartKlines(klines, intervalCode) {
  const source = Array.isArray(klines) ? klines : [];
  if (source.length < 2) return source;
  const intervalMs = intervalMsFromCode(intervalCode);
  const chartRows = [];
  let previous = null;
  for (const item of source) {
    if (previous) {
      const missingSlots = Math.round((Number(item.openTime) - Number(previous.openTime)) / intervalMs) - 1;
      for (let slot = 1; slot <= Math.min(missingSlots, 5000); slot += 1) {
        chartRows.push({
          isGap: true,
          openTime: Number(previous.openTime) + intervalMs * slot,
          missingSlots
        });
      }
    }
    chartRows.push({ ...item, isGap: false });
    previous = item;
  }
  return chartRows;
}

function chartKlines(payload) {
  if (!payload) return [];
  if (!payload._chartKlines) payload._chartKlines = buildChartKlines(payload.klines, payload.intervalCode);
  return payload._chartKlines;
}

function chartKlineLength(payload) {
  return chartKlines(payload).length;
}

async function loadAndRenderChart(row, { force = false } = {}) {
  const key = `${row.symbol}|${row.intervalCode}`;
  const shell = document.getElementById(chartElementId(key));
  if (!shell) return;

  try {
    if (force) state.chartCache.delete(key);
    if (!state.chartCache.has(key)) {
      const payload = await api(`/api/klines?symbol=${encodeURIComponent(row.symbol)}&interval=${encodeURIComponent(row.intervalCode)}&limit=all`);
      state.chartCache.set(key, payload);
      state.chartState.set(key, chartDefaults(chartKlineLength(payload)));
    }
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
    shell.innerHTML = `
      <div class="chart-toolbar">
        <div class="chart-title-block">
          <strong>${escapeHtml(row.symbol)} ${escapeHtml(row.intervalCode)} K线</strong>
          <span>数据库全部 ${payload.cachedCount ?? payload.klines.length} 根 / 目标 ${payload.expectedCount ?? "--"} 根${payload.gapCount ? ` · 缺口 ${payload.gapCount} 段/${payload.missingKlineCount} 根` : ""} · ${payload.hasMa200 ? "MA200 可用" : "新币历史不足 200 根"} · 按住图表自由平移，滚轮缩放时间轴，右侧价格轴单独缩放</span>
        </div>
        <div class="chart-tools" role="toolbar" aria-label="K线工具">
          <button class="${settings.crosshair ? "active" : ""}" type="button" data-tool="crosshair" title="显示或隐藏十字线">十字线</button>
          <button class="${settings.volume ? "active" : ""}" type="button" data-tool="volume" title="显示或隐藏成交量">成交量</button>
          <button class="${settings.ma100 ? "active" : ""}" type="button" data-tool="ma100" title="显示或隐藏 MA100">MA100</button>
          <button class="${settings.ma200 ? "active" : ""}" type="button" data-tool="ma200" title="显示或隐藏 MA200">MA200</button>
          <button class="${settings.drawTool === "trend" ? "active" : ""}" type="button" data-tool="trend" title="绘制趋势线">趋势线</button>
          <button class="${settings.drawTool === "hline" ? "active" : ""}" type="button" data-tool="hline" title="绘制水平线">水平线</button>
          <button type="button" data-tool="clearDrawings" title="清除当前图表画线">清除</button>
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
      </div>
      <canvas class="kline-canvas" data-key="${escapeHtml(key)}"></canvas>
    `;

    bindChartTools(shell, key);
    drawChartForKey(key);
  } catch (error) {
    shell.innerHTML = `<div class="chart-loading">K线读取失败：${escapeHtml(error instanceof Error ? error.message : String(error))}</div>`;
  }
}

function bindChartTools(shell, key) {
  for (const button of shell.querySelectorAll("[data-tool]")) {
    button.addEventListener("click", () => {
      const settings = state.chartState.get(key);
      if (!settings) return;
      const tool = button.dataset.tool;
      if (["crosshair", "volume", "ma100", "ma200"].includes(tool)) settings[tool] = !settings[tool];
      if (tool === "trend" || tool === "hline") settings.drawTool = settings.drawTool === tool ? null : tool;
      if (tool === "clearDrawings") {
        settings.drawings = [];
        settings.draftDrawing = null;
      }
      loadAndRenderChart({ symbol: state.chartCache.get(key)?.symbol, intervalCode: state.chartCache.get(key)?.intervalCode });
    });
  }

  const canvas = shell.querySelector(".kline-canvas");
  canvas.addEventListener("wheel", (event) => {
    const settings = state.chartState.get(key);
    const payload = state.chartCache.get(key);
    if (!settings || !payload) return;
    event.preventDefault();
    const length = chartKlineLength(payload);
    const minVisible = Math.min(length, 30);
    const rect = canvas.getBoundingClientRect();
    const layout = chartLayout(rect.width, rect.height || 430, settings);
    if (event.clientX - rect.left >= layout.plotRight) {
      const range = chartPriceRange(payload, settings);
      const yRatio = clamp((event.clientY - rect.top - layout.plotTop) / layout.height, 0, 1);
      const nextScale = clamp(settings.priceScale * (event.deltaY < 0 ? 0.86 : 1.16), 0.15, 8);
      const anchorPrice = range.max - yRatio * (range.max - range.min);
      const nextSpan = range.baseSpan * nextScale;
      const nextCenter = anchorPrice - (0.5 - yRatio) * nextSpan;
      settings.priceScale = nextScale;
      settings.priceOffset = nextCenter - range.baseCenter;
      drawChartForKey(key);
      return;
    }
    const ratio = clamp((event.clientX - rect.left - layout.plotLeft) / (layout.plotRight - layout.plotLeft), 0, 1);
    const anchorIndex = settings.start + Math.floor(settings.visible * ratio);
    const nextVisible = clamp(
      Math.round(settings.visible * (event.deltaY < 0 ? 0.82 : 1.22)),
      minVisible,
      length
    );
    settings.visible = nextVisible;
    settings.start = clamp(anchorIndex - Math.floor(nextVisible * ratio), 0, chartMaxStart(length, nextVisible));
    settings.hoverIndex = null;
    settings.hoverXRatio = null;
    settings.hoverYRatio = null;
    drawChartForKey(key);
  }, { passive: false });

  canvas.addEventListener("pointerdown", (event) => {
    const settings = state.chartState.get(key);
    const payload = state.chartCache.get(key);
    if (!settings || !payload || event.button !== 0) return;
    canvas.setPointerCapture?.(event.pointerId);
    if (settings.drawTool) {
      const point = chartPointFromEvent(canvas, key, event);
      if (!point) return;
      if (settings.drawTool === "hline") {
        settings.drawings.push({ type: "hline", yRatio: point.yRatio });
        drawChartForKey(key);
        return;
      }
      settings.draftDrawing = { type: "trend", start: point, end: point };
      drawChartForKey(key);
      return;
    }
    const rect = canvas.getBoundingClientRect();
    const layout = chartLayout(rect.width, rect.height || 430, settings);
    settings.dragging = true;
    settings.activePointerId = event.pointerId;
    settings.dragMode = event.clientX - rect.left >= layout.plotRight
      ? "price-scale"
      : "chart-pan";
    settings.dragStartX = event.clientX;
    settings.dragStartY = event.clientY;
    settings.dragStartStart = settings.start;
    settings.dragStartScale = settings.priceScale;
    settings.dragStartOffset = settings.priceOffset;
    settings.dragStartSpan = chartPriceRange(payload, settings).baseSpan * settings.priceScale;
    canvas.classList.add("is-dragging");
  });

  canvas.addEventListener("pointermove", (event) => {
    const settings = state.chartState.get(key);
    const payload = state.chartCache.get(key);
    if (!settings || !payload) return;

    if (settings.dragging) {
      const rect = canvas.getBoundingClientRect();
      const layout = chartLayout(rect.width, rect.height || 430, settings);
      if (settings.dragMode === "price-scale") {
        settings.priceScale = clamp(
          settings.dragStartScale * Math.exp((event.clientY - settings.dragStartY) / 180),
          0.15,
          8
        );
        drawChartForKey(key);
        return;
      }
      const slot = layout.width / Math.max(1, settings.visible);
      const movedSlots = Math.round((event.clientX - settings.dragStartX) / slot);
      settings.start = clamp(settings.dragStartStart - movedSlots, 0, chartMaxStart(chartKlineLength(payload), settings.visible));
      settings.priceOffset =
        settings.dragStartOffset +
        ((event.clientY - settings.dragStartY) / Math.max(1, layout.height)) * settings.dragStartSpan;
      settings.hoverIndex = null;
      settings.hoverXRatio = null;
      settings.hoverYRatio = null;
      drawChartForKey(key);
      return;
    }

    const point = chartPointFromEvent(canvas, key, event);
    if (!point) {
      if (settings.crosshair && settings.hoverIndex !== null) {
        settings.hoverIndex = null;
        settings.hoverXRatio = null;
        settings.hoverYRatio = null;
        drawChartForKey(key);
      }
      return;
    }

    if (settings.draftDrawing) {
      settings.draftDrawing.end = point;
      drawChartForKey(key);
      return;
    }

    if (settings.crosshair) {
      if (settings.hoverIndex === point.index && settings.hoverXRatio === point.xRatio && settings.hoverYRatio === point.yRatio) return;
      settings.hoverIndex = point.index;
      settings.hoverXRatio = point.xRatio;
      settings.hoverYRatio = point.yRatio;
      drawChartForKey(key);
    }
  });

  canvas.addEventListener("pointerup", (event) => {
    canvas.releasePointerCapture?.(event.pointerId);
    canvas.classList.remove("is-dragging");
    finishChartPointer(key);
  });
  canvas.addEventListener("pointercancel", () => {
    canvas.classList.remove("is-dragging");
    finishChartPointer(key);
  });
  canvas.addEventListener("pointerleave", () => {
    const settings = state.chartState.get(key);
    if (!settings || settings.dragging) return;
    settings.hoverIndex = null;
    settings.hoverXRatio = null;
    settings.hoverYRatio = null;
    drawChartForKey(key);
  });

  canvas.addEventListener("mousedown", (event) => {
    const settings = state.chartState.get(key);
    const payload = state.chartCache.get(key);
    if (!settings || !payload || settings.dragging || settings.drawTool || event.button !== 0) return;
    const rect = canvas.getBoundingClientRect();
    const layout = chartLayout(rect.width, rect.height || 430, settings);
    settings.dragging = true;
    settings.dragMode = event.clientX - rect.left >= layout.plotRight ? "price-scale" : "chart-pan";
    settings.dragStartX = event.clientX;
    settings.dragStartY = event.clientY;
    settings.dragStartStart = settings.start;
    settings.dragStartScale = settings.priceScale;
    settings.dragStartOffset = settings.priceOffset;
    settings.dragStartSpan = chartPriceRange(payload, settings).baseSpan * settings.priceScale;
    canvas.classList.add("is-dragging");
  });

  canvas.addEventListener("mousemove", (event) => {
    const settings = state.chartState.get(key);
    const payload = state.chartCache.get(key);
    if (!settings?.dragging || !payload) return;
    const rect = canvas.getBoundingClientRect();
    const layout = chartLayout(rect.width, rect.height || 430, settings);
    if (settings.dragMode === "price-scale") {
      settings.priceScale = clamp(
        settings.dragStartScale * Math.exp((event.clientY - settings.dragStartY) / 180),
        0.15,
        8
      );
    } else {
      const slot = layout.width / Math.max(1, settings.visible);
      const movedSlots = Math.round((event.clientX - settings.dragStartX) / slot);
      settings.start = clamp(
        settings.dragStartStart - movedSlots,
        0,
        chartMaxStart(chartKlineLength(payload), settings.visible)
      );
      settings.priceOffset =
        settings.dragStartOffset +
        ((event.clientY - settings.dragStartY) / Math.max(1, layout.height)) * settings.dragStartSpan;
      settings.hoverIndex = null;
      settings.hoverXRatio = null;
      settings.hoverYRatio = null;
    }
    drawChartForKey(key);
  });

  canvas.addEventListener("mouseup", () => {
    canvas.classList.remove("is-dragging");
    finishChartPointer(key);
  });

  canvas.addEventListener("mouseleave", () => {
    const settings = state.chartState.get(key);
    if (!settings) return;
    if (settings.dragging && settings.activePointerId !== null) return;
    canvas.classList.remove("is-dragging");
    finishChartPointer(key);
    settings.hoverIndex = null;
    settings.hoverXRatio = null;
    settings.hoverYRatio = null;
    drawChartForKey(key);
  });
}

function finishChartPointer(key) {
  const settings = state.chartState.get(key);
  if (!settings) return;
  if (settings.draftDrawing) {
    settings.drawings.push(settings.draftDrawing);
    settings.draftDrawing = null;
  }
  settings.dragging = false;
  settings.activePointerId = null;
  settings.dragMode = null;
}

function chartPointFromEvent(canvas, key, event) {
  const settings = state.chartState.get(key);
  const payload = state.chartCache.get(key);
  if (!settings || !payload) return null;
  const rect = canvas.getBoundingClientRect();
  const layout = chartLayout(rect.width, rect.height || 430, settings);
  const ratio = clamp((event.clientX - rect.left - layout.plotLeft) / (layout.plotRight - layout.plotLeft), 0, 1);
  const slotIndex = Math.min(settings.visible - 1, Math.floor(settings.visible * ratio));
  const index = clamp(settings.start + slotIndex, 0, Math.max(0, chartKlineLength(payload) - 1));
  return {
    index,
    xRatio: ratio,
    yRatio: clamp((event.clientY - rect.top - layout.plotTop) / Math.max(1, layout.plotBottom - layout.plotTop), 0, 1)
  };
}

function visibleKlines(payload, settings) {
  const rows = chartKlines(payload);
  const length = rows.length;
  settings.visible = clamp(settings.visible, 1, Math.max(1, length));
  settings.start = clamp(settings.start, 0, chartMaxStart(length, settings.visible));
  return rows.slice(settings.start, Math.min(length, settings.start + settings.visible));
}

function chartPriceRange(payload, settings) {
  const data = visibleKlines(payload, settings);
  const prices = data
    .flatMap((item) => [item.high, item.low, settings.ma100 ? item.ma100 : null, settings.ma200 ? item.ma200 : null])
    .filter(Number.isFinite);
  if (!prices.length) {
    const fallback = Number(payload.klines?.at(-1)?.close);
    const center = Number.isFinite(fallback) && fallback > 0 ? fallback : 1;
    const baseSpan = Math.max(Number.EPSILON, center * 0.16);
    const span = baseSpan * settings.priceScale;
    const shiftedCenter = center + settings.priceOffset;
    return {
      baseCenter: center,
      baseSpan,
      min: shiftedCenter - span / 2,
      max: shiftedCenter + span / 2
    };
  }
  const rawMin = Math.min(...prices);
  const rawMax = Math.max(...prices);
  const pad = (rawMax - rawMin || rawMax || 1) * 0.08;
  const baseMin = rawMin - pad;
  const baseMax = rawMax + pad;
  const baseCenter = (baseMin + baseMax) / 2;
  const baseSpan = Math.max(Number.EPSILON, baseMax - baseMin);
  const span = baseSpan * settings.priceScale;
  const center = baseCenter + settings.priceOffset;
  return {
    baseCenter,
    baseSpan,
    min: center - span / 2,
    max: center + span / 2
  };
}

function chartCanvasWidth(canvas) {
  const parent = canvas.parentElement;
  if (!parent) return 320;
  const style = getComputedStyle(parent);
  const horizontalPadding = (parseFloat(style.paddingLeft) || 0) + (parseFloat(style.paddingRight) || 0);
  const contentWidth = parent.clientWidth - horizontalPadding;
  return Math.max(320, Math.floor(contentWidth));
}

function drawLine(ctx, points, color, width = 1.5) {
  ctx.beginPath();
  let started = false;
  ctx.lineJoin = "round";
  ctx.lineCap = "round";
  for (const point of points) {
    if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y)) {
      started = false;
      continue;
    }
    if (!started) {
      ctx.moveTo(point.x, point.y);
      started = true;
    } else {
      ctx.lineTo(point.x, point.y);
    }
  }
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.stroke();
}

function drawGapRegions(ctx, data, layout, slot, palette) {
  let startIndex = null;
  for (let index = 0; index <= data.length; index += 1) {
    const isGap = Boolean(data[index]?.isGap);
    if (isGap && startIndex === null) {
      startIndex = index;
      continue;
    }
    if ((!isGap || index === data.length) && startIndex !== null) {
      const x = layout.plotLeft + slot * startIndex;
      const width = Math.max(1, slot * (index - startIndex));
      ctx.save();
      ctx.fillStyle = palette.gridStrong;
      ctx.globalAlpha = 0.16;
      ctx.fillRect(x, layout.plotTop, width, layout.height);
      if (layout.volumeHeight) ctx.fillRect(x, layout.volumeTop, width, layout.volumeHeight);
      ctx.restore();
      startIndex = null;
    }
  }
}

function drawUserDrawings(ctx, settings, layout, slot, palette) {
  const drawings = [...settings.drawings, settings.draftDrawing].filter(Boolean);
  if (!drawings.length) return;
  const plotHeight = Math.max(1, layout.plotBottom - layout.plotTop);
  ctx.save();
  ctx.strokeStyle = palette.ma200;
  ctx.lineWidth = 1.5;
  ctx.setLineDash([6, 4]);
  for (const drawing of drawings) {
    if (drawing.type === "hline") {
      const y = layout.plotTop + drawing.yRatio * plotHeight;
      if (y < layout.plotTop || y > layout.plotBottom) continue;
      ctx.beginPath();
      ctx.moveTo(layout.plotLeft, y);
      ctx.lineTo(layout.plotRight, y);
      ctx.stroke();
      continue;
    }
    const startLocal = drawing.start.index - settings.start;
    const endLocal = drawing.end.index - settings.start;
    if ((startLocal < 0 && endLocal < 0) || (startLocal > settings.visible && endLocal > settings.visible)) continue;
    ctx.beginPath();
    ctx.moveTo(layout.plotLeft + slot * startLocal + slot / 2, layout.plotTop + drawing.start.yRatio * plotHeight);
    ctx.lineTo(layout.plotLeft + slot * endLocal + slot / 2, layout.plotTop + drawing.end.yRatio * plotHeight);
    ctx.stroke();
  }
  ctx.restore();
}

function drawChartForKey(key) {
  const payload = state.chartCache.get(key);
  const settings = state.chartState.get(key);
  const canvas = document.querySelector(`.kline-canvas[data-key="${CSS.escape(key)}"]`);
  if (!payload || !settings || !canvas) return;
  canvas.dataset.viewportStart = String(settings.start);
  canvas.dataset.viewportVisible = String(settings.visible);
  canvas.dataset.priceScale = String(settings.priceScale);
  canvas.dataset.priceOffset = String(settings.priceOffset);

  const parentWidth = chartCanvasWidth(canvas);
  const cssHeight = 430;
  const dpr = window.devicePixelRatio || 1;
  const pixelWidth = Math.floor(parentWidth * dpr);
  const pixelHeight = Math.floor(cssHeight * dpr);
  if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
    canvas.style.width = `${parentWidth}px`;
    canvas.style.height = `${cssHeight}px`;
    canvas.width = pixelWidth;
    canvas.height = pixelHeight;
  }

  const ctx = canvas.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, parentWidth, cssHeight);
  const palette = chartPalette();
  ctx.fillStyle = palette.bg;
  ctx.fillRect(0, 0, parentWidth, cssHeight);

  const data = visibleKlines(payload, settings);
  if (!data.length) return;
  const layout = chartLayout(parentWidth, cssHeight, settings);
  const { plotLeft, plotRight, plotTop, plotBottom, volumeTop, volumeHeight, width, height } = layout;

  ctx.save();
  ctx.fillStyle = palette.panel;
  ctx.fillRect(plotLeft, plotTop, width, height);
  if (settings.volume) ctx.fillRect(plotLeft, volumeTop, width, volumeHeight);
  ctx.strokeStyle = palette.axis;
  ctx.lineWidth = 1;
  ctx.strokeRect(plotLeft, plotTop, width, height);
  if (settings.volume) ctx.strokeRect(plotLeft, volumeTop, width, volumeHeight);
  ctx.restore();

  const priceRange = chartPriceRange(payload, settings);
  const priceMin = priceRange.min;
  const priceMax = priceRange.max;
  const y = (price) => plotTop + ((priceMax - price) / (priceMax - priceMin)) * height;
  const slot = width / Math.max(1, settings.visible);
  const candleWidth = Math.max(2, Math.min(14, slot * 0.64));

  ctx.strokeStyle = palette.grid;
  ctx.lineWidth = 1;
  ctx.font = "12px Arial";
  ctx.textBaseline = "middle";
  ctx.fillStyle = palette.muted;
  for (let i = 0; i <= 5; i += 1) {
    const gy = plotTop + (height / 5) * i;
    ctx.beginPath();
    ctx.moveTo(plotLeft, gy);
    ctx.lineTo(plotRight, gy);
    ctx.stroke();
    const label = priceMax - ((priceMax - priceMin) / 5) * i;
    ctx.fillText(formatNumber(label, 4), plotRight + 8, gy);
  }

  const tickCount = Math.min(6, data.length);
  ctx.textBaseline = "top";
  for (let i = 0; i < tickCount; i += 1) {
    const localIndex = tickCount === 1 ? 0 : Math.round(((data.length - 1) * i) / (tickCount - 1));
    const item = data[localIndex];
    const x = plotLeft + slot * localIndex + slot / 2;
    ctx.strokeStyle = i === tickCount - 1 ? palette.gridStrong : palette.grid;
    ctx.beginPath();
    ctx.moveTo(x, plotTop);
    ctx.lineTo(x, settings.volume ? volumeTop + volumeHeight : plotBottom);
    ctx.stroke();
    const label = new Date(item.openTime)
      .toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false })
      .replace(/\//g, "-");
    const labelWidth = ctx.measureText(label).width;
    ctx.fillStyle = palette.muted;
    ctx.fillText(label, clamp(x - labelWidth / 2, plotLeft, plotRight - labelWidth), cssHeight - 25);
  }

  drawGapRegions(ctx, data, layout, slot, palette);

  const maxVolume = Math.max(...data.filter((item) => !item.isGap).map((item) => item.volume).filter(Number.isFinite), 1);
  data.forEach((item, index) => {
    if (item.isGap) return;
    const x = plotLeft + slot * index + slot / 2;
    const up = item.close >= item.open;
    const color = up ? palette.up : palette.down;
    ctx.strokeStyle = color;
    ctx.fillStyle = color;
    ctx.lineWidth = Math.max(1, Math.min(2, candleWidth / 4));
    ctx.beginPath();
    ctx.moveTo(x, y(item.high));
    ctx.lineTo(x, y(item.low));
    ctx.stroke();
    const bodyTop = y(Math.max(item.open, item.close));
    const bodyBottom = y(Math.min(item.open, item.close));
    const bodyHeight = Math.max(2, bodyBottom - bodyTop);
    ctx.globalAlpha = up ? 0.92 : 0.95;
    ctx.fillRect(x - candleWidth / 2, bodyTop, candleWidth, bodyHeight);
    ctx.globalAlpha = 1;

    if (settings.volume) {
      const volumeBarHeight = (item.volume / maxVolume) * volumeHeight;
      ctx.globalAlpha = 0.28;
      ctx.fillRect(x - candleWidth / 2, volumeTop + volumeHeight - volumeBarHeight, candleWidth, volumeBarHeight);
      ctx.globalAlpha = 1;
    }
  });

  if (settings.ma100) {
    drawLine(
      ctx,
      data.map((item, index) => (!item.isGap && Number.isFinite(item.ma100) ? { x: plotLeft + slot * index + slot / 2, y: y(item.ma100) } : null)),
      palette.ma100,
      2
    );
  }
  if (settings.ma200) {
    drawLine(
      ctx,
      data.map((item, index) => (!item.isGap && Number.isFinite(item.ma200) ? { x: plotLeft + slot * index + slot / 2, y: y(item.ma200) } : null)),
      palette.ma200,
      2
    );
  }

  const last = [...data].reverse().find((item) => !item.isGap && Number.isFinite(item.close));
  if (last && Number.isFinite(last.close)) {
    const lastY = y(last.close);
    const lastUp = last.close >= last.open;
    const lastColor = lastUp ? palette.up : palette.down;
    ctx.save();
    ctx.strokeStyle = lastColor;
    ctx.globalAlpha = 0.7;
    ctx.setLineDash([5, 5]);
    ctx.beginPath();
    ctx.moveTo(plotLeft, lastY);
    ctx.lineTo(plotRight, lastY);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.globalAlpha = 1;
    const label = formatNumber(last.close, 4);
    const labelWidth = Math.max(54, ctx.measureText(label).width + 12);
    ctx.fillStyle = lastColor;
    ctx.fillRect(plotRight + 4, lastY - 12, labelWidth, 24);
    ctx.fillStyle = "#ffffff";
    ctx.textBaseline = "middle";
    ctx.fillText(label, plotRight + 10, lastY);
    ctx.restore();
  }

  drawUserDrawings(ctx, settings, layout, slot, palette);

  const hoverLocal = settings.hoverIndex === null ? null : settings.hoverIndex - settings.start;
  if (settings.crosshair && hoverLocal !== null && hoverLocal >= 0 && hoverLocal < data.length) {
    const item = data[hoverLocal];
    const x = plotLeft + clamp(Number(settings.hoverXRatio ?? 0), 0, 1) * (plotRight - plotLeft);
    const hoverY = plotTop + clamp(Number(settings.hoverYRatio ?? 0), 0, 1) * (plotBottom - plotTop);
    const hoverPrice = priceMax - ((hoverY - plotTop) / Math.max(1, plotBottom - plotTop)) * (priceMax - priceMin);
    ctx.strokeStyle = palette.crosshair;
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.moveTo(x, plotTop);
    ctx.lineTo(x, plotBottom);
    ctx.moveTo(plotLeft, hoverY);
    ctx.lineTo(plotRight, hoverY);
    ctx.stroke();
    ctx.setLineDash([]);
    const priceLabel = formatNumber(hoverPrice, 4);
    const priceLabelWidth = Math.max(54, ctx.measureText(priceLabel).width + 12);
    ctx.fillStyle = palette.text;
    ctx.fillRect(plotRight + 4, hoverY - 11, priceLabelWidth, 22);
    ctx.fillStyle = palette.bg;
    ctx.textBaseline = "middle";
    ctx.fillText(priceLabel, plotRight + 10, hoverY);

    const lines = item.isGap
      ? [
          new Date(item.openTime).toLocaleString("zh-CN", { hour12: false }),
          "本时段缺失K线",
          "等待后台审计补齐",
          ""
        ]
      : [
          new Date(item.openTime).toLocaleString("zh-CN", { hour12: false }),
          `O ${formatNumber(item.open, 4)}   H ${formatNumber(item.high, 4)}`,
          `L ${formatNumber(item.low, 4)}   C ${formatNumber(item.close, 4)}   ${formatPercent(item.open ? ((item.close - item.open) / item.open) * 100 : null)}`,
          `V ${formatCompactNumber(item.volume)}   MA100 ${formatNumber(item.ma100, 4)}   MA200 ${formatNumber(item.ma200, 4)}`
        ];
    const tooltipWidth = Math.min(parentWidth - 24, Math.max(...lines.map((line) => ctx.measureText(line).width)) + 22);
    const tooltipHeight = 92;
    const tx = Math.min(parentWidth - tooltipWidth - 12, Math.max(12, x - tooltipWidth / 2));
    const ty = hoverY < plotTop + tooltipHeight + 16 ? plotTop + 12 : hoverY - tooltipHeight - 12;
    ctx.fillStyle = palette.tooltipBg;
    ctx.strokeStyle = palette.tooltipLine;
    ctx.fillRect(tx, ty, tooltipWidth, tooltipHeight);
    ctx.strokeRect(tx, ty, tooltipWidth, tooltipHeight);
    lines.forEach((line, index) => {
      ctx.fillStyle = index === 0 ? palette.text : palette.muted;
      ctx.textBaseline = "top";
      ctx.fillText(line, tx + 11, ty + 10 + index * 19);
    });
  }

  ctx.textBaseline = "middle";
  ctx.fillStyle = palette.ma100;
  ctx.fillRect(plotLeft, cssHeight - 13, 18, 3);
  ctx.fillStyle = palette.muted;
  ctx.fillText("MA100", plotLeft + 24, cssHeight - 12);
  ctx.fillStyle = palette.ma200;
  ctx.fillRect(plotLeft + 88, cssHeight - 13, 18, 3);
  ctx.fillStyle = palette.muted;
  ctx.fillText("MA200", plotLeft + 112, cssHeight - 12);
  const chartLength = chartKlineLength(payload);
  const trailingSpace = Math.max(0, settings.start + settings.visible - chartLength);
  const rangeLabel = `范围 ${settings.start + 1}-${settings.start + data.length}/${chartLength}槽 · 实K ${payload.klines.length}${trailingSpace ? ` +${trailingSpace}空白` : ""}`;
  const rangeWidth = ctx.measureText(rangeLabel).width;
  ctx.fillText(rangeLabel, Math.max(plotLeft + 190, plotRight - rangeWidth), cssHeight - 12);
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
$("#refreshTriggerHistoryBtn")?.addEventListener("click", () => loadTriggerHistory());
$("#clearTriggerHistoryBtn")?.addEventListener("click", async () => {
  if (!confirm("确定要清空所有历史记录吗？")) return;
  try {
    await api("/api/trigger-history", { method: "DELETE" });
    state.triggerHistory = [];
    state.triggerHistoryTotal = 0;
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
    "trigger-history": "#triggerHistoryPage"
  };
  window.location.hash = hashes[page] ?? "#signalsPage";
});

window.addEventListener("resize", () => {
  for (const canvas of document.querySelectorAll(".kline-canvas[data-key]")) {
    drawChartForKey(canvas.dataset.key);
  }
});

updateFilterControls();
setPage(pageFromHash());
void bootstrap();
await refreshAll({ keepPage: false });
if (state.currentView !== "heat" || (!state.hotRankLoading && !state.hotRankFetchedAt)) loadHotRank();
loadWatchlist();
setInterval(() => loadHotRank({ silent: true }), 5 * 60 * 1000);
setInterval(() => {
  if (state.currentView === "watch") loadWatchlist({ silent: true });
}, 60 * 1000);
setInterval(() => refreshAll({ keepPage: true }), 5000);
