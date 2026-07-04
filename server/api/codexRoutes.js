import express from "express";
import { config } from "../config.js";
import { getKlines } from "../db.js";
import { normalizeCodexScope, prepareCodexTradeAnalysis, runCodexTradeAnalysis } from "../codexTradeAnalysis.js";
import { normalizeTokenInterval, prepareCodexTokenAnalysis } from "../codexTokenAnalysis.js";
import { getTradeAnalysis } from "../tradeAnalysis.js";
import { requestKlineRefreshIfNeeded } from "./klineRefresh.js";
import { sanitizeSymbol } from "./routeUtils.js";

async function runPreparedCodexAnalysis(prepared) {
  const codexResult = await runCodexTradeAnalysis(prepared.prompt, {
    command: config.tradeAnalysis.codex.command,
    timeoutMs: config.tradeAnalysis.codex.timeoutMs
  });
  return {
    ok: true,
    generatedAt: new Date().toISOString(),
    scope: prepared.report.scope,
    title: prepared.report.title,
    report: prepared.report,
    analysis: codexResult.text
  };
}

export function createCodexRoutes({ requireLocalMutation }) {
  const router = express.Router();

  router.post("/api/trade-analysis/codex", requireLocalMutation, async (request, response) => {
    try {
      const body = request.body ?? {};
      const scope = normalizeCodexScope(body.scope);
      if (scope === "trade" && !body.tradeKey && (!body.source || !body.symbol)) {
        response.status(400).json({ ok: false, error: "请先在交易记录表中选择一个交易组。" });
        return;
      }
      if (scope === "symbol" && !body.symbol) {
        response.status(400).json({ ok: false, error: "请先选择一个币种汇总，或输入币种。" });
        return;
      }
      const analysis = await getTradeAnalysis(config, {
        start: scope === "all" ? "" : body.start,
        end: scope === "all" ? "" : body.end,
        symbol: scope === "range" || scope === "symbol" || scope === "trade" ? body.symbol : ""
      });
      const prepared = prepareCodexTradeAnalysis(analysis, {
        scope: body.scope,
        symbol: body.symbol,
        source: body.source,
        tradeKey: body.tradeKey,
        contextEventLimit: config.tradeAnalysis.codex.contextEventLimit
      });
      response.json(await runPreparedCodexAnalysis(prepared));
    } catch (error) {
      console.error("run codex trade analysis failed", error);
      response.status(error.statusCode || 500).json({ ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  });

  router.post("/api/token-analysis/codex", requireLocalMutation, async (request, response) => {
    try {
      const body = request.body ?? {};
      const symbol = sanitizeSymbol(body.symbol);
      const intervalCode = normalizeTokenInterval(body.intervalCode ?? body.interval);
      if (!symbol) {
        response.status(400).json({ ok: false, error: "symbol is required" });
        return;
      }

      const limit = body.klineLimit === undefined || body.klineLimit === null || body.klineLimit === "" || body.klineLimit === "all"
        ? "all"
        : Math.max(120, Number(body.klineLimit) || 360);
      const klinePayload = await getKlines({ symbol, intervalCode, limit });
      if (klinePayload.needsRefresh) {
        requestKlineRefreshIfNeeded({
          symbol,
          intervalCode,
          reason: klinePayload.refreshReason,
          queueReasonPrefix: "Codex 分析前补齐",
          logLabel: "token codex kline"
        });
      }

      const prepared = prepareCodexTokenAnalysis({
        symbol,
        intervalCode,
        klinePayload,
        context: body.context,
        contextKlineLimit: body.contextKlineLimit ?? config.tradeAnalysis.codex.tokenContextKlineLimit,
        promptTemplate: body.promptTemplate ?? body.template
      });
      response.json(await runPreparedCodexAnalysis(prepared));
    } catch (error) {
      console.error("run codex token analysis failed", error);
      response.status(error.statusCode || 500).json({ ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  });

  return router;
}
