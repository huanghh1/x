import { api } from "../api.js";
import {
  TOKEN_CODEX_PROMPT_TEMPLATE,
  normalizeTokenCodexTemplate,
  tokenCodexTemplateLabel
} from "../constants.js";
import { state } from "../state.js";
import { escapeHtml } from "../utils/dom.js";
import {
  chartPalette,
  clamp,
  cssEscape,
  formatCompactNumber,
  formatNumber,
  formatPercent,
  formatTime,
  oiChangeSummary
} from "../utils/format.js";

let copyTextHandler = async () => {};
let signalProfileResolver = () => ({ label: "观察" });

export function configureKlineChart({ copyText, signalProfile } = {}) {
  if (typeof copyText === "function") copyTextHandler = copyText;
  if (typeof signalProfile === "function") signalProfileResolver = signalProfile;
}

export function chartElementId(key) {
  return `chart-${key.replace(/[^a-zA-Z0-9_-]/g, "-")}`;
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

export function intervalMsFromCode(intervalCode) {
  return {
    "15m": 15 * 60 * 1000,
    "1h": 60 * 60 * 1000,
    "4h": 4 * 60 * 60 * 1000,
    "1d": 24 * 60 * 60 * 1000
  }[intervalCode] ?? 60 * 60 * 1000;
}

function buildChartKlines(klines, intervalCode) {
  const source = Array.isArray(klines) ? klines : [];
  if (source.length < 2) return source.map((item) => ({ ...item, isGap: false }));
  const intervalMs = intervalMsFromCode(intervalCode);
  const chartRows = [];
  let previous = null;
  for (const item of source) {
    const next = { ...item, isGap: false };
    if (previous) {
      const missingSlots = Math.round((Number(item.openTime) - Number(previous.openTime)) / intervalMs) - 1;
      if (missingSlots > 0) {
        next.gapBefore = true;
        next.gapMissingSlots = missingSlots;
      }
    }
    chartRows.push(next);
    previous = item;
  }
  return chartRows;
}

function chartKlines(payload) {
  if (!payload) return [];
  if (!payload._chartKlines) payload._chartKlines = buildChartKlines(payload.klines, payload.intervalCode);
  return payload._chartKlines;
}

export function chartKlineLength(payload) {
  return chartKlines(payload).length;
}

function tokenCodexKey(symbol, intervalCode, promptTemplate = state.tokenCodexTemplate) {
  return `${String(symbol ?? "").toUpperCase()}|${intervalCode || "1h"}|${normalizeTokenCodexTemplate(promptTemplate)}`;
}

function signalContextForToken(symbol, intervalCode) {
  const row = state.signals.find((item) => String(item.symbol ?? "").toUpperCase() === String(symbol ?? "").toUpperCase());
  if (!row) return null;
  const details = Array.isArray(row.intervalDetails) ? row.intervalDetails : [];
  const selectedDetail = details.find((item) => item.intervalCode === intervalCode) ?? details[0] ?? row;
  const triggered = details
    .filter((item) => ["LEVEL1", "LEVEL2"].includes(item.alertLevel))
    .map((item) => ({
      intervalCode: item.intervalCode,
      alertLevel: item.alertLevel,
      currentPrice: item.currentPrice,
      ma100: item.ma100,
      ma200: item.ma200,
      signalTime: item.signalTime || item.updatedAt
    }));
  return {
    categoryLabel: row.categoryLabel,
    bestAlertLevel: row.bestAlertLevel || row.alertLevel,
    profile: signalProfileResolver(row).label,
    multiMatchCount: row.multiMatchCount,
    hotRankHit: Boolean(Number(row.hotRankHit ?? 0)),
    fundingOneHour: Boolean(row.fundingOneHour),
    oiMatched: Boolean(row.oiMatched ?? row.oiSpikeHit),
    oiChange: oiChangeSummary(row),
    selectedInterval: selectedDetail.intervalCode || intervalCode,
    selectedPrice: selectedDetail.currentPrice,
    selectedMa100: selectedDetail.ma100,
    selectedMa200: selectedDetail.ma200,
    triggered
  };
}

function buildYokaiResearchPrompt(symbol, intervalCode) {
  const safeSymbol = String(symbol ?? "").trim().toUpperCase() || "当前交易对";
  const baseAsset = safeSymbol.replace(/USDT$/, "") || safeSymbol;
  return [
    `请帮我对 ${safeSymbol}（base asset: ${baseAsset}）做一次“妖币 / 庄控风险”排查。`,
    "",
    "先确认币种身份：Binance 合约 symbol、是否 Binance Alpha、是否有现货、是否有合约、主要链、合约地址、DEX 池子、market cap / FDV / liquidity / volume。仅靠 symbol 可能重名，必须优先用合约地址或 Binance/DEX 页面交叉确认。",
    "",
    "核心检查维度：",
    "1. 筹码集中：Top10 holder 占比、Top holder 类型、是否需要排除 CEX 热钱包、LP、staking、bridge、项目锁仓或做市地址。",
    "2. Bundler / 机器人 / 同源钱包：部署者、早期买入钱包、同秒注资、同源资金、批量钱包痕迹；查不到就写缺失。",
    "3. OI/MCap：合约 OI value 与市值或流通市值的比例；OI/MCap > 3x 属于高风险信号。",
    "4. Vol/OI：成交额相对 OI 的异常程度；Vol/OI > 20x 时要警惕刷量或高频对倒。",
    "5. 资金费率陷阱：持续深度负费率 < -0.05% 且价格抗跌/OI 上升，偏诱空或挤压蓄力；费率转正后要观察是否出货。",
    "6. 订单簿结构：Bid-Ask 是否失衡、Ask 是否变薄、拉盘前上方卖压是否被快速吃掉；没有盘口数据就写缺失。",
    "7. wallet -> CEX：项目方、早期大户或异常钱包是否向 CEX 转入；没有地址标签或转账证据就写缺失。",
    "8. 价格结构：是否处在区间底部、横盘吸筹、挤压蓄力、快速拉高、急跌出货或双向收割阶段。",
    "",
    "评分权重：筹码集中 25 分，资金费率异常 20 分，OI/MCap 异常 15 分，Vol/OI 刷量嫌疑 15 分，价格接近区间底部或挤压蓄力位置 10 分，Bundler/机器人/同源钱包 10 分，订单簿结构 5 分，总分 0-100。",
    "",
    "操盘模式识别：",
    "- 挤压式：建仓 -> 诱饵拉盘 -> 深度负费率引空 -> 挤压爆空 -> 反手做空。",
    "- 拉盘砸盘式：无充分横盘 -> 机器人钱包同秒注资 -> 急拉 ATH -> 快速崩盘。",
    "- 一鱼双吃：慢磨吞 Ask -> 空平多追 -> 一针砸盘 -> 双向收割。",
    "没有对应证据就写不成立。",
    "",
    "请按这个格式输出，不要扩成长篇报告：",
    "妖币/庄控结论：给 0-100 分；写风险等级低/中/高；写当前阶段：建仓、诱空、挤压、出货或不成立；用 1-3 句话说明。",
    "证据链：列 2-5 条，必须引用具体数据和来源链接/来源名称。",
    "反证与缺失：列真实反证和缺失数据，尤其是 Top10、Bundler、Alpha/Futures、链、MCap、订单簿、wallet->CEX。",
    "操盘模式：判断更像挤压式、拉盘砸盘式、一鱼双吃或不成立；说明触发下一阶段还差什么确认。",
    "退出/警戒信号：检查费率转正、OI 跌价涨、大额 wallet->CEX、价格放量失守关键位；没有数据就写缺失。",
    "执行建议：明确写试多、试空、等待确认或暂时放弃；给 1-3 条触发条件、失效条件和风控位置。"
  ].join("\n");
}

function tokenCodexContext(symbol, intervalCode) {
  const safeSymbol = String(symbol ?? "").toUpperCase();
  const funding = state.fundingTokens.find((item) => String(item.symbol ?? "").toUpperCase() === safeSymbol);
  const oi = state.ioData.find((item) => String(item.symbol ?? "").toUpperCase() === safeSymbol);
  const watch = state.watchlist.find((item) => String(item.symbol ?? "").toUpperCase() === safeSymbol);
  const signal = signalContextForToken(safeSymbol, intervalCode);
  return {
    chartInterval: intervalCode,
    page: state.currentView,
    signal,
    funding: funding
      ? {
          currentFundingRate: funding.currentFundingRate,
          fundingIntervalHours: funding.fundingIntervalHours,
          intervals: funding.intervals,
          multiCycleCount: funding.multiCycleCount,
          hotRank: Boolean(funding.hotRank),
          oiSpike: Boolean(funding.oiSpike),
          lastChangedAt: funding.lastChangedAt || funding.lastSeenAt
        }
      : null,
    openInterest: oi
      ? {
          window: state.ioWindow,
          changePercent: oi.changePercent,
          currentOpenInterest: oi.currentOpenInterest,
          currentOpenInterestValue: oi.currentOpenInterestValue,
          observedAt: oi.observedAt,
          isStale: Boolean(oi.isStale),
          matches: {
            hotRankHit: Boolean(oi.hotRankHit),
            fundingOneHour: Boolean(oi.fundingOneHour),
            multiCycleCount: oi.multiCycleCount
          }
        }
      : null,
    watchlist: watch
      ? {
          note: watch.note,
          alertEnabled: Boolean(watch.alertEnabled),
          alertAbove: watch.alertAbove,
          alertBelow: watch.alertBelow,
          latestInterval: watch.latestInterval,
          unlockStatus: watch.unlockStatus,
          nextUnlockAt: watch.nextUnlockAt
        }
      : null
  };
}

function tokenCodexPanelHtml(symbol, intervalCode, promptTemplate = state.tokenCodexTemplate) {
  const safeTemplate = normalizeTokenCodexTemplate(promptTemplate);
  const key = tokenCodexKey(symbol, intervalCode, safeTemplate);
  const entry = state.tokenCodex.get(key);
  if (!entry) return "";
  const templateLabel = tokenCodexTemplateLabel(safeTemplate);
  const status = entry.loading
    ? "分析中"
    : entry.error
      ? "失败"
      : entry.result?.generatedAt
        ? `完成 ${formatTime(entry.result.generatedAt)}`
        : "等待";
  const content = entry.loading
    ? "Codex 正在结合当前 K 线和页面信号分析这个币，请稍等。"
    : entry.error
      ? entry.error
      : entry.result?.analysis || "暂无分析结果。";
  return `
    <section class="chart-codex-panel ${entry.error ? "is-error" : ""}" data-token-codex-panel="${escapeHtml(key)}">
      <div class="chart-codex-head">
        <strong>Codex 看币 · ${escapeHtml(templateLabel)}</strong>
        <span>${escapeHtml(status)}</span>
      </div>
      <pre>${escapeHtml(content)}</pre>
    </section>
  `;
}

async function runTokenCodexAnalysis(symbol, intervalCode) {
  const safeSymbol = String(symbol ?? "").toUpperCase();
  const safeInterval = intervalCode || "1h";
  const safeTemplate = TOKEN_CODEX_PROMPT_TEMPLATE;
  if (!safeSymbol) return;
  const key = tokenCodexKey(safeSymbol, safeInterval, safeTemplate);
  const requestId = Number(state.tokenCodex.get(key)?.requestId ?? 0) + 1;
  state.tokenCodex.set(key, {
    loading: true,
    error: "",
    result: null,
    requestId
  });
  await loadAndRenderChart({ symbol: safeSymbol, intervalCode: safeInterval });
  try {
    const payload = await api("/api/token-analysis/codex", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        symbol: safeSymbol,
        intervalCode: safeInterval,
        promptTemplate: safeTemplate,
        context: tokenCodexContext(safeSymbol, safeInterval)
      })
    });
    if (state.tokenCodex.get(key)?.requestId !== requestId) return;
    state.tokenCodex.set(key, {
      loading: false,
      error: "",
      result: payload,
      requestId
    });
  } catch (error) {
    if (state.tokenCodex.get(key)?.requestId !== requestId) return;
    state.tokenCodex.set(key, {
      loading: false,
      error: error instanceof Error ? error.message : String(error),
      result: null,
      requestId
    });
  } finally {
    if (state.tokenCodex.get(key)?.requestId === requestId) {
      await loadAndRenderChart({ symbol: safeSymbol, intervalCode: safeInterval });
    }
  }
}

export async function loadAndRenderChart(row, { force = false } = {}) {
  const key = `${row.symbol}|${row.intervalCode}`;
  const shell = document.getElementById(chartElementId(key));
  if (!shell) return;

  try {
    if (force) state.chartCache.delete(key);
    const cached = state.chartCache.get(key);
    const shouldRefreshCached =
      cached?.needsRefresh && Date.now() - Number(cached._fetchedAt ?? 0) > 60_000;
    if (shouldRefreshCached) state.chartCache.delete(key);
    if (!state.chartCache.has(key)) {
      const payload = await api(`/api/klines?symbol=${encodeURIComponent(row.symbol)}&interval=${encodeURIComponent(row.intervalCode)}&limit=all`);
      payload._fetchedAt = Date.now();
      state.chartCache.set(key, payload);
      state.chartState.set(key, chartDefaults(chartKlineLength(payload)));
    }
    const realtimeKline = state.realtimeKlines.get(key);
    if (realtimeKline) updateChartKline(row.symbol, row.intervalCode, realtimeKline);
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
    const currentStatus = payload.hasCurrentKline
      ? " · 含当前未收盘K线"
      : " · 等待当前K线实时推送";
    const codexEntry = state.tokenCodex.get(tokenCodexKey(row.symbol, row.intervalCode));
    shell.innerHTML = `
      <div class="chart-toolbar">
        <div class="chart-title-block">
          <strong>${escapeHtml(row.symbol)} ${escapeHtml(row.intervalCode)} K线</strong>
          <span>已收盘 ${payload.cachedCount ?? payload.klines.length} 根 / 目标 ${payload.expectedCount ?? "--"} 根${currentStatus}${payload.gapCount ? ` · 历史缺口 ${payload.gapCount} 段/${payload.missingKlineCount} 根` : ""}${payload.isStale ? " · 最新已收盘K线落后，已请求后台补齐" : ""} · ${payload.hasMa200 ? "MA200 可用" : "新币历史不足 200 根"} · 按住图表自由平移，滚轮缩放时间轴，右侧价格轴单独缩放</span>
        </div>
        <div class="chart-tools" role="toolbar" aria-label="K线工具">
          <button class="${settings.crosshair ? "active" : ""}" type="button" data-tool="crosshair" title="显示或隐藏十字线">十字线</button>
          <button class="${settings.volume ? "active" : ""}" type="button" data-tool="volume" title="显示或隐藏成交量">成交量</button>
          <button class="${settings.ma100 ? "active" : ""}" type="button" data-tool="ma100" title="显示或隐藏 MA100">MA100</button>
          <button class="${settings.ma200 ? "active" : ""}" type="button" data-tool="ma200" title="显示或隐藏 MA200">MA200</button>
          <button class="chart-yokai-copy" type="button" data-tool="copy-yokai-prompt" data-token-codex-symbol="${escapeHtml(row.symbol)}" data-token-codex-interval="${escapeHtml(row.intervalCode)}" title="复制当前交易对的妖币排查话术">复制妖币话术</button>
          <button class="${codexEntry ? "active" : ""}" type="button" data-tool="token-codex" data-token-codex-symbol="${escapeHtml(row.symbol)}" data-token-codex-interval="${escapeHtml(row.intervalCode)}" title="让 Codex 看这个币的图表和信号" ${codexEntry?.loading ? "disabled" : ""}>${codexEntry?.loading ? "分析中" : "Codex看币"}</button>
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
        ${last?.isOpen ? '<span class="chart-meta-chip">当前K线</span>' : ""}
      </div>
      <canvas class="kline-canvas" data-key="${escapeHtml(key)}"></canvas>
      ${tokenCodexPanelHtml(row.symbol, row.intervalCode)}
    `;

    bindChartTools(shell, key);
    drawChartForKey(key);
    scheduleChartRefreshIfNeeded(key, row, payload);
  } catch (error) {
    shell.innerHTML = `<div class="chart-loading">K线读取失败：${escapeHtml(error instanceof Error ? error.message : String(error))}</div>`;
  }
}

function scheduleChartRefreshIfNeeded(key, row, payload) {
  if (!payload?.needsRefresh) {
    state.chartRefreshAttempts.delete(key);
    const timer = state.chartRefreshTimers.get(key);
    if (timer) clearTimeout(timer);
    state.chartRefreshTimers.delete(key);
    return;
  }
  if (state.chartRefreshTimers.has(key)) return;
  const attempts = Number(state.chartRefreshAttempts.get(key) ?? 0);
  if (attempts >= 6) return;
  const delayMs = attempts === 0 ? 12_000 : 25_000;
  const timer = setTimeout(() => {
    state.chartRefreshTimers.delete(key);
    state.chartRefreshAttempts.set(key, attempts + 1);
    const shell = document.getElementById(chartElementId(key));
    if (!shell) return;
    loadAndRenderChart(row, { force: true });
  }, delayMs);
  state.chartRefreshTimers.set(key, timer);
}

function bindChartTools(shell, key) {
  for (const button of shell.querySelectorAll("[data-tool]")) {
    button.addEventListener("click", async () => {
      const tool = button.dataset.tool;
      if (tool === "copy-yokai-prompt") {
        const originalText = button.textContent;
        try {
          await copyTextHandler(buildYokaiResearchPrompt(button.dataset.tokenCodexSymbol, button.dataset.tokenCodexInterval));
          button.textContent = "已复制";
          setTimeout(() => {
            button.textContent = originalText || "复制妖币话术";
          }, 1200);
        } catch {
          button.textContent = "复制失败";
        }
        return;
      }
      if (tool === "token-codex") {
        void runTokenCodexAnalysis(button.dataset.tokenCodexSymbol, button.dataset.tokenCodexInterval);
        return;
      }
      const settings = state.chartState.get(key);
      if (!settings) return;
      if (["crosshair", "volume", "ma100", "ma200"].includes(tool)) settings[tool] = !settings[tool];
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
    beginChartDrag(canvas, key, event, payload, settings, event.pointerId);
  });

  canvas.addEventListener("pointermove", (event) => {
    const settings = state.chartState.get(key);
    const payload = state.chartCache.get(key);
    if (!settings || !payload) return;

    if (settings.dragging) {
      updateChartDrag(canvas, key, event, payload, settings);
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
    beginChartDrag(canvas, key, event, payload, settings);
  });

  canvas.addEventListener("mousemove", (event) => {
    const settings = state.chartState.get(key);
    const payload = state.chartCache.get(key);
    if (!settings?.dragging || !payload) return;
    updateChartDrag(canvas, key, event, payload, settings);
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

function beginChartDrag(canvas, key, event, payload, settings, pointerId = null) {
  const rect = canvas.getBoundingClientRect();
  const layout = chartLayout(rect.width, rect.height || 430, settings);
  settings.dragging = true;
  settings.activePointerId = pointerId;
  settings.dragMode = event.clientX - rect.left >= layout.plotRight ? "price-scale" : "chart-pan";
  settings.dragStartX = event.clientX;
  settings.dragStartY = event.clientY;
  settings.dragStartStart = settings.start;
  settings.dragStartScale = settings.priceScale;
  settings.dragStartOffset = settings.priceOffset;
  settings.dragStartSpan = chartPriceRange(payload, settings).baseSpan * settings.priceScale;
  canvas.classList.add("is-dragging");
}

function updateChartDrag(canvas, key, event, payload, settings) {
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
  for (let index = 0; index < data.length; index += 1) {
    const item = data[index];
    if (!item?.gapBefore) continue;
    const x = layout.plotLeft + slot * index;
    const width = Math.max(2, Math.min(slot * 0.48, 10));
    ctx.save();
    ctx.fillStyle = palette.gridStrong;
    ctx.globalAlpha = 0.34;
    ctx.fillRect(x - width / 2, layout.plotTop, width, layout.height);
    if (layout.volumeHeight) ctx.fillRect(x - width / 2, layout.volumeTop, width, layout.volumeHeight);
    ctx.setLineDash([4, 4]);
    ctx.strokeStyle = palette.muted;
    ctx.globalAlpha = 0.7;
    ctx.beginPath();
    ctx.moveTo(x, layout.plotTop);
    ctx.lineTo(x, layout.plotBottom);
    ctx.stroke();
    ctx.restore();
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

export function drawChartForKey(key) {
  const payload = state.chartCache.get(key);
  const settings = state.chartState.get(key);
  const canvas = document.querySelector(`.kline-canvas[data-key="${cssEscape(key)}"]`);
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

    const lines = [
      new Date(item.openTime).toLocaleString("zh-CN", { hour12: false }),
      `O ${formatNumber(item.open, 4)}   H ${formatNumber(item.high, 4)}`,
      `L ${formatNumber(item.low, 4)}   C ${formatNumber(item.close, 4)}   ${formatPercent(item.open ? ((item.close - item.open) / item.open) * 100 : null)}`,
      item.gapBefore
        ? `前方缺失 ${formatNumber(item.gapMissingSlots, 0)} 根K线   MA100 ${formatNumber(item.ma100, 4)}   MA200 ${formatNumber(item.ma200, 4)}`
        : `V ${formatCompactNumber(item.volume)}   MA100 ${formatNumber(item.ma100, 4)}   MA200 ${formatNumber(item.ma200, 4)}`
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
