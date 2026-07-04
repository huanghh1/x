import { queueSymbolsForKlineRefresh } from "../db.js";
import { requestService } from "../serviceClient.js";

const klineRefreshRequests = new Map();

export function shouldRequestKlineRefresh(symbol, intervalCode, reason = "") {
  const key = `${symbol}:${intervalCode}:${reason}`;
  const now = Date.now();
  const last = Number(klineRefreshRequests.get(key) ?? 0);
  if (now - last < 10 * 60 * 1000) return false;
  klineRefreshRequests.set(key, now);
  if (klineRefreshRequests.size > 2000) {
    for (const [entryKey, timestamp] of klineRefreshRequests) {
      if (now - Number(timestamp) > 30 * 60 * 1000) klineRefreshRequests.delete(entryKey);
    }
  }
  return true;
}

export function requestKlineRefreshIfNeeded({
  symbol,
  intervalCode,
  reason = "",
  queueReasonPrefix = "按需补齐",
  logLabel = "on-demand kline"
} = {}) {
  if (!shouldRequestKlineRefresh(symbol, intervalCode, reason)) return false;
  void requestService("crawler", "/internal/kline/refresh", {
    method: "POST",
    body: JSON.stringify({ symbol, intervalCode }),
    timeoutMs: 10 * 60 * 1000
  })
    .catch((error) => console.error(`${logLabel} refresh failed`, symbol, intervalCode, error));
  void queueSymbolsForKlineRefresh(symbol, `${queueReasonPrefix} ${intervalCode} K线：${reason || "cache_refresh"}`)
    .catch((error) => console.error(`${logLabel} queue failed`, symbol, intervalCode, error));
  return true;
}
