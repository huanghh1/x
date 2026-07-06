import { fetchFuturesTicker24hr, fetchFuturesTicker24hrMap } from "./binance.js";
import { getPool } from "./db/connection.js";
import { sanitizeDbSymbol } from "./db/symbols.js";

function finiteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function rawSymbolVariants(value) {
  const raw = String(value ?? "").trim().toUpperCase();
  if (!raw) return [];
  const variants = new Set([raw]);
  for (const item of Array.from(variants)) {
    if (item.includes(":")) variants.add(item.split(":").pop());
    if (item.includes("-")) variants.add(item.split("-")[0]);
  }
  return Array.from(variants);
}

function marketSymbolCandidates(value) {
  const candidates = new Set();
  for (const variant of rawSymbolVariants(value)) {
    const symbol = sanitizeDbSymbol(variant);
    if (!symbol) continue;
    if (symbol.endsWith("USDT")) {
      candidates.add(symbol);
    } else if (symbol.endsWith("USDC")) {
      candidates.add(`${symbol.slice(0, -4)}USDT`);
      candidates.add(symbol);
    } else if (symbol.endsWith("USD") && symbol.length > 3) {
      candidates.add(`${symbol.slice(0, -3)}USDT`);
      candidates.add(symbol);
    } else {
      candidates.add(`${symbol}USDT`);
      candidates.add(symbol);
    }
  }
  return Array.from(candidates);
}

function normalizeLookupSymbols(items = []) {
  return [...new Set(
    (Array.isArray(items) ? items : [items])
      .flatMap((item) => marketSymbolCandidates(typeof item === "string" ? item : item?.symbol))
      .filter(Boolean)
  )];
}

async function fetchTokenMetadataMap(symbols = []) {
  const safeSymbols = normalizeLookupSymbols(symbols);
  if (!safeSymbols.length) return new Map();
  try {
    const [rows] = await getPool().query(
      `SELECT symbol, base_asset AS baseAsset, category_type AS categoryType, category_label AS categoryLabel,
        market_cap AS marketCap, market_cap_updated_at AS marketCapUpdatedAt
       FROM token_list
       WHERE symbol IN (?)`,
      [safeSymbols]
    );
    return new Map(rows.map((row) => [row.symbol, row]));
  } catch {
    return new Map();
  }
}

function normalizeTickerMapResult(result) {
  return result.status === "fulfilled" && result.value instanceof Map ? result.value : new Map();
}

function normalizeTokenMapResult(result) {
  return result.status === "fulfilled" && result.value instanceof Map ? result.value : new Map();
}

export function attachMarketMetadata(item = {}, ticker = null, token = null) {
  const displaySymbol = String(item?.symbol ?? "").trim();
  const fallbackSymbol = sanitizeDbSymbol(token?.symbol ?? ticker?.symbol);
  const symbol = displaySymbol || fallbackSymbol;
  const categoryLabel = String(
    item?.categoryLabel ??
      item?.category_label ??
      token?.categoryLabel ??
      ""
  ).trim();
  const categoryType = String(
    item?.categoryType ??
      item?.category_type ??
      token?.categoryType ??
      ""
  ).trim();
  const baseAsset = String(
    item?.baseAsset ??
      item?.base_asset ??
      token?.baseAsset ??
      ""
  ).trim();
  const priceChange24hPct = finiteNumber(
    ticker?.priceChange24hPct ??
      item?.priceChange24hPct
  );
  const lastPrice24h = finiteNumber(item?.lastPrice24h ?? ticker?.lastPrice);
  const marketCap = finiteNumber(
    item?.marketCap ??
      item?.market_cap ??
      token?.marketCap
  );

  return {
    ...item,
    ...(symbol ? { symbol } : {}),
    ...(baseAsset ? { baseAsset, base_asset: baseAsset } : {}),
    ...(categoryType ? { categoryType, category_type: categoryType } : {}),
    ...(categoryLabel ? { categoryLabel, category_label: categoryLabel } : {}),
    ...(marketCap > 0 ? { marketCap, market_cap: marketCap } : {}),
    ...(token?.marketCapUpdatedAt ? { marketCapUpdatedAt: token.marketCapUpdatedAt } : {}),
    priceChange24hPct,
    lastPrice24h
  };
}

export async function enrichRowsWithMarketMetadata(rows = []) {
  const list = Array.isArray(rows) ? rows : [rows].filter(Boolean);
  const symbols = normalizeLookupSymbols(list);
  if (!symbols.length) return list;
  const [tickerResult, tokenResult] = await Promise.allSettled([
    fetchFuturesTicker24hrMap(symbols),
    fetchTokenMetadataMap(symbols)
  ]);
  const tickers = normalizeTickerMapResult(tickerResult);
  const tokens = normalizeTokenMapResult(tokenResult);
  return list.map((item) => {
    const lookupSymbol = marketSymbolCandidates(item?.symbol).find((symbol) => tickers.has(symbol) || tokens.has(symbol));
    const next = attachMarketMetadata(item, tickers.get(lookupSymbol), tokens.get(lookupSymbol));
    if (Array.isArray(item?.intervalDetails)) {
      next.intervalDetails = item.intervalDetails.map((detail) =>
        attachMarketMetadata(detail, tickers.get(lookupSymbol), tokens.get(lookupSymbol))
      );
    }
    return next;
  });
}

export async function enrichItemWithMarketMetadata(item = {}) {
  const symbols = marketSymbolCandidates(item?.symbol);
  if (!symbols.length) return item;
  const [tickerResult, tokenResult] = await Promise.allSettled([
    fetchFuturesTicker24hr(symbols[0]),
    fetchTokenMetadataMap(symbols)
  ]);
  const ticker = tickerResult.status === "fulfilled" ? tickerResult.value : null;
  const tokens = normalizeTokenMapResult(tokenResult);
  const lookupSymbol = symbols.find((symbol) => symbol === ticker?.symbol || tokens.has(symbol)) ?? symbols[0];
  const token = tokens.get(lookupSymbol) ?? null;
  return attachMarketMetadata(item, ticker, token);
}
