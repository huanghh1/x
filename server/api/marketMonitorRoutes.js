import express from "express";
import {
  addWatchlistItemsIfMissing,
  listOneHourFundingIntervals,
  listOpenInterestMonitorPage
} from "../db.js";
import { requestService } from "../serviceClient.js";
import { mergeOpenInterestMonitorQueueState } from "./routeUtils.js";

export function createMarketMonitorRoutes({ requireLocalMutation }) {
  const router = express.Router();

  router.post("/api/funding-interval/check", requireLocalMutation, async (_request, response) => {
    try {
      response.json(await requestService("scheduler", "/internal/funding/check", { method: "POST", body: "{}" }));
    } catch (error) {
      response.status(502).json({
        ok: false,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  });

  router.post("/api/open-interest/check", requireLocalMutation, async (_request, response) => {
    try {
      response.json(await requestService("scheduler", "/internal/open-interest/check", { method: "POST", body: "{}" }));
    } catch (error) {
      response.status(502).json({
        ok: false,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  });

  router.get("/api/funding-rate-tokens", async (_request, response) => {
    try {
      const tokens = await listOneHourFundingIntervals();
      const watchlistAdded = await addWatchlistItemsIfMissing(tokens, { note: "资金费率 1小时结算自动加入" });
      if (watchlistAdded > 0) {
        void requestService("crawler", "/internal/watchlist/refresh", {
          method: "POST",
          body: JSON.stringify({ full: true }),
          timeoutMs: 60_000
        }).catch((error) => console.error("funding watchlist post-refresh failed", error));
        void requestService("realtime", "/internal/refresh", { method: "POST", body: "{}" })
          .catch((error) => console.error("funding watchlist realtime refresh failed", error));
        void requestService("scheduler", "/internal/unlock/check", {
          method: "POST",
          body: "{}",
          timeoutMs: 60_000
        }).catch((error) => console.error("funding watchlist unlock refresh failed", error));
      }
      response.json({ ok: true, tokens, total: tokens.length, watchlistAdded });
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
        generatedAt: new Date().toISOString(),
        ...(await listOpenInterestMonitorPage({
          timeWindow,
          sort,
          page: request.query.page,
          pageSize: request.query.pageSize
        })),
        timeWindow,
        sort,
        monitor: mergeOpenInterestMonitorQueueState(scheduler?.openInterestMonitor, scheduler?.telegramAlertQueue)
      });
    } catch (error) {
      console.error("get oi monitoring failed", error);
      response.status(500).json({ ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  }

  router.get("/api/oi-monitoring", handleOpenInterestMonitoring);
  router.get("/api/io-monitoring", handleOpenInterestMonitoring);

  return router;
}
