import assert from "node:assert/strict";
import test from "node:test";
import { config } from "./config.js";
import {
  formatOpenInterestSpikeTelegram,
  formatHotMaSignalTelegram,
  formatStandaloneOpenInterestSpikeTelegram,
  telegramApi,
  telegramTokenCopyButton,
  telegramTokenLine
} from "./telegram.js";
import {
  getTelegramBotState,
  heatRankKeyboard,
  oiFilterKeyboard,
  signalKeyboard,
  signalRowText,
  splitTelegramText,
  startTelegramBot
} from "./telegramBot.js";

test("Telegram token line keeps Twitter and Binance Square inside the card body", () => {
  const line = telegramTokenLine("ZESTUSDT");

  assert.match(line, /<b>ZESTUSDT<\/b>/);
  assert.match(line, /<a href="[^"]+">推特<\/a>/);
  assert.match(line, /<a href="[^"]+">币安广场<\/a>/);
  assert.match(line, /&amp;src=typed_query&amp;f=live/);
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
    { symbol: "EVAAUSDT", category_label: "Alpha 合约无现货", priceChange24hPct: 12.34 },
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
  assert.match(text, /分类：<b>Alpha 合约无现货<\/b>/);
  assert.match(text, /24h涨跌幅：<b>\+12\.34%<\/b>/);
  assert.doesNotMatch(text, /^周期：/m);
  assert.doesNotMatch(text, /^周期状态：/m);
  assert.doesNotMatch(text, /^MA100：/m);
  assert.doesNotMatch(text, /不构成投资建议/);
});

test("Telegram alerts name the OI spike hit periods", () => {
  const text = formatHotMaSignalTelegram(
    { symbol: "OIUSDT", category_label: "Alpha 合约无现货" },
    {
      intervalCode: "15m",
      alertLevel: "LEVEL2",
      currentPrice: 0.12,
      ma100: 0.11,
      ma200: 0.10,
      signalStatus: "二级警报",
      note: "测试"
    },
    {
      oiSpike: true,
      oiChange5mPct: 2.45,
      oiChange1hPct: 9.5,
      oiChange4hPct: 21,
      oiSpike5mHit: true,
      oiSpike1hHit: false,
      oiSpike4hHit: true,
      oiSpike1dHit: false
    }
  );

  assert.match(text, /<b>OI命中周期：<\/b>\n  • <b>5分钟 2\.45%<\/b>\n  • <b>4小时 21\.00%<\/b>/);
  assert.doesNotMatch(text, /^OI：/m);
});

test("OI spike Telegram text names threshold-hit periods", () => {
  const item = {
    symbol: "PERPUSDT",
    categoryLabel: "现货+合约",
    priceChange24hPct: -7.89,
    change5mPct: 1.5,
    change15mPct: 3.2,
    change1hPct: 12.5,
    change4hPct: 18,
    change1dPct: 41,
    currentOpenInterest: 12345,
    currentOpenInterestValue: 67890
  };
  const comboText = formatOpenInterestSpikeTelegram(item, {
    intervals: ["15m"],
    alertLevel: "LEVEL2",
    multiCycleCount: 1
  });
  const standaloneText = formatStandaloneOpenInterestSpikeTelegram(item);

  assert.match(comboText, /<b>OI命中周期：<\/b>\n  • <b>1小时 12\.50%<\/b>\n  • <b>1天 41\.00%<\/b>/);
  assert.match(comboText, /分类：<b>现货\+合约<\/b>/);
  assert.match(comboText, /24h涨跌幅：<b>-7\.89%<\/b>/);
  assert.match(standaloneText, /<b>OI命中周期：<\/b>\n  • <b>1小时 12\.50%<\/b>\n  • <b>1天 41\.00%<\/b>/);
  assert.match(standaloneText, /分类：<b>现货\+合约<\/b>/);
  assert.match(standaloneText, /24h涨跌幅：<b>-7\.89%<\/b>/);
  assert.doesNotMatch(standaloneText, /触发区间/);
});

test("Telegram signal menu shows OI spike changes as a matched combination", () => {
  const text = signalRowText(
    {
      symbol: "COLLECTUSDT",
      categoryLabel: "Alpha合约无现货",
      priceChange24hPct: -1.23,
      intervals: ["15m", "1h", "4h"],
      intervalCode: "15m",
      multiMatchCount: 3,
      multiMatchRequired: 3,
      bestAlertLevel: "LEVEL1",
      oiMatched: true,
      oiSpikeHit: true,
      oiChange5mPct: 5.25,
      oiChange1hPct: 11.5,
      oiChange4hPct: 23.2,
      oiSpike5mHit: true,
      oiSpike1hHit: true,
      oiSpike4hHit: true,
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
  assert.match(text, /分类：Alpha合约无现货｜24h：-1\.23%｜周期：15m \/ 1h \/ 4h/);
  assert.match(text, /OI暴涨：5m 5.25%｜1h 11.50%｜4h 23.20%/);
});

test("Telegram navigation marks the active menu", () => {
  const keyboard = signalKeyboard("oi");
  const oiButton = keyboard.inline_keyboard.flat().find((button) => button.callback_data === "oi:5m:desc");

  assert.equal(oiButton.text, "【OI监控】");
});

test("disabled Telegram bot does not report a runtime error", () => {
  const originalTelegramConfig = { ...config.telegram };
  try {
    config.telegram.enabled = false;
    config.telegram.botToken = "";
    config.telegram.chatId = "";

    const result = startTelegramBot();
    const state = getTelegramBotState();

    assert.equal(result.running, false);
    assert.equal(state.state, "disabled");
    assert.equal(state.lastError, null);
  } finally {
    Object.assign(config.telegram, originalTelegramConfig);
  }
});

test("Telegram OI controls mark the selected window and sort order", () => {
  const keyboard = oiFilterKeyboard({ timeWindow: "1h", sort: "asc" });

  assert.equal(keyboard.inline_keyboard[0][2].text, "✓ 1h");
  assert.equal(keyboard.inline_keyboard[1][1].text, "✓ 从低到高");
});

test("Telegram OI controls fall back to safe defaults for invalid callback data", () => {
  const keyboard = oiFilterKeyboard({ timeWindow: "bad", sort: "sideways" });

  assert.equal(keyboard.inline_keyboard[0][0].text, "✓ 5m");
  assert.equal(keyboard.inline_keyboard[1][0].text, "✓ 从高到低");
  assert.equal(keyboard.inline_keyboard[0][1].callback_data, "oi:15m:desc");
});

test("Telegram heat rank controls use paginated callbacks", () => {
  const keyboard = heatRankKeyboard({ page: 2, total: 30, pageSize: 8, symbols: ["AAAUSDT", "BBBUSDT"] });

  assert.deepEqual(
    keyboard.inline_keyboard[0],
    [
      { text: "‹ 上一页", callback_data: "heat:1" },
      { text: "2/4", callback_data: "noop" },
      { text: "下一页 ›", callback_data: "heat:3" }
    ]
  );
  assert.equal(keyboard.inline_keyboard.flat().find((button) => button.callback_data === "heat").text, "【热度排行】");
});

test("Telegram text splitter prefers line boundaries", () => {
  assert.deepEqual(
    splitTelegramText("line-one\nline-two\nline-three", 17),
    ["line-one\nline-two", "line-three"]
  );
});

test("Telegram API rejects malformed success responses", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    json: async () => ({ result: 123 })
  });

  await assert.rejects(
    telegramApi("sendMessage", { chat_id: "1", text: "hello", timeout: "bad" }),
    /response was not ok/
  );
});
