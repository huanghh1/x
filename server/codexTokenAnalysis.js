const VALID_INTERVALS = new Set(["15m", "1h", "4h", "1d"]);
const TOKEN_PROMPT_TEMPLATES = new Set(["standard"]);
const DEFAULT_CONTEXT_KLINE_LIMIT = 360;
const MAX_CONTEXT_KLINE_LIMIT = 720;

function requestError(message, statusCode = 400) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function cleanSymbol(value) {
  return String(value ?? "").trim().toUpperCase().replace(/[^A-Z0-9_]/g, "");
}

export function normalizeTokenInterval(value) {
  const interval = String(value ?? "1h").trim();
  return VALID_INTERVALS.has(interval) ? interval : "1h";
}

export function normalizeTokenPromptTemplate(value) {
  const template = String(value ?? "standard").trim().toLowerCase();
  return TOKEN_PROMPT_TEMPLATES.has(template) ? template : "standard";
}

function tokenPromptTemplateLabel(template) {
  return "常规看币";
}

function toNumber(value, fallback = null) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function roundNumber(value, digits = 6) {
  const number = Number(value);
  if (!Number.isFinite(number)) return null;
  const factor = 10 ** digits;
  return Math.round(number * factor) / factor;
}

function percentChange(current, previous) {
  const currentNumber = Number(current);
  const previousNumber = Number(previous);
  if (!Number.isFinite(currentNumber) || !Number.isFinite(previousNumber) || previousNumber === 0) return null;
  return roundNumber(((currentNumber - previousNumber) / previousNumber) * 100, 4);
}

function average(values) {
  const numbers = values.map(Number).filter(Number.isFinite);
  if (!numbers.length) return null;
  return numbers.reduce((sum, value) => sum + value, 0) / numbers.length;
}

function pickKline(row = {}) {
  return {
    openTime: toNumber(row.openTime),
    closeTime: toNumber(row.closeTime),
    open: roundNumber(row.open),
    high: roundNumber(row.high),
    low: roundNumber(row.low),
    close: roundNumber(row.close),
    volume: roundNumber(row.volume, 2),
    ma100: roundNumber(row.ma100),
    ma200: roundNumber(row.ma200),
    isOpen: Boolean(row.isOpen),
    gapBefore: Boolean(row.gapBefore)
  };
}

function compareToMa(close, ma) {
  const closeNumber = Number(close);
  const maNumber = Number(ma);
  if (!Number.isFinite(closeNumber) || !Number.isFinite(maNumber) || maNumber === 0) return null;
  return {
    value: roundNumber(maNumber),
    distancePct: percentChange(closeNumber, maNumber),
    side: closeNumber >= maNumber ? "above" : "below"
  };
}

function lookbackChange(rows, bars) {
  if (rows.length <= bars) return null;
  const last = rows.at(-1);
  const previous = rows.at(-(bars + 1));
  return {
    bars,
    changePct: percentChange(last?.close, previous?.close),
    fromClose: roundNumber(previous?.close),
    toClose: roundNumber(last?.close)
  };
}

function summarizeKlines(klines = []) {
  const rows = klines.map(pickKline).filter((row) => Number.isFinite(row.close));
  const last = rows.at(-1) ?? null;
  const previous = rows.at(-2) ?? null;
  const recentWindow = rows.slice(-Math.min(100, rows.length));
  const highs = recentWindow.map((row) => row.high).filter(Number.isFinite);
  const lows = recentWindow.map((row) => row.low).filter(Number.isFinite);
  const high100 = highs.length ? Math.max(...highs) : null;
  const low100 = lows.length ? Math.min(...lows) : null;
  const volumes20 = rows.slice(-20).map((row) => row.volume);
  const previousVolumes20 = rows.slice(-40, -20).map((row) => row.volume);
  const averageVolume20 = average(volumes20);
  const previousAverageVolume20 = average(previousVolumes20);
  return {
    bars: rows.length,
    last,
    previousClose: roundNumber(previous?.close),
    lastBarChangePct: previous ? percentChange(last?.close, previous.close) : null,
    lookbacks: [4, 20, 50, 100, 200].map((bars) => lookbackChange(rows, bars)).filter(Boolean),
    range100: {
      high: roundNumber(high100),
      low: roundNumber(low100),
      closeVsHighPct: high100 ? percentChange(last?.close, high100) : null,
      closeVsLowPct: low100 ? percentChange(last?.close, low100) : null
    },
    movingAverages: {
      ma100: compareToMa(last?.close, last?.ma100),
      ma200: compareToMa(last?.close, last?.ma200),
      maSpreadPct: percentChange(last?.ma100, last?.ma200)
    },
    volume: {
      last: roundNumber(last?.volume, 2),
      average20: roundNumber(averageVolume20, 2),
      average20ChangePct: previousAverageVolume20 ? percentChange(averageVolume20, previousAverageVolume20) : null
    }
  };
}

function sanitizeContext(value, depth = 0) {
  if (value === null || value === undefined) return null;
  if (depth > 4) return null;
  if (typeof value === "string") return value.slice(0, 300);
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "boolean") return value;
  if (Array.isArray(value)) return value.slice(0, 24).map((item) => sanitizeContext(item, depth + 1)).filter((item) => item !== null);
  if (typeof value !== "object") return null;
  const output = {};
  for (const [key, item] of Object.entries(value).slice(0, 36)) {
    const safeKey = String(key).replace(/[^a-zA-Z0-9_ -]/g, "").slice(0, 48);
    if (!safeKey) continue;
    const safeValue = sanitizeContext(item, depth + 1);
    if (safeValue !== null) output[safeKey] = safeValue;
  }
  return output;
}

function normalizeContextKlineLimit(value) {
  const requestedLimit = Number(value);
  const rawLimit = Number.isFinite(requestedLimit) && requestedLimit > 0
    ? requestedLimit
    : DEFAULT_CONTEXT_KLINE_LIMIT;
  return Math.max(24, Math.min(MAX_CONTEXT_KLINE_LIMIT, Math.floor(rawLimit)));
}

function tokenDataBlock(report) {
  return [
    "",
    "<token_data_json>",
    JSON.stringify(report, null, 2),
    "</token_data_json>"
  ];
}

function standardTokenPrompt(report) {
  return [
    "你是我的代币执行研判助理，目标是判断这个币当前更适合试多、试空、等待确认还是放弃；你不是交易复盘教练。只根据下面 JSON 里的本系统监控数据看技术面和资金面；不要联网，不要做外部资讯检索，不要读取本地文件，不要执行命令，不要索要或猜测任何 API Key/Secret。",
    "用中文回答，语气直接、果断、像在帮我盘前快速做交易决策。证据强时可以明确写“试多/试空/等待突破/暂时放弃”，也可以写“可以执行”；不要保证收益，不要把 JSON 没有的数据当事实，不要脑补外部催化。",
    "重点看：当前价格相对 MA100/MA200 的位置、全量 K 线里的趋势位置、近几段涨跌、区间高低点、成交量变化、数据质量，以及页面上下文里的均线/OI/资金费/热度/关注池信号。",
    "如果技术形态、量能、OI/资金费、热度等系统内信号互相确认，要给出清晰执行方向；如果证据不足或信号冲突，要直接说不执行，并说明还差什么确认。短线异动必须写清楚确认条件和失效条件。",
    "请按这个格式输出，不要扩成长篇报告：",
    "执行结论：1-3 句话，必须明确写试多、试空、等待确认或暂时放弃；说明当前更像强势、弱势、震荡、异动待确认还是证据不足，并给出低/中/高置信度。",
    "关键证据：列 2-4 条，必须引用 JSON 中的具体数据，例如价格、MA100/MA200 距离、近几段涨跌幅、成交量、OI、资金费、热度或关注池信号。",
    "执行条件：给 1-3 条可执行条件，包含触发条件、失效条件和风控位置，例如站稳哪个均线、放量突破哪个价位、跌破哪里就不做或止损；如果不执行，也写等待什么条件。",
    "风险点：列 1-3 条，只写数据里真实存在的风险，例如追高、跌破均线、量能不足、OI过热、资金费异常、K线缺口或历史不足。",
    ...tokenDataBlock(report)
  ].join("\n");
}

function buildTokenPrompt(report, promptTemplate) {
  return standardTokenPrompt(report);
}

export function prepareCodexTokenAnalysis({ symbol, intervalCode, klinePayload, context, contextKlineLimit, promptTemplate } = {}) {
  const safeSymbol = cleanSymbol(symbol || klinePayload?.symbol);
  const safeInterval = normalizeTokenInterval(intervalCode || klinePayload?.intervalCode);
  const safePromptTemplate = normalizeTokenPromptTemplate(promptTemplate);
  const klines = Array.isArray(klinePayload?.klines) ? klinePayload.klines : [];
  if (!safeSymbol) throw requestError("symbol is required");
  if (!klines.length) throw requestError(`当前没有 ${safeSymbol} ${safeInterval} 的 K 线缓存，先展开图表或等待抓取完成。`, 404);

  const limit = Math.min(klines.length, normalizeContextKlineLimit(contextKlineLimit));
  const recentKlines = klines.slice(-limit).map(pickKline);
  const report = {
    title: `代币图表分析：${safeSymbol} · ${safeInterval}`,
    scope: "token",
    generatedAt: new Date().toISOString(),
    symbol: safeSymbol,
    intervalCode: safeInterval,
    promptTemplate: safePromptTemplate,
    promptTemplateLabel: tokenPromptTemplateLabel(safePromptTemplate),
    dataQuality: {
      cachedCount: klinePayload?.cachedCount ?? klines.length,
      expectedCount: klinePayload?.expectedCount ?? null,
      coveragePercent: klinePayload?.coveragePercent ?? null,
      hasMa200: Boolean(klinePayload?.hasMa200),
      needsRefresh: Boolean(klinePayload?.needsRefresh),
      refreshReason: klinePayload?.refreshReason ?? null,
      isStale: Boolean(klinePayload?.isStale),
      naturalHistoryShortfall: Boolean(klinePayload?.naturalHistoryShortfall),
      gapCount: klinePayload?.gapCount ?? 0,
      missingKlineCount: klinePayload?.missingKlineCount ?? 0
    },
    summary: summarizeKlines(klines),
    pageContext: sanitizeContext(context),
    recentKlinesReturned: recentKlines.length,
    recentKlines
  };

  return { prompt: buildTokenPrompt(report, safePromptTemplate), report };
}
