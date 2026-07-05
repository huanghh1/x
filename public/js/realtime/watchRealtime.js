import { ALL_INTERVALS } from "../constants.js";
import { state } from "../state.js";
import { updateChartKline } from "../chart/klineChart.js";
import { rowKey, updateSignalPriceChangeDom, updateSignalPriceDom } from "../pages/signals.js";
import { updateWatchPriceDom } from "../pages/watchlist.js";
import { cssEscape, formatNumber, formatPercent, formatTime } from "../utils/format.js";

const PRICE_DOM_UPDATE_INTERVAL_MS = 30_000;
const queuedRealtimePriceUpdates = new Map();
const lastRealtimePriceDomUpdatedAt = new Map();
let realtimePriceDomFlushTimer = null;
let realtimePriceDomFlushDueAt = 0;

function clearRealtimePriceDomFlushTimer() {
  if (!realtimePriceDomFlushTimer) return;
  clearTimeout(realtimePriceDomFlushTimer);
  realtimePriceDomFlushTimer = null;
  realtimePriceDomFlushDueAt = 0;
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
  clearRealtimePriceDomFlushTimer();
  queuedRealtimePriceUpdates.clear();
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
  return true;
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

function updatePriceChangeDom(selector, value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return;
  for (const element of document.querySelectorAll(selector)) {
    element.textContent = formatPercent(number);
    element.classList.toggle("up", number > 0);
    element.classList.toggle("down", number < 0);
  }
}

function updateMarketPriceChangeDom(symbol, priceChange24hPct) {
  const safeSymbol = String(symbol ?? "").toUpperCase();
  const number = Number(priceChange24hPct);
  if (!safeSymbol || !Number.isFinite(number)) return;
  for (const item of [...state.fundingTokens, ...state.ioData, ...state.ioRealtimeRows]) {
    if (String(item.symbol ?? "").toUpperCase() === safeSymbol) item.priceChange24hPct = number;
  }
  const selectorSymbol = cssEscape(safeSymbol);
  updatePriceChangeDom(`[data-market-24h="${selectorSymbol}"]`, number);
}

function updateWatchPriceChangeDom(symbol, priceChange24hPct) {
  const safeSymbol = String(symbol ?? "").toUpperCase();
  const number = Number(priceChange24hPct);
  if (!safeSymbol || !Number.isFinite(number)) return;
  for (const item of state.watchlist) {
    if (String(item.symbol ?? "").toUpperCase() === safeSymbol) item.priceChange24hPct = number;
  }
  const selectorSymbol = cssEscape(safeSymbol);
  updatePriceChangeDom(`[data-watch-24h="${selectorSymbol}"]`, number);
}

function updateRealtimePriceDom({ symbol, price, eventTime, priceChange24hPct = null }) {
  updateWatchPriceDom(symbol, price, eventTime);
  updateSignalPriceDom(symbol, price, eventTime);
  updateMarketPriceDom(symbol, price, eventTime);
  updateWatchPriceChangeDom(symbol, priceChange24hPct);
  updateSignalPriceChangeDom(symbol, priceChange24hPct);
  updateMarketPriceChangeDom(symbol, priceChange24hPct);
}

function scheduleRealtimePriceDomFlush(delayMs) {
  const safeDelayMs = Math.max(0, delayMs);
  const dueAt = Date.now() + safeDelayMs;
  if (realtimePriceDomFlushTimer && realtimePriceDomFlushDueAt <= dueAt) return;
  clearRealtimePriceDomFlushTimer();
  realtimePriceDomFlushDueAt = dueAt;
  realtimePriceDomFlushTimer = setTimeout(flushRealtimePriceDomUpdates, safeDelayMs);
}

function flushRealtimePriceDomUpdates() {
  clearRealtimePriceDomFlushTimer();
  const now = Date.now();
  let nextDelayMs = null;
  for (const [symbol, update] of queuedRealtimePriceUpdates) {
    const lastUpdatedAt = lastRealtimePriceDomUpdatedAt.get(symbol) ?? 0;
    const remainingMs = lastUpdatedAt ? PRICE_DOM_UPDATE_INTERVAL_MS - (now - lastUpdatedAt) : 0;
    if (remainingMs > 0) {
      nextDelayMs = nextDelayMs === null ? remainingMs : Math.min(nextDelayMs, remainingMs);
      continue;
    }
    queuedRealtimePriceUpdates.delete(symbol);
    lastRealtimePriceDomUpdatedAt.set(symbol, now);
    updateRealtimePriceDom(update);
  }
  if (queuedRealtimePriceUpdates.size) {
    scheduleRealtimePriceDomFlush(nextDelayMs ?? PRICE_DOM_UPDATE_INTERVAL_MS);
  }
}

function updateRealtimePrice(symbol, price, eventTime, priceChange24hPct = null) {
  const safeSymbol = String(symbol ?? "").toUpperCase();
  const numericPrice = Number(price);
  if (!safeSymbol || !Number.isFinite(numericPrice)) return;
  const existing = queuedRealtimePriceUpdates.get(safeSymbol);
  const numericChange = Number(priceChange24hPct);
  queuedRealtimePriceUpdates.set(safeSymbol, {
    symbol: safeSymbol,
    price: numericPrice,
    eventTime,
    priceChange24hPct: Number.isFinite(numericChange) ? numericChange : existing?.priceChange24hPct ?? null
  });
  const lastUpdatedAt = lastRealtimePriceDomUpdatedAt.get(safeSymbol) ?? 0;
  const elapsedMs = Date.now() - lastUpdatedAt;
  if (!lastUpdatedAt || elapsedMs >= PRICE_DOM_UPDATE_INTERVAL_MS) {
    flushRealtimePriceDomUpdates();
    return;
  }
  scheduleRealtimePriceDomFlush(PRICE_DOM_UPDATE_INTERVAL_MS - elapsedMs);
}

function handleWatchRealtimeMessage(payload) {
  if (payload?.type === "price") {
    const symbol = String(payload.symbol ?? "").toUpperCase();
    const price = Number(payload.price);
    if (symbol && Number.isFinite(price)) {
      updateRealtimePrice(symbol, price, Number(payload.eventTime ?? Date.now()), payload.priceChange24hPct);
    }
    return;
  }
  if (payload?.type === "kline" && payload.kline) {
    const symbol = String(payload.symbol ?? "").toUpperCase();
    const interval = String(payload.interval ?? payload.kline.i ?? "");
    const price = Number(payload.kline.c);
    const eventTime = Number(payload.eventTime ?? Date.now());
    if (symbol && Number.isFinite(price)) {
      updateRealtimePrice(symbol, price, eventTime);
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
      updateRealtimePrice(symbol, price, Number(data.E ?? Date.now()), data.P);
    }
    return;
  }
  if (data?.e === "kline" && data.k) {
    const symbol = String(data.s ?? "").toUpperCase();
    const interval = String(data.k.i ?? "");
    const price = Number(data.k.c);
    const eventTime = Number(data.E ?? Date.now());
    if (symbol && Number.isFinite(price)) {
      updateRealtimePrice(symbol, price, eventTime);
    }
    updateChartKline(symbol, interval, data.k);
  }
}

export function updateWatchRealtime() {
  const streams = watchRealtimeStreams();
  if (!streams.length) {
    closeWatchRealtime();
    return;
  }
  if ("EventSource" in window && shouldUseServerRealtimeEvents()) {
    const streamSignature = streams.join("/");
    const signature = `sse:${streamSignature}`;
    if (state.watchRealtimeSource && state.watchRealtimeSignature === signature) return;
    closeWatchRealtime();
    state.watchRealtimeSignature = signature;
    const source = new EventSource(`/api/watchlist/events?streams=${encodeURIComponent(streamSignature)}`);
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
