import { telegramApi } from "../telegram.js";

export function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

export function formatNumber(value) {
  if (value === null || value === undefined || value === "") return "--";
  const number = Number(value);
  if (!Number.isFinite(number)) return "--";
  return number.toLocaleString("en-US", { maximumFractionDigits: 12 });
}

export function levelLabel(level) {
  if (level === "LEVEL1") return "一级警报";
  if (level === "LEVEL2") return "二级预警";
  if (level === "NONE") return "观察";
  return "样本不足";
}

export function formatOiChange(value) {
  const numeric = Number(value);
  return value === null || value === undefined || !Number.isFinite(numeric) ? "--" : `${numeric.toFixed(2)}%`;
}

export function oiChangeSummary(row) {
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

export function clampPage(page, total, pageSize) {
  const totalPages = Math.max(1, Math.ceil(Number(total || 0) / Number(pageSize || 1)));
  return Math.min(Math.max(1, Number(page) || 1), totalPages);
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

export async function sendOrEditMessage({ chatId, messageId = null, text, replyMarkup }) {
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
