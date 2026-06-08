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

function formatPercent(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return "--";
  return `${number >= 0 ? "+" : ""}${number.toLocaleString("en-US", { maximumFractionDigits: 2 })}%`;
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
    shell.innerHTML = `
      <div class="chart-toolbar">
        <div>
          <strong>${escapeHtml(row.symbol)} ${escapeHtml(row.intervalCode)} K线</strong>
          <span>已显示数据库全部缓存：${payload.klines.length} 根。滚轮缩放，拖拽平移。</span>
        </div>
        <div class="chart-tools">
          <button class="${settings.crosshair ? "active" : ""}" type="button" data-tool="crosshair">十字线</button>
          <button class="${settings.volume ? "active" : ""}" type="button" data-tool="volume">成交量</button>
          <button class="${settings.ma100 ? "active" : ""}" type="button" data-tool="ma100">MA100</button>
          <button class="${settings.ma200 ? "active" : ""}" type="button" data-tool="ma200">MA200</button>
          <button class="${settings.drawTool === "trend" ? "active" : ""}" type="button" data-tool="trend">趋势线</button>
          <button class="${settings.drawTool === "hline" ? "active" : ""}" type="button" data-tool="hline">水平线</button>
          <button type="button" data-tool="clearDrawings">清除画线</button>
          <a href="https://www.tradingview.com/chart/?symbol=${tvSymbol}" target="_blank" rel="noreferrer">TradingView</a>
        </div>
      </div>
      <div class="chart-meta">
        <span>最新收盘：${formatNumber(payload.klines.at(-1)?.close)}</span>
        <span>MA100：${formatNumber(payload.klines.at(-1)?.ma100)}</span>
        <span>MA200：${formatNumber(payload.klines.at(-1)?.ma200)}</span>
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
    const plotLeft = 18;
    const plotRight = Math.max(plotLeft + 10, rect.width - 64);
    const ratio = clamp((event.clientX - rect.left - plotLeft) / (plotRight - plotLeft), 0, 1);
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
      const plotWidth = Math.max(1, rect.width - 72);
      const slot = plotWidth / Math.max(1, settings.visible);
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
  const plotLeft = 18;
  const plotRight = Math.max(plotLeft + 10, rect.width - 64);
  const ratio = clamp((event.clientX - rect.left - plotLeft) / (plotRight - plotLeft), 0, 1);
  const slotIndex = Math.min(settings.visible - 1, Math.floor(settings.visible * ratio));
  const index = clamp(settings.start + slotIndex, 0, Math.max(0, payload.klines.length - 1));
  const plotTop = 18;
  const volumeHeight = settings.volume ? 64 : 0;
  const plotBottom = rect.height - 30 - volumeHeight;
  return {
    index,
    xRatio: ratio,
    yRatio: clamp((event.clientY - rect.top - plotTop) / Math.max(1, plotBottom - plotTop), 0, 1)
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

function drawUserDrawings(ctx, settings, plotLeft, plotRight, plotTop, plotBottom, slot, cssHeight) {
  const drawings = [...settings.drawings, settings.draftDrawing].filter(Boolean);
  if (!drawings.length) return;
  const plotHeight = Math.max(1, plotBottom - plotTop);
  ctx.save();
  ctx.strokeStyle = "#1f7aff";
  ctx.lineWidth = 1.6;
  ctx.setLineDash([6, 4]);
  for (const drawing of drawings) {
    if (drawing.type === "hline") {
      const y = plotTop + drawing.yRatio * plotHeight;
      if (y < plotTop || y > plotBottom) continue;
      ctx.beginPath();
      ctx.moveTo(plotLeft, y);
      ctx.lineTo(plotRight, y);
      ctx.stroke();
      continue;
    }
    const startLocal = drawing.start.index - settings.start;
    const endLocal = drawing.end.index - settings.start;
    if ((startLocal < 0 && endLocal < 0) || (startLocal > settings.visible && endLocal > settings.visible)) continue;
    ctx.beginPath();
    ctx.moveTo(plotLeft + slot * startLocal + slot / 2, plotTop + drawing.start.yRatio * plotHeight);
    ctx.lineTo(plotLeft + slot * endLocal + slot / 2, plotTop + drawing.end.yRatio * plotHeight);
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
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, parentWidth, cssHeight);

  const data = visibleKlines(payload, settings);
  const plotLeft = 18;
  const plotRight = parentWidth - 64;
  const plotTop = 18;
  const volumeHeight = settings.volume ? 64 : 0;
  const plotBottom = cssHeight - 30 - volumeHeight;
  const volumeTop = plotBottom + 18;
  const width = plotRight - plotLeft;
  const height = plotBottom - plotTop;

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
  const candleWidth = Math.max(1, Math.min(10, slot * 0.62));

  ctx.strokeStyle = "#f0e8ee";
  ctx.lineWidth = 1;
  ctx.font = "12px Arial";
  ctx.fillStyle = "#9b8f98";
  for (let i = 0; i <= 4; i += 1) {
    const gy = plotTop + (height / 4) * i;
    ctx.beginPath();
    ctx.moveTo(plotLeft, gy);
    ctx.lineTo(plotRight, gy);
    ctx.stroke();
    const label = priceMax - ((priceMax - priceMin) / 4) * i;
    ctx.fillText(formatNumber(label, 4), plotRight + 8, gy + 4);
  }

  const maxVolume = Math.max(...data.map((item) => item.volume), 1);
  data.forEach((item, index) => {
    const x = plotLeft + slot * index + slot / 2;
    const up = item.close >= item.open;
    const color = up ? "#22b981" : "#ed2a75";
    ctx.strokeStyle = color;
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.moveTo(x, y(item.high));
    ctx.lineTo(x, y(item.low));
    ctx.stroke();
    const bodyTop = y(Math.max(item.open, item.close));
    const bodyBottom = y(Math.min(item.open, item.close));
    ctx.fillRect(x - candleWidth / 2, bodyTop, candleWidth, Math.max(1, bodyBottom - bodyTop));

    if (settings.volume) {
      const volumeBarHeight = (item.volume / maxVolume) * volumeHeight;
      ctx.globalAlpha = 0.24;
      ctx.fillRect(x - candleWidth / 2, volumeTop + volumeHeight - volumeBarHeight, candleWidth, volumeBarHeight);
      ctx.globalAlpha = 1;
    }
  });

  if (settings.ma100) {
    drawLine(
      ctx,
      data.map((item, index) => (Number.isFinite(item.ma100) ? { x: plotLeft + slot * index + slot / 2, y: y(item.ma100) } : null)),
      "#ed2a75",
      1.8
    );
  }
  if (settings.ma200) {
    drawLine(
      ctx,
      data.map((item, index) => (Number.isFinite(item.ma200) ? { x: plotLeft + slot * index + slot / 2, y: y(item.ma200) } : null)),
      "#7d5dfc",
      1.8
    );
  }

  drawUserDrawings(ctx, settings, plotLeft, plotRight, plotTop, plotBottom, slot, cssHeight);

  const hoverLocal = settings.hoverIndex === null ? null : settings.hoverIndex - settings.start;
  if (settings.crosshair && hoverLocal !== null && hoverLocal >= 0 && hoverLocal < data.length) {
    const item = data[hoverLocal];
    const x = plotLeft + clamp(Number(settings.hoverXRatio ?? 0), 0, 1) * (plotRight - plotLeft);
    const hoverY = plotTop + clamp(Number(settings.hoverYRatio ?? 0), 0, 1) * (plotBottom - plotTop);
    const hoverPrice = priceMax - ((hoverY - plotTop) / Math.max(1, plotBottom - plotTop)) * (priceMax - priceMin);
    ctx.strokeStyle = "rgba(33, 23, 33, 0.35)";
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.moveTo(x, plotTop);
    ctx.lineTo(x, plotBottom);
    ctx.moveTo(plotLeft, hoverY);
    ctx.lineTo(plotRight, hoverY);
    ctx.stroke();
    ctx.setLineDash([]);
    const priceLabel = formatNumber(hoverPrice, 4);
    ctx.fillStyle = "#211721";
    ctx.fillRect(plotRight + 4, hoverY - 11, parentWidth - plotRight - 8, 22);
    ctx.fillStyle = "#fff";
    ctx.fillText(priceLabel, plotRight + 8, hoverY + 4);
    const tooltip = `${new Date(item.openTime).toLocaleString("zh-CN", { hour12: false })}  O ${formatNumber(item.open, 4)}  H ${formatNumber(item.high, 4)}  L ${formatNumber(item.low, 4)}  C ${formatNumber(item.close, 4)}`;
    ctx.fillStyle = "rgba(255, 255, 255, 0.95)";
    ctx.strokeStyle = "#eee8ec";
    const tooltipWidth = Math.min(parentWidth - 24, ctx.measureText(tooltip).width + 20);
    const tx = Math.min(parentWidth - tooltipWidth - 12, Math.max(12, x - tooltipWidth / 2));
    ctx.fillRect(tx, 10, tooltipWidth, 28);
    ctx.strokeRect(tx, 10, tooltipWidth, 28);
    ctx.fillStyle = "#211721";
    ctx.fillText(tooltip, tx + 10, 29);
  }

  ctx.fillStyle = "#ed2a75";
  ctx.fillText("MA100", plotLeft, cssHeight - 8);
  ctx.fillStyle = "#7d5dfc";
  ctx.fillText("MA200", plotLeft + 62, cssHeight - 8);
  ctx.fillStyle = "#9b8f98";
  const trailingSpace = Math.max(0, settings.start + settings.visible - payload.klines.length);
  const rangeLabel = `范围 ${settings.start + 1}-${settings.start + data.length}/${payload.klines.length}${trailingSpace ? ` +${trailingSpace}空白` : ""}`;
  ctx.fillText(rangeLabel, plotLeft + 128, cssHeight - 8);
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
