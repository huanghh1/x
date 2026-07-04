import express from "express";
import {
  getHotMaSignalsPage,
  getSignalGroupsPage,
  getSignals,
  listMultiCycleHistory
} from "../db.js";

export function createSignalRoutes() {
  const router = express.Router();

  router.get("/api/signals", async (request, response) => {
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

  router.get("/api/hot-ma-signals", async (request, response) => {
    const result = await getHotMaSignalsPage({
      categories: request.query.categories ?? "A,B",
      levels: request.query.levels ?? "LEVEL1,LEVEL2",
      intervals: request.query.intervals ?? "15m,1h,4h,1d",
      page: request.query.page,
      pageSize: request.query.pageSize
    });
    response.json({ ok: true, ...result });
  });

  router.get("/api/multi-history", async (request, response) => {
    response.json({ ok: true, items: await listMultiCycleHistory({ limit: request.query.limit }) });
  });

  return router;
}
