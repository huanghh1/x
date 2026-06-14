function addUtcMonths(value, months) {
  const date = new Date(value);
  const day = date.getUTCDate();
  date.setUTCDate(1);
  date.setUTCMonth(date.getUTCMonth() + months);
  const lastDay = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate();
  date.setUTCDate(Math.min(day, lastDay));
  return date;
}

const PLANS = {
  ZEST: {
    expectedName: "Zest Protocol",
    sourceUrl: "https://x.com/ZestProtocol/status/2054951676499665041",
    events: [
      {
        monthsAfterTge: 4,
        amount: 3_000_000,
        percent: 0.3,
        note: "Season 1 积分持有者第 4 个月可领取"
      },
      {
        monthsAfterTge: 5,
        amount: 3_000_000,
        percent: 0.3,
        note: "Season 1 积分持有者第 5 个月可领取"
      },
      {
        monthsAfterTge: 6,
        amount: 3_000_000,
        percent: 0.3,
        note: "Season 1 积分持有者第 6 个月可领取"
      },
      {
        monthsAfterTge: 12,
        amount: null,
        percent: null,
        note: "团队与投资者一年锁定期结束，开始三年线性释放"
      }
    ],
    undatedNote: "其余社区份额及团队、投资者份额按官方计划线性释放，部分后续批次未公布精确日期"
  },
  ELSA: {
    expectedName: "HeyElsa",
    sourceUrl: "https://docs.heyelsa.ai/elsa-white-paper/heyelsa-mica-whitepaper",
    events: [
      {
        monthsAfterTge: 10,
        amount: null,
        percent: null,
        note: "Elsa AI Ltd 的 10 个月 cliff 结束，34.49% 配额开始 24 个月线性释放"
      },
      {
        monthsAfterTge: 12,
        amount: null,
        percent: null,
        note: "团队、Pre-seed 与 Seed 的 12 个月 cliff 结束，开始 24 个月线性释放"
      }
    ],
    undatedNote: "社区配额自 TGE 后持续进行 48 个月线性释放"
  },
  FOLKS: {
    expectedName: "Folks Finance",
    sourceUrl: "https://docs.folks.finance/folks-token/tokenomics",
    events: [],
    undatedNote: "官方仅披露投资者、团队和顾问按 12 至 30 个月锁定及线性释放，未公布下一笔精确日期"
  }
};

export function resolveOfficialUnlock(alphaToken, now = Date.now()) {
  const symbol = String(alphaToken?.symbol ?? "").toUpperCase();
  const plan = PLANS[symbol];
  if (!plan) return null;
  if (String(alphaToken?.name ?? "") !== plan.expectedName) {
    throw new Error(`${symbol} 的币安项目名称不匹配`);
  }

  const tge = new Date(Number(alphaToken.listingTime));
  if (Number.isNaN(tge.getTime())) throw new Error(`${symbol} 缺少币安上线时间`);
  const events = plan.events
    .map((event) => ({ ...event, date: addUtcMonths(tge, event.monthsAfterTge) }))
    .filter((event) => event.date.getTime() > Number(now))
    .sort((a, b) => a.date - b.date);
  const next = events[0] ?? null;

  return {
    provider: "binance+official",
    sourceUrl: plan.sourceUrl,
    status: next ? "available" : "undated",
    nextUnlockAt: next?.date ?? null,
    unlockAmount: next?.amount ?? null,
    unlockPercent: next?.percent ?? null,
    error: next?.note ?? plan.undatedNote,
    rawPayload: {
      binance: {
        name: alphaToken.name,
        symbol,
        chainId: alphaToken.chainId,
        contractAddress: alphaToken.contractAddress,
        listingTime: tge.toISOString()
      },
      nextEvent: next
        ? {
            date: next.date.toISOString(),
            amount: next.amount,
            percent: next.percent,
            note: next.note
          }
        : null,
      note: plan.undatedNote
    }
  };
}
