import { config } from "./config.js";
import { getHotRank } from "./hotRank.js";
import { getSignalsPage, listWatchlist } from "./db.js";
import { telegramSearchLinks } from "./telegram.js";

let botRunning = false;
let updateOffset = 0;
const botStatus = {
  running: false,
  state: "stopped",
  startedAt: null,
  lastPollAt: null,
  lastUpdateAt: null,
  lastError: null,
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

async function telegramApi(method, payload) {
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
  } finally {
    clearTimeout(timer);
  }
}

function isAllowedChat(chatId) {
  return String(chatId) === String(config.telegram.chatId);
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
        { text: "热度排行", callback_data: "heat" },
        { text: "关注池", callback_data: "watch" }
      ]
    ]
  };
}

function tokenButtons(symbol) {
  const links = telegramSearchLinks(symbol);
  return [
    { text: `${symbol} 推特`, url: links.twitter },
    { text: `${symbol} 广场`, url: links.binanceSquare }
  ];
}

async function sendSignals(chatId, level = "LEVEL1", interval = "15m") {
  const payload = await getSignalsPage({
    categories: "A,B",
    levels: level,
    intervals: interval,
    page: 1,
    pageSize: 10
  });
  const label = level === "LEVEL1" ? "一级警报" : "二级预警";
  const rows = payload.signals.map((row, index) =>
    `${index + 1}. <b>${escapeHtml(row.symbol)}</b> · ${escapeHtml(row.categoryLabel)} · ${escapeHtml(row.signalStatus)} · ${escapeHtml(row.currentPrice)}`
  );
  const firstSymbol = payload.signals[0]?.symbol;
  const keyboard = signalKeyboard();
  if (firstSymbol) keyboard.inline_keyboard.unshift(tokenButtons(firstSymbol));
  await telegramApi("sendMessage", {
    chat_id: chatId,
    text: [`<b>均线信号 · ${escapeHtml(label)} · ${escapeHtml(interval)}</b>`, ...rows].join("\n") || "暂无信号",
    parse_mode: "HTML",
    disable_web_page_preview: true,
    reply_markup: keyboard
  });
}

async function sendHeat(chatId) {
  const payload = await getHotRank({ chain: "all", limit: 10 });
  const rows = (payload.tokens ?? []).slice(0, 10).map((token) =>
    `#${escapeHtml(token.rank)} <b>${escapeHtml(token.symbol)}</b> · 综合 ${escapeHtml(token.heat)} · ${escapeHtml(token.chainLabel)}`
  );
  const firstSymbol = payload.tokens?.[0]?.symbol;
  const keyboard = { inline_keyboard: [[{ text: "均线信号", callback_data: "signals" }, { text: "关注池", callback_data: "watch" }]] };
  if (firstSymbol) keyboard.inline_keyboard.unshift(tokenButtons(firstSymbol));
  await telegramApi("sendMessage", {
    chat_id: chatId,
    text: [`<b>综合热度排行 TOP 10</b>`, `来源：${escapeHtml(payload.source)}`, ...rows].join("\n"),
    parse_mode: "HTML",
    disable_web_page_preview: true,
    reply_markup: keyboard
  });
}

async function sendWatch(chatId) {
  const items = await listWatchlist();
  const rows = items.slice(0, 12).map((item, index) =>
    `${index + 1}. <b>${escapeHtml(item.symbol)}</b> · 现价 ${escapeHtml(item.currentPrice ?? "--")} · 高于 ${escapeHtml(item.alertAbove ?? "--")} · 低于 ${escapeHtml(item.alertBelow ?? "--")}`
  );
  const firstSymbol = items[0]?.symbol;
  const keyboard = { inline_keyboard: [[{ text: "均线信号", callback_data: "signals" }, { text: "热度排行", callback_data: "heat" }]] };
  if (firstSymbol) keyboard.inline_keyboard.unshift(tokenButtons(firstSymbol));
  await telegramApi("sendMessage", {
    chat_id: chatId,
    text: rows.length ? [`<b>关注池</b>`, ...rows].join("\n") : "<b>关注池</b>\n暂无关注代币。",
    parse_mode: "HTML",
    disable_web_page_preview: true,
    reply_markup: keyboard
  });
}

async function handleMessage(message) {
  const chatId = message?.chat?.id;
  if (!isAllowedChat(chatId)) return;
  const text = String(message.text ?? "").trim();
  if (text.startsWith("/heat")) return sendHeat(chatId);
  if (text.startsWith("/watch")) return sendWatch(chatId);
  if (text.startsWith("/signals")) return sendSignals(chatId, "LEVEL1", "15m");
  return telegramApi("sendMessage", {
    chat_id: chatId,
    text: "可用命令：/signals 查看均线信号，/heat 查看热度排行，/watch 查看关注池。",
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
    if (data === "heat") return sendHeat(chatId);
    if (data === "watch") return sendWatch(chatId);
    if (data === "signals") return sendSignals(chatId, "LEVEL1", "15m");
    if (data.startsWith("sig:")) {
      const [, level, interval] = data.split(":");
      return sendSignals(chatId, level, interval);
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
  };
  loop();
  return { running: true };
}
