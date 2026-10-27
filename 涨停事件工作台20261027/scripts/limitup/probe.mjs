// 字段探针（一次性）：确认 Wind 能否返回「涨停时间 / 开板次数 / 封单额」等涨停事件字段。
// 用法：node --env-file=.env scripts/limitup/probe.mjs [YYYYMMDD]
//
// 只打印结果，不落库、不改任何快照。用于在写 limit-engine.js 之前锁定可用字段。
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { callWindTool, getApiKeys, isMockMode } from "../../api/_lib/short-emotion/wind-client.js";

// Electron-as-node 的 stdout 有时不落盘，所有结果同时写一份报告文件，保证可读回
const REPORT_PATH = fileURLToPath(new URL("./probe-report.txt", import.meta.url));
const report = [];
const log = (line = "") => { report.push(line); console.log(line); };
const flush = () => writeFileSync(REPORT_PATH, report.join("\n"), "utf8");

function localDate(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(date);
  const value = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${value.year}${value.month}${value.day}`;
}

const argDay = String(process.argv[2] || "");
const day = /^\d{8}$/.test(argDay) ? argDay : localDate();

// 与 engine.js 完全一致的解包逻辑（那边没有 export，这里复制一份保持口径一致）
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
function rowsOf(payload) {
  return tables(payload).flatMap(objects);
}

const PROBES = [
  { id: "P1", note: "基线：涨停名单（引擎现有写法，无字段限定）",
    call: () => ["stock_data", "search_stocks", { question: `筛选${day}收盘价等于当日涨停价的沪深A股` }] },
  { id: "P2", note: "显式点名：涨跌停时间 / 交易时间 / 涨跌停状态",
    call: () => ["stock_data", "search_stocks", { question: `筛选${day}涨停的沪深A股并返回Wind代码、证券简称、涨跌停状态、涨跌停时间、交易时间` }] },
  { id: "P3", note: "显式点名：首次/最后涨停时间 / 涨停打开次数",
    call: () => ["stock_data", "search_stocks", { question: `筛选${day}涨停的沪深A股并返回Wind代码、证券简称、首次涨停时间、最后涨停时间、涨停打开次数` }] },
  { id: "P4", note: "显式点名：封单额 / 封单量 / 封单比",
    call: () => ["stock_data", "search_stocks", { question: `筛选${day}涨停的沪深A股并返回Wind代码、证券简称、封单额、封单量、封单比、涨停封成比` }] },
  { id: "P5", note: "概念与行业字段（概念聚合用）",
    call: () => ["stock_data", "search_stocks", { question: `筛选${day}涨停的沪深A股并返回Wind代码、证券简称、所属概念板块、所属申万行业、上市板` }] },
  { id: "P6", note: "备选通道：analytics_data 直问涨停时间",
    call: () => ["analytics_data", "get_financial_data", { question: `${day}涨停的沪深A股的证券简称与涨跌停时间及涨停打开次数` }] }
];

console.log(`探针日期 ${day} | Wind key ${getApiKeys().length} 个 | mock=${isMockMode()}`);
console.log("");

const findings = [];
let firstCode = null;

const KEY_FIELDS = ["涨跌停时间", "涨停时间", "首次涨停时间", "最后涨停时间", "涨停打开次数", "开板次数", "封单额", "封单量", "封单比", "涨跌停状态", "所属概念板块", "所属申万行业", "交易时间"];

for (const probe of PROBES) {
  const [serverType, toolName, params] = probe.call();
  log(`──── ${probe.id} ${probe.note} ────`);
  log(`${serverType}.${toolName}: ${String(params.question).slice(0, 90)}`);
  try {
    const payload = unpackWind(await callWindTool(serverType, toolName, params));
    const table = tables(payload);
    const columns = table.flatMap((item) => item.columns.map((column) => column.name));
    const unique = [...new Set(columns)];
    const rows = rowsOf(payload);
    log(`✓ 表${table.length}个 行${rows.length}条`);
    log(`  列名: ${unique.length ? unique.join(" | ") : "(无表格结构)"}`);
    if (rows[0]) {
      log(`  首行: ${JSON.stringify(rows[0]).slice(0, 600)}`);
      firstCode ||= rows[0]["Wind代码"] || rows[0].code || null;
      const stats = KEY_FIELDS.filter((key) => unique.includes(key))
        .map((key) => `${key}=${rows.filter((row) => row[key] != null && row[key] !== "").length}/${rows.length}`);
      if (stats.length) log(`  非空: ${stats.join(", ")}`);
    }
    findings.push({ id: probe.id, status: "ok", rows: rows.length, columns: unique });
  } catch (error) {
    const message = String(error?.message || error);
    log(`✗ ${message.slice(0, 400)}`);
    findings.push({ id: probe.id, status: "fail", error: message.slice(0, 300) });
  }
  log("");
  flush();
}

// 逐字段探针：get_stock_price_indicators 的 indexes 参数（逗号分隔，不受无空格限制）
const probeCode = firstCode || "000678.SZ";
const metricGroups = [
  ["时间类", "涨跌停时间,涨停时间,首次涨停时间,最后涨停时间,交易时间"],
  ["炸板类", "涨停打开次数,开板次数,涨停打开时长"],
  ["封单类", "封单额,封单量,封单比,封成比"],
  ["基础类", "涨跌幅,成交额,换手率,量比,总市值,流通市值,最新价,最高价,最低价"]
];
for (const [label, indexes] of metricGroups) {
  log(`──── P7-${label} get_stock_price_indicators(${probeCode}) ────`);
  log(`indexes: ${indexes}`);
  try {
    const payload = unpackWind(await callWindTool("stock_data", "get_stock_price_indicators", { windcode: probeCode, indexes }));
    const unique = [...new Set(tables(payload).flatMap((item) => item.columns.map((column) => column.name)))];
    const rows = rowsOf(payload);
    log(`✓ 行${rows.length}条 列名: ${unique.length ? unique.join(" | ") : "(无表格结构)"}`);
    if (rows[0]) log(`  首行: ${JSON.stringify(rows[0]).slice(0, 500)}`);
  } catch (error) {
    log(`✗ ${String(error?.message || error).slice(0, 400)}`);
  }
  log("");
  flush();
}

log("════ 汇总 ════");
for (const item of findings) {
  log(item.status === "ok"
    ? `${item.id} ✓ ${item.rows}行  ${item.columns.join(",").slice(0, 200)}`
    : `${item.id} ✗ ${item.error}`);
}
flush();
process.exit(0);
