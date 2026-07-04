import express from "express";
import { respondWithServiceJson } from "./routeUtils.js";

export function createCrawlerRoutes({ requireLocalMutation }) {
  const router = express.Router();

  router.post("/api/bootstrap", requireLocalMutation, async (_request, response) => {
    await respondWithServiceJson(response, "crawler", "/internal/bootstrap", { method: "POST", body: "{}" });
  });

  router.post("/api/crawl/start", requireLocalMutation, async (_request, response) => {
    await respondWithServiceJson(response, "crawler", "/internal/crawl/start", { method: "POST", body: "{}" });
  });

  router.post("/api/crawl/stop", requireLocalMutation, async (_request, response) => {
    await respondWithServiceJson(response, "crawler", "/internal/crawl/stop", { method: "POST", body: "{}" });
  });

  router.post("/api/kline-audit", requireLocalMutation, async (_request, response) => {
    await respondWithServiceJson(response, "crawler", "/internal/kline/audit", {
      method: "POST",
      body: "{}",
      timeoutMs: 60_000
    });
  });

  router.post("/api/kline-tails", requireLocalMutation, async (_request, response) => {
    await respondWithServiceJson(response, "crawler", "/internal/kline/tails", {
      method: "POST",
      body: "{}",
      timeoutMs: 10 * 60 * 1000
    });
  });

  return router;
}
