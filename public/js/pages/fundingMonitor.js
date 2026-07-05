import { api } from "../api.js";
import { state } from "../state.js";
import { $, escapeHtml, setText } from "../utils/dom.js";
import {
  formatFundingPercent,
  formatNumber,
  formatTime,
  fundingRateTone,
  oiChangeSummary
} from "../utils/format.js";
import { bindCopyButtons, copyButton, searchButtons } from "../ui/symbolActions.js";

let deps = {
  bindMarketChartControls: () => {},
  bindWatchButtons: () => {},
  loadWatchlist: async () => {},
  marketChartPanel: () => "",
  watchButton: () => ""
};

export function configureFundingMonitor(nextDeps = {}) {
  deps = { ...deps, ...nextDeps };
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
  const parts = [`当前共 ${state.fundingTokens.length} 个 1小时结算资金费率代币`];
  if (positiveCount || negativeCount || neutralCount) {
    parts.push(`正费率 ${positiveCount} / 负费率 ${negativeCount} / 持平或未知 ${neutralCount}`);
  }
  parts.push("按最近变化时间排序");
  return parts.join("，");
}

export async function loadFundingRateTokens({ silent = false } = {}) {
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
    if (Number(payload.watchlistAdded ?? 0) > 0 || Number(payload.watchlistRemoved ?? 0) > 0) {
      void deps.loadWatchlist({ silent: true });
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

export function renderFundingRateTokens() {
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
            ${deps.watchButton(token.symbol, "从资金费率监控加入")}
            ${searchButtons(token.symbol)}
          </div>
        </article>
        ${expanded ? deps.marketChartPanel(token.symbol, state.fundingInterval, "funding") : ""}
      `;
    })
    .join("");
  deps.bindWatchButtons(target);
  bindCopyButtons(target);
  deps.bindMarketChartControls(target, "funding");
  setText("#fundingStatus", state.fundingError ? `列表为上次成功结果，最新读取失败：${state.fundingError}` : fundingStatusText());
}

export async function scanFundingIntervals() {
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

export function bindFundingControls() {
  $("#refreshFundingBtn")?.addEventListener("click", () => loadFundingRateTokens());
  $("#scanFundingBtn")?.addEventListener("click", () => scanFundingIntervals());
}
