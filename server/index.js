import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "./config.js";
import { ensureDatabase } from "./db.js";
import { createCodexRoutes } from "./api/codexRoutes.js";
import { createCrawlerRoutes } from "./api/crawlerRoutes.js";
import { createHealthRoutes } from "./api/healthRoutes.js";
import { createHotRankRoutes } from "./api/hotRankRoutes.js";
import { createKlineRoutes } from "./api/klineRoutes.js";
import { createMarketMonitorRoutes } from "./api/marketMonitorRoutes.js";
import { requireLocalMutation, requireSensitiveRead } from "./api/middleware/auth.js";
import { createOpenAppRoutes } from "./api/openAppRoutes.js";
import { createRuntimeLogsRouter } from "./api/runtimeLogsRoutes.js";
import { createSignalRoutes } from "./api/signalRoutes.js";
import { createTradeAnalysisRoutes } from "./api/tradeAnalysisRoutes.js";
import { createTradeJournalRoutes } from "./api/tradeJournalRoutes.js";
import { createTriggerHistoryRoutes } from "./api/triggerHistoryRoutes.js";
import { createWatchlistRoutes } from "./api/watchlistRoutes.js";
import { startTradePositionPrefetch } from "./tradeAnalysis.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const app = express();

app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.resolve(__dirname, "../public")));

app.use(createHealthRoutes());
app.use(createRuntimeLogsRouter({ requireSensitiveRead, requireLocalMutation }));
app.use(createCrawlerRoutes({ requireLocalMutation }));
app.use(createKlineRoutes());
app.use(createTradeAnalysisRoutes({ requireSensitiveRead }));
app.use(createTradeJournalRoutes({ requireSensitiveRead, requireLocalMutation }));
app.use(createCodexRoutes({ requireLocalMutation }));
app.use(createSignalRoutes());
app.use(createHotRankRoutes());
app.use(createMarketMonitorRoutes({ requireLocalMutation }));
app.use(createWatchlistRoutes({ requireLocalMutation }));
app.use(createOpenAppRoutes());
app.use(createTriggerHistoryRoutes({ requireLocalMutation }));

app.use((_request, response) => {
  response.sendFile(path.resolve(__dirname, "../public/index.html"));
});

await ensureDatabase();
startTradePositionPrefetch(config);
app.listen(config.service.apiPort, config.service.apiHost, () => {
  console.log(`API service running at http://${config.service.apiHost}:${config.service.apiPort}`);
});
