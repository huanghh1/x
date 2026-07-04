import os from "node:os";
import path from "node:path";
import { createAsyncCache } from "./asyncCache.js";
import { config } from "./config.js";
import { getHotRank } from "./hotRank.js";
import {
  getHotMaSignalsPage,
  getMultiCycleSignalsPage,
  getSignalGroupsPage,
  listOneHourFundingIntervals,
  listOpenInterestMonitor,
  markFundingIntervalAlertConfirmed,
  listWatchlist
} from "./db.js";
import { resolveSignalProfile } from "./signalPriority.js";
import {
  telegramApi,
  telegramTokenCopyButton,
  telegramTokenLine
} from "./telegram.js";
import {
  clampPage,
  escapeHtml,
  formatNumber,
  levelLabel,
  oiChangeSummary,
  sendOrEditMessage
} from "./telegramBot/messageUtils.js";
import { createPollingLock } from "./telegramBot/pollingLock.js";

export { splitTelegramText } from "./telegramBot/messageUtils.js";

let botRunning = false;
let updateOffset = 0;
let menuWarmTimer = null;
const lockPath = path.join(os.tmpdir(), "binance-ma-monitor-telegram-bot.lock");
const { acquirePollingLock, releasePollingLock } = createPollingLock(lockPath);
const menuCache = createAsyncCache({
  ttlMs: config.telegram.menuCacheMs,
  staleMs: config.telegram.menuStaleMs,
  onBackgroundError: (error) => {
    console.error("telegram menu background refresh failed:", error instanceof Error ? error.message : error);
  }
});
const botStatus = {
  running: false,
  state: "stopped",
  startedAt: null,
  lastPollAt: null,
  lastUpdateAt: null,
  lastError: null,
  lockPath,
  conflictCount: 0,
  pollingErrorCount: 0,
  suppressedPollingErrors: 0
};
const pollingErrorLog = {
  key: null,
  lastLoggedAt: 0,
  suppressed: 0
};
const OI_TIME_WINDOWS = new Set(["5m", "15m", "1h", "4h", "1d"]);
const OI_SORTS = new Set(["asc", "desc"]);
const TELEGRAM_HOT_RANK_LIMIT = 30;
const TELEGRAM_HOT_RANK_PAGE_SIZE = 8;
const TELEGRAM_MENU_LIST_LIMIT = 30;
const TELEGRAM_OI_LIMIT = 10;

export function getTelegramBotState() {
  return { ...botStatus };
}

function pollingErrorKey(message) {
  const text = String(message ?? "");
  if (/(connect timeout|und_err|etimedout|econnreset|enotfound|eai_again|fetch failed)/i.test(text)) {
    return "network";
  }
  if (/too many requests|429|rate limit/i.test(text)) return "rate_limit";
  if (/conflict/i.test(text)) return "conflict";
  return text.slice(0, 160);
}

function logPollingError(message) {
  const now = Date.now();
  const key = pollingErrorKey(message);
  const shouldLog =
    pollingErrorLog.key !== key ||
    pollingErrorLog.lastLoggedAt === 0 ||
    now - pollingErrorLog.lastLoggedAt >= 5 * 60 * 1000;
  if (!shouldLog) {
    pollingErrorLog.suppressed += 1;
    botStatus.suppressedPollingErrors += 1;
    return;
  }
  const suffix = pollingErrorLog.suppressed > 0
    ? ` (suppressed ${pollingErrorLog.suppressed} similar polling errors)`
    : "";
  console.error("telegram bot polling failed:", `${message}${suffix}`);
  pollingErrorLog.key = key;
  pollingErrorLog.lastLoggedAt = now;
  pollingErrorLog.suppressed = 0;
}

function isAllowedChat(chatId) {
  return String(chatId) === String(config.telegram.chatId);
}

function navButtonText(label, key, active) {
  return active === key ? `【${label}】` : label;
}

function normalizeOiTimeWindow(timeWindow) {
  const value = String(timeWindow ?? "");
  return OI_TIME_WINDOWS.has(value) ? value : "5m";
}

function normalizeOiSort(sort) {
  const value = String(sort ?? "");
  return OI_SORTS.has(value) ? value : "desc";
}

export function signalKeyboard(active = null) {
  return {
    inline_keyboard: [
      [
        { text: navButtonText("均线组合", "signals", active), callback_data: "signals" },
        { text: navButtonText("多周期", "multi", active), callback_data: "multi:1" },
        { text: navButtonText("热度排行", "heat", active), callback_data: "heat" }
      ],
      [
        { text: navButtonText("资金费率", "funding", active), callback_data: "funding" },
        { text: navButtonText("OI监控", "oi", active), callback_data: "oi:5m:desc" },
        { text: navButtonText("关注池", "watch", active), callback_data: "watch" }
      ]
    ]
  };
}

function tokenOperationRows(symbols, limit = 20) {
  const buttons = [...new Set((symbols ?? []).filter(Boolean))]
    .slice(0, limit)
    .map((symbol) => telegramTokenCopyButton(symbol));
  return Array.from({ length: Math.ceil(buttons.length / 3) }, (_, index) =>
    buttons.slice(index * 3, index * 3 + 3)
  );
}

function appendMainNavigation(keyboard, active = null) {
  keyboard.inline_keyboard.push(...signalKeyboard(active).inline_keyboard);
  return keyboard;
}

function limitMenuItems(items, limit = TELEGRAM_MENU_LIST_LIMIT) {
  const source = Array.isArray(items) ? items : [];
  const safeLimit = Math.max(1, Math.min(100, Number(limit) || TELEGRAM_MENU_LIST_LIMIT));
  return {
    visibleItems: source.slice(0, safeLimit),
    hiddenCount: Math.max(0, source.length - safeLimit)
  };
}

function hiddenItemsText(hiddenCount) {
  return hiddenCount > 0 ? `仅显示前 ${TELEGRAM_MENU_LIST_LIMIT} 项，另有 ${hiddenCount} 项未展开。` : null;
}

function pageButtons({ prefix, page, total, pageSize }) {
  const totalPages = Math.max(1, Math.ceil(Number(total || 0) / Number(pageSize || 1)));
  return [
    { text: "‹ 上一页", callback_data: page <= 1 ? "noop" : `${prefix}:${page - 1}` },
    { text: `${page}/${totalPages}`, callback_data: "noop" },
    { text: "下一页 ›", callback_data: page >= totalPages ? "noop" : `${prefix}:${page + 1}` }
  ];
}

function signalNavKeyboard({ level, interval, page, total, pageSize, symbols }) {
  const keyboard = { inline_keyboard: [] };
  keyboard.inline_keyboard.push(pageButtons({ prefix: "ranked", page, total, pageSize }));
  keyboard.inline_keyboard.push(...tokenOperationRows(symbols));
  return appendMainNavigation(keyboard, "signals");
}

export function signalRowText(row, index) {
  const multiRequired = Number(row.multiMatchRequired ?? 0);
  const multiCount = Number(row.multiMatchCount ?? 0);
  const multiText = multiRequired > 1 && multiCount >= multiRequired ? `\n多周期：${multiCount}/${multiRequired}` : "";
  const profile = resolveSignalProfile({
    fundingOneHour: row.fundingOneHour,
    oiMatched: row.oiMatched,
    oiSpike: row.oiSpikeHit,
    hotRank: Boolean(row.hotRankHit),
    multiCycleCount: row.multiMatchCount,
    alertLevel: row.bestAlertLevel ?? row.alertLevel
  });
  const oiText = row.oiMatched
    ? `OI暴涨：${oiChangeSummary(row) || "暂无可用变化率"}`
    : null;
  const sourceOnlySignal = !(row.intervals?.length) && (row.fundingOneHour || row.oiMatched || row.oiSpikeHit);
  const intervalText = sourceOnlySignal
    ? "--"
    : (row.intervals?.length ? row.intervals : [row.intervalCode]).filter(Boolean).join(" / ") || "--";
  return [
    `${telegramTokenLine(row.symbol, `${index}. `)}${multiText}`,
    `分类：${escapeHtml(row.categoryLabel)}｜周期：${escapeHtml(intervalText)}`,
    `组合等级：${escapeHtml(profile.label)}`,
    oiText ? escapeHtml(oiText) : null,
    `现价：${escapeHtml(formatNumber(row.currentPrice))}`,
    `MA100：${escapeHtml(formatNumber(row.ma100))}`,
    `MA200：${escapeHtml(formatNumber(row.ma200))}`,
    `状态：${escapeHtml(row.signalStatus)}`,
    `说明：${escapeHtml(row.note || "--")}`
  ].filter(Boolean).join("\n");
}

async function sendSignals(chatId, level = "LEVEL1", interval = "15m", page = 1, messageId = null) {
  const pageSize = 4;
  const payload = await menuCache.get(`signals:${page}`, () =>
    getSignalGroupsPage({
      categories: "A,B",
      levels: "LEVEL1,LEVEL2",
      intervals: "15m,1h,4h,1d",
      page,
      pageSize
    })
  );
  const safePage = clampPage(payload.page, payload.total, payload.pageSize);
  const startIndex = (safePage - 1) * payload.pageSize;
  const rows = payload.signals.map((row, index) => signalRowText(row, startIndex + index + 1));
  const symbols = [...new Set(payload.signals.map((row) => row.symbol).filter(Boolean))];
  const totalPages = Math.max(1, Math.ceil(payload.total / payload.pageSize));
  const text = rows.length
    ? ["<b>均线组合排行</b>", `第 ${safePage}/${totalPages} 页 · 共 ${payload.total} 个代币`, ...rows].join("\n\n")
    : "<b>均线组合排行</b>\n暂无信号";
  await sendOrEditMessage({
    chatId,
    messageId,
    text,
    replyMarkup: signalNavKeyboard({ level, interval, page: safePage, total: payload.total, pageSize: payload.pageSize, symbols })
  });
}

function multiNavKeyboard({ page, total, pageSize, symbols }) {
  const keyboard = { inline_keyboard: [] };
  keyboard.inline_keyboard.push(pageButtons({ prefix: "multi", page, total, pageSize }));
  keyboard.inline_keyboard.push(...tokenOperationRows(symbols));
  return appendMainNavigation(keyboard, "multi");
}

function multiGroupText(group, index) {
  const rows = group.rows.map((row) =>
    [
      `${escapeHtml(row.intervalCode)}｜${escapeHtml(levelLabel(row.alertLevel))}`,
      `现价 ${escapeHtml(formatNumber(row.currentPrice))}`,
      `MA100 ${escapeHtml(formatNumber(row.ma100))}`,
      `MA200 ${escapeHtml(formatNumber(row.ma200))}`,
      `${escapeHtml(row.note || row.signalStatus || "--")}`
    ].join("｜")
  );
  return [
    `${telegramTokenLine(group.symbol, `${index}. `)} · 多周期 ${group.multiMatchCount}/${group.multiMatchRequired}`,
    ...rows
  ].join("\n");
}

async function sendMultiCycleSignals(chatId, page = 1, messageId = null) {
  const pageSize = 4;
  const payload = await menuCache.get(`multi:${page}`, () =>
    getMultiCycleSignalsPage({
      categories: "A,B",
      levels: "LEVEL1,LEVEL2",
      intervals: "15m,1h,4h,1d",
      page,
      pageSize
    })
  );
  const safePage = clampPage(payload.page, payload.total, payload.pageSize);
  const startIndex = (safePage - 1) * payload.pageSize;
  const rows = payload.groups.map((group, index) => multiGroupText(group, startIndex + index + 1));
  const symbols = payload.groups.map((group) => group.symbol).filter(Boolean);
  const totalPages = Math.max(1, Math.ceil(payload.total / payload.pageSize));
  await sendOrEditMessage({
    chatId,
    messageId,
    text: rows.length
      ? [`<b>多周期共振 · 一级/二级 · 15m/1h/4h/1d</b>`, `第 ${safePage}/${totalPages} 页 · 共 ${payload.total} 个代币`, ...rows].join("\n\n")
      : "<b>多周期共振</b>\n暂无满足条件的代币。",
    replyMarkup: multiNavKeyboard({ page: safePage, total: payload.total, pageSize: payload.pageSize, symbols })
  });
}

function hotMaNavKeyboard({ page, total, pageSize, symbols }) {
  const keyboard = { inline_keyboard: [] };
  keyboard.inline_keyboard.push(pageButtons({ prefix: "hotma", page, total, pageSize }));
  keyboard.inline_keyboard.push(...tokenOperationRows(symbols));
  return appendMainNavigation(keyboard, "heat");
}

function hotMaRowText(row, index) {
  return [
    `${telegramTokenLine(row.symbol, `${index}. 🔥 `)} · 热度 #${escapeHtml(row.hotRank ?? "--")} · ${escapeHtml(levelLabel(row.alertLevel))}`,
    `周期：${escapeHtml(row.intervalCode)}｜现价：${escapeHtml(formatNumber(row.currentPrice))}`,
    `MA100：${escapeHtml(formatNumber(row.ma100))}｜MA200：${escapeHtml(formatNumber(row.ma200))}`,
    `说明：${escapeHtml(row.note || "--")}`
  ].join("\n");
}

async function sendHotMa(chatId, page = 1, messageId = null) {
  const pageSize = 5;
  const payload = await menuCache.get(`hotma:${page}`, () => getHotMaSignalsPage({ page, pageSize }));
  const safePage = clampPage(payload.page, payload.total, payload.pageSize);
  const startIndex = (safePage - 1) * payload.pageSize;
  const rows = payload.signals.map((row, index) => hotMaRowText(row, startIndex + index + 1));
  const symbols = [...new Set(payload.signals.map((row) => row.symbol).filter(Boolean))];
  const totalPages = Math.max(1, Math.ceil(payload.total / payload.pageSize));
  await sendOrEditMessage({
    chatId,
    messageId,
    text: rows.length
      ? [`<b>🔥🔥🔥 热度+均线最高等级信号</b>`, `第 ${safePage}/${totalPages} 页 · 共 ${payload.total} 条`, ...rows].join("\n\n")
      : "<b>🔥🔥🔥 热度+均线最高等级信号</b>\n暂无同时满足热度排行和均线触发的代币。",
    replyMarkup: hotMaNavKeyboard({ page: safePage, total: payload.total, pageSize: payload.pageSize, symbols })
  });
}

export function heatRankKeyboard({ page, total, pageSize, symbols }) {
  const keyboard = { inline_keyboard: [] };
  keyboard.inline_keyboard.push(pageButtons({ prefix: "heat", page, total, pageSize }));
  keyboard.inline_keyboard.push(...tokenOperationRows(symbols));
  return appendMainNavigation(keyboard, "heat");
}

async function sendHeat(chatId, page = 1, messageId = null) {
  const payload = await menuCache.get("heat", () => getHotRank({ chain: "all", limit: TELEGRAM_HOT_RANK_LIMIT }));
  const visibleTokens = payload.tokens ?? [];
  const safePage = clampPage(page, visibleTokens.length, TELEGRAM_HOT_RANK_PAGE_SIZE);
  const startIndex = (safePage - 1) * TELEGRAM_HOT_RANK_PAGE_SIZE;
  const pageTokens = visibleTokens.slice(startIndex, startIndex + TELEGRAM_HOT_RANK_PAGE_SIZE);
  const rows = pageTokens.map((token) =>
    `#${escapeHtml(token.rank)} ${telegramTokenLine(token.symbol)} · 热度 ${escapeHtml(token.heat)} · 币安 ${escapeHtml(token.binanceHeat ?? "--")} · ${escapeHtml(token.chainLabel)}`
  );
  const totalPages = Math.max(1, Math.ceil(visibleTokens.length / TELEGRAM_HOT_RANK_PAGE_SIZE));
  const flags = [
    payload.stale ? "使用上次缓存" : null,
    !payload.stale && payload.partial ? "部分链失败" : null,
    Array.isArray(payload.errors) && payload.errors.length ? `错误 ${payload.errors.length} 条` : null
  ].filter(Boolean);
  await sendOrEditMessage({
    chatId,
    messageId,
    text: [
      "<b>综合热度排行</b>",
      rows.length ? `第 ${safePage}/${totalPages} 页 · 共 ${visibleTokens.length} 个代币` : null,
      `来源：${escapeHtml(payload.source || "Binance Web3 Social Hype")}${flags.length ? ` · ${escapeHtml(flags.join(" · "))}` : ""}`,
      rows.length ? rows.join("\n\n") : "暂无热度数据。"
    ].filter(Boolean).join("\n\n"),
    replyMarkup: heatRankKeyboard({
      page: safePage,
      total: visibleTokens.length,
      pageSize: TELEGRAM_HOT_RANK_PAGE_SIZE,
      symbols: pageTokens.map((token) => token.symbol)
    })
  });
}

async function sendWatch(chatId, messageId = null) {
  const items = await menuCache.get("watch", () => listWatchlist());
  const { visibleItems, hiddenCount } = limitMenuItems(items);
  const rows = visibleItems.map((item, index) =>
    `${index + 1}. ${telegramTokenLine(item.symbol)} · 现价 ${escapeHtml(item.currentPrice ?? "--")} · 高于 ${escapeHtml(item.alertAbove ?? "--")} · 低于 ${escapeHtml(item.alertBelow ?? "--")}`
  );
  const keyboard = appendMainNavigation(
    { inline_keyboard: tokenOperationRows(visibleItems.map((item) => item.symbol)) },
    "watch"
  );
  const tail = hiddenItemsText(hiddenCount);
  await sendOrEditMessage({
    chatId,
    messageId,
    text: rows.length ? [`<b>关注池 · 共 ${items.length} 个</b>`, ...rows, tail].filter(Boolean).join("\n") : "<b>关注池</b>\n暂无关注代币。",
    replyMarkup: keyboard
  });
}

async function sendFunding(chatId, messageId = null) {
  const items = await menuCache.get("funding", () => listOneHourFundingIntervals());
  const { visibleItems, hiddenCount } = limitMenuItems(items);
  const rows = visibleItems.map((item, index) => {
    const matches = [
      item.oiMatched ? "OI" : null,
      item.hotRank ? "热度" : null,
      Number(item.multiCycleCount ?? 0) >= 3 ? "多周期" : null
    ].filter(Boolean);
    return `${index + 1}. ${telegramTokenLine(item.symbol)} · 当前资金费率 ${escapeHtml(
      item.currentFundingRate === null ? "--" : `${(Number(item.currentFundingRate) * 100).toFixed(4)}%`
    )} · 均线 ${escapeHtml((item.intervals ?? []).join(" / ") || "--")} · 匹配 ${escapeHtml(matches.join(" + ") || "暂无")}`;
  });
  const keyboard = appendMainNavigation(
    { inline_keyboard: tokenOperationRows(visibleItems.map((item) => item.symbol)) },
    "funding"
  );
  const tail = hiddenItemsText(hiddenCount);
  await sendOrEditMessage({
    chatId,
    messageId,
    text: rows.length ? [`<b>1小时资金费率代币 · 共 ${items.length} 个</b>`, ...rows, tail].filter(Boolean).join("\n") : "<b>资金费率</b>\n当前没有1小时资金费率的代币。",
    replyMarkup: keyboard
  });
}

export function oiFilterKeyboard({ timeWindow = "5m", sort = "desc", symbols = [] } = {}) {
  const safeTimeWindow = normalizeOiTimeWindow(timeWindow);
  const safeSort = normalizeOiSort(sort);
  const keyboard = {
    inline_keyboard: [
      ["5m", "15m", "1h", "4h", "1d"].map((window) => ({
        text: window === safeTimeWindow ? `✓ ${window}` : window,
        callback_data: `oi:${window}:${safeSort}`
      })),
      [
        { text: safeSort === "desc" ? "✓ 从高到低" : "从高到低", callback_data: `oi:${safeTimeWindow}:desc` },
        { text: safeSort === "asc" ? "✓ 从低到高" : "从低到高", callback_data: `oi:${safeTimeWindow}:asc` }
      ],
      ...tokenOperationRows(symbols)
    ]
  };
  return appendMainNavigation(keyboard, "oi");
}

async function sendOI(chatId, timeWindow = "5m", sort = "desc", messageId = null) {
  const safeTimeWindow = normalizeOiTimeWindow(timeWindow);
  const safeSort = normalizeOiSort(sort);
  const items = await menuCache.get(`oi:${safeTimeWindow}:${safeSort}`, () =>
    listOpenInterestMonitor({ timeWindow: safeTimeWindow, sort: safeSort, limit: TELEGRAM_OI_LIMIT })
  );
  const rows = items.map((item, index) => {
    const intervals = item.signalIntervals ?? [];
    const matches = [
      item.hotRankHit ? "热度" : null,
      item.fundingOneHour ? "1h资金费率" : null,
      intervals.length ? `均线 ${intervals.join(" / ")}` : null
    ].filter(Boolean);
    return `${index + 1}. ${telegramTokenLine(item.symbol)} · ${escapeHtml(safeTimeWindow)} ${escapeHtml(
      item.changePercent === null ? "--" : `${Number(item.changePercent).toFixed(2)}%`
    )} · 匹配 ${escapeHtml(matches.join(" + ") || "暂无")}`;
  });
  const keyboard = oiFilterKeyboard({
    timeWindow: safeTimeWindow,
    sort: safeSort,
    symbols: items.map((item) => item.symbol)
  });
  await sendOrEditMessage({
    chatId,
    messageId,
    text: rows.length ? [`<b>OI监控 · ${escapeHtml(safeTimeWindow)} · TOP ${items.length}</b>`, ...rows].join("\n") : "<b>OI监控</b>\n暂无 OI 数据。",
    replyMarkup: keyboard
  });
}

async function answerCallback(callbackId, payload = {}) {
  if (!callbackId) return;
  try {
    await telegramApi("answerCallbackQuery", { callback_query_id: callbackId, ...payload });
  } catch (error) {
    console.error("telegram callback acknowledgement failed:", error instanceof Error ? error.message : error);
  }
}

async function handleMessage(message) {
  const chatId = message?.chat?.id;
  if (!isAllowedChat(chatId)) return;
  const text = String(message.text ?? "").trim();
  if (text.startsWith("/heat")) return sendHeat(chatId);
  if (text.startsWith("/watch")) return sendWatch(chatId);
  if (text.startsWith("/hotma")) return sendHotMa(chatId, 1);
  if (text.startsWith("/multi")) return sendMultiCycleSignals(chatId, 1);
  if (text.startsWith("/funding")) return sendFunding(chatId);
  if (text.startsWith("/oi")) return sendOI(chatId);
  if (text.startsWith("/signals")) return sendSignals(chatId, "LEVEL1", "15m");
  return telegramApi("sendMessage", {
    chat_id: chatId,
    text: "可用命令：/signals 均线排行，/multi 多周期，/heat 热度排行，/funding 资金费率，/oi OI监控，/watch 关注池。",
    reply_markup: signalKeyboard()
  });
}

async function handleCallback(callback) {
  const chatId = callback?.message?.chat?.id;
  if (!isAllowedChat(chatId)) {
    await answerCallback(callback?.id, { text: "这个聊天没有授权使用此 bot。" });
    return;
  }
  const data = String(callback.data ?? "");
  void answerCallback(callback.id, data.startsWith("funding_confirm:") ? { text: "正在确认..." } : {});
  try {
    if (data === "noop") return;
    const messageId = callback?.message?.message_id ?? null;
    if (data === "heat") return sendHeat(chatId, 1, messageId);
    if (data.startsWith("heat:")) {
      const [, page] = data.split(":");
      return sendHeat(chatId, page, messageId);
    }
    if (data === "watch") return sendWatch(chatId, messageId);
    if (data === "funding") return sendFunding(chatId, messageId);
    if (data.startsWith("funding_confirm:")) {
      const [, symbol] = data.split(":");
      await markFundingIntervalAlertConfirmed(symbol);
      menuCache.invalidate("funding");
      return sendFunding(chatId, messageId);
    }
    if (data === "signals") return sendSignals(chatId, "LEVEL1", "15m", 1, messageId);
    if (data.startsWith("hotma:")) {
      const [, page] = data.split(":");
      return sendHotMa(chatId, page, messageId);
    }
    if (data.startsWith("multi:")) {
      const [, page] = data.split(":");
      return sendMultiCycleSignals(chatId, page, messageId);
    }
    if (data.startsWith("sig:")) {
      const [, level, interval, page] = data.split(":");
      return sendSignals(chatId, level, interval, page, messageId);
    }
    if (data.startsWith("ranked:")) {
      const [, page] = data.split(":");
      return sendSignals(chatId, "LEVEL1", "15m", page, messageId);
    }
    if (data.startsWith("oi:")) {
      const [, timeWindow, sort] = data.split(":");
      return sendOI(chatId, timeWindow, sort, messageId);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("telegram callback failed:", message);
    await telegramApi("sendMessage", {
      chat_id: chatId,
      text: `按钮处理失败：${escapeHtml(message)}`,
      parse_mode: "HTML"
    });
  }
}

async function pollOnce() {
  botStatus.state = "polling";
  botStatus.lastPollAt = new Date().toISOString();
  const updates = await telegramApi("getUpdates", {
    offset: updateOffset,
    timeout: 25,
    allowed_updates: ["message", "callback_query"]
  });
  for (const update of updates) {
    updateOffset = Math.max(updateOffset, Number(update.update_id) + 1);
    botStatus.lastUpdateAt = new Date().toISOString();
    const task = update.message
      ? handleMessage(update.message)
      : update.callback_query
        ? handleCallback(update.callback_query)
        : null;
    task?.catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      botStatus.lastError = message;
      console.error("telegram update handling failed:", message);
    });
  }
}

async function warmPrimaryMenus() {
  await Promise.allSettled([
    menuCache.get("signals:1", () =>
      getSignalGroupsPage({
        categories: "A,B",
        levels: "LEVEL1,LEVEL2",
        intervals: "15m,1h,4h,1d",
        page: 1,
        pageSize: 4
      })
    ),
    menuCache.get("multi:1", () =>
      getMultiCycleSignalsPage({
        categories: "A,B",
        levels: "LEVEL1,LEVEL2",
        intervals: "15m,1h,4h,1d",
        page: 1,
        pageSize: 4
      })
    ),
    menuCache.get("funding", () => listOneHourFundingIntervals()),
    menuCache.get("oi:5m:desc", () => listOpenInterestMonitor({ timeWindow: "5m", sort: "desc", limit: TELEGRAM_OI_LIMIT }))
  ]);
}

function startMenuWarmup() {
  warmPrimaryMenus().catch((error) => {
    console.error("telegram menu warmup failed:", error instanceof Error ? error.message : error);
  });
  menuWarmTimer = setInterval(() => {
    warmPrimaryMenus().catch((error) => {
      console.error("telegram menu refresh failed:", error instanceof Error ? error.message : error);
    });
  }, config.telegram.menuWarmIntervalMs);
  menuWarmTimer.unref?.();
}

export function startTelegramBot() {
  if (botRunning) return { running: true };
  if (!config.telegram.enabled) {
    botStatus.running = false;
    botStatus.state = "disabled";
    botStatus.lastError = null;
    return { running: false, reason: "Telegram disabled" };
  }
  if (!config.telegram.botToken || !config.telegram.chatId) {
    botStatus.running = false;
    botStatus.state = "not_configured";
    botStatus.lastError = "Telegram missing TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID";
    return { running: false, reason: botStatus.lastError };
  }
  const lock = acquirePollingLock();
  if (!lock.acquired) {
    botStatus.running = false;
    botStatus.state = "lock_held";
    botStatus.lastError = lock.reason;
    console.error(`telegram bot polling skipped: ${lock.reason}`);
    return { running: false, reason: lock.reason };
  }
  botRunning = true;
  botStatus.running = true;
  botStatus.state = "starting";
  botStatus.startedAt = new Date().toISOString();
  botStatus.lastError = null;
  startMenuWarmup();
  const loop = async () => {
    let consecutiveErrors = 0;
    while (botRunning) {
      try {
        await pollOnce();
        consecutiveErrors = 0;
        botStatus.lastError = null;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (message.includes("Conflict: terminated by other getUpdates request")) {
          botStatus.state = "conflict";
          botStatus.conflictCount += 1;
          botStatus.lastError = message;
          console.error("telegram bot polling conflict: another getUpdates consumer is already running; retrying");
          await new Promise((resolve) => setTimeout(resolve, 10000));
          continue;
        }
        botStatus.state = "error";
        botStatus.lastError = message;
        botStatus.pollingErrorCount += 1;
        logPollingError(message);
        consecutiveErrors += 1;
        const delayMs = Math.min(60_000, 3000 * 2 ** Math.min(4, consecutiveErrors - 1));
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }
    botStatus.running = false;
    botStatus.state = "stopped";
    releasePollingLock();
  };
  loop();
  return { running: true };
}

for (const eventName of ["exit", "SIGINT", "SIGTERM"]) {
  process.once(eventName, () => {
    botRunning = false;
    if (menuWarmTimer) clearInterval(menuWarmTimer);
    releasePollingLock();
    if (eventName !== "exit") process.exit(0);
  });
}
