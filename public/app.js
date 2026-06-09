const ALL_CATEGORIES = ["A", "B"];
const ALL_LEVELS = ["LEVEL1", "LEVEL2", "NONE", "INSUFFICIENT"];
const ALL_INTERVALS = ["15m", "1h", "4h", "1d"];

const LABELS = {
  category: { A: "A类", B: "B类" },
  level: { LEVEL1: "一级", LEVEL2: "二级", NONE: "观察", INSUFFICIENT: "样本不足" },
  interval: { "15m": "15m", "1h": "1h", "4h": "4h", "1d": "1d" }
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
  chartCache: new Map(),
  chartState: new Map(),
  multiHistory: [],
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
  hotRankFetchedAt: null,
  hotRankPartial: false,
  hotRankStale: false,
  hotRankErrors: [],
  hotRankLoading: false,
  hotRankError: "",
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

function levelBadge(level) {
  if (level === "LEVEL1") return '<span class="level-badge level1">一级警报</span>';
  if (level === "LEVEL2") return '<span class="level-badge level2">二级预警</span>';
  if (level === "INSUFFICIENT") return '<span class="level-badge">样本不足</span>';
  return '<span class="level-badge none">观察中</span>';
}

function rowKey(row) {
  return `${row.symbol}|${row.intervalCode}`;
}

function baseAsset(symbol) {
  return String(symbol ?? "").toUpperCase().replace(/USDT$/, "");
}

function twitterSearchUrl(symbol) {
  return `https://mobile.twitter.com/search?q=${encodeURIComponent(`$${baseAsset(symbol)}`)}&src=typed_query&f=live`;
}

function binanceSquareSearchUrl(symbol) {
  return `https://www.binance.com/en/square/search?keyword=${encodeURIComponent(baseAsset(symbol))}`;
}

function searchButtons(symbol) {
  const safeSymbol = escapeHtml(symbol);
  return `
    <a class="mini-link" href="${escapeHtml(binanceSquareSearchUrl(symbol))}" target="_blank" rel="noreferrer" title="在币安广场搜索 ${safeSymbol}">广场</a>
    <a class="mini-link" href="${escapeHtml(twitterSearchUrl(symbol))}" target="_blank" rel="noreferrer" title="在推特搜索 ${safeSymbol}">推特</a>
  `;
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

function chartElementId(key) {
  return `chart-${key.replace(/[^a-zA-Z0-9_-]/g, "-")}`;
}

async function api(path, options) {
  const response = await fetch(path, options);
  if (!response.ok) throw new Error(`${path} ${response.status}`);
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
  if (token.twitterStatus === "not_configured") return "推特未配置";
  if (token.twitterStatus === "token_pool_cooling_down") return "推特冷却中";
  if (token.twitterStatus.includes("insufficient quota")) return "推特额度不足";
  if (token.twitterStatus.startsWith("token_pool_failed")) return "推特请求失败";
  if (token.twitterStatus === "pending_refresh") return "推特待刷新";
  if (token.twitterStatus === "stale_cache") return `推特缓存 ${formatNumber(token.twitterHeat, 0)}`;
  if (token.twitterStatus === "failed") return "推特请求失败";
  if (token.twitterStatus === "empty_symbol") return "推特无关键词";
  return `推特${token.twitterStatus}`;
}

function renderHotRank() {
  const target = $("#hotRankRows");
  const status = $("#hotRankStatus");
  if (!target || !status) return;

  setText("#heatRankCount", state.hotRank.length || "--");
  document.querySelectorAll("[data-heat-chain]").forEach((button) => {
    button.classList.toggle("active", button.dataset.heatChain === state.hotRankChain);
  });

  if (state.hotRankLoading) {
    status.textContent = "正在刷新热度排行...";
    target.innerHTML = '<div class="heat-empty">正在读取 Binance 社交热度数据。</div>';
    return;
  }

  if (state.hotRankFetchedAt) {
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

  if (!state.hotRank.length) {
    target.innerHTML = '<div class="heat-empty">暂无热度数据。</div>';
    return;
  }

  target.innerHTML = state.hotRank
    .map((token) => {
      const change = Number(token.priceChange);
      const changeClass = Number.isFinite(change) && change < 0 ? "down" : "up";
      const symbol = escapeHtml(token.symbol);
      const twitterMeta = twitterStatusLabel(token);
      const logo = token.logo
        ? `<img src="${escapeHtml(token.logo)}" alt="" loading="lazy" onerror="this.replaceWith(Object.assign(document.createElement('span'), { className: 'heat-token-mark', textContent: '${symbol.slice(0, 2)}' }))" />`
        : `<span class="heat-token-mark">${symbol.slice(0, 2)}</span>`;
      return `
        <article class="heat-rank-row">
          <div class="heat-rank-num">#${escapeHtml(token.rank)}</div>
          <div class="heat-token">
            ${logo}
            <div>
              <strong>${symbol}</strong>
              <span>市值 ${formatCompactUsd(token.marketCap)} · 情绪 ${escapeHtml(sentimentLabel(token.sentiment))} · ${escapeHtml(twitterMeta)}</span>
            </div>
          </div>
          <div class="heat-chain">${escapeHtml(token.chainLabel)}</div>
          <div class="heat-score">${formatNumber(token.heat, 0)}</div>
          <div class="heat-change ${changeClass}">${formatPercent(change)}</div>
          <div class="heat-links">${searchButtons(token.symbol)}</div>
          <div class="heat-summary" title="${escapeHtml(token.summary || "暂无讨论摘要")}">${escapeHtml(token.summary || "暂无讨论摘要")}</div>
        </article>
      `;
    })
    .join("");
}

async function loadHotRank({ silent = false } = {}) {
  if (state.hotRankLoading) return;
  state.hotRankLoading = true;
  if (!silent) renderHotRank();
  try {
    state.hotRankError = "";
    const payload = await api(`/api/hot-rank?chain=${encodeURIComponent(state.hotRankChain)}&limit=30`);
    state.hotRank = payload.tokens ?? [];
    state.hotRankSource = payload.source ?? "";
    state.hotRankFetchedAt = payload.fetchedAt ?? new Date().toISOString();
    state.hotRankPartial = Boolean(payload.partial);
    state.hotRankStale = Boolean(payload.stale);
    state.hotRankErrors = Array.isArray(payload.errors) ? payload.errors : [];
  } catch (error) {
    state.hotRank = [];
    state.hotRankSource = "";
    state.hotRankFetchedAt = null;
    state.hotRankPartial = false;
    state.hotRankStale = false;
    state.hotRankErrors = [];
    state.hotRankError = `热度数据读取失败：${error instanceof Error ? error.message : String(error)}`;
  } finally {
    state.hotRankLoading = false;
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
    target.innerHTML = '<tr><td colspan="9" class="empty">当前筛选条件下暂无信号。可放宽等级、周期或分类筛选。</td></tr>';
    return;
  }

  target.innerHTML = rows
    .map((row) => {
      const key = rowKey(row);
      const expanded = state.expandedKey === key;
      const multiRequired = Number(row.multiMatchRequired ?? 0);
      const multiCount = Number(row.multiMatchCount ?? 0);
      const multiQualified = multiRequired > 1 && multiCount >= multiRequired;
      const hotRankHit = Boolean(Number(row.hotRankHit ?? 0));
      const watched = isWatchedSymbol(row.symbol);
      const signalRow = `
        <tr class="signal-row ${expanded ? "is-expanded" : ""} ${multiQualified ? "is-multi-hit" : ""} ${hotRankHit ? "is-hot-ma-hit" : ""}" data-key="${escapeHtml(key)}">
          <td>
            <div class="symbol-cell">
              <button class="symbol-button" type="button" data-key="${escapeHtml(key)}" title="查看K线">${escapeHtml(row.symbol)}</button>
              <button class="copy-symbol" type="button" data-symbol="${escapeHtml(row.symbol)}" title="复制交易对">复制</button>
              <button class="copy-symbol watch-add ${watched ? "is-added" : ""}" type="button" data-watch-symbol="${escapeHtml(row.symbol)}" title="${watched ? `${escapeHtml(row.symbol)} 已在关注池` : `加入关注池：${escapeHtml(row.symbol)}`}" aria-pressed="${watched ? "true" : "false"}" ${watched ? "disabled" : ""}>${watched ? "已关注" : "加关注"}</button>
              ${searchButtons(row.symbol)}
              ${hotRankHit ? `<span class="hot-ma-badge">热度+均线 #${escapeHtml(row.hotRank ?? "--")}</span>` : ""}
              ${multiQualified ? `<span class="multi-badge">多周期 ${multiCount}/${multiRequired}</span>` : ""}
            </div>
          </td>
          <td>${escapeHtml(row.categoryLabel)}</td>
          <td class="mono">${escapeHtml(row.intervalCode)}</td>
          <td>${levelBadge(row.alertLevel)}</td>
          <td class="mono">${formatNumber(row.ma100)}</td>
          <td class="mono">${formatNumber(row.ma200)}</td>
          <td class="mono">${formatNumber(row.currentPrice)}</td>
          <td>${escapeHtml(row.signalStatus)}</td>
          <td>${escapeHtml(row.note)}</td>
        </tr>
      `;
      if (!expanded) return signalRow;
      return `${signalRow}
        <tr class="chart-row">
          <td colspan="9">
            <div class="chart-shell" id="${chartElementId(key)}">
              <div class="chart-loading">正在读取 ${escapeHtml(row.symbol)} ${escapeHtml(row.intervalCode)} 全部K线缓存...</div>
            </div>
          </td>
        </tr>`;
    })
    .join("");

  bindRowClicks();
  if (state.expandedKey) {
    const expandedRow = rows.find((row) => rowKey(row) === state.expandedKey);
    if (expandedRow) loadAndRenderChart(expandedRow);
  }
}

function renderMultiHistory() {
  const target = $("#multiHistoryRows");
  if (!target) return;
  if (!state.multiHistory.length) {
    target.innerHTML = '<div class="heat-empty">暂无多周期历史记录。</div>';
    return;
  }
  target.innerHTML = state.multiHistory
    .map((item) => `
      <article class="multi-history-row">
        <div>
          <strong>${escapeHtml(item.symbol)}</strong>
          <span>${escapeHtml(item.categoryLabel || item.baseAsset || "--")}</span>
        </div>
        <div><span>周期数</span><b>${escapeHtml(item.multiMatchCount)}</b></div>
        <div><span>周期</span><b>${escapeHtml(item.intervals || "--")}</b></div>
        <div><span>最高等级</span><b>${escapeHtml(LABELS.level[item.bestAlertLevel] || item.bestAlertLevel || "--")}</b></div>
        <div><span>首次触发</span><b>${formatTime(item.firstTriggeredAt)}</b></div>
        <div><span>最近触发</span><b>${formatTime(item.lastTriggeredAt)}</b></div>
        <div class="heat-links">${searchButtons(item.symbol)}</div>
      </article>
    `)
    .join("");
}

async function loadMultiHistory() {
  try {
    const payload = await api("/api/multi-history?limit=80");
    state.multiHistory = payload.items ?? [];
  } catch (error) {
    console.warn("multi history failed", error);
    state.multiHistory = [];
  }
  renderMultiHistory();
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
  for (const button of document.querySelectorAll("[data-symbol]")) {
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

  for (const button of document.querySelectorAll("[data-watch-symbol]")) {
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
        await addWatchItem({ symbol, note: "从均线信号加入" });
        updateSignalWatchButtons();
      } catch {
        button.textContent = "失败";
        setTimeout(updateSignalWatchButtons, 1200);
      } finally {
        button.classList.remove("is-pending");
      }
    });
  }

  for (const link of document.querySelectorAll(".signal-row .mini-link")) {
    link.addEventListener("click", (event) => event.stopPropagation());
  }

  for (const row of document.querySelectorAll(".signal-row")) {
    row.addEventListener("click", () => toggleRow(row.dataset.key));
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
            ${ALL_INTERVALS.map((interval) => `<button class="${state.watchInterval === interval ? "active" : ""}" type="button" data-watch-interval="${interval}">${interval}</button>`).join("")}
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
          <button class="watch-symbol-button" type="button" data-edit-watch="${safeSymbol}">
            <strong>${safeSymbol}</strong>
            <span>${escapeHtml(item.categoryLabel || item.baseAsset || "--")}</span>
          </button>
        </div>
        <div><span>现价</span><div class="mono" data-watch-price="${safeSymbol}">${formatNumber(item.currentPrice)}</div></div>
        <div><span>最新周期</span><div class="mono">${escapeHtml(item.latestInterval || "--")}</div></div>
        <div><span>高于提醒</span><div class="mono">${formatNumber(item.alertAbove)}</div></div>
        <div><span>低于提醒</span><div class="mono">${formatNumber(item.alertBelow)}</div></div>
        <div><span>警报</span><div>${escapeHtml(alertText)}</div></div>
        <div class="watch-actions">
          ${searchButtons(item.symbol)}
          <button class="copy-symbol" type="button" data-remove-watch="${safeSymbol}">移除</button>
        </div>
      </article>
      ${detail}
    `;
  }).join("");

  for (const button of document.querySelectorAll("[data-edit-watch]")) {
    button.addEventListener("click", () => {
      const symbol = button.dataset.editWatch ?? "";
      state.watchExpandedSymbol = state.watchExpandedSymbol === symbol ? null : symbol;
      renderWatchlist();
    });
  }

  for (const button of document.querySelectorAll("[data-watch-interval]")) {
    button.addEventListener("click", () => {
      state.watchInterval = button.dataset.watchInterval ?? "15m";
      renderWatchlist();
    });
  }

  for (const form of document.querySelectorAll("[data-watch-settings]")) {
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      const data = new FormData(form);
      await addWatchItem({
        symbol: form.dataset.watchSettings,
        note: data.get("note") ?? "",
        alertAbove: data.get("alertAbove") ?? "",
        alertBelow: data.get("alertBelow") ?? "",
        alertEnabled: data.get("alertEnabled") === "on"
      });
    });
  }

  for (const button of document.querySelectorAll("[data-remove-watch]")) {
    button.addEventListener("click", async () => {
      await api(`/api/watchlist/${encodeURIComponent(button.dataset.removeWatch)}`, { method: "DELETE" });
      if (state.watchExpandedSymbol === button.dataset.removeWatch) state.watchExpandedSymbol = null;
      await loadWatchlist();
    });
  }

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
        item.latestInterval ?? ""
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
      state.watchlist = [];
      state.watchLoaded = false;
      state.watchError = `关注池读取失败：${error instanceof Error ? error.message : String(error)}`;
      shouldRender = !silent || state.currentView !== "watch";
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
  state.watchlist = payload.items ?? [];
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
  if (state.currentView !== "watch" || !state.watchlist.length) return [];
  const streams = new Set();
  for (const item of state.watchlist) {
    const symbol = String(item.symbol ?? "").toLowerCase();
    if (symbol) streams.add(`${symbol}@ticker`);
  }
  if (state.watchExpandedSymbol) {
    streams.add(`${state.watchExpandedSymbol.toLowerCase()}@kline_${state.watchInterval}`);
  }
  return Array.from(streams);
}

function updateWatchPriceDom(symbol, price, eventTime = Date.now()) {
  const safeSymbol = String(symbol ?? "").toUpperCase();
  const item = state.watchlist.find((entry) => entry.symbol === safeSymbol);
  if (item) {
    item.currentPrice = price;
    item.currentCloseTime = eventTime;
  }
  for (const element of document.querySelectorAll(`[data-watch-price="${CSS.escape(safeSymbol)}"]`)) {
    element.textContent = formatNumber(price);
  }
  for (const element of document.querySelectorAll(`[data-watch-updated="${CSS.escape(safeSymbol)}"]`)) {
    element.textContent = `最新更新时间：${formatTime(eventTime)}`;
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
    klines.push(next);
    if (klines.length > 6000) klines.shift();
    const settings = state.chartState.get(key);
    if (settings) {
      settings.start = chartMaxStart(klines.length, settings.visible);
    }
  } else {
    return;
  }
  const closes = klines.map((item) => item.close).filter(Number.isFinite);
  const target = klines.at(-1);
  target.ma100 = averageRecent(closes, 100);
  target.ma200 = averageRecent(closes, 200);
  drawChartForKey(key);
}

function handleWatchRealtimeMessage(payload) {
  if (payload?.type === "price") {
    const symbol = String(payload.symbol ?? "").toUpperCase();
    const price = Number(payload.price);
    if (symbol && Number.isFinite(price)) updateWatchPriceDom(symbol, price, Number(payload.eventTime ?? Date.now()));
    return;
  }
  if (payload?.type === "kline" && payload.kline) {
    const symbol = String(payload.symbol ?? "").toUpperCase();
    const interval = String(payload.interval ?? payload.kline.i ?? "");
    updateWatchPriceDom(symbol, Number(payload.kline.c), Number(payload.eventTime ?? Date.now()));
    updateChartKline(symbol, interval, payload.kline);
    return;
  }
  const stream = String(payload?.stream ?? "");
  const data = payload?.data ?? payload;
  if (stream.endsWith("@ticker") || data?.e === "24hrTicker") {
    const symbol = String(data.s ?? "").toUpperCase();
    const price = Number(data.c);
    if (symbol && Number.isFinite(price)) updateWatchPriceDom(symbol, price, Number(data.E ?? Date.now()));
    return;
  }
  if (data?.e === "kline" && data.k) {
    const symbol = String(data.s ?? "").toUpperCase();
    const interval = String(data.k.i ?? "");
    updateWatchPriceDom(symbol, Number(data.k.c), Number(data.E ?? Date.now()));
    updateChartKline(symbol, interval, data.k);
  }
}

function updateWatchRealtime() {
  if (state.currentView !== "watch" || !state.watchlist.length) {
    closeWatchRealtime();
    return;
  }
  const streams = watchRealtimeStreams();
  const signature = `local:${state.watchlist.map((item) => item.symbol).join("/")}:${state.watchExpandedSymbol ?? ""}:${state.watchInterval}`;
  if (state.watchRealtimeSocket && state.watchRealtimeSignature === signature) return;
  if (state.watchRealtimeSource && state.watchRealtimeSignature === signature) return;
  closeWatchRealtime();
  state.watchRealtimeSignature = signature;
  if ("EventSource" in window) {
    const source = new EventSource("/api/watchlist/events");
    state.watchRealtimeSource = source;
    source.onmessage = (event) => {
      try {
        handleWatchRealtimeMessage(JSON.parse(event.data));
      } catch (error) {
        console.warn("watch realtime event failed", error);
      }
    };
    source.onerror = () => {
      if (state.currentView !== "watch") return;
      source.close();
      state.watchRealtimeSource = null;
      state.watchRealtimeReconnectTimer = setTimeout(updateWatchRealtime, 3000);
    };
    return;
  }
  if (!streams.length) return;
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
    if (state.currentView !== "watch") return;
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
  document.querySelectorAll("[data-nav-page]").forEach((link) => {
    link.classList.toggle("active", link.dataset.navPage === page);
  });
  if (page === "heat") loadHotRank({ silent: true });
  if (page === "watch") loadWatchlist();
  else closeWatchRealtime();
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
    loadMultiHistory();
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
  for (const input of document.querySelectorAll(".filter-menu input[type='checkbox']")) {
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
  return {
    crosshair: true,
    volume: true,
    ma100: true,
    ma200: true,
    drawTool: null,
    drawings: [],
    draftDrawing: null,
    visible: Math.max(1, dataLength),
    start: 0,
    hoverIndex: null,
    hoverXRatio: null,
    hoverYRatio: null,
    dragging: false,
    dragStartX: 0,
    dragStartStart: 0
  };
}

function chartRightSpaceSlots(visible) {
  if (visible <= 1) return 0;
  return clamp(Math.round(visible * 0.45), 1, visible - 1);
}

function chartMaxStart(length, visible) {
  const rightSpace = chartRightSpaceSlots(visible);
  return Math.max(0, length + rightSpace - visible);
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

async function loadAndRenderChart(row, { force = false } = {}) {
  const key = rowKey(row);
  const shell = document.getElementById(chartElementId(key));
  if (!shell) return;

  try {
    if (force) state.chartCache.delete(key);
    if (!state.chartCache.has(key)) {
      const payload = await api(`/api/klines?symbol=${encodeURIComponent(row.symbol)}&interval=${encodeURIComponent(row.intervalCode)}&limit=all`);
      state.chartCache.set(key, payload);
      state.chartState.set(key, chartDefaults(payload.klines.length));
    }
    const payload = state.chartCache.get(key);
    const settings = state.chartState.get(key) ?? chartDefaults(payload.klines.length);
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
          <span>${payload.klines.length} 根缓存 · 滚轮缩放 · 拖拽平移 · 画线辅助观察</span>
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
    const length = payload.klines.length;
    const minVisible = Math.min(length, 30);
    const rect = canvas.getBoundingClientRect();
    const layout = chartLayout(rect.width, rect.height || 430, settings);
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

  canvas.addEventListener("mousedown", (event) => {
    const settings = state.chartState.get(key);
    const payload = state.chartCache.get(key);
    if (!settings || !payload) return;
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
    settings.dragging = true;
    settings.dragStartX = event.clientX;
    settings.dragStartStart = settings.start;
  });

  canvas.addEventListener("mousemove", (event) => {
    const settings = state.chartState.get(key);
    const payload = state.chartCache.get(key);
    if (!settings || !payload) return;

    if (settings.dragging) {
      const rect = canvas.getBoundingClientRect();
      const layout = chartLayout(rect.width, rect.height || 430, settings);
      const slot = layout.width / Math.max(1, settings.visible);
      const movedSlots = Math.round((event.clientX - settings.dragStartX) / slot);
      settings.start = clamp(settings.dragStartStart - movedSlots, 0, chartMaxStart(payload.klines.length, settings.visible));
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

  canvas.addEventListener("mouseup", () => finishChartPointer(key));
  canvas.addEventListener("mouseleave", () => {
    const settings = state.chartState.get(key);
    if (!settings) return;
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
}

function chartPointFromEvent(canvas, key, event) {
  const settings = state.chartState.get(key);
  const payload = state.chartCache.get(key);
  if (!settings || !payload) return null;
  const rect = canvas.getBoundingClientRect();
  const layout = chartLayout(rect.width, rect.height || 430, settings);
  const ratio = clamp((event.clientX - rect.left - layout.plotLeft) / (layout.plotRight - layout.plotLeft), 0, 1);
  const slotIndex = Math.min(settings.visible - 1, Math.floor(settings.visible * ratio));
  const index = clamp(settings.start + slotIndex, 0, Math.max(0, payload.klines.length - 1));
  return {
    index,
    xRatio: ratio,
    yRatio: clamp((event.clientY - rect.top - layout.plotTop) / Math.max(1, layout.plotBottom - layout.plotTop), 0, 1)
  };
}

function visibleKlines(payload, settings) {
  const length = payload.klines.length;
  settings.visible = clamp(settings.visible, 1, Math.max(1, length));
  settings.start = clamp(settings.start, 0, chartMaxStart(length, settings.visible));
  return payload.klines.slice(settings.start, Math.min(length, settings.start + settings.visible));
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

  const prices = data
    .flatMap((item) => [item.high, item.low, settings.ma100 ? item.ma100 : null, settings.ma200 ? item.ma200 : null])
    .filter(Number.isFinite);
  const minPrice = Math.min(...prices);
  const maxPrice = Math.max(...prices);
  const pad = (maxPrice - minPrice || maxPrice || 1) * 0.08;
  const priceMin = minPrice - pad;
  const priceMax = maxPrice + pad;
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

  const maxVolume = Math.max(...data.map((item) => item.volume), 1);
  data.forEach((item, index) => {
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
      data.map((item, index) => (Number.isFinite(item.ma100) ? { x: plotLeft + slot * index + slot / 2, y: y(item.ma100) } : null)),
      palette.ma100,
      2
    );
  }
  if (settings.ma200) {
    drawLine(
      ctx,
      data.map((item, index) => (Number.isFinite(item.ma200) ? { x: plotLeft + slot * index + slot / 2, y: y(item.ma200) } : null)),
      palette.ma200,
      2
    );
  }

  const last = data.at(-1);
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

    const changePct = item.open ? ((item.close - item.open) / item.open) * 100 : null;
    const lines = [
      new Date(item.openTime).toLocaleString("zh-CN", { hour12: false }),
      `O ${formatNumber(item.open, 4)}   H ${formatNumber(item.high, 4)}`,
      `L ${formatNumber(item.low, 4)}   C ${formatNumber(item.close, 4)}   ${formatPercent(changePct)}`,
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
  const trailingSpace = Math.max(0, settings.start + settings.visible - payload.klines.length);
  const rangeLabel = `范围 ${settings.start + 1}-${settings.start + data.length}/${payload.klines.length}${trailingSpace ? ` +${trailingSpace}空白` : ""}`;
  const rangeWidth = ctx.measureText(rangeLabel).width;
  ctx.fillText(rangeLabel, Math.max(plotLeft + 190, plotRight - rangeWidth), cssHeight - 12);
}

for (const input of document.querySelectorAll(".filter-menu input[type='checkbox']")) {
  input.addEventListener("change", () => setFilter(input.dataset.filter, input.dataset.value, input.checked));
}

for (const button of document.querySelectorAll(".page-size .page-size-btn")) {
  button.addEventListener("click", () => {
    state.pageSize = Number(button.dataset.size);
    state.page = 1;
    document.querySelectorAll(".page-size .page-size-btn").forEach((item) => item.classList.toggle("active", item === button));
    refreshAll({ keepPage: true });
  });
}

for (const button of document.querySelectorAll("[data-heat-chain]")) {
  button.addEventListener("click", async () => {
    state.hotRankChain = button.dataset.heatChain ?? "all";
    await loadHotRank();
  });
}

$("#refreshHotRankBtn")?.addEventListener("click", () => loadHotRank());
$("#refreshWatchBtn")?.addEventListener("click", () => loadWatchlist());

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

window.addEventListener("resize", () => {
  if (state.expandedKey) drawChartForKey(state.expandedKey);
});

updateFilterControls();
setPage(pageFromHash());
void bootstrap();
await refreshAll({ keepPage: false });
loadHotRank();
loadWatchlist();
setInterval(() => loadHotRank({ silent: true }), 5 * 60 * 1000);
setInterval(() => {
  if (state.currentView === "watch") loadWatchlist({ silent: true });
}, 60 * 1000);
setInterval(() => refreshAll({ keepPage: true }), 5000);
