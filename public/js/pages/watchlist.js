import { api } from "../api.js";
import { ALL_INTERVALS } from "../constants.js";
import { chartElementId, loadAndRenderChart } from "../chart/klineChart.js";
import { state } from "../state.js";
import { $, escapeHtml, setText } from "../utils/dom.js";
import { cssEscape, formatCompactNumber, formatNumber, formatPercent, formatTime } from "../utils/format.js";
import { bindCopyButtons, copyButton, searchButtons } from "../ui/symbolActions.js";

let deps = {
  updateWatchRealtime: () => {}
};

export function configureWatchlist(nextDeps = {}) {
  deps = { ...deps, ...nextDeps };
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

function watchSymbols() {
  return new Set(state.watchlist.map((item) => String(item.symbol ?? "").toUpperCase()));
}

function isWatchedSymbol(symbol) {
  return watchSymbols().has(String(symbol ?? "").toUpperCase());
}

export function updateSignalWatchButtons() {
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

export function watchButton(symbol, note) {
  const safeSymbol = escapeHtml(symbol);
  const watched = isWatchedSymbol(symbol);
  return `<button class="copy-symbol watch-add ${watched ? "is-added" : ""}" type="button" data-watch-symbol="${safeSymbol}" data-watch-note="${escapeHtml(note)}" title="${watched ? `${safeSymbol} 已在关注池` : `加入关注池：${safeSymbol}`}" aria-pressed="${watched ? "true" : "false"}" ${watched ? "disabled" : ""}>${watched ? "已关注" : "加关注"}</button>`;
}

export function bindWatchButtons(root = document) {
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

export function renderWatchlist() {
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
  deps.updateWatchRealtime();
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

export async function loadWatchlist({ silent = false } = {}) {
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
      deps.updateWatchRealtime();
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
  deps.updateWatchRealtime();
}

export function updateWatchPriceDom(symbol, price, eventTime = Date.now()) {
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

export function bindWatchlistControls() {
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
}
