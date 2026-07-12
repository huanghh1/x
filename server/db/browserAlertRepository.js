import { config } from "../config.js";
import { getPool } from "./connection.js";

function openInterestActiveSeconds() {
  return Math.max(60, Math.floor(config.openInterestMonitor.activeMs / 1000));
}

export async function listBrowserAlertStates() {
  const [oiRows, fundingRows] = await Promise.all([
    getPool().query(
      `SELECT symbol,
        change_5m_pct AS change5mPct,
        change_1h_pct AS change1hPct,
        change_4h_pct AS change4hPct,
        change_1d_pct AS change1dPct,
        observed_at AS observedAt
       FROM open_interest_monitor
       WHERE observed_at >= DATE_SUB(NOW(3), INTERVAL :activeSeconds SECOND)
         AND (
           change_5m_pct >= :spike5mPct
           OR change_1h_pct >= :spike1hPct
           OR change_4h_pct >= :spike4hPct
           OR change_1d_pct >= :spike1dPct
         )
       ORDER BY observed_at DESC, symbol`,
      {
        activeSeconds: openInterestActiveSeconds(),
        spike5mPct: config.openInterestMonitor.spike5mPct,
        spike1hPct: config.openInterestMonitor.spike1hPct,
        spike4hPct: config.openInterestMonitor.spike4hPct,
        spike1dPct: config.openInterestMonitor.spike1dPct
      }
    ),
    getPool().query(
      `SELECT symbol,
        current_funding_rate AS currentFundingRate,
        last_changed_at AS lastChangedAt,
        last_seen_at AS lastSeenAt
       FROM funding_interval_state
       WHERE funding_interval_hours=1
         AND source_present=1
       ORDER BY COALESCE(last_changed_at, last_seen_at) DESC, symbol`
    )
  ]);

  return {
    oiAlerts: oiRows[0].map((row) => ({
      symbol: row.symbol,
      windows: [
        Number(row.change5mPct) >= config.openInterestMonitor.spike5mPct ? "5m" : null,
        Number(row.change1hPct) >= config.openInterestMonitor.spike1hPct ? "1h" : null,
        Number(row.change4hPct) >= config.openInterestMonitor.spike4hPct ? "4h" : null,
        Number(row.change1dPct) >= config.openInterestMonitor.spike1dPct ? "1d" : null
      ].filter(Boolean),
      observedAt: row.observedAt
    })),
    fundingAlerts: fundingRows[0].map((row) => ({
      symbol: row.symbol,
      currentFundingRate: row.currentFundingRate === null ? null : Number(row.currentFundingRate),
      lastChangedAt: row.lastChangedAt,
      lastSeenAt: row.lastSeenAt
    }))
  };
}
