import { EventEmitter } from "node:events";
import {
  clearWatchlistAlertSide,
  listFundingRealtimeTokens,
  listWatchlist,
  listWatchlistTokens,
  listRealtimeKlineTokens,
  listTopOpenInterestRealtimeTokens,
  markWatchlistAlertSent,
  refreshTokenFetchState,
  selectClosePrices,
  updateWatchlistRealtimePrice,
  upsertKlinePage,
  upsertSignal
} from "./db.js";
import { config } from "./config.js";
import { calculateSignal, INTERVALS } from "./ma.js";

const WATCHLIST_SYNC_MS = 10_000;
const RECONNECT_MS = 3_000;
const PRICE_PERSIST_MS = 2_000;
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
  watchRealtimeSymbols: new Set(),
  backgroundKlineSymbols: new Set(),
  fundingRealtimeSymbols: new Set(),
  fundingRealtimeCount: 0,
  openInterestRealtimeSymbols: new Set(),
  openInterestTopCount: 0,
  clientStreams: new Map(),
  nextClientId: 1,
  clientStreamCount: 0,
  requestedStreamCount: 0,
  truncatedStreamCount: 0,
  lastPricePersistedAt: new Map(),
  lastKlinePersistedAt: new Map(),
  alertingSymbols: new Set(),
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

function normalizeStreamName(value) {
  const stream = String(value ?? "").trim().toLowerCase();
  const match = stream.match(/^([a-z0-9_]+)@(ticker|kline_(15m|1h|4h|1d))$/);
  if (!match) return null;
  const symbol = sanitizeSymbol(match[1]).toLowerCase();
  if (!symbol) return null;
  return `${symbol}@${match[2]}`;
}

export function parseWatchRealtimeStreams(value) {
  const values = Array.isArray(value) ? value : [value];
  const streams = new Set();
  for (const item of values) {
    for (const part of String(item ?? "").split(/[,\s/]+/)) {
      const stream = normalizeStreamName(part);
      if (stream) streams.add(stream);
    }
  }
  return streams;
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
  const [items, klineTokens, watchTokens, fundingRealtimeTokens, openInterestTopTokens] = await Promise.all([
    listWatchlist(),
    listRealtimeKlineTokens(),
    listWatchlistTokens(),
    listFundingRealtimeTokens(),
    listTopOpenInterestRealtimeTokens({ timeWindow: "5m", sort: "desc", limit: 5 })
  ]);
  const tokenMap = new Map();
  for (const token of [...klineTokens, ...watchTokens, ...fundingRealtimeTokens, ...openInterestTopTokens]) {
    const symbol = sanitizeSymbol(token?.symbol);
    if (symbol) tokenMap.set(symbol, token);
  }
  state.watchItems = new Map(items.map((item) => [sanitizeSymbol(item.symbol), item]));
  state.tokenRows = tokenMap;
  state.watchRealtimeSymbols = new Set(watchTokens.map((token) => sanitizeSymbol(token?.symbol)).filter(Boolean));
  state.backgroundKlineSymbols = new Set(klineTokens.map((token) => sanitizeSymbol(token?.symbol)).filter(Boolean));
  state.fundingRealtimeSymbols = new Set(fundingRealtimeTokens.map((token) => sanitizeSymbol(token?.symbol)).filter(Boolean));
  state.fundingRealtimeCount = state.fundingRealtimeSymbols.size;
  state.openInterestRealtimeSymbols = new Set(openInterestTopTokens.map((token) => sanitizeSymbol(token?.symbol)).filter(Boolean));
  state.openInterestTopCount = state.openInterestRealtimeSymbols.size;
  return { items, tokens: Array.from(tokenMap.values()), klineTokens, watchTokens, fundingRealtimeTokens, openInterestTopTokens };
}

function buildStreams() {
  const streams = new Set();
  const clientStreams = new Set();
  for (const requestedStreams of state.clientStreams.values()) {
    for (const stream of requestedStreams) {
      clientStreams.add(stream);
      streams.add(stream);
    }
  }
  state.clientStreamCount = clientStreams.size;

  for (const symbol of state.watchRealtimeSymbols) {
    streams.add(`${symbol.toLowerCase()}@ticker`);
  }

  for (const symbol of state.fundingRealtimeSymbols) {
    streams.add(`${symbol.toLowerCase()}@ticker`);
  }

  for (const symbol of state.openInterestRealtimeSymbols) {
    streams.add(`${symbol.toLowerCase()}@ticker`);
  }

  const symbols = Array.from(state.backgroundKlineSymbols).slice(0, config.realtime.tokenLimit);
  for (const symbol of symbols) {
    const lower = symbol.toLowerCase();
    streams.add(`${lower}@ticker`);
    for (const interval of INTERVALS) {
      streams.add(`${lower}@kline_${interval}`);
    }
  }
  const requestedStreams = Array.from(streams);
  state.requestedStreamCount = requestedStreams.length;
  state.truncatedStreamCount = Math.max(0, requestedStreams.length - config.realtime.streamLimit);
  return requestedStreams.slice(0, config.realtime.streamLimit);
}

export function registerWatchRealtimeClientStreams(streams) {
  const id = state.nextClientId;
  state.nextClientId += 1;
  const requestedStreams = streams instanceof Set ? streams : parseWatchRealtimeStreams(streams);
  state.clientStreams.set(id, requestedStreams);
  updateWatchlistRealtime().catch((error) => {
    state.lastError = error instanceof Error ? error.message : String(error);
  });
  return {
    id,
    streams: requestedStreams,
    close: () => {
      if (!state.clientStreams.delete(id)) return;
      updateWatchlistRealtime().catch((error) => {
        state.lastError = error instanceof Error ? error.message : String(error);
      });
    }
  };
}

export function shouldForwardWatchRealtimePayload(streams, payload) {
  if (!(streams instanceof Set) || !streams.size) return true;
  if (payload?.type === "price") {
    const symbol = sanitizeSymbol(payload.symbol).toLowerCase();
    if (!symbol) return false;
    if (streams.has(`${symbol}@ticker`)) return true;
    return INTERVALS.some((interval) => streams.has(`${symbol}@kline_${interval}`));
  }
  if (payload?.type === "kline") {
    const symbol = sanitizeSymbol(payload.symbol).toLowerCase();
    const interval = String(payload.interval ?? payload.kline?.i ?? "");
    return Boolean(symbol && INTERVALS.includes(interval) && streams.has(`${symbol}@kline_${interval}`));
  }
  return true;
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
  if (!isClosed) return false;
  const key = `${symbol}|${interval}`;
  const now = Date.now();
  const last = state.lastKlinePersistedAt.get(key) ?? 0;
  if (now - last < (KLINE_PERSIST_MS[interval] ?? 30_000)) return false;
  state.lastKlinePersistedAt.set(key, now);
  return true;
}

export function resolveWatchlistAlertSide(item, price) {
  const aboveHit = item?.alertAbove !== null && item?.alertAbove !== undefined && price >= Number(item.alertAbove);
  const belowHit = item?.alertBelow !== null && item?.alertBelow !== undefined && price <= Number(item.alertBelow);
  if (aboveHit) return "above";
  if (belowHit) return "below";
  return null;
}

export function shouldSendWatchlistPriceAlert(item, side) {
  if (side !== "above" && side !== "below") return false;
  if (item?.lastAlertSide === side) return false;
  const cooldownMs = Math.max(0, Number(config.realtime.watchlistAlertCooldownMs) || 0);
  if (!cooldownMs) return true;
  const lastAlertMs = item?.lastAlertAt instanceof Date
    ? item.lastAlertAt.getTime()
    : new Date(item?.lastAlertAt ?? 0).getTime();
  if (!Number.isFinite(lastAlertMs) || lastAlertMs <= 0) return true;
  return Date.now() - lastAlertMs >= cooldownMs;
}

async function maybeSendPriceAlert(symbol, price, eventTime) {
  const item = state.watchItems.get(symbol);
  if (!item?.alertEnabled) return;
  const side = resolveWatchlistAlertSide(item, price);
  if (!side) {
    if (item.lastAlertSide) {
      await clearWatchlistAlertSide(symbol);
      state.watchItems.set(symbol, { ...item, currentPrice: price, lastAlertSide: null });
    }
    return;
  }
  if (!shouldSendWatchlistPriceAlert(item, side)) return;
  if (state.alertingSymbols.has(symbol)) return;

  state.alertingSymbols.add(symbol);
  try {
    const reason = side === "above"
      ? `实时价 ${price} 高于提醒价 ${item.alertAbove}`
      : `实时价 ${price} 低于提醒价 ${item.alertBelow}`;
    const result = state.alertSender ? await state.alertSender({ ...item, currentPrice: price }, reason) : { skipped: true };
    if (!result.skipped) {
      await markWatchlistAlertSent(symbol, side);
      state.watchItems.set(symbol, {
        ...item,
        currentPrice: price,
        lastAlertAt: new Date(eventTime).toISOString(),
        lastAlertSide: side
      });
    }
  } finally {
    state.alertingSymbols.delete(symbol);
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
    streamLimit: config.realtime.streamLimit,
    tokenLimit: config.realtime.tokenLimit,
    watchCount: state.watchItems.size,
    watchRealtimeCount: state.watchRealtimeSymbols.size,
    backgroundKlineTokenCount: state.backgroundKlineSymbols.size,
    fundingRealtimeCount: state.fundingRealtimeCount,
    fundingTopCount: state.fundingRealtimeCount,
    openInterestTopCount: state.openInterestTopCount,
    clientCount: state.clientStreams.size,
    clientStreamCount: state.clientStreamCount,
    requestedStreamCount: state.requestedStreamCount,
    truncatedStreamCount: state.truncatedStreamCount,
    connectedAt: state.connectedAt,
    lastMessageAt: state.lastMessageAt,
    lastError: state.lastError,
    reconnects: state.reconnects
  };
}
