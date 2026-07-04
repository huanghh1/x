import express from "express";
import { config } from "../config.js";
import { getKlineAuditReport, getKlines, listKlineTailRefreshTargets } from "../db.js";
import { requestKlineRefreshIfNeeded } from "./klineRefresh.js";

export function createKlineRoutes() {
  const router = express.Router();

  router.get("/api/kline-health", async (_request, response) => {
    try {
      response.json({ ok: true, ...(await getKlineAuditReport(config.crawler.retentionLimits)) });
    } catch (error) {
      console.error("get kline health failed", error);
      response.status(500).json({ ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  });

  router.get("/api/kline-tail-health", async (_request, response) => {
    try {
      const targets = await listKlineTailRefreshTargets({ limit: 10_000 });
      response.json({
        ok: true,
        generatedAt: new Date().toISOString(),
        targetIntervalCount: targets.length,
        targetTokenCount: new Set(targets.map((item) => item.symbol)).size,
        targets
      });
    } catch (error) {
      console.error("get kline tail health failed", error);
      response.status(500).json({ ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  });

  router.get("/api/klines", async (request, response) => {
    const symbol = String(request.query.symbol ?? "").toUpperCase().replace(/[^A-Z0-9_]/g, "");
    const interval = ["15m", "1h", "4h", "1d"].includes(request.query.interval) ? request.query.interval : "1h";
    const limit = request.query.limit === "all" ? "all" : Math.max(50, Math.min(1000, Number(request.query.limit) || 240));
    if (!symbol) {
      response.status(400).json({ ok: false, error: "symbol is required" });
      return;
    }
    const payload = await getKlines({ symbol, intervalCode: interval, limit });
    if (payload.needsRefresh) {
      requestKlineRefreshIfNeeded({
        symbol,
        intervalCode: interval,
        reason: payload.refreshReason,
        queueReasonPrefix: "按需补齐",
        logLabel: "on-demand kline"
      });
    }
    response.json({
      ok: true,
      ...payload,
      tradingViewSymbol: `BINANCE:${symbol}.P`
    });
  });

  return router;
}
