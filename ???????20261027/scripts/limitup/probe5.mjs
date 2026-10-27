// 字段探针 第五轮：昨日涨停溢价（个股级，可按首板/连板拆分）与集合竞价强度。
// 用法：node --env-file=.env scripts/limitup/probe5.mjs [YYYYMMDD] [上一交易日YYYYMMDD] [今日YYYYMMDD]
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { callWindTool, getApiKeys } from "../../api/_lib/short-emotion/wind-client.js";

const REPORT_PATH = fileURLToPath(new URL("./probe5-report.txt", import.meta.url));
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
const prevDay = /^\d{8}$/.test(String(process.argv[3] || "")) ? process.argv[3] : "20261026";

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

async function fetchRows(serverType, tool, question, { attempts = 2, gap = 2500 } = {}) {
  const trials = [];
  for (let i = 1; i <= attempts; i += 1) {
    try {
      const rows = rowsOf(unpackWind(await callWindTool(serverType, tool, { question })));
      trials.push(rows.length);
      if (rows.length) return { rows, trials };
    } catch (error) {
      trials.push(`err:${String(error?.message || error).slice(0, 80)}`);
    }
    if (i < attempts) await sleep(gap);
  }
  return { rows: [], trials };
}

const PROBES = [
  { id: "A1", note: "昨日涨停 → 今日涨跌幅（个股级，用于拆分首板/连板溢价）", tool: "stock_data.search_stocks",
    q: `筛选${prevDay}涨停的沪深A股并返回Wind代码、证券简称、${day}涨跌幅、${day}开盘涨幅` },
  { id: "A2", note: "引擎现措辞：昨日涨停股票今日最新涨跌幅排名", tool: "analytics_data.get_financial_data",
    q: `${prevDay}涨停股票在${day}的最新涨跌幅排名` },
  { id: "B1", note: "昨日涨停股今日集合竞价涨幅（竞价溢价）", tool: "analytics_data.get_financial_data",
    q: `${prevDay}涨停的沪深A股在${day}的集合竞价涨幅` },
  { id: "B2", note: "今日集合竞价涨幅排名（判断竞价强度分布）", tool: "stock_data.search_stocks",
    q: `${day}沪深A股集合竞价涨幅排名` },
  { id: "B3", note: "今日涨停股能否带开盘价/量比（竞价强度替代口径）", tool: "stock_data.search_stocks",
    q: `筛选${day}涨停的沪深A股并返回Wind代码、证券简称、今日开盘价、昨日收盘价、量比` }
];

log(`第五轮探针 ${day}（上一交易日 ${prevDay}）| Wind key ${getApiKeys().length} 个`);
log("");

for (const probe of PROBES) {
  const [serverType, toolName] = probe.tool.split(".");
  log(`──── ${probe.id} ${probe.note} ────`);
  log(`tool: ${probe.tool}`);
  log(`question: ${probe.q}`);
  try {
    const { rows, trials } = await fetchRows(serverType, toolName, probe.q);
    log(`  各次尝试行数: ${JSON.stringify(trials)}`);
    if (rows.length) {
      const keys = Object.keys(rows[0]);
      log(`✓ 行${rows.length}条 | 唯一代码${new Set(rows.map((r) => r["Wind代码"])).size}个`);
      log(`  列名: ${keys.join(" | ")}`);
      for (const key of keys) {
        const values = rows.map((row) => Number(row[key])).filter((value) => Number.isFinite(value));
        if (values.length >= Math.max(3, rows.length * 0.5)) {
          const sorted = [...values].sort((a, b) => a - b);
          log(`  数值列 ${key}: n=${values.length} min=${sorted[0]} 中位=${sorted[Math.floor(sorted.length / 2)]} max=${sorted.at(-1)}`);
        }
      }
      log(`  前3行: ${JSON.stringify(rows.slice(0, 3)).slice(0, 600)}`);
    } else {
      log("  ✗ 全部为空");
    }
  } catch (error) {
    log(`  ✗ 异常: ${String(error?.message || error).slice(0, 200)}`);
  }
  log("");
  flush();
}

flush();
process.exit(0);