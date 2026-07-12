import { getPool } from "./connection.js";

function windowsFromSignature(signature) {
  const entry = String(signature ?? "").split(";").find((part) => part.startsWith("windows="));
  const value = entry?.slice("windows=".length) ?? "";
  if (!value || value === "none") return [];
  return value.split(",").map((item) => item.trim()).filter(Boolean);
}

function timestampVersion(value) {
  const timestamp = new Date(value).getTime();
  return Number.isFinite(timestamp) ? String(timestamp) : String(value ?? "");
}

export async function listBrowserAlertStates() {
  const [oiRows, fundingRows] = await Promise.all([
    getPool().query(
      `SELECT symbol,
        last_spike_alert_at AS alertedAt,
        last_spike_alert_signature AS alertSignature
       FROM open_interest_monitor
       WHERE last_spike_alert_at >= DATE_SUB(NOW(3), INTERVAL 1 DAY)
       ORDER BY last_spike_alert_at DESC, symbol`
    ),
    getPool().query(
      `SELECT symbol,
        current_funding_rate AS currentFundingRate,
        one_hour_alerted_at AS alertedAt,
        one_hour_alert_count AS alertCount
       FROM funding_interval_state
       WHERE funding_interval_hours=1
         AND source_present=1
         AND one_hour_alerted_at IS NOT NULL
       ORDER BY one_hour_alerted_at DESC, symbol`
    )
  ]);

  return {
    oiAlerts: oiRows[0].map((row) => ({
      symbol: row.symbol,
      windows: windowsFromSignature(row.alertSignature),
      alertedAt: row.alertedAt,
      eventVersion: timestampVersion(row.alertedAt)
    })),
    fundingAlerts: fundingRows[0].map((row) => ({
      symbol: row.symbol,
      currentFundingRate: row.currentFundingRate === null ? null : Number(row.currentFundingRate),
      alertedAt: row.alertedAt,
      alertCount: Number(row.alertCount ?? 0),
      eventVersion: `${Number(row.alertCount ?? 0)}|${timestampVersion(row.alertedAt)}`
    }))
  };
}
