// 字段探针 第四轮：锁定最终取数配方（今日封板时间 / 今日概念 / 历史涨停名单），并确认失败规律。
// 用法：node --env-file=.env scripts/limitup/probe4.mjs [YYYYMMDD] [上一交易日YYYYMMDD]
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { callWindTool, getApiKeys } from "../../api/_lib/short-emotion/wind-client.js";

const REPORT_PATH = fileURLToPath(new URL("./probe4-report.txt", import.meta.url));
const report = [];
const log = (line = "") => { report.push(line); console.log(line); };
const flush = () => writeFileSync(REPORT_PATH, report.join("\n"), "utf8");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function localDate(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(date);
  const value = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${value.year}${value.month}${value.day}`;
}
const day = /^\d{8}$/.test(String(process.argv[2] || "")) ? process.argv[2] : localDate();
const prevDay = /^\d{8}$/.test(String(process.argv[3] || "")) ? process.argv[3] : "20261023";

function unpackWind(outer) {
  if (outer?.error?.code) throw new Error(`${outer.error.code}: ${outer.error.message || "Wind调用失败"}`);
  if (outer?.isError) throw new Error(outer?.content?.[0]?.text || "Wind调用失败");
  const text = outer?.content?.find?.((item) => item.type === "text")?.text;
  if (!text) return outer;
  try {
    const inner = JSON.parse(text);
    if (inner?.error) throw new Error(inner.error.message || JSON.stringify(inner.error));
    return inner;
  } catch (error) {
    if (error instanceof SyntaxError) return { data: text };
    throw error;
  }
}
function tables(payload) {
  const value = payload?.data?.data ?? payload?.data;
  if (Array.isArray(value)) return value.filter((item) => item?.columns && Array.isArray(item.rows));
  return value?.columns && Array.isArray(value.rows) ? [value] : [];
}
function objects(table) {
  if (!table) return [];
  const names = table.columns.map((item) => item.name);
  return table.rows.map((row) => Object.fromEntries(names.map((name, index) => [name, row[index]])));
}
const rowsOf = (payload) => tables(payload).flatMap(objects);

async function fetchRows(question, { attempts = 2, gap = 2500 } = {}) {
  const trials = [];
  for (let i = 1; i <= attempts; i += 1) {
    try {
      const rows = rowsOf(unpackWind(await callWindTool("stock_data", "search_stocks", { question })));
      trials.push(rows.length);
      if (rows.length) return { rows, trials };
    } catch (error) {
      trials.push(`err:${String(error?.message || error).slice(0, 60)}`);
    }
    if (i < attempts) await sleep(gap);
  }
  return { rows: [], trials };
}

const PROBES = [
  { id: "T1", note: "封板时间 + 概念 能否同表（概念聚合关键）", q: `筛选${day}涨停的沪深A股并返回Wind代码、证券简称、首次封板时间、所属概念板块` },
  { id: "T2", note: "纯概念字段（不含『涨跌停时间』字样）", q: `筛选${day}涨停的沪深A股并返回Wind代码、证券简称、所属概念板块、申万行业明细` },
  { id: "T3", note: "历史涨停名单（引擎现有措辞，晋级率依赖）", q: `筛选${prevDay}收盘价等于当日涨停价的沪深A股` },
  { id: "T4", note: "历史日 + 封板时间措辞（确认历史确实不返回封板时间）", q: `筛选${prevDay}涨停的沪深A股并返回Wind代码、证券简称、首次封板时间、最后封板时间` }
];

log(`第四轮探针 ${day}（上一交易日 ${prevDay}）| Wind key ${getApiKeys().length} 个`);
log("");

for (const probe of PROBES) {
  log(`──── ${probe.id} ${probe.note} ────`);
  log(`question: ${probe.q}`);
  const { rows, trials } = await fetchRows(probe.q);
  log(`  各次尝试行数: ${JSON.stringify(trials)}`);
  if (rows.length) {
    const keys = Object.keys(rows[0]);
    log(`✓ 行${rows.length}条 | 唯一代码${new Set(rows.map((r) => r["Wind代码"])).size}个`);
    log(`  列名: ${keys.join(" | ")}`);
    const timeKey = keys.find((key) => /涨跌停时间/.test(key));
    if (timeKey) {
      const clocks = rows.map((r) => String(r[timeKey] || "").match(/\d{2}:\d{2}:\d{2}/)?.[0]).filter(Boolean).sort();
      log(`  ${timeKey}: 可解析${clocks.length}/${rows.length} 最早${clocks[0] || "-"} 最晚${clocks.at(-1) || "-"}`);
    }
    const conceptKey = keys.find((key) => /所属概念板块/.test(key));
    if (conceptKey) {
      const counts = new Map();
      rows.forEach((row) => String(row[conceptKey] || "").split(/[;；]/).filter(Boolean).forEach((name) => counts.set(name, (counts.get(name) || 0) + 1)));
      const top = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10);
      log(`  去重概念${counts.size}个 Top10: ${top.map(([name, count]) => `${name}(${count})`).join(" ")}`);
    }
    log(`  前2行: ${JSON.stringify(rows.slice(0, 2)).slice(0, 700)}`);
  } else {
    log("  ✗ 全部为空");
  }
  log("");
  flush();
}

log("════ 小结 ════");
log("规律假设：question 措辞决定是否命中结构化事件表；命中失败时静默返回空表（不报错）。");
log("已确认可用：筛选{当日}涨停的沪深A股并返回Wind代码、证券简称、首次封板时间、最后封板时间 → 含『涨跌停时间』全时间戳");
flush();
process.exit(0);
