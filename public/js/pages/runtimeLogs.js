import { api } from "../api.js";
import { state } from "../state.js";
import { $, escapeHtml, setText } from "../utils/dom.js";
import { crawlerDetailText, crawlerMetaText, formatBytes, formatTime } from "../utils/format.js";

function serviceRuntimeSummary(service, payload) {
  if (!payload) return { ok: false, title: service, meta: "未返回状态", detail: "" };
  if (payload.ok === false) {
    return { ok: false, title: service, meta: "不可达", detail: payload.error || "服务未响应" };
  }
  if (service === "crawler") {
    const crawler = payload.crawler ?? {};
    return {
      ok: !crawler.lastError,
      title: "crawler",
      meta: crawlerMetaText(crawler),
      detail: crawlerDetailText(crawler)
    };
  }
  if (service === "realtime") {
    const realtime = payload.watchRealtime ?? {};
    return {
      ok: !realtime.lastError && Boolean(realtime.connected),
      title: "realtime",
      meta: realtime.connected ? `已连接 · ${realtime.streamCount || 0} streams` : "未连接",
      detail: realtime.lastError || `最近消息 ${formatTime(realtime.lastMessageAt)}`
    };
  }
  const scheduler = payload;
  const errors = [
    scheduler.maintenance?.lastError,
    scheduler.maintenance?.runtimeLogCleanup?.lastError,
    scheduler.fundingMonitor?.lastError,
    scheduler.openInterestMonitor?.lastError,
    ...(scheduler.openInterestMonitor?.errors ?? []),
    ...(scheduler.tokenUnlock?.errors ?? []),
    scheduler.telegramBot?.lastError
  ].filter(Boolean);
  return {
    ok: errors.length === 0,
    title: "scheduler",
    meta: `OI ${scheduler.openInterestMonitor?.running ? "扫描中" : "等待"} · 资金费率 ${scheduler.fundingMonitor?.running ? "扫描中" : "等待"}`,
    detail: errors[0] || "正常"
  };
}

export async function loadRuntimeLogs() {
  state.runtimeLogsLoading = true;
  state.runtimeLogsError = "";
  renderRuntimeLogs();
  try {
    const payload = await api("/api/runtime-logs?limit=160");
    state.runtimeLogs = payload.entries || [];
    state.runtimeLogFiles = payload.files || [];
    state.runtimeStateErrors = payload.stateErrors || [];
    state.runtimeServices = payload.services || null;
    state.runtimeLogsGeneratedAt = payload.generatedAt || null;
    state.selectedRuntimeLogIds = new Set(
      Array.from(state.selectedRuntimeLogIds).filter((id) => state.runtimeLogs.some((item) => runtimeLogId(item) === id))
    );
  } catch (error) {
    state.runtimeLogsError = error instanceof Error ? error.message : String(error);
  } finally {
    state.runtimeLogsLoading = false;
    renderRuntimeLogs();
  }
}

export function runtimeLogId(item) {
  return String(item.id ?? `${item.source || "state"}:${item.service || ""}:${item.component || ""}:${item.file || ""}:${item.message || ""}`);
}

function updateRuntimeLogSelectionUi() {
  const selectedRows = state.runtimeLogs.filter((item) => state.selectedRuntimeLogIds.has(runtimeLogId(item)));
  const deletableRows = state.runtimeLogs.filter((item) => item.source === "pm2" && item.file);
  const selectedDeletable = selectedRows.filter((item) => item.source === "pm2" && item.file);
  setText("#selectedRuntimeLogCount", `已选 ${state.selectedRuntimeLogIds.size} 条，可删除 ${selectedDeletable.length} 条`);
  const deleteButton = $("#deleteSelectedRuntimeLogsBtn");
  if (deleteButton) deleteButton.disabled = selectedDeletable.length === 0;
  const selectAll = $("#selectAllRuntimeLogs");
  if (selectAll) {
    const visibleIds = deletableRows.map(runtimeLogId);
    selectAll.checked = visibleIds.length > 0 && visibleIds.every((id) => state.selectedRuntimeLogIds.has(id));
    selectAll.indeterminate = visibleIds.some((id) => state.selectedRuntimeLogIds.has(id)) && !selectAll.checked;
  }
}

function bindRuntimeLogSelection() {
  document.querySelectorAll("[data-runtime-log-id]").forEach((input) => {
    input.addEventListener("change", () => {
      const id = input.dataset.runtimeLogId;
      if (input.checked) state.selectedRuntimeLogIds.add(id);
      else state.selectedRuntimeLogIds.delete(id);
      updateRuntimeLogSelectionUi();
    });
  });
  updateRuntimeLogSelectionUi();
}

export function selectedRuntimeLogFiles() {
  return Array.from(new Set(
    state.runtimeLogs
      .filter((item) => state.selectedRuntimeLogIds.has(runtimeLogId(item)))
      .filter((item) => item.source === "pm2" && item.file)
      .map((item) => item.file)
  ));
}

export async function deleteRuntimeLogs(files = []) {
  const body = files.length ? JSON.stringify({ files }) : "{}";
  try {
    const result = await api("/api/runtime-logs", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body
    });
    state.runtimeLogsNotice = `已清空 ${result.truncatedCount ?? 0}/${result.fileCount ?? 0} 个日志文件，释放 ${formatBytes(result.truncatedBytes)}`;
    state.selectedRuntimeLogIds.clear();
    await loadRuntimeLogs();
  } catch (error) {
    state.runtimeLogsError = `删除失败：${error instanceof Error ? error.message : String(error)}`;
    renderRuntimeLogs();
  }
}

export function renderRuntimeLogs() {
  const cardTarget = $("#runtimeServiceCards");
  const rowTarget = $("#runtimeLogRows");
  if (!cardTarget || !rowTarget) return;

  const services = state.runtimeServices ?? {};
  const summaries = ["crawler", "realtime", "scheduler"].map((service) => serviceRuntimeSummary(service, services[service]));
  cardTarget.innerHTML = summaries
    .map((item) => `
      <article class="runtime-service-card ${item.ok ? "is-ok" : "is-error"}">
        <span>${escapeHtml(item.title)}</span>
        <strong>${escapeHtml(item.ok ? "正常" : "异常")}</strong>
        <p>${escapeHtml(item.meta)}</p>
        <small title="${escapeHtml(item.detail)}">${escapeHtml(item.detail)}</small>
      </article>
    `)
    .join("");

  const statusParts = [];
  if (state.runtimeLogsLoading) statusParts.push("刷新中");
  if (state.runtimeLogsGeneratedAt) statusParts.push(`更新时间 ${formatTime(state.runtimeLogsGeneratedAt)}`);
  if (state.runtimeLogsNotice) statusParts.push(state.runtimeLogsNotice);
  statusParts.push(`${state.runtimeLogs.length} 条日志`);
  const categoryCounts = runtimeLogCategoryCounts(state.runtimeLogs);
  if (categoryCounts.length) {
    statusParts.push(categoryCounts.map(({ label, count }) => `${label} ${count}`).join(" / "));
  }
  const currentErrorCount = state.runtimeStateErrors.filter((item) => item.severity === "ERROR").length;
  const currentWarnCount = state.runtimeStateErrors.filter((item) => item.severity !== "ERROR").length;
  if (currentErrorCount) statusParts.push(`当前错误 ${currentErrorCount} 条`);
  if (currentWarnCount) statusParts.push(`当前警告 ${currentWarnCount} 条`);
  if (state.runtimeLogsError) statusParts.push(`读取失败：${state.runtimeLogsError}`);
  setText("#runtimeLogsStatus", statusParts.join(" · "));

  if (state.runtimeLogsLoading && !state.runtimeLogs.length) {
    rowTarget.innerHTML = '<tr><td colspan="7" class="empty">正在读取运行日志。</td></tr>';
    updateRuntimeLogSelectionUi();
    return;
  }
  if (state.runtimeLogsError && !state.runtimeLogs.length) {
    rowTarget.innerHTML = `<tr><td colspan="7" class="empty">${escapeHtml(state.runtimeLogsError)}</td></tr>`;
    updateRuntimeLogSelectionUi();
    return;
  }
  if (!state.runtimeLogs.length) {
    rowTarget.innerHTML = '<tr><td colspan="7" class="empty">最近没有错误日志。</td></tr>';
    updateRuntimeLogSelectionUi();
    return;
  }

  rowTarget.innerHTML = state.runtimeLogs
    .map((item) => {
      const detail = item.details ? `<details class="runtime-log-details"><summary>${escapeHtml(item.message || "--")}</summary><pre>${escapeHtml(item.details)}</pre></details>` : escapeHtml(item.message || "--");
      const id = runtimeLogId(item);
      const deletable = item.source === "pm2" && item.file;
      return `
        <tr class="${item.severity === "ERROR" ? "runtime-row-error" : ""}">
          <td>${
            deletable
              ? `<input type="checkbox" data-runtime-log-id="${escapeHtml(id)}" ${state.selectedRuntimeLogIds.has(id) ? "checked" : ""} />`
              : `<span class="runtime-not-deletable" title="当前状态错误来自服务内存状态，不能按日志文件删除">--</span>`
          }</td>
          <td>${escapeHtml(item.source || "--")}</td>
          <td><span class="runtime-category category-${escapeHtml(item.category || "OTHER")}">${escapeHtml(item.categoryLabel || runtimeCategoryLabel(item.category))}</span></td>
          <td><span class="runtime-severity ${item.severity === "ERROR" ? "is-error" : "is-warn"}">${escapeHtml(item.severity || "WARN")}</span></td>
          <td>${escapeHtml([item.service, item.component].filter(Boolean).join(" / ") || "--")}</td>
          <td>${formatTime(item.updatedAt)}</td>
          <td class="runtime-message">${detail}</td>
        </tr>
      `;
    })
    .join("");
  bindRuntimeLogSelection();
}

function runtimeCategoryLabel(category) {
  return {
    NETWORK: "网络连接",
    BINANCE_LIMIT: "Binance限频",
    BINANCE_HTTP: "Binance接口",
    TELEGRAM: "Telegram",
    DATABASE: "数据库",
    OI: "OI监控",
    FUNDING: "资金费率",
    KLINE: "K线抓取",
    PROGRAM: "程序异常",
    OTHER: "其他"
  }[category] ?? "其他";
}

function runtimeLogCategoryCounts(items) {
  const counts = new Map();
  for (const item of items) {
    const key = item.category || "OTHER";
    const current = counts.get(key) ?? { key, label: item.categoryLabel || runtimeCategoryLabel(key), count: 0 };
    current.count += 1;
    counts.set(key, current);
  }
  const order = ["NETWORK", "BINANCE_LIMIT", "BINANCE_HTTP", "DATABASE", "TELEGRAM", "OI", "FUNDING", "KLINE", "PROGRAM", "OTHER"];
  return Array.from(counts.values()).sort((a, b) => order.indexOf(a.key) - order.indexOf(b.key));
}
