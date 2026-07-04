export const SOURCE_LABELS = {
  binance: "Binance USD-M",
  hyperliquid: "Hyperliquid"
};

export const DAY_MS = 24 * 60 * 60 * 1000;
const TRANSIENT_RETRY_DELAYS_MS = [350, 1000];

export const CONNECTIONS = [
  {
    id: "binance",
    label: SOURCE_LABELS.binance,
    docsUrl: "https://developers.binance.com/docs/derivatives/usds-margined-futures/account/rest-api/Get-Income-History",
    fields: [
      { env: "BINANCE_API_KEY", configKey: "apiKey", label: "API Key", secret: true },
      { env: "BINANCE_API_SECRET", configKey: "apiSecret", label: "API Secret", secret: true },
      { env: "BINANCE_FUTURES_BASE_URL", configKey: "futuresBaseUrl", label: "Futures Base URL", optional: true }
    ]
  },
  {
    id: "hyperliquid",
    label: SOURCE_LABELS.hyperliquid,
    docsUrl: "https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/info-endpoint/perpetuals",
    fields: [
      { env: "HYPERLIQUID_WALLET_ADDRESS", configKey: "walletAddress", label: "钱包地址" },
      { env: "HYPERLIQUID_INFO_BASE_URL", configKey: "infoBaseUrl", label: "Info Base URL", optional: true },
      { env: "HYPERLIQUID_PERP_DEXS", configKey: "perpDexs", label: "HIP-3 Perp Dexs", optional: true }
    ]
  }
];

export function toNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

export function finiteOrNull(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function isConfigured(value) {
  return typeof value === "string" && value.trim().length > 0;
}

export function normalizeBaseUrl(url) {
  return String(url ?? "").replace(/\/+$/, "");
}

function parseTime(value, fallback) {
  if (value === undefined || value === null || value === "") return fallback;
  const direct = Number(value);
  if (Number.isFinite(direct) && direct > 0) return direct;
  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function normalizeWindow({ start, end, defaultLookbackDays = 90 }) {
  const now = Date.now();
  const fallbackEnd = now;
  const fallbackStart = now - (Math.max(1, Number(defaultLookbackDays) || 90) * DAY_MS);
  let startMs = parseTime(start, fallbackStart);
  let endMs = parseTime(end, fallbackEnd);
  if (startMs > endMs) [startMs, endMs] = [endMs, startMs];
  return { startMs, endMs };
}

export function splitTimeRange(startMs, endMs, chunkMs) {
  const chunks = [];
  let cursor = startMs;
  while (cursor <= endMs) {
    const chunkEnd = Math.min(endMs, cursor + chunkMs);
    chunks.push({ startMs: cursor, endMs: chunkEnd });
    cursor = chunkEnd + 1;
  }
  return chunks;
}

export function chunksForActivity(startMs, endMs, chunkMs, activityTimes = []) {
  const validTimes = activityTimes
    .map((value) => Number(value))
    .filter((value) => Number.isFinite(value) && value >= startMs && value <= endMs);
  if (!validTimes.length) return splitTimeRange(startMs, endMs, chunkMs);
  const stepMs = chunkMs + 1;
  const chunks = new Map();
  for (const time of validTimes) {
    const index = Math.floor((time - startMs) / stepMs);
    const chunkStart = startMs + (index * stepMs);
    chunks.set(index, {
      startMs: chunkStart,
      endMs: Math.min(endMs, chunkStart + chunkMs)
    });
  }
  return Array.from(chunks.entries())
    .sort((a, b) => a[0] - b[0])
    .map(([, chunk]) => chunk);
}

export function uniqueById(items) {
  const seen = new Set();
  const result = [];
  for (const item of items) {
    const key = String(item.id ?? `${item.source}:${item.symbol}:${item.type}:${item.time}:${item.net}`);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(item);
  }
  return result;
}

export async function mapLimit(items, limit, fn) {
  const results = Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      try {
        results[index] = { status: "fulfilled", value: await fn(items[index], index) };
      } catch (reason) {
        results[index] = { status: "rejected", reason };
      }
    }
  });
  await Promise.all(workers);
  return results;
}

function compactErrorPart(value) {
  return String(value ?? "").trim().replace(/\s+/g, " ");
}

export function describeError(error) {
  const message = compactErrorPart(error instanceof Error ? error.message : error) || "unknown error";
  const cause = error instanceof Error && error.cause && typeof error.cause === "object" ? error.cause : null;
  const code = compactErrorPart(cause?.code ?? cause?.name);
  const causeMessage = compactErrorPart(cause?.message);
  const parts = [message];
  if (code && !message.includes(code)) parts.push(code);
  if (causeMessage && causeMessage !== message && !message.includes(causeMessage)) parts.push(causeMessage);
  return parts.join(" · ");
}

function isTransientFetchError(error) {
  return /(fetch failed|aborted|timeout|ECONNRESET|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|UND_ERR|socket|network|HTTP 429|HTTP 5\d\d)/i.test(describeError(error));
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function retryTransient(fn) {
  let lastError;
  for (let attempt = 0; attempt <= TRANSIENT_RETRY_DELAYS_MS.length; attempt += 1) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (attempt >= TRANSIENT_RETRY_DELAYS_MS.length || !isTransientFetchError(error)) throw error;
      await delay(TRANSIENT_RETRY_DELAYS_MS[attempt]);
    }
  }
  throw lastError;
}

export function absNegative(value) {
  const number = toNumber(value);
  return number === 0 ? 0 : -Math.abs(number);
}

export function nonPnlNote(note, rawType) {
  const detail = String(note || rawType || "").trim();
  return ["不计入收益", detail].filter(Boolean).join(" · ");
}

export function normalizeTradeAction({ source, side, positionSide, direction, realizedPnl }) {
  const raw = String(direction || "").trim();
  if (raw) return raw;
  const sideUpper = String(side || "").toUpperCase();
  const posUpper = String(positionSide || "").toUpperCase();
  const hasClosePnl = Math.abs(toNumber(realizedPnl)) > 0;
  if (posUpper === "LONG") return sideUpper === "BUY" ? "Open Long" : "Close Long";
  if (posUpper === "SHORT") return sideUpper === "SELL" ? "Open Short" : "Close Short";
  if (source === "binance" && hasClosePnl) return sideUpper === "BUY" ? "Buy / Close" : "Sell / Close";
  if (sideUpper === "BUY" || sideUpper === "B") return "Buy";
  if (sideUpper === "SELL" || sideUpper === "S" || sideUpper === "A") return "Sell";
  return side || "";
}

function normalizeSymbolText(value) {
  return String(value ?? "").trim().toUpperCase();
}

function symbolLookupVariants(value) {
  const variants = new Set();
  function add(item) {
    const normalized = normalizeSymbolText(item);
    if (normalized) variants.add(normalized);
  }

  add(value);
  for (const item of Array.from(variants)) {
    if (item.includes("-")) add(item.split("-")[0]);
    if (item.includes(":")) add(item.split(":").pop());
    for (const quote of ["USDT", "USDC"]) {
      if (item.endsWith(quote) && item.length > quote.length) add(item.slice(0, -quote.length));
      if (item.endsWith(`-${quote}`) && item.length > quote.length + 1) add(item.slice(0, -(quote.length + 1)));
    }
  }
  for (const item of Array.from(variants)) {
    if (/^[A-Z]{3}$/.test(item)) add(`USD${item}`);
  }
  return variants;
}

export function symbolMatchesValue(value, target) {
  if (!target) return true;
  const valueVariants = symbolLookupVariants(value);
  const targetVariants = symbolLookupVariants(target);
  for (const variant of valueVariants) {
    if (targetVariants.has(variant)) return true;
  }
  return false;
}

export function sourceConnectionStatus(config) {
  const sources = {
    binance: config.tradeAnalysis.binance,
    hyperliquid: config.tradeAnalysis.hyperliquid
  };
  return CONNECTIONS.map((connection) => {
    const source = sources[connection.id] ?? {};
    const fields = connection.fields.map((field) => ({
      ...field,
      configured: field.optional || isConfigured(source[field.configKey] ?? "")
    }));
    const missing = fields.filter((field) => !field.optional && !field.configured).map((field) => field.env);
    return {
      id: connection.id,
      label: connection.label,
      docsUrl: connection.docsUrl,
      configured: missing.length === 0,
      missing,
      fields: fields.map(({ configKey: _configKey, ...field }) => field)
    };
  });
}

export async function fetchJson(url, options = {}, timeoutMs = 15_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    const text = await response.text();
    let payload;
    try {
      payload = text ? JSON.parse(text) : null;
    } catch {
      payload = text;
    }
    if (!response.ok) {
      const message = typeof payload === "object" && payload?.msg
        ? payload.msg
        : typeof payload === "object" && payload?.message
          ? payload.message
          : `${response.status} ${response.statusText}`;
      throw new Error(message);
    }
    return payload;
  } finally {
    clearTimeout(timer);
  }
}

export function positionSide(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number === 0) return "";
  return number > 0 ? "long" : "short";
}

export function normalizePositionQuantity(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.abs(number) : null;
}

export function missingSource(id, missing) {
  return {
    id,
    label: SOURCE_LABELS[id],
    configured: false,
    ok: false,
    missing,
    error: `缺少 ${missing.join("、")}`,
    eventCount: 0,
    positionCount: 0,
    events: [],
    positions: []
  };
}

export function okSource(id, events, positions = []) {
  return {
    id,
    label: SOURCE_LABELS[id],
    configured: true,
    ok: true,
    missing: [],
    error: "",
    eventCount: events.length,
    positionCount: positions.length,
    events,
    positions
  };
}

export function errorSource(id, error) {
  return {
    id,
    label: SOURCE_LABELS[id],
    configured: true,
    ok: false,
    missing: [],
    error: describeError(error),
    eventCount: 0,
    positionCount: 0,
    events: [],
    positions: []
  };
}
