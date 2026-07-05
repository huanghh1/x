import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { parsePm2ErrorLog, runtimeStateErrors } from "./api/runtimeLogsRoutes.js";
import { cleanupRuntimeLogFiles } from "./runtimeLogs.js";

test("cleanupRuntimeLogFiles truncates existing runtime log files and ignores missing files", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "runtime-logs-"));
  try {
    await fs.writeFile(path.join(tmpDir, "monitor-api-error.log"), "first line\nsecond line\n");

    const result = await cleanupRuntimeLogFiles({
      logDir: tmpDir,
      files: [
        { service: "api", type: "error", file: "monitor-api-error.log" },
        { service: "api", type: "out", file: "monitor-api-out.log" }
      ]
    });

    const stat = await fs.stat(path.join(tmpDir, "monitor-api-error.log"));
    assert.equal(stat.size, 0);
    assert.equal(result.fileCount, 2);
    assert.equal(result.truncatedCount, 1);
    assert.equal(result.truncatedBytes, "first line\nsecond line\n".length);
    assert.equal(result.files[1].existed, false);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test("parsePm2ErrorLog downgrades transient Telegram polling aborts to warnings", () => {
  const entries = parsePm2ErrorLog(
    "scheduler",
    "0|monitor-scheduler| telegram bot polling failed: This operation was aborted (suppressed 6 similar polling errors)\n"
  );

  assert.equal(entries.length, 1);
  assert.equal(entries[0].category, "TELEGRAM");
  assert.equal(entries[0].severity, "WARN");
});

test("runtimeStateErrors reports partial tail refresh network failures as warnings", () => {
  const entries = runtimeStateErrors({
    crawler: {
      ok: true,
      crawler: {
        lastError: null,
        tailRefresh: {
          lastError: "BTUUSDT 1h: BTUUSDT 1h klines fetch failed (ECONNRESET): Client network socket disconnected before secure TLS connection was established",
          lastErrorAt: "2026-07-05T02:21:41.000Z",
          errorCount: 197,
          refreshedRows: 1243
        }
      }
    },
    realtime: { ok: true, watchRealtime: {} },
    scheduler: { ok: true }
  });

  assert.equal(entries.length, 1);
  assert.equal(entries[0].component, "tailRefresh");
  assert.equal(entries[0].category, "NETWORK");
  assert.equal(entries[0].severity, "WARN");
});
