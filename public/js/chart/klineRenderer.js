import { state } from "../state.js";
import {
  chartPalette,
  clamp,
  cssEscape,
  formatCompactNumber,
  formatNumber,
  formatPercent
} from "../utils/format.js";
import {
  chartKlineLength,
  chartKlines,
  chartLayout,
  chartMaxStart
} from "./klineCore.js";

function visibleKlines(payload, settings) {
  const rows = chartKlines(payload);
  const length = rows.length;
  settings.visible = clamp(settings.visible, 1, Math.max(1, length));
  settings.start = clamp(settings.start, 0, chartMaxStart(length, settings.visible));
  return rows.slice(settings.start, Math.min(length, settings.start + settings.visible));
}

export function chartPriceRange(payload, settings) {
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
