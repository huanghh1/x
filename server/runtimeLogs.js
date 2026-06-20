import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const RUNTIME_LOG_SERVICES = ["api", "crawler", "realtime", "scheduler"];

export const RUNTIME_LOG_FILES = RUNTIME_LOG_SERVICES.flatMap((service) => [
  { service, type: "error", file: `monitor-${service}-error.log` },
  { service, type: "out", file: `monitor-${service}-out.log` }
]);

export const RUNTIME_ERROR_LOG_FILES = RUNTIME_LOG_FILES.filter((item) => item.type === "error");

export function pm2LogDir() {
  return path.join(process.env.PM2_HOME || path.join(os.homedir(), ".pm2"), "logs");
}

export function runtimeLogPath(file, logDir = pm2LogDir()) {
  return path.join(logDir, file);
}

export async function cleanupRuntimeLogFiles({ logDir = pm2LogDir(), files = RUNTIME_LOG_FILES } = {}) {
  const results = await Promise.all(files.map(async ({ service, type, file }) => {
    const filePath = runtimeLogPath(file, logDir);
    try {
      const stat = await fs.stat(filePath);
      await fs.truncate(filePath, 0);
      return {
        service,
        type,
        file,
        existed: true,
        truncatedBytes: stat.size
      };
    } catch (error) {
      if (error?.code === "ENOENT") {
        return {
          service,
          type,
          file,
          existed: false,
          truncatedBytes: 0
        };
      }
      throw error;
    }
  }));

  return {
    fileCount: results.length,
    truncatedCount: results.filter((item) => item.existed).length,
    truncatedBytes: results.reduce((sum, item) => sum + item.truncatedBytes, 0),
    files: results
  };
}
