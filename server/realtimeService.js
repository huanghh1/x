import express from "express";
import { config } from "./config.js";
import { ensureDatabase } from "./db.js";
import { requireInternalService } from "./serviceClient.js";
import { sendWatchlistTelegram } from "./telegram.js";
import {
  getWatchlistRealtimeState,
  parseWatchRealtimeStreams,
  registerWatchRealtimeClientStreams,
  refreshWatchlistRealtime,
  shouldForwardWatchRealtimePayload,
  startWatchlistRealtime,
  stopWatchlistRealtime,
  watchRealtimeEvents
} from "./watchRealtime.js";

const app = express();
app.use(express.json({ limit: "128kb" }));
app.use("/internal", requireInternalService);

app.get("/internal/health", (_request, response) => {
  response.json({ ok: true, role: "realtime", watchRealtime: getWatchlistRealtimeState() });
});

app.post("/internal/refresh", async (_request, response) => {
  await refreshWatchlistRealtime();
  response.json({ ok: true, watchRealtime: getWatchlistRealtimeState() });
});

app.get("/internal/events", (request, response) => {
  const client = registerWatchRealtimeClientStreams(parseWatchRealtimeStreams(request.query.streams));
  response.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no"
  });
  response.write(`event: ready\ndata: ${JSON.stringify(getWatchlistRealtimeState())}\n\n`);
  const send = (payload) => {
    if (shouldForwardWatchRealtimePayload(client.streams, payload)) {
      response.write(`data: ${JSON.stringify(payload)}\n\n`);
    }
  };
  const heartbeat = setInterval(() => response.write(`event: ping\ndata: ${Date.now()}\n\n`), 25_000);
  watchRealtimeEvents.on("price", send);
  watchRealtimeEvents.on("kline", send);
  request.on("close", () => {
    clearInterval(heartbeat);
    watchRealtimeEvents.off("price", send);
    watchRealtimeEvents.off("kline", send);
    client.close();
  });
});

await ensureDatabase();
await startWatchlistRealtime({ alertSender: sendWatchlistTelegram });
const server = app.listen(config.service.realtimePort, config.service.host, () => {
  console.log(`Realtime service running at http://${config.service.host}:${config.service.realtimePort}`);
});

function shutdownRealtimeService() {
  stopWatchlistRealtime();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
}

process.once("SIGINT", shutdownRealtimeService);
process.once("SIGTERM", shutdownRealtimeService);
