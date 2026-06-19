import { EventEmitter } from "node:events";
import {
  listWatchlist,
  listRealtimeKlineTokens,
  markWatchlistAlertSent,
  refreshTokenFetchState,
  selectClosePrices,
  updateWatchlistRealtimePrice,
  upsertKlinePage,
  upsertSignal
} from "./db.js";
import { calculateSignal, INTERVALS } from "./ma.js";

const WATCHLIST_STREAM_LIMIT = 1024;
const WATCHLIST_SYNC_MS = 10_000;
const RECONNECT_MS = 3_000;
const PRICE_PERSIST_MS = 2_000;
const ALERT_COOLDOWN_MS = 30 * 60 * 1000;
const KLINE_PERSIST_MS = {
  "15m": 5_000,
  "1h": 15_000,
  "4h": 30_000,
  "1d": 60_000
};

export const watchRealtimeEvents = new EventEmitter();
watchRealtimeEvents.setMaxListeners(100);

const state = {
  socket: null,
  signature: "",
  reconnectTimer: null,
  syncTimer: null,
  rotateTimer: null,
  watchItems: new Map(),
  tokenRows: new Map(),
  lastPricePersistedAt: new Map(),
  lastKlinePersistedAt: new Map(),
  streamCount: 0,
  connectedAt: null,
  lastMessageAt: null,
  lastError: null,
  reconnects: 0,
  running: false,
  alertSender: null
};

function sanitizeSymbol(value) {
  return String(value ?? "").toUpperCase().replace(/[^A-Z0-9_]/g, "");
}

function streamUrl(signature) {
  return `wss://fstream.binance.com/market/stream?streams=${signature}`;
}

function klineToDbRow(kline) {
  return [
    Number(kline.t),
    String(kline.o),
    String(kline.h),
    String(kline.l),
    String(kline.c),
    String(kline.v),
    Number(kline.T),
    kline.q ?? null,
    kline.n ?? null
  ];
}

async function syncWatchlistState() {
  const [items, tokens] = await Promise.all([listWatchlist(), listRealtimeKlineTokens()]);
  state.watchItems = new Map(items.map((item) => [sanitizeSymbol(item.symbol), item]));
  state.tokenRows = new Map(tokens.map((token) => [sanitizeSymbol(token.symbol), token]));
  return { items, tokens };
}

function buildStreams() {
  const streams = [];
  for (const symbol of state.tokenRows.keys()) {
    const lower = symbol.toLowerCase();
    streams.push(`${lower}@ticker`);
    for (const interval of INTERVALS) {
      streams.push(`${lower}@kline_${interval}`);
    }
  }
  return streams.slice(0, WATCHLIST_STREAM_LIMIT);
}

function closeSocket() {
  if (state.reconnectTimer) {
    clearTimeout(state.reconnectTimer);
    state.reconnectTimer = null;
  }
  if (state.rotateTimer) {
    clearTimeout(state.rotateTimer);
    state.rotateTimer = null;
  }
  if (state.socket) {
    state.socket.onclose = null;
    state.socket.onerror = null;
    state.socket.onmessage = null;
    state.socket.close();
  }
  state.socket = null;
  state.connectedAt = null;
}

function scheduleReconnect() {
  if (!state.running || state.reconnectTimer) return;
  state.reconnectTimer = setTimeout(() => {
    state.reconnectTimer = null;
    updateWatchlistRealtime().catch((error) => {
      state.lastError = error instanceof Error ? error.message : String(error);
      scheduleReconnect();
    });
  }, RECONNECT_MS);
}

function shouldPersistPrice(symbol, eventTime) {
  const last = state.lastPricePersistedAt.get(symbol) ?? 0;
  if (eventTime - last < PRICE_PERSIST_MS) return false;
  state.lastPricePersistedAt.set(symbol, eventTime);
  return true;
}

function shouldPersistKline(symbol, interval, isClosed) {
  if (isClosed) return true;
  const key = `${symbol}|${interval}`;
  const now = Date.now();
  const last = state.lastKlinePersistedAt.get(key) ?? 0;
  if (now - last < (KLINE_PERSIST_MS[interval] ?? 30_000)) return false;
  state.lastKlinePersistedAt.set(key, now);
  return true;
}

async function maybeSendPriceAlert(symbol, price, eventTime) {
  const item = state.watchItems.get(symbol);
  if (!item?.alertEnabled) return;
  const lastAlertAt = item.lastAlertAt ? new Date(item.lastAlertAt).getTime() : 0;
  if (eventTime - lastAlertAt < ALERT_COOLDOWN_MS) return;
  const aboveHit = item.alertAbove !== null && item.alertAbove !== undefined && price >= Number(item.alertAbove);
  const belowHit = item.alertBelow !== null && item.alertBelow !== undefined && price <= Number(item.alertBelow);
  if (!aboveHit && !belowHit) return;

  const reason = aboveHit ? `实时价 ${price} 高于提醒价 ${item.alertAbove}` : `实时价 ${price} 低于提醒价 ${item.alertBelow}`;
  const result = state.alertSender ? await state.alertSender({ ...item, currentPrice: price }, reason) : { skipped: true };
  if (!result.skipped) {
    await markWatchlistAlertSent(symbol);
    state.watchItems.set(symbol, { ...item, currentPrice: price, lastAlertAt: new Date(eventTime).toISOString() });
  }
}

async function handleTicker(data) {
  const symbol = sanitizeSymbol(data.s);
  const price = Number(data.c);
  const eventTime = Number(data.E ?? Date.now());
  if (!symbol || !Number.isFinite(price)) return;
  state.lastMessageAt = new Date().toISOString();
  const item = state.watchItems.get(symbol);
  if (item) state.watchItems.set(symbol, { ...item, currentPrice: price, currentCloseTime: eventTime });
  watchRealtimeEvents.emit("price", { type: "price", symbol, price, eventTime });
  if (shouldPersistPrice(symbol, eventTime)) {
    await updateWatchlistRealtimePrice(symbol, price, eventTime);
  }
  await maybeSendPriceAlert(symbol, price, eventTime);
}

async function handleKline(data) {
  const kline = data?.k;
  const symbol = sanitizeSymbol(data?.s);
  const interval = String(kline?.i ?? "");
  const close = Number(kline?.c);
  if (!symbol || !INTERVALS.includes(interval) || !Number.isFinite(close)) return;
  state.lastMessageAt = new Date().toISOString();

  const eventTime = Number(data.E ?? Date.now());
  if (shouldPersistPrice(symbol, eventTime)) {
    await updateWatchlistRealtimePrice(symbol, close, eventTime);
  }
  watchRealtimeEvents.emit("price", { type: "price", symbol, price: close, eventTime });
  watchRealtimeEvents.emit("kline", { type: "kline", symbol, interval, kline, eventTime });
  await maybeSendPriceAlert(symbol, close, eventTime);

  const token = state.tokenRows.get(symbol);
  if (!token || !shouldPersistKline(symbol, interval, Boolean(kline.x))) return;

  await upsertKlinePage(token, interval, [klineToDbRow(kline)]);
  await refreshTokenFetchState(token.id);
  const closes = await selectClosePrices(symbol, interval);
  await upsertSignal(token, calculateSignal({ intervalCode: interval, closes }));
}

async function handleMessage(payload) {
  const data = payload?.data ?? payload;
  if (data?.e === "24hrTicker") {
    await handleTicker(data);
    return;
  }
  if (data?.e === "kline") {
    await handleKline(data);
  }
}

async function updateWatchlistRealtime() {
  if (!state.running) return;
  await syncWatchlistState();
  const streams = buildStreams();
  const signature = streams.join("/");
  state.streamCount = streams.length;

  if (!streams.length) {
    state.signature = "";
    closeSocket();
    return;
  }
  if (state.socket && state.signature === signature) return;

  closeSocket();
  state.signature = signature;
  const socket = new WebSocket(streamUrl(signature));
  state.socket = socket;
  state.reconnects += 1;

  socket.onopen = () => {
    state.connectedAt = new Date().toISOString();
    state.lastError = null;
    state.rotateTimer = setTimeout(() => socket.close(), 23 * 60 * 60 * 1000);
  };
  socket.onmessage = (event) => {
    let payload;
    try {
      payload = JSON.parse(event.data);
    } catch (error) {
      state.lastError = error instanceof Error ? error.message : String(error);
      return;
    }
    handleMessage(payload).catch((error) => {
      state.lastError = error instanceof Error ? error.message : String(error);
      console.error("watchlist realtime message failed", error);
    });
  };
  socket.onerror = (error) => {
    state.lastError = error?.message ?? "watchlist realtime socket error";
    socket.close();
  };
  socket.onclose = () => {
    if (state.socket === socket) {
      state.socket = null;
      state.connectedAt = null;
      scheduleReconnect();
    }
  };
}

export async function refreshWatchlistRealtime() {
  await updateWatchlistRealtime();
}

export async function startWatchlistRealtime({ alertSender } = {}) {
  if (state.running) return getWatchlistRealtimeState();
  state.running = true;
  state.alertSender = alertSender ?? null;
  await updateWatchlistRealtime();
  state.syncTimer = setInterval(() => {
    updateWatchlistRealtime().catch((error) => {
      state.lastError = error instanceof Error ? error.message : String(error);
      console.error("watchlist realtime sync failed", error);
    });
  }, WATCHLIST_SYNC_MS);
  return getWatchlistRealtimeState();
}

export function stopWatchlistRealtime() {
  state.running = false;
  if (state.syncTimer) {
    clearInterval(state.syncTimer);
    state.syncTimer = null;
  }
  closeSocket();
  return getWatchlistRealtimeState();
}

export function getWatchlistRealtimeState() {
  return {
    running: state.running,
    connected: Boolean(state.socket && state.connectedAt),
    streamCount: state.streamCount,
    watchCount: state.watchItems.size,
    connectedAt: state.connectedAt,
    lastMessageAt: state.lastMessageAt,
    lastError: state.lastError,
    reconnects: state.reconnects
  };
}
