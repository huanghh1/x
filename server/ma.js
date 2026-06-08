import { config } from "./config.js";

export const INTERVALS = ["15m", "1h", "4h", "1d"];

function average(values) {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function round(value) {
  if (value === null || value === undefined || !Number.isFinite(value)) return null;
  return Number(value.toFixed(12));
}

export function calculateSignal({ intervalCode, closes }) {
  const clean = closes.filter((item) => Number.isFinite(item.close));
  const latest = clean[clean.length - 1];
  const signalTime = latest?.closeTime ?? Date.now();
  const ma100 = clean.length >= 100 ? average(clean.slice(-100).map((item) => item.close)) : null;
  const ma200 = clean.length >= 200 ? average(clean.slice(-200).map((item) => item.close)) : null;
  const currentPrice = latest?.close ?? null;

  if (!currentPrice || ma100 === null || ma200 === null) {
    return {
      intervalCode,
      ma100: round(ma100),
      ma200: round(ma200),
      currentPrice: round(currentPrice),
      alertLevel: "INSUFFICIENT",
      proximityPct: null,
      signalWeight: null,
      signalStatus: "样本不足",
      note: `本周期缓存 ${clean.length} 根K线，MA200需要至少200根。`,
      signalTime
    };
  }

  const lower = Math.min(ma100, ma200);
  const upper = Math.max(ma100, ma200);
  const inside = currentPrice >= lower && currentPrice <= upper;
  const distanceToMa100 = Math.abs(currentPrice - ma100) / currentPrice * 100;
  const distanceToMa200 = Math.abs(currentPrice - ma200) / currentPrice * 100;
  const proximityPct = Math.min(distanceToMa100, distanceToMa200);
  const nearThresholdPct = config.signal.nearThresholdPct;

  if (inside) {
    return {
      intervalCode,
      ma100: round(ma100),
      ma200: round(ma200),
      currentPrice: round(currentPrice),
      alertLevel: "LEVEL1",
      proximityPct: round(proximityPct),
      signalWeight: round(100 + (upper - lower) / currentPrice),
      signalStatus: "一级警报",
      note: `当前价格进入 MA100 与 MA200 区间，${intervalCode} 周期强观察信号。`,
      signalTime
    };
  }

  if (proximityPct <= nearThresholdPct) {
    const nearLine = distanceToMa100 <= distanceToMa200 ? "MA100" : "MA200";
    return {
      intervalCode,
      ma100: round(ma100),
      ma200: round(ma200),
      currentPrice: round(currentPrice),
      alertLevel: "LEVEL2",
      proximityPct: round(proximityPct),
      signalWeight: round(Math.max(0, nearThresholdPct - proximityPct)),
      signalStatus: "二级预警",
      note: `当前价格靠近 ${nearLine}，距离约 ${proximityPct.toFixed(3)}%。`,
      signalTime
    };
  }

  return {
    intervalCode,
    ma100: round(ma100),
    ma200: round(ma200),
    currentPrice: round(currentPrice),
    alertLevel: "NONE",
    proximityPct: round(proximityPct),
    signalWeight: 0,
    signalStatus: "观察中",
    note: `未进入双均线区间，距离最近均线约 ${proximityPct.toFixed(3)}%。`,
    signalTime
  };
}
