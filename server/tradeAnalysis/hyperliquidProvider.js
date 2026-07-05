import {
  describeError,
  fetchJson,
  finiteOrNull,
  missingSource,
  normalizeBaseUrl,
  normalizePositionQuantity,
  normalizeTradeAction,
  okSource,
  positionSide,
  retryTransient,
  SOURCE_LABELS,
  symbolMatchesValue,
  toNumber
} from "./shared.js";

const HYPERLIQUID_PAGE_LIMIT = 2000;

function hyperliquidFillEvent(item) {
  const fee = Math.abs(toNumber(item.fee));
  const price = finiteOrNull(item.px);
  const quantity = finiteOrNull(item.sz);
  const realizedPnl = toNumber(item.closedPnl);
  return {
    id: `hyperliquid:${item.hash ?? item.oid ?? item.time}:${item.tid ?? item.startPosition ?? ""}`,
    source: "hyperliquid",
    sourceLabel: SOURCE_LABELS.hyperliquid,
    symbol: item.coin || "--",
    asset: "USDC",
    time: Number(item.time) || null,
    type: item.dir || "fill",
    side: item.side || "",
    direction: item.dir || normalizeTradeAction({ source: "hyperliquid", side: item.side }),
    quantity,
    price,
    notional: price && quantity ? price * quantity : null,
    fundingRate: null,
    realizedPnl,
    funding: 0,
    commission: -fee,
    feeAsset: item.feeToken || "USDC",
    net: realizedPnl - fee,
    pnlIncluded: true,
    orderId: item.oid || "",
    tradeId: item.tid || "",
    liquidity: item.crossed ? "taker" : "maker",
    note: `start ${item.startPosition ?? "--"}`,
    rawType: "FILL"
  };
}

function hyperliquidFundingEvent(item) {
  const delta = item.delta ?? item;
  const amount = toNumber(delta.usdc ?? delta.funding ?? item.usdc);
  return {
    id: `hyperliquid-funding:${item.time ?? delta.time}:${delta.coin ?? item.coin}`,
    source: "hyperliquid",
    sourceLabel: SOURCE_LABELS.hyperliquid,
    symbol: delta.coin || item.coin || "--",
    asset: "USDC",
    time: Number(item.time ?? delta.time) || null,
    type: "funding",
    side: "",
    direction: "Funding",
    quantity: finiteOrNull(delta.szi),
    price: null,
    notional: null,
    fundingRate: finiteOrNull(delta.fundingRate),
    realizedPnl: 0,
    funding: amount,
    commission: 0,
    feeAsset: "USDC",
    net: amount,
    pnlIncluded: true,
    orderId: "",
    tradeId: item.hash || "",
    note: `samples ${delta.nSamples ?? "--"}`,
    rawType: "FUNDING"
  };
}

async function fetchHyperliquidInfo(config, body) {
  const source = config.tradeAnalysis.hyperliquid;
  return fetchJson(normalizeBaseUrl(source.infoBaseUrl), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  }, config.tradeAnalysis.requestTimeoutMs);
}

function hyperliquidPerpDexs(source) {
  const configuredDexs = Array.isArray(source.perpDexs)
    ? source.perpDexs
    : String(source.perpDexs ?? "").split(",");
  const dexs = ["", ...configuredDexs]
    .map((dex) => String(dex ?? "").trim())
    .filter((dex, index, all) => all.indexOf(dex) === index);
  return dexs.length ? dexs : [""];
}

function hyperliquidClearinghouseRequest(source, dex) {
  const request = {
    type: "clearinghouseState",
    user: source.walletAddress
  };
  if (dex) request.dex = dex;
  return request;
}

function hyperliquidPositionSymbol(position, dex) {
  const coin = String(position.coin || "").trim();
  if (!dex || !coin || coin.toLowerCase().startsWith(`${dex.toLowerCase()}:`)) return coin || "--";
  return `${dex}:${coin}`;
}

function hyperliquidPositionFromApi(position, payload, dex) {
  const symbol = hyperliquidPositionSymbol(position, dex);
  return {
    id: `hyperliquid-position:${dex || "default"}:${symbol}`,
    source: "hyperliquid",
    sourceLabel: SOURCE_LABELS.hyperliquid,
    symbol,
    asset: "USDC",
    side: positionSide(position.szi ?? position.size),
    quantity: normalizePositionQuantity(position.szi ?? position.size),
    entryPrice: finiteOrNull(position.entryPx),
    markPrice: null,
    notional: Math.abs(toNumber(position.positionValue)),
    unrealizedPnl: toNumber(position.unrealizedPnl),
    leverage: finiteOrNull(position.leverage?.value ?? position.leverage),
    liquidationPrice: finiteOrNull(position.liquidationPx),
    marginMode: position.leverage?.type || "",
    updatedAt: Number(payload.time) || null
  };
}

async function fetchHyperliquidPositions(config, symbol) {
  const source = config.tradeAnalysis.hyperliquid;
  const dexs = hyperliquidPerpDexs(source);
  const results = await Promise.allSettled(dexs.map(async (dex) => ({
    dex,
    payload: await retryTransient(() => fetchHyperliquidInfo(config, hyperliquidClearinghouseRequest(source, dex)))
  })));
  const fulfilled = results.filter((result) => result.status === "fulfilled");
  if (!fulfilled.length) throw results[0]?.reason ?? new Error("Hyperliquid 持仓读取失败");
  const positions = fulfilled.flatMap(({ value }) =>
    (Array.isArray(value.payload?.assetPositions) ? value.payload.assetPositions : [])
      .map((item) => item.position ?? item)
      .filter((position) => Math.abs(toNumber(position.szi ?? position.size)) > 0)
      .map((position) => hyperliquidPositionFromApi(position, value.payload, value.dex))
      .filter((position) => symbolMatchesValue(position.symbol, symbol))
  );
  const rejected = results.filter((result) => result.status === "rejected");
  return {
    positions,
    error: rejected.length
      ? `部分 Hyperliquid dex 持仓读取失败：${rejected.map((result) => describeError(result.reason)).join("；")}`
      : ""
  };
}

export async function fetchHyperliquidEvents(config, window, symbol) {
  const source = config.tradeAnalysis.hyperliquid;
  if (!source.walletAddress) return missingSource("hyperliquid", ["HYPERLIQUID_WALLET_ADDRESS"]);
  async function fetchFillsPaged() {
    const rows = [];
    let cursor = window.startMs;
    for (let page = 0; page < 25 && cursor <= window.endMs; page += 1) {
      const payload = await fetchHyperliquidInfo(config, {
        type: "userFillsByTime",
        user: source.walletAddress,
        startTime: cursor,
        endTime: window.endMs,
        aggregateByTime: true
      });
      const pageRows = Array.isArray(payload) ? payload : payload?.fills ?? payload?.data ?? [];
      rows.push(...pageRows);
      if (pageRows.length < HYPERLIQUID_PAGE_LIMIT) break;
      const lastTime = Math.max(...pageRows.map((row) => Number(row.time)).filter(Number.isFinite));
      if (!Number.isFinite(lastTime) || lastTime < cursor) break;
      cursor = lastTime + 1;
    }
    return rows;
  }
  async function fetchFundingPaged() {
    const rows = [];
    let cursor = window.startMs;
    for (let page = 0; page < 25 && cursor <= window.endMs; page += 1) {
      const payload = await fetchHyperliquidInfo(config, {
        type: "userFunding",
        user: source.walletAddress,
        startTime: cursor,
        endTime: window.endMs
      });
      const pageRows = Array.isArray(payload) ? payload : payload?.data ?? [];
      rows.push(...pageRows);
      if (pageRows.length < HYPERLIQUID_PAGE_LIMIT) break;
      const lastTime = Math.max(...pageRows.map((row) => Number(row.time)).filter(Number.isFinite));
      if (!Number.isFinite(lastTime) || lastTime < cursor) break;
      cursor = lastTime + 1;
    }
    return rows;
  }
  const [fillsResult, positionsResult] = await Promise.allSettled([
    fetchFillsPaged(),
    retryTransient(() => fetchHyperliquidPositions(config, symbol))
  ]);
  if (fillsResult.status === "rejected") throw fillsResult.reason;
  const fillsPayload = fillsResult.value;
  const fills = (Array.isArray(fillsPayload) ? fillsPayload : [])
    .filter((item) => symbolMatchesValue(item.coin, symbol))
    .map(hyperliquidFillEvent);
  let funding = [];
  try {
    const fundingPayload = await fetchFundingPaged();
    funding = (Array.isArray(fundingPayload) ? fundingPayload : [])
      .filter((item) => symbolMatchesValue(item.delta?.coin ?? item.coin, symbol))
      .map(hyperliquidFundingEvent);
  } catch (error) {
    funding = [];
  }
  const positionsPayload = positionsResult.status === "fulfilled" ? positionsResult.value : { positions: [], error: "" };
  const sourceResult = okSource("hyperliquid", [...fills, ...funding], positionsPayload.positions);
  sourceResult.rawEventCount = fills.length + funding.length;
  sourceResult.rangeNote = "Hyperliquid fills/funding 按时间向后分页抓取；fills 官方单次最多 2000 条，最近最多 10000 条。";
  if (positionsPayload.error) sourceResult.positionError = positionsPayload.error;
  if (positionsResult.status === "rejected") sourceResult.positionError = describeError(positionsResult.reason);
  return sourceResult;
}

export async function fetchHyperliquidPositionSource(config, symbol = "") {
  const source = config.tradeAnalysis.hyperliquid;
  if (!source.walletAddress) return missingSource("hyperliquid", ["HYPERLIQUID_WALLET_ADDRESS"]);
  const payload = await fetchHyperliquidPositions(config, symbol);
  const sourceResult = okSource("hyperliquid", [], payload.positions);
  if (payload.error) sourceResult.positionError = payload.error;
  return sourceResult;
}
