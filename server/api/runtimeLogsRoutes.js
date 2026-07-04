import express from "express";
import fs from "node:fs/promises";
import { cleanupRuntimeLogFiles, RUNTIME_ERROR_LOG_FILES, RUNTIME_LOG_FILES, runtimeLogPath } from "../runtimeLogs.js";
import { serviceStates } from "../serviceClient.js";

async function readLogTail(filePath, maxBytes = 240_000) {
  const stat = await fs.stat(filePath);
  const start = Math.max(0, stat.size - maxBytes);
  const handle = await fs.open(filePath, "r");
  try {
    const buffer = Buffer.alloc(stat.size - start);
    await handle.read(buffer, 0, buffer.length, start);
    return {
      text: buffer.toString("utf8"),
      size: stat.size,
      mtime: stat.mtime
    };
  } finally {
    await handle.close();
  }
}

function compactLogEntry(service, rawLines, index) {
  const lines = rawLines.map((line) => line.replace(/^\d+\|[^|]*\|\s?/, "").trim()).filter(Boolean);
  const firstLine = lines[0] ?? "";
  const causeLine = lines.find((line) => /\b(cause|code|errno|syscall|hostname|host):/i.test(line));
  const message = [firstLine, causeLine && causeLine !== firstLine ? causeLine : null].filter(Boolean).join(" | ");
  const severity = /\b(error|failed|timeout|ECONNRESET|ENOTFOUND|UND_ERR|HTTP 4|HTTP 5)\b/i.test(message)
    ? "ERROR"
    : "WARN";
  const category = classifyRuntimeError({ service, message, details: lines.join("\n") });
  return {
    id: `${service}-${index}`,
    service,
    severity,
    category: category.key,
    categoryLabel: category.label,
    message: message.slice(0, 1000),
    details: lines.slice(0, 16).join("\n").slice(0, 3000)
  };
}

function classifyRuntimeError({ service = "", component = "", message = "", details = "" } = {}) {
  const text = `${service} ${component} ${message} ${details}`.toLowerCase();
  if (/(enotfound|eai_again|und_err_connect_timeout|etimedout|econnreset|fetch failed|connect timeout|socket disconnected|tls|dns|getaddrinfo|network)/i.test(text)) {
    return { key: "NETWORK", label: "网络连接" };
  }
  if (/(http 418|http 429|too many requests|rate limit|used-weight)/i.test(text)) {
    return { key: "BINANCE_LIMIT", label: "Binance限频" };
  }
  if (/(binance|fapi\.binance|api\.binance|premium index|klines|open interest|funding info).*http [45]\d\d/i.test(text)) {
    return { key: "BINANCE_HTTP", label: "Binance接口" };
  }
  if (/(telegram|bot|getupdates|sendmessage)/i.test(text)) {
    return { key: "TELEGRAM", label: "Telegram" };
  }
  if (/(mysql|database|sql|deadlock|er_|pool|connection.*refused|lock wait)/i.test(text)) {
    return { key: "DATABASE", label: "数据库" };
  }
  if (/(openinterest|open interest|oi[:\s_-]|open-interest)/i.test(text)) {
    return { key: "OI", label: "OI监控" };
  }
  if (/(funding|资金费率|premium index)/i.test(text)) {
    return { key: "FUNDING", label: "资金费率" };
  }
  if (/(kline|klines|watchlist market|crawler|token universe|crawl)/i.test(text)) {
    return { key: "KLINE", label: "K线抓取" };
  }
  if (/(syntaxerror|typeerror|referenceerror|rangeerror|unhandled|exception)/i.test(text)) {
    return { key: "PROGRAM", label: "程序异常" };
  }
  return { key: "OTHER", label: "其他" };
}

function parsePm2ErrorLog(service, text, limit = 80) {
  const lines = String(text ?? "").split(/\r?\n/).filter(Boolean);
  const entries = [];
  let current = [];
  const normalizeLine = (line) => line.replace(/^\d+\|[^|]*\|\s?/, "").trim();
  const startsEntry = (line) => {
    const normalized = normalizeLine(line);
    if (/^(\[cause\]|at\s|code:|errno:|syscall:|hostname:|host:|port:|localAddress:|path:|})/i.test(normalized)) {
      return false;
    }
    return /(failed|TypeError|Unhandled|Exception|^Error:|HTTP\s+[45]\d\d)/i.test(normalized);
  };
  for (const line of lines) {
    if (startsEntry(line) && current.length) {
      entries.push(compactLogEntry(service, current, entries.length));
      current = [];
    }
    if (startsEntry(line) || current.length) current.push(line);
    if (current.length >= 18) {
      entries.push(compactLogEntry(service, current, entries.length));
      current = [];
    }
  }
  if (current.length) entries.push(compactLogEntry(service, current, entries.length));
  return entries.slice(-limit).reverse();
}

function pushStateError(items, service, component, message, meta = {}) {
  if (!message) return;
  const category = classifyRuntimeError({ service, component, message, details: meta.details ?? "" });
  items.push({
    id: `state-${service}-${component}`,
    service,
    component,
    severity: "ERROR",
    category: category.key,
    categoryLabel: category.label,
    message: String(message).slice(0, 1000),
    updatedAt: meta.updatedAt ?? null,
    details: meta.details ?? ""
  });
}

function runtimeStateErrors(services) {
  const items = [];
  if (services.crawler?.ok === false) pushStateError(items, "crawler", "service", services.crawler.error);
  if (services.realtime?.ok === false) pushStateError(items, "realtime", "service", services.realtime.error);
  if (services.scheduler?.ok === false) pushStateError(items, "scheduler", "service", services.scheduler.error);

  const crawler = services.crawler?.crawler;
  pushStateError(items, "crawler", "crawler", crawler?.lastError, {
    updatedAt: crawler?.lastErrorAt ?? crawler?.runCompletedAt ?? crawler?.runStartedAt ?? null,
    details: crawler?.lastAction ?? ""
  });
  pushStateError(items, "crawler", "tailRefresh", crawler?.tailRefresh?.lastError, {
    updatedAt: crawler?.tailRefresh?.lastErrorAt ?? crawler?.tailRefresh?.lastCompletedAt ?? crawler?.tailRefresh?.lastStartedAt ?? null,
    details: crawler?.tailRefresh
      ? `errors=${crawler.tailRefresh.errorCount ?? 0}, refreshedRows=${crawler.tailRefresh.refreshedRows ?? 0}`
      : ""
  });
  pushStateError(items, "crawler", "dailyAudit", crawler?.dailyAudit?.lastError, {
    updatedAt: crawler?.dailyAudit?.lastStartedAt ?? null
  });
  pushStateError(items, "crawler", "watchlistMarket", services.crawler?.watchlistMarket?.lastError);

  const realtime = services.realtime?.watchRealtime;
  pushStateError(items, "realtime", "watchRealtime", realtime?.lastError, {
    updatedAt: realtime?.lastMessageAt ?? realtime?.connectedAt ?? null
  });

  const scheduler = services.scheduler ?? {};
  pushStateError(items, "scheduler", "maintenance", scheduler.maintenance?.lastError, {
    updatedAt: scheduler.maintenance?.lastRunAt ?? null
  });
  pushStateError(items, "scheduler", "runtimeLogCleanup", scheduler.maintenance?.runtimeLogCleanup?.lastError, {
    updatedAt: scheduler.maintenance?.runtimeLogCleanup?.lastRunAt ?? null
  });
  pushStateError(items, "scheduler", "fundingMonitor", scheduler.fundingMonitor?.lastError, {
    updatedAt: scheduler.fundingMonitor?.lastStartedAt ?? null
  });
  pushStateError(items, "scheduler", "openInterestMonitor", scheduler.openInterestMonitor?.lastError, {
    updatedAt: scheduler.openInterestMonitor?.lastStartedAt ?? null,
    details: (scheduler.openInterestMonitor?.errors ?? []).join("\n")
  });
  for (const error of scheduler.openInterestMonitor?.errors ?? []) {
    pushStateError(items, "scheduler", "openInterestToken", error, {
      updatedAt: scheduler.openInterestMonitor?.lastStartedAt ?? null
    });
  }
  for (const error of scheduler.tokenUnlock?.errors ?? []) {
    pushStateError(items, "scheduler", "tokenUnlock", error, {
      updatedAt: scheduler.tokenUnlock?.lastRunAt ?? null
    });
  }
  pushStateError(items, "scheduler", "telegramBot", scheduler.telegramBot?.lastError, {
    updatedAt: scheduler.telegramBot?.lastPollAt ?? null
  });
  return items;
}

export function createRuntimeLogsRouter({ requireSensitiveRead, requireLocalMutation }) {
  const router = express.Router();

  router.get("/api/runtime-logs", requireSensitiveRead, async (request, response) => {
    try {
      const limit = Math.max(20, Math.min(300, Number(request.query.limit) || 120));
      const services = await serviceStates();
      const stateErrors = runtimeStateErrors(services);
      const logResults = await Promise.all(
        RUNTIME_ERROR_LOG_FILES.map(async ({ service, file }) => {
          const filePath = runtimeLogPath(file);
          try {
            const tail = await readLogTail(filePath);
            return {
              service,
              file,
              fileSize: tail.size,
              updatedAt: tail.mtime.toISOString(),
              entries: parsePm2ErrorLog(service, tail.text, limit)
            };
          } catch (error) {
            if (error?.code === "ENOENT") return { service, file, fileSize: 0, updatedAt: null, entries: [] };
            return {
              service,
              file,
              fileSize: 0,
              updatedAt: null,
              entries: [{
                id: `${service}-log-read`,
                service,
                severity: "ERROR",
                message: `读取日志失败：${error instanceof Error ? error.message : String(error)}`,
                details: ""
              }]
            };
          }
        })
      );
      const logEntries = logResults.flatMap((result) =>
        result.entries.map((entry) => ({
          ...entry,
          file: result.file,
          updatedAt: result.updatedAt,
          source: "pm2"
        }))
      );
      response.json({
        ok: true,
        generatedAt: new Date().toISOString(),
        services,
        files: logResults.map(({ entries, ...file }) => ({ ...file, entryCount: entries.length })),
        stateErrors,
        entries: [...stateErrors.map((entry) => ({ ...entry, source: "state" })), ...logEntries].slice(0, limit)
      });
    } catch (error) {
      console.error("get runtime logs failed", error);
      response.status(500).json({ ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  });
  
  router.delete("/api/runtime-logs", requireLocalMutation, async (request, response) => {
    try {
      const requestedFiles = Array.isArray(request.body?.files)
        ? Array.from(new Set(request.body.files.map((file) => String(file ?? "")).filter(Boolean)))
        : [];
      const allowed = new Map(RUNTIME_LOG_FILES.map((item) => [item.file, item]));
      const files = requestedFiles.length
        ? requestedFiles.map((file) => allowed.get(file)).filter(Boolean)
        : RUNTIME_LOG_FILES;
      if (!files.length) {
        response.status(400).json({ ok: false, error: "no valid log files selected" });
        return;
      }
      const result = await cleanupRuntimeLogFiles({ files });
      response.json({ ok: true, ...result });
    } catch (error) {
      console.error("delete runtime logs failed", error);
      response.status(500).json({ ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  });

  return router;
}
