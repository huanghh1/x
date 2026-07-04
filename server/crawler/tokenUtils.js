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
