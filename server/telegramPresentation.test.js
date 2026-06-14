import assert from "node:assert/strict";
import test from "node:test";
import {
  formatHotMaSignalTelegram,
  telegramTokenCopyButton,
  telegramTokenLine
} from "./telegram.js";
import { oiFilterKeyboard, signalKeyboard, signalRowText } from "./telegramBot.js";

test("Telegram token line keeps Twitter and Binance Square inside the card body", () => {
  const line = telegramTokenLine("ZESTUSDT");

  assert.match(line, /<b>ZESTUSDT<\/b>/);
  assert.match(line, /<a href="[^"]+">推特<\/a>/);
  assert.match(line, /<a href="[^"]+">币安广场<\/a>/);
});

test("Telegram token action button is copy-only", () => {
  const button = telegramTokenCopyButton("ZESTUSDT");

  assert.deepEqual(button, {
    text: "复制 ZESTUSDT",
    copy_text: { text: "ZESTUSDT" }
  });
  assert.equal("url" in button, false);
  assert.equal("callback_data" in button, false);
});

test("multi-cycle Telegram alert is rendered as one aggregated message", () => {
  const text = formatHotMaSignalTelegram(
    { symbol: "EVAAUSDT", category_label: "Alpha 合约无现货" },
    {
      intervalCode: "15m",
      alertLevel: "LEVEL1",
      currentPrice: 0.3862,
      ma100: 0.397114,
      ma200: 0.36552,
      signalStatus: "一级警报",
      note: "15m 周期强观察信号。"
    },
    {
      multiCycleCount: 3,
      multiCycleIntervals: ["15m", "1h", "4h"],
      alertLevel: "LEVEL1"
    }
  );

  assert.match(text, /触发周期：<b>15m \/ 1h \/ 4h<\/b>（共 3 个）/);
  assert.doesNotMatch(text, /^周期：/m);
  assert.doesNotMatch(text, /^周期状态：/m);
  assert.doesNotMatch(text, /^MA100：/m);
});

test("Telegram signal menu shows OI spike changes as a matched combination", () => {
  const text = signalRowText(
    {
      symbol: "COLLECTUSDT",
      categoryLabel: "Alpha合约无现货",
      intervals: ["15m", "1h", "4h"],
      intervalCode: "15m",
      multiMatchCount: 3,
      multiMatchRequired: 3,
      bestAlertLevel: "LEVEL1",
      oiMatched: true,
      oiSpikeHit: true,
      oiChange5mPct: 5.25,
      oiChange1hPct: 11.5,
      hotRankHit: 1,
      currentPrice: 0.05,
      ma100: 0.051,
      ma200: 0.052,
      signalStatus: "一级警报",
      note: "测试"
    },
    1
  );

  assert.match(text, /组合等级：OI \+ 热度 \+ 多周期 · 一级警报/);
  assert.match(text, /OI暴涨：5m 5.25%｜1h 11.50%/);
});

test("Telegram navigation marks the active menu", () => {
  const keyboard = signalKeyboard("oi");
  const oiButton = keyboard.inline_keyboard.flat().find((button) => button.callback_data === "oi:5m:desc");

  assert.equal(oiButton.text, "【OI监控】");
});

test("Telegram OI controls mark the selected window and sort order", () => {
  const keyboard = oiFilterKeyboard({ timeWindow: "1h", sort: "asc" });

  assert.equal(keyboard.inline_keyboard[0][2].text, "✓ 1h");
  assert.equal(keyboard.inline_keyboard[1][1].text, "✓ 从低到高");
});
