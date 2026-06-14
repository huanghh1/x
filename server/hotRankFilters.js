const STABLECOIN_SYMBOLS = new Set([
  "BUSD",
  "CRVUSD",
  "DAI",
  "EURC",
  "EURS",
  "EURT",
  "FDUSD",
  "FRAX",
  "GHO",
  "GUSD",
  "LUSD",
  "MIM",
  "PYUSD",
  "RLUSD",
  "SUSD",
  "TUSD",
  "USD0",
  "USD1",
  "USDA",
  "USDC",
  "USDD",
  "USDE",
  "USDP",
  "USDS",
  "USDT",
  "USTC"
]);

function tagText(tagInfoList) {
  if (!tagInfoList || typeof tagInfoList !== "object") return "";
  return JSON.stringify(tagInfoList).toLowerCase();
}

export function isStablecoinToken(token) {
  const symbol = String(token?.symbol ?? "").toUpperCase();
  const tags = tagText(token?.tagInfoList);
  return STABLECOIN_SYMBOLS.has(symbol) || tags.includes("stablecoin");
}

export function isTokenizedStockToken(token) {
  const tags = tagText(token?.tagInfoList);
  return [
    "tokenized stock",
    "tokenized stocks",
    "alpha stock",
    "prestocks",
    "stock-concept",
    "stock-technology",
    "stock-financial"
  ].some((marker) => tags.includes(marker));
}

export function filterEligibleHotTokens(tokens, topMarketCapSymbols) {
  const topSymbols = topMarketCapSymbols instanceof Set
    ? topMarketCapSymbols
    : new Set((topMarketCapSymbols ?? []).map((symbol) => String(symbol).toUpperCase()));
  const excluded = {
    topMarketCap: 0,
    stablecoin: 0,
    tokenizedStock: 0
  };
  const eligible = [];

  for (const token of tokens ?? []) {
    const symbol = String(token?.symbol ?? "").toUpperCase();
    if (topSymbols.has(symbol)) {
      excluded.topMarketCap += 1;
      continue;
    }
    if (isStablecoinToken(token)) {
      excluded.stablecoin += 1;
      continue;
    }
    if (isTokenizedStockToken(token)) {
      excluded.tokenizedStock += 1;
      continue;
    }
    const { tagInfoList: _tagInfoList, ...publicToken } = token;
    eligible.push({ ...publicToken, assetType: "crypto" });
  }

  return { tokens: eligible, excluded };
}
