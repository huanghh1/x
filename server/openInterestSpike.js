function finiteNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

export function evaluateOpenInterestSpike(
  { change5mPct = null, change1hPct = null, change4hPct = null, change1dPct = null } = {},
  { spike5mPct = 2, spike1hPct = 10, spike4hPct = 20, spike1dPct = 40 } = {}
) {
  const normalized5mPct = finiteNumber(change5mPct);
  const normalized1hPct = finiteNumber(change1hPct);
  const normalized4hPct = finiteNumber(change4hPct);
  const normalized1dPct = finiteNumber(change1dPct);
  const hit5m = normalized5mPct !== null && normalized5mPct >= Number(spike5mPct);
  const hit1h = normalized1hPct !== null && normalized1hPct >= Number(spike1hPct);
  const hit4h = normalized4hPct !== null && normalized4hPct >= Number(spike4hPct);
  const hit1d = normalized1dPct !== null && normalized1dPct >= Number(spike1dPct);

  return {
    hit: hit5m || hit1h || hit4h || hit1d,
    hit5m,
    hit1h,
    hit4h,
    hit1d,
    change5mPct: normalized5mPct,
    change1hPct: normalized1hPct,
    change4hPct: normalized4hPct,
    change1dPct: normalized1dPct
  };
}
