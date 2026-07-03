import { config } from "../config.js";
import { evaluateOpenInterestSpike } from "../openInterestSpike.js";
import { resolveBestAlertLevel, resolveSignalProfile, SIGNAL_PRIORITY } from "../signalPriority.js";
import { getPool } from "./connection.js";
import { baseAssetFromSymbol, sanitizeDbSymbol } from "./symbols.js";

export async function getOverview() {
  const [tokenRows] = await getPool().query(
    `SELECT
      COUNT(*) AS totalTokens,
      SUM(fetch_status='completed') AS cachedTokens,
      SUM(fetch_status<>'completed') AS pendingTokens
     FROM token_list
     WHERE is_active=1`
  );
  const [signalRows] = await getPool().query(
    `SELECT
      SUM(alert_level='LEVEL1') AS level1Signals,
      SUM(alert_level='LEVEL2') AS level2Signals
     FROM signal_result s
     JOIN token_list t ON t.id=s.token_id
     WHERE t.is_active=1`
  );
  const [categoryRows] = await getPool().query(
    `SELECT category_type AS categoryType,
      COUNT(*) AS total,
      SUM(fetch_status='completed') AS cached,
      SUM(fetch_status<>'completed') AS pending
     FROM token_list
     WHERE is_active=1
     GROUP BY category_type`
  );
  const [currentRows] = await getPool().query(
    `SELECT symbol, category_type AS categoryType, fetch_status AS fetchStatus, current_interval AS currentInterval,
      fetched_interval_count AS fetchedIntervalCount, total_interval_count AS totalIntervalCount, updated_at AS updatedAt, last_error AS lastError
     FROM token_list
     WHERE fetch_status='fetching'
       AND is_active=1
     ORDER BY updated_at DESC
     LIMIT 1`
  );
  const [lastRows] = await getPool().query(
    `SELECT MAX(updated_at) AS lastUpdatedAt FROM token_list WHERE is_active=1`
  );
  return {
    totals: {
      totalTokens: Number(tokenRows[0]?.totalTokens ?? 0),
      cachedTokens: Number(tokenRows[0]?.cachedTokens ?? 0),
      pendingTokens: Number(tokenRows[0]?.pendingTokens ?? 0),
      level1Signals: Number(signalRows[0]?.level1Signals ?? 0),
      level2Signals: Number(signalRows[0]?.level2Signals ?? 0)
    },
    categories: categoryRows.map((row) => ({
      categoryType: row.categoryType,
      total: Number(row.total ?? 0),
      cached: Number(row.cached ?? 0),
      pending: Number(row.pending ?? 0)
    })),
    currentFetch: currentRows[0] ?? null,
    lastUpdatedAt: lastRows[0]?.lastUpdatedAt ?? null
  };
}

export async function getSignals(categoryType) {
  const [rows] = await getPool().query(
    `SELECT s.symbol, s.category_type AS categoryType, t.category_label AS categoryLabel,
      s.interval_code AS intervalCode, s.alert_level AS alertLevel, s.ma100, s.ma200,
      s.current_price AS currentPrice, s.proximity_pct AS proximityPct, s.signal_weight AS signalWeight,
      s.signal_status AS signalStatus, s.note, s.signal_time AS signalTime, s.updated_at AS updatedAt
     FROM signal_result s
     JOIN token_list t ON t.id=s.token_id
     WHERE s.category_type=:categoryType
       AND t.is_active=1
     ORDER BY
      CASE s.alert_level WHEN 'LEVEL1' THEN 0 WHEN 'LEVEL2' THEN 1 WHEN 'NONE' THEN 2 ELSE 3 END,
      s.signal_weight DESC,
      s.updated_at DESC`,
    { categoryType }
  );
  return rows;
}

const SIGNAL_CATEGORIES = new Set(["A", "B"]);
const SIGNAL_LEVELS = new Set(["LEVEL1", "LEVEL2", "NONE", "INSUFFICIENT"]);
const SIGNAL_INTERVALS = new Set(["15m", "1h", "4h", "1d"]);

function normalizeList(values, allowedValues) {
  const input = Array.isArray(values) ? values : String(values ?? "").split(",");
  return input.map((item) => String(item).trim()).filter((item) => allowedValues.has(item));
}

function quotedList(values) {
  return values.map((item) => `'${item}'`).join(",");
}

function hotRankActiveSeconds() {
  return Math.max(60, Math.floor(config.hotRank.activeMs / 1000));
}

function openInterestActiveSeconds() {
  return Math.max(60, Math.floor(config.openInterestMonitor.activeMs / 1000));
}

function openInterestSpikeConditionSql(alias = "oi") {
  return `(
    ${alias}.change_5m_pct >= :oiSpike5mPct
    OR ${alias}.change_1h_pct >= :oiSpike1hPct
    OR ${alias}.change_4h_pct >= :oiSpike4hPct
    OR ${alias}.change_1d_pct >= :oiSpike1dPct
  )`;
}

function activeOpenInterestSpikeSql(alias = "oi", activeSecondsParam = "oiActiveSeconds") {
  return `${alias}.observed_at >= DATE_SUB(NOW(3), INTERVAL :${activeSecondsParam} SECOND)
    AND ${openInterestSpikeConditionSql(alias)}`;
}

function openInterestSpikeQueryParams(extra = {}) {
  return {
    oiActiveSeconds: openInterestActiveSeconds(),
    oiSpike5mPct: config.openInterestMonitor.spike5mPct,
    oiSpike1hPct: config.openInterestMonitor.spike1hPct,
    oiSpike4hPct: config.openInterestMonitor.spike4hPct,
    oiSpike1dPct: config.openInterestMonitor.spike1dPct,
    ...extra
  };
}

function hotRankTokenMatchSql(hotAlias, tokenAlias) {
  return `(
    ${hotAlias}.symbol=${tokenAlias}.symbol
    OR ${hotAlias}.base_asset=${tokenAlias}.base_asset
    OR (${tokenAlias}.base_asset LIKE '1000%' AND ${hotAlias}.base_asset=SUBSTRING(${tokenAlias}.base_asset, 5))
    OR (${hotAlias}.base_asset LIKE '1000%' AND ${tokenAlias}.base_asset=SUBSTRING(${hotAlias}.base_asset, 5))
    OR (${tokenAlias}.base_asset LIKE '1000000%' AND ${hotAlias}.base_asset=SUBSTRING(${tokenAlias}.base_asset, 8))
    OR (${hotAlias}.base_asset LIKE '1000000%' AND ${tokenAlias}.base_asset=SUBSTRING(${hotAlias}.base_asset, 8))
  )`;
}

function hotRankHitSql(tokenAlias, activeSecondsParam = "hotRankActiveSeconds") {
  return `EXISTS(
    SELECT 1
    FROM hot_rank_seen h
    WHERE ${hotRankTokenMatchSql("h", tokenAlias)}
      AND h.last_seen_at >= DATE_SUB(NOW(3), INTERVAL :${activeSecondsParam} SECOND)
  )`;
}

function hotRankValueSql(tokenAlias, expression, activeSecondsParam = "hotRankActiveSeconds") {
  return `(
    SELECT ${expression}
    FROM hot_rank_seen h
    WHERE ${hotRankTokenMatchSql("h", tokenAlias)}
      AND h.last_seen_at >= DATE_SUB(NOW(3), INTERVAL :${activeSecondsParam} SECOND)
  )`;
}

function hotRankSignalMatchSql(hotAlias, signalAlias) {
  const baseAsset = `REPLACE(${signalAlias}.symbol, 'USDT', '')`;
  return `(
    ${hotAlias}.symbol=${signalAlias}.symbol
    OR ${hotAlias}.base_asset=${baseAsset}
    OR (${baseAsset} LIKE '1000%' AND ${hotAlias}.base_asset=SUBSTRING(${baseAsset}, 5))
    OR (${hotAlias}.base_asset LIKE '1000%' AND ${baseAsset}=SUBSTRING(${hotAlias}.base_asset, 5))
    OR (${baseAsset} LIKE '1000000%' AND ${hotAlias}.base_asset=SUBSTRING(${baseAsset}, 8))
    OR (${hotAlias}.base_asset LIKE '1000000%' AND ${baseAsset}=SUBSTRING(${hotAlias}.base_asset, 8))
  )`;
}

export async function getSignalGroupsPage({ categories, levels, intervals, page = 1, pageSize = 20 }) {
  const safeCategories = normalizeList(categories, SIGNAL_CATEGORIES);
  const safeLevels = normalizeList(levels, SIGNAL_LEVELS);
  const safeIntervals = normalizeList(intervals, SIGNAL_INTERVALS);
  const safePageSize = Math.max(1, Math.min(100, Number(pageSize) || 20));
  const safePage = Math.max(1, Number(page) || 1);
  if (!safeCategories.length || !safeLevels.length || !safeIntervals.length) {
    return { signals: [], total: 0, page: safePage, pageSize: safePageSize };
  }

  const whereSql = `s.category_type IN (${quotedList(safeCategories)})
    AND s.alert_level IN (${quotedList(safeLevels)})
    AND s.interval_code IN (${quotedList(safeIntervals)})
    AND t.is_active=1`;
  const alarmLevels = safeLevels.filter((level) => ["LEVEL1", "LEVEL2"].includes(level));
  const multiJoinSql = alarmLevels.length
    ? `LEFT JOIN (
      SELECT s2.symbol,
        COUNT(DISTINCT s2.interval_code) AS multiMatchCount,
        MIN(CASE s2.alert_level WHEN 'LEVEL1' THEN 0 WHEN 'LEVEL2' THEN 1 ELSE 2 END) AS bestAlertRank
      FROM signal_result s2
      JOIN token_list t2 ON t2.id=s2.token_id
      WHERE s2.category_type IN (${quotedList(safeCategories)})
        AND s2.alert_level IN (${quotedList(alarmLevels)})
        AND s2.interval_code IN (${quotedList(safeIntervals)})
        AND t2.is_active=1
      GROUP BY s2.symbol
    ) mp ON mp.symbol=s.symbol`
    : "LEFT JOIN (SELECT NULL AS symbol, 0 AS multiMatchCount, 2 AS bestAlertRank) mp ON mp.symbol=s.symbol";
  const fundingBitSql =
    "IF(EXISTS(SELECT 1 FROM funding_interval_state f WHERE f.symbol=s.symbol AND f.funding_interval_hours=1 AND f.source_present=1), 8, 0)";
  const oiBitSql =
    `IF(EXISTS(
      SELECT 1 FROM open_interest_monitor oi
      WHERE oi.symbol=s.symbol
        AND ${activeOpenInterestSpikeSql("oi")}
    ), 4, 0)`;
  const hotBitSql = `IF(EXISTS(
    SELECT 1 FROM hot_rank_seen h
    WHERE ${hotRankSignalMatchSql("h", "s")}
      AND h.last_seen_at >= DATE_SUB(NOW(3), INTERVAL :activeSeconds SECOND)
  ), 2, 0)`;
  const multiBitSql = "IF(COALESCE(mp.multiMatchCount, 0) >= 3, 1, 0)";
  const sourceMaskSql = `(${fundingBitSql} + ${oiBitSql} + ${hotBitSql} + ${multiBitSql})`;
  const bestAlertRankSql = "COALESCE(mp.bestAlertRank, 2)";
  const groupSql = `
    SELECT s.symbol,
      MIN(t.category_type) AS categoryType,
      MIN(t.category_label) AS categoryLabel,
      COUNT(DISTINCT s.interval_code) AS matchingIntervalCount,
      COALESCE(mp.multiMatchCount, 0) AS multiMatchCount,
      ${sourceMaskSql} AS sourceMask,
      MAX(s.updated_at) AS latestUpdatedAt,
      MIN(CASE s.alert_level WHEN 'LEVEL1' THEN 0 WHEN 'LEVEL2' THEN 1 WHEN 'NONE' THEN 2 ELSE 3 END) AS bestLevelRank,
      MAX(s.signal_weight) AS bestWeight,
      CASE
        WHEN ${bestAlertRankSql} > 1 THEN 99
        WHEN ${sourceMaskSql} > 0 THEN (15 - ${sourceMaskSql}) * 2 + ${bestAlertRankSql}
        WHEN ${bestAlertRankSql}=0 THEN 30
        WHEN ${bestAlertRankSql}=1 THEN 31
        ELSE 99
      END AS priorityRank,
      'COMPOSITE' AS displayKind
    FROM signal_result s
    JOIN token_list t ON t.id=s.token_id
    ${multiJoinSql}
    WHERE ${whereSql}
    GROUP BY s.symbol, mp.multiMatchCount, mp.bestAlertRank
    HAVING sourceMask > 0`;
  const standaloneMaAlertExistsSql = alarmLevels.length
    ? `EXISTS(
        SELECT 1 FROM signal_result sx
        JOIN token_list tx ON tx.id=sx.token_id
        WHERE sx.symbol=t.symbol
          AND sx.category_type IN (${quotedList(safeCategories)})
          AND sx.alert_level IN (${quotedList(alarmLevels)})
          AND sx.interval_code IN (${quotedList(safeIntervals)})
          AND tx.is_active=1
      )`
    : "0";
  const standaloneOiSql = `
    SELECT t.symbol,
      t.category_type AS categoryType,
      t.category_label AS categoryLabel,
      0 AS matchingIntervalCount,
      0 AS multiMatchCount,
      4 AS sourceMask,
      oi.observed_at AS latestUpdatedAt,
      2 AS bestLevelRank,
      0 AS bestWeight,
      ${SIGNAL_PRIORITY.STANDALONE} AS priorityRank,
      'STANDALONE' AS displayKind
    FROM token_list t
    JOIN open_interest_monitor oi
      ON oi.symbol=t.symbol
      AND ${activeOpenInterestSpikeSql("oi")}
    WHERE t.category_type IN (${quotedList(safeCategories)})
      AND t.is_active=1
      AND NOT ${standaloneMaAlertExistsSql}`;
  const candidateSql = `${groupSql}\nUNION ALL\n${standaloneOiSql}`;
  const [countRows] = await getPool().query(
    `SELECT COUNT(*) AS total FROM (${candidateSql}) grouped`,
    openInterestSpikeQueryParams({ activeSeconds: hotRankActiveSeconds() })
  );
  const [symbolRows] = await getPool().query(
    `${candidateSql}
     ORDER BY
      priorityRank,
      bestLevelRank,
      bestWeight DESC,
      latestUpdatedAt DESC,
      symbol
     LIMIT :pageSize OFFSET :offset`,
    openInterestSpikeQueryParams({
      pageSize: safePageSize,
      offset: (safePage - 1) * safePageSize,
      activeSeconds: hotRankActiveSeconds()
    })
  );
  const symbols = symbolRows.map((row) => sanitizeDbSymbol(row.symbol)).filter(Boolean);
  const uniqueSymbols = [...new Set(symbols)];
  if (!symbols.length) {
    return {
      signals: [],
      total: Number(countRows[0]?.total ?? 0),
      page: safePage,
      pageSize: safePageSize
    };
  }

  const [rows] = await getPool().query(
    `SELECT s.symbol, s.category_type AS categoryType, t.category_label AS categoryLabel,
      s.interval_code AS intervalCode, s.alert_level AS alertLevel, s.ma100, s.ma200,
      s.current_price AS currentPrice, s.proximity_pct AS proximityPct, s.signal_weight AS signalWeight,
      s.signal_status AS signalStatus, s.note, s.signal_time AS signalTime, s.updated_at AS updatedAt
     FROM signal_result s
     JOIN token_list t ON t.id=s.token_id
     WHERE s.symbol IN (${quotedList(uniqueSymbols)})
       AND t.is_active=1
       AND s.category_type IN (${quotedList(safeCategories)})
       AND s.interval_code IN (${quotedList(safeIntervals)})
     ORDER BY FIELD(s.interval_code, '15m', '1h', '4h', '1d')`
  );
  const [hotRows] = await getPool().query(
    `SELECT t.symbol, MIN(h.last_seen_rank) AS hotRank
     FROM hot_rank_seen h
     JOIN token_list t ON ${hotRankTokenMatchSql("h", "t")}
     WHERE t.symbol IN (${quotedList(uniqueSymbols)})
       AND t.is_active=1
       AND h.last_seen_at >= DATE_SUB(NOW(3), INTERVAL :activeSeconds SECOND)
     GROUP BY t.symbol`,
    { activeSeconds: hotRankActiveSeconds() }
  );
  const [oiRows] = await getPool().query(
    `SELECT symbol,
      change_5m_pct AS oiChange5mPct,
      change_1h_pct AS oiChange1hPct,
      change_4h_pct AS oiChange4hPct,
      change_1d_pct AS oiChange1dPct
     FROM open_interest_monitor
     WHERE symbol IN (${quotedList(uniqueSymbols)})
       AND observed_at >= DATE_SUB(NOW(3), INTERVAL :activeSeconds SECOND)`,
    { activeSeconds: openInterestActiveSeconds() }
  );
  const [fundingRows] = await getPool().query(
    `SELECT symbol
     FROM funding_interval_state
     WHERE symbol IN (${quotedList(uniqueSymbols)})
       AND funding_interval_hours=1
       AND source_present=1`
  );
  const hotBySymbol = new Map(hotRows.map((row) => [row.symbol, row]));
  const oiBySymbol = new Map(oiRows.map((row) => [row.symbol, row]));
  const fundingSymbols = new Set(fundingRows.map((row) => row.symbol));
  const rowsBySymbol = new Map();
  for (const row of rows) {
    if (!rowsBySymbol.has(row.symbol)) rowsBySymbol.set(row.symbol, []);
    rowsBySymbol.get(row.symbol).push(row);
  }
  const signals = symbolRows.map((meta, index) => {
    const symbol = sanitizeDbSymbol(meta.symbol);
    const isStandalone = meta.displayKind === "STANDALONE";
    const metaSourceMask = Number(meta.sourceMask ?? 0);
    const rawDetails = rowsBySymbol.get(symbol) ?? [];
    const matchingDetails = isStandalone
      ? rawDetails.map((row) => ({ ...row, alertLevel: "NONE" }))
      : rawDetails.filter((row) => safeLevels.includes(row.alertLevel));
    const representative =
      matchingDetails.find((row) => row.alertLevel === "LEVEL1") ??
      matchingDetails.find((row) => row.alertLevel === "LEVEL2") ??
      matchingDetails[0] ??
      {
        symbol,
        categoryType: meta.categoryType ?? null,
        categoryLabel: meta.categoryLabel ?? "",
        intervalCode: safeIntervals[0] ?? null,
        alertLevel: "NONE",
        ma100: null,
        ma200: null,
        currentPrice: null,
        proximityPct: null,
        signalWeight: 0,
        signalStatus: "independent",
        note: "资金费率/OI 独立命中",
        signalTime: meta.latestUpdatedAt ?? null,
        updatedAt: meta.latestUpdatedAt ?? null
      };
    const hot = hotBySymbol.get(symbol);
    const oi = oiBySymbol.get(symbol);
    const triggeredDetails = isStandalone ? [] : matchingDetails.filter((row) => ["LEVEL1", "LEVEL2"].includes(row.alertLevel));
    const bestAlertLevel = isStandalone ? null : resolveBestAlertLevel(triggeredDetails);
    const oiSpike = evaluateOpenInterestSpike(
      {
        change5mPct: oi?.oiChange5mPct,
        change1hPct: oi?.oiChange1hPct,
        change4hPct: oi?.oiChange4hPct,
        change1dPct: oi?.oiChange1dPct
      },
      config.openInterestMonitor
    );
    const oiMatched = isStandalone ? metaSourceMask === 4 && oiSpike.hit : oiSpike.hit;
    const fundingOneHour = isStandalone ? metaSourceMask === 8 : fundingSymbols.has(symbol);
    const oiSpikeHit = oiMatched;
    const compositeProfile = resolveSignalProfile({
      fundingOneHour,
      oiMatched,
      hotRank: Boolean(hot),
      multiCycleCount: triggeredDetails.length,
      alertLevel: bestAlertLevel
    });
    return {
      ...representative,
      symbol,
      bestAlertLevel,
      intervals: triggeredDetails.map((row) => row.intervalCode),
      intervalDetails: matchingDetails,
      multiMatchCount: triggeredDetails.length,
      multiMatchRequired: 3,
      displayKind: meta.displayKind ?? "COMPOSITE",
      displayKey: `${symbol}:${meta.displayKind ?? "COMPOSITE"}:${metaSourceMask || "MA"}:${index}`,
      sourceMask: metaSourceMask,
      hotRankHit: hot ? 1 : 0,
      hotRank: hot?.hotRank ?? null,
      fundingOneHour,
      oiChange5mPct: oiSpike.change5mPct,
      oiChange1hPct: oiSpike.change1hPct,
      oiChange4hPct: oiSpike.change4hPct,
      oiChange1dPct: oiSpike.change1dPct,
      oiMatched,
      oiSpikeHit,
      oiSpike5mHit: oiSpike.hit5m,
      oiSpike1hHit: oiSpike.hit1h,
      oiSpike4hHit: oiSpike.hit4h,
      oiSpike1dHit: oiSpike.hit1d,
      compositeProfile
    };
  });
  return {
    signals,
    total: Number(countRows[0]?.total ?? 0),
    page: safePage,
    pageSize: safePageSize
  };
}

export async function getMultiCycleSignalsPage({ categories, levels, intervals, page = 1, pageSize = 4 }) {
  const safeCategories = normalizeList(categories, SIGNAL_CATEGORIES);
  const safeLevels = normalizeList(levels, SIGNAL_LEVELS).filter((level) => ["LEVEL1", "LEVEL2"].includes(level));
  const safeIntervals = normalizeList(intervals, SIGNAL_INTERVALS);
  const safePageSize = Math.max(1, Math.min(10, Number(pageSize) || 4));
  const safePage = Math.max(1, Number(page) || 1);
  const offset = (safePage - 1) * safePageSize;
  const multiRequired = safeIntervals.length > 1 && safeLevels.length > 0 ? Math.min(3, safeIntervals.length) : 0;

  if (safeCategories.length === 0 || safeLevels.length === 0 || safeIntervals.length === 0 || multiRequired < 2) {
    return { groups: [], total: 0, page: safePage, pageSize: safePageSize, multiMatchRequired: multiRequired };
  }

  const groupWhereSql = `s.category_type IN (${quotedList(safeCategories)})
    AND s.alert_level IN (${quotedList(safeLevels)})
    AND s.interval_code IN (${quotedList(safeIntervals)})
    AND t.is_active=1`;

  const groupSql = `
    SELECT
      s.symbol,
      COUNT(DISTINCT s.interval_code) AS multiMatchCount,
      MIN(CASE s.alert_level WHEN 'LEVEL1' THEN 0 WHEN 'LEVEL2' THEN 1 ELSE 3 END) AS bestLevelRank,
      MAX(s.signal_weight) AS bestWeight,
      MAX(s.updated_at) AS latestUpdatedAt
    FROM signal_result s
    JOIN token_list t ON t.id=s.token_id
    WHERE ${groupWhereSql}
    GROUP BY s.symbol
    HAVING COUNT(DISTINCT s.interval_code) >= :multiRequired`;

  const [countRows] = await getPool().query(`SELECT COUNT(*) AS total FROM (${groupSql}) m`, { multiRequired });
  const [symbolRows] = await getPool().query(
    `${groupSql}
     ORDER BY bestLevelRank, multiMatchCount DESC, bestWeight DESC, latestUpdatedAt DESC, symbol
     LIMIT :pageSize OFFSET :offset`,
    { multiRequired, pageSize: safePageSize, offset }
  );

  const symbols = symbolRows.map((row) => String(row.symbol ?? "").toUpperCase().replace(/[^A-Z0-9_]/g, "")).filter(Boolean);
  if (!symbols.length) {
    return {
      groups: [],
      total: Number(countRows[0]?.total ?? 0),
      page: safePage,
      pageSize: safePageSize,
      multiMatchRequired: multiRequired
    };
  }

  const [rows] = await getPool().query(
    `SELECT s.symbol, s.category_type AS categoryType, t.category_label AS categoryLabel,
      s.interval_code AS intervalCode, s.alert_level AS alertLevel, s.ma100, s.ma200,
      s.current_price AS currentPrice, s.proximity_pct AS proximityPct, s.signal_weight AS signalWeight,
      s.signal_status AS signalStatus, s.note, s.signal_time AS signalTime, s.updated_at AS updatedAt
     FROM signal_result s
     JOIN token_list t ON t.id=s.token_id
     WHERE s.symbol IN (${quotedList(symbols)})
       AND ${groupWhereSql}
     ORDER BY
      CASE s.interval_code WHEN '15m' THEN 0 WHEN '1h' THEN 1 WHEN '4h' THEN 2 WHEN '1d' THEN 3 ELSE 4 END,
      CASE s.alert_level WHEN 'LEVEL1' THEN 0 WHEN 'LEVEL2' THEN 1 ELSE 3 END,
      s.signal_weight DESC`
  );

  const rowsBySymbol = new Map();
  for (const row of rows) {
    if (!rowsBySymbol.has(row.symbol)) rowsBySymbol.set(row.symbol, []);
    rowsBySymbol.get(row.symbol).push(row);
  }

  return {
    groups: symbolRows.map((row) => ({
      symbol: row.symbol,
      multiMatchCount: Number(row.multiMatchCount ?? 0),
      multiMatchRequired: multiRequired,
      rows: rowsBySymbol.get(row.symbol) ?? []
    })),
    total: Number(countRows[0]?.total ?? 0),
    page: safePage,
    pageSize: safePageSize,
    multiMatchRequired: multiRequired
  };
}

export async function getHotMaSignalsPage({ categories = "A,B", levels = "LEVEL1,LEVEL2", intervals = "15m,1h,4h,1d", page = 1, pageSize = 6 } = {}) {
  const safeCategories = normalizeList(categories, SIGNAL_CATEGORIES);
  const safeLevels = normalizeList(levels, SIGNAL_LEVELS).filter((level) => ["LEVEL1", "LEVEL2"].includes(level));
  const safeIntervals = normalizeList(intervals, SIGNAL_INTERVALS);
  const safePageSize = Math.max(1, Math.min(20, Number(pageSize) || 6));
  const safePage = Math.max(1, Number(page) || 1);
  const offset = (safePage - 1) * safePageSize;

  if (safeCategories.length === 0 || safeLevels.length === 0 || safeIntervals.length === 0) {
    return { signals: [], total: 0, page: safePage, pageSize: safePageSize };
  }

  const whereSql = `s.category_type IN (${quotedList(safeCategories)})
    AND s.alert_level IN (${quotedList(safeLevels)})
    AND s.interval_code IN (${quotedList(safeIntervals)})
    AND t.is_active=1
    AND ${hotRankHitSql("t")}`;

  const params = {
    hotRankActiveSeconds: hotRankActiveSeconds(),
    pageSize: safePageSize,
    offset
  };
  const [countRows] = await getPool().query(
    `SELECT COUNT(*) AS total
     FROM signal_result s
     JOIN token_list t ON t.id=s.token_id
     WHERE ${whereSql}`,
    params
  );
  const [rows] = await getPool().query(
    `SELECT s.symbol, s.category_type AS categoryType, t.category_label AS categoryLabel,
      s.interval_code AS intervalCode, s.alert_level AS alertLevel, s.ma100, s.ma200,
      s.current_price AS currentPrice, s.proximity_pct AS proximityPct, s.signal_weight AS signalWeight,
      s.signal_status AS signalStatus, s.note, s.signal_time AS signalTime, s.updated_at AS updatedAt,
      ${hotRankValueSql("t", "MIN(h.last_seen_rank)")} AS hotRank,
      ${hotRankValueSql("t", "MAX(h.last_seen_at)")} AS hotRankLastSeenAt
     FROM signal_result s
     JOIN token_list t ON t.id=s.token_id
     WHERE ${whereSql}
     ORDER BY
      CASE s.alert_level WHEN 'LEVEL1' THEN 0 WHEN 'LEVEL2' THEN 1 ELSE 2 END,
      hotRank ASC,
      s.signal_weight DESC,
      s.updated_at DESC
     LIMIT :pageSize OFFSET :offset`,
    params
  );
  return {
    signals: rows,
    total: Number(countRows[0]?.total ?? 0),
    page: safePage,
    pageSize: safePageSize
  };
}

export async function selectHotMaSignalAlert(symbol, intervalCode) {
  const safeSymbol = sanitizeDbSymbol(symbol);
  if (!safeSymbol) return null;
  const [rows] = await getPool().query(
    `SELECT symbol, interval_code AS intervalCode, alert_level AS alertLevel, signal_time AS signalTime,
      profile_key AS profileKey, source_mask AS sourceMask, context_signature AS contextSignature, sent_at AS sentAt
     FROM hot_ma_signal_alert
     WHERE symbol=:symbol AND interval_code=:intervalCode
     LIMIT 1`,
    { symbol: safeSymbol, intervalCode }
  );
  return rows[0] ?? null;
}

export async function markHotMaSignalAlertSent(symbol, intervalCode, signal, alertState = {}) {
  const safeSymbol = sanitizeDbSymbol(symbol);
  if (!safeSymbol || !["LEVEL1", "LEVEL2"].includes(signal?.alertLevel)) return;
  const signalTime = Number(signal.signalTime ?? Date.now());
  const profileKey = alertState.profileKey ? String(alertState.profileKey).slice(0, 80) : null;
  const sourceMask = Number.isFinite(Number(alertState.sourceMask)) ? Number(alertState.sourceMask) : 0;
  const contextSignature = alertState.contextSignature ? String(alertState.contextSignature).slice(0, 255) : null;
  const sentAtUpdate = alertState.preserveSentAt ? "sent_at=sent_at" : "sent_at=NOW(3)";
  await getPool().query(
    `INSERT INTO hot_ma_signal_alert
      (symbol, interval_code, alert_level, signal_time, profile_key, source_mask, context_signature, sent_at)
     VALUES
      (:symbol, :intervalCode, :alertLevel, FROM_UNIXTIME(:signalTime / 1000), :profileKey, :sourceMask, :contextSignature, NOW(3))
     ON DUPLICATE KEY UPDATE
      alert_level=VALUES(alert_level),
      signal_time=VALUES(signal_time),
      profile_key=VALUES(profile_key),
      source_mask=VALUES(source_mask),
      context_signature=VALUES(context_signature),
      ${sentAtUpdate}`,
    { symbol: safeSymbol, intervalCode, alertLevel: signal.alertLevel, signalTime, profileKey, sourceMask, contextSignature }
  );
}

export async function recordMultiCycleHistory(token, signals, required = 2) {
  const hits = (signals ?? [])
    .filter(({ signal }) => ["LEVEL1", "LEVEL2"].includes(signal.alertLevel))
    .sort((a, b) => SIGNAL_INTERVALS_ORDER.indexOf(a.intervalCode) - SIGNAL_INTERVALS_ORDER.indexOf(b.intervalCode));
  if (hits.length < required) return false;
  const bestAlertLevel = hits.some(({ signal }) => signal.alertLevel === "LEVEL1") ? "LEVEL1" : "LEVEL2";
  const intervals = hits.map(({ intervalCode }) => intervalCode).join(",");
  await getPool().query(
    `INSERT INTO multi_cycle_history
      (symbol, base_asset, category_label, multi_match_count, intervals, best_alert_level)
     VALUES (:symbol, :baseAsset, :categoryLabel, :multiMatchCount, :intervals, :bestAlertLevel)
     ON DUPLICATE KEY UPDATE
      category_label=VALUES(category_label),
      last_triggered_at=NOW(3),
      multi_match_count=VALUES(multi_match_count),
      intervals=VALUES(intervals),
      best_alert_level=VALUES(best_alert_level)`,
    {
      symbol: sanitizeDbSymbol(token.symbol),
      baseAsset: baseAssetFromSymbol(token.symbol),
      categoryLabel: String(token.category_label ?? token.categoryLabel ?? "").slice(0, 80),
      multiMatchCount: hits.length,
      intervals,
      bestAlertLevel
    }
  );
  return true;
}

const SIGNAL_INTERVALS_ORDER = ["15m", "1h", "4h", "1d"];

export async function listMultiCycleHistory({ limit = 50 } = {}) {
  const safeLimit = Math.max(1, Math.min(200, Number(limit) || 50));
  const [rows] = await getPool().query(
    `SELECT symbol, base_asset AS baseAsset, category_label AS categoryLabel,
      first_triggered_at AS firstTriggeredAt, last_triggered_at AS lastTriggeredAt,
      multi_match_count AS multiMatchCount, intervals, best_alert_level AS bestAlertLevel
     FROM multi_cycle_history
     ORDER BY last_triggered_at DESC, multi_match_count DESC, symbol
     LIMIT :limit`,
    { limit: safeLimit }
  );
  return rows.map((row) => ({
    ...row,
    multiMatchCount: Number(row.multiMatchCount ?? 0)
  }));
}


export async function listRealtimeKlineTokens() {
  const [rows] = await getPool().query(
    `SELECT DISTINCT t.*
     FROM token_list t
     WHERE t.is_active=1
       AND (
         EXISTS(SELECT 1 FROM watchlist w WHERE w.symbol=t.symbol)
         OR EXISTS(
           SELECT 1
           FROM signal_result s
           LEFT JOIN (
             SELECT symbol, COUNT(DISTINCT interval_code) AS multiMatchCount
             FROM signal_result
             WHERE alert_level IN ('LEVEL1','LEVEL2')
             GROUP BY symbol
           ) mp ON mp.symbol=s.symbol
           WHERE s.symbol=t.symbol
             AND s.alert_level IN ('LEVEL1','LEVEL2')
             AND (
               COALESCE(mp.multiMatchCount, 0) >= 3
               OR EXISTS(
                 SELECT 1 FROM funding_interval_state f
                 WHERE f.symbol=s.symbol
                   AND f.funding_interval_hours=1
                   AND f.source_present=1
               )
               OR EXISTS(
                 SELECT 1 FROM open_interest_monitor oi
                 WHERE oi.symbol=s.symbol
                   AND ${activeOpenInterestSpikeSql("oi")}
               )
               OR EXISTS(
                 SELECT 1 FROM hot_rank_seen h
                 WHERE ${hotRankTokenMatchSql("h", "t")}
                   AND h.last_seen_at >= DATE_SUB(NOW(3), INTERVAL :hotRankActiveSeconds SECOND)
               )
             )
         )
       )
     ORDER BY t.symbol`,
    openInterestSpikeQueryParams({ hotRankActiveSeconds: hotRankActiveSeconds() })
  );
  return rows;
}
