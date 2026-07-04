export function chartElementId(key) {
  return `chart-${key.replace(/[^a-zA-Z0-9_-]/g, "-")}`;
}

export function chartDefaults(dataLength) {
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

export function chartRightSpaceSlots(visible) {
  if (visible <= 1) return 0;
  return Math.max(1, Math.round(visible * 1.5));
}

export function chartMaxStart(length, visible) {
  if (length <= 0) return 0;
  const rightSpace = chartRightSpaceSlots(visible);
  return Math.max(0, Math.min(length - 1, length + rightSpace - visible));
}

export function chartLayout(width, height, settings) {
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

export function chartKlines(payload) {
  if (!payload) return [];
  if (!payload._chartKlines) payload._chartKlines = buildChartKlines(payload.klines, payload.intervalCode);
  return payload._chartKlines;
}

export function chartKlineLength(payload) {
  return chartKlines(payload).length;
}

export function averageRecent(values, size) {
  if (values.length < size) return null;
  const slice = values.slice(-size);
  return slice.reduce((sum, value) => sum + value, 0) / size;
}
