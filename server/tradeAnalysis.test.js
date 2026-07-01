import assert from "node:assert/strict";
import test from "node:test";
import { getTradeAnalysis } from "./tradeAnalysis.js";

function response(payload) {
  return {
    ok: true,
    text: async () => JSON.stringify(payload)
  };
}

function testConfig() {
  return {
    tradeAnalysis: {
      requestTimeoutMs: 1000,
      defaultLookbackDays: 90,
      maxEventRows: 100,
      binance: {
        apiKey: "test-key",
        apiSecret: "test-secret",
        futuresBaseUrl: "https://binance.test",
        recvWindowMs: 5000
      },
      hyperliquid: {
        walletAddress: "",
        infoBaseUrl: "https://hyperliquid.test/info",
        perpDexs: []
      }
    }
  };
}

test("Binance transfers stay visible but do not count toward PnL summaries", async () => {
  const originalFetch = globalThis.fetch;
  const start = Date.UTC(2026, 0, 1, 0, 0, 0);
  const end = start + 60_000;

  try {
    globalThis.fetch = async (url) => {
      const parsed = new URL(url);
      if (parsed.pathname === "/fapi/v1/income") {
        return response([
          {
            incomeType: "TRANSFER",
            income: "800.00000000",
            asset: "USDT",
            symbol: "",
            time: start + 1000,
            info: "TRANSFER",
            tranId: "transfer-1"
          },
          {
            incomeType: "REALIZED_PNL",
            income: "10.00000000",
            asset: "USDT",
            symbol: "BTCUSDT",
            time: start + 2000,
            info: "trade-1",
            tranId: "pnl-1"
          },
          {
            incomeType: "FUNDING_FEE",
            income: "2.00000000",
            asset: "USDT",
            symbol: "BTCUSDT",
            time: start + 3000,
            info: "funding",
            tranId: "funding-1"
          },
          {
            incomeType: "COMMISSION",
            income: "-1.00000000",
            asset: "USDT",
            symbol: "BTCUSDT",
            time: start + 4000,
            info: "fee",
            tranId: "fee-1"
          }
        ]);
      }
      if (parsed.pathname === "/fapi/v3/positionRisk") {
        return response([
          {
            symbol: "BTCUSDT",
            positionAmt: "0.25",
            positionSide: "LONG",
            entryPrice: "100",
            markPrice: "110",
            notional: "27.5",
            unRealizedProfit: "2.5",
            leverage: "5",
            liquidationPrice: "50",
            marginType: "cross",
            updateTime: start + 5000
          }
        ]);
      }
      if (parsed.pathname === "/fapi/v1/userTrades") return response([]);
      if (parsed.pathname === "/fapi/v1/fundingRate") return response([]);
      throw new Error(`unexpected fetch ${url}`);
    };

    const analysis = await getTradeAnalysis(testConfig(), {
      start: new Date(start).toISOString(),
      end: new Date(end).toISOString()
    });

    const binanceSummary = analysis.summary.bySource.find((source) => source.source === "binance");
    assert.equal(binanceSummary.net, 11);
    assert.equal(binanceSummary.realizedPnl, 10);
    assert.equal(binanceSummary.funding, 2);
    assert.equal(binanceSummary.commission, -1);

    const transfer = analysis.events.find((event) => event.rawType === "TRANSFER");
    assert.equal(transfer.net, 800);
    assert.equal(transfer.pnlIncluded, false);
    assert.match(transfer.note, /不计入收益/);

    const currentPosition = analysis.events.find((event) => event.rawType === "CURRENT_POSITION");
    assert.equal(currentPosition.type, "OPEN_POSITION");
    assert.equal(currentPosition.pnlIncluded, false);
    assert.equal(currentPosition.unrealizedPnl, 2.5);
    assert.equal(analysis.positionSummary.unrealizedPnl, 2.5);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Binance userTrades enrich events without double-counting income PnL", async () => {
  const originalFetch = globalThis.fetch;
  const start = Date.UTC(2026, 0, 2, 0, 0, 0);
  const end = start + 60_000;

  try {
    globalThis.fetch = async (url) => {
      const parsed = new URL(url);
      if (parsed.pathname === "/fapi/v1/income") {
        return response([
          {
            incomeType: "REALIZED_PNL",
            income: "10.00000000",
            asset: "USDT",
            symbol: "BTCUSDT",
            time: start + 2000,
            info: "trade-1",
            tranId: "pnl-1"
          },
          {
            incomeType: "COMMISSION",
            income: "-1.00000000",
            asset: "USDT",
            symbol: "BTCUSDT",
            time: start + 3000,
            info: "fee",
            tranId: "fee-1"
          }
        ]);
      }
      if (parsed.pathname === "/fapi/v3/positionRisk") return response([]);
      if (parsed.pathname === "/fapi/v1/fundingRate") return response([]);
      if (parsed.pathname === "/fapi/v1/userTrades") {
        return response([
          {
            symbol: "BTCUSDT",
            id: 100,
            orderId: 10,
            price: "100",
            qty: "0.1",
            quoteQty: "10",
            commission: "1",
            commissionAsset: "USDT",
            realizedPnl: "10",
            side: "SELL",
            positionSide: "LONG",
            buyer: false,
            maker: false,
            time: start + 2500
          }
        ]);
      }
      throw new Error(`unexpected fetch ${url}`);
    };

    const analysis = await getTradeAnalysis(testConfig(), {
      start: new Date(start).toISOString(),
      end: new Date(end).toISOString()
    });

    const binanceSummary = analysis.summary.bySource.find((source) => source.source === "binance");
    assert.equal(binanceSummary.net, 9);
    assert.equal(binanceSummary.realizedPnl, 10);
    assert.equal(binanceSummary.commission, -1);

    const tradeDetail = analysis.events.find((event) => event.rawType === "USER_TRADE");
    assert.equal(tradeDetail.pnlIncluded, false);
    assert.equal(tradeDetail.net, 9);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("symbol summaries are sorted by latest activity time", async () => {
  const originalFetch = globalThis.fetch;
  const start = Date.UTC(2026, 0, 3, 0, 0, 0);
  const older = start + 1000;
  const newer = start + 10_000;
  const end = start + 60_000;

  try {
    globalThis.fetch = async (url) => {
      const parsed = new URL(url);
      if (parsed.pathname === "/fapi/v1/income") {
        return response([
          {
            incomeType: "REALIZED_PNL",
            income: "500.00000000",
            asset: "USDT",
            symbol: "OLDUSDT",
            time: older,
            info: "older profitable trade",
            tranId: "old-pnl"
          },
          {
            incomeType: "REALIZED_PNL",
            income: "1.00000000",
            asset: "USDT",
            symbol: "NEWUSDT",
            time: newer,
            info: "newer small trade",
            tranId: "new-pnl"
          }
        ]);
      }
      if (parsed.pathname === "/fapi/v3/positionRisk") return response([]);
      if (parsed.pathname === "/fapi/v1/userTrades") return response([]);
      throw new Error(`unexpected fetch ${url}`);
    };

    const analysis = await getTradeAnalysis(testConfig(), {
      start: new Date(start).toISOString(),
      end: new Date(end).toISOString()
    });

    assert.deepEqual(
      analysis.summary.bySymbol.map((row) => row.symbol),
      ["NEWUSDT", "OLDUSDT"]
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("symbol summaries support pagination when history storage is unavailable", async () => {
  const originalFetch = globalThis.fetch;
  const start = Date.UTC(2026, 0, 4, 0, 0, 0);
  const end = start + 60_000;

  try {
    globalThis.fetch = async (url) => {
      const parsed = new URL(url);
      if (parsed.pathname === "/fapi/v1/income") {
        return response([
          {
            incomeType: "REALIZED_PNL",
            income: "1.00000000",
            asset: "USDT",
            symbol: "AAAUSDT",
            time: start + 1000,
            info: "first",
            tranId: "aaa-pnl"
          },
          {
            incomeType: "REALIZED_PNL",
            income: "2.00000000",
            asset: "USDT",
            symbol: "BBBUSDT",
            time: start + 2000,
            info: "second",
            tranId: "bbb-pnl"
          },
          {
            incomeType: "REALIZED_PNL",
            income: "3.00000000",
            asset: "USDT",
            symbol: "CCCUSDT",
            time: start + 3000,
            info: "third",
            tranId: "ccc-pnl"
          }
        ]);
      }
      if (parsed.pathname === "/fapi/v3/positionRisk") return response([]);
      if (parsed.pathname === "/fapi/v1/userTrades") return response([]);
      throw new Error(`unexpected fetch ${url}`);
    };

    const analysis = await getTradeAnalysis(testConfig(), {
      start: new Date(start).toISOString(),
      end: new Date(end).toISOString(),
      page: 2,
      pageSize: 1
    });

    assert.equal(analysis.persistence.enabled, false);
    assert.equal(analysis.tradeRows.total, 3);
    assert.equal(analysis.tradeRows.page, 2);
    assert.equal(analysis.tradeRows.pageSize, 1);
    assert.deepEqual(
      analysis.summary.bySymbol.map((row) => row.symbol),
      ["BBBUSDT"]
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Hyperliquid positions include configured HIP-3 perp dexs", async () => {
  const originalFetch = globalThis.fetch;
  const start = Date.UTC(2026, 0, 5, 0, 0, 0);
  const end = start + 60_000;
  const requestedDexs = [];

  try {
    globalThis.fetch = async (url, options = {}) => {
      if (String(url) !== "https://hyperliquid.test/info") throw new Error(`unexpected fetch ${url}`);
      const body = JSON.parse(options.body);
      if (body.type === "userFillsByTime") return response([]);
      if (body.type === "userFunding") return response([]);
      if (body.type === "clearinghouseState") {
        requestedDexs.push(body.dex ?? "");
        return response({
          time: end,
          assetPositions: body.dex === "xyz"
            ? [
                {
                  position: {
                    coin: "xyz:JPY",
                    szi: "-193.66",
                    entryPx: "162.0",
                    positionValue: "31390.3494",
                    unrealizedPnl: "-17.4294",
                    leverage: { type: "isolated", value: 50 },
                    liquidationPx: "163.661191125"
                  }
                }
              ]
            : []
        });
      }
      throw new Error(`unexpected Hyperliquid request ${body.type}`);
    };

    const config = testConfig();
    config.tradeAnalysis.binance.apiKey = "";
    config.tradeAnalysis.binance.apiSecret = "";
    config.tradeAnalysis.hyperliquid.walletAddress = "0xf020762C7bb2A9f198D67b7B0d722dA0a55bBA1C";
    config.tradeAnalysis.hyperliquid.perpDexs = ["xyz"];

    const analysis = await getTradeAnalysis(config, {
      start: new Date(start).toISOString(),
      end: new Date(end).toISOString(),
      symbol: "USDJPY"
    });

    assert.deepEqual(requestedDexs, ["", "xyz"]);
    assert.equal(analysis.positionSummary.count, 1);
    assert.equal(analysis.positions[0].symbol, "xyz:JPY");
    assert.equal(analysis.positions[0].side, "short");
    assert.equal(analysis.positions[0].quantity, 193.66);
    assert.equal(analysis.positions[0].leverage, 50);
    assert.equal(analysis.positions[0].unrealizedPnl, -17.4294);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
