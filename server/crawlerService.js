import express from "express";
import { config } from "./config.js";
import {
  getCrawlerState,
  initializeTokenUniverse,
  runDailyKlineAudit,
  setDailyAuditNextRunAt,
  startCrawler,
  stopCrawler
} from "./crawler.js";
import { nextDailyRunAt } from "./dailySchedule.js";
import { ensureDatabase } from "./db.js";
import { requireInternalService } from "./serviceClient.js";
import { getWatchlistMarketState, refreshWatchlistMarketData } from "./watchlistMarket.js";

const app = express();
app.use(express.json({ limit: "256kb" }));
app.use("/internal", requireInternalService);

app.get("/internal/health", (_request, response) => {
  response.json({ ok: true, role: "crawler", crawler: getCrawlerState(), watchlistMarket: getWatchlistMarketState() });
});

app.post("/internal/bootstrap", async (_request, response) => {
  const universe = await initializeTokenUniverse();
  response.json({ ok: true, universe: { count: universe.count }, crawler: await startCrawler() });
});

app.post("/internal/crawl/start", async (_request, response) => {
  response.json({ ok: true, crawler: await startCrawler() });
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

await ensureDatabase();
setInterval(() => {
  initializeTokenUniverse().catch((error) => console.error("token universe sync failed", error));
}, config.crawler.tokenUniverseSyncMs).unref?.();
setInterval(() => {
  startCrawler().catch((error) => console.error("incremental crawler failed", error));
}, config.crawler.incrementalRefreshMs).unref?.();
setInterval(() => {
  refreshWatchlistMarketData().catch((error) => console.error("watchlist market refresh failed", error));
}, 15_000).unref?.();
scheduleDailyKlineAudit();

app.listen(config.service.crawlerPort, config.service.host, () => {
  console.log(`Crawler service running at http://${config.service.host}:${config.service.crawlerPort}`);
  if (config.crawler.autoStart) startCrawler().catch((error) => console.error("auto crawler failed", error));
});
