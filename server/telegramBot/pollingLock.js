import fs from "node:fs";

function processIsRunning(pid) {
  if (!pid || !Number.isFinite(pid)) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function createPollingLock(lockPath) {
  let lockFd = null;

  function acquirePollingLock() {
    try {
      lockFd = fs.openSync(lockPath, "wx");
      fs.writeFileSync(lockFd, String(process.pid));
      return { acquired: true };
    } catch (error) {
      if (error?.code !== "EEXIST") return { acquired: false, reason: error.message };
      let existingPid = 0;
      try {
        existingPid = Number(fs.readFileSync(lockPath, "utf8").trim());
      } catch {
        existingPid = 0;
      }
      if (processIsRunning(existingPid)) {
        return { acquired: false, reason: `Telegram polling already held by local PID ${existingPid}` };
      }
      try {
        fs.unlinkSync(lockPath);
      } catch {
        return { acquired: false, reason: "Telegram polling lock exists and cannot be removed" };
      }
      return acquirePollingLock();
    }
  }

  function releasePollingLock() {
    if (lockFd === null) return;
    try {
      fs.closeSync(lockFd);
    } catch {
      // Ignore cleanup errors during process shutdown.
    }
    lockFd = null;
    try {
      fs.unlinkSync(lockPath);
    } catch {
      // Ignore stale lock cleanup errors; startup handles stale locks.
    }
  }

  return { acquirePollingLock, releasePollingLock };
}
