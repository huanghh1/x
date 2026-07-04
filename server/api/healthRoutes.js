import express from "express";
import { getOverview, pingDatabase } from "../db.js";
import { serviceStates } from "../serviceClient.js";
import { telegramState } from "../telegram.js";
import { mergeOpenInterestMonitorQueueState } from "./routeUtils.js";

export function createHealthRoutes() {
  const router = express.Router();

  router.get("/api/health", async (_request, response) => {
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
        openInterestMonitor: mergeOpenInterestMonitorQueueState(
          services.scheduler?.openInterestMonitor,
          services.scheduler?.telegramAlertQueue
        ),
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

  router.get("/api/overview", async (_request, response) => {
    const services = await serviceStates();
    response.json({
      ok: true,
      overview: await getOverview(),
      crawler: services.crawler?.crawler ?? null,
      watchRealtime: services.realtime?.watchRealtime ?? null,
      fundingMonitor: services.scheduler?.fundingMonitor ?? null,
      openInterestMonitor: mergeOpenInterestMonitorQueueState(
        services.scheduler?.openInterestMonitor,
        services.scheduler?.telegramAlertQueue
      ),
      tokenUnlock: services.scheduler?.tokenUnlock ?? null,
      telegram: { ...telegramState(), bot: services.scheduler?.telegramBot ?? null },
      database: "connected"
    });
  });

  return router;
}
