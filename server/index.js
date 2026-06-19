import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Readable } from "node:stream";
import { config } from "./config.js";
import {
  clearTriggerHistory,
  countActiveTokens,
  deleteTriggerHistory,
  deleteWatchlistItem,
  ensureDatabase,
  findKlineGap,
  getKlines,
  getHotMaSignalsPage,
  getSignalGroupsPage,
  listMultiCycleHistory,
  getOverview,
  getSignals,
  getSignalsPage,
  getKlineAuditReport,
  klineStats,
  listOneHourFundingIntervals,
  listOpenInterestMonitorPage,
  listTriggerHistory,
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
import { fetchKlinesPaged, fetchRecentKlines } from "./binance.js";
import { getHotRank } from "./hotRank.js";
import { telegramState } from "./telegram.js";
import { requestService, serviceStates, serviceUrl } from "./serviceClient.js";
import { getTokenUnlockCache } from "./db.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const app = express();

app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.resolve(__dirname, "../public")));
app.get("/tokens.css", (_request, response) => {
  response.sendFile(path.resolve(__dirname, "../tokens.css"));
});

app.get("/api/health", async (_request, response) => {
  try {
    await pingDatabase();
    const services = await serviceStates();
    response.json({
      ok: true,
      database: "connected",
      services,
      crawler: services.crawler?.crawler ?? null,
      maintenance: services.scheduler?.maintenance ?? null,
      watchRealtime: services.realtime?.watchRealtime ?? null,
      fundingMonitor: services.scheduler?.fundingMonitor ?? null,
      openInterestMonitor: services.scheduler?.openInterestMonitor ?? null,
      telegram: { ...telegramState(), bot: services.scheduler?.telegramBot ?? null },
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
  try {
    response.json(await requestService("crawler", "/internal/bootstrap", { method: "POST", body: "{}" }));
  } catch (error) {
    response.status(503).json({ ok: false, error: error instanceof Error ? error.message : String(error) });
  }
});

app.post("/api/crawl/start", async (_request, response) => {
  response.json(await requestService("crawler", "/internal/crawl/start", { method: "POST", body: "{}" }));
});

app.post("/api/crawl/stop", async (_request, response) => {
  response.json(await requestService("crawler", "/internal/crawl/stop", { method: "POST", body: "{}" }));
});

app.post("/api/kline-audit", async (_request, response) => {
  response.json(await requestService("crawler", "/internal/kline/audit", {
    method: "POST",
    body: "{}",
    timeoutMs: 60_000
  }));
});

app.get("/api/kline-health", async (_request, response) => {
  try {
    response.json({ ok: true, ...(await getKlineAuditReport(config.crawler.retentionLimits)) });
  } catch (error) {
    console.error("get kline health failed", error);
    response.status(500).json({ ok: false, error: error instanceof Error ? error.message : String(error) });
  }
});

app.get("/api/overview", async (_request, response) => {
  const services = await serviceStates();
  response.json({
    ok: true,
    overview: await getOverview(),
    crawler: services.crawler?.crawler ?? null,
    watchRealtime: services.realtime?.watchRealtime ?? null,
    fundingMonitor: services.scheduler?.fundingMonitor ?? null,
    openInterestMonitor: services.scheduler?.openInterestMonitor ?? null,
    tokenUnlock: services.scheduler?.tokenUnlock ?? null,
    telegram: { ...telegramState(), bot: services.scheduler?.telegramBot ?? null },
    database: "connected"
  });
});

app.get("/api/signals", async (request, response) => {
  if (request.query.categories || request.query.levels || request.query.intervals || request.query.page || request.query.pageSize) {
    const result = await getSignalGroupsPage({
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

app.get("/api/hot-ma-signals", async (request, response) => {
  const result = await getHotMaSignalsPage({
    categories: request.query.categories ?? "A,B",
    levels: request.query.levels ?? "LEVEL1,LEVEL2",
    intervals: request.query.intervals ?? "15m,1h,4h,1d",
    page: request.query.page,
    pageSize: request.query.pageSize
  });
  response.json({ ok: true, ...result });
});

app.get("/api/multi-history", async (request, response) => {
  response.json({ ok: true, items: await listMultiCycleHistory({ limit: request.query.limit }) });
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
    response.json(payload);
  } catch (error) {
    response.status(502).json({
      ok: false,
      error: error instanceof Error ? error.message : String(error)
    });
  }
});

app.post("/api/funding-interval/check", async (_request, response) => {
  try {
    response.json(await requestService("scheduler", "/internal/funding/check", { method: "POST", body: "{}" }));
  } catch (error) {
    response.status(502).json({
      ok: false,
      error: error instanceof Error ? error.message : String(error)
    });
  }
});

app.post("/api/open-interest/check", async (_request, response) => {
  try {
    response.json(await requestService("scheduler", "/internal/open-interest/check", { method: "POST", body: "{}" }));
  } catch (error) {
    response.status(502).json({
      ok: false,
      error: error instanceof Error ? error.message : String(error)
    });
  }
});

app.get("/api/watchlist", async (_request, response) => {
  response.json({ ok: true, items: await listWatchlist() });
});

app.get("/api/watchlist/events", async (request, response) => {
  let upstream;
  try {
    upstream = await fetch(serviceUrl("realtime", "/internal/events"), {
      headers: config.service.internalToken ? { "X-Internal-Service-Token": config.service.internalToken } : {}
    });
  } catch (error) {
    console.error("watchlist events upstream failed", error);
    response.status(503).json({ ok: false, error: error instanceof Error ? error.message : String(error) });
    return;
  }
  if (!upstream.ok || !upstream.body) {
    response.status(503).json({ ok: false, error: `realtime service HTTP ${upstream.status}` });
    return;
  }
  response.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no"
  });
  const stream = Readable.fromWeb(upstream.body);
  stream.on("error", (error) => {
    console.error("watchlist events stream failed", error);
    if (!response.destroyed) response.end();
  });
  stream.pipe(response);
  request.on("close", () => stream.destroy());
});

app.post("/api/watchlist", async (request, response) => {
  try {
    const items = await upsertWatchlistItem(request.body ?? {});
    const symbol = sanitizeSymbol(request.body?.symbol);
    const baseAsset = symbol.replace(/USDT$/, "");
    void requestService("crawler", "/internal/watchlist/refresh", {
      method: "POST",
      body: JSON.stringify({ full: true }),
      timeoutMs: 60_000
    }).catch((error) => console.error("watchlist post-refresh failed", error));
    void requestService("realtime", "/internal/refresh", { method: "POST", body: "{}" })
      .catch((error) => console.error("watchlist realtime refresh failed", error));
    void requestService("scheduler", "/internal/unlock/check", {
      method: "POST",
      body: JSON.stringify({ symbol, baseAsset }),
      timeoutMs: 60_000
    })
      .catch((error) => console.error("watchlist unlock refresh failed", error));
    response.json({ ok: true, items });
  } catch (error) {
    response.status(400).json({ ok: false, error: error instanceof Error ? error.message : String(error) });
  }
});

app.delete("/api/watchlist/:symbol", async (request, response) => {
  const deleted = await deleteWatchlistItem(request.params.symbol);
  void requestService("realtime", "/internal/refresh", { method: "POST", body: "{}" })
    .catch((error) => console.error("watchlist realtime refresh failed", error));
  response.json({ ok: true, deleted });
});

app.get("/api/watchlist/:symbol/unlock", async (request, response) => {
  response.json({ ok: true, item: await getTokenUnlockCache(request.params.symbol) });
});

app.post("/api/watchlist/unlock/refresh", async (_request, response) => {
  response.json(await requestService("scheduler", "/internal/unlock/check", {
    method: "POST",
    body: "{}",
    timeoutMs: 60_000
  }));
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

app.get("/api/trigger-history", async (request, response) => {
  try {
    response.json({
      ok: true,
      ...(await listTriggerHistory({
        page: request.query.page,
        pageSize: request.query.pageSize,
        triggerTypes: request.query.triggerTypes
      }))
    });
  } catch (error) {
    console.error("get trigger history failed", error);
    response.status(500).json({ ok: false, error: error instanceof Error ? error.message : String(error) });
  }
});

app.delete("/api/trigger-history/:id", async (request, response) => {
  try {
    const deleted = await deleteTriggerHistory(request.params.id);
    response.json({ ok: true, deleted });
  } catch (error) {
    console.error("delete trigger history failed", error);
    response.status(500).json({ ok: false, error: error instanceof Error ? error.message : String(error) });
  }
});

app.delete("/api/trigger-history", async (request, response) => {
  try {
    const ids = Array.isArray(request.body?.ids) ? request.body.ids : [];
    const deleted = ids.length ? await deleteTriggerHistory(ids) : await clearTriggerHistory();
    response.json({ ok: true, deleted });
  } catch (error) {
    console.error("clear trigger history failed", error);
    response.status(500).json({ ok: false, error: error instanceof Error ? error.message : String(error) });
  }
});

app.get("/api/funding-rate-tokens", async (_request, response) => {
  try {
    const tokens = await listOneHourFundingIntervals();
    response.json({ ok: true, tokens, total: tokens.length });
  } catch (error) {
    console.error("get funding rate tokens failed", error);
    response.status(500).json({ ok: false, error: error instanceof Error ? error.message : String(error) });
  }
});

async function handleOpenInterestMonitoring(request, response) {
  try {
    const timeWindow = ["5m", "15m", "1h", "4h", "1d"].includes(request.query.timeWindow)
      ? request.query.timeWindow
      : "5m";
    const sort = request.query.sort === "asc" ? "asc" : "desc";
    const scheduler = await requestService("scheduler", "/internal/health").catch(() => null);
    response.json({
      ok: true,
      ...(await listOpenInterestMonitorPage({
        timeWindow,
        sort,
        page: request.query.page,
        pageSize: request.query.pageSize
      })),
      timeWindow,
      sort,
      monitor: scheduler?.openInterestMonitor ?? null
    });
  } catch (error) {
    console.error("get oi monitoring failed", error);
    response.status(500).json({ ok: false, error: error instanceof Error ? error.message : String(error) });
  }
}

app.get("/api/oi-monitoring", handleOpenInterestMonitoring);
app.get("/api/io-monitoring", handleOpenInterestMonitoring);

app.use((_request, response) => {
  response.sendFile(path.resolve(__dirname, "../public/index.html"));
});

await ensureDatabase();
app.listen(config.service.apiPort, config.service.apiHost, () => {
  console.log(`API service running at http://${config.service.apiHost}:${config.service.apiPort}`);
});
