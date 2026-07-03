export function sanitizeDbSymbol(value) {
  return String(value ?? "").toUpperCase().replace(/[^A-Z0-9_]/g, "").slice(0, 32);
}

export function baseAssetFromSymbol(symbol) {
  return sanitizeDbSymbol(symbol).replace(/USDT$/, "");
}

export function baseAssetAliases(value) {
  const baseAsset = sanitizeDbSymbol(value);
  if (!baseAsset) return [];
  const aliases = new Set([baseAsset]);
  for (const prefix of ["1000000", "1000"]) {
    if (baseAsset.startsWith(prefix) && baseAsset.length > prefix.length) {
      aliases.add(baseAsset.slice(prefix.length));
    }
  }
  return Array.from(aliases);
}
