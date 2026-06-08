import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { config } from "./config.js";
import { getHotRank } from "./hotRank.js";
import { getHotMaSignalsPage, getMultiCycleSignalsPage, getSignalsPage, listWatchlist } from "./db.js";
import { telegramSearchLinks } from "./telegram.js";

let botRunning = false;
let updateOffset = 0;
let lockFd = null;
const lockPath = path.join(os.tmpdir(), "binance-ma-monitor-telegram-bot.lock");
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

function clampPage(page, total, pageSize) {
  const totalPages = Math.max(1, Math.ceil(Number(total || 0) / Number(pageSize || 1)));
  return Math.min(Math.max(1, Number(page) || 1), totalPages);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function telegramApi(method, payload) {
  const attempts = 2;
  let lastError = null;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const controller = new AbortController();
    const payloadTimeout = Number(payload?.timeout ?? 0) * 1000;
    const timer = setTimeout(() => controller.abort(), Math.max(config.telegram.timeoutMs + 3000, payloadTimeout + 8000));
    try {
      const response = await fetch(`https://api.telegram.org/bot${config.telegram.botToken}/${method}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: controller.signal,
        body: JSON.stringify(payload)
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || data.ok === false) {
        throw new Error(data.description ?? `Telegram ${method} HTTP ${response.status}`);
      }
      return data.result;
    } catch (error) {
      const cause = error?.cause?.message ? `: ${error.cause.message}` : "";
      lastError = error instanceof Error && error.message === "fetch failed"
        ? new Error(`Telegram ${method} fetch failed${cause}`)
        : error;
      if (!(lastError instanceof Error) || !lastError.message.includes("fetch failed") || attempt >= attempts - 1) {
        throw lastError;
      }
      await sleep(800 * (attempt + 1));
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastError ?? new Error(`Telegram ${method} failed`);
}

async function sendOrEditMessage({ chatId, messageId = null, text, replyMarkup }) {
  const payload = {
    chat_id: chatId,
    text,
    parse_mode: "HTML",
    disable_web_page_preview: true,
    reply_markup: replyMarkup
  };
  if (!messageId) return telegramApi("sendMessage", payload);
  try {
    return await telegramApi("editMessageText", { ...payload, message_id: messageId });
  } catch (error) {
    if (error instanceof Error && error.message.includes("message is not modified")) return null;
    throw error;
  }
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

function signalKeyboard() {
  const levels = [
    ["一级", "LEVEL1"],
    ["二级", "LEVEL2"]
  ];
  const intervals = ["15m", "1h", "4h", "1d"];
  return {
    inline_keyboard: [
      ...levels.map(([label, level]) =>
        intervals.map((interval) => ({ text: `${label} ${interval}`, callback_data: `sig:${level}:${interval}` }))
      ),
      [
        { text: "热度+均线信号", callback_data: "hotma:1" },
        { text: "多周期共振", callback_data: "multi:1" },
        { text: "热度排行", callback_data: "heat" },
        { text: "关注池", callback_data: "watch" }
      ]
    ]
  };
}

function tokenButtons(symbol) {
  const links = telegramSearchLinks(symbol);
  return [
    { text: `复制 ${symbol}`, copy_text: { text: symbol } },
    { text: `${symbol} 推特`, url: links.twitter },
    { text: `${symbol} 广场`, url: links.binanceSquare }
  ];
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
  for (const symbol of symbols) keyboard.inline_keyboard.push(tokenButtons(symbol));
  keyboard.inline_keyboard.push(pageButtons({ prefix: `sig:${level}:${interval}`, page, total, pageSize }));
  keyboard.inline_keyboard.push([
    { text: "热度+均线信号", callback_data: "hotma:1" },
    { text: "多周期共振", callback_data: "multi:1" },
    { text: "热度排行", callback_data: "heat" },
    { text: "关注池", callback_data: "watch" }
  ]);
  keyboard.inline_keyboard.push(...signalKeyboard().inline_keyboard.slice(0, 2));
  return keyboard;
}

function signalRowText(row, index) {
  const multiRequired = Number(row.multiMatchRequired ?? 0);
  const multiCount = Number(row.multiMatchCount ?? 0);
  const multiText = multiRequired > 1 && multiCount >= multiRequired ? `\n多周期：${multiCount}/${multiRequired}` : "";
  return [
    `<b>${index}. ${escapeHtml(row.symbol)}</b>${multiText}`,
    `分类：${escapeHtml(row.categoryLabel)}｜周期：${escapeHtml(row.intervalCode)}｜等级：${escapeHtml(levelLabel(row.alertLevel))}`,
    `现价：${escapeHtml(formatNumber(row.currentPrice))}`,
    `MA100：${escapeHtml(formatNumber(row.ma100))}`,
    `MA200：${escapeHtml(formatNumber(row.ma200))}`,
    `状态：${escapeHtml(row.signalStatus)}`,
    `说明：${escapeHtml(row.note || "--")}`
  ].join("\n");
}

async function sendSignals(chatId, level = "LEVEL1", interval = "15m", page = 1, messageId = null) {
  const pageSize = 4;
  const payload = await getSignalsPage({
    categories: "A,B",
    levels: level,
    intervals: interval,
    page,
    pageSize
  });
  const safePage = clampPage(payload.page, payload.total, payload.pageSize);
  const label = levelLabel(level);
  const startIndex = (safePage - 1) * payload.pageSize;
  const rows = payload.signals.map((row, index) => signalRowText(row, startIndex + index + 1));
  const symbols = [...new Set(payload.signals.map((row) => row.symbol).filter(Boolean))];
  const totalPages = Math.max(1, Math.ceil(payload.total / payload.pageSize));
  const text = rows.length
    ? [`<b>均线信号 · ${escapeHtml(label)} · ${escapeHtml(interval)}</b>`, `第 ${safePage}/${totalPages} 页 · 共 ${payload.total} 条`, ...rows].join("\n\n")
    : `<b>均线信号 · ${escapeHtml(label)} · ${escapeHtml(interval)}</b>\n暂无信号`;
  await sendOrEditMessage({
    chatId,
    messageId,
    text,
    replyMarkup: signalNavKeyboard({ level, interval, page: safePage, total: payload.total, pageSize: payload.pageSize, symbols })
  });
}

function multiNavKeyboard({ page, total, pageSize, symbols }) {
  const keyboard = { inline_keyboard: [] };
  for (const symbol of symbols) keyboard.inline_keyboard.push(tokenButtons(symbol));
  keyboard.inline_keyboard.push(pageButtons({ prefix: "multi", page, total, pageSize }));
  keyboard.inline_keyboard.push([
    { text: "热度+均线信号", callback_data: "hotma:1" },
    { text: "均线信号", callback_data: "signals" },
    { text: "热度排行", callback_data: "heat" },
    { text: "关注池", callback_data: "watch" }
  ]);
  return keyboard;
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
  return [`<b>${index}. ${escapeHtml(group.symbol)} · 多周期 ${group.multiMatchCount}/${group.multiMatchRequired}</b>`, ...rows].join("\n");
}

async function sendMultiCycleSignals(chatId, page = 1, messageId = null) {
  const pageSize = 4;
  const payload = await getMultiCycleSignalsPage({
    categories: "A,B",
    levels: "LEVEL1,LEVEL2",
    intervals: "15m,1h,4h,1d",
    page,
    pageSize
  });
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
  for (const symbol of symbols) keyboard.inline_keyboard.push(tokenButtons(symbol));
  keyboard.inline_keyboard.push(pageButtons({ prefix: "hotma", page, total, pageSize }));
  keyboard.inline_keyboard.push([
    { text: "均线信号", callback_data: "signals" },
    { text: "多周期共振", callback_data: "multi:1" },
    { text: "热度排行", callback_data: "heat" },
    { text: "关注池", callback_data: "watch" }
  ]);
  return keyboard;
}

function hotMaRowText(row, index) {
  return [
    `<b>${index}. 🔥 ${escapeHtml(row.symbol)}</b> · 热度 #${escapeHtml(row.hotRank ?? "--")} · ${escapeHtml(levelLabel(row.alertLevel))}`,
    `周期：${escapeHtml(row.intervalCode)}｜现价：${escapeHtml(formatNumber(row.currentPrice))}`,
    `MA100：${escapeHtml(formatNumber(row.ma100))}｜MA200：${escapeHtml(formatNumber(row.ma200))}`,
    `说明：${escapeHtml(row.note || "--")}`
  ].join("\n");
}

async function sendHotMa(chatId, page = 1, messageId = null) {
  const pageSize = 5;
  const payload = await getHotMaSignalsPage({ page, pageSize });
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
  const payload = await getHotRank({ chain: "all", limit: 30 });
  const rows = (payload.tokens ?? []).map((token) =>
    `#${escapeHtml(token.rank)} <b>${escapeHtml(token.symbol)}</b> · 综合 ${escapeHtml(token.heat)} · 广场 ${escapeHtml(token.binanceHeat ?? "--")} · 推特 ${escapeHtml(token.twitterHeat ?? "--")} · ${escapeHtml(token.chainLabel)}`
  );
  const firstSymbol = payload.tokens?.[0]?.symbol;
  const keyboard = { inline_keyboard: [[{ text: "热度+均线信号", callback_data: "hotma:1" }, { text: "均线信号", callback_data: "signals" }, { text: "关注池", callback_data: "watch" }]] };
  if (firstSymbol) keyboard.inline_keyboard.unshift(tokenButtons(firstSymbol));
  await sendOrEditMessage({
    chatId,
    messageId,
    text: [`<b>综合热度排行 TOP ${rows.length}</b>`, `来源：${escapeHtml(payload.source)}`, ...rows].join("\n"),
    replyMarkup: keyboard
  });
}

async function sendWatch(chatId, messageId = null) {
  const items = await listWatchlist();
  const rows = items.slice(0, 12).map((item, index) =>
    `${index + 1}. <b>${escapeHtml(item.symbol)}</b> · 现价 ${escapeHtml(item.currentPrice ?? "--")} · 高于 ${escapeHtml(item.alertAbove ?? "--")} · 低于 ${escapeHtml(item.alertBelow ?? "--")}`
  );
  const firstSymbol = items[0]?.symbol;
  const keyboard = { inline_keyboard: [[{ text: "热度+均线信号", callback_data: "hotma:1" }, { text: "均线信号", callback_data: "signals" }, { text: "热度排行", callback_data: "heat" }]] };
  if (firstSymbol) keyboard.inline_keyboard.unshift(tokenButtons(firstSymbol));
  await sendOrEditMessage({
    chatId,
    messageId,
    text: rows.length ? [`<b>关注池</b>`, ...rows].join("\n") : "<b>关注池</b>\n暂无关注代币。",
    replyMarkup: keyboard
  });
}

async function handleMessage(message) {
  const chatId = message?.chat?.id;
  if (!isAllowedChat(chatId)) return;
  const text = String(message.text ?? "").trim();
  if (text.startsWith("/heat")) return sendHeat(chatId);
  if (text.startsWith("/watch")) return sendWatch(chatId);
  if (text.startsWith("/hotma")) return sendHotMa(chatId, 1);
  if (text.startsWith("/multi")) return sendMultiCycleSignals(chatId, 1);
  if (text.startsWith("/signals")) return sendSignals(chatId, "LEVEL1", "15m");
  return telegramApi("sendMessage", {
    chat_id: chatId,
    text: "可用命令：/hotma 查看热度+均线信号，/signals 查看均线信号，/multi 查看多周期共振，/heat 查看热度排行，/watch 查看关注池。",
    reply_markup: signalKeyboard()
  });
}

async function handleCallback(callback) {
  const chatId = callback?.message?.chat?.id;
  if (!isAllowedChat(chatId)) {
    await telegramApi("answerCallbackQuery", {
      callback_query_id: callback.id,
      text: "这个聊天没有授权使用此 bot。"
    });
    return;
  }
  const data = String(callback.data ?? "");
  await telegramApi("answerCallbackQuery", { callback_query_id: callback.id });
  try {
    if (data === "noop") return;
    const messageId = callback?.message?.message_id ?? null;
    if (data === "heat") return sendHeat(chatId, messageId);
    if (data === "watch") return sendWatch(chatId, messageId);
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
    if (update.message) await handleMessage(update.message);
    if (update.callback_query) await handleCallback(update.callback_query);
  }
}

export function startTelegramBot() {
  if (botRunning) return { running: true };
  if (!config.telegram.enabled || !config.telegram.botToken || !config.telegram.chatId) {
    botStatus.running = false;
    botStatus.state = "not_configured";
    botStatus.lastError = "Telegram is not configured";
    return { running: false, reason: "Telegram is not configured" };
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
  const loop = async () => {
    while (botRunning) {
      try {
        await pollOnce();
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
        await new Promise((resolve) => setTimeout(resolve, 5000));
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
    releasePollingLock();
    if (eventName !== "exit") process.exit(0);
  });
}
