function finiteNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

export function evaluateOpenInterestSpike(
  { change5mPct = null, change1hPct = null } = {},
  { spike5mPct = 5, spike1hPct = 10 } = {}
) {
  const normalized5mPct = finiteNumber(change5mPct);
  const normalized1hPct = finiteNumber(change1hPct);
  const hit5m = normalized5mPct !== null && normalized5mPct >= Number(spike5mPct);
  const hit1h = normalized1hPct !== null && normalized1hPct >= Number(spike1hPct);

  return {
    hit: hit5m || hit1h,
    hit5m,
    hit1h,
    change5mPct: normalized5mPct,
    change1hPct: normalized1hPct
  };
}
