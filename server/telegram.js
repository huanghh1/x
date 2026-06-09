import { config } from "./config.js";

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
      level1: config.telegram.level1Enabled,
      level2: config.telegram.level2Enabled
    }
  };
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
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
    binanceSquare: `https://www.binance.com/en/square/search?keyword=${encodedSquareSearch}`
  };
}

function signalActionButtons() {
  return [
    { text: "热度+均线信号", callback_data: "hotma:1" },
    { text: "均线信号", callback_data: "signals" },
    { text: "热度排行", callback_data: "heat" }
  ];
}

function signalReplyMarkup(token) {
  const links = signalLinks(token);
  return {
    inline_keyboard: [
      [
        { text: "复制代币", copy_text: { text: token.symbol } },
        { text: "推特", url: links.twitter },
        { text: "币安广场", url: links.binanceSquare }
      ],
      signalActionButtons()
    ]
  };
}

export async function postTelegram(text, replyMarkup = null) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.telegram.timeoutMs);
  try {
    const response = await fetch(`https://api.telegram.org/bot${config.telegram.botToken}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: controller.signal,
      body: JSON.stringify({
        chat_id: config.telegram.chatId,
        text,
        parse_mode: "HTML",
        disable_web_page_preview: true,
        ...(replyMarkup ? { reply_markup: replyMarkup } : {})
      })
    });
    const data = await response.json();
    if (!response.ok || data.ok === false) {
      throw new Error(data.description ?? `Telegram HTTP ${response.status}`);
    }
    return data.result;
  } finally {
    clearTimeout(timer);
  }
}

export async function sendSignalTelegram(token, signal, context = {}) {
  if (!config.telegram.enabled) return { skipped: true, reason: "Telegram disabled" };
  if (!config.telegram.botToken || !config.telegram.chatId) return { skipped: true, reason: "Telegram missing config" };
  if (signal.alertLevel !== "LEVEL1") return { skipped: true, reason: "Only LEVEL1 Telegram alerts are enabled" };
  if (!config.telegram.level1Enabled) return { skipped: true, reason: "LEVEL1 disabled" };

  const links = signalLinks(token);
  const multiCycleCount = Number(context.multiCycleCount ?? 0);
  const multiCycleIntervals = Array.isArray(context.multiCycleIntervals) ? context.multiCycleIntervals : [];
  const hasMultiCycle = multiCycleCount >= 3;
  const text = [
    hasMultiCycle ? `<b>🔥🔥 [多周期共振 · 一级警报]</b>` : `<b>[MA100/MA200 一级警报]</b>`,
    `交易对：<b>${escapeHtml(token.symbol)}</b> · ${escapeHtml(token.category_label)}`,
    hasMultiCycle ? `醒目提示：<b>${multiCycleCount} 个周期同时触发</b>（${escapeHtml(multiCycleIntervals.join(" / "))}）` : null,
    `周期：${escapeHtml(signal.intervalCode)}`,
    `现价：${escapeHtml(signal.currentPrice)}`,
    `MA100：${escapeHtml(signal.ma100)} / MA200：${escapeHtml(signal.ma200)}`,
    `状态：${escapeHtml(signal.signalStatus)}`,
    `说明：${escapeHtml(signal.note)}`,
    `推特搜索：${escapeHtml(links.twitterQuery)}`,
    "提示：仅公开数据观察，不构成投资建议。"
  ].filter(Boolean).join("\n");

  const result = await postTelegram(text, signalReplyMarkup(token));
  return { skipped: false, result };
}

export async function sendHotMaSignalTelegram(token, signal, context = {}) {
  if (!config.telegram.enabled) return { skipped: true, reason: "Telegram disabled" };
  if (!config.telegram.botToken || !config.telegram.chatId) return { skipped: true, reason: "Telegram missing config" };
  if (!["LEVEL1", "LEVEL2"].includes(signal.alertLevel)) return { skipped: true, reason: "Not an MA alert" };

  const links = signalLinks(token);
  const multiCycleCount = Number(context.multiCycleCount ?? 0);
  const multiCycleIntervals = Array.isArray(context.multiCycleIntervals) ? context.multiCycleIntervals : [];
  const text = [
    `<b>🔥🔥🔥 [最高等级 · 热度+均线${signal.alertLevel === "LEVEL1" ? "一级警报" : "二级预警"}]</b>`,
    `交易对：<b>${escapeHtml(token.symbol)}</b> · ${escapeHtml(token.category_label)}`,
    `热度确认：该代币当前在综合热度排行内`,
    multiCycleCount >= 2 ? `多周期：<b>${multiCycleCount} 个周期触发</b>（${escapeHtml(multiCycleIntervals.join(" / "))}）` : null,
    `周期：${escapeHtml(signal.intervalCode)}`,
    `现价：${escapeHtml(signal.currentPrice)}`,
    `MA100：${escapeHtml(signal.ma100)} / MA200：${escapeHtml(signal.ma200)}`,
    `状态：${escapeHtml(signal.signalStatus)}`,
    `说明：${escapeHtml(signal.note)}`,
    `推特搜索：${escapeHtml(links.twitterQuery)}`,
    "提示：热度+均线共振优先级高于普通均线和多周期列表，不构成投资建议。"
  ].filter(Boolean).join("\n");

  const result = await postTelegram(text, signalReplyMarkup(token));
  return { skipped: false, result };
}

export async function sendHotRankTelegram(tokens) {
  if (!config.telegram.enabled) return { skipped: true, reason: "Telegram disabled" };
  if (!config.telegram.botToken || !config.telegram.chatId) return { skipped: true, reason: "Telegram missing config" };
  const fresh = (tokens ?? []).slice(0, 8);
  if (!fresh.length) return { skipped: true, reason: "No new hot rank tokens" };

  const lines = [
    "<b>🔥 [热度排行新上榜]</b>",
    "来源：币安广场热度 + 推特热度融合",
    ...fresh.map((token) => {
      const links = signalLinks(token);
      return `#${escapeHtml(token.rank ?? "--")} <b>${escapeHtml(token.symbol)}</b> · ${escapeHtml(token.chainLabel ?? "--")} · 搜索 ${escapeHtml(links.twitterQuery)}`;
    }),
    "提示：这是热度排行提醒，不是均线一级警报。"
  ];

  const first = fresh[0];
  const result = await postTelegram(lines.join("\n"), signalReplyMarkup(first));
  return { skipped: false, result };
}

export async function sendWatchlistTelegram(item, reason) {
  if (!config.telegram.enabled) return { skipped: true, reason: "Telegram disabled" };
  if (!config.telegram.botToken || !config.telegram.chatId) return { skipped: true, reason: "Telegram missing config" };
  const text = [
    "<b>🎯 [关注池价格警报]</b>",
    `交易对：<b>${escapeHtml(item.symbol)}</b>`,
    `现价：${escapeHtml(item.currentPrice ?? "--")}`,
    `触发：${escapeHtml(reason)}`,
    item.note ? `备注：${escapeHtml(item.note)}` : null,
    "提示：这是关注池自定义价格提醒，不是全市场均线信号。"
  ].filter(Boolean).join("\n");

  const result = await postTelegram(text, signalReplyMarkup(item));
  return { skipped: false, result };
}

function formatFundingRate(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return "--";
  return `${(number * 100).toFixed(4)}%`;
}

export async function sendFundingIntervalTelegram(item) {
  if (!config.telegram.enabled) return { skipped: true, reason: "Telegram disabled" };
  if (!config.telegram.botToken || !config.telegram.chatId) return { skipped: true, reason: "Telegram missing config" };
  const previous = Number(item.previousFundingIntervalHours);
  const current = Number(item.fundingIntervalHours);
  const changeText = Number.isFinite(previous) && previous > 0 ? `${previous}h -> ${current}h` : `首次发现 ${current}h`;
  const text = [
    "<b>[资金费率结算周期变化]</b>",
    `交易对：<b>${escapeHtml(item.symbol)}</b>`,
    `结算周期：<b>${escapeHtml(changeText)}</b>`,
    `资金费率上限：${escapeHtml(formatFundingRate(item.adjustedFundingRateCap))}`,
    `资金费率下限：${escapeHtml(formatFundingRate(item.adjustedFundingRateFloor))}`,
    item.lastChangedAt ? `变化时间：${escapeHtml(new Date(item.lastChangedAt).toLocaleString("zh-CN", { hour12: false }))}` : null,
    "提示：这是 Binance USDⓈ-M fundingInfo 公开数据监控，不构成投资建议。"
  ].filter(Boolean).join("\n");

  const result = await postTelegram(text, signalReplyMarkup(item));
  return { skipped: false, result };
}

export function telegramSearchLinks(symbol) {
  return signalLinks({ symbol });
}
