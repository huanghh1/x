import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "./config.js";
import {
  countActiveTokens,
  deleteWatchlistItem,
  ensureDatabase,
  getKlines,
  getOverview,
  getSignals,
  getSignalsPage,
  listWatchlistTokens,
  listWatchlist,
  markHotRankNotified,
  markWatchlistAlertSent,
  pingDatabase,
  recordHotRankSnapshot,
  refreshTokenFetchState,
  selectClosePrices,
  upsertKlinePage,
  upsertSignal,
  upsertWatchlistItem
} from "./db.js";
import { fetchRecentKlines } from "./binance.js";
import { getCrawlerState, initializeTokenUniverse, startCrawler, stopCrawler } from "./crawler.js";
import { getHotRank } from "./hotRank.js";
import { calculateSignal, INTERVALS } from "./ma.js";
import { getMaintenanceRuntimeState, startMaintenanceScheduler } from "./maintenance.js";
import { sendHotRankTelegram, sendWatchlistTelegram, telegramState } from "./telegram.js";
import { getTelegramBotState, startTelegramBot } from "./telegramBot.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const app = express();

app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.resolve(__dirname, "../public")));

app.get("/api/health", async (_request, response) => {
  try {
    await pingDatabase();
    response.json({
      ok: true,
      database: "connected",
      crawler: getCrawlerState(),
      maintenance: getMaintenanceRuntimeState(),
      telegram: { ...telegramState(), bot: getTelegramBotState() },
      now: new Date().toISOString()
    });
  } catch (error) {
    response.status(500).json({
      ok: false,
      database: "disconnected",
      error: error instanceof Error ? error.message : String(error)
    });
  }
});

app.post("/api/bootstrap", async (_request, response) => {
  let universe;
  try {
    universe = await initializeTokenUniverse();
  } catch (error) {
    universe = {
      count: await countActiveTokens(),
      warning: error instanceof Error ? error.message : String(error)
    };
  }
  const crawler = await startCrawler();
  response.json({ ok: true, universe: { count: universe.count, warning: universe.warning ?? null }, crawler });
});

app.post("/api/crawl/start", async (_request, response) => {
  response.json({ ok: true, crawler: await startCrawler() });
});

app.post("/api/crawl/stop", (_request, response) => {
  response.json({ ok: true, crawler: stopCrawler() });
});

app.get("/api/overview", async (_request, response) => {
  response.json({
    ok: true,
    overview: await getOverview(),
    crawler: getCrawlerState(),
    telegram: { ...telegramState(), bot: getTelegramBotState() },
    database: "connected"
  });
});

app.get("/api/signals", async (request, response) => {
  if (request.query.categories || request.query.levels || request.query.intervals || request.query.page || request.query.pageSize) {
    const result = await getSignalsPage({
      categories: request.query.categories,
      levels: request.query.levels,
      intervals: request.query.intervals,
      page: request.query.page,
      pageSize: request.query.pageSize
    });
    response.json({ ok: true, ...result });
    return;
  }

  const category = request.query.category === "B" ? "B" : "A";
  response.json({ ok: true, category, signals: await getSignals(category) });
});

app.get("/api/klines", async (request, response) => {
  const symbol = String(request.query.symbol ?? "").toUpperCase().replace(/[^A-Z0-9_]/g, "");
  const interval = ["15m", "1h", "4h", "1d"].includes(request.query.interval) ? request.query.interval : "1h";
  const limit = request.query.limit === "all" ? "all" : Math.max(50, Math.min(1000, Number(request.query.limit) || 240));
  if (!symbol) {
    response.status(400).json({ ok: false, error: "symbol is required" });
    return;
  }
  response.json({
    ok: true,
    ...(await getKlines({ symbol, intervalCode: interval, limit })),
    tradingViewSymbol: `BINANCE:${symbol}.P`
  });
});

app.get("/api/hot-rank", async (request, response) => {
  try {
    const payload = await getHotRank({
      chain: String(request.query.chain ?? "all"),
      limit: request.query.limit,
      targetLanguage: String(request.query.targetLanguage ?? "zh"),
      socialLanguage: String(request.query.socialLanguage ?? "ALL"),
      timeRange: request.query.timeRange
    });
    const freshTokens = await recordHotRankSnapshot(payload.tokens ?? []);
    if (freshTokens.length > 0) {
      try {
        const result = await sendHotRankTelegram(freshTokens);
        if (!result.skipped) await markHotRankNotified(freshTokens.map((token) => token.symbol));
      } catch (error) {
        console.error("hot rank telegram alert failed", error);
      }
    }
    response.json({ ...payload, newTokens: freshTokens.length });
  } catch (error) {
    response.status(502).json({
      ok: false,
      error: error instanceof Error ? error.message : String(error)
    });
  }
});

app.get("/api/watchlist", async (_request, response) => {
  await refreshWatchlistMarketData();
  response.json({ ok: true, items: await listWatchlist() });
});

app.post("/api/watchlist", async (request, response) => {
  try {
    const items = await upsertWatchlistItem(request.body ?? {});
    response.json({ ok: true, items });
  } catch (error) {
    response.status(400).json({ ok: false, error: error instanceof Error ? error.message : String(error) });
  }
});

app.delete("/api/watchlist/:symbol", async (request, response) => {
  response.json({ ok: true, deleted: await deleteWatchlistItem(request.params.symbol) });
});

function sanitizeSymbol(value) {
  return String(value ?? "").toUpperCase().replace(/[^A-Z0-9_]/g, "");
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function appOpenPage({ title, symbol, primaryDeepLink, secondaryDeepLinks = [], fallbackUrl, note }) {
  const deepLinks = [primaryDeepLink, ...secondaryDeepLinks].filter(Boolean);
  const encodedLinks = JSON.stringify(deepLinks);
  return `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>${escapeHtml(title)}</title>
    <style>
      body {
        margin: 0;
        min-height: 100vh;
        display: grid;
        place-items: center;
        font-family: Arial, "PingFang SC", "Microsoft YaHei", sans-serif;
        color: #211721;
        background: #fff8fb;
      }
      main {
        width: min(92vw, 460px);
        padding: 28px;
        border: 1px solid #eee8ec;
        border-radius: 18px;
        background: #fff;
        box-shadow: 0 18px 45px rgba(69, 39, 55, 0.12);
      }
      h1 { margin: 0 0 10px; font-size: 24px; }
      p { color: #6d606b; line-height: 1.7; }
      a, button {
        display: flex;
        align-items: center;
        justify-content: center;
        width: 100%;
        min-height: 44px;
        margin-top: 12px;
        border: 0;
        border-radius: 999px;
        color: #fff;
        background: #ed2a75;
        font: inherit;
        font-weight: 800;
        text-decoration: none;
      }
      button { cursor: pointer; }
      small { display: block; margin-top: 14px; color: #9b8f98; line-height: 1.6; }
    </style>
  </head>
  <body>
    <main>
      <h1>${escapeHtml(title)}</h1>
      <p>正在尝试打开 App：<strong>${escapeHtml(symbol)}</strong></p>
      <button id="openApp" type="button">再次尝试打开 App</button>
      <a href="${escapeHtml(fallbackUrl)}">打不开 App 时打开网页</a>
      <small>${escapeHtml(note)}</small>
    </main>
    <script>
      const deepLinks = ${encodedLinks};
      const fallbackUrl = ${JSON.stringify(fallbackUrl)};
      function openApp() {
        deepLinks.forEach((url, index) => {
          setTimeout(() => {
            window.location.href = url;
          }, index * 450);
        });
        setTimeout(() => {
          if (!document.hidden) window.location.href = fallbackUrl;
        }, 2600);
      }
      document.getElementById("openApp").addEventListener("click", openApp);
      openApp();
    </script>
  </body>
</html>`;
}

app.get("/open/binance", (request, response) => {
  const symbol = sanitizeSymbol(request.query.symbol);
  if (!symbol) {
    response.status(400).send("symbol is required");
    return;
  }
  const fallbackUrl = `https://www.binance.com/en/futures/${encodeURIComponent(symbol)}`;
  response.type("html").send(
    appOpenPage({
      title: "打开 Binance App",
      symbol,
      primaryDeepLink: `bnc://app.binance.com/futures/${encodeURIComponent(symbol)}`,
      secondaryDeepLinks: [
        `bnc://app.binance.com/en/futures/${encodeURIComponent(symbol)}`,
        "bnc://app.binance.com/markets/markets",
        "bnc://app.binance.com"
      ],
      fallbackUrl,
      note: "如果 Binance App 没有接管深链，会自动回落到网页合约页。"
    })
  );
});

app.get("/open/tradingview", (request, response) => {
  const symbol = sanitizeSymbol(request.query.symbol);
  if (!symbol) {
    response.status(400).send("symbol is required");
    return;
  }
  const tvSymbol = `BINANCE:${symbol}.P`;
  const fallbackUrl = `https://www.tradingview.com/chart/?symbol=${encodeURIComponent(tvSymbol)}`;
  response.type("html").send(
    appOpenPage({
      title: "打开 TradingView App",
      symbol: tvSymbol,
      primaryDeepLink: `tradingview://chart/?symbol=${encodeURIComponent(tvSymbol)}`,
      secondaryDeepLinks: [`tradingview://symbols/${encodeURIComponent(tvSymbol.replace(":", "-"))}/`, "tradingview://"],
      fallbackUrl,
      note: "如果 TradingView App 没有接管深链，会自动回落到网页图表页。"
    })
  );
});

app.use((_request, response) => {
  response.sendFile(path.resolve(__dirname, "../public/index.html"));
});

await ensureDatabase();
await startMaintenanceScheduler();
startTelegramBot();

let watchlistRefreshing = false;
async function refreshWatchlistMarketData() {
  if (watchlistRefreshing) return;
  watchlistRefreshing = true;
  try {
    const tokens = await listWatchlistTokens();
    for (const token of tokens) {
      for (const intervalCode of INTERVALS) {
        const klines = await fetchRecentKlines({ symbol: token.symbol, intervalCode, limit: 3 });
        if (klines.length > 0) await upsertKlinePage(token, intervalCode, klines);
      }
      await refreshTokenFetchState(token.id);
      for (const intervalCode of INTERVALS) {
        const closes = await selectClosePrices(token.symbol, intervalCode);
        await upsertSignal(token, calculateSignal({ intervalCode, closes }));
      }
    }
  } catch (error) {
    console.error("watchlist market refresh failed", error);
  } finally {
    watchlistRefreshing = false;
  }
}

let watchlistChecking = false;
async function checkWatchlistAlerts() {
  if (watchlistChecking) return;
  watchlistChecking = true;
  try {
    await refreshWatchlistMarketData();
    const items = await listWatchlist();
    const cooldownMs = 30 * 60 * 1000;
    for (const item of items) {
      if (!item.alertEnabled || item.currentPrice === null || item.currentPrice === undefined) continue;
      const lastAlertAt = item.lastAlertAt ? new Date(item.lastAlertAt).getTime() : 0;
      if (Date.now() - lastAlertAt < cooldownMs) continue;
      const aboveHit = item.alertAbove !== null && item.currentPrice >= item.alertAbove;
      const belowHit = item.alertBelow !== null && item.currentPrice <= item.alertBelow;
      if (!aboveHit && !belowHit) continue;
      const reason = aboveHit
        ? `现价 ${item.currentPrice} 高于提醒价 ${item.alertAbove}`
        : `现价 ${item.currentPrice} 低于提醒价 ${item.alertBelow}`;
      const result = await sendWatchlistTelegram(item, reason);
      if (!result.skipped) await markWatchlistAlertSent(item.symbol);
    }
  } catch (error) {
    console.error("watchlist alert check failed", error);
  } finally {
    watchlistChecking = false;
  }
}

setInterval(() => {
  checkWatchlistAlerts();
}, 15 * 1000);

setInterval(() => {
  initializeTokenUniverse().catch((error) => {
    console.error("Token universe sync failed:", error);
  });
}, config.crawler.tokenUniverseSyncMs);

setInterval(() => {
  startCrawler().catch((error) => {
    console.error("Incremental crawler start failed:", error);
  });
}, config.crawler.incrementalRefreshMs);

app.listen(config.port, () => {
  console.log(`Binance MA monitor running at http://localhost:${config.port}`);
  if (config.crawler.autoStart) {
    startCrawler().catch((error) => {
      console.error("Auto crawler start failed:", error);
    });
  }
});
