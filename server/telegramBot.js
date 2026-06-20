import fs from "node:fs";
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

let botRunning = false;
let updateOffset = 0;
let lockFd = null;
let menuWarmTimer = null;
const lockPath = path.join(os.tmpdir(), "binance-ma-monitor-telegram-bot.lock");
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
  conflictCount: 0
};
const OI_TIME_WINDOWS = new Set(["5m", "15m", "1h", "4h", "1d"]);
const OI_SORTS = new Set(["asc", "desc"]);
const TELEGRAM_HOT_RANK_LIMIT = 30;
const TELEGRAM_MENU_LIST_LIMIT = 30;
const TELEGRAM_OI_LIMIT = 10;

export function getTelegramBotState() {
  return { ...botStatus };
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function formatNumber(value) {
  if (value === null || value === undefined || value === "") return "--";
  const number = Number(value);
  if (!Number.isFinite(number)) return String(value);
  return number.toLocaleString("en-US", { maximumFractionDigits: 12 });
}

function levelLabel(level) {
  if (level === "LEVEL1") return "一级警报";
  if (level === "LEVEL2") return "二级预警";
  if (level === "NONE") return "观察";
  return "样本不足";
}

function formatOiChange(value) {
  const numeric = Number(value);
  return value === null || value === undefined || !Number.isFinite(numeric) ? "--" : `${numeric.toFixed(2)}%`;
}

function oiChangeSummary(row) {
  const intervals = [
    ["5m", row.oiChange5mPct, row.oiSpike5mHit],
    ["1h", row.oiChange1hPct, row.oiSpike1hHit],
    ["4h", row.oiChange4hPct, row.oiSpike4hHit],
    ["1d", row.oiChange1dPct, row.oiSpike1dHit]
  ];
  const available = intervals.filter(([, value]) => {
    const numeric = Number(value);
    return value !== null && value !== undefined && Number.isFinite(numeric);
  });
  const hits = available.filter(([, , hit]) => hit);
  return (hits.length ? hits : available)
    .map(([label, value]) => `${label} ${formatOiChange(value)}`)
    .join("｜");
}

function clampPage(page, total, pageSize) {
  const totalPages = Math.max(1, Math.ceil(Number(total || 0) / Number(pageSize || 1)));
  return Math.min(Math.max(1, Number(page) || 1), totalPages);
}

async function sendOrEditMessage({ chatId, messageId = null, text, replyMarkup }) {
  const chunks = splitTelegramText(text);
  const payload = {
    chat_id: chatId,
    text: chunks[0],
    parse_mode: "HTML",
    disable_web_page_preview: true,
    reply_markup: chunks.length === 1 ? replyMarkup : undefined
  };
  if (!messageId) {
    const first = await telegramApi("sendMessage", payload);
    for (const [index, chunk] of chunks.slice(1).entries()) {
      await telegramApi("sendMessage", {
        chat_id: chatId,
        text: chunk,
        parse_mode: "HTML",
        disable_web_page_preview: true,
        reply_markup: index === chunks.length - 2 ? replyMarkup : undefined
      });
    }
    return first;
  }
  try {
    const edited = await telegramApi("editMessageText", { ...payload, message_id: messageId });
    for (const [index, chunk] of chunks.slice(1).entries()) {
      await telegramApi("sendMessage", {
        chat_id: chatId,
        text: chunk,
        parse_mode: "HTML",
        disable_web_page_preview: true,
        reply_markup: index === chunks.length - 2 ? replyMarkup : undefined
      });
    }
    return edited;
  } catch (error) {
    if (error instanceof Error && error.message.includes("message is not modified")) return null;
    if (error instanceof Error && /message to edit not found|message can't be edited|message identifier is not specified/i.test(error.message)) {
      return sendOrEditMessage({ chatId, text, replyMarkup });
    }
    throw error;
  }
}

function splitLongTelegramBlock(block, maxLength) {
  if (block.length <= maxLength) return [block];
  const chunks = [];
  let current = "";
  for (const line of block.split("\n")) {
    if (line.length > maxLength) {
      if (current) chunks.push(current);
      for (let index = 0; index < line.length; index += maxLength) {
        chunks.push(line.slice(index, index + maxLength));
      }
      current = "";
      continue;
    }
    const next = current ? `${current}\n${line}` : line;
    if (next.length <= maxLength) {
      current = next;
      continue;
    }
    if (current) chunks.push(current);
    current = line;
  }
  if (current) chunks.push(current);
  return chunks;
}

export function splitTelegramText(text, maxLength = 3900) {
  const source = String(text ?? "");
  if (source.length <= maxLength) return [source];
  const chunks = [];
  let current = "";
  for (const block of source.split(/\n\n/)) {
    for (const part of splitLongTelegramBlock(block, maxLength)) {
      const next = current ? `${current}\n\n${part}` : part;
      if (next.length <= maxLength) {
        current = next;
        continue;
      }
      if (current) chunks.push(current);
      current = part;
    }
  }
  if (current) chunks.push(current);
  return chunks.length ? chunks : [source.slice(0, maxLength)];
}

function isAllowedChat(chatId) {
  return String(chatId) === String(config.telegram.chatId);
}

function processIsRunning(pid) {
  if (!pid || !Number.isFinite(pid)) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function acquirePollingLock() {
  try {
    lockFd = fs.openSync(lockPath, "wx");
    fs.writeFileSync(lockFd, String(process.pid));
    return { acquired: true };
  } catch (error) {
    if (error?.code !== "EEXIST") return { acquired: false, reason: error.message };
    let existingPid = 0;
    try {
      existingPid = Number(fs.readFileSync(lockPath, "utf8").trim());
    } catch {
      existingPid = 0;
    }
    if (processIsRunning(existingPid)) {
      return { acquired: false, reason: `Telegram polling already held by local PID ${existingPid}` };
    }
    try {
      fs.unlinkSync(lockPath);
    } catch {
      return { acquired: false, reason: "Telegram polling lock exists and cannot be removed" };
    }
    return acquirePollingLock();
  }
}

function releasePollingLock() {
  if (lockFd === null) return;
  try {
    fs.closeSync(lockFd);
  } catch {
    // Ignore cleanup errors during process shutdown.
  }
  lockFd = null;
  try {
    fs.unlinkSync(lockPath);
  } catch {
    // Ignore stale lock cleanup errors; startup handles stale locks.
  }
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
  return [
    `${telegramTokenLine(row.symbol, `${index}. `)}${multiText}`,
    `分类：${escapeHtml(row.categoryLabel)}｜周期：${escapeHtml((row.intervals ?? [row.intervalCode]).join(" / "))}`,
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

async function sendHeat(chatId, messageId = null) {
  const payload = await menuCache.get("heat", () => getHotRank({ chain: "all", limit: TELEGRAM_HOT_RANK_LIMIT }));
  const visibleTokens = payload.tokens ?? [];
  const rows = visibleTokens.map((token) =>
    `#${escapeHtml(token.rank)} ${telegramTokenLine(token.symbol)} · 热度 ${escapeHtml(token.heat)} · 币安 ${escapeHtml(token.binanceHeat ?? "--")} · ${escapeHtml(token.chainLabel)}`
  );
  const flags = [
    payload.stale ? "使用上次缓存" : null,
    !payload.stale && payload.partial ? "部分链失败" : null,
    Array.isArray(payload.errors) && payload.errors.length ? `错误 ${payload.errors.length} 条` : null
  ].filter(Boolean);
  const keyboard = appendMainNavigation(
    { inline_keyboard: tokenOperationRows(visibleTokens.map((token) => token.symbol)) },
    "heat"
  );
  await sendOrEditMessage({
    chatId,
    messageId,
    text: [
      rows.length ? `<b>综合热度排行 · 共 ${rows.length} 个</b>` : "<b>综合热度排行</b>",
      `来源：${escapeHtml(payload.source || "Binance Web3 Social Hype")}${flags.length ? ` · ${escapeHtml(flags.join(" · "))}` : ""}`,
      rows.length ? rows.join("\n") : "暂无热度数据。"
    ].join("\n"),
    replyMarkup: keyboard
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
    if (data === "heat") return sendHeat(chatId, messageId);
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
        console.error("telegram bot polling failed:", message);
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
