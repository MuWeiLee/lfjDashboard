// 盘中资金流向（A股 Wind 概念指数主力净流入）——每 30 分钟采样一次。
//
// 数据全部来自 Wind MCP analytics_data.get_financial_data：
//   1) 今日流入/流出榜：每轮刷新取一次，把「截至当前的累计净流入」追加进当日采样序列，
//      页面重放即成分时曲线（Wind 语义层忽略历史时点，无法回补当天已过时段，因此只能向前累积）。
//   2) 5 日 / 20 日窗口：收盘后按概念逐一取「每日净流入额 + 成交额」日序列，当日只构建一次并缓存。
// 任何一轮取数失败都保留上一份快照，避免把看板清空。
import { callWindTool } from "./wind-client.js";

const KEY = {
  today: (day) => `fund-flow:today:${day}`,
  window: (days) => `fund-flow:window:${days}`,
  latest: "fund-flow:latest"
};

export const FUND_FLOW_KEYS = KEY;

const INFLOW_TODAY = ["A股概念指数今日主力净流入额和成交额排名前三十", "A股概念指数今日主力净流入额排名前三十"];
const OUTFLOW_TODAY = ["A股概念指数今日主力净流出额和成交额排名前二十", "A股概念指数今日主力净流出额排名前二十"];
const windowRanking = (days, direction) => direction === "out"
  ? [`A股概念指数近${days}日主力净流出额合计排名前二十`, `A股概念指数近${days}日主力净流出额排名前二十`]
  : [`A股概念指数近${days}日主力净流入额合计和成交额合计排名前二十`, `A股概念指数近${days}日主力净流入额合计排名前二十`];
const seriesQuestions = (name, days) => [
  `${name}近${days}个交易日每日主力净流入额和成交额`,
  `${name}近${days}个交易日每日主力净流入额`
];

// ── Wind 解析 ──────────────────────────────────────────────

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

function objects(table) {
  const names = table.columns.map((item) => item.name);
  return table.rows.map((row) => Object.fromEntries(names.map((name, index) => [name, row[index]])));
}

function pick(names, includes, excludes = []) {
  return names.find((name) => includes.some((pattern) => pattern.test(name)) && !excludes.some((pattern) => pattern.test(name)));
}

const RE = {
  code: /Wind代码|^代码$|指数代码/,
  name: /证券简称|概念名称|板块名称|^名称$/,
  net: /主力净流入额|净流入额/,
  netLatest: /最新/,
  turnover: /成交额/,
  pct: /占比|净流入占比/,
  date: /日期|交易时间|时间/
};

/** 净流入额的量纲不固定（元 / 万元 / 亿元），按整列数量级归一到亿元。 */
function amountScale(values) {
  const magnitudes = values.map((value) => Math.abs(Number(value))).filter((value) => value > 0).sort((a, b) => a - b);
  if (!magnitudes.length) return 1;
  const median = magnitudes[Math.floor(magnitudes.length / 2)];
  if (median >= 1e7) return 1e8;      // 元
  if (median >= 1e3) return 1e4;      // 万元
  return 1;                            // 亿元
}

/** Wind 表格 → [{ code, name, amount(亿元), pct(%), turnover(亿元) }] */
function flowRows(payload, { sign = 1 } = {}) {
  const output = [];
  const seen = new Set();
  for (const table of tables(payload)) {
    const names = table.columns.map((item) => item.name);
    const nameKey = pick(names, [RE.name]);
    const codeKey = pick(names, [RE.code]);
    const netKey = pick(names, [RE.net], [RE.netLatest, RE.pct]);
    const pctKey = pick(names, [RE.pct]);
    const turnoverKey = pick(names, [RE.turnover], [RE.net]);
    if (!nameKey || !netKey) continue;
    const rows = objects(table);
    const scale = amountScale(rows.map((row) => row[netKey]));
    const turnoverScale = turnoverKey ? amountScale(rows.map((row) => row[turnoverKey])) : 1;
    for (const row of rows) {
      const name = String(row[nameKey] || "").trim();
      const amount = Number(row[netKey]) / scale;
      if (!name || !Number.isFinite(amount)) continue;
      const code = codeKey ? String(row[codeKey] || "").trim() : "";
      const key = code || name;
      if (seen.has(key)) continue;
      seen.add(key);
      const turnover = turnoverKey && Number.isFinite(Number(row[turnoverKey])) ? Number(row[turnoverKey]) / turnoverScale : null;
      const pctValue = pctKey && Number.isFinite(Number(row[pctKey])) ? Number(row[pctKey]) : null;
      output.push({
        code,
        name,
        amount: round(amount * sign, 3),
        pct: pctValue != null ? round(pctValue * (sign < 0 ? -1 : 1), 3) : null,
        turnover: turnover == null ? null : round(turnover * 1, 3)
      });
    }
  }
  return output;
}

function round(value, digits) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

async function query(questions, options) {
  let lastError = null;
  for (const question of questions) {
    try {
      const rows = flowRows(unwrap(await callWindTool("analytics_data", "get_financial_data", { question }, { timeoutMs: 45_000 })), options);
      if (rows.length) return { rows, question };
    } catch (error) {
      lastError = error;
    }
  }
  if (lastError) throw lastError;
  return { rows: [], question: questions[0] };
}

function shanghaiNow(now = new Date()) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hourCycle: "h23"
  }).formatToParts(now).map((part) => [part.type, part.value]));
  return { day: `${parts.year}${parts.month}${parts.day}`, minute: Number(parts.hour) * 60 + Number(parts.minute), label: `${parts.hour}:${parts.minute}` };
}

// ── 今日分时采样 ───────────────────────────────────────────

const MAX_SAMPLES = 40;

/** 每轮刷新：把当前累计净流入追加为一个采样点。 */
export async function appendTodaySample(store, { now = new Date() } = {}) {
  const clock = shanghaiNow(now);
  const current = (await store.kvGet(KEY.today(clock.day)).catch(() => null))?.value
    || { tradingDate: clock.day, samples: [], series: [] };
  // 收盘后不再追加采样：15:00 之后的刷新会把收盘值重复记成新时点，曲线尾部会失真。
  const hasCloseSample = (current.samples || []).some((label) => compareLabel(label, "15:00") >= 0);
  if (clock.minute > 15 * 60 + 2 && hasCloseSample) return { skipped: true, reason: "收盘采样已完成，保留 15:00 收盘值" };
  if (clock.minute < 9 * 60 + 30) return { skipped: true, reason: "尚未开盘，未记录采样" };

  const [inflow, outflow] = await Promise.all([
    query(INFLOW_TODAY),
    query(OUTFLOW_TODAY, { sign: -1 })
  ]);
  const flows = [...inflow.rows.map((row) => ({ ...row, amount: Math.abs(row.amount) })), ...outflow.rows.map((row) => ({ ...row, amount: -Math.abs(row.amount), pct: row.pct == null ? null : -Math.abs(row.pct) }))];
  if (!flows.length) return { skipped: true, errors: [] };

  const byCode = new Map(current.series.map((line) => [line.code || line.name, { ...line, points: new Map((line.points || []).map((point) => [point.label, point])) }]));
  // 收盘后取到的是收盘值，统一记作 15:00，避免把盘后时点画到 X 轴之外。
  const sampleMinute = Math.min(clock.minute, 15 * 60);
  const sampleLabel = `${String(Math.floor(sampleMinute / 60)).padStart(2, "0")}:${String(sampleMinute % 60).padStart(2, "0")}`;
  for (const flow of flows) {
    const key = flow.code || flow.name;
    const line = byCode.get(key) || { code: flow.code, name: flow.name, points: new Map() };
    const pct = Number.isFinite(flow.pct) ? flow.pct : (flow.turnover ? flow.amount / flow.turnover * 100 : null);
    line.points.set(sampleLabel, {
      label: sampleLabel,
      minute: sampleMinute,
      amount: round(flow.amount, 3),
      pct: Number.isFinite(pct) ? round(pct, 3) : null
    });
    byCode.set(key, line);
  }

  const samples = [...new Set([...(current.samples || []), sampleLabel])].sort(compareLabel).slice(-MAX_SAMPLES);
  const keep = new Set(samples);
  const series = [...byCode.values()].map((line) => ({
    code: line.code,
    name: line.name,
    points: [...line.points.values()].filter((point) => keep.has(point.label)).sort((a, b) => compareLabel(a.label, b.label))
  })).filter((line) => line.points.length);

  const value = {
    tradingDate: clock.day,
    updatedAt: now.toISOString(),
    startLabel: samples[0],
    samples,
    series
  };
  await store.kvSet(KEY.today(clock.day), value);
  await store.kvSet(KEY.latest, value);
  return { value, errors: [] };
}

function compareLabel(a, b) {
  const toMinute = (label) => {
    const [hour, minute] = String(label || "0:0").split(":").map(Number);
    return (hour || 0) * 60 + (minute || 0);
  };
  return toMinute(a) - toMinute(b);
}

// ── 5 日 / 20 日窗口 ─────────────────────────────────────

const WINDOWS = [5, 20];
const PICK_INFLOW = 6;
const PICK_OUTFLOW = 4;

function dateKey(value) {
  const digits = String(value || "").replace(/\D/g, "");
  return digits.length >= 8 ? digits.slice(0, 8) : null;
}

/** 单概念每日净流入日序列 → [{ date, amount, pct }] */
function dailySeries(payload, days) {
  const output = [];
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - days * 2);
  for (const table of tables(payload)) {
    const names = table.columns.map((item) => item.name);
    const dateKeyName = pick(names, [RE.date]);
    const netKey = pick(names, [RE.net], [RE.netLatest, RE.pct]);
    const turnoverKey = pick(names, [RE.turnover], [RE.net]);
    if (!dateKeyName || !netKey) continue;
    const rows = objects(table);
    const scale = amountScale(rows.map((row) => row[netKey]));
    const turnoverScale = turnoverKey ? amountScale(rows.map((row) => row[turnoverKey])) : 1;
    for (const row of rows) {
      const date = dateKey(row[dateKeyName]);
      const amount = Number(row[netKey]) / scale;
      if (!date || !Number.isFinite(amount)) continue;
      const turnover = turnoverKey ? Number(row[turnoverKey]) / turnoverScale : null;
      output.push({
        date,
        amount: round(amount, 3),
        pct: turnover && Number.isFinite(turnover) && turnover !== 0 ? round(amount / turnover * 100, 3) : null,
        _sortKey: `${date}${String(row[dateKeyName]).replace(/\D/g, "").slice(8)}`
      });
    }
  }
  const unique = new Map();
  for (const point of output.sort((a, b) => a._sortKey.localeCompare(b._sortKey))) unique.set(point._sortKey, point);
  return [...unique.values()].slice(-days).map(({ _sortKey, ...point }) => point);
}

/** 榜单口径为空时，用今日已采样的概念兜底，保证 5/20 日视图有数据。 */
async function fallbackPicks(store) {
  const latest = (await store.kvGet(KEY.latest).catch(() => null))?.value;
  return (latest?.series || []).slice(0, PICK_INFLOW + PICK_OUTFLOW).map((line) => ({ name: line.name, code: line.code }));
}

async function querySeries(name, days) {
  for (const question of seriesQuestions(name, days)) {
    try {
      const payload = unwrap(await callWindTool("analytics_data", "get_financial_data", { question }, { timeoutMs: 45_000 }));
      if (dailySeries(payload, days).length) return payload;
    } catch { /* 换下一种问法 */ }
  }
  return null;
}

/** 盘中缺缓存时立即构建（保证 5 日 / 20 日视图一开始就有数据）；收盘后再用当日收盘价重建一次。 */
export async function refreshWindows(store, { now = new Date(), force = false } = {}) {
  const clock = shanghaiNow(now);
  const result = { errors: [], built: [] };
  const afterClose = clock.minute >= 15 * 60;

  for (const days of WINDOWS) {
    const cached = (await store.kvGet(KEY.window(days)).catch(() => null))?.value;
    if (!force && cached && cached.builtFor === clock.day && (!afterClose || cached.closed)) continue;
    try {
      const [inflow, outflow] = await Promise.all([
        query(windowRanking(days, "in")),
        query(windowRanking(days, "out"), { sign: -1 })
      ]);
      const picks = [
        ...inflow.rows.slice(0, PICK_INFLOW),
        ...outflow.rows.slice(0, PICK_OUTFLOW)
      ].filter((row) => row.name);
      if (!picks.length) {
        // 榜单口径不可用时，退回今日已采样的概念，保证 5 日 / 20 日视图有数据。
        picks.push(...(await fallbackPicks(store)));
      }
      if (!picks.length) { result.errors.push(`fund-flow:${days}日 榜单为空`); continue; }
      const lines = [];
      for (const pickRow of picks) {
        try {
          const payload = await querySeries(pickRow.name, days);
          const points = payload ? dailySeries(payload, days) : [];
          if (points.length) lines.push({ code: pickRow.code, name: pickRow.name, points });
        } catch (error) {
          result.errors.push(`fund-flow:${days}日 ${pickRow.name} ${String(error?.message || error).slice(0, 80)}`);
        }
      }
      if (!lines.length) { result.errors.push(`fund-flow:${days}日 无日序列`); continue; }
      const dates = [...new Set(lines.flatMap((line) => line.points.map((point) => point.date)))].sort().slice(-days);
      await store.kvSet(KEY.window(days), {
        builtFor: clock.day,
        closed: afterClose,
        builtAt: now.toISOString(),
        days,
        dates,
        series: lines.map((line) => ({ ...line, points: line.points.filter((point) => dates.includes(point.date)) }))
      });
      result.built.push(`fund-flow:${days}日(${lines.length}线)`);
    } catch (error) {
      result.errors.push(`fund-flow:${days}日 ${String(error?.message || error).slice(0, 120)}`);
    }
  }
  return result;
}

/** 页面读取：今日曲线 + 两个窗口（窗口缺失时返回空数组，由前端提示）。 */
export async function readFundFlow(store, { tradingDate = null } = {}) {
  const latest = (await store.kvGet(KEY.latest).catch(() => null))?.value || null;
  const day = tradingDate || latest?.tradingDate || null;
  const today = day ? (await store.kvGet(KEY.today(day)).catch(() => null))?.value || (latest?.tradingDate === day ? latest : null) : null;
  const windows = {};
  for (const days of WINDOWS) windows[String(days)] = (await store.kvGet(KEY.window(days)).catch(() => null))?.value || null;
  return { asOf: today?.updatedAt || null, tradingDate: day, today, windows };
}
