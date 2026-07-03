import { closestElement, escapeHtml } from "../utils/dom.js";

const CUSTOM_SELECT_EXCLUDED_SELECTOR = [
  "#mobilePageSelect",
  "#signals select",
  "[data-page-section='signals'] select",
  "select[data-native-select]"
].join(", ");

function shouldEnhanceCustomSelect(select) {
  return select instanceof HTMLSelectElement && !select.matches(CUSTOM_SELECT_EXCLUDED_SELECTOR);
}

function customSelectLabelText(select) {
  const ariaLabel = String(select.getAttribute("aria-label") ?? "").trim();
  if (ariaLabel) return ariaLabel;
  const labelledBy = String(select.getAttribute("aria-labelledby") ?? "").trim();
  if (labelledBy) {
    const text = labelledBy
      .split(/\s+/)
      .map((id) => document.getElementById(id)?.textContent?.trim() ?? "")
      .filter(Boolean)
      .join(" ");
    if (text) return text;
  }
  const parentLabel = select.closest("label");
  if (parentLabel) {
    const text = Array.from(parentLabel.childNodes)
      .filter((node) => node !== select && !(node instanceof HTMLElement && node.dataset.customSelectFor))
      .map((node) => node.textContent?.trim() ?? "")
      .filter(Boolean)
      .join(" ");
    if (text) return text;
  }
  const previous = select.previousElementSibling;
  if (previous?.textContent?.trim()) return previous.textContent.trim();
  return "选择";
}

function customSelectBaseId(select) {
  if (!select.id) select.id = `customSelect${Math.random().toString(36).slice(2, 9)}`;
  return select.id;
}

function customSelectOptionGroups(select) {
  const groups = [];
  let looseOptions = [];
  for (const child of select.children) {
    if (child instanceof HTMLOptGroupElement) {
      if (looseOptions.length) {
        groups.push({ label: "", options: looseOptions });
        looseOptions = [];
      }
      groups.push({
        label: child.label || "",
        options: Array.from(child.children).filter((item) => item instanceof HTMLOptionElement)
      });
      continue;
    }
    if (child instanceof HTMLOptionElement) looseOptions.push(child);
  }
  if (looseOptions.length) groups.push({ label: "", options: looseOptions });
  return groups.filter((group) => group.options.length);
}

function firstEnabledCustomOption(select) {
  return Array.from(select.options).find((option) => !option.disabled) ?? null;
}

function customSelectActiveOption(select) {
  const value = select.dataset.customSelectActiveValue ?? select.value;
  return Array.from(select.options).find((option) => option.value === value && !option.disabled) ?? firstEnabledCustomOption(select);
}

function setCustomSelectOpen(select, open) {
  const wrapper = select.nextElementSibling?.dataset.customSelectFor === select.id ? select.nextElementSibling : null;
  if (!wrapper) return;
  const canOpen = !select.disabled && Array.from(select.options).some((option) => !option.disabled);
  wrapper.dataset.open = open && canOpen ? "true" : "false";
  if (wrapper.dataset.open === "true") {
    select.dataset.customSelectActiveValue = select.value || customSelectActiveOption(select)?.value || "";
  }
  renderCustomSelect(select);
}

function closeAllCustomSelects(exceptSelect = null) {
  document.querySelectorAll("select[data-custom-select-enhanced='true']").forEach((select) => {
    if (select === exceptSelect) return;
    const wrapper = select.nextElementSibling?.dataset.customSelectFor === select.id ? select.nextElementSibling : null;
    if (wrapper) wrapper.dataset.open = "false";
    renderCustomSelect(select);
  });
}

function moveCustomSelectActive(select, delta) {
  const enabled = Array.from(select.options).filter((option) => !option.disabled);
  if (!enabled.length) return;
  const current = customSelectActiveOption(select);
  const currentIndex = Math.max(0, enabled.indexOf(current));
  const next = enabled[(currentIndex + delta + enabled.length) % enabled.length];
  select.dataset.customSelectActiveValue = next.value;
  setCustomSelectOpen(select, true);
}

function commitCustomSelectValue(select, value) {
  const option = Array.from(select.options).find((item) => item.value === value && !item.disabled);
  if (!option) return;
  select.value = option.value;
  select.dataset.customSelectActiveValue = option.value;
  setCustomSelectOpen(select, false);
  renderCustomSelect(select);
  select.dispatchEvent(new Event("change", { bubbles: true }));
}

function customSelectOptionHtml(select, option, index) {
  const selected = option.value === select.value;
  const active = option.value === customSelectActiveOption(select)?.value;
  const disabled = option.disabled;
  return `
    <div
      id="${escapeHtml(customSelectBaseId(select))}CustomOption${index}"
      class="trade-journal-source-option${selected ? " is-selected" : ""}${active ? " is-active" : ""}${disabled ? " is-disabled" : ""}"
      role="option"
      aria-selected="${selected ? "true" : "false"}"
      aria-disabled="${disabled ? "true" : "false"}"
      data-custom-select-value="${escapeHtml(option.value)}"
      data-active="${active ? "true" : "false"}"
    >
      <span>${escapeHtml(option.textContent?.trim() || option.label || option.value || "--")}</span>
    </div>
  `;
}

function renderCustomSelect(select) {
  if (!shouldEnhanceCustomSelect(select)) return;
  const wrapper = select.nextElementSibling?.dataset.customSelectFor === select.id ? select.nextElementSibling : null;
  if (!wrapper) return;
  const button = wrapper.querySelector("[data-custom-select-button]");
  const text = wrapper.querySelector("[data-custom-select-text]");
  const list = wrapper.querySelector("[data-custom-select-list]");
  if (!button || !text || !list) return;

  const open = wrapper.dataset.open === "true" && !select.disabled;
  const selected = select.selectedOptions[0];
  const selectedText = selected?.textContent?.trim() || customSelectLabelText(select);
  const active = customSelectActiveOption(select);
  const activeIndex = Array.from(select.options).indexOf(active);
  text.textContent = selectedText;
  button.disabled = select.disabled;
  button.dataset.state = select.disabled ? "disabled" : select.value ? "filled" : "empty";
  button.setAttribute("aria-expanded", String(open));
  if (open && activeIndex >= 0) {
    button.setAttribute("aria-activedescendant", `${customSelectBaseId(select)}CustomOption${activeIndex}`);
  } else {
    button.removeAttribute("aria-activedescendant");
  }

  let optionIndex = 0;
  list.innerHTML = customSelectOptionGroups(select).map((group) => {
    const rows = group.options.map((option) => customSelectOptionHtml(select, option, optionIndex++)).join("");
    return `
      <div class="trade-journal-source-group" role="presentation">
        ${group.label ? `<div class="trade-journal-source-group-label">${escapeHtml(group.label)}</div>` : ""}
        ${rows}
      </div>
    `;
  }).join("");
  list.hidden = !open;
  if (open) {
    requestAnimationFrame(() => {
      list.querySelector('[data-active="true"]')?.scrollIntoView({ block: "nearest" });
    });
  }
}

function enhanceCustomSelect(select) {
  if (!shouldEnhanceCustomSelect(select) || select.dataset.customSelectEnhanced === "true") return;
  const id = customSelectBaseId(select);
  const label = customSelectLabelText(select);
  select.dataset.customSelectEnhanced = "true";
  select.tabIndex = -1;
  select.setAttribute("aria-hidden", "true");

  const wrapper = document.createElement("div");
  wrapper.className = "trade-journal-source-combobox custom-select";
  wrapper.dataset.customSelectFor = id;
  wrapper.dataset.open = "false";
  wrapper.innerHTML = `
    <button
      class="trade-journal-source-button"
      type="button"
      aria-haspopup="listbox"
      aria-expanded="false"
      aria-controls="${escapeHtml(id)}CustomList"
      aria-label="${escapeHtml(label)}"
      data-custom-select-button
    >
      <span data-custom-select-text>${escapeHtml(label)}</span>
      <span class="trade-journal-source-arrow" aria-hidden="true"></span>
    </button>
    <div
      id="${escapeHtml(id)}CustomList"
      class="trade-journal-source-list"
      role="listbox"
      aria-label="${escapeHtml(label)}"
      data-custom-select-list
      hidden
    ></div>
  `;
  select.insertAdjacentElement("afterend", wrapper);

  const button = wrapper.querySelector("[data-custom-select-button]");
  const list = wrapper.querySelector("[data-custom-select-list]");
  button?.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    const willOpen = wrapper.dataset.open !== "true";
    closeAllCustomSelects(select);
    setCustomSelectOpen(select, willOpen);
  });
  button?.addEventListener("keydown", (event) => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      if (wrapper.dataset.open === "true") moveCustomSelectActive(select, 1);
      else setCustomSelectOpen(select, true);
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      if (wrapper.dataset.open === "true") moveCustomSelectActive(select, -1);
      else setCustomSelectOpen(select, true);
      return;
    }
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      if (wrapper.dataset.open === "true") commitCustomSelectValue(select, customSelectActiveOption(select)?.value ?? "");
      else setCustomSelectOpen(select, true);
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      setCustomSelectOpen(select, false);
    }
  });
  list?.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    const option = closestElement(event.target, "[data-custom-select-value]");
    if (!option || option.getAttribute("aria-disabled") === "true") return;
    commitCustomSelectValue(select, option.dataset.customSelectValue ?? "");
    requestAnimationFrame(() => button?.focus());
  });
  list?.addEventListener("pointerdown", (event) => {
    if (event.pointerType && event.pointerType !== "mouse") return;
    event.preventDefault();
    event.stopPropagation();
    const option = closestElement(event.target, "[data-custom-select-value]");
    if (!option || option.getAttribute("aria-disabled") === "true") return;
    commitCustomSelectValue(select, option.dataset.customSelectValue ?? "");
    requestAnimationFrame(() => button?.focus());
  });
  list?.addEventListener("pointerover", (event) => {
    const option = closestElement(event.target, "[data-custom-select-value]");
    if (!option || option.getAttribute("aria-disabled") === "true") return;
    select.dataset.customSelectActiveValue = option.dataset.customSelectValue ?? "";
    list.querySelectorAll("[data-custom-select-value]").forEach((item) => {
      const active = item === option;
      item.classList.toggle("is-active", active);
      item.dataset.active = active ? "true" : "false";
    });
    const activeIndex = Array.from(select.options).findIndex((item) => item.value === select.dataset.customSelectActiveValue);
    if (activeIndex >= 0) button?.setAttribute("aria-activedescendant", `${customSelectBaseId(select)}CustomOption${activeIndex}`);
  });
  document.body.classList.add("has-custom-source-picker", "has-custom-selects");
  renderCustomSelect(select);
}

export function enhanceCustomSelects(root = document) {
  root.querySelectorAll("select").forEach((select) => enhanceCustomSelect(select));
  bindCustomSelectDocumentEvents();
}

export function syncCustomSelect(select) {
  if (!select) return;
  enhanceCustomSelect(select);
  renderCustomSelect(select);
}

export function syncAllCustomSelects() {
  document.querySelectorAll("select[data-custom-select-enhanced='true']").forEach((select) => renderCustomSelect(select));
}

function bindCustomSelectDocumentEvents() {
  if (document.body.dataset.customSelectEventsBound === "true") return;
  document.body.dataset.customSelectEventsBound = "true";
  document.addEventListener("click", (event) => {
    if (closestElement(event.target, "[data-custom-select-for]")) return;
    closeAllCustomSelects();
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") closeAllCustomSelects();
  });
}
