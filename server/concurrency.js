export function normalizeConcurrency(value, { fallback = 1, min = 1, max = Number.MAX_SAFE_INTEGER } = {}) {
  const safeMin = Math.max(1, Math.floor(Number(min) || 1));
  const safeMax = Math.max(safeMin, Math.floor(Number(max) || safeMin));
  const configured = Number(value);
  const fallbackValue = Number(fallback);
  const raw = Number.isFinite(configured) ? configured : fallbackValue;
  const integer = Math.floor(Number.isFinite(raw) ? raw : safeMin);
  return Math.max(safeMin, Math.min(safeMax, integer));
}

export async function mapLimit(items, concurrency, fn) {
  const list = Array.isArray(items) ? items : [];
  const results = Array(list.length);
  const workerCount = normalizeConcurrency(concurrency, { max: list.length || 1 });
  let cursor = 0;
  const workers = Array.from({ length: workerCount }, async () => {
    while (cursor < list.length) {
      const index = cursor;
      cursor += 1;
      try {
        results[index] = { status: "fulfilled", value: await fn(list[index], index) };
      } catch (reason) {
        results[index] = { status: "rejected", reason };
      }
    }
  });
  await Promise.all(workers);
  return results;
}
