import express from "express";
import {
  clearTriggerHistory,
  deleteTriggerHistory,
  listTriggerHistory
} from "../db.js";

export function createTriggerHistoryRoutes({ requireLocalMutation }) {
  const router = express.Router();

  router.get("/api/trigger-history", async (request, response) => {
    try {
      response.json({
        ok: true,
        ...(await listTriggerHistory({
          page: request.query.page,
          pageSize: request.query.pageSize,
          triggerTypes: request.query.triggerTypes
        }))
      });
    } catch (error) {
      console.error("get trigger history failed", error);
      response.status(500).json({ ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  });

  router.delete("/api/trigger-history/:id", requireLocalMutation, async (request, response) => {
    try {
      const deleted = await deleteTriggerHistory(request.params.id);
      response.json({ ok: true, deleted });
    } catch (error) {
      console.error("delete trigger history failed", error);
      response.status(500).json({ ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  });

  router.delete("/api/trigger-history", requireLocalMutation, async (request, response) => {
    try {
      const ids = Array.isArray(request.body?.ids) ? request.body.ids : [];
      const deleted = ids.length ? await deleteTriggerHistory(ids) : await clearTriggerHistory();
      response.json({ ok: true, deleted });
    } catch (error) {
      console.error("clear trigger history failed", error);
      response.status(500).json({ ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  });

  return router;
}
