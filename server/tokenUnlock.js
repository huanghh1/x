import { config } from "./config.js";
import {
  getTokenUnlockCache,
  listWatchlistUnlockTargets,
  upsertTokenUnlockCache
} from "./db.js";
import { resolveOfficialUnlock } from "./officialUnlocks.js";

let timer = null;
let alphaTokenCache = null;
let alphaTokenCacheAt = 0;
const state = {
  running: false,
  lastRunAt: null,
  nextRunAt: null,
  updatedCount: 0,
  errors: []
};

function futureDate(value) {
  if (!value) return null;
  const date = new Date(typeof value === "number" && value < 10_000_000_000 ? value * 1000 : value);
  return Number.isNaN(date.getTime()) || date.getTime() <= Date.now() ? null : date;
}

function releaseRows(payload) {
  const data = payload?.data ?? payload;
  const candidates = [
    data?.release_schedule,
    data?.releaseSchedule,
    data?.token_release_schedule,
    data?.unlocks,
    data?.vesting
  ];
  return candidates.find(Array.isArray) ?? [];
}

function normalizeRelease(row) {
  const date = futureDate(
    row?.date ?? row?.unlock_date ?? row?.unlockDate ?? row?.timestamp ?? row?.time
  );
  if (!date) return null;
  const amount = Number(row?.amount ?? row?.tokens ?? row?.unlock_amount);
  const percent = Number(row?.percent ?? row?.percentage ?? row?.unlock_percent);
  return {
    date,
    amount: Number.isFinite(amount) ? amount : null,
    percent: Number.isFinite(percent) ? percent : null
  };
}

async function fetchJson(url, headers = {}) {
  const controller = new AbortController();
  const timerId = setTimeout(() => controller.abort(), config.unlock.requestTimeoutMs);
  try {
    const response = await fetch(url, { headers: { Accept: "application/json", ...headers }, signal: controller.signal });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(payload?.message ?? payload?.error ?? `unlock provider HTTP ${response.status}`);
    }
    return payload;
  } finally {
    clearTimeout(timerId);
  }
}

async function fetchMobula(baseAsset) {
  if (!config.unlock.mobulaApiKey) {
    return {
      status: "unconfigured",
      provider: "mobula",
      error: "缺少 MOBULA_API_KEY",
      sourceUrl: "https://docs.mobula.io/rest-api/endpoint/metadata"
    };
  }
  const url = new URL("https://api.mobula.io/api/1/metadata");
  url.searchParams.set("asset", baseAsset);
  const payload = await fetchJson(url, { Authorization: config.unlock.mobulaApiKey });
  return {
    payload,
    provider: "mobula",
    sourceUrl: url.toString()
  };
}

async function fetchCustom(symbol, baseAsset) {
  if (!config.unlock.customUrlTemplate) {
    return {
      status: "unconfigured",
      provider: "custom",
      error: "缺少 TOKEN_UNLOCK_URL_TEMPLATE"
    };
  }
  const url = config.unlock.customUrlTemplate
    .replaceAll("{symbol}", encodeURIComponent(symbol))
    .replaceAll("{baseAsset}", encodeURIComponent(baseAsset));
  const headers = config.unlock.bearerToken
    ? { Authorization: `Bearer ${config.unlock.bearerToken}` }
    : {};
  return {
    payload: await fetchJson(url, headers),
    provider: "custom",
    sourceUrl: url
  };
}

async function fetchBinanceAlphaTokens() {
  if (alphaTokenCache && Date.now() - alphaTokenCacheAt < 5 * 60 * 1000) return alphaTokenCache;
  const payload = await fetchJson(config.binance.alphaTokenListUrl);
  const rows = Array.isArray(payload?.data) ? payload.data : [];
  alphaTokenCache = rows;
  alphaTokenCacheAt = Date.now();
  return rows;
}

async function fetchOfficial(baseAsset) {
  const rows = await fetchBinanceAlphaTokens();
  const token = rows.find((item) => String(item?.symbol ?? "").toUpperCase() === baseAsset);
  if (!token) {
    return {
      status: "undated",
      provider: "public-search",
      sourceUrl: `https://www.google.com/search?q=${encodeURIComponent(`${baseAsset} token unlock schedule vesting`)}`,
      error: "币安 Alpha 未收录该代币，请通过推特、币安广场或网页搜索核验解锁计划"
    };
  }
  const result = resolveOfficialUnlock(token);
  if (result) return result;
  return {
    status: "undated",
    provider: "binance+official",
    sourceUrl: `https://www.binance.com/en/square/search?s=${encodeURIComponent(baseAsset)}`,
    error: "币安已确认代币，但官方渠道尚未发布可核验的精确解锁日期",
    rawPayload: {
      binance: {
        name: token.name,
        symbol: token.symbol,
        chainId: token.chainId,
        contractAddress: token.contractAddress,
        listingTime: token.listingTime
      }
    }
  };
}

async function fetchUnlockSource(symbol, baseAsset) {
  if (config.unlock.provider === "custom") {
    const result = await fetchCustom(symbol, baseAsset);
    return result.status === "unconfigured" ? fetchOfficial(baseAsset) : result;
  }
  if (config.unlock.provider === "mobula") {
    const result = await fetchMobula(baseAsset);
    return result.status === "unconfigured" ? fetchOfficial(baseAsset) : result;
  }
  return fetchOfficial(baseAsset);
}

export async function refreshTokenUnlock(symbol, baseAsset, { force = false } = {}) {
  const cached = await getTokenUnlockCache(symbol);
  if (!force && cached?.expiresAt && new Date(cached.expiresAt).getTime() > Date.now()) return cached;
  const checkedAt = new Date();
  const expiresAt = new Date(checkedAt.getTime() + config.unlock.cacheMs);

  try {
    const result = await fetchUnlockSource(symbol, baseAsset);
    if (result.status) {
      return upsertTokenUnlockCache({
        symbol,
        baseAsset,
        ...result,
        checkedAt,
        expiresAt
      });
    }
    const releases = releaseRows(result.payload)
      .map(normalizeRelease)
      .filter(Boolean)
      .sort((a, b) => a.date - b.date);
    const next = releases[0] ?? null;
    return upsertTokenUnlockCache({
      symbol,
      baseAsset,
      provider: result.provider,
      sourceUrl: result.sourceUrl,
      status: next ? "available" : "none",
      nextUnlockAt: next?.date ?? null,
      unlockAmount: next?.amount ?? null,
      unlockPercent: next?.percent ?? null,
      rawPayload: result.payload,
      checkedAt,
      expiresAt
    });
  } catch (error) {
    if (cached && ["available", "none", "undated"].includes(cached.status)) return cached;
    return upsertTokenUnlockCache({
      symbol,
      baseAsset,
      provider: config.unlock.provider,
      status: "error",
      error: error instanceof Error ? error.message : String(error),
      checkedAt,
      expiresAt
    });
  }
}

export async function runTokenUnlockRefresh({ force = false } = {}) {
  if (!config.unlock.enabled && !force) return { skipped: true, reason: "Token unlock disabled" };
  if (state.running) return { skipped: true, reason: "Token unlock refresh already running" };
  state.running = true;
  state.errors = [];
  try {
    const targets = await listWatchlistUnlockTargets({ expiredOnly: !force });
    let updatedCount = 0;
    for (const target of targets) {
      const item = await refreshTokenUnlock(target.symbol, target.baseAsset, { force });
      if (item) updatedCount += 1;
      if (item?.status === "error") state.errors.push(`${target.symbol}: ${item.error}`);
    }
    state.lastRunAt = new Date().toISOString();
    state.updatedCount = updatedCount;
    return { ok: true, updatedCount, errors: state.errors.slice(0, 20) };
  } finally {
    state.running = false;
  }
}

export function startTokenUnlockMonitor() {
  if (!config.unlock.enabled || timer) return getTokenUnlockState();
  const tick = () => {
    runTokenUnlockRefresh().catch((error) => {
      state.errors = [error instanceof Error ? error.message : String(error)];
    });
    state.nextRunAt = new Date(Date.now() + config.unlock.scanIntervalMs).toISOString();
  };
  tick();
  timer = setInterval(tick, config.unlock.scanIntervalMs);
  timer.unref?.();
  return getTokenUnlockState();
}

export function getTokenUnlockState() {
  return {
    enabled: config.unlock.enabled,
    provider: config.unlock.provider,
    ...state
  };
}
