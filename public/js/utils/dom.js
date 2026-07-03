export const $ = (selector) => document.querySelector(selector);

export function closestElement(target, selector) {
  return target instanceof Element ? target.closest(selector) : null;
}

export function setText(selector, value) {
  const element = $(selector);
  if (element) element.textContent = value;
}

export function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}
