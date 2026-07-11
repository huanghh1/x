export function normalizeCrawlerToken(token) {
  if (!token) return token;
  const baseAsset = token.base_asset ?? token.baseAsset ?? "";
  const categoryType = token.category_type ?? token.categoryType ?? null;
  const categoryLabel = token.category_label ?? token.categoryLabel ?? "";
  return {
    ...token,
    base_asset: baseAsset,
    baseAsset,
    category_type: categoryType,
    categoryType,
    category_label: categoryLabel,
    categoryLabel
  };
}

export function validateTokenUniverseSnapshot(tokens, current = {}) {
  if (!Array.isArray(tokens) || tokens.length === 0) {
    throw new Error("Token universe snapshot is empty");
  }
  const symbols = new Set();
  const counts = { total: tokens.length, categoryA: 0, categoryB: 0 };
  for (const token of tokens) {
    const symbol = String(token?.symbol ?? "").trim();
    const categoryType = token?.categoryType;
    if (!symbol || symbols.has(symbol) || !["A", "B"].includes(categoryType)) {
      throw new Error(`Invalid token universe row: ${symbol || "<empty>"}`);
    }
    symbols.add(symbol);
    counts[categoryType === "A" ? "categoryA" : "categoryB"] += 1;
  }

  const baseline = {
    total: Math.max(0, Number(current.total) || 0),
    categoryA: Math.max(0, Number(current.categoryA) || 0),
    categoryB: Math.max(0, Number(current.categoryB) || 0)
  };
  const checks = [
    ["total", 100, 0.7],
    ["categoryA", 20, 0.5],
    ["categoryB", 50, 0.7]
  ];
  for (const [key, minimumBaseline, ratio] of checks) {
    if (baseline[key] >= minimumBaseline && counts[key] < Math.floor(baseline[key] * ratio)) {
      throw new Error(
        `Token universe snapshot rejected: ${key} dropped from ${baseline[key]} to ${counts[key]}`
      );
    }
  }
  return counts;
}
