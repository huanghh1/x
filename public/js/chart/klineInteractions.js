import { state } from "../state.js";
import { clamp } from "../utils/format.js";
import {
  chartKlineLength,
  chartLayout,
  chartMaxStart
} from "./klineCore.js";
import { buildYokaiResearchPrompt, runTokenCodexAnalysis } from "./klineCodex.js";
import { chartPriceRange, drawChartForKey } from "./klineRenderer.js";

let copyTextHandler = async () => {};

export function configureChartInteractions({ copyText } = {}) {
  if (typeof copyText === "function") copyTextHandler = copyText;
}

export function bindChartTools(shell, key, renderChart) {
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
      renderChart({ symbol: state.chartCache.get(key)?.symbol, intervalCode: state.chartCache.get(key)?.intervalCode });
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
