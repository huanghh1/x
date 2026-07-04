import { requestService } from "../serviceClient.js";

export async function respondWithServiceJson(response, service, pathname, options = {}, statusCode = 503) {
  try {
    response.json(await requestService(service, pathname, options));
  } catch (error) {
    response.status(statusCode).json({
      ok: false,
      error: error instanceof Error ? error.message : String(error)
    });
  }
}

export function mergeOpenInterestMonitorQueueState(openInterestMonitor, telegramAlertQueue) {
  if (!openInterestMonitor) return null;
  const stats = telegramAlertQueue?.stats ?? {};
  const alertPendingCount = Math.max(0, Number(stats.pending ?? 0)) + Math.max(0, Number(stats.sending ?? 0));
  return {
    ...openInterestMonitor,
    alertPendingCount
  };
}

export function sanitizeSymbol(value) {
  return String(value ?? "").toUpperCase().replace(/[^A-Z0-9_]/g, "");
}

export function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
