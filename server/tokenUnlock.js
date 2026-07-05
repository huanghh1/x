import { config } from "./config.js";
import { mapLimit } from "./concurrency.js";
import {
  getTokenUnlockCache,
  listWatchlistUnlockTargets,
  upsertTokenUnlockCache
} from "./db.js";
import { resolveOfficialUnlock } from "./officialUnlocks.js";

let timer = null;
let alphaTokenCache = null;
let alphaTokenCacheAt = 0;
let alphaTokenInflight = null;
const state = {
  running: false,
  lastRunAt: null,
  nextRunAt: null,
  updatedCount: 0,
  concurrency: config.unlock.concurrency,
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

async function fetchText(url) {
  const controller = new AbortController();
  const timerId = setTimeout(() => controller.abort(), config.unlock.requestTimeoutMs);
  try {
    const response = await fetch(url, {
      headers: {
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "User-Agent": "Mozilla/5.0 (compatible; BinanceMonitor/1.0; +https://www.binance.com/)"
      },
      signal: controller.signal
    });
    const text = await response.text().catch(() => "");
    return {
      ok: response.ok,
      status: response.status,
      text: text.slice(0, 250_000)
    };
  } finally {
    clearTimeout(timerId);
  }
}

function stripHtml(text) {
  return String(text ?? "")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, " ")
    .trim();
}

function parseCandidateDate(raw) {
  const text = String(raw ?? "").trim();
  const monthMap = {
    jan: 0, january: 0,
    feb: 1, february: 1,
    mar: 2, march: 2,
    apr: 3, april: 3,
    may: 4,
    jun: 5, june: 5,
    jul: 6, july: 6,
    aug: 7, august: 7,
    sep: 8, sept: 8, september: 8,
    oct: 9, october: 9,
    nov: 10, november: 10,
    dec: 11, december: 11
  };
  let match = text.match(/\b(20\d{2})[-/.年](\d{1,2})[-/.月](\d{1,2})/);
  if (match) return new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  match = text.match(/\b(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\.?\s+(\d{1,2}),?\s+(20\d{2})\b/i);
  if (match) return new Date(Date.UTC(Number(match[3]), monthMap[match[1].toLowerCase().replace(".", "")], Number(match[2])));
  match = text.match(/\b(\d{1,2})\s+(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\.?,?\s+(20\d{2})\b/i);
  if (match) return new Date(Date.UTC(Number(match[3]), monthMap[match[2].toLowerCase().replace(".", "")], Number(match[1])));
  return null;
}

function findUnlockFromText(text) {
  const plain = stripHtml(text);
  if (!/\b(unlock|vesting|release|cliff|tge|allocation)\b/i.test(plain)) return null;
  const datePattern = /(20\d{2}[-/.年]\d{1,2}[-/.月]\d{1,2}|(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\.?\s+\d{1,2},?\s+20\d{2}|\d{1,2}\s+(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\.?,?\s+20\d{2})/gi;
  for (const match of plain.matchAll(datePattern)) {
    const start = Math.max(0, match.index - 220);
    const end = Math.min(plain.length, match.index + match[0].length + 220);
    const context = plain.slice(start, end);
    if (!/\b(unlock|vesting|release|cliff|tge|allocation)\b/i.test(context)) continue;
    const date = futureDate(parseCandidateDate(match[0]));
    if (date) return { date, context: context.slice(0, 500) };
  }
  return null;
}

async function searchUnlockSources(symbol, baseAsset) {
  const query = `${baseAsset} token unlock schedule vesting`;
  const sources = [
    {
      provider: "binance-square",
      url: `https://www.binance.com/en/square/search?s=${encodeURIComponent(baseAsset)}`
    },
    {
      provider: "web-search",
      url: `https://www.bing.com/search?q=${encodeURIComponent(query)}`
    },
    {
      provider: "twitter-search",
      url: `https://x.com/search?q=${encodeURIComponent(`$${baseAsset} unlock OR vesting`)}&src=typed_query&f=live`
    }
  ];
  const checked = [];
  for (const source of sources) {
    try {
      const result = await fetchText(source.url);
      const found = result.ok ? findUnlockFromText(result.text) : null;
      checked.push({
        provider: source.provider,
        url: source.url,
        ok: result.ok,
        status: result.status,
        foundDate: found?.date?.toISOString() ?? null,
        context: found?.context ?? null
      });
    } catch (error) {
      checked.push({
        provider: source.provider,
        url: source.url,
        ok: false,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }
  const firstUnverifiedDate = checked.find((item) => item.foundDate);
  return {
    provider: "public-search",
    sourceUrl: firstUnverifiedDate?.url ?? sources[1].url,
    status: "undated",
    error: firstUnverifiedDate
      ? "公开搜索发现疑似未来解锁日期，但来源未通过官方核验，已按未公布精确日期处理"
      : "已实际检查币安广场、网页搜索和推特搜索，未找到可自动核验的未来解锁日期",
    rawPayload: { checked, symbol, baseAsset }
  };
}

async function fetchBinanceAlphaTokens() {
  if (alphaTokenCache && Date.now() - alphaTokenCacheAt < 5 * 60 * 1000) return alphaTokenCache;
  if (!alphaTokenInflight) {
    alphaTokenInflight = fetchJson(config.binance.alphaTokenListUrl)
      .then((payload) => {
        const rows = Array.isArray(payload?.data) ? payload.data : [];
        alphaTokenCache = rows;
        alphaTokenCacheAt = Date.now();
        return rows;
      })
      .finally(() => {
        alphaTokenInflight = null;
      });
  }
  return alphaTokenInflight;
}

async function fetchOfficial(baseAsset) {
  const rows = await fetchBinanceAlphaTokens();
  const token = rows.find((item) => String(item?.symbol ?? "").toUpperCase() === baseAsset);
  if (!token) {
    return searchUnlockSources(`${baseAsset}USDT`, baseAsset);
  }
  const result = resolveOfficialUnlock(token);
  if (result) return result;
  const searched = await searchUnlockSources(`${baseAsset}USDT`, baseAsset);
  return {
    ...searched,
    provider: "binance+public-search",
    error: "币安已确认代币，但官方渠道尚未发布可核验的精确解锁日期；已实际检查币安广场、网页搜索和推特搜索",
    rawPayload: {
      ...(searched.rawPayload ?? {}),
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
  const expiresAtForStatus = (status) =>
    new Date(checkedAt.getTime() + (status === "available" ? config.unlock.cacheMs : config.unlock.retryCacheMs));

  try {
    const result = await fetchUnlockSource(symbol, baseAsset);
    if (result.status) {
      return upsertTokenUnlockCache({
        symbol,
        baseAsset,
        ...result,
        checkedAt,
        expiresAt: expiresAtForStatus(result.status)
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
      expiresAt: expiresAtForStatus(next ? "available" : "none")
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
      expiresAt: expiresAtForStatus("error")
    });
  }
}

export async function runTokenUnlockRefresh({ force = false } = {}) {
  if (!config.unlock.enabled && !force) return { skipped: true, reason: "Token unlock disabled" };
  if (state.running) return { skipped: true, reason: "Token unlock refresh already running" };
  state.running = true;
  state.errors = [];
  state.concurrency = config.unlock.concurrency;
  try {
    const targets = await listWatchlistUnlockTargets({ expiredOnly: !force });
    let updatedCount = 0;
    const results = await mapLimit(targets, config.unlock.concurrency, (target) =>
      refreshTokenUnlock(target.symbol, target.baseAsset, { force })
    );
    for (const [index, result] of results.entries()) {
      const target = targets[index];
      if (result.status === "rejected") {
        const message = result.reason instanceof Error ? result.reason.message : String(result.reason);
        state.errors.push(`${target?.symbol ?? "UNKNOWN"}: ${message}`);
        continue;
      }
      const item = result.value;
      if (item) updatedCount += 1;
      if (item?.status === "error") state.errors.push(`${target.symbol}: ${item.error}`);
    }
    state.lastRunAt = new Date().toISOString();
    state.updatedCount = updatedCount;
    return {
      ok: true,
      partial: state.errors.length > 0,
      targetCount: targets.length,
      updatedCount,
      concurrency: config.unlock.concurrency,
      errors: state.errors.slice(0, 20)
    };
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
    concurrency: config.unlock.concurrency,
    ...state
  };
}
