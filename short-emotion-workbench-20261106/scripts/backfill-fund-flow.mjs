// 一次性回填：用 narrative-radar 的历史日频面板（Wind 指数行情 + 机构主动净买入）
// 生成资金流向的 5 日 / 20 日窗口快照，避免首次部署时窗口为空。
//
// 数据源：prototype/narrative-radar/data/processed/题材拐点正式输入数据_v1_日频_*.csv
//   第 9 列成交额（元）、第 22 列机构主动净买入额（元）、第 23 列机构主动净买入占比（小数）
// 输出：short-emotion-data/kv/fund-flow_window_{5,20}.json（真实数据，非 mock）
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";

const PANEL = process.argv[2] || "D:/fjliu.frank/YUN/prototype/narrative-radar/data/processed/题材拐点正式输入数据_v1_日频_20230103-20261019.csv";
const STORE_DIR = process.env.SHORT_EMOTION_DATA_DIR || "D:/fjliu.frank/YUN/短线情绪工作台/short-emotion-data";
const WINDOWS = [5, 20];
const SEQ = { date: 1, code: 2, name: 3, benchmark: 4, amount: 9, active: 22, activeRatio: 23 };

async function eachRow(handler) {
  const reader = createInterface({ input: createReadStream(PANEL, "utf8"), crlfDelay: Infinity });
  let header = true;
  for await (const line of reader) {
    if (header) { header = false; continue; }
    if (!line) continue;
    handler(line.split(","));
  }
}

const dates = new Set();
await eachRow((cols) => { if (cols[SEQ.date]) dates.add(cols[SEQ.date]); });
const recent = [...dates].sort().slice(-20);
const recentSet = new Set(recent);
console.log(`面板交易日 ${dates.size} 天，取最近 ${recent.length} 天：${recent[0]} ~ ${recent.at(-1)}`);

const concepts = new Map();
await eachRow((cols) => {
  const date = cols[SEQ.date];
  if (!recentSet.has(date) || cols[SEQ.benchmark] === "1") return;
  const code = cols[SEQ.code];
  if (!code?.startsWith("884")) return;
  const active = Number(cols[SEQ.active]);
  if (!Number.isFinite(active)) return;
  const ratio = Number(cols[SEQ.activeRatio]);
  const entry = concepts.get(code) || { code, name: cols[SEQ.name], points: new Map() };
  entry.points.set(date, {
    date,
    amount: Math.round(active / 1e8 * 1000) / 1000,
    pct: Number.isFinite(ratio) ? Math.round(ratio * 100 * 1000) / 1000 : null
  });
  concepts.set(code, entry);
});

process.env.SHORT_EMOTION_STORE = "file";
process.env.SHORT_EMOTION_DATA_DIR = STORE_DIR;
const { getStore } = await import("../api/_lib/short-emotion/store.js");
const store = getStore("cn");

for (const days of WINDOWS) {
  const windowDates = recent.slice(-days);
  const scored = [];
  for (const entry of concepts.values()) {
    const points = windowDates.map((date) => entry.points.get(date)).filter(Boolean);
    if (!points.length) continue;
    const total = points.reduce((sum, point) => sum + point.amount, 0);
    scored.push({ code: entry.code, name: entry.name, total, points });
  }
  scored.sort((a, b) => b.total - a.total);
  const inflow = scored.filter((item) => item.total > 0).slice(0, 6);
  const outflow = scored.filter((item) => item.total < 0).slice(-4).reverse();
  const picks = [...inflow, ...outflow];
  const payload = {
    builtFor: windowDates.at(-1).replaceAll("-", ""),
    closed: true,
    builtAt: new Date().toISOString(),
    source: "narrative-radar-panel",
    days,
    dates: windowDates,
    series: picks.map((item) => ({ code: item.code, name: item.name, points: item.points }))
  };
  await store.kvSet(`fund-flow:window:${days}`, payload);
  console.log(`${days} 日：${windowDates.length} 个交易日 ${windowDates[0]}~${windowDates.at(-1)}，${picks.length} 条线（流入 ${inflow.length} / 流出 ${outflow.length}）`);
}
