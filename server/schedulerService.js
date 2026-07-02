import express from "express";
import { config } from "./config.js";
import {
  ensureDatabase,
  markHotRankNotified,
  recordHotRankSnapshot,
  recordTriggerHistoryBatch
} from "./db.js";
import {
  getFundingIntervalMonitorState,
  runFundingIntervalCheck,
  startFundingIntervalMonitor
} from "./fundingMonitor.js";
import { getHotRank } from "./hotRank.js";
import { getMaintenanceRuntimeState, startMaintenanceScheduler } from "./maintenance.js";
import {
  getOpenInterestMonitorState,
  runOpenInterestCheck,
  startOpenInterestMonitor
} from "./openInterestMonitor.js";
import { requireInternalService } from "./serviceClient.js";
import { sendHotRankTelegram } from "./telegram.js";
import { getTelegramBotState, startTelegramBot } from "./telegramBot.js";
import {
  getTokenUnlockState,
  refreshTokenUnlock,
  runTokenUnlockRefresh,
  startTokenUnlockMonitor
} from "./tokenUnlock.js";

const app = express();
app.use(express.json({ limit: "128kb" }));
app.use("/internal", requireInternalService);

app.get("/internal/health", (_request, response) => {
  response.json({
    ok: true,
    role: "scheduler",
    maintenance: getMaintenanceRuntimeState(),
    fundingMonitor: getFundingIntervalMonitorState(),
    openInterestMonitor: getOpenInterestMonitorState(),
    tokenUnlock: getTokenUnlockState(),
    telegramBot: getTelegramBotState()
  });
});

app.post("/internal/funding/check", async (_request, response) => {
  response.json(await runFundingIntervalCheck({ force: true }));
});

app.post("/internal/open-interest/check", async (_request, response) => {
  response.json(await runOpenInterestCheck({ force: true }));
});

app.post("/internal/unlock/check", async (request, response) => {
  const symbol = String(request.body?.symbol ?? "").toUpperCase().replace(/[^A-Z0-9_]/g, "");
  const baseAsset = String(request.body?.baseAsset ?? symbol.replace(/USDT$/, ""))
    .toUpperCase()
    .replace(/[^A-Z0-9_]/g, "");
  if (symbol) {
    response.json({
      ok: true,
      item: await refreshTokenUnlock(symbol, baseAsset, { force: true })
    });
    return;
  }
  response.json(await runTokenUnlockRefresh({ force: true }));
});

app.get("/internal/hot-rank", async (request, response) => {
  try {
    response.json(await getHotRank({
      chain: String(request.query.chain ?? "all"),
      limit: request.query.limit,
      targetLanguage: String(request.query.targetLanguage ?? "zh"),
      socialLanguage: String(request.query.socialLanguage ?? "ALL"),
      timeRange: request.query.timeRange
    }));
  } catch (error) {
    response.status(502).json({ ok: false, error: error instanceof Error ? error.message : String(error) });
  }
});

async function refreshHotRank() {
  const payload = await getHotRank({ chain: "all", limit: 30 });
  const fresh = await recordHotRankSnapshot(payload.tokens ?? []);
  if (!fresh.length) return;
  const now = Date.now();
  await recordTriggerHistoryBatch(fresh.map((token) => ({
    eventKey: `hot:${token.symbol}:${Math.floor(now / 300000)}`,
    symbol: token.symbol,
    triggerType: "HOT_RANK",
    triggerTime: now,
    details: { chainLabel: token.chainLabel, rank: token.rank }
  })));
  const result = await sendHotRankTelegram(fresh);
  await markHotRankNotified(fresh.map((token) => token.symbol));
}

await ensureDatabase();
await startMaintenanceScheduler();
startTelegramBot();
startFundingIntervalMonitor();
startOpenInterestMonitor();
startTokenUnlockMonitor();
setInterval(() => {
  refreshHotRank().catch((error) => console.error("hot rank scheduler failed", error));
}, config.binance.hotRankCacheMs).unref?.();
refreshHotRank().catch((error) => console.error("initial hot rank refresh failed", error));

app.listen(config.service.schedulerPort, config.service.host, () => {
  console.log(`Scheduler service running at http://${config.service.host}:${config.service.schedulerPort}`);
});
