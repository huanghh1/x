import express from "express";
import { config } from "../config.js";
import { getHotRank } from "../hotRank.js";
import { requestService } from "../serviceClient.js";

const HOT_RANK_SERVICE_TIMEOUT_MS = Math.max(
  config.service.requestTimeoutMs,
  config.binance.requestTimeoutMs * 2 + 5000
);

function hotRankQueryParams(query) {
  const params = new URLSearchParams();
  for (const key of ["chain", "limit", "targetLanguage", "socialLanguage", "timeRange"]) {
    const value = Array.isArray(query[key]) ? query[key][0] : query[key];
    if (value !== undefined && value !== null && value !== "") params.set(key, String(value));
  }
  return params;
}

export function createHotRankRoutes() {
  const router = express.Router();

  router.get("/api/hot-rank", async (request, response) => {
    const params = hotRankQueryParams(request.query);
    const queryString = params.toString();
    try {
      response.json(await requestService("scheduler", `/internal/hot-rank${queryString ? `?${queryString}` : ""}`, {
        timeoutMs: HOT_RANK_SERVICE_TIMEOUT_MS
      }));
    } catch (error) {
      console.warn("scheduler hot rank unavailable, falling back to api process:", error instanceof Error ? error.message : error);
      try {
        const payload = await getHotRank({
          chain: String(request.query.chain ?? "all"),
          limit: request.query.limit,
          targetLanguage: String(request.query.targetLanguage ?? "zh"),
          socialLanguage: String(request.query.socialLanguage ?? "ALL"),
          timeRange: request.query.timeRange
        });
        response.json(payload);
      } catch (fallbackError) {
        response.status(502).json({
          ok: false,
          error: fallbackError instanceof Error ? fallbackError.message : String(fallbackError)
        });
      }
    }
  });

  return router;
}
