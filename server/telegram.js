import { config } from "./config.js";
import { resolveSignalProfile } from "./signalPriority.js";

export function telegramState() {
  const configured = Boolean(config.telegram.botToken && config.telegram.chatId);
  return {
    configured,
    enabled: config.telegram.enabled,
    message: configured
      ? config.telegram.enabled
        ? "Telegram警报已启用"
        : "Telegram已配置但未启用"
      : "缺少TELEGRAM_BOT_TOKEN或TELEGRAM_CHAT_ID",
    routes: {
      level1: false,
      level2: false
    }
  };
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function formatOiChange(value) {
  const numeric = Number(value);
  return value === null || value === undefined || !Number.isFinite(numeric)
    ? "--"
    : `${numeric.toFixed(2)}%`;
}

function tokenSearchTerm(token) {
  const baseAsset = String(token.base_asset ?? "").trim();
  if (baseAsset) return baseAsset.toUpperCase();
  return String(token.symbol ?? "")
    .toUpperCase()
    .replace(/USDT$/, "");
}

function signalLinks(token) {
  const searchTerm = tokenSearchTerm(token);
  const twitterQuery = `$${searchTerm}`;
  const encodedSearch = encodeURIComponent(twitterQuery);
  const encodedSquareSearch = encodeURIComponent(searchTerm);

  return {
    searchTerm,
    twitterQuery,
    twitter: `https://mobile.twitter.com/search?q=${encodedSearch}&src=typed_query&f=live`,
    binanceSquare: `https://www.binance.com/en/square/search?s=${encodedSquareSearch}`
  };
}

function signalActionButtons(active = null) {
  const label = (text, key) => active === key ? `【${text}】` : text;
  return [
    { text: label("均线组合", "signals"), callback_data: "signals" },
    { text: label("热度排行", "heat"), callback_data: "heat" },
    { text: label("资金费率", "funding"), callback_data: "funding" },
    { text: label("OI监控", "oi"), callback_data: "oi:5m:desc" },
    { text: label("关注池", "watch"), callback_data: "watch" }
  ];
}

export function telegramTokenCopyButton(symbol) {
  return { text: `复制 ${symbol}`, copy_text: { text: String(symbol) } };
}

export function telegramTokenLine(symbol, prefix = "") {
  const links = telegramSearchLinks(symbol);
  return `<b>${escapeHtml(prefix)}${escapeHtml(symbol)}</b> · <a href="${links.twitter}">推特</a> · <a href="${links.binanceSquare}">币安广场</a>`;
}

function signalReplyMarkup(token = null, active = "signals") {
  const navigation = signalActionButtons(active);
  return {
    inline_keyboard: token?.symbol
      ? [
          [telegramTokenCopyButton(token.symbol), ...navigation.slice(0, 2)],
          navigation.slice(2)
        ]
      : [navigation.slice(0, 3), navigation.slice(3)]
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function retryableTelegramError(error) {
  const status = Number(error?.status ?? 0);
  const message = String(error?.message ?? "");
  return !status || status === 408 || status === 429 || status >= 500 ||
    /fetch failed|aborted|timeout|socket|TLS|ECONNRESET|UND_ERR_SOCKET/i.test(message);
}

export async function telegramApi(method, payload) {
  let lastError = null;
  for (let attempt = 0; attempt < config.telegram.retries; attempt += 1) {
    const controller = new AbortController();
    const pollingTimeoutMs = Number(payload?.timeout ?? 0) * 1000;
    const timer = setTimeout(
      () => controller.abort(),
      Math.max(config.telegram.timeoutMs, pollingTimeoutMs + 8000)
    );
    try {
      const response = await fetch(`https://api.telegram.org/bot${config.telegram.botToken}/${method}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: controller.signal,
        body: JSON.stringify(payload)
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || data.ok === false) {
        const error = new Error(data.description ?? `Telegram ${method} HTTP ${response.status}`);
        error.status = response.status;
        error.retryAfter = Number(data?.parameters?.retry_after ?? 0);
        throw error;
      }
      return data.result;
    } catch (error) {
      const cause = error?.cause?.message ? `: ${error.cause.message}` : "";
      lastError = error instanceof Error && error.message === "fetch failed"
        ? new Error(`Telegram ${method} fetch failed${cause}`)
        : error;
      if (!retryableTelegramError(lastError) || attempt >= config.telegram.retries - 1) throw lastError;
      const retryAfterMs = Math.max(
        Number(lastError?.retryAfter ?? 0) * 1000,
        config.telegram.retryDelayMs * 2 ** attempt
      );
      await sleep(retryAfterMs + Math.floor(Math.random() * 250));
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastError ?? new Error(`Telegram ${method} failed`);
}

export async function postTelegram(text, replyMarkup = null) {
  return telegramApi("sendMessage", {
    chat_id: config.telegram.chatId,
    text,
    parse_mode: "HTML",
    disable_web_page_preview: true,
    ...(replyMarkup ? { reply_markup: replyMarkup } : {})
  });
}

export async function sendSignalTelegram(token, signal, context = {}) {
  return { skipped: true, reason: "Standalone MA Telegram alerts are disabled by policy" };
}

export function formatHotMaSignalTelegram(token, signal, context = {}) {
  const multiCycleCount = Number(context.multiCycleCount ?? 0);
  const multiCycleIntervals = Array.isArray(context.multiCycleIntervals) ? context.multiCycleIntervals : [];
  const alertLevel = ["LEVEL1", "LEVEL2"].includes(context.alertLevel)
    ? context.alertLevel
    : signal.alertLevel;
  const profile = resolveSignalProfile({
    fundingOneHour: context.fundingOneHour,
    hotRank: context.hotRank,
    multiCycleCount,
    alertLevel,
    oiSpike: context.oiSpike
  });
  const intervalText = multiCycleIntervals.join(" / ") || signal.intervalCode;
  const isAggregated = multiCycleIntervals.length > 1;
  return [
    `<b>[${escapeHtml(profile.label)}]</b>`,
    `交易对：${telegramTokenLine(token.symbol)} · ${escapeHtml(token.category_label)}`,
    context.hotRank ? "热度确认：该代币当前在综合热度排行内" : null,
    context.fundingOneHour ? "资金费率：当前为 1 小时结算周期" : null,
    context.oiSpike
      ? `OI：5分钟 ${escapeHtml(formatOiChange(context.oiChange5mPct))} · 1小时 ${escapeHtml(formatOiChange(context.oiChange1hPct))}`
      : null,
    `触发周期：<b>${escapeHtml(intervalText)}</b>${multiCycleCount > 1 ? `（共 ${escapeHtml(multiCycleCount)} 个）` : ""}`,
    isAggregated ? null : `现价：${escapeHtml(signal.currentPrice)}`,
    isAggregated ? null : `MA100：${escapeHtml(signal.ma100)} / MA200：${escapeHtml(signal.ma200)}`,
    isAggregated ? null : `状态：${escapeHtml(signal.signalStatus)}`,
    isAggregated ? null : `说明：${escapeHtml(signal.note)}`,
    "提示：本条按资金费、OI、热度、多周期与均线等级组合排序，不构成投资建议。"
  ].filter(Boolean).join("\n");
}

export async function sendHotMaSignalTelegram(token, signal, context = {}) {
  if (!config.telegram.enabled) return { skipped: true, reason: "Telegram disabled" };
  if (!config.telegram.botToken || !config.telegram.chatId) return { skipped: true, reason: "Telegram missing config" };
  const alertLevel = ["LEVEL1", "LEVEL2"].includes(context.alertLevel)
    ? context.alertLevel
    : signal.alertLevel;
  if (!["LEVEL1", "LEVEL2"].includes(alertLevel)) return { skipped: true, reason: "Not an MA alert" };
  const profile = resolveSignalProfile({
    fundingOneHour: context.fundingOneHour,
    hotRank: context.hotRank,
    multiCycleCount: context.multiCycleCount,
    alertLevel,
    oiSpike: context.oiSpike
  });
  if (!profile.sourceMask) return { skipped: true, reason: "No ranked combination source" };

  const result = await postTelegram(formatHotMaSignalTelegram(token, signal, context), signalReplyMarkup(token));
  return { skipped: false, result };
}

export async function sendHotRankTelegram(tokens) {
  return { skipped: true, reason: "Standalone hot-rank Telegram alerts are disabled by policy" };
}

export async function sendWatchlistTelegram(item, reason) {
  if (!config.telegram.enabled) return { skipped: true, reason: "Telegram disabled" };
  if (!config.telegram.botToken || !config.telegram.chatId) return { skipped: true, reason: "Telegram missing config" };
  const text = [
    "<b>🎯 [关注池价格警报]</b>",
    `交易对：${telegramTokenLine(item.symbol)}`,
    `现价：${escapeHtml(item.currentPrice ?? "--")}`,
    `触发：${escapeHtml(reason)}`,
    item.note ? `备注：${escapeHtml(item.note)}` : null,
    "提示：这是关注池自定义价格提醒，不是全市场均线信号。"
  ].filter(Boolean).join("\n");

  const result = await postTelegram(text, signalReplyMarkup(item, "watch"));
  return { skipped: false, result };
}

function formatFundingRate(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return "--";
  return `${(number * 100).toFixed(4)}%`;
}

export async function sendFundingIntervalTelegram(item, context = {}) {
  if (!config.telegram.enabled) return { skipped: true, reason: "Telegram disabled" };
  if (!config.telegram.botToken || !config.telegram.chatId) return { skipped: true, reason: "Telegram missing config" };
  const previous = Number(item.previousFundingIntervalHours);
  const current = Number(item.fundingIntervalHours);
  const changeText = Number.isFinite(previous) && previous > 0 ? `${previous}h -> ${current}h` : `首次发现 ${current}h`;
  const profile = resolveSignalProfile({
    fundingOneHour: true,
    hotRank: context.hotRank,
    multiCycleCount: context.multiCycleCount,
    oiSpike: context.oiSpike,
    alertLevel: context.alertLevel
  });
  if (!profile.sourceMask) return { skipped: true, reason: "No MA alert for funding combination" };
  const intervals = Array.isArray(context.intervals) ? context.intervals : [];
  const text = [
    `<b>[${escapeHtml(profile.label)}]</b>`,
    `交易对：${telegramTokenLine(item.symbol)}`,
    `结算周期：<b>${escapeHtml(changeText)}</b>`,
    `当前资金费率：<b>${escapeHtml(formatFundingRate(item.currentFundingRate))}</b>`,
    item.nextFundingTime ? `下次结算：${escapeHtml(new Date(Number(item.nextFundingTime)).toLocaleString("zh-CN", { hour12: false }))}` : null,
    intervals.length ? `均线触发周期：${escapeHtml(intervals.join(" / "))}` : null,
    context.oiSpike
      ? `OI：5分钟 ${escapeHtml(formatOiChange(context.oiChange5mPct))} · 1小时 ${escapeHtml(formatOiChange(context.oiChange1hPct))}`
      : null,
    item.lastChangedAt ? `变化时间：${escapeHtml(new Date(item.lastChangedAt).toLocaleString("zh-CN", { hour12: false }))}` : null,
    "提示：这是 Binance USDⓈ-M fundingInfo 公开数据监控，不构成投资建议。"
  ].filter(Boolean).join("\n");

  const result = await postTelegram(text, signalReplyMarkup(item, "funding"));
  return { skipped: false, result };
}

export async function sendOpenInterestSpikeTelegram(item, context = {}) {
  if (!config.telegram.enabled) return { skipped: true, reason: "Telegram disabled" };
  if (!config.telegram.botToken || !config.telegram.chatId) {
    return { skipped: true, reason: "Telegram missing config" };
  }
  const profile = resolveSignalProfile({
    fundingOneHour: context.fundingOneHour,
    oiSpike: true,
    hotRank: context.hotRank,
    multiCycleCount: context.multiCycleCount,
    alertLevel: context.alertLevel
  });
  if (!profile.sourceMask) return { skipped: true, reason: "No MA alert for OI combination" };
  const matches = [
    context.hotRank ? "热度排行" : null,
    context.fundingOneHour ? "1小时资金费率" : null,
    Number(context.multiCycleCount ?? 0) >= 3 ? `多周期 ${context.multiCycleCount}` : null
  ].filter(Boolean);
  const intervals = Array.isArray(context.intervals) ? context.intervals : [];
  const text = [
    `<b>[${escapeHtml(profile.label)}]</b>`,
    `交易对：${telegramTokenLine(item.symbol)}`,
    `5分钟变化：<b>${escapeHtml(formatOiChange(item.change5mPct))}</b>`,
    `1小时变化：<b>${escapeHtml(formatOiChange(item.change1hPct))}</b>`,
    `当前持仓量：${escapeHtml(item.currentOpenInterest)}`,
    `持仓价值：${escapeHtml(item.currentOpenInterestValue)}`,
    matches.length ? `同币种命中：<b>${escapeHtml(matches.join(" + "))}</b>` : "同币种命中：暂无其他信号",
    intervals.length ? `均线触发周期：${escapeHtml(intervals.join(" / "))}` : null,
    `暴涨条件：5分钟 ≥ ${escapeHtml(config.openInterestMonitor.spike5mPct)}% 或 1小时 ≥ ${escapeHtml(config.openInterestMonitor.spike1hPct)}%`,
    "提示：OI 暴涨只有与一级或二级均线警报组合时才发送，不构成投资建议。"
  ].filter(Boolean).join("\n");
  const result = await postTelegram(text, signalReplyMarkup(item, "oi"));
  return { skipped: false, result };
}

export function telegramSearchLinks(symbol) {
  return signalLinks({ symbol });
}
