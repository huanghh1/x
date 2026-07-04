import { escapeHtml } from "../utils/dom.js";

export function baseAsset(symbol) {
  return String(symbol ?? "").toUpperCase().replace(/USDT$/, "");
}

export function twitterSearchUrl(symbol) {
  return `https://mobile.twitter.com/search?q=${encodeURIComponent(`$${baseAsset(symbol)}`)}&src=typed_query&f=live`;
}

export function binanceSquareSearchUrl(symbol) {
  return `https://www.binance.com/en/square/search?s=${encodeURIComponent(baseAsset(symbol))}`;
}

export function searchButtons(symbol) {
  const safeSymbol = escapeHtml(symbol);
  return `
    <a class="mini-link" href="${escapeHtml(binanceSquareSearchUrl(symbol))}" target="_blank" rel="noreferrer" title="在币安广场搜索 ${safeSymbol}">广场</a>
    <a class="mini-link" href="${escapeHtml(twitterSearchUrl(symbol))}" target="_blank" rel="noreferrer" title="在推特搜索 ${safeSymbol}">推特</a>
  `;
}

export function copyButton(symbol, label = "复制") {
  return `<button class="copy-symbol" type="button" data-symbol="${escapeHtml(symbol)}" title="复制交易对">${escapeHtml(label)}</button>`;
}

export async function copyText(text) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }
  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  document.body.appendChild(textarea);
  textarea.select();
  document.execCommand("copy");
  textarea.remove();
}

export function bindCopyButtons(root = document) {
  for (const button of root.querySelectorAll("[data-symbol]:not([data-copy-bound])")) {
    button.dataset.copyBound = "true";
    button.addEventListener("click", async (event) => {
      event.stopPropagation();
      const symbol = button.dataset.symbol ?? "";
      try {
        await copyText(symbol);
        button.textContent = "已复制";
        setTimeout(() => {
          button.textContent = "复制";
        }, 1200);
      } catch {
        button.textContent = "复制失败";
      }
    });
  }
}
