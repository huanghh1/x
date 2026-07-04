import express from "express";
import { config } from "../config.js";
import { getTradeAnalysis } from "../tradeAnalysis.js";

export function createTradeAnalysisRoutes({ requireSensitiveRead }) {
  const router = express.Router();

  router.get("/api/trade-analysis", requireSensitiveRead, async (request, response) => {
    try {
      response.json(await getTradeAnalysis(config, {
        start: request.query.start,
        end: request.query.end,
        symbol: request.query.symbol,
        page: request.query.page,
        pageSize: request.query.pageSize,
        mode: request.query.mode
      }));
    } catch (error) {
      console.error("get trade analysis failed", error);
      response.status(500).json({ ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  });

  return router;
}
