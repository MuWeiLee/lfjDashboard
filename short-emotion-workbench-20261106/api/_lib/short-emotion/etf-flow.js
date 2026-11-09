// 宽基指数 ETF 资金净申赎（观察「国家队」行踪）
//
// 数据口径（重要，页面上也会展示）：
//   Wind 的 analytics_data 没有「ETF 净申赎金额」直接字段，只有日频基金份额与收盘价。
//   因此这里按份额变动估算：
//     净申赎(亿元) = (当日基金份额 − 上一交易日基金份额) × 当日收盘价 / 1e8（份额单位：份）
//   Wind 在「近N交易日每日基金份额」口径下返回的数值实际是「万份」（列名单位标注不可靠），
//   代码按数量级自动识别并换算，等价公式：
//     净申赎(亿元) = Δ份额(万份) × 当日收盘价 / 1e4
//   该结果是「份额变动按当日收盘价折算」的估算值，不等于基金公司披露的精确申赎金额。
//
// 取数：每次刷新按 4 只一批问 Wind（多代码一次返回全部日期），只取近 21 个份额点，
// 首点作为基准，滚动得到近 20 个交易日的净申赎。份额为 0 变动且价格不变的行（周末/节假日/
// 份额尚未更新）会被剔除，不记为交易日。所有错误都静默降级：保留上一份快照，页面不清空。
import { callWindTool } from "./wind-client.js";

export const ETF_FLOW_KEY = "etf-flow:latest";
const WIND_DAYS = 20;
const REQUEST_DAYS = 21; // 21 个份额点 → 20 个变动
const BATCH_SIZE = 2; // Wind 一次问 3 只以上会缺行/截断，2 只一批才能拿全

// 只收敛一组规模最大、最有代表性的宽基 ETF，避免铺太多。
export const ETF_UNIVERSE = [
  { code: "510050.SH", label: "上证50", etf: "上证50ETF" },
  { code: "510300.SH", label: "沪深300", etf: "沪深300ETF" },
  { code: "159919.SZ", label: "沪深300", etf: "沪深300ETF(嘉实)" },
  { code: "510500.SH", label: "中证500", etf: "中证500ETF" },
  { code: "512100.SH", label: "中证1000", etf: "中证1000ETF" },
  { code: "159915.SZ", label: "创业板", etf: "创业板ETF" },
  { code: "588000.SH", label: "科创50", etf: "科创50ETF" },
  { code: "563360.SH", label: "中证A500", etf: "中证A500ETF" }
];

export const ETF_FLOW_BASIS = "净申赎 ≈ Δ基金份额 × 当日收盘价（份额按万份换算后折算，Wind 无直接申赎金额字段）";

// 预警口径（只在这里定义，前端直接消费算好的字段）：
//   singleDayAmount：单日净申购（亿元）预警阈值
//   streakDays：连续净申购/净赎回天数预警阈值
export const ETF_ALERT_CONFIG = {
  singleDayAmount: 50,
  streakDays: 5
};

const RE = {
  code: /Wind代码|^代码$/,
  name: /证券简称|^名称$/,
  price: /收盘价/,
  priceDate: /收盘价时间/,
  share: /基金份额/,
  shareDate: /基金份额时间/
};

function unwrap(outer) {
  const text = outer?.content?.find?.((item) => item.type === "text")?.text;
  if (!text) return outer;
  try { return JSON.parse(text); } catch { return { data: text }; }
}

function tables(payload) {
  const value = payload?.data?.data ?? payload?.data;
  if (Array.isArray(value)) return value.filter((item) => item?.columns && Array.isArray(item.rows));
  return value?.columns && Array.isArray(value.rows) ? [value] : [];
}

function pick(names, includes, excludes = []) {
  return names.find((name) => includes.some((pattern) => pattern.test(name)) && !excludes.some((pattern) => pattern.test(name)));
}

function dates(value) {
  const digits = String(value || "").replace(/\D/g, "");
  return digits.length >= 8 ? digits.slice(0, 8) : null;
}

function round(value, digits) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

/** 份额列可能是「份」也可能是「万份」，按中位数量级判断（宽基 ETF 份额至少十亿份级）。 */
export function shareScaleOf(values) {
  const magnitudes = values.map((value) => Math.abs(Number(value))).filter((value) => value > 0).sort((a, b) => a - b);
  if (!magnitudes.length) return 1e4;
  const median = magnitudes[Math.floor(magnitudes.length / 2)];
  // 宽基 ETF 份额是十亿份级：若中位数只有百万级，说明单位是「万份」。
  return median < 1e7 ? 1e4 : 1; // 万份 → 份需要 ×1e4；已是份则直接用
}

/** Wind 宽表（每行 = 一只 ETF 的一个日期）→ Map<code, { name, rows }>。 */
export function parseEtfRows(...payloads) {
  const byCode = new Map();
  for (const payload of payloads) {
    for (const table of tables(payload)) {
      const names = table.columns.map((item) => item.name);
      const codeKey = pick(names, [RE.code]);
      const nameKey = pick(names, [RE.name]);
      const priceKey = pick(names, [RE.price], [RE.priceDate]);
      const shareKey = pick(names, [RE.share], [RE.shareDate]);
      const dateKey = pick(names, [RE.priceDate]) || pick(names, [RE.shareDate]) || pick(names, [/日期|交易时间/]);
      if (!codeKey || !priceKey || !shareKey || !dateKey) continue;
      for (const row of table.rows) {
        const code = String(row[names.indexOf(codeKey)] || "").trim();
        const date = dates(row[names.indexOf(dateKey)]);
        const price = Number(row[names.indexOf(priceKey)]);
        const share = Number(row[names.indexOf(shareKey)]);
        if (!code || !date || !Number.isFinite(price) || !Number.isFinite(share)) continue;
        const entry = byCode.get(code) || { name: nameKey ? String(row[names.indexOf(nameKey)] || "").trim() : "", rows: [] };
        entry.rows.push({ date, price, share });
        byCode.set(code, entry);
      }
    }
  }
  return byCode;
}

/**
 * 单只 ETF 的份额序列 → 每日净申赎（亿元）。
 * 份额/价格都没变的行（周末、节假日、份额未更新）不是交易日，直接跳过；
 * 首行只作基准，不产生金额。
 */
export function deriveNetFlow(rows, { days = WIND_DAYS } = {}) {
  const sorted = [...rows].sort((a, b) => a.date.localeCompare(b.date));
  const scale = shareScaleOf(sorted.map((row) => row.share));
  const kept = [];
  for (const row of sorted) {
    const prev = kept.at(-1);
    if (!prev) { kept.push(row); continue; }
    if (row.date === prev.date) continue;
    if (row.share === prev.share && row.price === prev.price) continue; // 非交易日/未更新
    kept.push(row);
  }
  // scale=1e4 表示 Wind 给的是万份：Δ(万份)×1e4×价格/1e8 = Δ×价格/1e4。
  const divisor = scale === 1e4 ? 1e4 : 1e8;
  const flow = [];
  for (let index = 1; index < kept.length; index += 1) {
    const row = kept[index];
    const prev = kept[index - 1];
    const amount = (row.share - prev.share) * scale * row.price / 1e8;
    flow.push({ date: row.date, amount: round(amount, 3) });
  }
  return flow.slice(-days);
}

/**
 * 单个窗口内的预警：
 *   - 单日大额净申购：某日 amount ≥ singleDayAmount；
 *   - 连续净流入/流出：从窗口最后一天往前数，连续同向的天数（中断即停）。
 * 返回 { dates, summary, byCode }，前端直接按 code 取用，不再自行判定。
 */
export function computeWindowAlerts(series, dates, { config = ETF_ALERT_CONFIG } = {}) {
  const byCode = {};
  let count = 0;
  let topSingle = null;
  let topStreak = null;
  for (const line of series) {
    const points = line.points.filter((point) => dates.includes(point.date));
    const hits = points
      .filter((point) => point.amount >= config.singleDayAmount)
      .map((point) => ({ date: point.date, amount: point.amount }));
    const max = hits.reduce((best, hit) => (!best || hit.amount > best.amount ? hit : best), null);
    let direction = null;
    let streakDays = 0;
    for (let index = points.length - 1; index >= 0; index -= 1) {
      const amount = points[index].amount;
      const sign = amount > 0 ? "in" : amount < 0 ? "out" : null;
      if (!sign) break;
      if (direction && sign !== direction) break;
      direction = sign;
      streakDays += 1;
    }
    const streak = { thresholdDays: config.streakDays, direction, days: streakDays, alert: streakDays >= config.streakDays };
    byCode[line.code] = { singleDay: { threshold: config.singleDayAmount, max, hits }, streak };
    if (max || streak.alert) count += 1;
    if (max && (!topSingle || max.amount > topSingle.amount)) {
      topSingle = { code: line.code, label: line.label, date: max.date, amount: max.amount };
    }
    if (streak.alert && (!topStreak || streakDays > topStreak.days)) {
      topStreak = { code: line.code, label: line.label, direction, days: streakDays };
    }
  }
  return {
    dates: dates.slice(),
    summary: { count, threshold: config.singleDayAmount, streakDays: config.streakDays, topSingle, topStreak },
    byCode
  };
}

/** 合并多批 Wind 结果 → 可直接存储/下发的快照。 */
export function buildEtfFlow(payloads, { now = new Date(), days = WIND_DAYS, universe = ETF_UNIVERSE, errors = [] } = {}) {
  const parsed = parseEtfRows(...payloads);
  const series = [];
  for (const item of universe) {
    const entry = parsed.get(item.code);
    if (!entry) continue;
    const points = deriveNetFlow(entry.rows, { days });
    if (!points.length) continue;
    series.push({
      code: item.code,
      label: item.label,
      name: entry.name || item.etf,
      points
    });
  }
  const allDates = [...new Set(series.flatMap((line) => line.points.map((point) => point.date)))].sort().slice(-days);
  const normalized = series
    .map((line) => ({ ...line, points: line.points.filter((point) => allDates.includes(point.date)) }))
    .filter((line) => line.points.length);
  // 页面可选 5 / 20 日：两个窗口的预警都在数据层算好，避免前后端口径漂移。
  const windows = {};
  for (const length of [5, days]) {
    windows[String(length)] = computeWindowAlerts(normalized, allDates.slice(-length));
  }
  return {
    asOf: now.toISOString(),
    tradingDate: allDates.at(-1) || null,
    days,
    basis: ETF_FLOW_BASIS,
    source: "Wind analytics_data.get_financial_data（日频基金份额 + 收盘价）",
    dates: allDates,
    series: normalized,
    alertConfig: { ...ETF_ALERT_CONFIG },
    windows,
    missing: universe.filter((item) => !parsed.has(item.code)).map((item) => item.code),
    errors: errors.slice(0, 6)
  };
}

const questionOf = (codes) => `${codes.join(",")}近${REQUEST_DAYS}个交易日每日基金份额和收盘价`;

/** 刷新快照。任何一批失败都继续，全部失败或新数据更旧时保留上一份缓存（静默降级）。 */
export async function refreshEtfFlow(store, { now = new Date() } = {}) {
  const codes = ETF_UNIVERSE.map((item) => item.code);
  const payloads = [];
  const errors = [];
  for (let index = 0; index < codes.length; index += BATCH_SIZE) {
    const batch = codes.slice(index, index + BATCH_SIZE);
    try {
      payloads.push(unwrap(await callWindTool("analytics_data", "get_financial_data", { question: questionOf(batch) }, { timeoutMs: 60_000 })));
    } catch (error) {
      errors.push(`etf-flow:${batch.join("/")} ${String(error?.message || error).slice(0, 80)}`);
    }
  }
  const next = buildEtfFlow(payloads, { now, errors });
  if (!next.series.length) return { skipped: true, errors, reason: "Wind 未返回份额数据，保留上一份快照" };
  const cached = (await store.kvGet(ETF_FLOW_KEY).catch(() => null))?.value;
  if (cached?.tradingDate && next.tradingDate && next.tradingDate < cached.tradingDate) {
    return { skipped: true, errors, reason: "Wind 返回的份额日期早于缓存，保留上一份快照" };
  }
  await store.kvSet(ETF_FLOW_KEY, next);
  return { value: next, errors };
}

const EMPTY = {
  pending: true,
  asOf: null,
  tradingDate: null,
  days: WIND_DAYS,
  basis: ETF_FLOW_BASIS,
  source: "Wind analytics_data.get_financial_data（日频基金份额 + 收盘价）",
  dates: [],
  series: [],
  alertConfig: { ...ETF_ALERT_CONFIG },
  windows: {},
  missing: [],
  errors: []
};

/** 页面读取：只读快照，不调用 Wind；没有快照时返回 pending 空结构，前端展示占位。 */
export async function readEtfFlow(store) {
  const entry = await store.kvGet(ETF_FLOW_KEY).catch(() => null);
  if (!entry?.value) return { ...EMPTY };
  return { ...entry.value, pending: false, storedAt: entry.updatedAt || null };
}
