import { Readable } from "node:stream";
import express from "express";
import { config } from "../config.js";
import {
  deleteWatchlistItem,
  getTokenUnlockCache,
  listWatchlist,
  upsertWatchlistItem
} from "../db.js";
import { requestService, serviceUrl } from "../serviceClient.js";
import { respondWithServiceJson, sanitizeSymbol } from "./routeUtils.js";

export function createWatchlistRoutes({ requireLocalMutation }) {
  const router = express.Router();

  router.get("/api/watchlist", async (_request, response) => {
    response.json({ ok: true, items: await listWatchlist() });
  });

  router.get("/api/watchlist/events", async (request, response) => {
    let upstream;
    try {
      upstream = await fetch(serviceUrl("realtime", "/internal/events"), {
        headers: config.service.internalToken ? { "X-Internal-Service-Token": config.service.internalToken } : {}
      });
    } catch (error) {
      console.error("watchlist events upstream failed", error);
      response.status(503).json({ ok: false, error: error instanceof Error ? error.message : String(error) });
      return;
    }
    if (!upstream.ok || !upstream.body) {
      response.status(503).json({ ok: false, error: `realtime service HTTP ${upstream.status}` });
      return;
    }
    response.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no"
    });
    const stream = Readable.fromWeb(upstream.body);
    stream.on("error", (error) => {
      console.error("watchlist events stream failed", error);
      if (!response.destroyed) response.end();
    });
    stream.pipe(response);
    request.on("close", () => stream.destroy());
  });

  router.post("/api/watchlist", requireLocalMutation, async (request, response) => {
    try {
      const items = await upsertWatchlistItem(request.body ?? {});
      const symbol = sanitizeSymbol(request.body?.symbol);
      const baseAsset = symbol.replace(/USDT$/, "");
      void requestService("crawler", "/internal/watchlist/refresh", {
        method: "POST",
        body: JSON.stringify({ full: true }),
        timeoutMs: 60_000
      }).catch((error) => console.error("watchlist post-refresh failed", error));
      void requestService("realtime", "/internal/refresh", { method: "POST", body: "{}" })
        .catch((error) => console.error("watchlist realtime refresh failed", error));
      void requestService("scheduler", "/internal/unlock/check", {
        method: "POST",
        body: JSON.stringify({ symbol, baseAsset }),
        timeoutMs: 60_000
      })
        .catch((error) => console.error("watchlist unlock refresh failed", error));
      response.json({ ok: true, items });
    } catch (error) {
      response.status(400).json({ ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  });

  router.delete("/api/watchlist/:symbol", requireLocalMutation, async (request, response) => {
    const deleted = await deleteWatchlistItem(request.params.symbol);
    void requestService("realtime", "/internal/refresh", { method: "POST", body: "{}" })
      .catch((error) => console.error("watchlist realtime refresh failed", error));
    response.json({ ok: true, deleted });
  });

  router.get("/api/watchlist/:symbol/unlock", async (request, response) => {
    response.json({ ok: true, item: await getTokenUnlockCache(request.params.symbol) });
  });

  router.post("/api/watchlist/unlock/refresh", requireLocalMutation, async (_request, response) => {
    await respondWithServiceJson(response, "scheduler", "/internal/unlock/check", {
      method: "POST",
      body: "{}",
      timeoutMs: 60_000
    });
  });

  return router;
}
