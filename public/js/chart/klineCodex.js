import { api } from "../api.js";
import {
  TOKEN_CODEX_PROMPT_TEMPLATE,
  normalizeTokenCodexTemplate,
  tokenCodexTemplateLabel
} from "../constants.js";
import { state } from "../state.js";
import { escapeHtml } from "../utils/dom.js";
import {
  formatNumber,
  formatTime,
  oiChangeSummary
} from "../utils/format.js";

let signalProfileResolver = () => ({ label: "观察" });
let rerenderChart = async () => {};

export function configureKlineCodex({ signalProfile, renderChart } = {}) {
  if (typeof signalProfile === "function") signalProfileResolver = signalProfile;
  if (typeof renderChart === "function") rerenderChart = renderChart;
}

export function tokenCodexKey(symbol, intervalCode, promptTemplate = state.tokenCodexTemplate) {
  return `${String(symbol ?? "").toUpperCase()}|${intervalCode || "1h"}|${normalizeTokenCodexTemplate(promptTemplate)}`;
}

function signalContextForToken(symbol, intervalCode) {
  const row = state.signals.find((item) => String(item.symbol ?? "").toUpperCase() === String(symbol ?? "").toUpperCase());
  if (!row) return null;
  const details = Array.isArray(row.intervalDetails) ? row.intervalDetails : [];
  const selectedDetail = details.find((item) => item.intervalCode === intervalCode) ?? details[0] ?? row;
  const triggered = details
    .filter((item) => ["LEVEL1", "LEVEL2"].includes(item.alertLevel))
    .map((item) => ({
      intervalCode: item.intervalCode,
      alertLevel: item.alertLevel,
      currentPrice: item.currentPrice,
      ma100: item.ma100,
      ma200: item.ma200,
      signalTime: item.signalTime || item.updatedAt
    }));
  return {
    categoryLabel: row.categoryLabel,
    bestAlertLevel: row.bestAlertLevel || row.alertLevel,
    profile: signalProfileResolver(row).label,
    multiMatchCount: row.multiMatchCount,
    hotRankHit: Boolean(Number(row.hotRankHit ?? 0)),
    fundingOneHour: Boolean(row.fundingOneHour),
    oiMatched: Boolean(row.oiMatched ?? row.oiSpikeHit),
    oiChange: oiChangeSummary(row),
    selectedInterval: selectedDetail.intervalCode || intervalCode,
    selectedPrice: selectedDetail.currentPrice,
    selectedMa100: selectedDetail.ma100,
    selectedMa200: selectedDetail.ma200,
    triggered
  };
}

export function buildYokaiResearchPrompt(symbol, intervalCode) {
  const safeSymbol = String(symbol ?? "").trim().toUpperCase() || "当前交易对";
  const baseAsset = safeSymbol.replace(/USDT$/, "") || safeSymbol;
  return [
    `请帮我对 ${safeSymbol}（base asset: ${baseAsset}）做一次“妖币 / 庄控风险”排查。`,
    "",
    "先确认币种身份：看看是否上了币安alpha和币安合约，却没有上币安现货的，检查其他主流平台有没有也上了现货",
    "",
    "核心检查维度：",
    "1. 筹码集中：Top10 holder 占比、Top holder 类型、是否需要排除 CEX 热钱包、LP、staking、bridge、项目锁仓或做市地址。",
    "2. Bundler / 机器人 / 同源钱包：部署者、早期买入钱包、同秒注资、同源资金、批量钱包痕迹；查不到就写缺失。",
    "3. OI/MCap：合约 OI value 与市值或流通市值的比例；OI/MCap > 3x 属于高风险信号。",
    "4. Vol/OI：成交额相对 OI 的异常程度；Vol/OI > 20x 时要警惕刷量或高频对倒。",
    "5. 资金费率陷阱：持续深度负费率 < -0.05% 且价格抗跌/OI 上升，偏诱空或挤压蓄力；费率转正后要观察是否出货。",
    "6. 订单簿结构：Bid-Ask 是否失衡、Ask 是否变薄、拉盘前上方卖压是否被快速吃掉；没有盘口数据就写缺失。",
    "7. wallet -> CEX：项目方、早期大户或异常钱包是否向 CEX 转入；没有地址标签或转账证据就写缺失。",
    "8. 价格结构：是否处在区间底部、横盘吸筹、挤压蓄力、快速拉高、急跌出货或双向收割阶段。",
    "",
    "评分权重：筹码集中 25 分，资金费率异常 20 分，OI/MCap 异常 15 分，Vol/OI 刷量嫌疑 15 分，价格接近区间底部或挤压蓄力位置 10 分，Bundler/机器人/同源钱包 10 分，订单簿结构 5 分，总分 0-100。",
    "",
    "操盘模式识别：",
    "- 挤压式：建仓 -> 诱饵拉盘 -> 深度负费率引空 -> 挤压爆空 -> 反手做空。",
    "- 拉盘砸盘式：无充分横盘 -> 机器人钱包同秒注资 -> 急拉 ATH -> 快速崩盘。",
    "- 一鱼双吃：慢磨吞 Ask -> 空平多追 -> 一针砸盘 -> 双向收割。",
    "没有对应证据就写不成立。",
    "",
    "请按这个格式输出，不要扩成长篇报告：",
    "妖币/庄控结论：给 0-100 分；写风险等级低/中/高；写当前阶段：建仓、诱空、挤压、出货或不成立；用 1-3 句话说明。",
    "证据链：列 2-5 条，必须引用具体数据和来源链接/来源名称。",
    "反证与缺失：列真实反证和缺失数据，尤其是 Top10、Bundler、Alpha/Futures、链、MCap、订单簿、wallet->CEX。",
    "操盘模式：判断更像挤压式、拉盘砸盘式、一鱼双吃或不成立；说明触发下一阶段还差什么确认。",
    "退出/警戒信号：检查费率转正、OI 跌价涨、大额 wallet->CEX、价格放量失守关键位；没有数据就写缺失。",
    "执行建议：明确写试多、试空、等待确认或暂时放弃；给 1-3 条触发条件、失效条件和风控位置。"
  ].join("\n");
}

function tokenCodexContext(symbol, intervalCode) {
  const safeSymbol = String(symbol ?? "").toUpperCase();
  const funding = state.fundingTokens.find((item) => String(item.symbol ?? "").toUpperCase() === safeSymbol);
  const oi = state.ioData.find((item) => String(item.symbol ?? "").toUpperCase() === safeSymbol);
  const watch = state.watchlist.find((item) => String(item.symbol ?? "").toUpperCase() === safeSymbol);
  const signal = signalContextForToken(safeSymbol, intervalCode);
  return {
    chartInterval: intervalCode,
    page: state.currentView,
    signal,
    funding: funding
      ? {
          currentFundingRate: funding.currentFundingRate,
          fundingIntervalHours: funding.fundingIntervalHours,
          intervals: funding.intervals,
          multiCycleCount: funding.multiCycleCount,
          hotRank: Boolean(funding.hotRank),
          oiSpike: Boolean(funding.oiSpike),
          lastChangedAt: funding.lastChangedAt || funding.lastSeenAt
        }
      : null,
    openInterest: oi
      ? {
          window: state.ioWindow,
          changePercent: oi.changePercent,
          currentOpenInterest: oi.currentOpenInterest,
          currentOpenInterestValue: oi.currentOpenInterestValue,
          observedAt: oi.observedAt,
          isStale: Boolean(oi.isStale),
          matches: {
            hotRankHit: Boolean(oi.hotRankHit),
            fundingOneHour: Boolean(oi.fundingOneHour),
            multiCycleCount: oi.multiCycleCount
          }
        }
      : null,
    watchlist: watch
      ? {
          note: watch.note,
          alertEnabled: Boolean(watch.alertEnabled),
          alertAbove: watch.alertAbove,
          alertBelow: watch.alertBelow,
          latestInterval: watch.latestInterval,
          unlockStatus: watch.unlockStatus,
          nextUnlockAt: watch.nextUnlockAt
        }
      : null
  };
}

export function tokenCodexPanelHtml(symbol, intervalCode, promptTemplate = state.tokenCodexTemplate) {
  const safeTemplate = normalizeTokenCodexTemplate(promptTemplate);
  const key = tokenCodexKey(symbol, intervalCode, safeTemplate);
  const entry = state.tokenCodex.get(key);
  if (!entry) return "";
  const templateLabel = tokenCodexTemplateLabel(safeTemplate);
  const status = entry.loading
    ? "分析中"
    : entry.error
      ? "失败"
      : entry.result?.generatedAt
        ? `完成 ${formatTime(entry.result.generatedAt)}`
        : "等待";
  const content = entry.loading
    ? "Codex 正在结合当前 K 线和页面信号分析这个币，请稍等。"
    : entry.error
      ? entry.error
      : entry.result?.analysis || "暂无分析结果。";
  return `
    <section class="chart-codex-panel ${entry.error ? "is-error" : ""}" data-token-codex-panel="${escapeHtml(key)}">
      <div class="chart-codex-head">
        <strong>Codex 看币 · ${escapeHtml(templateLabel)}</strong>
        <span>${escapeHtml(status)}</span>
      </div>
      <pre>${escapeHtml(content)}</pre>
    </section>
  `;
}

export async function runTokenCodexAnalysis(symbol, intervalCode) {
  const safeSymbol = String(symbol ?? "").toUpperCase();
  const safeInterval = intervalCode || "1h";
  const safeTemplate = TOKEN_CODEX_PROMPT_TEMPLATE;
  if (!safeSymbol) return;
  const key = tokenCodexKey(safeSymbol, safeInterval, safeTemplate);
  const requestId = Number(state.tokenCodex.get(key)?.requestId ?? 0) + 1;
  state.tokenCodex.set(key, {
    loading: true,
    error: "",
    result: null,
    requestId
  });
  await rerenderChart({ symbol: safeSymbol, intervalCode: safeInterval });
  try {
    const payload = await api("/api/token-analysis/codex", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        symbol: safeSymbol,
        intervalCode: safeInterval,
        promptTemplate: safeTemplate,
        context: tokenCodexContext(safeSymbol, safeInterval)
      })
    });
    if (state.tokenCodex.get(key)?.requestId !== requestId) return;
    state.tokenCodex.set(key, {
      loading: false,
      error: "",
      result: payload,
      requestId
    });
  } catch (error) {
    if (state.tokenCodex.get(key)?.requestId !== requestId) return;
    state.tokenCodex.set(key, {
      loading: false,
      error: error instanceof Error ? error.message : String(error),
      result: null,
      requestId
    });
  } finally {
    if (state.tokenCodex.get(key)?.requestId === requestId) {
      await rerenderChart({ symbol: safeSymbol, intervalCode: safeInterval });
    }
  }
}
