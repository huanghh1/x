import express from "express";
import {
  createTradeJournalEntry,
  createTradeJournalIntradayNote,
  deleteTradeJournalEntry,
  getTradeJournalEntry,
  listTradeJournal,
  updateTradeJournalEntry
} from "../db.js";

export function createTradeJournalRoutes({ requireSensitiveRead, requireLocalMutation }) {
  const router = express.Router();

  router.get("/api/trade-journal", requireSensitiveRead, async (request, response) => {
    try {
      response.json({
        ok: true,
        ...(await listTradeJournal({
          page: request.query.page,
          pageSize: request.query.pageSize,
          keyword: request.query.keyword,
          status: request.query.status
        }))
      });
    } catch (error) {
      console.error("get trade journal failed", error);
      response.status(500).json({ ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  });

  router.get("/api/trade-journal/:id", requireSensitiveRead, async (request, response) => {
    try {
      const item = await getTradeJournalEntry(request.params.id);
      if (!item) {
        response.status(404).json({ ok: false, error: "交易日记不存在" });
        return;
      }
      response.json({ ok: true, item });
    } catch (error) {
      console.error("get trade journal item failed", error);
      response.status(500).json({ ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  });

  router.post("/api/trade-journal", requireLocalMutation, async (request, response) => {
    try {
      response.json({ ok: true, item: await createTradeJournalEntry(request.body ?? {}) });
    } catch (error) {
      console.error("create trade journal failed", error);
      response.status(400).json({ ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  });

  router.put("/api/trade-journal/:id", requireLocalMutation, async (request, response) => {
    try {
      const item = await updateTradeJournalEntry(request.params.id, request.body ?? {});
      if (!item) {
        response.status(404).json({ ok: false, error: "交易日记不存在" });
        return;
      }
      response.json({ ok: true, item });
    } catch (error) {
      console.error("update trade journal failed", error);
      response.status(400).json({ ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  });

  router.post("/api/trade-journal/:id/intraday-notes", requireLocalMutation, async (request, response) => {
    try {
      const note = await createTradeJournalIntradayNote(request.params.id, request.body ?? {});
      if (!note) {
        response.status(404).json({ ok: false, error: "交易日记不存在" });
        return;
      }
      response.json({ ok: true, note });
    } catch (error) {
      console.error("create trade journal intraday note failed", error);
      response.status(400).json({ ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  });

  router.delete("/api/trade-journal/:id", requireLocalMutation, async (request, response) => {
    try {
      response.json({ ok: true, deleted: await deleteTradeJournalEntry(request.params.id) });
    } catch (error) {
      console.error("delete trade journal failed", error);
      response.status(500).json({ ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  });

  return router;
}
