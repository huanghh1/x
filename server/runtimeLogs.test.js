import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
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
