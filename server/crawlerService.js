import express from "express";
import { config } from "./config.js";
import {
  getCrawlerState,
  initializeTokenUniverse,
  refreshLatestKlineTails,
  refreshKlineCacheForSymbol,
  runDailyKlineAudit,
  setDailyAuditNextRunAt,
  startCrawler,
  stopCrawler
} from "./crawler.js";
import { nextDailyRunAt } from "./dailySchedule.js";
import { ensureDatabase } from "./db.js";
import {
  getPriceChangeKlineRefreshState,
  runPriceChangeKlineRefresh,
  startPriceChangeKlineScheduler
} from "./priceChangeKlineService.js";
import { requireInternalService } from "./serviceClient.js";
import { getWatchlistMarketState, refreshWatchlistMarketData } from "./watchlistMarket.js";

const app = express();
app.use(express.json({ limit: "256kb" }));
app.use("/internal", requireInternalService);

app.get("/internal/health", (_request, response) => {
  response.json({
    ok: true,
    role: "crawler",
    crawler: getCrawlerState(),
    watchlistMarket: getWatchlistMarketState(),
    priceChangeKline: getPriceChangeKlineRefreshState()
  });
});

app.post("/internal/bootstrap", async (_request, response) => {
  const universe = await initializeTokenUniverse();
  response.json({
    ok: true,
    universe: { count: universe.count },
    crawler: await startCrawler({ mode: "manual", reason: "手动初始化", includeIncremental: true })
  });
});

app.post("/internal/crawl/start", async (_request, response) => {
  response.json({
    ok: true,
    crawler: await startCrawler({ mode: "manual", reason: "手动启动", includeIncremental: true })
  });
});

app.post("/internal/crawl/stop", (_request, response) => {
  response.json({ ok: true, crawler: stopCrawler() });
});

app.post("/internal/watchlist/refresh", async (request, response) => {
  response.json(await refreshWatchlistMarketData({ force: true, full: request.body?.full !== false }));
});

app.post("/internal/kline/audit", async (_request, response) => {
  response.json(await runDailyKlineAudit({ syncUniverse: true }));
});

app.post("/internal/kline/tails", async (_request, response) => {
  response.json(await refreshLatestKlineTails({ force: true }));
});

app.post("/internal/price-change-1m/refresh", async (_request, response) => {
  response.json(await runPriceChangeKlineRefresh({ force: true }));
});

app.post("/internal/kline/refresh", async (request, response) => {
  const symbol = String(request.body?.symbol ?? "").toUpperCase().replace(/[^A-Z0-9_]/g, "");
  const intervalCode = ["15m", "1h", "4h", "1d"].includes(request.body?.intervalCode)
    ? request.body.intervalCode
    : null;
  if (!symbol || !intervalCode) {
    response.status(400).json({ ok: false, error: "symbol and intervalCode are required" });
    return;
  }
  response.json(await refreshKlineCacheForSymbol(symbol, intervalCode));
});

function scheduleDailyKlineAudit() {
  const now = new Date();
  const nextRunAt = nextDailyRunAt(config.crawler.dailyAuditHour, now);
  const delayMs = nextRunAt.getTime() - now.getTime();
  setDailyAuditNextRunAt(nextRunAt);
  const timer = setTimeout(async () => {
    try {
      await runDailyKlineAudit({ syncUniverse: true });
    } catch (error) {
      console.error("daily kline audit failed", error);
    } finally {
      scheduleDailyKlineAudit();
    }
  }, delayMs);
  timer.unref?.();
}

async function runRecoveryKlineAudit() {
  try {
    await runDailyKlineAudit({ syncUniverse: false });
  } catch (error) {
    console.error("recovery kline audit failed", error);
  }
}

await ensureDatabase();
startPriceChangeKlineScheduler();
setInterval(() => {
  initializeTokenUniverse().catch((error) => console.error("token universe sync failed", error));
}, config.crawler.tokenUniverseSyncMs).unref?.();
setInterval(() => {
  startCrawler({ mode: "incremental", reason: "定时增量刷新", includeIncremental: true })
    .catch((error) => console.error("incremental crawler failed", error));
}, config.crawler.incrementalRefreshMs).unref?.();
setInterval(runRecoveryKlineAudit, config.crawler.recoveryAuditMs).unref?.();
scheduleDailyKlineAudit();

app.listen(config.service.crawlerPort, config.service.host, () => {
  console.log(`Crawler service running at http://${config.service.host}:${config.service.crawlerPort}`);
  if (config.crawler.autoStart) {
    startCrawler({ mode: "incremental", reason: "服务启动自动刷新", includeIncremental: true })
      .catch((error) => console.error("auto crawler failed", error));
  }
});
