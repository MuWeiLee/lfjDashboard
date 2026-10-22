import { promises as fs } from "node:fs";
import { spawn } from "node:child_process";
import path from "node:path";
import { createDebriefAgent } from "./ai-debrief-agent.mjs";
import { parseTerminal910, parseTerminal913, terminalSnapshotUsable } from "./wind-terminal-data-parser.mjs";
import { generateDeepLocalDebrief, validateDebrief } from "./deep-debrief-local-agent.mjs";

const THEMES = [
  {
    id: "ai-app",
    name: "AI应用 / GEO / 多模态",
    shortName: "AI应用",
    keywords: ["AI应用", "GEO", "多模态", "智能体", "AI Agent", "AIGC", "Sora", "ChatGPT", "AI语料", "互联网传媒", "AI营销"],
    logic: "模型能力向商业化场景扩散，交易核心由技术发布转向流量入口、内容生产和可兑现收入。",
    chain: ["基础模型", "智能体与工具", "内容/营销/GEO", "行业应用", "收入兑现"]
  },
  {
    id: "ai-infra",
    name: "AI算力 / 光通信 / CPO",
    shortName: "AI算力与光通信",
    keywords: ["AI算力", "光通信", "CPO", "OCS", "光模块", "英伟达产业链", "东数西算", "算力租赁"],
    logic: "算力需求沿服务器、交换、光互联与数据中心扩散，成交承载和订单兑现决定持续性。",
    chain: ["AI芯片", "服务器", "交换机", "光模块/CPO", "数据中心"]
  },
  {
    id: "semiconductor",
    name: "半导体 / 存储 / HBM",
    shortName: "半导体与存储",
    keywords: ["半导体", "存储器", "HBM", "模拟芯片", "芯片设计", "集成电路", "存储芯片"],
    logic: "AI硬件景气向存储、模拟和国产替代扩散，需要用业绩兑现区分趋势主线与情绪补涨。",
    chain: ["设备材料", "芯片设计", "晶圆制造", "先进封装", "存储/HBM", "终端需求"]
  }
];

// 父主线规则：先按产业叙事合并相似小题材，再在父主线内部判断分支阶段。
// 规则顺序代表语义优先级，避免“中核系”被并入泛电力、“航发系”被并入泛央企。
const THEME_FAMILIES = [
  { id: "coal-energy", name: "煤炭与煤化工产业链", test: /煤炭|煤矿|煤化工|中煤系|焦煤|焦炭/, keywords: ["煤炭", "煤矿", "煤化工", "焦煤", "焦炭"], logic: "煤价、供给约束、需求改善与央企资源整合共同驱动煤炭链，必须结合成交承载、分支扩散和容量股响应判断持续性。", chain: ["资源供给", "煤炭开采", "焦煤焦炭", "煤化工", "电力与工业需求"] },
  { id: "agriculture", name: "农业与种植产业链", test: /农业|种植|种业|粮食|大豆|玉米|农产品/, keywords: ["农业", "种植", "种业", "粮食", "大豆", "玉米"], logic: "农产品价格、天气、政策和供需预期共同驱动农业链，需验证种植、种业和加工环节是否同步扩散。", chain: ["种子与农资", "种植", "粮食与农产品", "加工", "渠道消费"] },
  { id: "steel-materials", name: "钢铁与工业材料产业链", test: /钢铁|特钢|铁矿|黑色金属/, keywords: ["钢铁", "特钢", "铁矿", "黑色金属"], logic: "钢材价格、供给约束、基建制造需求和利润修复共同驱动钢铁链，需观察容量品种和上下游是否同步。", chain: ["铁矿与原料", "钢铁冶炼", "特钢材料", "加工制造", "基建与工业需求"] },
  { id: "internet-content", name: "互联网内容与营销", test: /互联网传媒|互联网营销|数字营销|广告营销|短视频|直播电商|内容电商|社交电商|社交媒体|网络直播|网红经济|快手|抖音|字节跳动|小红书|微信小店/, keywords: ["互联网内容", "数字营销", "短视频", "直播电商", "内容社区", "快手", "抖音", "小红书"], logic: "平台名称、内容社区、短视频、直播电商和数字营销共享流量商业化驱动，必须归并后再判断哪个业务分支真正获得资金与业绩共振。", chain: ["平台流量", "内容生态", "广告营销", "直播/社交电商", "商业化兑现"] },
  { id: "nuclear-energy", name: "核能产业链", test: /核聚变|可控核聚变|核电|中核系|核能|核工业/, keywords: ["核聚变", "可控核聚变", "核电", "中核系", "核能"], logic: "核聚变与核电共享核工业政策、设备、材料和工程建设叙事，但保留各自分支周期与股票池。", chain: ["政策/项目", "核级材料", "关键设备", "工程建设", "运营/技术验证"] },
  { id: "aerospace", name: "航空航天产业链", test: /商业航天|卫星|航天装备|航发系|航空发动机|低空经济/, keywords: ["商业航天", "卫星", "航天装备", "航发", "低空经济"], logic: "发射、卫星、航空发动机与低空应用共享高端装备和政策驱动，分支持续性取决于订单与核心股承接。", chain: ["材料部件", "核心设备", "整机制造", "发射/运营", "应用服务"] },
  { id: "artificial-intelligence", name: "人工智能产业链", test: /AI应用|多模态|智能体|AIGC|GEO|算力|光通信|CPO|光模块|数据中心|小基站|基站|5G/, keywords: ["AI应用", "多模态", "智能体", "AIGC", "算力", "光通信", "CPO", "光模块"], logic: "应用、算力与光互联属于同一AI资本开支和商业化叙事，必须区分领涨分支、修复分支与退潮分支。", chain: ["芯片/算力", "服务器", "光互联", "模型工具", "行业应用"] },
  { id: "semiconductor", name: "半导体产业链", test: /半导体|存储|HBM|芯片|集成电路|先进封装/, keywords: ["半导体", "存储", "HBM", "芯片", "集成电路", "先进封装"], logic: "设备材料、设计制造、封装存储共享国产替代叙事，但各分支景气与资金周期可能明显错位。", chain: ["设备材料", "芯片设计", "晶圆制造", "先进封装", "存储/终端"] },
  { id: "robotics", name: "机器人产业链", test: /机器人|人形机器人|减速器|执行器|机器视觉/, keywords: ["机器人", "人形机器人", "减速器", "执行器", "机器视觉"], logic: "核心零部件、执行器、整机和应用落地属于同一量产叙事，分支状态由订单和资金扩散决定。", chain: ["材料/零部件", "减速器", "执行器", "整机", "应用落地"] },
  { id: "healthcare", name: "医药产业链", test: /医药|医疗服务|创新药|独家药|CRO|CXO|ADC|中药|疫苗|医疗器械|生物制药|仿制药|原料药/, keywords: ["医药", "医疗服务", "创新药", "独家药", "CRO", "CXO", "ADC", "中药", "疫苗", "医疗器械"], logic: "研发服务、创新药、ADC、生物制药、医疗器械和医疗服务共享医药产业景气叙事，但临床、订单、政策和业绩兑现必须按分支验证。", chain: ["研发服务/CRO", "创新药/ADC", "原料与生产", "医疗器械", "医疗服务"] },
  { id: "consumer", name: "消费产业链", test: /黄酒|白酒|啤酒|食品|饮料|零售|旅游|酒店|家电|消费/, keywords: ["黄酒", "白酒", "食品饮料", "零售", "旅游", "家电"], logic: "酒类、食品饮料与可选消费共享需求和价格传导，但持续性必须结合消费场景、渠道库存和业绩兑现判断。", chain: ["消费场景", "品牌产品", "渠道库存", "价格与销量", "业绩兑现"] },
  { id: "new-energy", name: "新能源产业链", test: /光伏|风电|锂电|储能|新能源车|电动车|充电桩/, keywords: ["光伏", "风电", "锂电", "储能", "新能源车", "电动车"], logic: "新能源各分支共享需求与政策周期，但供需、价格和盈利拐点必须分支验证。", chain: ["上游材料", "核心设备", "系统集成", "终端制造", "运营消纳"] },
  { id: "power-grid", name: "电力与电网产业链", test: /电力设备|电网|特高压|智能电网|大唐系|发电运营/, keywords: ["电力设备", "电网", "特高压", "智能电网", "大唐系"], logic: "发电运营、电网投资与设备订单共同构成电力链，分支强弱用于识别资金传导方向。", chain: ["发电运营", "输变电", "电网设备", "系统建设", "电力服务"] },
  { id: "central-soe", name: "央企改革主线", test: /诚通系|国新系|机科院系|中钢研系|国资云|央企改革/, keywords: ["诚通系", "国新系", "机科院系", "中钢研系", "央企改革"], logic: "不同央企集团只有在改革催化和资金共振同时出现时才合并为主线，单一集团异动仅视为分支。", chain: ["改革催化", "集团平台", "资产整合", "专业化整合", "价值重估"] },
  { id: "innovative-materials", name: "新材料产业链", test: /稀土|新材料|金属材料|有色金属|碳纤维|超导材料/, keywords: ["稀土", "新材料", "金属材料", "碳纤维", "超导材料"], logic: "材料分支需同时验证下游需求、价格趋势和核心公司的业绩传导。", chain: ["资源供给", "材料加工", "关键部件", "高端制造", "终端需求"] }
];
const STOCK_BRANCH_RULES = [
  { theme: /互联网内容与营销/, rules: [[/快手/, "快手生态"], [/抖音|字节跳动/, "抖音/字节生态"], [/小红书/, "小红书生态"], [/短视频|网络直播|网红经济/, "短视频与直播"], [/直播电商|内容电商|社交电商|微信小店/, "内容与社交电商"], [/互联网营销|数字营销|广告营销/, "数字营销"]] },
  { theme: /机器人/, rules: [[/减速器|齿轮|谐波/, "减速器"], [/执行器|丝杠|关节|伺服/, "执行器与关节"], [/机器视觉|视觉传感/, "机器视觉"], [/宇树|人形机器人|具身智能/, "人形机器人"], [/工业机器人|机器人/, "工业机器人"]] },
  { theme: /医药/, rules: [[/CRO|CXO|研发服务/, "CRO/CXO"], [/创新药|ADC|生物制药/, "创新药"], [/医疗器械/, "医疗器械"], [/中药/, "中药"], [/医药商业|药店|流通/, "医药商业"]] },
  { theme: /新能源/, rules: [[/光伏|逆变器/, "光伏"], [/储能|电池/, "储能与电池"], [/风电/, "风电"], [/充电桩|新能源车|电动车/, "新能源车与充电"]] },
  { theme: /人工智能/, rules: [[/光模块|CPO|光通信/, "光通信/CPO"], [/算力|服务器|数据中心/, "AI算力"], [/应用|智能体|AIGC|多模态/, "AI应用"]] },
  { theme: /半导体/, rules: [[/设备|材料/, "半导体设备材料"], [/存储|HBM/, "存储/HBM"], [/封装/, "先进封装"], [/芯片设计|集成电路/, "芯片设计"]] },
  { theme: /核能/, rules: [[/核聚变|可控核聚变/, "核聚变"], [/核电|核能|中核/, "核电"]] }
];
const MAINLINE_SLOT_COUNT = 3;
const AUTO_THEME_REFRESH_SLOTS = [
  { key: "0935", minutes: 9 * 60 + 35, label: "09:35" },
  { key: "1000", minutes: 10 * 60, label: "10:00" },
  { key: "1330", minutes: 13 * 60 + 30, label: "13:30" },
  { key: "1430", minutes: 14 * 60 + 30, label: "14:30" },
  { key: "1500", minutes: 15 * 60, label: "15:00" }
];
const AUTO_REVIEW_REFRESH_SLOTS = [
  { key: "1130", minutes: 11 * 60 + 30, label: "11:30" },
  { key: "1530", minutes: 15 * 60 + 30, label: "15:30" }
];
const THEME_SNAPSHOT_INDEXES = "中文简称,最新成交价,涨跌幅,成交额,5日涨跌幅,20日涨跌幅,上涨家数,下跌家数,平盘家数,当日主力净流入额,近5日主力净流入额";
const STOCK_SNAPSHOT_INDEXES = "中文简称,最新成交价,涨跌幅,成交额,换手率,量比,总市值2,市盈率(TTM),市净率,当日主力净流入额,当日主力净流入占比,近5日主力净流入额,近5日主力净流入占比,涨停价,交易状态";
const DEBRIEF_FRAMEWORK = [
  "市场阶段与关键位置：指数、万得全A量能、广度和风险偏好",
  "事件导火索：政策、产业、供需价格、订单业绩、海外映射及新闻新鲜度",
  "产业链传导：事件首先利好哪个环节，是否扩散到上下游和容量中军",
  "题材价格与资金：涨幅、成交额、主力流向、分支覆盖和持续性",
  "连板梯队：最高板、各高度家数、首板扩散、首封时间、开板质量和梯队完整度",
  "核心个股反馈：情绪先锋、容量中军、低位补涨、后排跟风和掉队",
  "周期与拥挤：启动、强化、高潮、分歧、退潮及异动/监管压力",
  "边际变化：与上一观察窗口相比是强化、切换、高位松动还是新逻辑试错",
  "次日推演：延续、分歧、证伪三种情景及具体验证变量"
];
// 交易形态、情绪样本、风格因子和选股标签只进入市场情绪层，禁止进入产业题材主线。
const NON_NARRATIVE_THEME_PATTERN = /打板|连板|首板|涨停|跌停|炸板|破板|一字板|反包|领涨|龙头|中军|补涨|跟风|竞价|抢筹|趋势股|突破股|放量股|缩量股|高开|低开|非.?ST|ST股|强势股|活跃股|高换手|低换手|高价股|低价股|微盘股|小盘股|大盘股|绩优股|亏损股|昨日|近\d+日|龙虎榜|融资融券|转融券|陆股通|基金重仓|机构重仓|北向重仓|高股息|红利|低波|动量|等权|全A|百元股|次新股|解禁|破净|破发|风格指数|成交额|成交量|成交主力|换手率|振幅|涨速|量比|市值|市盈率|市净率|TOP.?[0-9]+|前[0-9]+|后[0-9]+|排名|排行|榜单|样本池|股票池|入选|精选组合|精选指数|金股指数|策略指数|因子指数|点位贡献|上涨贡献|下跌贡献|资金流入前|资金流出前|买入前|卖出前/i;

const DEFAULT_STATE = {
  running: false,
  progress: null,
  lastError: null,
  generatedAt: null,
  asOf: null,
  source: "Wind AI Fin Market",
  decision: null,
  runs: []
};

function number(value) {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string") return null;
  const cleaned = value.replaceAll(",", "").replace(/[％%]/g, "").trim();
  // Wind may serialize large amounts (notably market cap) in scientific
  // notation, e.g. "5.73897e+10". Dropping the exponent distorts capacity
  // and liquidity scoring even when the raw Wind value is correct.
  const match = cleaned.match(/-?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?/);
  return match ? Number(match[0]) : null;
}

function round(value, digits = 2) {
  if (!Number.isFinite(value)) return null;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function clamp(value, min = 0, max = 100) {
  return Math.min(Math.max(value, min), max);
}

function todayShanghai() {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
}

function compactDate(date = new Date()) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).format(date).replaceAll("-", "");
}

function daysBefore(days) {
  const date = new Date();
  date.setDate(date.getDate() - days);
  return compactDate(date);
}

function collectTables(payload) {
  const tables = [];
  const queue = [payload];
  const seen = new Set();
  while (queue.length) {
    const value = queue.shift();
    if (!value || typeof value !== "object" || seen.has(value)) continue;
    seen.add(value);
    if (Array.isArray(value.columns) && Array.isArray(value.rows)) tables.push(value);
    for (const child of Object.values(value)) if (child && typeof child === "object") queue.push(child);
  }
  return tables;
}

function rowsFromPayload(payload) {
  const output = [];
  for (const table of collectTables(payload)) {
    const keys = table.columns.map((column, index) => column?.name || column?.title || `field${index}`);
    const units = Object.fromEntries(table.columns.map((column, index) => [keys[index], column?.unit || table?.unit?.[keys[index]] || null]));
    for (const row of table.rows) {
      if (Array.isArray(row)) output.push({ ...Object.fromEntries(keys.map((key, index) => [key, row[index]])), __units: units });
      else if (row && typeof row === "object") output.push(row);
    }
  }
  return output;
}

function summarizeThemeLadder(inputStocks, source = "题材成分股逐股统计") {
  const stockMap = new Map();
  for (const stock of inputStocks || []) {
    if (!stock?.code && !stock?.name) continue;
    const key = stock.code || stock.name;
    const prior = stockMap.get(key) || {};
    stockMap.set(key, { ...prior, ...stock, code: stock.code || prior.code || null, name: stock.name || prior.name || null });
  }
  const stocks = [...stockMap.values()];
  const height = Math.max(0, ...stocks.map((item) => Number(item.boards) || 1));
  const tiers = [...new Set(stocks.map((item) => Number(item.boards) || 1))].sort((a, b) => b - a);
  const counts = Object.fromEntries(tiers.map((tier) => [tier, stocks.filter((item) => (Number(item.boards) || 1) === tier).length]));
  const score = clamp(height * 10 + stocks.length * 3 + Math.max(0, tiers.length - 1) * 8 - stocks.reduce((sum, item) => sum + (Number(item.brokenCount) || 0), 0) * 2, 0, 100);
  const shape = !stocks.length ? "暂无已确认涨停成分股" : height >= 4 && tiers.length >= 3 ? "高标与中低位梯队完整" : height >= 3 && tiers.length >= 2 ? "有高度且存在接力层" : height >= 2 ? "有连板高度但梯队偏薄" : stocks.length >= 3 ? "首板形成扩散，接力高度待确认" : "首板数量偏少，尚未形成接力高度";
  return { observed: stocks.length > 0, height: stocks.length ? height : null, tiers, counts, stocks, limitUpCount: stocks.length ? stocks.length : null, score: stocks.length ? round(score, 0) : null, shape: stocks.length ? shape : null, source: stocks.length ? source : null };
}

function parseThemeLadder(payload) {
  const rows = rowsFromPayload(payload);
  const stocks = rows.map((row) => ({
    code: textField(row, [/Wind代码/i, /证券代码/i, /windcode/i]),
    name: textField(row, [/证券简称/i, /股票简称/i, /名称/i]),
    boards: metric(row, [/连续涨停天数/i, /连板数/i, /几连板/i, /连板高度/i]),
    firstLimitTime: textField(row, [/首次涨停时间/i, /首封时间/i]),
    lastLimitTime: textField(row, [/最后涨停时间/i, /终封时间/i, /最后封板时间/i]),
    brokenCount: metric(row, [/开板次数/i, /炸板次数/i]),
    sealedAmount: metricBillions(row, [/封单金额/i, /涨停封单额/i]),
    sealedRatio: metric(row, [/封单占成交额/i, /封成比/i]),
    turnoverRate: metric(row, [/换手率/i]),
    r10: metric(row, [/近10日涨跌幅/i, /10日涨跌幅/i]),
    r30: metric(row, [/近30日涨跌幅/i, /30日涨跌幅/i])
  })).filter((item) => item.name || item.code);
  return summarizeThemeLadder(stocks);
}
function limitTimeMinutes(value) {
  const match = String(value || "").match(/(?:T|\s)?(\d{1,2}):(\d{2})/);
  return match ? Number(match[1]) * 60 + Number(match[2]) : null;
}

function scoreLimitUpStrength(stock = {}) {
  const first = limitTimeMinutes(stock.firstLimitTime);
  const last = limitTimeMinutes(stock.lastLimitTime);
  const brokenKnown = stock.brokenCount !== null && stock.brokenCount !== undefined && Number.isFinite(Number(stock.brokenCount));
  const broken = brokenKnown ? Number(stock.brokenCount) : 0;
  const boards = Number(stock.boards) || 1;
  const timeScore = first == null ? 45 : first <= 9 * 60 + 35 ? 95 : first <= 10 * 60 ? 85 : first <= 11 * 60 + 30 ? 72 : first <= 14 * 60 ? 56 : 38;
  const sealScore = last == null ? 50 : last <= 10 * 60 ? 88 : last <= 13 * 60 + 30 ? 72 : last <= 14 * 60 + 30 ? 58 : 42;
  const score = clamp(timeScore * .4 + sealScore * .2 + Math.min(boards * 10, 35) + Math.min(Number(stock.sealedRatio) || 0, 20) - broken * 7, 0, 100);
  const label = score >= 82 ? "强封板" : score >= 65 ? "较强封板" : score >= 48 ? "分歧封板" : "弱封板/尾盘板";
  return { score: round(score, 0), label, firstLimitTime: stock.firstLimitTime || null, lastLimitTime: stock.lastLimitTime || null, brokenCount: brokenKnown ? broken : null, boards };
}

function recalculateThemeStrength(theme) {
  const price = clamp(45 + (Number(theme.changePct) || 0) * 9 + (Number(theme.r5) || 0) * .8, 0, 100);
  const capital = Number.isFinite(theme.mainFlow) ? clamp(50 + theme.mainFlow * 2, 0, 100) : Number.isFinite(theme.turnover) ? clamp(35 + Math.log10(Math.max(theme.turnover, 1)) * 22, 0, 100) : 40;
  const breadth = Number.isFinite(theme.breadth) ? clamp(theme.breadth, 0, 100) : clamp(35 + Number(theme.activeBranchCount || 0) * 18, 0, 100);
  const ladder = Number.isFinite(theme.ladder?.score) ? theme.ladder.score : 30;
  const catalyst = theme.catalysts?.crossValidated ? 92 : theme.catalysts?.sourceTypes?.some((item) => item !== "wind-news") && theme.catalysts?.items?.length >= 2 ? 72 : theme.catalysts?.items?.length >= 3 ? 78 : theme.catalysts?.items?.length ? 60 : 25;
  const continuity = Number.isFinite(theme.r3 ?? theme.r5) ? clamp(45 + Number(theme.r3 ?? theme.r5) * 4, 0, 100) : 45;
  const core = clamp(35 + Number(theme.sentimentLeaderCount || 0) * 14 + Math.min(Number(theme.ladder?.height || 0) * 6, 24), 0, 100);
  const capacity = Number.isFinite(theme.turnover) ? clamp(25 + Math.log10(Math.max(theme.turnover, 1)) * 28, 0, 100) : 35;
  const crowdingPenalty = Number(theme.r5) > 25 ? Math.min((Number(theme.r5) - 25) * .35, 10) : 0;
  const total = price * .12 + capital * .18 + breadth * .15 + ladder * .15 + catalyst * .15 + continuity * .10 + core * .10 + capacity * .05 - crowdingPenalty;
  return { ...theme, strength: round(clamp(total, 0, 100), 0), strengthBreakdown: { price: round(price, 0), capital: round(capital, 0), breadth: round(breadth, 0), ladder: round(ladder, 0), catalyst: round(catalyst, 0), continuity: round(continuity, 0), core: round(core, 0), capacity: round(capacity, 0), crowdingPenalty: round(crowdingPenalty, 0) } };
}

function parseThemeCatalysts(payload) {
  const candidates = [];
  const queue = [payload];
  const seen = new Set();
  while (queue.length) {
    const value = queue.shift();
    if (!value || typeof value !== "object" || seen.has(value)) continue;
    seen.add(value);
    if (!Array.isArray(value)) {
      const title = textField(value, [/标题/i, /^title$/i, /新闻标题/i]);
      const summary = textField(value, [/摘要/i, /^summary$/i, /内容/i, /^text$/i]);
      const date = textField(value, [/时间/i, /日期/i, /publish/i, /date/i]);
      const source = textField(value, [/来源/i, /^source$/i]);
      if (title && title.length >= 6) candidates.push({ title, summary: summary.slice(0, 240), date, source, url: value.url || value.link || "", sourceType: value.sourceType || "" });
    }
    for (const child of Object.values(value)) if (child && typeof child === "object") queue.push(child);
  }
  for (const row of rowsFromPayload(payload)) {
    const title = textField(row, [/标题/i, /^title$/i, /新闻标题/i]);
    if (title) candidates.push({ title, summary: textField(row, [/摘要/i, /内容/i]).slice(0, 240), date: textField(row, [/时间/i, /日期/i]), source: textField(row, [/来源/i]) });
  }
  const items = [...new Map(candidates.map((item) => [item.title, item])).values()].slice(0, 6);
  const joined = items.map((item) => `${item.title}${item.summary}`).join(" ");
  const type = /政策|规划|会议|监管|补贴|指导意见/.test(joined) ? "政策催化" : /涨价|价格|供需|库存|产能/.test(joined) ? "供需/价格催化" : /订单|中标|业绩|利润|收入/.test(joined) ? "订单/业绩催化" : /发布|模型|产品|大会|展会|试验|量产/.test(joined) ? "产业事件催化" : items.length ? "新闻事件催化" : "催化待核验";
  return { items, type, primary: items[0] || null, quality: items.length >= 3 ? "证据较充分" : items.length ? "单点催化，需交叉验证" : "未取到有效事件" };
}

function findField(row, tests) {
  for (const [key, value] of Object.entries(row || {})) {
    if (tests.some((test) => test.test(String(key)))) return value;
  }
  return null;
}

function metric(row, tests) {
  return number(findField(row, tests));
}

function rowText(row) {
  return Object.values(row || {}).filter((value) => value != null).join(" ");
}

function textField(row, tests) {
  const value = findField(row, tests);
  return value == null ? "" : String(value).trim();
}

function metricBillions(row, tests) {
  for (const [key, value] of Object.entries(row || {})) {
    if (!tests.some((test) => test.test(String(key)))) continue;
    const parsed = number(value);
    if (!Number.isFinite(parsed)) return null;
    const unit = String(row?.__units?.[key] || "");
    if (unit.includes("百万元")) return parsed / 100;
    if (unit.includes("万元")) return parsed / 10_000;
    if (unit === "元" || unit.includes("人民币元")) return parsed / 100_000_000;
    return parsed;
  }
  return null;
}

function parseWindTime(value, fallbackDate = "") {
  const text = String(value || "").trim();
  const iso = text.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?/);
  if (iso) return new Date(`${iso[1]}-${iso[2]}-${iso[3]}T${iso[4]}:${iso[5]}:${iso[6] || "00"}+08:00`);
  const compact = text.match(/^(\d{4})(\d{2})(\d{2})\s+(\d{2}):(\d{2})(?::(\d{2}))?/);
  if (compact) return new Date(`${compact[1]}-${compact[2]}-${compact[3]}T${compact[4]}:${compact[5]}:${compact[6] || "00"}+08:00`);
  const date = String(fallbackDate || text).match(/(\d{4})[-/]?(\d{2})[-/]?(\d{2})/);
  return date ? new Date(`${date[1]}-${date[2]}-${date[3]}T15:00:00+08:00`) : null;
}

function shanghaiClock(date = new Date()) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit", weekday: "short", hour: "2-digit", minute: "2-digit", hour12: false }).formatToParts(date).map((part) => [part.type, part.value]));
  const minutes = Number(parts.hour) * 60 + Number(parts.minute);
  const day = `${parts.year}-${parts.month}-${parts.day}`;
  const phase = minutes < 570 ? "preopen" : minutes <= 690 ? "live" : minutes < 780 ? "break" : minutes <= 900 ? "live" : "postclose";
  return { day, minutes, phase, weekday: parts.weekday, hour: Number(parts.hour), minute: Number(parts.minute), hhmm: `${parts.hour}:${parts.minute}` };
}

function assessFreshness(rows, now = new Date()) {
  const timestamps = rows.map((row) => parseWindTime(findField(row, [/交易时间/i, /数据时间/i, /更新时间/i, /^TIME$/i]), findField(row, [/^日期$/i, /最新交易日/i]))).filter((value) => value && Number.isFinite(value.getTime()));
  const latest = timestamps.length ? new Date(Math.max(...timestamps.map((value) => value.getTime()))) : null;
  const clock = shanghaiClock(now);
  const latestDay = latest ? new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).format(latest) : null;
  const latestMinutes = latest ? Number(new Intl.DateTimeFormat("en-US", { timeZone: "Asia/Shanghai", hour: "2-digit", minute: "2-digit", hour12: false }).format(latest).split(":")[0]) * 60 + Number(new Intl.DateTimeFormat("en-US", { timeZone: "Asia/Shanghai", hour: "2-digit", minute: "2-digit", hour12: false }).format(latest).split(":")[1]) : null;
  const ageMinutes = latest ? (now.getTime() - latest.getTime()) / 60_000 : Infinity;
  let isFresh = false;
  let label = "缺少Wind交易时间";
  if (clock.phase === "live") { isFresh = latestDay === clock.day && ageMinutes <= 10; label = isFresh ? "盘中实时" : "盘中数据超过10分钟"; }
  else if (clock.phase === "break") { isFresh = latestDay === clock.day && latestMinutes >= 685; label = isFresh ? "午间最新快照" : "午间快照不完整"; }
  else if (clock.phase === "postclose") { isFresh = latestDay === clock.day && latestMinutes >= 895; label = isFresh ? "当日收盘快照" : "当日收盘数据不完整"; }
  else { isFresh = latest && ageMinutes <= 72 * 60; label = isFresh ? "最近交易日收盘快照" : "盘前数据已过期"; }
  return { isFresh, phase: clock.phase, label, marketTimestamp: latest?.toISOString() || null, ageMinutes: Number.isFinite(ageMinutes) ? round(ageMinutes, 1) : null, maxAgeMinutes: clock.phase === "live" ? 10 : null };
}

function canonicalThemeName(name) {
  const clean = rawThemeName(name);
  if (/可控核聚变|核聚变/.test(clean)) return "核聚变";
  if (/中核系|核电|核能/.test(clean)) return "核电";
  if (/快手/.test(clean)) return "快手生态";
  if (/抖音|字节跳动/.test(clean)) return "抖音/字节生态";
  if (/小红书/.test(clean)) return "小红书生态";
  if (/短视频|网络直播|网红经济/.test(clean)) return "短视频与直播";
  if (/直播电商|内容电商|社交电商|微信小店/.test(clean)) return "内容与社交电商";
  if (/互联网营销|数字营销|广告营销/.test(clean)) return "数字营销";
  return clean || String(name || "").trim();
}

function rawThemeName(name) {
  return String(name || "").replace(/^\[(?:US|HK|A)\]/i, "").replace(/万得|概念|主题|指数/g, "").trim();
}

function isNarrativeThemeName(name) {
  const clean = rawThemeName(name);
  if (clean.length < 2 || NON_NARRATIVE_THEME_PATTERN.test(clean)) return false;
  const knownFamily = THEME_FAMILIES.some((item) => item.test.test(clean)) || THEMES.some((item) => item.keywords.some((keyword) => clean.toLowerCase().includes(keyword.toLowerCase())));
  const narrativeSemantics = /产业链|设备|材料|技术|软件|硬件|芯片|算力|通信|机器人|药|医疗|消费|能源|电力|军工|农业|种植|种业|粮食|大豆|玉米|煤炭|煤矿|煤化工|焦煤|焦炭|钢铁|特钢|铁矿|汽车|地产|传媒|教育|政策|改革|涨价|出海|平台|核电|聚变|光伏|储能|电池|有色|金属|食品|旅游|银行|证券|保险/;
  return knownFamily || narrativeSemantics.test(clean);
}

function themeKnowledge(name) {
  const fixed = THEMES.find((item) => item.keywords.some((keyword) => name.toLowerCase().includes(keyword.toLowerCase())));
  if (fixed) return fixed;
  const shortName = canonicalThemeName(name);
  return { shortName, keywords: [shortName, String(name).replace(/指数/g, "")], logic: `${shortName}由当日相对强度、资金承接和核心股联动共同驱动，需继续验证产业催化与持续性。`, chain: ["事件/政策催化", "产业链受益", "核心龙头", "容量中军", "扩散与兑现"] };
}

function themeFromRow(row) {
  const code = textField(row, [/Wind代码/i, /指数代码/i]);
  const name = textField(row, [/证券简称/i, /指数简称/i, /^名称$/i]);
  const currency = textField(row, [/交易币种/i]);
  if (!name || /^\[(?:US|HK)\]/i.test(name) || (currency && currency !== "CNY")) return null;
  if (!isNarrativeThemeName(name)) return null;
  if (code && !/\.WI$/i.test(code)) return null;
  const knowledge = themeKnowledge(name);
  const changePct = metric(row, [/最新涨跌幅/i, /当日.*涨跌幅/i, /今日.*涨跌幅/i, /202\d年.*涨跌幅/i, /^涨跌幅$/i]);
  if (!Number.isFinite(changePct)) return null;
  const upCount = metric(row, [/上涨家数/i]);
  const downCount = metric(row, [/下跌家数/i]);
  const limitUpCount = metric(row, [/涨停家数/i]);
  const limitDownCount = metric(row, [/跌停家数/i]);
  const turnover = metricBillions(row, [/成交额/i]);
  const mainFlow = metricBillions(row, [/主力.*净流入/i, /资金.*净流入/i]);
  const r3 = metric(row, [/近3日.*涨跌幅/i, /3日.*涨跌幅/i]);
  const r5 = metric(row, [/近5日.*涨跌幅/i, /5日.*涨跌幅/i]);
  const breadth = Number.isFinite(upCount) && Number.isFinite(downCount) && upCount + downCount > 0 ? upCount / (upCount + downCount) : null;
  const strength = clamp(35 + changePct * 7 + (breadth == null ? 0 : (breadth - .5) * 30) + Math.min(Math.max(limitUpCount || 0, 0), 8) * 2 + Math.min(Math.log10(Math.max(turnover || 1, 1)) * 5, 12) + (mainFlow == null ? 0 : clamp(mainFlow / 5, -12, 12)) + clamp((r3 || r5 || 0) * .5, -10, 10) - Math.max(0, -changePct) * 5);
  const shortName = knowledge.shortName || canonicalThemeName(name);
  return { id: `wind-${String(code || shortName).replace(/[^a-zA-Z0-9]+/g, "-").toLowerCase()}`, windCode: code || null, name, branchName: rawThemeName(name), shortName, keywords: [...new Set([shortName, rawThemeName(name), ...(knowledge.keywords || [])])], logic: knowledge.logic, chain: knowledge.chain, matchedRows: 1, changePct: round(changePct), dailyPeakPct: round(changePct), r3: round(r3), r5: round(r5), turnover: round(turnover), mainFlow: round(mainFlow), upCount, downCount, breadth: round(breadth == null ? null : breadth * 100, 1), limitUpCount, limitDownCount, tradeTime: textField(row, [/交易时间/i, /数据时间/i]), strength: round(strength, 0), sourceFields: row };
}

function mergeThemeSnapshot(branch, payload) {
  const row = rowsFromPayload(payload)[0];
  if (!row) return { ...branch, snapshotError: "Wind题材指数快照为空" };
  const upCount = metric(row, [/上涨家数/i]);
  const downCount = metric(row, [/下跌家数/i]);
  const breadth = Number.isFinite(upCount) && Number.isFinite(downCount) && upCount + downCount > 0 ? upCount / (upCount + downCount) * 100 : branch.breadth;
  const updated = {
    ...branch,
    changePct: metric(row, [/^涨跌幅$/i]) ?? branch.changePct,
    r5: metric(row, [/5日涨跌幅/i]),
    r20: metric(row, [/20日涨跌幅/i]),
    turnover: metricBillions(row, [/^成交额$/i]) ?? branch.turnover,
    mainFlow: metricBillions(row, [/当日主力净流入额/i]),
    mainFlow5: metricBillions(row, [/近5日主力净流入额/i]),
    upCount,
    downCount,
    breadth: round(breadth, 1),
    snapshotSourceFields: row
  };
  updated.strength = round(clamp(35 + updated.changePct * 7 + ((updated.breadth ?? 50) - 50) * .3 + Math.min(Math.log10(Math.max(updated.turnover || 1, 1)) * 5, 12) + (updated.mainFlow == null ? -8 : clamp(updated.mainFlow / 5, -12, 12)) + clamp((updated.r5 || 0) * .5, -10, 10) - Math.max(0, -updated.changePct) * 5), 0);
  return updated;
}

function aggregateMarketMetric(rows, tests) {
  const candidates = [];
  for (const row of rows) {
    for (const [key, value] of Object.entries(row || {})) {
      if (key === "__units" || !tests.some((test) => test.test(key))) continue;
      const parsed = number(value);
      if (!Number.isFinite(parsed)) continue;
      const code = textField(row, [/Wind代码/i]);
      const name = textField(row, [/证券简称/i, /指数简称/i]);
      const businessKeys = Object.keys(row).filter((item) => item !== "__units" && !/日期|时间|币种/.test(item));
      const score = (/881001\.WI/i.test(code) ? 20 : 0) + (/万得全A/.test(name) ? 15 : 0) + (/万得全A/.test(key) ? 12 : 0) + (!code && businessKeys.length <= 3 ? 8 : 0);
      candidates.push({ value: parsed, unit: String(row?.__units?.[key] || ""), key, score });
    }
  }
  return candidates.sort((a, b) => b.score - a.score)[0] || null;
}

function moneyToTrillion(item) {
  if (!item) return null;
  if (item.unit.includes("万亿元")) return item.value;
  if (item.unit.includes("亿元")) return item.value / 10_000;
  if (item.unit.includes("百万元")) return item.value / 1_000_000;
  if (item.unit.includes("万元")) return item.value / 100_000_000;
  if (item.unit.includes("元")) return item.value / 1_000_000_000_000;
  return item.value;
}

function moneyToBillion(item) {
  if (!item) return null;
  if (item.unit.includes("万亿元")) return item.value * 10_000;
  if (item.unit.includes("亿元")) return item.value;
  if (item.unit.includes("百万元")) return item.value / 100;
  if (item.unit.includes("万元")) return item.value / 10_000;
  if (item.unit.includes("元")) return item.value / 100_000_000;
  return item.value;
}

function deriveMarketContext(rows, themes) {
  const scopedMetric = (tests, layers = null) => aggregateMarketMetric(layers ? rows.filter((row) => layers.includes(row.__marketLayer)) : rows, tests);
  const value = (tests, layers = null) => scopedMetric(tests, layers)?.value ?? null;
  const currentTurnover = moneyToTrillion(scopedMetric([/^\d{4}年\d+月\d+日(?:万得全A)?成交额$/i, /当日.*万得全A成交额/i], ["core"]));
  let previousTurnover = moneyToTrillion(scopedMetric([/^前一交易日.*成交额$/i, /^上一交易日.*成交额$/i], ["core"]));
  const directForecast = null;
  if (Number.isFinite(currentTurnover) && Number.isFinite(previousTurnover) && Math.abs(currentTurnover - previousTurnover) < 0.0005) previousTurnover = null;
  const clock = shanghaiClock();
  const elapsed = clock.minutes <= 690 ? Math.max(0, clock.minutes - 570) : clock.minutes < 780 ? 120 : Math.min(240, 120 + clock.minutes - 780);
  const projectedTurnover = Number.isFinite(directForecast) ? directForecast : clock.phase === "postclose" ? currentTurnover : null;
  const forecastMethod = Number.isFinite(directForecast) ? "Wind原生预测" : clock.phase === "postclose" ? "收盘实际" : "Wind预测字段待补";
  const turnoverDeltaPct = Number.isFinite(projectedTurnover) && Number.isFinite(previousTurnover) && previousTurnover ? (projectedTurnover / previousTurnover - 1) * 100 : null;
  let up = value([/^(?:\d{4}年\d+月\d+日)?(?:A股全市场|万得全A指数成份)?上涨数量$/i], ["breadth"]);
  let down = value([/^(?:\d{4}年\d+月\d+日)?(?:A股全市场|万得全A指数成份)?下跌数量$/i], ["breadth"]);
  let flat = value([/^(?:\d{4}年\d+月\d+日)?(?:A股全市场|万得全A指数成份)?平盘数量$/i], ["breadth"]);
  const countLayerCodes = (layer) => new Set(rows.filter((row) => row.__marketLayer === layer).map((row) => textField(row, [/Wind代码/i, /证券代码/i, /股票代码/i])).filter((code) => /^\d{6}\.(SH|SZ|BJ)$/i.test(code))).size;
  const screenedUp = countLayerCodes("breadth-up");
  const screenedDown = countLayerCodes("breadth-down");
  if (screenedUp) up = screenedUp;
  if (screenedDown) down = screenedDown;
  const coreStocks = new Map();
  for (const row of rows.filter((item) => item.__marketLayer === "core")) {
    const code = textField(row, [/Wind代码/i]);
    const name = textField(row, [/证券简称/i]);
    const change = metric(row, [/涨跌幅/i]);
    if (/^\d{6}\.(SH|SZ|BJ)$/i.test(code) && !/^(S\*ST|\*ST|SST|ST)/i.test(name.replaceAll(" ", "")) && Number.isFinite(change)) coreStocks.set(code, change);
  }
  if (!Number.isFinite(up) || !Number.isFinite(down) || up + down < 1000) {
    up = coreStocks.size > 1000 ? [...coreStocks.values()].filter((change) => change > 0).length : null;
    down = coreStocks.size > 1000 ? [...coreStocks.values()].filter((change) => change < 0).length : null;
  }
  if (Number.isFinite(up) && (!Number.isInteger(up) || up < 0 || up > 6000)) up = null;
  if (Number.isFinite(down) && (!Number.isInteger(down) || down < 0 || down > 6000)) down = null;
  if (Number.isFinite(flat) && (!Number.isInteger(flat) || flat < 0 || flat > 6000)) flat = null;
  if (Number.isFinite(up) && Number.isFinite(down) && Number.isFinite(flat) && (up + down + flat < 3000 || up + down + flat > 6000)) { up = null; down = null; flat = null; }
  const breadth = Number.isFinite(up) && Number.isFinite(down) && up + down ? up / (up + down) : null;
  const plausibleCount = (amount, max = 6000) => Number.isInteger(amount) && amount >= 0 && amount <= max ? amount : null;
  const limitUp = plausibleCount(value([/^(?:\d{4}年\d+月\d+日)?A股涨停数量$/i, /^(?:\d{4}年\d+月\d+日)?涨停(?:家数|数量)$/i], ["breadth"]));
  const limitDown = plausibleCount(value([/^(?:\d{4}年\d+月\d+日)?A股跌停数量$/i, /^(?:\d{4}年\d+月\d+日)?跌停(?:家数|数量)$/i], ["breadth"]));
  const yesterdayLimit = plausibleCount(value([/^昨日涨停(?:家数|数量)$/i], ["sentiment"]));
  const continuationCount = plausibleCount(value([/^连板成功(?:家数|数量)$/i], ["sentiment"]), 500);
  const touchedLimit = plausibleCount(value([/^触及涨停(?:家数|数量)$/i], ["sentiment"]), 1000);
  let brokenLimit = plausibleCount(value([/^炸板(?:家数|数量)$/i], ["sentiment"]), 1000);
  if (Number.isFinite(brokenLimit) && Number.isFinite(touchedLimit) && brokenLimit > touchedLimit) brokenLimit = null;
  const yesterdayLimitAvgRaw = value([/^(?:\d{4}年\d+月\d+日)?昨日涨停.*今日平均涨跌幅$/i, /^(?:\d{4}年\d+月\d+日)?昨日涨停.*平均涨跌幅$/i], ["yesterday-performance"]);
  const yesterdayLimitAvg = Number.isFinite(yesterdayLimitAvgRaw) && Math.abs(yesterdayLimitAvgRaw) <= 30 ? yesterdayLimitAvgRaw : null;
  const continuationRateRaw = Number.isFinite(continuationCount) && Number.isFinite(yesterdayLimit) && yesterdayLimit && continuationCount <= yesterdayLimit ? continuationCount / yesterdayLimit * 100 : null;
  const brokenRateRaw = Number.isFinite(brokenLimit) && Number.isFinite(touchedLimit) && touchedLimit ? brokenLimit / touchedLimit * 100 : null;
  const continuationRate = Number.isFinite(continuationRateRaw) && continuationRateRaw >= 0 && continuationRateRaw <= 100 ? continuationRateRaw : null;
  const brokenRate = Number.isFinite(brokenRateRaw) && brokenRateRaw >= 0 && brokenRateRaw <= 100 ? brokenRateRaw : null;
  const sumFlowRows = (tests) => {
    const byCode = new Map();
    for (const row of rows.filter((item) => item.__marketLayer === "flow")) {
      const code = textField(row, [/Wind代码/i]);
      if (!/^\d{6}\.(SH|SZ|BJ)$/i.test(code)) continue;
      const item = aggregateMarketMetric([row], tests);
      if (item) byCode.set(code, moneyToBillion(item));
    }
    return byCode.size ? [...byCode.values()].filter(Number.isFinite).reduce((sum, amount) => sum + amount, 0) : null;
  };
  const mainFlow = moneyToBillion(aggregateMarketMetric(rows, [/万得全A.*主力.*净流入/i, /^主力资金?净流入/i])) ?? sumFlowRows([/主力.*净流入/i, /L2_MONEY_1D_NETIN/i]);
  const institutionProxy = moneyToBillion(aggregateMarketMetric(rows, [/万得全A.*超大单.*净流入/i, /^超大单净流入/i])) ?? sumFlowRows([/超大单.*净流入/i]);
  const retailFlow = moneyToBillion(aggregateMarketMetric(rows, [/万得全A.*散户.*净流入/i, /^散户净流入/i, /^小单净流入/i])) ?? sumFlowRows([/散户.*净流入/i, /小单.*净流入/i]);
  const positiveThemes = themes.filter((theme) => theme.changePct > 0).length;
  let regime = "震荡";
  if ((breadth ?? .5) >= .62 && (turnoverDeltaPct ?? 0) >= 0) regime = "进攻";
  else if ((breadth ?? .5) <= .38 || (turnoverDeltaPct ?? 0) <= -10) regime = "防守";
  else if (positiveThemes >= 2) regime = "切换";
  const gate = 2;
  return {
    regime,
    confidence: Number.isFinite(breadth) && Number.isFinite(projectedTurnover) ? 84 : 68,
    liquidity: { currentTurnover: round(currentTurnover, 3), previousTurnover: round(previousTurnover, 3), projectedTurnover: round(projectedTurnover, 3), turnoverDeltaPct: round(turnoverDeltaPct, 1), forecastMethod, fixedGate: gate, gateGap: round(Number.isFinite(projectedTurnover) ? projectedTurnover - gate : null, 3), gateSupported: Number.isFinite(projectedTurnover) ? projectedTurnover >= gate : null },
    breadth: { up, down, flat, total: Number.isFinite(up) && Number.isFinite(down) && Number.isFinite(flat) ? up + down + flat : null, ratio: round(Number.isFinite(breadth) ? breadth * 100 : null, 1), limitUp, limitDown },
    sentiment: { yesterdayLimit, yesterdayLimitAvg: round(yesterdayLimitAvg, 2), continuationCount, continuationRate: round(continuationRate, 1), touchedLimit, brokenLimit, brokenRate: round(brokenRate, 1), quality: { continuationValid: Number.isFinite(continuationRate), brokenValid: Number.isFinite(brokenRate), invariant: "0≤连板/炸板≤分母且比率≤100%" } },
    flows: { mainFlow: round(mainFlow, 2), institutionProxy: round(institutionProxy, 2), retailFlow: round(retailFlow, 2), institutionLabel: "超大单代理，不等同真实机构席位" },
    evidence: [
      Number.isFinite(projectedTurnover) ? `预计全天成交${round(projectedTurnover, 2)}万亿元${Number.isFinite(turnoverDeltaPct) ? `，较前日${round(turnoverDeltaPct, 1)}%` : ""}` : "全天成交预测待补",
      Number.isFinite(breadth) ? `上涨${up}家/下跌${down}家，上涨宽度${round(breadth * 100, 1)}%` : "全市场涨跌家数待补",
      Number.isFinite(continuationRate) ? `连板率${round(continuationRate, 1)}%` : "连板率待补",
      Number.isFinite(brokenRate) ? `炸板率${round(brokenRate, 1)}%` : "炸板率待补"
    ]
  };
}

function familyForTheme(theme) {
  return THEME_FAMILIES.find((family) => family.test.test(`${theme.name} ${theme.branchName} ${theme.keywords.join(" ")}`)) || null;
}

function branchStage(branch, parentStrength, bestStrength) {
  const flowDivergence = (Number.isFinite(branch.mainFlow) && branch.mainFlow < 0) || (Number.isFinite(branch.mainFlow5) && branch.mainFlow5 < 0);
  const relativeGap = bestStrength - branch.strength;
  const extended = branch.changePct >= 6 || (branch.r5 || 0) >= 15;
  if (branch.changePct <= -1.5 || branch.strength < 35) return { status: "退潮", action: "不执行", reason: "价格与综合强度同步转弱，等待止跌和资金回流。" };
  if (extended) return { status: "加速不追", action: "等回踩", reason: "短线涨幅或阶段涨幅偏大，只观察回踩承接。" };
  if (branch.changePct < .8 || relativeGap >= 18 || (flowDivergence && branch.changePct < 2.5)) return { status: "分歧", action: "等确认", reason: "相对强度或资金承接落后于父主线，需核心股重新转强。" };
  if (branch.changePct >= 1.2 && branch.strength >= Math.max(55, parentStrength - 12)) return { status: "可上车", action: "近价触发", reason: "分支强度、方向和父主线共振，允许从核心角色寻找触发。" };
  return { status: "观察", action: "暂缓", reason: "证据尚未达到主动交易门槛。" };
}

function buildThemeGroup(key, family, inputBranches) {
  const branchMap = new Map();
  for (const branch of inputBranches) {
    const branchKey = branch.branchName || branch.shortName;
    const prior = branchMap.get(branchKey);
    if (!prior || branch.strength > prior.strength) branchMap.set(branchKey, branch);
  }
  const rawBranches = [...branchMap.values()].sort((a, b) => b.strength - a.strength || b.changePct - a.changePct);
  const best = rawBranches[0];
  const averageStrength = rawBranches.reduce((sum, branch) => sum + branch.strength, 0) / rawBranches.length;
  const positiveCount = rawBranches.filter((branch) => branch.changePct > 0).length;
  const consensus = positiveCount / rawBranches.length;
  const lowCapacitySingle = rawBranches.length === 1 && (best.turnover || 0) < 50;
  const strength = clamp(best.strength * .55 + averageStrength * .25 + consensus * 20 - (lowCapacitySingle ? 12 : 0));
  const stagedBranches = rawBranches.map((branch) => ({ ...branch, ...branchStage(branch, strength, best.strength) }));
  const familyName = family?.name || best.shortName;
  const isParent = Boolean(family && stagedBranches.length > 1);
  const confidence = stagedBranches.length >= 3 && consensus >= .67 ? "高" : stagedBranches.length >= 2 && consensus >= .5 ? "中高" : lowCapacitySingle ? "低" : "中";
  const eligibleMainline = strength >= 58 && (stagedBranches.length >= 2 ? consensus >= .5 : (best.turnover || 0) >= 50 || best.strength >= 84);
  const branches = stagedBranches.map((branch) => !eligibleMainline && branch.status !== "退潮" ? { ...branch, status: "观察", action: "暂缓", reason: "父题材尚未达到主线共振或成交承载门槛，分支不能单独标记为可上车。" } : branch);
  const activeBranches = branches.filter((branch) => ["可上车", "加速不追"].includes(branch.status));
  return {
    id: family?.id || `single-${best.id}`,
    name: familyName,
    shortName: familyName,
    parentTheme: isParent,
    branches,
    branchCount: branches.length,
    activeBranchCount: activeBranches.length,
    primaryBranch: branches[0]?.branchName || branches[0]?.shortName,
    keywords: [...new Set([...(family?.keywords || []), ...branches.flatMap((branch) => branch.keywords)])],
    logic: family?.logic || best.logic,
    chain: family?.chain || best.chain,
    matchedRows: branches.length,
    changePct: round(branches.reduce((sum, branch) => sum + branch.changePct, 0) / branches.length),
    dailyPeakPct: best.changePct,
    turnover: round(Math.max(...branches.map((branch) => branch.turnover || 0))),
    mainFlow: best.mainFlow,
    mainFlow5: best.mainFlow5,
    limitUpCount: Math.max(...branches.map((branch) => branch.limitUpCount || 0)),
    breadth: round(consensus * 100, 1),
    r3: best.r3,
    r5: best.r5,
    r20: best.r20,
    strength: round(strength, 0),
    mainlineConfidence: confidence,
    eligibleMainline,
    dataFresh: true,
    tradeTime: best.tradeTime,
    sourceFields: best.sourceFields
  };
}

const THEME_SEMANTIC_AXES = [
  { id: "content-platform", test: /内容|短视频|直播|社交|社区|传媒|营销|广告|电商|流量|平台|快手|抖音|字节|小红书|微信/ },
  { id: "ai-compute", test: /人工智能|AI|算力|服务器|数据中心|光模块|光通信|CPO|大模型|智能体|AIGC/ },
  { id: "chip", test: /半导体|芯片|集成电路|存储|HBM|封装|晶圆|光刻/ },
  { id: "robot", test: /机器人|具身智能|减速器|执行器|丝杠|机器视觉|伺服/ },
  { id: "healthcare", test: /医药|医疗|创新药|独家药|CRO|CXO|ADC|疫苗|中药|器械/ },
  { id: "nuclear", test: /核能|核电|核聚变|核工业|核级/ },
  { id: "aerospace", test: /航天|航空|卫星|火箭|低空|无人机|发动机/ },
  { id: "new-energy", test: /新能源|光伏|风电|锂电|储能|电池|充电桩/ },
  { id: "grid-power", test: /电力|电网|特高压|输变电|发电|电气设备/ },
  { id: "materials", test: /有色|金属|材料|稀土|铜|铝|黄金|碳纤维|超导/ },
  { id: "consumption", test: /消费|食品|饮料|白酒|零售|旅游|酒店|家电|美妆/ },
  { id: "finance", test: /银行|证券|券商|保险|金融|支付|互金/ }
];
const GENERIC_THEME_WORDS = /产业链|产业|主题|概念|指数|板块|生态|相关|精选|综合|龙头|上游|中游|下游/g;

function themeTokens(theme) {
  const text = `${theme.branchName || ""}${theme.shortName || ""}${(theme.keywords || []).join("")}`.replace(GENERIC_THEME_WORDS, "").toLowerCase();
  const latin = text.match(/[a-z][a-z0-9+.-]{1,}/g) || [];
  const han = text.match(/[\u4e00-\u9fff]{2,8}/g) || [];
  const chunks = han.flatMap((word) => word.length <= 3 ? [word] : Array.from({ length: word.length - 1 }, (_, i) => word.slice(i, i + 2)));
  return new Set([...latin, ...chunks]);
}

function jaccard(left, right) {
  if (!left.size || !right.size) return 0;
  let common = 0;
  for (const item of left) if (right.has(item)) common += 1;
  return common / (left.size + right.size - common);
}

function semanticAxes(theme) {
  const text = `${theme.name} ${theme.branchName} ${(theme.keywords || []).join(" ")}`;
  return new Set(THEME_SEMANTIC_AXES.filter((axis) => axis.test.test(text)).map((axis) => axis.id));
}

function themeMergeEvidence(left, right) {
  const leftFamily = familyForTheme(left);
  const rightFamily = familyForTheme(right);
  const sameFamily = Boolean(leftFamily && rightFamily && leftFamily.id === rightFamily.id);
  const axesLeft = semanticAxes(left);
  const axesRight = semanticAxes(right);
  const commonAxes = [...axesLeft].filter((axis) => axesRight.has(axis));
  const semantic = jaccard(themeTokens(left), themeTokens(right));
  const names = jaccard(themeTokens({ branchName: left.branchName }), themeTokens({ branchName: right.branchName }));
  const driverScore = sameFamily ? 40 : commonAxes.length ? 28 : 0;
  const chainScore = sameFamily ? 25 : commonAxes.length ? 16 : 0;
  const score = driverScore + chainScore + semantic * 20 + names * 15;
  return { score, sameFamily, commonAxes, semantic, names, merge: sameFamily || (commonAxes.length > 0 && score >= 52) || score >= 60 };
}

function inferredFamily(themes) {
  const fixed = themes.map(familyForTheme).find(Boolean);
  if (fixed) return fixed;
  const axisCounts = new Map();
  for (const theme of themes) for (const axis of semanticAxes(theme)) axisCounts.set(axis, (axisCounts.get(axis) || 0) + 1);
  const axis = [...axisCounts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
  if (!axis || themes.length < 2) return null;
  const label = THEME_SEMANTIC_AXES.find((item) => item.id === axis)?.id || axis;
  return { id: `dynamic-${axis}`, name: themes[0].shortName, keywords: [...new Set(themes.flatMap((item) => item.keywords || []))], logic: `由共同驱动、产业链关系和语义重合动态归并；各分支仍须分别验证资金、强度与持续性。`, chain: ["共同事件/驱动", "产业传导", "核心分支", "资金扩散", "业绩兑现"], dynamic: true, label };
}

function discoverThemes(rows) {
  const themes = rows.map(themeFromRow).filter(Boolean);
  const parent = themes.map((_, index) => index);
  const find = (index) => parent[index] === index ? index : (parent[index] = find(parent[index]));
  const join = (a, b) => { const pa = find(a); const pb = find(b); if (pa !== pb) parent[pb] = pa; };
  for (let i = 0; i < themes.length; i += 1) {
    for (let j = i + 1; j < themes.length; j += 1) if (themeMergeEvidence(themes[i], themes[j]).merge) join(i, j);
  }
  const clusters = new Map();
  themes.forEach((theme, index) => { const key = find(index); const list = clusters.get(key) || []; list.push(theme); clusters.set(key, list); });
  const grouped = [...clusters.values()].map((branches) => {
    const family = inferredFamily(branches);
    const key = family?.id || `single:${canonicalThemeName(branches[0].branchName)}`;
    const built = buildThemeGroup(key, family, branches);
    built.classification = { method: "多维动态聚类", branchCount: branches.length, dimensions: ["共同驱动40%", "产业链关系25%", "核心词语义20%", "名称相似度15%"], aliasesOnlyNormalize: true };
    return built;
  });
  const eligible = grouped.filter((theme) => theme.eligibleMainline).sort((a, b) => b.strength - a.strength || b.activeBranchCount - a.activeBranchCount);
  const fallback = grouped.filter((theme) => !theme.eligibleMainline).sort((a, b) => b.strength - a.strength);
  return [...eligible, ...fallback].slice(0, MAINLINE_SLOT_COUNT);
}
function ensureMainlineSlots(themes, reason = "Wind候选池待补充") {
  const output = [...themes].filter((theme) => theme?.dataPending || isNarrativeThemeName(theme?.shortName || theme?.name)).slice(0, MAINLINE_SLOT_COUNT);
  while (output.length < MAINLINE_SLOT_COUNT) {
    const rank = output.length + 1;
    output.push({
      id: `pending-mainline-${rank}`,
      name: `第${rank}主线待实时补位`,
      shortName: `第${rank}主线待实时补位`,
      rank,
      parentTheme: true,
      dataPending: true,
      eligibleMainline: false,
      dataFresh: false,
      strength: null,
      mainlineConfidence: "待补",
      branchCount: 0,
      activeBranchCount: 0,
      branches: [],
      stocks: [],
      keywords: [],
      chain: [],
      phase: "数据补位中",
      continuity: "待验证",
      conclusion: "相似题材归并后独立父题材不足3个，正在从下一顺位候选中补位；不会用旧题材或重复分支凑数。",
      evidence: [reason],
      impact: "补位完成前不进入选股、仓位和交易计划。",
      nextAction: "Wind实时扫描恢复后自动替换为真实第三父主线。",
      risk: "数据未补齐，不形成交易结论。"
    });
  }
  return output.map((theme, index) => ({
    ...theme,
    rank: index + 1,
    stocks: (theme.stocks || []).map((stock) => ({ ...stock, themeRank: index + 1 }))
  }));
}

function stockFromRow(row) {
  const text = rowText(row);
  const codeValue = findField(row, [/Wind代码/i, /证券代码/i, /股票代码/i, /^code$/i, /windcode/i]);
  const code = String(codeValue || text.match(/\b\d{6}\.(?:SH|SZ|BJ)\b/i)?.[0] || "").toUpperCase();
  if (!/^\d{6}\.(SH|SZ|BJ)$/.test(code)) return null;
  const name = String(findField(row, [/证券简称/i, /股票简称/i, /中文简称/i, /^名称$/i, /^name$/i]) || "").trim();
  return {
    code,
    name: name || code,
    latestPrice: metric(row, [/最新成交价/i, /^现价$/i]),
    changePct: metric(row, [/当日.*涨跌幅/i, /今日.*涨跌幅/i, /^涨跌幅/i]),
    r5: metric(row, [/5日.*涨跌幅/i, /近5日/i]),
    r20: metric(row, [/20日.*涨跌幅/i, /近20日/i]),
    turnover: metric(row, [/成交额/i]),
    turnoverRate: metric(row, [/换手率/i]),
    mainFlow: metric(row, [/主力.*净流入/i, /资金.*净流入/i]),
    pe: metric(row, [/市盈率/i, /PE/i]),
    roe: metric(row, [/ROE/i, /净资产收益率/i]),
    revenueGrowth: metric(row, [/营业收入.*同比/i, /营收.*增速/i]),
    profitGrowth: metric(row, [/净利润.*同比/i, /净利润.*增速/i]),
    branchHint: textField(row, [/^__branchName$/i]),
    tradeTime: textField(row, [/交易时间/i, /数据时间/i]),
    dataDate: textField(row, [/^日期$/i, /最新交易日/i]),
    limitStatus: textField(row, [/是否涨停/i, /涨停状态/i, /交易状态/i]),
    stStatus: textField(row, [/是否ST/i, /ST状态/i, /特别处理/i]),
    emotionHint: Boolean(row.__emotionHint),
    concepts: text.slice(0, 1200),
    sourceFields: row
  };
}

function mergeStockSnapshot(stock, payload) {
  const row = rowsFromPayload(payload)[0];
  if (!row) return { ...stock, snapshotError: "Wind个股行情快照为空" };
  const latestPrice = metric(row, [/最新成交价/i]);
  const limitUpPrice = metric(row, [/涨停价/i]);
  return {
    ...stock,
    name: textField(row, [/中文简称/i, /证券简称/i]) || stock.name,
    latestPrice,
    changePct: metric(row, [/^涨跌幅$/i]),
    turnover: metricBillions(row, [/^成交额$/i]),
    turnoverRate: metric(row, [/^换手率$/i]),
    volumeRatio: metric(row, [/^量比$/i]),
    marketCap: metricBillions(row, [/总市值2/i]),
    pe: metric(row, [/市盈率\(TTM\)/i]),
    pb: metric(row, [/^市净率$/i]),
    mainFlow: metricBillions(row, [/当日主力净流入额/i]),
    mainFlowPct: metric(row, [/当日主力净流入占比/i]),
    mainFlow5: metricBillions(row, [/近5日主力净流入额/i]),
    mainFlow5Pct: metric(row, [/近5日主力净流入占比/i]),
    limitUpPrice,
    limitStatus: textField(row, [/交易状态/i]),
    atLimitUp: Number.isFinite(latestPrice) && Number.isFinite(limitUpPrice) && latestPrice >= limitUpPrice - .001,
    quoteSourceFields: row
  };
}

function mergeStockFundamentals(stock, payload) {
  const row = rowsFromPayload(payload)[0];
  if (!row) return { ...stock, fundamentalError: "Wind基本面快照为空" };
  return {
    ...stock,
    roe: metric(row, [/净资产收益率/i, /ROE/i]),
    revenueGrowth: metric(row, [/营业收入.*增长率/i, /营收.*增速/i]),
    profitGrowth: metric(row, [/归母净利润.*增长率/i, /净利润.*增速/i]),
    operatingCashFlow: metric(row, [/经营活动.*现金流量净额/i, /经营现金流/i]),
    debtRatio: metric(row, [/资产负债率/i]),
    financialPeriod: textField(row, [/报告期/i]),
    fundamentalSourceFields: row
  };
}

function mergeStockBusinessMapping(stock, payload) {
  const rows = rowsFromPayload(payload);
  if (!rows.length) return { ...stock, businessMappingError: "Wind主营与概念映射为空" };
  return {
    ...stock,
    concepts: `${stock.concepts || ""} ${rows.map(rowText).join(" ")}`.slice(0, 8000),
    businessMappingSourceFields: rows[0]
  };
}

function stockLimitUpThreshold(code) {
  const digits = String(code || "").slice(0, 6);
  if (/\.(BJ)$/i.test(String(code)) || /^(4|8)/.test(digits)) return 29.5;
  if (/^(300|301|688|689)/.test(digits)) return 19.5;
  return 9.5;
}

function isStStock(stock) {
  const name = String(stock?.name || "").replaceAll(" ", "").toUpperCase();
  const status = String(stock?.stStatus || "").toUpperCase();
  return /^(?:S\*ST|\*ST|SST|ST)/.test(name) || (/ST|特别处理/.test(status) && !/非ST|否|正常/.test(status));
}

function isLimitUpStock(stock) {
  const status = String(stock?.limitStatus || "");
  if (/涨停|封板|一字板/.test(status) && !/未涨停|非涨停|打开|炸板/.test(status)) return true;
  return stock?.atLimitUp === true || (Number.isFinite(stock?.changePct) && stock.changePct >= stockLimitUpThreshold(stock.code));
}

function uniqueStocks(rows) {
  const map = new Map();
  for (const row of rows) {
    const stock = stockFromRow(row);
    if (!stock) continue;
    const prior = map.get(stock.code) || {};
    map.set(stock.code, Object.fromEntries(Object.entries({ ...prior, ...stock }).map(([key, value]) => [key, value ?? prior[key] ?? null])));
  }
  return [...map.values()];
}

function computeTechnical(payload) {
  const rows = rowsFromPayload(payload);
  const bars = rows.map((row) => ({
    time: findField(row, [/^TIME$/i, /日期/i]),
    open: metric(row, [/^OPEN$/i, /开盘/i]),
    close: metric(row, [/^MATCH$/i, /^CLOSE$/i, /收盘/i]),
    high: metric(row, [/^HIGH$/i, /最高/i]),
    low: metric(row, [/^LOW$/i, /最低/i]),
    volume: metric(row, [/^VOLUME$/i, /成交量/i])
  })).filter((bar) => [bar.close, bar.high, bar.low].every(Number.isFinite));
  if (bars.length < 21) return null;
  const latest = bars.at(-1);
  const prior = bars.slice(0, -1);
  const last20 = prior.slice(-20);
  const mean = (values) => values.reduce((sum, value) => sum + value, 0) / values.length;
  const ma5 = mean(bars.slice(-5).map((bar) => bar.close));
  const ma20 = mean(bars.slice(-20).map((bar) => bar.close));
  const priorHigh20 = Math.max(...last20.map((bar) => bar.high));
  const avgVolume20 = mean(last20.map((bar) => bar.volume).filter(Number.isFinite));
  const volumeRatio = avgVolume20 ? latest.volume / avgVolume20 : null;
  const last10 = bars.slice(-10);
  const prior10 = bars.slice(-20, -10);
  const avgRange = (items) => mean(items.map((bar) => bar.close ? (bar.high - bar.low) / bar.close : 0));
  const contractionRatio = prior10.length ? avgRange(last10) / Math.max(avgRange(prior10), .0001) : null;
  const upVolumes = last20.filter((bar, index, list) => index > 0 && bar.close >= list[index - 1].close).map((bar) => bar.volume).filter(Number.isFinite);
  const downVolumes = last20.filter((bar, index, list) => index > 0 && bar.close < list[index - 1].close).map((bar) => bar.volume).filter(Number.isFinite);
  const upDownVolumeRatio = upVolumes.length && downVolumes.length ? mean(upVolumes) / Math.max(mean(downVolumes), 1) : null;
  const r5 = bars.length > 5 ? (latest.close / bars.at(-6).close - 1) * 100 : null;
  const r20 = (latest.close / bars.at(-21).close - 1) * 100;
  const distanceHigh20Pct = (latest.close / priorHigh20 - 1) * 100;
  const support10 = Math.min(...last10.map((bar) => bar.low));
  const falseBreakout = latest.high > priorHigh20 && latest.close < priorHigh20 && volumeRatio >= 1.15;
  const breakoutStage = falseBreakout ? "疑似假突破" : latest.close >= priorHigh20 && volumeRatio >= 1.2 ? "确认突破" : distanceHigh20Pct >= -5 && contractionRatio <= .9 ? "准备突破" : latest.close > ma20 ? "结构修复" : "尚未形成突破结构";
  return {
    asOf: latest.time,
    close: latest.close,
    ma5: round(ma5),
    ma20: round(ma20),
    r5: round(r5),
    r20: round(r20),
    volumeRatio: round(volumeRatio),
    distanceHigh20Pct: round(distanceHigh20Pct),
    resistancePrice: round(priorHigh20),
    supportPrice: round(Math.max(support10, ma20)),
    contractionRatio: round(contractionRatio),
    upDownVolumeRatio: round(upDownVolumeRatio),
    breakoutStage,
    volatility20: round(avgRange(last20) * 100),
    trend: latest.close > ma5 && ma5 > ma20 ? "多头趋势" : latest.close > ma20 ? "趋势修复" : "弱于20日线",
    priceVolume: volumeRatio >= 1.2 && latest.close >= priorHigh20 ? "放量突破" : volumeRatio >= 1.1 ? "量能增强" : volumeRatio < .75 ? "缩量待验证" : "量价平稳"
  };
}

async function mapLimit(items, limit, worker) {
  const output = new Array(items.length);
  let cursor = 0;
  async function run() {
    while (cursor < items.length) {
      const index = cursor++;
      try { output[index] = await worker(items[index], index); }
      catch (error) { output[index] = { ...items[index], enrichmentError: error instanceof Error ? error.message : String(error) }; }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run));
  return output;
}

function themeAggregate(theme, rows) {
  const matched = rows.filter((row) => theme.keywords.some((keyword) => rowText(row).toLowerCase().includes(keyword.toLowerCase())));
  const values = (tests) => matched.map((row) => metric(row, tests)).filter(Number.isFinite);
  const max = (list) => list.length ? Math.max(...list) : null;
  const sumPositive = (list) => list.filter((value) => value > 0).reduce((sum, value) => sum + value, 0);
  const changes = values([/当日.*涨跌幅/i, /今日.*涨跌幅/i, /^涨跌幅/i]);
  const turnover = values([/成交额/i]);
  const flows = values([/主力.*净流入/i, /资金.*净流入/i]);
  const strength = clamp(40 + Math.min(max(changes) || 0, 20) * 1.4 + Math.min(sumPositive(flows), 60) * .35 + Math.min(sumPositive(turnover), 600) * .03 + Math.min(matched.length, 15));
  return {
    ...theme,
    matchedRows: matched.length,
    dailyPeakPct: round(max(changes)),
    turnover: round(sumPositive(turnover)),
    mainFlow: round(sumPositive(flows)),
    strength: round(strength, 0)
  };
}

function branchForStock(stock, theme) {
  const hint = String(stock.branchHint || "");
  const concepts = String(stock.concepts || "").toLowerCase();
  const taxonomy = STOCK_BRANCH_RULES.find((entry) => entry.theme.test(theme.shortName || theme.name || ""));
  const inferred = taxonomy?.rules.find(([pattern]) => pattern.test(concepts));
  if (inferred) {
    const parent = theme.branches?.[0] || {};
    return { ...parent, branchName: inferred[1], shortName: inferred[1], reason: `根据Wind所属概念及主营映射至${inferred[1]}分支。` };
  }
  const existing = (theme.branches || []).find((branch) => [branch.branchName, branch.shortName, ...(branch.keywords || [])].some((keyword) => keyword && concepts.includes(String(keyword).toLowerCase())));
  if (existing) return existing;
  return (theme.branches || []).find((branch) => hint && (hint.includes(branch.branchName) || branch.branchName.includes(hint)))
    || theme.branches?.[0]
    || { branchName: theme.shortName, status: "观察", action: "暂缓", reason: "分支映射待确认", strength: theme.strength };
}

function scoreStock(stock, theme, index, count, adaptiveWeights = null) {
  const technical = stock.technical || {};
  const branch = branchForStock(stock, theme);
  const themeFit = clamp(70 + Math.min((stock.concepts.match(new RegExp(theme.keywords.join("|"), "gi")) || []).length * 4, 25));
  const capital = clamp(35 + (stock.mainFlow > 0 ? 18 : stock.mainFlow < 0 ? -15 : 0) + (stock.mainFlow5 > 0 ? 12 : stock.mainFlow5 < 0 ? -10 : 0) + (stock.turnoverRate >= 1 && stock.turnoverRate <= 15 ? 10 : 0) + (stock.turnover ? 8 : 0));
  const priceVolume = clamp(45 + (technical.priceVolume === "放量突破" ? 30 : technical.priceVolume === "量能增强" ? 20 : technical.priceVolume === "缩量待验证" ? -8 : 6) + (technical.distanceHigh20Pct >= -4 && technical.distanceHigh20Pct <= 2 ? 12 : 0));
  const trend = clamp(45 + (technical.trend === "多头趋势" ? 28 : technical.trend === "趋势修复" ? 13 : -12) + (Number.isFinite(technical.r20) && technical.r20 > 0 && technical.r20 < 35 ? 12 : 0));
  const fundamentalAvailable = [stock.roe, stock.profitGrowth, stock.revenueGrowth].filter(Number.isFinite).length >= 2 && Boolean(stock.financialPeriod);
  const fundamental = fundamentalAvailable ? clamp(35 + (stock.roe >= 10 ? 15 : 0) + (stock.profitGrowth > 0 ? 15 : -10) + (stock.revenueGrowth > 0 ? 10 : -8) + (stock.operatingCashFlow > 0 ? 8 : 0) + (stock.pe > 0 && stock.pe < 60 ? 8 : 0)) : 0;
  const effectiveThemeStrength = round(theme.strength * .6 + (branch.strength || theme.strength) * .4, 0);
  const catalystFit = clamp((theme.catalysts?.items?.length >= 3 ? 82 : theme.catalysts?.items?.length ? 62 : 35) + (themeFit >= 85 ? 8 : 0));
  const liquidity = clamp(30 + (Number(stock.turnover) >= 20 ? 35 : Number(stock.turnover) >= 8 ? 25 : Number(stock.turnover) >= 3 ? 15 : 0) + (stock.turnoverRate >= 1 && stock.turnoverRate <= 18 ? 18 : stock.turnoverRate > 25 ? -12 : 0));
  const riskQuality = clamp(70 - (Number(technical.volatility20) > 7 ? 22 : Number(technical.volatility20) > 5 ? 10 : 0) - ((stock.r5 ?? technical.r5 ?? 0) > 20 ? 25 : 0) - (technical.breakoutStage === "疑似假突破" ? 30 : 0));
  const r5 = Number(stock.r5 ?? technical.r5);
  const r20 = Number(stock.r20 ?? technical.r20);
  const distanceHigh = Number(technical.distanceHigh20Pct);
  const positionPotential = clamp(55 + (Number.isFinite(r5) && r5 >= -3 && r5 <= 10 ? 22 : r5 > 20 ? -25 : 0) + (Number.isFinite(r20) && r20 >= 0 && r20 <= 25 ? 16 : r20 > 40 ? -22 : 0) + (Number.isFinite(distanceHigh) && distanceHigh >= -9 && distanceHigh <= 1 ? 15 : distanceHigh < -18 ? -15 : 0));
  const catalystPotential = theme.catalysts?.items?.length >= 3 ? 88 : theme.catalysts?.items?.length ? 68 : 38;
  const expectationGap = clamp(positionPotential * .25 + capital * .20 + priceVolume * .18 + catalystPotential * .15 + fundamental * .12 + effectiveThemeStrength * .10);
  const weights = adaptiveWeights || { themeFit: 18, themeStrength: 12, catalystFit: 10, capital: 14, priceVolume: 12, trend: 8, fundamental: 10, upsidePotential: 12, liquidity: 4 };
  const score = (themeFit * weights.themeFit + effectiveThemeStrength * weights.themeStrength + catalystFit * weights.catalystFit + capital * weights.capital + priceVolume * weights.priceVolume + trend * weights.trend + fundamental * weights.fundamental + expectationGap * weights.upsidePotential + liquidity * weights.liquidity) / 100;
  const trackingLabel = expectationGap >= 78 ? "高预期差" : expectationGap >= 65 ? "潜力较高" : expectationGap >= 55 ? "等待催化" : "空间有限";
  const trackingReason = expectationGap >= 65
    ? `当前涨幅尚未明显透支，题材、资金和量价至少两项形成配合；更适合等待近价触发，而不是追逐已涨停先锋。`
    : `现有价格位置、资金持续性或催化证据尚不足，暂不把“低位”直接等同于上涨空间。`;
  let role = "跟随股";
  if (index === 0) role = "龙头候选";
  else if (index === 1 || (count > 5 && index === 2)) role = stock.turnover ? "中军候选" : "核心跟随";
  else if ((stock.r5 || technical.r5 || 0) < 8 && (stock.r20 || technical.r20 || 0) > 0) role = "补涨候选";
  if ((stock.r5 || technical.r5 || 0) < -4 || technical.trend === "弱于20日线") role = "掉队观察";
  const reasons = [
    `${branch.branchName || branch.shortName}分支：${branch.status}`,
    `题材映射${themeFit >= 85 ? "较纯" : "需继续核验主营"}`,
    technical.priceVolume || "量价数据待补",
    technical.trend || "趋势数据待补",
    stock.mainFlow > 0 && stock.mainFlow5 > 0 ? "当日与5日主力资金共振净流入" : stock.mainFlow > 0 ? "当日资金流入但5日持续性待确认" : "资金承接偏弱",
    fundamentalAvailable ? `基本面报告期${stock.financialPeriod}` : "基本面字段不足，不允许主动推荐"
  ];
  const requiredFields = {
    实时价格: stock.latestPrice,
    当日涨跌幅: stock.changePct,
    成交额: stock.turnover,
    换手率: stock.turnoverRate,
    当日资金流: stock.mainFlow,
    五日资金流: stock.mainFlow5,
    量价结构: technical?.close,
    财务报告期: stock.financialPeriod
  };
  const missingFields = Object.entries(requiredFields).filter(([, value]) => value == null || value === "").map(([key]) => key);
  const dataComplete = missingFields.length === 0 && fundamentalAvailable;
  const nonPriceSupport = Number(theme.strengthBreakdown?.catalyst || 0) >= 65 || Number(theme.strengthBreakdown?.ladder || 0) >= 65 || Number(theme.strengthBreakdown?.capital || 0) >= 65;
  const themeEligible = theme.eligibleMainline !== false && theme.strength >= 55 && (theme.changePct > -1 || nonPriceSupport) && theme.dataFresh !== false;
  const branchBlocked = ["退潮", "观察"].includes(branch.status);
  const divergenceBlocked = branch.status === "分歧" && !["龙头候选", "中军候选", "核心跟随"].includes(role);
  const limitUpBlocked = isLimitUpStock(stock);
  const hardGateFailure = themeFit < 75 ? "题材与主营映射不足" : liquidity < 42 ? "成交承载或换手结构不足" : riskQuality < 40 ? "波动、过度上涨或假突破风险过高" : expectationGap < 55 ? "预期差和剩余上涨空间不足" : null;
  const reject = !dataComplete || limitUpBlocked || !themeEligible || branchBlocked || divergenceBlocked || role === "掉队观察" || hardGateFailure || score < 60;
  const exclusion = !dataComplete ? `关键数据不足：${missingFields.join("、") || "基本面"}` : limitUpBlocked ? "当日已涨停或封板，无法按计划合理买入" : !themeEligible ? "父主线多维强度、共振或实时性未通过门槛" : branch.status === "退潮" ? "所属分支处于退潮期，不生成主动计划" : branch.status === "观察" ? "所属分支证据不足，仅观察" : divergenceBlocked ? "分歧分支只保留龙头和中军候选" : role === "掉队观察" ? "趋势已掉队，不纳入主动交易池" : hardGateFailure || (score < 60 ? "综合得分未达到60分" : null);
  const priority = expectationGap >= 75 && score >= 70 ? "第一优先级" : expectationGap >= 62 && score >= 64 ? "第二优先级" : "观察级";
  const trigger = technical.breakoutStage === "准备突破" ? `放量站上${technical.resistancePrice || "20日阻力位"}且所属分支保持强势` : technical.breakoutStage === "确认突破" ? `回踩${technical.resistancePrice || "突破位"}不破并再次出现主动资金承接` : `先修复量价结构，站稳${technical.ma20 || "20日均线"}后再评估`;
  const invalidation = `跌破${technical.supportPrice || technical.ma20 || "结构支撑位"}，或题材催化证伪、分支转入退潮时取消跟踪`;
  return { ...stock, dataComplete, missingFields, branch: branch.branchName || branch.shortName, branchStatus: branch.status, branchAction: branch.action, branchReason: branch.reason, role, trackingScore: round(expectationGap, 0), trackingLabel, trackingReason, selection: { priority, stage: technical.breakoutStage || "结构待补", thesis: `${theme.shortName}${branch.branchName ? `/${branch.branchName}` : ""}具备题材支撑，当前重点验证预期差能否被资金与量价兑现。`, trigger, invalidation }, scores: { total: round(score, 0), upsidePotential: round(expectationGap, 0), catalystFit, liquidity, riskQuality, themeFit, themeStrength: effectiveThemeStrength, capital, priceVolume, trend, fundamental }, reasons, selected: !reject, exclusion };
}

function buildThemeConclusion(theme, rank) {
  const flowText = Number.isFinite(theme.mainFlow) ? `领涨分支主力净流入约${theme.mainFlow}亿元` : "资金净流入字段待下一轮补齐";
  const amountText = Number.isFinite(theme.turnover) ? `代表分支最大成交承载约${theme.turnover}亿元（不重复累加重合指数）` : "成交承载待下一轮补齐";
  const phase = theme.activeBranchCount >= 2 && theme.changePct >= 2 ? "多分支共振" : theme.changePct >= 2 ? "单分支启动" : rank === 0 ? "主线辨识阶段" : "轮动验证阶段";
  const persistence = theme.r3 ?? theme.r5;
  const continuity = Number.isFinite(persistence) ? (persistence >= 8 ? "高" : persistence >= 3 ? "中高" : "待验证") : "待连续数据验证";
  const breadthText = Number.isFinite(theme.breadth) ? `分支上涨覆盖率${theme.breadth}%` : "分支广度待补齐";
  const limitText = Number.isFinite(theme.limitUpCount) ? `涨停${theme.limitUpCount}家` : "涨停梯队待补齐";
  const branchText = (theme.branches || []).map((branch) => `${branch.branchName}：${branch.status}`).join("；");
  return {
    ...theme,
    rank: rank + 1,
    phase,
    continuity,
    conclusion: rank === 0 ? `${theme.shortName}由${theme.branchCount}个相近分支归并形成父主线，${theme.primaryBranch}当前领涨；先看分支共振，再从可上车分支选择核心股。` : `${theme.shortName}属于第${rank + 1}层父主线，只有分支扩散、资金承接和核心股结构同步增强才升级。`,
    evidence: [`父主线强度 ${theme.strength}/100，置信度${theme.mainlineConfidence}`, `归并${theme.branchCount}个分支：${branchText}`, breadthText, limitText, amountText, flowText, ...(Number(theme.sentimentLeaderCount) > 0 ? [`确认${theme.sentimentLeaderCount}只非ST涨停情绪先锋，计入题材辨识度但不进入可买推荐`] : [])],
    impact: rank === 0 ? "决定候选池的主要风险预算与首要观察顺序。" : "作为轮动或补涨来源，仓位和追价容忍度低于第一主线。",
    nextAction: rank === 0 ? "只在标记为可上车的分支中寻找龙头/中军触发；分歧分支等确认，加速分支不追，退潮分支不执行。" : "等待至少两个分支连续两个观察窗口改善，再从轮动升级为主动主线。",
    risk: "若可上车分支降为分歧、分支上涨覆盖率跌破50%或核心股集体掉队，父主线立即降级；相似名称不等于资金共振。"
  };
}

function rebuildCachedThemeHierarchy(cachedDecision) {
  const oldThemes = Array.isArray(cachedDecision?.themes) ? cachedDecision.themes : [];
  if (!oldThemes.length || oldThemes.every((theme) => Array.isArray(theme.branches))) return null;
  const groups = new Map();
  for (const oldTheme of oldThemes) {
    const branchName = oldTheme.branchName || rawThemeName(oldTheme.name || oldTheme.shortName);
    const branch = { ...oldTheme, branchName, keywords: [...new Set([branchName, oldTheme.shortName, ...(oldTheme.keywords || [])].filter(Boolean))] };
    delete branch.stocks;
    delete branch.roleSummary;
    const family = familyForTheme(branch);
    const key = family?.id || `single:${canonicalThemeName(branchName)}`;
    const entry = groups.get(key) || { family, branches: [], stockGroups: [] };
    entry.branches.push(branch);
    entry.stockGroups.push({ branchName, stocks: Array.isArray(oldTheme.stocks) ? oldTheme.stocks : [] });
    groups.set(key, entry);
  }
  const parents = [...groups.values()].map((entry) => ({ entry, theme: buildThemeGroup(entry.family?.id || entry.branches[0].id, entry.family, entry.branches) }))
    .sort((a, b) => Number(b.theme.eligibleMainline) - Number(a.theme.eligibleMainline) || b.theme.strength - a.theme.strength)
    .slice(0, 3);
  const rebuiltThemes = parents.map(({ entry, theme }, index) => {
    const ranked = buildThemeConclusion(theme, index);
    const stockMap = new Map();
    for (const group of entry.stockGroups) {
      const branch = ranked.branches.find((item) => item.branchName === group.branchName) || ranked.branches[0];
      for (const stock of group.stocks) {
        const coreRole = ["龙头候选", "中军候选", "核心跟随"].includes(stock.role);
        const branchAllowed = ranked.eligibleMainline !== false && !["退潮", "观察"].includes(branch.status) && (branch.status !== "分歧" || coreRole);
        const upgraded = { ...stock, branch: group.branchName, branchStatus: branch.status, branchAction: branch.action, branchReason: branch.reason, selected: Boolean(stock.selected && branchAllowed), themeId: ranked.id, theme: ranked.shortName, themeRank: index + 1 };
        const prior = stockMap.get(stock.code);
        if (!prior || Number(upgraded.scores?.total || 0) > Number(prior.scores?.total || 0)) stockMap.set(stock.code, upgraded);
      }
    }
    ranked.stocks = [...stockMap.values()].sort((a, b) => Number(b.scores?.total || 0) - Number(a.scores?.total || 0));
    ranked.roleSummary = ["龙头候选", "中军候选", "核心跟随", "补涨候选", "跟随股", "掉队观察"].map((role) => ({ role, names: ranked.stocks.filter((stock) => stock.role === role).map((stock) => stock.name) })).filter((item) => item.names.length);
    return ranked;
  });
  const themes = ensureMainlineSlots(rebuiltThemes, "Wind接口额度限流；现有当日缓存仅包含合并前3个题材，缺少第4名以后候选");
  const opportunities = themes.flatMap((theme) => theme.stocks || []).sort((a, b) => Number(b.scores?.total || 0) - Number(a.scores?.total || 0));
  const firstTheme = themes[0]?.shortName || "父主线";
  return {
    ...cachedDecision,
    market: { ...cachedDecision.market, conclusion: `${firstTheme}暂列父主线辨识度第一；已按共同驱动合并小题材，并以分支阶段决定是否允许生成交易计划。`, nextAction: `下一窗口验证${firstTheme}各分支的强度、资金与核心股是否继续共振。` },
    themes,
    opportunities,
    review: { ...cachedDecision.review, conclusion: `市场 → 相似小题材归并为${firstTheme} → 分支阶段 → 个股多维筛选 → 五日回测 → 框架反思。` },
    linkages: [
      { from: "市场", to: "题材", rule: "市场档位决定父主线风险预算。" },
      { from: "题材", to: "分支", rule: "同产业链、同核心驱动的小题材先归并去重；父主线须由多分支共振确认。" },
      { from: "分支", to: "个股", rule: "先判断可上车、分歧、加速不追、退潮，再选择龙头、中军和核心跟随。" },
      { from: "个股", to: "回测", rule: "冻结当日入选原因，记录未来5个交易日路径，不以后见之明改写样本。" },
      { from: "回测", to: "复盘", rule: "定位错误维度；满30个完成样本后才允许小幅调整框架权重。" }
    ],
    methodology: {
      ...(cachedDecision.methodology || {}),
      themeAggregation: {
        rule: "按共同核心驱动与产业链上下游归并相似小题材，并对重合指数成交额去重；父主线成立需多分支共振。",
        branchStages: ["可上车：强度与父主线共振", "分歧：涨幅、资金或广度未同向", "加速不追：涨幅过快，等待回踩", "退潮：价格和强度同步转弱，禁止主动计划"]
      }
    }
  };
}

function buildAiReview(decision) {
  const market = decision?.market || {};
  const liquidity = market.liquidity || {};
  const breadth = market.breadth || {};
  const sentiment = market.sentiment || {};
  const flows = market.flows || {};
  const themes = Array.isArray(decision?.themes) ? decision.themes.slice(0, 3) : [];
  const valid = (value) => value !== null && value !== undefined && value !== "" && Number.isFinite(Number(value));
  const n = (value, digits = 1) => Number(value).toFixed(digits);
  const marketFacts = [];
  if (valid(liquidity.currentTurnover)) marketFacts.push(`万得全A当前累计成交${n(liquidity.currentTurnover, 3)}万亿元`);
  if (valid(breadth.up) && valid(breadth.down) && valid(breadth.flat)) marketFacts.push(`万得全A成分上涨${n(breadth.up, 0)}家、下跌${n(breadth.down, 0)}家、平盘${n(breadth.flat, 0)}家`);
  if (valid(breadth.limitUp)) marketFacts.push(`涨停${n(breadth.limitUp, 0)}家`);
  if (valid(breadth.limitDown)) marketFacts.push(`跌停${n(breadth.limitDown, 0)}家`);
  if (valid(sentiment.yesterdayLimitAvg)) marketFacts.push(`昨日涨停组合今日平均${Number(sentiment.yesterdayLimitAvg) >= 0 ? "上涨" : "下跌"}${n(Math.abs(Number(sentiment.yesterdayLimitAvg)))}%`);
  if (valid(sentiment.continuationRate)) marketFacts.push(`连板成功${n(sentiment.continuationCount, 0)}家，连板率${n(sentiment.continuationRate)}%`);
  if (valid(flows.mainFlow)) marketFacts.push(`万得全A主力资金${Number(flows.mainFlow) >= 0 ? "净流入" : "净流出"}${n(Math.abs(Number(flows.mainFlow)))}亿元`);
  const themeSections = themes.map((theme, index) => {
    const name = theme.shortName || theme.name || `题材${index + 1}`;
    const branches = theme.branches || [];
    const ready = branches.filter((item) => item.status === "可上车");
    const ladder = theme.ladder || { height: 0, stocks: [], shape: "暂无已确认涨停成分股" };
    const ladderStocks = (ladder.stocks || []).slice(0, 8).map((item) => `${item.name}${Number(item.boards) > 1 ? `${item.boards}板` : "首板"}${item.firstLimitTime ? `(${item.firstLimitTime}首封)` : ""}`).join("、");
    const ladderText = ladder.stocks?.length ? `系统逐股核对题材成分股，确认${ladder.stocks.length}只涨停，最高${ladder.height}板，${ladder.shape}${ladderStocks ? `；梯队为${ladderStocks}` : ""}` : "题材成分股中暂无已确认涨停股票";
    const branchText = branches.map((item) => `${item.branchName || item.shortName}${item.status}`).join("、");
    const catalyst = theme.catalysts?.items?.[0];
    const catalystText = catalyst ? `直接催化为“${catalyst.title}”。` : "当前判断主要由结构化行情和成分股反馈支持。";
    return {
      title: `${name}——${ready.length ? "有可交易分支，但必须接受承接检验" : "强势不等于可追，等待分支给出承接"}`,
      judgment: `${catalystText}${name}的判断不只依据板块涨幅，而是同时观察产业驱动、分支扩散、成分股涨停梯队、封板时间和容量股承接。${ladderText}。`,
      evidence: [`父题材综合强度${n(theme.strength, 0)}/100；分支状态：${branchText || "暂无有效分支"}`],
      action: ready.length ? `优先验证${ready.map((item) => item.branchName || item.shortName).join("、")}在分歧时能否保持容量和核心股承接；涨停股只作为情绪锚点，不进入可买推荐。` : "没有分支通过可交易门槛前，不因单只先锋涨停提高题材级别。"
    };
  });
  const top = themes[0]?.shortName || "第一主线";
  return {
    title: `${market.regime || "市场阶段待判"}：只用本轮可验证数据判断资金是否形成合力`,
    conclusion: `本轮复盘删除了无法稳定取得的预测成交、前日成交比较、炸板率和不可靠资金拆分，只保留Wind本轮可验证事实。当前重点不是堆砌指标，而是观察${top}能否由局部强势扩散成市场共识。`,
    sections: [
      { title: "大局观：先确认市场是否有进攻能力", judgment: `市场当前被识别为${market.regime || "待识别"}。${marketFacts.join("；") || "本轮没有通过校验的市场统计字段"}。这些数据用于判断交易活跃度和极端情绪，但不会被扩展成尚未取得的预测或资金身份结论。`, evidence: marketFacts, action: "市场数据决定风险预算，题材和成分股结构决定资金具体投向。" },
      { title: "情绪结构：题材梯队由成分股逐股统计", judgment: "全市场不稳定的炸板等字段已从分析框架删除。题材强度改用成分股涨停数、最高板、各板高度数量、首次封板时间、开板次数以及容量股响应共同判断。", evidence: themes.map((theme) => `${theme.shortName}：${theme.ladder?.limitUpCount || 0}只涨停、最高${theme.ladder?.height || 0}板、${theme.ladder?.shape || "暂无梯队"}`), action: "早封且梯队完整代表共识更强；只有首板孤立爆发或高标独舞时，按轮动而非主升处理。" },
      ...themeSections,
      { title: "最重要的变化：看局部强势能否扩散", judgment: `${top}暂列第一，但主线成立仍需要不同分支和不同角色共同响应。单一概念指数上涨、单只股票封板或者新闻刺激，都不足以单独证明持续性。`, evidence: themes.map((theme) => `${theme.shortName}强度${n(theme.strength, 0)}，成分股涨停${theme.ladder?.limitUpCount || 0}只`).slice(0, 3), action: "下一观察窗口重点看核心股分歧承接、容量中军、第二分支扩散和催化是否继续兑现。" }
    ],
    tomorrow: [`观察${top}的成分股梯队是否扩展而非收缩`, "观察最早封板先锋能否带动容量中军与可交易后排", "若只有高标继续上涨、分支和中军不响应，按拥挤与轮动处理"],
    risk: "复盘只使用通过字段、来源和统计恒等式校验的数据；不可稳定取得的维度已退出分析框架。"
  };
}
function portfolioConclusion(baseState, decision) {
  const positions = Array.isArray(baseState?.positions) ? baseState.positions : [];
  const equity = Number(baseState?.account?.equity) || 0;
  if (!positions.length) return {
    title: "当前为空仓，AI建议先分配主题风险预算，而不是先找满仓理由",
    conclusion: `市场为${decision.market.regime}，首要关注${decision.themes[0]?.shortName || "主线"}；在触发条件成立前保持现金选择权。`,
    evidence: ["暂无持仓暴露", `${decision.opportunities.filter((item) => item.selected).length}只股票通过多维初筛`, "所有自动计划仍需人工批准"],
    impact: "没有历史仓位拖累，可按主线强弱建立首笔试错，但不应同时买入同一产业链的多个高度相关标的。",
    nextAction: "优先从第一主线选择1只龙头/中军候选，首笔不超过计划总仓位的40%—50%。"
  };
  const value = positions.reduce((sum, item) => sum + (Number(item.lastPrice) || Number(item.cost) || 0) * (Number(item.shares) || 0), 0);
  const themeMap = decision.themes.map((theme) => ({ theme: theme.shortName, count: positions.filter((item) => theme.keywords.some((key) => `${item.theme || ""} ${item.thesis || ""}`.toLowerCase().includes(key.toLowerCase()))).length }));
  const unmapped = Math.max(0, positions.length - themeMap.reduce((sum, item) => sum + item.count, 0));
  return {
    title: unmapped ? `${unmapped}个持仓尚未映射到当前主线，组合存在“逻辑孤岛”` : "持仓已完成主线映射，下一步看集中度与失效条件",
    conclusion: `当前持仓${positions.length}只、估算仓位${equity ? round(value / equity * 100, 1) : "—"}%；AI将市场状态与题材强弱同步用于持仓处置。`,
    evidence: themeMap.filter((item) => item.count).map((item) => `${item.theme} ${item.count}只`).concat(unmapped ? [`未映射 ${unmapped}只`] : []),
    impact: "弱于主线、跌破计划风险线或缺少可验证逻辑的仓位，应比盈利仓更早进入处置队列。",
    nextAction: "刷新持仓行情后，优先检查主题降级、单票集中度和止损缓冲三项异常。"
  };
}

function planConclusion(baseState, automation, decision) {
  const plans = Array.isArray(baseState?.plans) ? baseState.plans : [];
  const signals = Array.isArray(automation?.signals) ? automation.signals : [];
  const triggered = signals.filter((item) => String(item.stage).includes("已触发"));
  return {
    title: triggered.length ? `${triggered.length}个信号触发，但必须通过题材地位复核后才可执行` : "当前没有可直接执行的信号，等待题材与量价共振",
    conclusion: `AI把${signals.length}个自动信号与${decision.themes.length}条题材主线交叉验证；仅技术形态成立但不属于有效主线的标的会被降级。`,
    evidence: [`已有计划 ${plans.length}个`, `自动信号 ${signals.length}个`, `已触发 ${triggered.length}个`],
    impact: "交易计划不再是孤立价格表，而是随市场档位、题材强弱和个股角色动态调整首笔仓位。",
    nextAction: triggered.length ? "先确认所属题材仍在前两位、核心股未掉队，再按触发区间和止损执行。" : "保留条件单思维，不为完成交易次数降低门槛。"
  };
}

async function runTerminalScript(script, args = []) {
  await fs.access(script);
  return new Promise((resolve) => {
    const child = spawn("C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script, ...args], { windowsHide: true, stdio: "ignore" });
    const timer = setTimeout(() => { child.kill(); resolve(false); }, 90_000);
    child.on("error", () => { clearTimeout(timer); resolve(false); });
    child.on("close", (code) => { clearTimeout(timer); resolve(code === 0); });
  });
}

async function confirmScheduledTerminalCapture(stateFile, reason) {
  if (!String(reason || "").startsWith("fixed-")) return true;
  const root = path.join(path.dirname(stateFile), "..");
  const label = String(reason).replace(/^fixed-/, "");
  const script = path.join(root, "wind-terminal-capture-confirm.ps1");
  await fs.access(script);
  return new Promise((resolve) => {
    const child = spawn("C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe", ["-NoProfile", "-STA", "-ExecutionPolicy", "Bypass", "-File", script, "-ScheduleLabel", `${label}定时刷新`], { windowsHide: true, stdio: "ignore" });
    child.on("error", () => resolve(false));
    child.on("close", (code) => resolve(code === 0));
  });
}

async function runTerminalScriptWithRetries(script, args = [], retryCount = 3) {
  const maxAttempts = Math.max(1, Number(retryCount) + 1);
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const succeeded = await runTerminalScript(script, args).catch(() => false);
    if (succeeded) return true;
    if (attempt < maxAttempts) await new Promise((resolve) => setTimeout(resolve, 1500));
  }
  return false;
}
async function showTerminalCaptureResult(stateFile, result) {
  const root = path.join(path.dirname(stateFile), "..");
  const script = path.join(root, "wind-terminal-capture-result.ps1");
  const success = result?.forecast === true && result?.marketSentiment === true && result?.limitLadder === true;
  const failedStep = result?.stoppedAt === "forecast" ? "万得全A预测成交额" : result?.stoppedAt === "910" ? "910市场情绪" : result?.stoppedAt === "913" ? "913连板天梯" : "未知环节";
  await fs.access(script);
  return new Promise((resolve) => {
    const args = ["-NoProfile", "-STA", "-ExecutionPolicy", "Bypass", "-File", script, "-Status", success ? "Success" : "Failure"];
    if (!success) args.push("-FailedStep", failedStep);
    const child = spawn("C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe", args, { windowsHide: false, stdio: "ignore" });
    child.on("error", () => resolve(false));
    child.on("close", (code) => resolve(code === 3));
  });
}
async function persistTerminalCaptureCheckpoint(stateFile, result) {
  const checkpointFile = path.join(path.dirname(stateFile), "wind-terminal-capture-checkpoint.json");
  const payload = {
    forecast: result?.forecast === true,
    marketSentiment: result?.marketSentiment === true,
    limitLadder: result?.limitLadder === true,
    stoppedAt: result?.stoppedAt || null,
    updatedAt: new Date().toISOString()
  };
  const temp = `${checkpointFile}.tmp`;
  await fs.mkdir(path.dirname(checkpointFile), { recursive: true });
  await fs.writeFile(temp, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  await fs.rename(temp, checkpointFile);
  return payload;
}
async function refreshTerminalFallbacks(stateFile, prior = null) {
  const root = path.join(path.dirname(stateFile), "..");
  // Wind pages share one foreground window. Each step is a gate: never type the next command on an unconfirmed page.
  const forecast = prior?.forecast === true || await runTerminalScriptWithRetries(path.join(root, "wind-terminal-forecast.ps1"), [], 3).catch(() => false);
  if (!forecast) return persistTerminalCaptureCheckpoint(stateFile, { forecast: false, marketSentiment: false, limitLadder: false, stoppedAt: "forecast" });
  await persistTerminalCaptureCheckpoint(stateFile, { forecast: true, marketSentiment: false, limitLadder: false, stoppedAt: "910" });
  const marketSentiment = prior?.marketSentiment === true || await runTerminalScriptWithRetries(path.join(root, "wind-terminal-page-capture.ps1"), ["-PageCode", "910"], 3).catch(() => false);
  if (!marketSentiment) return persistTerminalCaptureCheckpoint(stateFile, { forecast: true, marketSentiment: false, limitLadder: false, stoppedAt: "910" });
  await persistTerminalCaptureCheckpoint(stateFile, { forecast: true, marketSentiment: true, limitLadder: false, stoppedAt: "913" });
  const limitLadder = prior?.limitLadder === true || await runTerminalScriptWithRetries(path.join(root, "wind-terminal-page-capture.ps1"), ["-PageCode", "913"], 3).catch(() => false);
  return persistTerminalCaptureCheckpoint(stateFile, { forecast: true, marketSentiment: true, limitLadder, stoppedAt: limitLadder ? null : "913" });
}
export function createAiDecisionEngine({ windCall, automationStatus, readBaseState, stateFile, safeError, selectionBacktest = null }) {
  const debriefAgent = createDebriefAgent({ dataDir: path.dirname(stateFile), fallback: generateDeepLocalDebrief });
  let runtime = { ...DEFAULT_STATE };

  async function load() {
    try { runtime = { ...DEFAULT_STATE, ...JSON.parse(await fs.readFile(stateFile, "utf8")), running: false, progress: null }; }
    catch (error) { if (error?.code !== "ENOENT") runtime.lastError = safeError(error); }
    const retryAt = runtime.quotaRetryAfter ? new Date(runtime.quotaRetryAfter).getTime() : 0;
    if (retryAt > 0 && retryAt <= Date.now() && /额度|限流/.test(String(runtime.refreshWarning || ''))) {
      runtime.refreshWarning = null;
      runtime.quotaRetryAfter = null;
      if (/Wind限流/.test(String(runtime.dataFreshness?.label || ''))) {
        runtime.dataFreshness = { ...runtime.dataFreshness, label: '最近成功快照已超时，等待重新刷新', degradationReason: '历史限额冷却已结束，等待下一次结构化Wind刷新确认' };
      }
    }
    if (!runtime.quotaRetryAfter && !runtime.refreshWarning && /Wind限流/.test(String(runtime.dataFreshness?.label || ''))) {
      runtime.dataFreshness = { ...runtime.dataFreshness, label: '最近成功快照已超时，等待重新刷新', degradationReason: '历史限额冷却已结束，等待下一次结构化Wind刷新确认' };
    }
    return runtime;
  }

  async function persist() {
    await fs.mkdir(new URL(".", `file:///${stateFile.replaceAll("\\", "/")}`).pathname, { recursive: true }).catch(() => {});
    const clean = { ...runtime, running: false, progress: null };
    const temp = `${stateFile}.tmp`;
    await fs.writeFile(temp, `${JSON.stringify(clean, null, 2)}\n`, "utf8");
    await fs.rename(temp, stateFile);
  }

  function setProgress(step, total, label) { runtime.progress = { step, total, label }; }

  async function run({ reason = "manual" } = {}) {
    if (runtime.running) return status();
    if (runtime.quotaRetryAfter && Date.now() < new Date(runtime.quotaRetryAfter).getTime()) {
      const retryTime = new Date(runtime.quotaRetryAfter).toLocaleTimeString("zh-CN", { timeZone: "Asia/Shanghai", hour: "2-digit", minute: "2-digit", second: "2-digit" });
      runtime.refreshWarning = `Wind额度处于冷却期，将在${retryTime}后自动重试；当前保留最近成功快照。`;
      return status();
    }
    runtime.running = true;
    runtime.lastError = null;
    runtime.refreshWarning = null;
    const startedAt = new Date().toISOString();
    try {
      setProgress(1, 6, "等待确认Wind终端截屏取数");
      const terminalCaptureApproved = await confirmScheduledTerminalCapture(stateFile, reason).catch(() => false);
      if (terminalCaptureApproved) {
        let retryTerminalCapture = false;
        let terminalResult = null;
        do {
          setProgress(1, 6, retryTerminalCapture ? "正在重试Wind终端截屏取数" : "读取Wind终端预测成交额与市场上下文");
          terminalResult = await refreshTerminalFallbacks(stateFile, retryTerminalCapture ? terminalResult : null).catch(() => ({ forecast: false, marketSentiment: false, limitLadder: false, stoppedAt: "unknown" }));
          retryTerminalCapture = await showTerminalCaptureResult(stateFile, terminalResult).catch(() => false);
        } while (retryTerminalCapture);
      } else {
        runtime.refreshWarning = "本轮未确认终端截屏取数，已跳过万得全A、910与913页面采集；结构化Wind数据继续刷新。";
      }
      const [automation, baseState, adaptiveWeights] = await Promise.all([automationStatus(), readBaseState(), selectionBacktest?.weights?.() || Promise.resolve(null)]);
      const asOf = todayShanghai();

      setProgress(2, 6, "识别全市场高辨识度题材");
      const dateText = `${Number(asOf.slice(0, 4))}年${Number(asOf.slice(5, 7))}月${Number(asOf.slice(8, 10))}日`;
      const refreshClock = shanghaiClock();
      const realtimeScope = `${dateText}截至${refreshClock.hhmm}最新盘中`;
      const [hotPayload, coldPayload, freshnessAnchorPayload] = await Promise.all([
        windCall("analytics_data", "get_financial_data", { question: `${dateText}A股产业和事件类Wind概念指数按涨跌幅从高到低排序取前30名并列出成交额和交易时间，排除连板、涨停、精选、金股、风格和策略指数`, lang: "CNS" }, 90_000),
        windCall("analytics_data", "get_financial_data", { question: `${dateText}A股产业和事件类Wind概念指数按成交额从高到低排序取前30名并列出涨跌幅和交易时间，排除连板、涨停、精选、金股、风格和策略指数`, lang: "CNS" }, 90_000).catch(() => ({ data: [] })),
        windCall("index_data", "get_index_price_indicators", { windcode: "881001.WI", indexes: "交易时间" }, 45_000).catch(() => ({ data: [] }))
      ]);
      const marketTasks = [
        () => windCall("analytics_data", "get_financial_data", { question: `${dateText}万得全A当日成交额和交易时间`, lang: "CNS" }, 90_000),
        () => windCall("analytics_data", "get_financial_data", { question: `${dateText}截至当前A股全市场上涨数量`, lang: "CNS" }, 90_000),
        () => windCall("analytics_data", "get_financial_data", { question: `${dateText}截至当前A股全市场下跌数量`, lang: "CNS" }, 90_000),
        () => windCall("analytics_data", "get_financial_data", { question: `${dateText}截至当前A股全市场平盘数量`, lang: "CNS" }, 90_000),
        () => windCall("analytics_data", "get_financial_data", { question: `${dateText}截至当前A股全市场涨停数量和跌停数量`, lang: "CNS" }, 90_000),
        () => windCall("analytics_data", "get_financial_data", { question: `${dateText}昨日涨停股票今日平均涨跌幅`, lang: "CNS" }, 90_000),
        () => windCall("analytics_data", "get_financial_data", { question: `${dateText}A股昨日涨停家数、连板成功家数、触及涨停家数和炸板家数`, lang: "CNS" }, 90_000),
        () => windCall("analytics_data", "get_financial_data", { question: `${dateText}万得全A指数主力净流入额、超大单净流入额和小单净流入额`, lang: "CNS" }, 90_000)
      ];
      const [marketLiquidityPayload, marketUpCountPayload, marketDownCountPayload, marketFlatCountPayload, marketLimitPayload, marketYesterdayPerformancePayload, marketSentimentPayload, marketFlowPayload] = await mapLimit(marketTasks, 2, async (task) => task().catch(() => ({ data: [] })));
      const hotRows = rowsFromPayload(hotPayload);
      const freshnessAnchorRows = rowsFromPayload(freshnessAnchorPayload);
      await fs.writeFile(new URL("./data/last-theme-hot-debug.json", import.meta.url), JSON.stringify({ queriedAt: new Date().toISOString(), queryMode: "Wind产业事件题材双池：涨幅前30+成交额前30，再统一归类过滤", rowCount: hotRows.length, freshnessAnchorRows, rows: hotRows.slice(0, 30), turnoverRows: rowsFromPayload(coldPayload).slice(0, 30) }, null, 2), "utf8").catch(() => {});
      const aShareThemeRows = hotRows.filter((row) => themeFromRow(row));
      if (!hotRows.length) throw new Error("REALTIME_THEME_SOURCE_EMPTY: Wind实时题材查询返回0行");
      if (!aShareThemeRows.length) throw new Error("REALTIME_THEME_ROWS_UNUSABLE: Wind返回内容中没有通过产业/事件题材校验的行");
      const dataFreshness = assessFreshness([...aShareThemeRows, ...freshnessAnchorRows]);
      if (!dataFreshness.isFresh) throw new Error(`REALTIME_DATA_STALE: ${dataFreshness.label}，最近Wind时间${dataFreshness.marketTimestamp || "未知"}，已阻止生成主线和交易计划`);
      const coldRows = rowsFromPayload(coldPayload).filter((row) => themeFromRow(row));
      const discovered = discoverThemes([...aShareThemeRows, ...coldRows]);
      if (!discovered.length) throw new Error("NO_DYNAMIC_THEMES: Wind未返回可验证的A股实时题材指数，已阻止回退到固定题材模板");
      const enrichedGroups = await mapLimit(discovered, 2, async (theme) => {
        const branches = await mapLimit((theme.branches || []).slice(0, 3), 2, async (branch) => {
          if (!branch.windCode) return { ...branch, snapshotError: "题材指数代码缺失" };
          const snapshot = await windCall("index_data", "get_index_price_indicators", { windcode: branch.windCode, indexes: THEME_SNAPSHOT_INDEXES }, 45_000);
          return mergeThemeSnapshot(branch, snapshot);
        });
        const family = THEME_FAMILIES.find((item) => item.id === theme.id) || null;
        return buildThemeGroup(theme.id, family, branches.length ? branches : theme.branches);
      });
      const ranked = ensureMainlineSlots(enrichedGroups.sort((a, b) => b.strength - a.strength).map((theme, index) => buildThemeConclusion({ ...theme, dataFresh: true }, index)), "Wind全市场候选去重后暂不足3个独立父题材");

      setProgress(3, 6, "沿题材产业链筛选真实受益个股");
      const themePayloads = await mapLimit(ranked, 2, async (theme) => {
        const targetBranches = (theme.branches || []).filter((branch) => branch.status !== "退潮").slice(0, 3);
        const branches = targetBranches.length ? targetBranches : (theme.branches || []).slice(0, 1);
        const branchPayloads = await mapLimit(branches, 2, async (branch) => {
          let payload = await windCall("analytics_data", "get_financial_data", {
            question: `${asOf}${branch.branchName}相关非ST的A股，列出Wind代码、证券简称和交易时间，按当日综合活跃度前20`,
            lang: "CNS"
          }, 90_000);
          if (!rowsFromPayload(payload).some((row) => stockFromRow(row))) {
            payload = await windCall("stock_data", "search_stocks", { question: `筛选A股中属于${branch.branchName}概念、当日有成交且非ST的股票` }, 60_000);
          }
          return { branch, payload };
        });
        const fullScope = [...new Set([theme.shortName, ...(theme.keywords || [])])].slice(0, 8).join("、");
        const primaryBranch = branches[0] || { branchName: theme.shortName };
        const newsQuery = `${dateText}${theme.shortName}催化事件政策产业价格订单产品发布异动原因市场热议传闻小作文未来观察窗口`.replace(/\s+/g, "");
        const [familyPayload, pioneerPayload, ladderPayload, windCatalystPayload] = await Promise.all([
          windCall("analytics_data", "get_financial_data", {
            question: `${asOf}${fullScope}产业链相关非ST的A股，列出Wind代码、证券简称和所属概念，按当日综合活跃度前30`,
            lang: "CNS"
          }, 90_000).catch(() => ({ data: [] })),
          windCall("stock_data", "search_stocks", {
            question: `筛选A股中属于${fullScope}产业链、今日涨停且非ST的股票`
          }, 60_000).catch(() => ({ data: [] })),
          windCall("analytics_data", "get_financial_data", {
            question: `${dateText}${theme.shortName}题材非ST涨停股连板梯队，列出Wind代码、证券简称、连续涨停天数、首次涨停时间、最后涨停时间、开板次数、封单金额、封单占成交额、换手率、近10日和近30日涨跌幅`,
            lang: "CNS"
          }, 90_000).catch(() => ({ data: [] })),
          windCall("financial_docs", "get_financial_news", { query: newsQuery, top_k: 6 }, 90_000).catch(() => ({ data: [] }))
        ]);
        theme.ladder = parseThemeLadder(ladderPayload);
        theme.ladder.stocks = theme.ladder.stocks.map((stock) => ({ ...stock, limitStrength: scoreLimitUpStrength(stock) }));
        theme.limitUpCount = theme.ladder.limitUpCount;
        theme.catalysts = parseThemeCatalysts(windCatalystPayload);
        theme.catalysts.sourceCount = new Set(theme.catalysts.items.map((item) => item.source).filter(Boolean)).size;
        theme.catalysts.sourceTypes = [...new Set(theme.catalysts.items.map((item) => item.sourceType || (item.url ? "web-search" : "wind-news")))];
        theme.catalysts.crossValidated = theme.catalysts.sourceCount >= 2 && theme.catalysts.sourceTypes.length >= 2;
        theme.catalysts.quality = theme.catalysts.crossValidated ? "Wind与外部资讯交叉验证" : theme.catalysts.quality;
        Object.assign(theme, recalculateThemeStrength(theme));
        return {
          theme,
          payloads: [
            ...branchPayloads,
            { branch: primaryBranch, payload: familyPayload, familyScope: true },
            { branch: primaryBranch, payload: pioneerPayload, emotionPool: true }
          ]
        };
      });

      setProgress(4, 6, "计算量价、趋势位置与角色分层");
      for (const item of themePayloads) {
        const themeRows = (item.payloads || []).filter((entry) => entry?.payload && entry?.branch).flatMap((entry) => rowsFromPayload(entry.payload).map((row) => ({ ...row, __branchName: entry.branch.branchName, __emotionHint: Boolean(entry.emotionPool) })));
        const allCandidates = uniqueStocks(themeRows).filter((stock) => !isStStock(stock));
        const windLimitCandidates = allCandidates.filter((stock) => stock.emotionHint);
        const chosen = [];
        const chosenCodes = new Set();
        for (const stock of allCandidates.filter((candidate) => candidate.emotionHint).slice(0, 3)) {
          if (!chosenCodes.has(stock.code)) { chosen.push(stock); chosenCodes.add(stock.code); }
        }
        for (const branch of item.theme.branches || []) {
          for (const stock of allCandidates.filter((candidate) => candidate.branchHint === branch.branchName).slice(0, 3)) {
            if (!chosenCodes.has(stock.code)) { chosen.push(stock); chosenCodes.add(stock.code); }
          }
        }
        for (const stock of allCandidates) if (chosen.length < 7 && !chosenCodes.has(stock.code)) { chosen.push(stock); chosenCodes.add(stock.code); }
        const candidates = chosen.slice(0, 7);
        const enriched = await mapLimit(candidates, 3, async (stock) => {
          const [snapshot, mapping] = await Promise.all([
            windCall("stock_data", "get_stock_price_indicators", { windcode: stock.code, indexes: STOCK_SNAPSHOT_INDEXES }, 45_000),
            stock.emotionHint
              ? windCall("stock_data", "get_stock_basicinfo", { question: `${stock.code}主营业务、所属行业和所属概念板块`, lang: "中文" }, 60_000).catch(() => null)
              : Promise.resolve(null)
          ]);
          const quoted = mapping ? mergeStockBusinessMapping(mergeStockSnapshot(stock, snapshot), mapping) : mergeStockSnapshot(stock, snapshot);
          if (isStStock(quoted) || isLimitUpStock(quoted)) return quoted;
          const kline = await windCall("stock_data", "get_stock_kline", { windcode: stock.code, begin_date: daysBefore(120), end_date: compactDate() }, 45_000);
          return { ...quoted, technical: computeTechnical(kline) };
        });
        // Wind natural-language screening and ladder queries are discovery
        // sources, not proof of a limit-up. Verify every candidate against a
        // same-day quote before it can affect the ladder or theme strength.
        const ladderStocks = item.theme.ladder?.stocks || [];
        const quoteByKey = new Map(enriched.map((stock) => [stock.code || stock.name, stock]));
        const evidencePool = uniqueStocks([
          ...windLimitCandidates,
          ...ladderStocks.map((stock) => ({ ...stock, emotionHint: true, branchHint: item.theme.primaryBranch }))
        ]).slice(0, 40);
        const verifiedEvidence = await mapLimit(evidencePool, 3, async (stock) => {
          const key = stock.code || stock.name;
          if (quoteByKey.has(key)) return quoteByKey.get(key);
          if (!stock.code) return null;
          try {
            const snapshot = await windCall("stock_data", "get_stock_price_indicators", { windcode: stock.code, indexes: STOCK_SNAPSHOT_INDEXES }, 45_000);
            return mergeStockSnapshot(stock, snapshot);
          } catch {
            return null;
          }
        });
        const verifiedLimitStocks = verifiedEvidence.filter((stock) => stock && !isStStock(stock) && isLimitUpStock(stock));
        const ladderByKey = new Map(ladderStocks.map((stock) => [stock.code || stock.name, stock]));
        item.theme.sentimentLeaders = verifiedLimitStocks.map((stock) => {
          const ladderStock = ladderByKey.get(stock.code || stock.name) || {};
          const merged = { ...ladderStock, ...stock, boards: Number(ladderStock.boards) || 1 };
          const limitStrength = scoreLimitUpStrength(merged);
          return {
            code: stock.code,
            name: stock.name,
            role: "情绪先锋",
            branch: branchForStock(stock, item.theme).branchName,
            changePct: stock.changePct,
            latestPrice: stock.latestPrice,
            limitUpPrice: stock.limitUpPrice,
            turnover: stock.turnover,
            mainFlow: stock.mainFlow,
            firstLimitTime: limitStrength.firstLimitTime,
            lastLimitTime: limitStrength.lastLimitTime,
            brokenCount: limitStrength.brokenCount,
            boards: limitStrength.boards,
            limitStrengthScore: limitStrength.score,
            limitStrengthLabel: limitStrength.label,
            reason: `${limitStrength.label}；首封${limitStrength.firstLimitTime || "待补"}，开板${limitStrength.brokenCount == null ? "待补" : `${limitStrength.brokenCount}次`}。涨停股只用于题材强度、扩散和带动性判断，不进入可买推荐。`
          };
        });
        item.theme.ladder = summarizeThemeLadder(item.theme.sentimentLeaders, "Wind候选逐股行情核验后统计");        item.theme.sentimentLeaderCount = item.theme.ladder.limitUpCount || 0;
        item.theme.limitUpCount = item.theme.ladder.limitUpCount;
        Object.assign(item.theme, recalculateThemeStrength(item.theme));
        const tradable = enriched.filter((stock) => !isStStock(stock) && !isLimitUpStock(stock) && Number.isFinite(stock.latestPrice) && stock.technical);
        const prelim = tradable.map((stock) => {
          const r5 = Number(stock.r5 ?? stock.technical?.r5) || 0;
          const r20 = Number(stock.r20 ?? stock.technical?.r20) || 0;
          const distance = Number(stock.technical?.distanceHigh20Pct);
          const notExtended = r5 <= 12 && r20 <= 30 ? 22 : r5 > 20 || r20 > 45 ? -25 : 5;
          const structure = stock.technical?.breakoutStage === "准备突破" ? 24 : stock.technical?.breakoutStage === "确认突破" ? 18 : stock.technical?.breakoutStage === "疑似假突破" ? -25 : 5;
          const nearResistance = Number.isFinite(distance) && distance >= -9 && distance <= 2 ? 16 : 0;
          return { ...stock, sortScore: (stock.mainFlow || 0) * .35 + (stock.turnover || 0) * .10 + notExtended + structure + nearResistance };
        }).sort((a, b) => b.sortScore - a.sortScore);
        const fundamentalResults = await mapLimit(prelim.slice(0, 5), 2, async (stock) => {
          const payload = await windCall("stock_data", "get_stock_fundamentals", { question: `${stock.code}最新ROE、营业收入同比增速、归母净利润同比增速、经营现金流、资产负债率和报告期`, lang: "中文" }, 60_000);
          return mergeStockFundamentals(stock, payload);
        });
        const fundamentalsByCode = new Map(fundamentalResults.map((stock) => [stock.code, stock]));
        const complete = prelim.map((stock) => fundamentalsByCode.get(stock.code) || { ...stock, fundamentalError: "非前五预期差候选，未调用基本面接口" });
        const branchCounts = new Map();
        for (const stock of complete) { const name = branchForStock(stock, item.theme).branchName; branchCounts.set(name, (branchCounts.get(name) || 0) + 1); }
        const branchSeen = new Map();
        item.theme.stocks = complete.map((stock) => {
          const name = branchForStock(stock, item.theme).branchName;
          const index = branchSeen.get(name) || 0;
          branchSeen.set(name, index + 1);
          return scoreStock(stock, item.theme, index, branchCounts.get(name) || 1, adaptiveWeights);
        }).sort((a, b) => Number(b.selected) - Number(a.selected) || Number(b.trackingScore || 0) - Number(a.trackingScore || 0) || Number(b.scores?.total || 0) - Number(a.scores?.total || 0));
        item.theme.roleSummary = ["龙头候选", "中军候选", "补涨候选", "跟随股", "掉队观察"].map((role) => ({ role, names: item.theme.stocks.filter((stock) => stock.role === role).map((stock) => stock.name) })).filter((entry) => entry.names.length);
      }

      setProgress(5, 6, "生成跨TAB因果链与组合动作");
      const themes = themePayloads.map((item) => item.theme)
        .sort((a, b) => Number(b.strength || 0) - Number(a.strength || 0))
        .map((theme, index) => {
          const refreshed = buildThemeConclusion(theme, index);
          return { ...refreshed, stocks: (theme.stocks || []).map((stock) => ({ ...stock, themeRank: index + 1 })) };
        });
      const opportunities = themes.flatMap((theme) => (theme.stocks || []).map((stock) => ({ ...stock, themeId: theme.id, theme: theme.shortName, themeRank: theme.rank }))).sort((a, b) => Number(b.selected) - Number(a.selected) || Number(b.trackingScore || 0) - Number(a.trackingScore || 0) || Number(b.scores?.total || 0) - Number(a.scores?.total || 0));
      const marketRows = [
        ...rowsFromPayload(marketLiquidityPayload).map((row) => ({ ...row, __marketLayer: "core" })),
        ...rowsFromPayload(marketUpCountPayload).map((row) => ({ ...row, __marketLayer: "breadth" })),
        ...rowsFromPayload(marketDownCountPayload).map((row) => ({ ...row, __marketLayer: "breadth" })),
        ...rowsFromPayload(marketFlatCountPayload).map((row) => ({ ...row, __marketLayer: "breadth" })),
        ...rowsFromPayload(marketLimitPayload).map((row) => ({ ...row, __marketLayer: "breadth" })),
        ...rowsFromPayload(marketYesterdayPerformancePayload).map((row) => ({ ...row, __marketLayer: "yesterday-performance" })),
        ...rowsFromPayload(marketSentimentPayload).map((row) => ({ ...row, __marketLayer: "sentiment" })),
        ...rowsFromPayload(marketFlowPayload).map((row) => ({ ...row, __marketLayer: "flow" })),
      ];
      const marketContext = deriveMarketContext(marketRows, themes);
      try {
        const terminalForecast = JSON.parse(await fs.readFile(new URL("./data/wind-terminal-fallback/latest.json", import.meta.url), "utf8"));
        const ageMs = Date.now() - new Date(terminalForecast.capturedAt).getTime();
        if (terminalForecast.ok === true && terminalForecast.windcode === "881001.WI" && ageMs >= 0 && ageMs <= 20 * 60_000 && Number.isFinite(Number(terminalForecast.projectedTurnoverTrillion))) {
          const forecast = Number(terminalForecast.projectedTurnoverTrillion);
          marketContext.liquidity.projectedTurnover = round(forecast, 3); marketContext.liquidity.forecastMethod = "Wind金融终端OCR";
          marketContext.liquidity.turnoverDeltaPct = Number.isFinite(Number(terminalForecast.changePct)) ? round(Number(terminalForecast.changePct), 1) : null;
          marketContext.liquidity.gateGap = round(forecast - marketContext.liquidity.fixedGate, 3); marketContext.liquidity.gateSupported = forecast >= marketContext.liquidity.fixedGate;
          marketContext.liquidity.terminalEvidence = { capturedAt: terminalForecast.capturedAt, screenshot: terminalForecast.screenshot, validation: terminalForecast.validation };
        }
      } catch {}
      try {
        const terminalRoot = new URL("./data/wind-terminal-fallback/", import.meta.url);
        const terminal910 = JSON.parse(await fs.readFile(new URL("910-latest.json", terminalRoot), "utf8"));
        const terminal913 = JSON.parse(await fs.readFile(new URL("913-latest.json", terminalRoot), "utf8"));
        const valid910 = terminalSnapshotUsable(terminal910);
        const valid913 = terminalSnapshotUsable(terminal913);
        const parsed910 = valid910 ? parseTerminal910(terminal910) : null;
        const parsed913 = valid913 ? parseTerminal913(terminal913) : null;
        marketContext.terminalFallback = {
          marketSentiment: parsed910 ? { capturedAt: parsed910.capturedAt, parsed: parsed910, screenshot: terminal910.screenshot } : null,
          limitLadder: parsed913 ? { capturedAt: parsed913.capturedAt, parsed: parsed913, screenshot: terminal913.screenshot } : null
        };
        if (parsed910?.breadth) marketContext.breadth = { ...marketContext.breadth, ...parsed910.breadth, source: "Wind终端910全屏OCR双源校验" };
        if (parsed910?.limits) {
          marketContext.breadth.limitUp = parsed910.limits.limitUp;
          marketContext.breadth.limitDown = parsed910.limits.limitDown;
          marketContext.sentiment.brokenLimit = parsed910.limits.opened;
        }
        if (Number.isFinite(parsed910?.relative?.yesterdayLimitAvg)) marketContext.sentiment.yesterdayLimitAvg = parsed910.relative.yesterdayLimitAvg;
        if (Number.isFinite(parsed910?.flows?.institution)) marketContext.flows.institutionProxy = parsed910.flows.institution;
        if (Number.isFinite(parsed910?.flows?.main)) marketContext.flows.mainFlow = parsed910.flows.main;
        if (Number.isFinite(parsed910?.flows?.retail)) marketContext.flows.retailFlow = parsed910.flows.retail;
        marketContext.sentiment.marketLadder = parsed913?.observed ? parsed913 : null;
        marketContext.terminalFallbackParsed = { marketSentiment: parsed910?.validation || null, limitLadder: parsed913?.validation || null };
      } catch (error) {
        marketContext.terminalFallbackError = safeError(error);
      }
      const regime = marketContext.regime;
      const confidence = marketContext.confidence;
      const decision = {
        dataFreshness,
        market: {
          title: `当前市场为${regime}，主线交易优先于宽泛撒网`,
          regime,
          confidence,
          liquidity: marketContext.liquidity,
          breadth: marketContext.breadth,
          sentiment: marketContext.sentiment,
          flows: marketContext.flows,
          conclusion: `${themes[0]?.shortName || "最强题材"}暂列父主线辨识度第一；量能、市场广度、涨停接力与资金结构共同决定能否提高交易仓位。`,
          evidence: [`Wind行情时间 ${dataFreshness.marketTimestamp}`, `${dataFreshness.label}，全市场动态扫描${hotRows.length}组样本`, ...marketContext.evidence],
          impact: regime.includes("进攻") ? "允许提高有效主线的验证效率，但不放宽个股失效边界。" : "降低首笔仓位和追价容忍度，只做强题材中的强角色。",
          nextAction: `下一观察窗口重点验证${themes[0]?.shortName || "第一主线"}的成交承载、资金连续性和龙头稳定性。`
        },
        themes,
        opportunities,
        portfolio: null,
        plans: null,
        review: {
          title: "复盘重点从“涨跌结果”改为“因果链是否兑现”",
          conclusion: `今日链条：${regime}市场 → 相似小题材归并为${themes[0]?.shortName || "父主线"} → 分支划分可上车/分歧/加速/退潮 → 核心个股按角色与量价分层 → 仅通过多维门槛者进入计划。`,
          evidence: [`主线候选 ${themes.length}条`, `多维个股样本 ${opportunities.length}只`, `通过初筛 ${opportunities.filter((item) => item.selected).length}只`],
          impact: "如果市场或题材层先失效，即使个股技术形态未破坏，也应降低计划优先级。",
          nextAction: "明日复盘先记录市场档位与主线排名变化，再评价个股执行，不倒因为果。"
        },
        linkages: [
          { from: "市场", to: "题材", rule: `${regime}决定主题风险预算；仅高辨识度主题获得主动交易额度。` },
          { from: "题材", to: "分支", rule: "同产业链、同核心驱动的小题材先归并去重；父主线须由多个分支共振确认，单一小题材异动不得冒充主线。" },
          { from: "分支", to: "个股", rule: "先判断可上车、分歧、加速不追、退潮，再结合产业链真实性、角色地位和量价结构确定候选优先级。" },
          { from: "个股", to: "回测", rule: "每日15:00冻结全部AI入选样本及理由，记录未来5个交易日，不挑选成功案例。" },
          { from: "市场+题材", to: "持仓", rule: "市场降档或题材掉出主线时，自动收紧首笔仓位并提升处置优先级。" },
          { from: "回测", to: "复盘", rule: "区分题材、催化、资金、量价、基本面、预期差和市场环境错误，并反向更新分析框架。" }
        ],
        methodology: {
          themeAggregation: {
            rule: "按共同核心驱动与产业链上下游归并相似小题材，并对重合指数的成交额去重；父主线成立需多分支共振，强单分支仅作候选观察。",
            universeRule: "主线池只接收产业题材与事件题材；打板、连板、首板、非ST、涨停样本、风格因子和选股标签仅用于情绪判断，禁止进入主线排名。",
            branchStages: ["可上车：强度与资金接近父主线并有承接", "分歧：涨幅、资金或广度未同向", "加速不追：短期涨幅过快，等待回踩", "退潮：价格和强度同步跌破门槛，禁止主动计划"]
          },
          debriefFramework: DEBRIEF_FRAMEWORK,
          weights: [
            { name: "题材真实性", weight: adaptiveWeights?.themeFit ?? 18 }, { name: "题材多维强度", weight: adaptiveWeights?.themeStrength ?? 12 }, { name: "事件催化匹配", weight: adaptiveWeights?.catalystFit ?? 10 },
            { name: "资金承接", weight: adaptiveWeights?.capital ?? 14 }, { name: "量价结构", weight: adaptiveWeights?.priceVolume ?? 12 }, { name: "趋势位置", weight: adaptiveWeights?.trend ?? 8 },
            { name: "基本面", weight: adaptiveWeights?.fundamental ?? 10 }, { name: "预期差/上涨潜力", weight: adaptiveWeights?.upsidePotential ?? 12 }, { name: "流动性", weight: adaptiveWeights?.liquidity ?? 4 }
          ],
          selectionFramework: {
            funnel: ["题材与事件真实映射", "排除ST、涨停和不可交易状态", "资金与流动性门槛", "平台/突破量价结构", "基本面与催化交叉验证", "预期差与剩余上涨空间排序", "触发条件与失效边界"],
            hardGates: ["题材映射分不低于75", "题材多维强度不低于55", "流动性分不低于42", "风险质量分不低于40", "预期差分不低于55", "综合分不低于60"],
            ranking: "先通过所有硬门槛，再按预期差分排序；综合分用于准入，不用于替代上涨空间判断。"
          },
          learningPolicy: "每日15:00冻结入选理由，跟踪未来5个交易日；前30个完成样本仅影子学习，达到门槛后每5个新样本最多小幅调整一次维度权重，并保留历史版本。",
          dataGate: "实时价格、成交额、换手率、当日及5日资金流、K线结构、ROE/增长率和财务报告期任一关键组缺失时，不进入主动推荐。",
          sourcePolicy: "当前采用Wind单源：行情、板块、资金、个股与财务使用结构化接口；政策、产业事件、异动解读和市场热议使用Wind财经新闻检索。Wind未单列社交媒体传闻榜，小作文覆盖可能不完整，任何消息都必须由量价、资金和题材扩散验证，不能单独判为主线。",
          boundary: "评分用于缩小研究范围，不代表收益承诺；回测结果在小样本阶段不用于直接优化参数。"
        }
      };
      const shouldRefreshReview = reason.startsWith("review-");
      if (shouldRefreshReview || !runtime.decision?.review) {
        decision.review = { ...(await debriefAgent.generate(decision)), generatedAt: new Date().toISOString(), scheduleSlot: reason.replace(/^review-/, "") };
      } else {
        decision.review = runtime.decision.review;
      }
      delete decision.portfolio;
      delete decision.plans;

      setProgress(6, 6, "保存统一AI决策图谱");
      const completedAt = new Date().toISOString();
      runtime = {
        ...runtime,
        running: false,
        progress: null,
        generatedAt: completedAt,
        asOf,
        dataFreshness,
        source: "Wind AI Fin Market · 实时动态题材扫描",
        decision,
        runs: [{ startedAt, completedAt, reason, themeCount: themes.length, stockCount: opportunities.length, selectedCount: opportunities.filter((item) => item.selected).length }, ...(runtime.runs || [])].slice(0, 20)
      };
      await persist();
      await selectionBacktest?.onDecision(decision, { asOf, reason }).catch((error) => { runtime.refreshWarning = `AI选股回测记录暂未更新：${safeError(error)}`; });
      return status();
    } catch (error) {
      const errorText = safeError(error);
      const cachedTimestamp = runtime.dataFreshness?.marketTimestamp;
      const cachedDay = cachedTimestamp ? new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(cachedTimestamp)) : null;
      const cachedUpgrade = errorText.includes("QUOTA_ERROR") && shanghaiClock().phase === "postclose" && cachedDay === todayShanghai()
        ? (rebuildCachedThemeHierarchy(runtime.decision) || { ...runtime.decision, themes: ensureMainlineSlots(runtime.decision?.themes || [], "Wind接口额度限流；第三主线等待下一顺位实时候选补位") })
        : null;
      if (cachedUpgrade) {
        const completedAt = new Date().toISOString();
        const dataFreshness = { ...(runtime.dataFreshness || {}), isFresh: true, phase: "postclose", label: "当日Wind收盘快照·本地新规则重算", degraded: true, degradationReason: "Wind接口额度限流；仅复用当日15:00收盘行情，不复用旧分析结论" };
        runtime = {
          ...runtime,
          running: false,
          progress: null,
          lastError: null,
          refreshWarning: "Wind接口额度限流；已使用当日收盘终值重新执行父主线与分支规则。",
          quotaRetryAfter: new Date(Date.now() + 5 * 60_000).toISOString(),
          generatedAt: completedAt,
          dataFreshness,
          source: "Wind AI Fin Market · 当日收盘行情 · 父主线/分支规则本地重算",
          decision: { ...cachedUpgrade, dataFreshness },
          runs: [{ startedAt, completedAt, reason: `${reason}-cached-postclose-rebuild`, themeCount: cachedUpgrade.themes.length, stockCount: cachedUpgrade.opportunities.length, selectedCount: cachedUpgrade.opportunities.filter((item) => item.selected).length, degraded: true }, ...(runtime.runs || [])].slice(0, 20)
        };
        await persist();
        return status();
      }
      const sameDayThemeSourceUnavailable = /REALTIME_DATA_STALE|REALTIME_THEME_SOURCE_EMPTY|REALTIME_THEME_ROWS_UNUSABLE/.test(errorText) && cachedDay === todayShanghai() && Array.isArray(runtime.decision?.themes) && runtime.decision.themes.length > 0;
      if (sameDayThemeSourceUnavailable) {
        runtime.running = false; runtime.progress = null; runtime.lastError = null;
        runtime.refreshWarning = errorText.includes("SOURCE_EMPTY") ? "Wind实时题材源本轮返回0行；保留上一轮成功研判并冻结新选股/计划，下一固定时点自动重试。" : errorText.includes("ROWS_UNUSABLE") ? "Wind本轮返回内容不属于可验证的产业/事件题材；保留上一轮成功研判并冻结新选股/计划。" : "Wind题材行情仍停留在上一时点；保留上一轮成功研判并冻结新选股/计划，下一固定时点自动重试。";
        runtime.dataFreshness = { ...(runtime.dataFreshness || {}), isFresh: false, degraded: true, label: "实时题材源暂未更新·旧研判只读", degradationReason: errorText };
        await persist(); return status();
      }
      const sameDayCacheAvailable = cachedDay === todayShanghai() && Array.isArray(runtime.decision?.themes) && runtime.decision.themes.length > 0;
      if (errorText.includes("QUOTA_ERROR") && sameDayCacheAvailable) {
        const marketTimestamp = runtime.dataFreshness?.marketTimestamp;
        const ageMinutes = marketTimestamp ? Math.max(0, (Date.now() - new Date(marketTimestamp).getTime()) / 60_000) : null;
        const phase = shanghaiClock().phase;
        const maxAgeMinutes = phase === "live" ? 5 : phase === "break" ? 15 : 360;
        const stillFresh = Number.isFinite(ageMinutes) && ageMinutes <= maxAgeMinutes;
        runtime.running = false;
        runtime.progress = null;
        runtime.lastError = null;
        runtime.refreshWarning = `Wind刷新触发额度限制，保留${marketTimestamp || "当日"}最近成功快照；系统将自动重试。`;
        runtime.quotaRetryAfter = new Date(Date.now() + 5 * 60_000).toISOString();
        runtime.dataFreshness = {
          ...(runtime.dataFreshness || {}),
          isFresh: stillFresh,
          phase,
          ageMinutes: round(ageMinutes, 1),
          maxAgeMinutes,
          degraded: true,
          label: stillFresh ? "Wind限流·最近成功快照仍在有效期" : "Wind限流·最近成功快照已超时，交易计划冻结"
        };
        await persist();
        return status();
      }
      runtime.running = false;
      runtime.progress = null;
      runtime.lastError = errorText;
      runtime.dataFreshness = { ...(runtime.dataFreshness || {}), isFresh: false, label: "实时刷新失败，旧结论与交易计划已冻结" };
      await persist().catch(() => {});
      throw error;
    }
  }

  async function runReview({ reason = "review-manual" } = {}) {
    if (runtime.running) return status();
    if (!runtime.decision) throw new Error("REVIEW_SOURCE_EMPTY: 尚无可复盘的当日决策快照");
    runtime.running = true; runtime.lastError = null; runtime.refreshWarning = null;
    try {
      setProgress(1, 2, "审计复盘证据包");
      const terminalRoot = new URL("./data/wind-terminal-fallback/", import.meta.url);
      try {
        const terminal910 = JSON.parse(await fs.readFile(new URL("910-latest.json", terminalRoot), "utf8"));
        const terminal913 = JSON.parse(await fs.readFile(new URL("913-latest.json", terminalRoot), "utf8"));
        const parsed910 = terminalSnapshotUsable(terminal910) ? parseTerminal910(terminal910) : null;
        const parsed913 = terminalSnapshotUsable(terminal913) ? parseTerminal913(terminal913) : null;
        if (parsed910?.breadth) runtime.decision.market.breadth = { ...runtime.decision.market.breadth, ...parsed910.breadth, source: "Wind终端910全屏OCR双源校验" };
        if (parsed910?.limits) runtime.decision.market.breadth = { ...runtime.decision.market.breadth, limitUp: parsed910.limits.limitUp, limitDown: parsed910.limits.limitDown };
        if (Number.isFinite(parsed910?.relative?.yesterdayLimitAvg)) runtime.decision.market.sentiment.yesterdayLimitAvg = parsed910.relative.yesterdayLimitAvg;
        if (parsed910) {
          runtime.decision.market.flows = parsed910.validation?.flowsValid
            ? { ...runtime.decision.market.flows, institutionProxy: parsed910.flows.institution, mainFlow: parsed910.flows.main, retailFlow: parsed910.flows.retail, middleFlow: parsed910.flows.middle, source: "Wind终端910资金分层平衡校验" }
            : { ...runtime.decision.market.flows, institutionProxy: null, mainFlow: null, retailFlow: null, middleFlow: null, source: null };
        }
        runtime.decision.market.sentiment.marketLadder = parsed913?.observed ? parsed913 : null;
      } catch (error) { runtime.refreshWarning = `终端证据未更新：${safeError(error)}`; }
      setProgress(2, 2, "独立复盘Agent生成深度文章");
      const prior = runtime.decision.review;
      const generated = await debriefAgent.generate(runtime.decision);
      if (!validateDebrief(generated)) throw new Error("DEBRIEF_QUALITY_GATE_FAILED: 文章深度或禁词校验未通过，保留上一成功版本");
      runtime.decision.review = { ...generated, generatedAt: new Date().toISOString(), scheduleSlot: reason.replace(/^review-/, ""), priorGeneratedAt: prior?.generatedAt || null };
      runtime.generatedAt = runtime.decision.review.generatedAt;
      runtime.running = false; runtime.progress = null;
      await persist();
      return status();
    } catch (error) {
      runtime.running = false; runtime.progress = null; runtime.lastError = safeError(error); await persist().catch(() => {}); throw error;
    }
  }
  function status() {
    return {
      ...runtime,
      autoThemeRefresh: { mode: "fixed-five-times", timezone: "Asia/Shanghai", tradingDays: "周一至周五", times: AUTO_THEME_REFRESH_SLOTS.map((slot) => slot.label) },
      autoReviewRefresh: { mode: "fixed-two-times", timezone: "Asia/Shanghai", tradingDays: "周一至周五", times: AUTO_REVIEW_REFRESH_SLOTS.map((slot) => slot.label), lastGeneratedAt: runtime.decision?.review?.generatedAt || null }
    };
  }

  async function start() {
    await load();
    if (runtime.decision) {
      runtime.decision.methodology = { ...(runtime.decision.methodology || {}), debriefFramework: DEBRIEF_FRAMEWORK };
      runtime.decision.methodology.weights = [
        { name: "题材真实性", weight: 18 }, { name: "题材多维强度", weight: 12 }, { name: "事件催化匹配", weight: 10 },
        { name: "资金承接", weight: 14 }, { name: "量价结构", weight: 12 }, { name: "趋势位置", weight: 8 },
        { name: "基本面", weight: 10 }, { name: "预期差/上涨潜力", weight: 12 }, { name: "流动性", weight: 4 }
      ];
      runtime.decision.methodology.selectionFramework = {
        funnel: ["题材与事件真实映射", "排除ST、涨停和不可交易状态", "资金与流动性门槛", "平台/突破量价结构", "基本面与催化交叉验证", "预期差与剩余上涨空间排序", "触发条件与失效边界"],
        hardGates: ["题材映射分不低于75", "题材多维强度不低于55", "流动性分不低于42", "风险质量分不低于40", "预期差分不低于55", "综合分不低于60"],
        ranking: "先通过所有硬门槛，再按预期差分排序；综合分用于准入，不用于替代上涨空间判断。"
      };
      runtime.decision.methodology.learningPolicy = "每日15:00冻结入选理由，跟踪未来5个交易日；前30个完成样本仅影子学习，达到门槛后每5个新样本最多小幅调整一次维度权重，并保留历史版本。";
      delete runtime.decision.portfolio;
      delete runtime.decision.plans;
      await persist();
    }
    if (runtime.decision?.themes) runtime.decision.themes = ensureMainlineSlots(runtime.decision.themes, "Wind下一顺位候选等待实时补位");
    let hierarchyNormalized = false;
    if (Array.isArray(runtime.decision?.themes)) {
      for (const theme of runtime.decision.themes) {
        const beforeCount = (theme.stocks || []).length;
        theme.stocks = (theme.stocks || []).filter((stock) => !isLimitUpStock(stock));
        if (theme.stocks.length !== beforeCount) {
          hierarchyNormalized = true;
          theme.roleSummary = ["龙头候选", "中军候选", "核心跟随", "补涨候选", "跟随股", "掉队观察"]
            .map((role) => ({ role, names: theme.stocks.filter((stock) => stock.role === role).map((stock) => stock.name) }))
            .filter((item) => item.names.length);
        }
        if (theme.eligibleMainline !== false) continue;
        hierarchyNormalized = true;
        theme.branches = (theme.branches || []).map((branch) => branch.status === "退潮" ? branch : { ...branch, status: "观察", action: "暂缓", reason: "父题材尚未达到主线共振或成交承载门槛，分支不能单独标记为可上车。" });
        theme.activeBranchCount = 0;
        theme.stocks = (theme.stocks || []).map((stock) => ({ ...stock, branchStatus: "观察", branchAction: "暂缓", branchReason: "父题材未通过主线门槛", selected: false, exclusion: stock.exclusion || "父题材未通过主线共振或成交承载门槛" }));
      }
      if (hierarchyNormalized) {
        runtime.decision.opportunities = runtime.decision.themes.flatMap((theme) => theme.stocks || []).sort((a, b) => Number(b.scores?.total || 0) - Number(a.scores?.total || 0));
        await persist();
      }
    }
    const attemptedSlots = new Set();
    const attemptedReviewSlots = new Set();
    const checkFixedSchedule = () => {
  const clock = shanghaiClock();
      if (!new Set(["Mon", "Tue", "Wed", "Thu", "Fri"]).has(clock.weekday)) return;
      const slot = AUTO_THEME_REFRESH_SLOTS.find((item) => item.minutes === clock.minutes);
      if (!slot) return;
      const runKey = `${clock.day}-${slot.key}`;
      // One-off pause requested for today only; tomorrow follows the normal schedule.
      if (clock.day === "2026-08-12" && slot.key === "1430") { attemptedSlots.add(runKey); return; }
      if (attemptedSlots.has(runKey) || runtime.running) return;
      attemptedSlots.add(runKey);
      run({ reason: `fixed-${slot.key}` }).catch(() => {});
    };
    const checkReviewSchedule = () => {
  const clock = shanghaiClock();
      if (!new Set(["Mon", "Tue", "Wed", "Thu", "Fri"]).has(clock.weekday)) return;
      const slot = AUTO_REVIEW_REFRESH_SLOTS.find((item) => item.minutes === clock.minutes);
      if (!slot) return;
      const runKey = `${clock.day}-review-${slot.key}`;
      if (attemptedReviewSlots.has(runKey) || runtime.running) return;
      attemptedReviewSlots.add(runKey);
      runReview({ reason: `review-${slot.key}` }).catch(() => {});
    };
    checkFixedSchedule();
    checkReviewSchedule();
    setInterval(() => { checkFixedSchedule(); checkReviewSchedule(); }, 30_000).unref();
  }

  return { run, runReview, status, start };
}












