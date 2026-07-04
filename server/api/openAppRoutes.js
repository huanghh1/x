import express from "express";
import { escapeHtml, sanitizeSymbol } from "./routeUtils.js";

function appOpenPage({ title, symbol, primaryDeepLink, secondaryDeepLinks = [], fallbackUrl, note }) {
  const deepLinks = [primaryDeepLink, ...secondaryDeepLinks].filter(Boolean);
  const encodedLinks = JSON.stringify(deepLinks);
  return `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>${escapeHtml(title)}</title>
    <style>
      body {
        margin: 0;
        min-height: 100vh;
        display: grid;
        place-items: center;
        font-family: Arial, "PingFang SC", "Microsoft YaHei", sans-serif;
        color: #211721;
        background: #fff8fb;
      }
      main {
        width: min(92vw, 460px);
        padding: 28px;
        border: 1px solid #eee8ec;
        border-radius: 18px;
        background: #fff;
        box-shadow: 0 18px 45px rgba(69, 39, 55, 0.12);
      }
      h1 { margin: 0 0 10px; font-size: 24px; }
      p { color: #6d606b; line-height: 1.7; }
      a, button {
        display: flex;
        align-items: center;
        justify-content: center;
        width: 100%;
        min-height: 44px;
        margin-top: 12px;
        border: 0;
        border-radius: 999px;
        color: #fff;
        background: #ed2a75;
        font: inherit;
        font-weight: 800;
        text-decoration: none;
      }
      button { cursor: pointer; }
      small { display: block; margin-top: 14px; color: #9b8f98; line-height: 1.6; }
    </style>
  </head>
  <body>
    <main>
      <h1>${escapeHtml(title)}</h1>
      <p>正在尝试打开 App：<strong>${escapeHtml(symbol)}</strong></p>
      <button id="openApp" type="button">再次尝试打开 App</button>
      <a href="${escapeHtml(fallbackUrl)}">打不开 App 时打开网页</a>
      <small>${escapeHtml(note)}</small>
    </main>
    <script>
      const deepLinks = ${encodedLinks};
      const fallbackUrl = ${JSON.stringify(fallbackUrl)};
      function openApp() {
        deepLinks.forEach((url, index) => {
          setTimeout(() => {
            window.location.href = url;
          }, index * 450);
        });
        setTimeout(() => {
          if (!document.hidden) window.location.href = fallbackUrl;
        }, 2600);
      }
      document.getElementById("openApp").addEventListener("click", openApp);
      openApp();
    </script>
  </body>
</html>`;
}

export function createOpenAppRoutes() {
  const router = express.Router();

  router.get("/open/binance", (request, response) => {
    const symbol = sanitizeSymbol(request.query.symbol);
    if (!symbol) {
      response.status(400).send("symbol is required");
      return;
    }
    const fallbackUrl = `https://www.binance.com/en/futures/${encodeURIComponent(symbol)}`;
    response.type("html").send(
      appOpenPage({
        title: "打开 Binance App",
        symbol,
        primaryDeepLink: `bnc://app.binance.com/futures/${encodeURIComponent(symbol)}`,
        secondaryDeepLinks: [
          `bnc://app.binance.com/en/futures/${encodeURIComponent(symbol)}`,
          "bnc://app.binance.com/markets/markets",
          "bnc://app.binance.com"
        ],
        fallbackUrl,
        note: "如果 Binance App 没有接管深链，会自动回落到网页合约页。"
      })
    );
  });

  router.get("/open/tradingview", (request, response) => {
    const symbol = sanitizeSymbol(request.query.symbol);
    if (!symbol) {
      response.status(400).send("symbol is required");
      return;
    }
    const tvSymbol = `BINANCE:${symbol}.P`;
    const fallbackUrl = `https://www.tradingview.com/chart/?symbol=${encodeURIComponent(tvSymbol)}`;
    response.type("html").send(
      appOpenPage({
        title: "打开 TradingView App",
        symbol: tvSymbol,
        primaryDeepLink: `tradingview://chart/?symbol=${encodeURIComponent(tvSymbol)}`,
        secondaryDeepLinks: [`tradingview://symbols/${encodeURIComponent(tvSymbol.replace(":", "-"))}/`, "tradingview://"],
        fallbackUrl,
        note: "如果 TradingView App 没有接管深链，会自动回落到网页图表页。"
      })
    );
  });

  return router;
}
