function finitePriceChange(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

export function sortSignalRowsByPriceChange(rows = [], direction = null) {
  const list = [...rows];
  if (!["asc", "desc"].includes(direction)) return list;
  const multiplier = direction === "asc" ? 1 : -1;
  return list.sort((left, right) => {
    const leftChange = finitePriceChange(left?.priceChange24hPct);
    const rightChange = finitePriceChange(right?.priceChange24hPct);
    if (leftChange === null && rightChange === null) {
      return String(left?.symbol ?? "").localeCompare(String(right?.symbol ?? ""));
    }
    if (leftChange === null) return 1;
    if (rightChange === null) return -1;
    return (leftChange - rightChange) * multiplier ||
      String(left?.symbol ?? "").localeCompare(String(right?.symbol ?? ""));
  });
}

export function signalPriceChangePage(rows = [], direction = null, page = 1, pageSize = 20) {
  const safePage = Math.max(1, Number(page) || 1);
  const safePageSize = Math.max(1, Number(pageSize) || 20);
  const start = (safePage - 1) * safePageSize;
  return sortSignalRowsByPriceChange(rows, direction).slice(start, start + safePageSize);
}
