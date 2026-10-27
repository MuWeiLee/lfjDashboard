// 涨停事件工作台 · 计算层
//
// 取数配方来自四轮字段探针（结论见 scripts/limitup/probe4.mjs / probe4-report.txt），三条硬约束：
//   1. `question` 里绝不能出现「涨跌停状态」「涨跌停时间」字样 —— 一旦出现，Wind 静默返回空表（不报错）。
//      封板时间必须走侧门：点名「首次封板时间」会连带返回真正的 `涨跌停时间` 列（完整时分秒）。
//   2. 措辞未命中时返回空表而非异常，因此所有取数必须「空表即重试」。
//   3. 历史日不支持「涨停」措辞，只能用「收盘价等于当日涨停价」拿涨停名单（无封板时间）。
//
// 只做计算与取数，不落库；落库由 scripts/limitup/build.mjs 负责。
import {
  windCall,
  tables,
  objects,
  localDate,
  limitStreakLabel,
  anomalyThemeName,
  anomalyFamily,
  NON_NARRATIVE_ANOMALY_PATTERN,
  VERIFIED_STANDALONE_THEME_PATTERN,
  loadLimitHistory,
  isEligibleNarrativeTheme,
  detectThemeFamilies,
  previousTradingDate
} from "./engine.js";

const SECTOR_ATTEMPTS = 2;
const SEARCH_RETRY_GAP_MS = 1200;
const ROW_CAP = 100;
const waitFor = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ── 配方 ①：今日涨停事件表（按板块拆分） ──────────────────────────────────
// 一次调用同时得到：Wind代码 / 证券简称 / 所属概念板块 / 涨跌停时间（首次封板时间戳）
//
// 必须分板块：全市场一次查会撞 Wind 的 100 行硬上限。实测同一时刻
// 「沪深A股」返回 100 行 / 50 个唯一代码（且被截断的 9 只恰好是科创板与部分沪主板），
// 而「主板51 + 创业板5 + 科创板3 + 北交所0」并集 59 只，与「收盘价=涨停价」口径完全一致。
const SECTORS = [
  { key: "主板", phrase: "主板A股" },
  { key: "创业板", phrase: "创业板A股" },
  { key: "科创板", phrase: "科创板A股" },
  { key: "北交所", phrase: "北交所A股" }
];
const eventQuestion = (day, phrase) => `筛选${day}涨停的${phrase}并返回Wind代码、证券简称、首次封板时间、所属概念板块`;

// 单个板块：空表要重试（措辞偶发未命中），但北交所涨停为 0 是常态，因此只在「全部板块为空」时判失败
async function fetchSectorRows(day, sector) {
  let lastError = null;
  for (let attempt = 1; attempt <= SECTOR_ATTEMPTS; attempt += 1) {
    try {
      const payload = await windCall("stock_data", "search_stocks", { question: eventQuestion(day, sector.phrase) });
      const rows = tables(payload).flatMap(objects);
      if (rows.length) return { rows, capped: rows.length >= ROW_CAP, error: null };
      lastError = `第${attempt}次空表`;
    } catch (error) {
      lastError = `第${attempt}次: ${String(error?.message || error)}`;
    }
    if (attempt < SECTOR_ATTEMPTS) await waitFor(attempt * SEARCH_RETRY_GAP_MS);
  }
  return { rows: [], capped: false, error: `${sector.key} ${lastError}` };
}

async function fetchLimitEventRows(day) {
  const results = await Promise.all(SECTORS.map((sector) => fetchSectorRows(day, sector)));
  const rows = results.flatMap((result) => result.rows);
  const cappedSectors = SECTORS.filter((_, index) => results[index].capped).map((sector) => sector.key);
  if (!rows.length) {
    const detail = results.map((result) => result.error).filter(Boolean).join(" / ");
    return { rows: [], cappedSectors, errors: [`涨停事件表全板块为空: ${detail}`], complete: false };
  }
  return {
    rows, cappedSectors, complete: cappedSectors.length === 0,
    // 触顶板块的家数会被截断，必须告警而不是静默接受
    errors: cappedSectors.length ? [`${cappedSectors.join("/")}触顶${ROW_CAP}行，该板块家数可能不全`] : []
  };
}

// `2026-10-26T09:49:27+08:00` → `09:49:27`
function sealClock(value) {
  return String(value || "").match(/(\d{2}):(\d{2}):(\d{2})/)?.[0] || null;
}

// ── 配方 ③：跌停事件表 ──────────────────────────────────────────────────
// 探针实测：历史日同样支持「跌停」措辞（20261023 返回 9 只），且带 `涨跌停状态=-1`；
// 「首次跌停时间」与「首次封板时间」同理，会侧门带出 `涨跌停时间` 列。
// 但 Wind 会混入语义漂移行（近一年/前一年每日涨跌停状态），必须按查询日的状态列过滤。
//
// 跌停家数远少于涨停，但个股同样会因多概念拆成多行（实测 10 行 → 5 只），
// 因此「沪深A股」聚合 + 各板块拆分取并集再按代码去重：聚合查询在极端日会撞 100 行上限，
// 板块拆分则偶发漏（探针里主板只回 2 只、聚合回 8 只），两者互补比单选任一都稳。
const DOWN_SECTORS = [
  { key: "沪深", phrase: "沪深A股" },
  { key: "主板", phrase: "主板A股" },
  { key: "创业板", phrase: "创业板A股" },
  { key: "科创板", phrase: "科创板A股" },
  { key: "北交所", phrase: "北交所A股" }
];
const downEventQuestion = (day, phrase) => `筛选${day}跌停的${phrase}并返回Wind代码、证券简称、首次跌停时间、所属概念板块`;
const downStatusKey = (day) => `${String(day).slice(0, 4)}年${Number(String(day).slice(4, 6))}月${Number(String(day).slice(6, 8))}日涨跌停状态`;
const DOWN_DRIFT_PATTERN = /近一年|前一年|首次跌停日期/;
// 任一「涨跌停状态 / 涨跌停日期」列：用来识别 Wind 把「某日跌停」理解成「某段区间跌停」
const ANY_STATUS_COLUMN_PATTERN = /涨跌停状态|涨跌停日期|跌停日期/;

// 当日跌停判据：优先看「查询日涨跌停状态」=-1；没有该列时退回「有涨跌停时间且不是漂移行」。
// Wind 偶发把「某日跌停」理解成「某段区间跌停」，那批行会带别的日期状态列或近一年/前一年列，一律不采信。
export function isLimitDownRow(row, day) {
  if (!row) return false;
  const key = downStatusKey(day);
  if (key in row) return String(row[key]) === "-1";
  if (Object.keys(row).some((name) => DOWN_DRIFT_PATTERN.test(name))) return false;
  if (Object.keys(row).some((name) => ANY_STATUS_COLUMN_PATTERN.test(name))) return false;
  return Boolean(row["涨跌停时间"]);
}

async function fetchDownSector(day, sector, { isAggregate = false } = {}) {
  let lastError = null;
  let threw = false;
  for (let attempt = 1; attempt <= SECTOR_ATTEMPTS; attempt += 1) {
    try {
      const payload = await windCall("stock_data", "search_stocks", { question: downEventQuestion(day, sector.phrase) });
      const rows = tables(payload).flatMap(objects);
      if (rows.length) {
        const down = rows.filter((row) => isLimitDownRow(row, day));
        // 有行却一只都不匹配查询日：措辞被理解跑偏了。聚合口径必须报错（家数不可信），
        // 板块口径只当作 0（北交所常年无跌停，报错纯属噪音）。
        const error = isAggregate && !down.length ? `${sector.key}返回 ${rows.length} 行但无${day}跌停行（疑似语义漂移）` : null;
        return { rows: down, capped: rows.length >= ROW_CAP, error };
      }
    } catch (error) {
      lastError = `第${attempt}次: ${String(error?.message || error)}`;
      threw = true;
    }
    if (attempt < SECTOR_ATTEMPTS) await waitFor(attempt * SEARCH_RETRY_GAP_MS);
  }
  return { rows: [], capped: false, error: threw ? `${sector.key} ${lastError}` : null };
}

async function fetchLimitDownRows(day) {
  const results = await Promise.all(DOWN_SECTORS.map((sector, index) => fetchDownSector(day, sector, { isAggregate: index === 0 })));
  const byCode = new Map();
  // 同一只股票会因多个概念拆成多行，必须按代码去重（实测 10 行 → 5 只）
  for (const row of results.flatMap((result) => result.rows)) {
    const code = row["Wind代码"];
    if (code && !byCode.has(code)) byCode.set(code, row);
  }
  const cappedSectors = DOWN_SECTORS.filter((_, index) => results[index].capped).map((sector) => sector.key);
  // 「沪深A股」覆盖面最全，它失败才真正无法判断家数是否完整；
  // 单个板块查询偶发抖动（北交所最容易被语义跑偏）只降级、不报错。
  const aggregateError = results[0]?.error || null;
  return {
    rows: [...byCode.values()],
    cappedSectors,
    errors: [
      ...(aggregateError ? [`沪深A股跌停查询不可信：${aggregateError}`] : []),
      ...(cappedSectors.length ? [`${cappedSectors.join("/")}跌停触顶${ROW_CAP}行，家数可能不全`] : [])
    ],
    complete: cappedSectors.length === 0 && !aggregateError
  };
}

// 只取家数：用于「跌停家数环比」，不解析个股。
// 与当日同口径（多板块并集去重），否则「较上日」会和主数字互相打架。
async function fetchLimitDownCount(day) {
  if (!day) return null;
  const result = await fetchLimitDownRows(day).catch(() => null);
  if (!result || !result.complete) return null;
  return result.rows.length;
}

// ── 配方 ④：昨日涨停股今日溢价（赚钱效应）与竞价溢价 ──────────────────────
// 短线选手真正关心的是「昨天涨停的票今天能不能兑现」，所以把昨日涨停名单按昨日板高拆成
// 「首板 / 连板」两组比较今日涨跌幅中位数：两组都为正说明接力赚钱；连板明显弱于首板，
// 说明高度不被认可，之后往往就是空间板折戟。
// 措辞沿用主工作台已验证的 `{昨日}涨停股票在{今日}的最新涨跌幅排名`。
//
// 竞价溢价（今日开盘涨幅）刻画 9:25 竞价强度：高开说明隔夜资金愿意溢价接。
// 两句都是自然语言取数，Wind 偶发把名单理解跑偏（返回今日涨停股、全市场或区间口径），
// 所以解析必须过护栏：要能认出数值列、且返回值绝大多数落在昨日涨停名单里；
// 任一项不达标就整体置 null —— 宁可不显示，也不能把漂移结果当数据用。
const PREMIUM_ATTEMPTS = 2;
const PREMIUM_COLUMN_PATTERN = /涨跌幅\s*(?:\(%\)|%)?$/;
const AUCTION_COLUMN_PATTERN = /(?:开盘涨幅|竞价涨幅)\s*(?:\(%\)|%)?$/;
// 「涨跌幅排名」「近一年涨跌幅」这类列不是当日数值，必须排除
const PREMIUM_DRIFT_PATTERN = /近一年|前一年|每日|排名/;
const PREMIUM_PRECISION_MIN = 0.8;
const PREMIUM_MIN_HITS = 2;

const round2 = (value) => Math.round(value * 100) / 100;
const medianOf = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};

async function askAnalytics(question) {
  let lastError = null;
  for (let attempt = 1; attempt <= PREMIUM_ATTEMPTS; attempt += 1) {
    try {
      const rows = tables(await windCall("analytics_data", "get_financial_data", { question })).flatMap(objects);
      if (rows.length) return { rows, error: null };
      lastError = `第${attempt}次空表`;
    } catch (error) {
      lastError = `第${attempt}次: ${String(error?.message || error)}`;
    }
    if (attempt < PREMIUM_ATTEMPTS) await waitFor(attempt * SEARCH_RETRY_GAP_MS);
  }
  return { rows: [], error: lastError };
}

// 行 → 「Wind代码 → 数值」，并用昨日涨停名单做漂移护栏（命中率过低说明名单被理解跑了）
function premiumValues(rows, suffixPattern, codeSet) {
  const keys = Object.keys(rows[0] || {});
  const column = keys.find((key) => suffixPattern.test(key) && !PREMIUM_DRIFT_PATTERN.test(key)
    && rows.some((row) => Number.isFinite(Number(row[key])))) || null;
  if (!column) return { values: new Map(), column: null, hits: 0, precision: 0 };
  const all = new Map();
  for (const row of rows) {
    const code = row["Wind代码"];
    const value = Number(row[column]);
    if (code && Number.isFinite(value) && !all.has(code)) all.set(code, value);
  }
  const hits = [...all.keys()].filter((code) => codeSet.has(code)).length;
  const precision = all.size ? hits / all.size : 0;
  if (hits < PREMIUM_MIN_HITS || precision < PREMIUM_PRECISION_MIN) {
    return { values: new Map(), column, hits, precision };
  }
  return { values: all, column, hits, precision };
}

// 溢价汇总（纯函数）：昨日涨停名单 × 今日涨跌幅 → 中位数 / 上涨占比 / 首板与连板分组
export function summarizePremium({ values = new Map(), codes = [], streakOf = () => 1 } = {}) {
  const overall = [];
  const first = [];
  const ladder = [];
  for (const code of codes) {
    const value = values.get(code);
    if (!Number.isFinite(value)) continue;
    overall.push(value);
    ((streakOf(code) || 1) >= 2 ? ladder : first).push(value);
  }
  const group = (list) => ({ count: list.length, median: list.length ? round2(medianOf(list)) : null });
  return {
    sampleSize: overall.length,
    median: overall.length ? round2(medianOf(overall)) : null,
    upRatio: overall.length ? round2(overall.filter((value) => value > 0).length / overall.length) : null,
    first: group(first),
    ladder: group(ladder)
  };
}

async function fetchPremium({ baseDay, day, codes = [], streakOf = () => 1 }) {
  // 盘前构建时行情还停在上一交易日（baseDay === day），此时「今日涨跌幅」就是昨天的，没有意义
  if (!baseDay || !day || baseDay === day || !codes.length) return null;
  const codeSet = new Set(codes);

  const [trendResult, auctionResult] = await Promise.all([
    askAnalytics(`${baseDay}涨停股票在${day}的最新涨跌幅排名`),
    askAnalytics(`${baseDay}涨停股票在${day}的开盘涨幅`)
  ]);

  const trend = premiumValues(trendResult.rows, PREMIUM_COLUMN_PATTERN, codeSet);
  const auction = premiumValues(auctionResult.rows, AUCTION_COLUMN_PATTERN, codeSet);
  const auctionSummary = summarizePremium({ values: auction.values, codes, streakOf });

  return {
    day, baseDay,
    complete: trend.values.size > 0,
    column: trend.column,
    precision: round2(trend.precision),
    ...summarizePremium({ values: trend.values, codes, streakOf }),
    // 竞价溢价：取不到就 null，不参与结论
    auction: auctionSummary.sampleSize
      ? { sampleSize: auctionSummary.sampleSize, median: auctionSummary.median }
      : null,
    auctionError: auction.values.size ? null : (auctionResult.error || "未识别到开盘涨幅列（措辞待验证）"),
    error: trend.values.size ? null : (trendResult.error || "返回结果未通过口径护栏（疑似名单漂移）")
  };
}

const clockMinutes = (clock) => (clock ? Number(clock.slice(0, 2)) * 60 + Number(clock.slice(3, 5)) : null);

const SEAL_BUCKETS = [
  { label: "09:30前(竞价)", from: -1, to: 570 },
  { label: "09:30-10:00", from: 570, to: 600 },
  { label: "10:00-10:30", from: 600, to: 630 },
  { label: "10:30-11:00", from: 630, to: 660 },
  { label: "11:00-11:30", from: 660, to: 691 },
  { label: "13:00-13:30", from: 780, to: 810 },
  { label: "13:30-14:00", from: 810, to: 840 },
  { label: "14:00-14:30", from: 840, to: 870 },
  { label: "14:30-15:00", from: 870, to: 901 }
];
const sealBucketLabel = (clock) => {
  const minute = clockMinutes(clock);
  if (minute == null) return "时间未知";
  return SEAL_BUCKETS.find((bucket) => minute >= bucket.from && minute < bucket.to)?.label || "其他";
};

// ── 概念口径：方案(c) 黑名单兜底 + 白名单加权 ─────────────────────────────
// 探针实测：Wind「所属概念板块」245 个里 Top10 全是风格/情绪/资金标签（全部A股、非基金重仓、
// 小市值、全A负动量…），必须过滤，否则概念聚合会输出一堆噪音。
const LIMIT_STYLE_TAG_PATTERN = new RegExp([
  "全部A股", "全A", "等权", "非基金重仓", "基金重仓", "非陆股通重仓", "陆股通", "沪股通", "深股通",
  "QFII", "MSCI", "富时罗素", "标普道琼斯", "小市值", "中盘股", "大盘股", "微盘股", "小盘股",
  "高价股", "低价股", "百元股", "动量", "成交主力", "高振幅", "低换手", "高换手", "振幅", "量比",
  "融资融券", "转融券", "场外期权", "证券公司", "券源", "质押",
  "财报披露", "股权激励", "员工持股", "股票回购", "贷款回购", "保底增持", "近期减持", "解禁", "破净", "破发",
  "预增", "预减", "业绩预", "行业龙头", "并购阶段", "重组", "举牌", "含可转债", "可转债正股",
  "市场情绪", "情绪指数", "打板", "连板", "首板", "涨停", "跌停", "炸板", "破板", "一字板", "反包",
  "领涨", "跟风", "补涨", "强势股", "活跃股", "趋势股", "龙头", "中军", "抢筹", "竞价",
  "三新", "双循环", "先进制造", "新质生产力", "新经济", "老经济", "资源股", "大消费",
  "民营企业综合", "国企综合", "地方国企综合", "央企", "国资", "非ST", "ST股", "次新股",
  "龙虎榜", "华为平台", "昨日", "近\\d+日", "上市板", "核准制", "注册制",
  // 资质认定类标签：覆盖股票池过宽，是属性不是题材，出现在涨停聚合里会虚高家数
  "专精特新", "小巨人", "单项冠军", "隐形冠军", "高新技术企业", "科技型中小企业",
  "独角兽", "瞪羚", "创新型企业", "国家级",
  // 事件/所有权类标签：由公告触发，覆盖全市场，不是当日交易题材
  "股权转让", "借壳", "参股金融", "参股", "外资企业", "民营", "控股", "实际控制人", "股东",
  "资产注入", "整体上市", "控制权变更", "易主", "高管", "员工"
].join("|"));

// 同一概念在 Wind 里常有多种写法（如「专精特新小巨人」与「专精特新小巨人主题」、
// 「借壳上市」与「借壳上市(MA)」），不归一化会被聚合成两行、重复计数。
const CONCEPT_SUFFIX_PATTERN = /(?:主题|概念|指数|板块|精选|成分股|[（(][^）)]*[）)])$/;

// 题材拐点漏掉的属性标签：持股结构、资金主体、股东类型，均非交易题材
const NON_THEME_ATTRIBUTE_PATTERN = /含?B股|含H股|^AH股|^A股|养老金|社保|QFII|保险资金|保险重仓|信托重仓|汇金|证金|外资持股|外资背景|国资|央企|地方国资|员工持股|股权激励|参股|控股|实际控制人/;

// 题材判定：叠加「题材拐点」的白名单判定（必须命中题材家族或已验证独立题材），
// 再补一层属性标签黑名单 —— 否则「含B股的A股」「养老金」这类会漏进来。
function limitConceptEligible(name) {
  const value = anomalyThemeName(name);
  if (!value || value.length > 14) return false;
  if (LIMIT_STYLE_TAG_PATTERN.test(value)) return false;
  if (NON_NARRATIVE_ANOMALY_PATTERN.test(value)) return false;
  if (NON_THEME_ATTRIBUTE_PATTERN.test(value)) return false;
  return isEligibleNarrativeTheme(value);
}
// 白名单加权：命中既有题材家族或已验证独立题材的，排序时优先
const isWhitelistTheme = (name) => Boolean(anomalyFamily(name)) || VERIFIED_STANDALONE_THEME_PATTERN.test(name);

function normalizeConceptName(value) {
  return anomalyThemeName(value).replace(CONCEPT_SUFFIX_PATTERN, "");
}

function limitConcepts(value) {
  return [...new Set(String(value || "").split(/[;；]/)
    .map(normalizeConceptName)
    .filter(limitConceptEligible))];
}

// 方案 A：集团品牌类标签必须主营支持。「家电」最容易误伤：创维数字做机顶盒、
// 宽带设备，只因「创维」这块牌子就被归到消费股。只有主营出现家电制造词才保留。
const BRAND_CONCEPT_SUPPORT = [
  {
    concept: "家电",
    support: /家电|家用电器|白电|黑电|冰洗|冰箱|空调|洗衣机|厨电|小家电|热水器|吸尘器|洗地机|扫地机|电饭煲|微波炉|彩电|电视机/
  }
];
// 主营文本为空（取数失败）时不删标签：宁可保留旧口径，也不因缺数据误删
export function pruneUnsupportedBrandConcepts(concepts, businessText) {
  const text = String(businessText || "").trim();
  if (!text || !concepts?.length) return { concepts: concepts || [], dropped: [] };
  const dropped = [];
  const kept = concepts.filter((name) => {
    const rule = BRAND_CONCEPT_SUPPORT.find((item) => name === item.concept);
    if (!rule) return true;
    if (rule.support.test(text)) return true;
    dropped.push(name);
    return false;
  });
  return { concepts: kept, dropped };
}

// ── 配方 ②：历史日涨停名单（含证券简称） ─────────────────────────────────
// 历史日不能用「涨停」措辞（探针确认返回空表），只能用「收盘价等于当日涨停价」。
// loadLimitHistory 已经查过同一句，但只保留代码；这里单独再查一次以拿到简称，
// 仅在有断板/未晋级股时才触发，属于按需成本。
async function fetchYesterdayNames(day) {
  if (!day) return { names: new Map(), concepts: new Map() };
  // 优先一次拿全简称 + 概念；概念是静态属性，历史日有机会返回
  const questions = [
    `筛选${day}收盘价等于当日涨停价的沪深A股并返回Wind代码、证券简称、所属概念板块`,
    `筛选${day}收盘价等于当日涨停价的沪深A股`
  ];
  for (const question of questions) {
    for (let attempt = 1; attempt <= SECTOR_ATTEMPTS; attempt += 1) {
      try {
        const payload = await windCall("stock_data", "search_stocks", { question });
        const rows = tables(payload).flatMap(objects);
        if (rows.length) {
          const names = new Map();
          const concepts = new Map();
          for (const row of rows) {
            const code = row["Wind代码"];
            const name = row["证券简称"];
            if (code && name && !names.has(code)) names.set(code, name);
            const list = limitConcepts(row["所属概念板块"]);
            if (code && list.length && !concepts.has(code)) concepts.set(code, list);
          }
          return { names, concepts };
        }
      } catch { /* 名称补不齐不影响主数据，静默降级 */ }
      if (attempt < SECTOR_ATTEMPTS) await waitFor(attempt * SEARCH_RETRY_GAP_MS);
    }
  }
  return { names: new Map(), concepts: new Map() };
}

// 概念名 → 与题材聚合一致的展示名（族名去掉「产业链」）
function conceptLabelOf(name) {
  const family = anomalyFamily(name);
  return family ? family.name.replace(/产业链$/, "") : name;
}

// ── 资讯复核 ──────────────────────────────────────────────────────────
// 每只股票都用当日资讯复核一遍，以资讯为准覆盖 Wind 概念（资讯没命中时保留 Wind）。
const newsConceptCache = new Map();
const NEWS_CONCEPT_MAX = 80;
// 默认开启；LIMITUP_NEWS_CONCEPT=0 可关闭（每只股票占 1 次 Wind 额度）
const NEWS_CONCEPT_ENABLED = process.env.LIMITUP_NEWS_CONCEPT !== "0";
// 资讯检索会混进「每日大事件」这类泛化财经稿：正文没提到这只股票就不能用，
// 否则「支付」「证券」等词会把无关个股误判成金融科技题材。
const NEWS_GENERIC_ARTICLE = /每日大事件|早报|早餐|午评|收评|复盘|盘点|要闻|晚报|盘前|盘后|周报|月报|十大|汇总|精选|必读|观察|速递|一览|集锦/;
// 只保留正文真的提到这只股票、且不是泛化盘面稿的资讯
export function selectStockNews(items, stockName = "") {
  const textOf = (item) => `${item.title || ""}${item.content || item.summary || ""}`;
  return items.filter((item) => {
    if (stockName && !textOf(item).includes(stockName)) return false;
    return !NEWS_GENERIC_ARTICLE.test(String(item.title || ""));
  });
}
async function askThemeNames(query, stockName = "") {
  try {
    const payload = await windCall("financial_docs", "get_financial_news", { query, top_k: 3 }, 15_000);
    const items = payload?.data?.items || payload?.data?.data?.items || [];
    const relevant = selectStockNews(items, stockName);
    const names = detectThemeFamilies(relevant.map((item) => `${item.title || ""}${item.content || item.summary || ""}`).join(" ")).slice(0, 3);
    if (process.env.LIMITUP_DEBUG) {
      console.log(`[news] ${query.slice(-14)} items=${items.length}/${relevant.length} hits=${names.join("/") || "-"}`);
    }
    // hit 用来判断要不要换措辞重试：raw 有稿但没提到这只股票，也算没命中
    return { names, failed: false, hit: relevant.length > 0 };
  } catch {
    return { names: [], failed: true, hit: false };
  }
}

// 队列顺序：断板 → 连板 → 首板，额度或时间不够时先保证最重要的拿到。
// 抽成纯函数便于单测：排序规则一变，晋级/断板概念就会错位。
export function buildNewsReviewQueue(stocks, brokenCodes = [], nameByCode = null) {
  const queue = [];
  // 断板股今日不涨停、Wind 概念多为空，最需要资讯解释「为什么断了」，所以排最前
  for (const code of brokenCodes) {
    const name = nameByCode?.get(code);
    if (name) queue.push({ code, name, broken: true, stock: null });
  }
  // 连板股次之（决定空间高度）：板高降序，同板高按封板时间由早到晚
  const ranked = [...stocks].sort((a, b) =>
    (b.streak || 1) - (a.streak || 1) || String(a.sealTime || "99").localeCompare(String(b.sealTime || "99")));
  for (const stock of ranked) queue.push({ code: stock.code, name: stock.name, broken: false, stock });
  return queue;
}

// 资讯优先：资讯识别到题材族就以资讯为准覆盖 Wind 概念；
// 资讯没识别出题材时不覆盖（否则会把 Wind 的有效概念清空），只做「已复核」标记。
export function applyNewsConcepts(stock, names) {
  stock.newsVerified = true;
  if (!names?.length) {
    stock.conceptSource = stock.concepts?.length ? "wind" : "none";
    return false;
  }
  stock.concepts = [...new Set(names)];
  stock.conceptSource = "news";
  return true;
}

async function reviewConceptsByNews(stocks, day, brokenCodes = [], nameByCode = null, brokenDay = day) {
  // reviewed：实际查过资讯的只数；aborted：连续失败熔断，说明后面还没复核完
  const result = { filled: 0, reviewed: 0, aborted: false, brokenConcepts: new Map() };
  if (!NEWS_CONCEPT_ENABLED) return result;

  const queue = buildNewsReviewQueue(stocks, brokenCodes, nameByCode);

  const visited = new Set();
  let consecutiveFailures = 0;
  for (const target of queue) {
    if (visited.size >= NEWS_CONCEPT_MAX) break;
    if (!target.name || visited.has(target.code)) continue;
    visited.add(target.code);

    // 缓存带上交易日：跨日复用会把昨天的资讯结论套到今天
    const cacheKey = `${day}:${target.code}`;
    let names = newsConceptCache.get(cacheKey);
    if (!names) {
      // 断板股涨停发生在上一交易日：用今天去查会一篇都查不到（实测海洋王 0 条）
      const queryDay = target.broken ? brokenDay : day;
      let answer = await askThemeNames(`${queryDay}${target.name}上涨原因概念题材`, target.name);
      // 断板股、以及 Wind 概念全空的个股，日期过滤容易筛掉新闻：补一次不带日期的查询
      if (!answer.failed && !answer.hit && (target.broken || !(target.stock?.concepts?.length))) {
        if (process.env.WIND_MOCK !== "1") await waitFor(900);
        answer = await askThemeNames(`${target.name}涨停原因概念题材`, target.name);
      }
      names = answer.names;
      result.reviewed += 1;
      // 失败不写缓存：额度恢复后同一天刷新时还能补回来
      if (!answer.failed) newsConceptCache.set(cacheKey, names);
      // 额度耗尽时连续失败，继续排队只会白等，直接熔断
      if (answer.failed) {
        consecutiveFailures += 1;
        if (consecutiveFailures >= 5) {
          result.aborted = true;
          break;
        }
      } else {
        consecutiveFailures = 0;
      }
      // 节流只在真实调用时生效；离线 mock 跑测试不需要这一秒多的等待
      if (process.env.WIND_MOCK !== "1") await waitFor(1_200);
    }
    // 断板股只有资讯命中了才写；没命中时保留 Wind 昨日概念的兜底
    if (target.broken) {
      if (!names.length) continue;
      result.brokenConcepts.set(target.code, names);
      result.filled += 1;
      continue;
    }

    // 以资讯为准：资讯命中的题材族覆盖 Wind 概念，Wind 只作为资讯无症状时的底稿。
    // 资讯为空也要走这一步，否则个股不会带上「已复核」与来源标记
    if (applyNewsConcepts(target.stock, names)) result.filled += 1;
  }
  return result;
}

// ── 主营复核（方案 A） ─────────────────────────────────────────────────
// 只对带「家电」等集团品牌标签的个股取主营，成本可控（通常个位数）。
const businessTextCache = new Map();
async function loadBusinessText(day, code) {
  const key = `${day}:${code}`;
  if (businessTextCache.has(key)) return businessTextCache.get(key);
  const payload = await windCall("stock_data", "get_stock_basicinfo", { question: `${code}公司主营业务和核心产品` }, 12_000);
  const text = tables(payload).flatMap(objects).flatMap((row) => Object.values(row)).filter((value) => value != null).join(" ");
  businessTextCache.set(key, text);
  return text;
}

async function reviewBrandConcepts(stocks, day) {
  const result = { checked: 0, pruned: 0, failed: 0, businessText: new Map() };
  for (const stock of stocks) {
    // 资讯已经说明市场在炒什么，就以资讯为准，不再拿主营去改它
    if (stock.conceptSource === "news") continue;
    if (!BRAND_CONCEPT_SUPPORT.some((rule) => stock.concepts?.includes(rule.concept))) continue;
    let text = "";
    try {
      text = await loadBusinessText(day, stock.code);
      result.checked += 1;
      result.businessText.set(stock.code, text);
    } catch {
      // 取不到主营就保留 Wind 标签，不因为缺证据误删
      result.failed += 1;
      continue;
    }
    const { concepts, dropped } = pruneUnsupportedBrandConcepts(stock.concepts, text);
    if (dropped.length) {
      stock.concepts = concepts;
      stock.droppedConcepts = [...(stock.droppedConcepts || []), ...dropped];
      result.pruned += 1;
      if (process.env.LIMITUP_DEBUG) {
        console.log(`[brand] ${stock.name} 主营不支持「${dropped.join("/")}」→ 剔除`);
      }
    }
    if (process.env.WIND_MOCK !== "1") await waitFor(600);
  }
  return result;
}

// ── 代码 / 名称派生字段 ─────────────────────────────────────────────────
const BOARD_BY_PREFIX = [
  [/^(?:688|689)\d{3}$/, "科创板"],
  [/^(?:300|301)\d{3}$/, "创业板"],
  [/^(?:43|83|87|88|92)\d{4}$/, "北交所"],
  [/^(?:600|601|603|605|000|001|002|003)\d{3}$/, "主板"]
];
function boardOf(code) {
  const numeric = String(code || "").split(".")[0];
  return BOARD_BY_PREFIX.find(([pattern]) => pattern.test(numeric))?.[1] || "其他";
}
const isStName = (name) => /^\*?ST/i.test(String(name || ""));

// ── 连板高度 ────────────────────────────────────────────────────────────
// `sets[0]` 是昨日、`sets[1]` 前日…；连续命中几个就加几板。
function streakAgainst(sets, code) {
  let streak = 1;
  for (const codes of sets) {
    if (!codes.has(code)) break;
    streak += 1;
  }
  return streak;
}

// ── 晋级率（无需落库历史，交易日历 + 涨停名单即可算，因此第一天就能出数） ──
function promotionOf(todayCodes, sets, yesterdayCodes) {
  if (!sets.length || !yesterdayCodes?.size) return { baseTradingDate: null, baseLimitUpCount: 0, tiers: [], overallRate: null, promoted: [], failed: [] };
  const tiers = [];
  const promoted = [];
  const failed = [];
  const byYesterdayStreak = new Map();
  for (const code of yesterdayCodes) {
    const streak = streakAgainst(sets.slice(1), code);
    if (!byYesterdayStreak.has(streak)) byYesterdayStreak.set(streak, []);
    byYesterdayStreak.get(streak).push(code);
  }
  for (const [streak, codes] of [...byYesterdayStreak].sort((a, b) => a[0] - b[0])) {
    const promotedCodes = codes.filter((code) => todayCodes.has(code));
    tiers.push({
      from: streak, to: streak + 1, label: `${streak}进${streak + 1}`,
      baseCount: codes.length, promotedCount: promotedCodes.length,
      rate: codes.length ? Number((promotedCodes.length / codes.length).toFixed(4)) : null,
      promoted: promotedCodes
    });
    promotedCodes.forEach((code) => promoted.push({ code, fromStreak: streak, toStreak: streak + 1 }));
    codes.filter((code) => !todayCodes.has(code)).forEach((code) => failed.push({ code, fromStreak: streak }));
  }
  const promotedTotal = tiers.reduce((sum, tier) => sum + tier.promotedCount, 0);
  return {
    baseTradingDate: null,
    baseLimitUpCount: yesterdayCodes.size,
    tiers, promoted, failed,
    overallRate: Number((promotedTotal / yesterdayCodes.size).toFixed(4))
  };
}

// ── 概念聚合 ────────────────────────────────────────────────────────────
// streakDistribution 让页面能画「板高微条」：一只股票一个方块，深浅=板高。
// 光看家数分不清「5家全首板（跟风）」和「3家有4板（主线）」，分布才能区分。
export function aggregateConcepts(stocks) {
  const groups = new Map();
  for (const stock of stocks) {
    const streak = stock.streak || 1;
    for (const name of stock.concepts) {
      // 与「题材异动」保持同一题材维度：先映射到题材家族
      // （人形机器人 / 机器人 / 减速器 → 机器人产业链），否则同一件事会被拆成多行
      const family = anomalyFamily(name);
      // 族名去掉「产业链」后缀，只留核心词（机器人产业链 → 机器人）
      const label = family ? family.name.replace(/产业链$/, "") : name;
      // 以展示名作聚合键：族名与 Wind 原始概念可能走不同分支（汽车智能化 vs 华为汽车），
      // 按 family.id 分组会把同一件事拆成两行、家数各算一遍
      const key = label;
      if (!groups.has(key)) {
        groups.set(key, {
          name: label, aliases: [], stocks: [], maxStreak: 0, firstSealTime: null,
          whitelist: Boolean(family) || isWhitelistTheme(name), streakDistribution: {},
          leaderCode: null, leaderSealTime: null
        });
      }
      const group = groups.get(key);
      if (!group.whitelist && isWhitelistTheme(name)) group.whitelist = true;
      if (!group.aliases.includes(name)) group.aliases.push(name);
      // 同一只股票可能同时带族内多个概念，只计一次，否则家数会虚高
      if (group.stocks.includes(stock.code)) continue;
      group.stocks.push(stock.code);
      group.streakDistribution[streak] = (group.streakDistribution[streak] || 0) + 1;
      // 龙头 = 最高板里封板最早的那只，决定次日谁能接过身位
      if (streak > group.maxStreak) {
        group.maxStreak = streak;
        group.leaderCode = stock.code;
        group.leaderSealTime = stock.sealTime;
      } else if (streak === group.maxStreak && String(stock.sealTime || "99") < String(group.leaderSealTime || "99")) {
        group.leaderCode = stock.code;
        group.leaderSealTime = stock.sealTime;
      }
      const seal = stock.sealTime;
      if (seal && (!group.firstSealTime || seal < group.firstSealTime)) group.firstSealTime = seal;
    }
  }
  return [...groups.values()].map((group) => ({
    ...group,
    limitCount: group.stocks.length,
    hasLeader: group.maxStreak >= 2
  }))
    // 有龙头 > 家数 > 白名单 > 首封时间：3家有4板比5家全首板更该排前面
    .sort((a, b) => Number(b.hasLeader) - Number(a.hasLeader)
      || b.limitCount - a.limitCount
      || Number(b.whitelist) - Number(a.whitelist)
      || String(a.firstSealTime || "99").localeCompare(String(b.firstSealTime || "99")));
}

// 主标签口径（方案 A）：资讯优先；没有资讯时，优先选「主营能匹配」的概念。
// 概念炒作不一定贴主营，所以主营只用来挑主标签，不覆盖资讯结论。
export function pickPrimaryConcept(concepts, conceptCounts, businessText = "") {
  const text = String(businessText || "");
  const matchesBusiness = (name) => {
    if (!text) return false;
    if (text.includes(name)) return true;
    const family = anomalyFamily(name);
    if (!family) return false;
    if (family.business) {
      family.business.lastIndex = 0;
      if (family.business.test(text)) return true;
    }
    family.test.lastIndex = 0;
    return family.test.test(text);
  };
  const score = (name) =>
    (matchesBusiness(name) ? 100_000 : 0)
    + (conceptCounts.get(name) || 0) * 10
    + (isWhitelistTheme(name) ? 1000 : 0);
  return [...concepts].sort((a, b) => score(b) - score(a) || a.length - b.length)[0] || null;
}

// ── 题材强弱：涨停题材 vs 跌停题材 ──────────────────────────────────────
// 把「若干只股票的题材标签」聚合为 { name, count, maxStreak }，供强弱对比与历史题材复用。
// 归一化走 conceptLabelOf（题材族名去「产业链」），保证涨停、跌停、昨日名单落在同一行。
export function aggregateThemeOccurrences(entries = []) {
  const groups = new Map();
  for (const entry of entries) {
    const streak = entry?.streak || 1;
    const names = [...new Set((entry?.names || []).map(conceptLabelOf).filter(Boolean))];
    for (const name of names) {
      if (!groups.has(name)) groups.set(name, { name, count: 0, maxStreak: 0 });
      const group = groups.get(name);
      group.count += 1;
      if (streak > group.maxStreak) group.maxStreak = streak;
    }
  }
  return [...groups.values()].sort((a, b) => b.count - a.count || b.maxStreak - a.maxStreak);
}

// 涨停个股 → 题材计数（复用概念聚合的族归一与龙头判定）
export function themeCountsOf(stocks = []) {
  return aggregateConcepts(stocks).map((item) => ({
    name: item.name, count: item.limitCount, maxStreak: item.maxStreak, stocks: item.stocks
  }));
}

function themeStrengthStatus(group) {
  const { upCount, downCount, maxUpStreak, previousUpCount } = group;
  if (upCount && !downCount) {
    // 昨日是主线、今日涨停家数腰斩：不是走弱，但明显在降温，不能继续标成主升
    if (previousUpCount >= 3 && upCount <= previousUpCount * 0.6) return "降温";
    // 「主升」必须既有梯队又成规模：至少 3 家，且满足「4 家起出 2 板」或「3 家起出 3 板」。
    // 2 只涨停（哪怕一只是 4 板高标）只是试错资金，标成主升会误导仓位。
    if ((upCount >= 4 && maxUpStreak >= 2) || (upCount >= 3 && maxUpStreak >= 3)) return "主升";
    if (upCount >= 2) return "走强";
    return "异动";
  }
  if (upCount && downCount) return "分歧";
  if (!upCount && downCount >= 3) return "冰点";
  if (!upCount && downCount) return "走弱";
  return "退潮";
}
const strengthTone = (status) => (status === "主升" || status === "走强" ? "up" : status === "走弱" || status === "冰点" || status === "退潮" ? "down" : "warn");

// 强弱判定（纯函数）：
//   有涨停无跌停 → 主升/走强/异动；涨跌同现 → 分歧；只有跌停 → 走弱/冰点；只剩断板 → 退潮。
// 负反馈只认「跌停」：前期主线昨天还有一堆涨停，今天却出现跌停，才叫突然负反馈。
// 单纯断板/未晋级不算负反馈（晋级率低的日子几乎每个题材都在断板，会把冰点预警刷成噪音）。
export function buildThemeStrength({ upThemes = [], downThemes = [], previousThemes = [], brokenThemes = [] } = {}) {
  const groups = new Map();
  const ensure = (name) => {
    if (!groups.has(name)) {
      groups.set(name, {
        name, upCount: 0, downCount: 0, maxUpStreak: 0,
        brokenCount: 0, previousUpCount: 0, previousMaxStreak: 0
      });
    }
    return groups.get(name);
  };
  for (const theme of upThemes) {
    const group = ensure(theme.name);
    group.upCount += theme.count || 0;
    group.maxUpStreak = Math.max(group.maxUpStreak, theme.maxStreak || 1);
  }
  for (const theme of downThemes) ensure(theme.name).downCount += theme.count || 0;
  for (const theme of previousThemes) {
    const group = ensure(theme.name);
    group.previousUpCount += theme.count || 0;
    group.previousMaxStreak = Math.max(group.previousMaxStreak, theme.maxStreak || 1);
  }
  for (const theme of brokenThemes) ensure(theme.name).brokenCount += theme.count || 0;

  return [...groups.values()]
    .filter((group) => group.upCount || group.downCount || group.brokenCount)
    .map((group) => {
      const hotYesterday = group.previousUpCount >= 3 || group.previousMaxStreak >= 2;
      // 还要求「今天涨停家数比昨天少」：昨天 5 家、今天 6 家 + 1 家跌停，是分歧不是负反馈
      const negativeFeedback = hotYesterday && group.downCount > 0 && group.upCount < group.previousUpCount;
      const status = themeStrengthStatus(group);
      return { ...group, net: group.upCount - group.downCount, negativeFeedback, status, tone: strengthTone(status) };
    })
    .sort((a, b) => Number(b.negativeFeedback) - Number(a.negativeFeedback)
      || b.upCount - a.upCount
      || b.downCount - a.downCount
      || b.previousUpCount - a.previousUpCount
      || a.name.localeCompare(b.name));
}

// 题材强弱合并进「概念聚合」：同一行里既有涨停家数/最高板/首封时间，也有跌停、断板、强弱状态。
// 涨停题材以概念聚合的富信息为准；只有跌停、没有涨停的题材补成 limitCount=0 的行，
// 否则「谁在走弱」看不到——而这恰恰是判断冰点最需要的另一半。
export function mergeThemeBoard({ concepts = [], themeStrength = [] } = {}) {
  const strengthByName = new Map(themeStrength.map((theme) => [theme.name, theme]));
  const rows = concepts.map((concept) => {
    const strength = strengthByName.get(concept.name);
    return {
      ...concept,
      downCount: strength?.downCount || 0,
      brokenCount: strength?.brokenCount || 0,
      previousUpCount: strength?.previousUpCount || 0,
      negativeFeedback: Boolean(strength?.negativeFeedback),
      status: strength?.status || null,
      tone: strength?.tone || null,
      downOnly: false
    };
  });
  const upNames = new Set(concepts.map((concept) => concept.name));
  for (const strength of themeStrength) {
    if (upNames.has(strength.name)) continue;
    // 没有涨停的弱方向也要留：只有跌停的（走弱/冰点）必然可见，
    // 纯断板的退潮题材在断了 ≥2 家时也留一行，否则删掉「题材强弱」卡片后这些方向就彻底看不到了。
    if (!strength.downCount && (strength.brokenCount || 0) < 2) continue;
    rows.push({
      name: strength.name, aliases: [], stocks: [], maxStreak: 0, firstSealTime: null,
      whitelist: false, streakDistribution: {}, leaderCode: null, leaderSealTime: null, hasLeader: false,
      limitCount: 0,
      downCount: strength.downCount || 0, brokenCount: strength.brokenCount || 0,
      previousUpCount: strength.previousUpCount,
      negativeFeedback: strength.negativeFeedback, status: strength.status, tone: strength.tone,
      downOnly: true
    });
  }
  return rows
    // 单个涨停只是个股行为，不构成题材，一律不展示（哪怕它同时有跌停/断板）；
    // 1 家涨停也没有的弱方向，则要 ≥2 家跌停或 ≥2 家断板才留，否则同样是噪音。
    .filter((row) => row.limitCount >= 2
      || (row.limitCount === 0 && (row.downCount >= 2 || row.brokenCount >= 2)))
    // 负反馈最优先；其余按「有梯队 > 涨停家数 > 跌停家数 > 断板家数」排，弱方向自然沉底但仍可见
    .sort((a, b) => Number(b.negativeFeedback) - Number(a.negativeFeedback)
      || Number(b.hasLeader) - Number(a.hasLeader)
      || b.limitCount - a.limitCount
      || b.downCount - a.downCount
      || b.brokenCount - a.brokenCount
      || String(a.firstSealTime || "99").localeCompare(String(b.firstSealTime || "99")));
}

// 顶部亮点（纯函数）：主线 → 冰点预警 → 负反馈 → 退潮 → 高位断板 → 结构风险/亮点，最多 6 条。
// 主线永远排第一：先回答「今天资金在哪」，风险与退潮类结论放后面。
//
// 每条结论带 priority，最后统一排序再截断：
//   0 主线 → 1 冰点 → 1.5 赚钱效应 → 2 负反馈 → 3 退潮/走弱 → 4 高位断板 →
//   4.5 竞价强度 → 5 结构风险（接力差 / 高度断层 / 封板偏晚 / 题材发散）→
//   6 结构亮点（接力顺 / 封板扎实 / 空间打开 / 主线清晰）
// 结构类只在「明显偏离中性」时给出，否则宁可不占版面。
const pctText = (value) => `${Math.round(value * 100)}%`;
const signedText = (value) => `${value > 0 ? "+" : ""}${round2(value)}`;
// 板高文案：1 板统一叫「首板」（与 limitStreakLabel 口径一致），避免出现「1板」
const boardText = (streak) => (Number(streak) >= 2 ? `${Number(streak)}板` : "首板");

// 前 3 大题材覆盖了多少只涨停（按并集，不重复计数），用来判断「主线清晰」还是「资金发散」
function topThemeCoverage(concepts, upCount) {
  const top = (concepts || [])
    .filter((concept) => concept.limitCount > 0)
    .sort((a, b) => b.limitCount - a.limitCount)
    .slice(0, 3);
  if (!top.length || !upCount) return null;
  const codes = new Set();
  for (const concept of top) for (const code of concept.stocks || []) codes.add(code);
  return { ratio: Math.min(1, codes.size / upCount), names: top.map((concept) => concept.name) };
}

export function buildHighlights({
  summary = {}, themeStrength = [], brokenStreaks = null, concepts = [], ladder = [], quoteTime = null, premium = null
} = {}) {
  const items = [];
  const add = (priority, item) => items.push({ priority, item });
  const upCount = summary.limitUpCount || 0;
  const downCount = summary.limitDownCount || 0;
  const feedback = themeStrength.filter((theme) => theme.negativeFeedback);
  const maxStreak = summary.maxStreak || 0;
  // 盘中快照只包含「此刻已经封板/晋级」的股票：早封占比会天然偏高、晋级率天然偏低，
  // 这两项必须等到 14:00 之后（或收盘/历史快照）才成立，否则会给出方向相反的结论。
  const quoteMinute = (() => {
    const match = String(quoteTime || "").match(/(\d{2}):(\d{2})/);
    return match ? Number(match[1]) * 60 + Number(match[2]) : null;
  })();
  const fullDay = quoteMinute == null || quoteMinute >= 840;

  // 主线只在真正的「主升」里选；没有主升时退而取最强「走强」，
  // 避免 2 只涨停的试错题材被当成当日主线。
  const main = (themeStrength
    .filter((theme) => theme.status === "主升")
    .sort((a, b) => b.maxUpStreak - a.maxUpStreak || b.upCount - a.upCount)[0])
    || (themeStrength
      .filter((theme) => theme.status === "走强")
      .sort((a, b) => b.upCount - a.upCount || b.maxUpStreak - a.maxUpStreak)[0]);
  if (main) {
    add(0, {
      tone: "up",
      title: `主线 · ${main.name}`,
      detail: `${main.upCount} 家涨停${main.maxUpStreak >= 2 ? `（最高 ${main.maxUpStreak} 板）` : "（均为首板）"}，无跌停`
    });
  }

  // 冰点不能只看跌停家数：涨停也少、跌停接近涨停一半，才说明赚钱效应真的塌了
  if (downCount >= 5 && feedback.length && (upCount === 0 || downCount >= upCount * 0.5)) {
    add(1, {
      tone: "warn",
      title: "冰点预警",
      detail: `跌停 ${downCount} 家、涨停 ${upCount} 家，${feedback.length} 个前期主线题材出现负反馈（${feedback.slice(0, 3).map((theme) => theme.name).join("、")}）`
    });
  }
  feedback.slice(0, 2).forEach((theme, index) => add(2 + index * 0.1, {
    tone: "down",
    title: `负反馈 · ${theme.name}`,
    detail: `昨日 ${theme.previousUpCount} 家涨停${theme.previousMaxStreak >= 2 ? `（最高 ${theme.previousMaxStreak} 板）` : ""} → 今日 ${theme.upCount} 家涨停、${theme.downCount} 家跌停、${theme.brokenCount} 家断板/未晋级`
  }));

  // ── 赚钱效应：昨日涨停股今日中位数（短线最直接的「昨天的票今天能不能兑现」）──
  // 中位数落在 -2% ~ +3% 的常态区间就不说话，避免每天都刷一条无信息量的结论。
  const yesterdayPremium = Number.isFinite(premium?.median) && premium.sampleSize >= 5 ? premium : null;
  if (yesterdayPremium) {
    const ratio = Number.isFinite(premium.upRatio) ? `，上涨占比 ${pctText(premium.upRatio)}` : "";
    if (premium.median <= -2) {
      add(1.5, {
        tone: "down", title: "赚钱效应差",
        detail: `昨日 ${premium.sampleSize} 家涨停今日中位数 ${signedText(premium.median)}%${ratio}，隔夜承接弱、兑现为主`
      });
    } else if (premium.median >= 3) {
      add(1.5, {
        tone: "up", title: "赚钱效应好",
        detail: `昨日 ${premium.sampleSize} 家涨停今日中位数 ${signedText(premium.median)}%${ratio}，隔夜资金愿意接力`
      });
    }
    // 连板 vs 首板：高度是否被认可。差距不明显就不下结论
    const { first, ladder: ladderGroup } = premium;
    if (first.count >= 2 && ladderGroup.count >= 2 && Number.isFinite(first.median) && Number.isFinite(ladderGroup.median)) {
      const gap = ladderGroup.median - first.median;
      if (gap <= -3) {
        add(5, {
          tone: "warn", title: "高度不被认可",
          detail: `连板中位数 ${signedText(ladderGroup.median)}%（${ladderGroup.count} 家）明显弱于首板 ${signedText(first.median)}%（${first.count} 家），空间板接力意愿差`
        });
      } else if (gap >= 3) {
        add(6, {
          tone: "up", title: "高度获认可",
          detail: `连板中位数 ${signedText(ladderGroup.median)}%（${ladderGroup.count} 家）强于首板 ${signedText(first.median)}%（${first.count} 家），越高越受追捧`
        });
      }
    }
  }

  // ── 竞价强度：一字板（9:25 竞价直接封板）+ 昨日涨停股今日开盘溢价 ─────────
  // auctionSealCount 缺失时不下结论：字段没取到与「真的一字板为 0」是两回事。
  const hasSealData = Number.isFinite(summary.auctionSealCount);
  const auctionSeal = hasSealData ? summary.auctionSealCount : 0;
  const auctionMedian = premium?.auction?.sampleSize >= 5 ? premium.auction.median : null;
  const auctionBits = [
    hasSealData && upCount >= 8 ? `${auctionSeal} 家一字板（占涨停 ${pctText(auctionSeal / upCount)}）` : null,
    Number.isFinite(auctionMedian) ? `昨日涨停股今日开盘中位数 ${signedText(auctionMedian)}%` : null
  ].filter(Boolean);
  if (auctionBits.length && (auctionSeal >= 3 || (Number.isFinite(auctionMedian) && auctionMedian >= 1))) {
    add(4.5, { tone: "up", title: "竞价强势", detail: `${auctionBits.join("，")}，隔夜资金愿意溢价接` });
  } else if (auctionBits.length && Number.isFinite(auctionMedian) && auctionMedian <= -1) {
    add(4.5, { tone: "down", title: "竞价走弱", detail: `${auctionBits.join("，")}，隔夜资金不愿竞价承接` });
  } else if (hasSealData && upCount >= 15 && auctionSeal === 0) {
    add(5, { tone: "warn", title: "无一字板", detail: `涨停 ${upCount} 家却无一家集合竞价直接封板，资金抢筹意愿一般` });
  }

  // 退潮：昨天还是主线，今天一只涨停都没有、也没有跌停，但断板一大片
  const faded = themeStrength
    .filter((theme) => theme.previousUpCount >= 3 && theme.upCount === 0 && theme.downCount === 0 && theme.brokenCount > 0)
    .sort((a, b) => b.brokenCount - a.brokenCount)[0];
  if (faded) {
    add(3, {
      tone: "down",
      title: `退潮 · ${faded.name}`,
      detail: `昨日 ${faded.previousUpCount} 家涨停，今日 0 家涨停、${faded.brokenCount} 家断板/未晋级`
    });
  }

  const weak = themeStrength
    .filter((theme) => theme.downCount >= 2 && theme.upCount === 0)
    .sort((a, b) => b.downCount - a.downCount)[0];
  if (weak) add(3.1, { tone: "down", title: `走弱 · ${weak.name}`, detail: `${weak.downCount} 家跌停，无涨停` });

  if (brokenStreaks && brokenStreaks.brokenCount > 0) {
    add(4, {
      tone: "warn",
      title: "高位断板",
      detail: `昨日 ${boardText(brokenStreaks.streak)} ${brokenStreaks.brokenCount}/${brokenStreaks.totalCount} 家未晋级，高度止步于 ${boardText(maxStreak)}`
    });
  }

  // ── 接力氛围：短线看的是「昨天涨停今天能不能兑现」 ──────────────────────
  const rate = summary.promotionRate;
  const yesterdayCount = summary.yesterdayLimitUpCount || 0;
  if (fullDay && Number.isFinite(rate) && yesterdayCount >= 5) {
    const promoted = Math.round(rate * yesterdayCount);
    if (rate <= 0.2) {
      add(5, {
        tone: "down", title: "接力亏钱",
        detail: `昨日 ${yesterdayCount} 家涨停仅 ${promoted} 家晋级（${pctText(rate)}），打板次日承接差，跟风票不宜隔夜`
      });
    } else if (rate >= 0.4) {
      add(6, {
        tone: "up", title: "接力顺畅",
        detail: `昨日 ${yesterdayCount} 家涨停 ${promoted} 家晋级（${pctText(rate)}），连板有承接，可继续做接力`
      });
    }
  }

  // ── 高度结构：最高板与中位板之间断档 = 空间板孤立，最容易 A 字杀 ────────
  const tierCount = new Map((ladder || []).map((tier) => [tier.streak, tier.count]));
  if (ladder && ladder.length && maxStreak >= 3) {
    // 不能只看最高板下面一层：5 板 1 家、4 板 3 家、3 板 0 家同样是断层（中位部队脱节）
    const missing = [];
    for (let streak = 2; streak < maxStreak; streak += 1) {
      if (!(tierCount.get(streak) > 0)) missing.push(streak);
    }
    if (missing.length) {
      add(5, {
        tone: "warn", title: "高度断层",
        detail: `最高 ${maxStreak} 板（${tierCount.get(maxStreak)} 家），但 ${missing.join("、")} 板断档，中位部队脱节、空间板孤立`
      });
    } else if (maxStreak >= 4) {
      add(6, {
        tone: "up", title: "空间打开",
        detail: `高度 ${maxStreak} 板（${tierCount.get(maxStreak)} 家），${maxStreak - 1} 板 ${tierCount.get(maxStreak - 1)} 家，梯队 ${summary.ladderDepth || 0} 层连续`
      });
    }
  }

  // ── 封板质量：早盘封板占比高=资金坚决，偏低=尾盘偷袭、次日兑现压力大 ────
  if (fullDay && Number.isFinite(summary.firstSealCount) && upCount >= 8) {
    const ratio = summary.firstSealCount / upCount;
    if (ratio <= 0.35) {
      add(5, {
        tone: "warn", title: "封板偏晚",
        detail: `${pctText(ratio)} 在 10:00 前封板（${summary.firstSealCount}/${upCount}），尾盘偷袭多，次日兑现压力大`
      });
    } else if (ratio >= 0.6) {
      add(6, {
        tone: "up", title: "封板扎实",
        detail: `${pctText(ratio)} 在 10:00 前封板（${summary.firstSealCount}/${upCount}），资金进场坚决`
      });
    }
  }

  // ── 题材集中度：是「一条主线」还是「四处试错」 ─────────────────────────
  const coverage = topThemeCoverage(concepts, upCount);
  if (coverage && upCount >= 8 && concepts.length >= 4) {
    if (coverage.ratio <= 0.3) {
      add(5, {
        tone: "warn", title: "题材发散",
        detail: `前 3 题材仅覆盖 ${pctText(coverage.ratio)} 涨停（${coverage.names.join("/")}），资金四处试错、无主线`
      });
    } else if (coverage.ratio >= 0.55) {
      add(6, {
        tone: "up", title: "主线清晰",
        detail: `前 3 题材覆盖 ${pctText(coverage.ratio)} 涨停（${coverage.names.join("/")}）`
      });
    }
  }

  // 没有明显信号时给一句状态描述，避免顶部空白
  if (!items.length && upCount > 0 && downCount === 0) {
    add(0, { tone: "up", title: "情绪偏强", detail: `涨停 ${upCount} 家、跌停 0 家，暂无题材负反馈` });
  }
  if (!items.length && downCount > 0 && upCount === 0) {
    add(0, { tone: "down", title: "情绪冰点", detail: `跌停 ${downCount} 家、无涨停，等待修复信号` });
  }
  return items.sort((a, b) => a.priority - b.priority).map((entry) => entry.item).slice(0, 6);
}

// 行情时间戳 → 交易日（YYYYMMDD）。盘前 / 休市时 Wind 会回上一交易日的收盘快照，
// 板块必须按「行情日期」而不是本地日期落库，否则会把昨日数据写成今日快照。
export function quoteDayOf(quoteTime) {
  const match = String(quoteTime || "").match(/(\d{4})-(\d{2})-(\d{2})/);
  return match ? `${match[1]}${match[2]}${match[3]}` : null;
}
// 行情日期 != 期望日期：说明拿到的还是上一交易日的收盘快照（盘前 / 假日）
export function snapshotDayMismatch(quoteTime, expectedDay) {
  const quoteDay = quoteDayOf(quoteTime);
  return Boolean(quoteDay && expectedDay && quoteDay !== String(expectedDay));
}

// ── 主入口 ──────────────────────────────────────────────────────────────
export async function loadLimitUpBoard(day = localDate()) {
  const errors = [];
  const [eventResult, historyResult] = await Promise.all([
    fetchLimitEventRows(day),
    loadLimitHistory(day).catch((error) => {
      errors.push(`涨停历史: ${String(error?.message || error)}`);
      return { sets: [], dates: [], complete: false };
    })
  ]);
  errors.push(...eventResult.errors, ...(historyResult.errors || []));

  const sets = historyResult.sets || [];
  const rawByCode = new Map();
  for (const row of eventResult.rows) {
    const code = row["Wind代码"];
    if (!code || rawByCode.has(code)) continue;
    rawByCode.set(code, row);
  }

  const allStocks = [...rawByCode.values()].map((row) => {
    const code = row["Wind代码"];
    const sealTime = sealClock(row["涨跌停时间"]);
    return {
      code, name: row["证券简称"],
      sealTime, bucket: sealBucketLabel(sealTime),
      streak: sets.length ? streakAgainst(sets, code) : null,
      concepts: limitConcepts(row["所属概念板块"]),
      boardType: boardOf(code), isST: isStName(row["证券简称"])
    };
  }).filter((stock) => stock.code && stock.name);

  // ST 股不参与统计与展示：涨跌幅受限、连板口径失真，留在天梯里会误导高度判断。
  const stCount = allStocks.filter((stock) => stock.isST).length;
  const kept = allStocks.filter((stock) => !stock.isST);

  // 资讯复核排队：断板 → 连板 → 首板。
  // 断板股今日不涨停、Wind 概念多为空，最需要资讯解释「为什么断了」，所以排最前；
  // 连板股次之（决定空间高度），首板最后（数量大、单只信息量低）。
  const todayCodes = new Set(kept.map((stock) => stock.code));
  const yesterdayCodes = sets[0] || null;
  const baseTradingDate = historyResult.dates?.[0] || await previousTradingDate(day).catch(() => null);
  const promotion = promotionOf(todayCodes, sets, yesterdayCodes);
  promotion.baseTradingDate = baseTradingDate;

  const topStreak = yesterdayCodes?.size
    ? Math.max(...[...yesterdayCodes].map((code) => streakAgainst(sets.slice(1), code)))
    : 0;
  const topCodes = topStreak && yesterdayCodes?.size
    ? [...yesterdayCodes].filter((code) => streakAgainst(sets.slice(1), code) === topStreak)
    : [];
  const brokenCodes = topCodes.filter((code) => !todayCodes.has(code));

  // 昨日名单（简称 + 概念）：断板、未晋级、以及题材强弱里「昨日涨停家数」都要用。
  // 即便今天全部晋级也要取一次，否则无法判断前期主线是否出现负反馈。
  const yesterday = baseTradingDate
    ? await fetchYesterdayNames(baseTradingDate)
    : { names: new Map(), concepts: new Map() };
  const nameByCode = yesterday.names;
  const brokenConceptMap = yesterday.concepts;
  if (brokenCodes.length && !nameByCode.size) {
    errors.push("断板股简称未补齐（昨日涨停名单查询失败），暂以代码展示");
  }

  // 盘前构建时本地日期已是新交易日，但行情还停在上一交易日收盘：
  // 资讯检索、断板解释、跌停取数都必须用「行情日期」，否则当天数据一条都取不到。
  const quoteTime = eventResult.rows.map((row) => row["交易时间"]).filter(Boolean).sort().at(-1) || null;
  const dataDay = quoteDayOf(quoteTime) || day;

  // 跌停取数：按行情日期查当日跌停（历史日同样支持「跌停」措辞），
  // 同时补一次上一交易日的跌停家数，给「跌停扩散 / 收敛」提供环比。
  // 顺带取昨日涨停股今日溢价（赚钱效应）与竞价溢价，三者互不依赖，并行发出。
  const [downResult, previousDownCount, premium] = await Promise.all([
    fetchLimitDownRows(dataDay),
    fetchLimitDownCount(baseTradingDate),
    fetchPremium({
      baseDay: baseTradingDate,
      day: dataDay,
      codes: [...(yesterdayCodes || [])],
      streakOf: (code) => streakAgainst(sets.slice(1), code)
    })
  ]);
  errors.push(...downResult.errors);
  // 溢价失手会直接砍掉一条短线核心结论，必须告警；竞价溢价措辞待验证，只记录不刷告警
  if (premium?.error) errors.push(`昨日涨停溢价: ${premium.error}`);
  const rawDownStocks = downResult.rows.map((row) => {
    const code = row["Wind代码"];
    const downTime = sealClock(row["涨跌停时间"]);
    return {
      code, name: row["证券简称"],
      downTime, bucket: sealBucketLabel(downTime),
      concepts: limitConcepts(row["所属概念板块"]),
      boardType: boardOf(code), isST: isStName(row["证券简称"]),
      conceptSource: "wind"
    };
  }).filter((stock) => stock.code && stock.name);
  const downStCount = rawDownStocks.filter((stock) => stock.isST).length;
  // 与涨停同一口径剔除 ST：跌停股里 ST 占比高，混在一起会夸大恐慌程度
  const downStocks = rawDownStocks.filter((stock) => !stock.isST)
    .sort((a, b) => String(a.downTime || "99").localeCompare(String(b.downTime || "99")));

  // 资讯复核：Wind 概念准不准、有没有漏，都用当日资讯过一遍
  const newsReview = await reviewConceptsByNews(kept, dataDay, brokenCodes, nameByCode, dataDay);
  const newsConceptFilled = newsReview.filled;
  // 熔断说明队列没跑完，页面应知道「未被资讯验证」而不是「资讯确认无题材」
  if (newsReview.aborted) {
    errors.push(`资讯复核中断（Wind 接口/额度连续失败），仅复核 ${newsReview.reviewed} 只`);
  }

  // 主营复核（方案 A）：集团品牌标签必须有主营支撑，否则剔除（创维数字的家电）。
  // 资讯复核已因额度熔断时不再试主营，否则每只都要把 5 把 Key 轮一遍
  const brandReview = newsReview.aborted
    ? { checked: 0, pruned: 0, failed: 0, skipped: true, businessText: new Map() }
    : await reviewBrandConcepts(kept, day);
  if (brandReview.failed) {
    errors.push(`主营复核失败 ${brandReview.failed} 只，相关个股保留 Wind 标签`);
  }
  if (process.env.LIMITUP_DEBUG) {
    console.log(`[brand] checked=${brandReview.checked} pruned=${brandReview.pruned} failed=${brandReview.failed}${brandReview.skipped ? " skipped" : ""}`);
  }

  // 概念家数只按留下来的股票统计，避免剔除后 primaryConcept 仍按含 ST 的口径打分
  const conceptCounts = new Map();
  for (const stock of kept) {
    for (const name of stock.concepts) conceptCounts.set(name, (conceptCounts.get(name) || 0) + 1);
  }

  const stocks = kept.map((stock) => ({
    ...stock,
    streakLabel: stock.streak == null ? null : limitStreakLabel(stock.streak),
    // 集合竞价封板（09:25-09:30）即一字板，是次日溢价最强的形态
    isAuctionSeal: stock.bucket === "09:30前(竞价)",
    // 资讯来源的概念不再拿主营改写；Wind 来源的才用主营挑主标签
    primaryConcept: pickPrimaryConcept(
      stock.concepts,
      conceptCounts,
      stock.conceptSource === "news" ? "" : (brandReview.businessText.get(stock.code) || "")
    )
  }))
    .sort((a, b) => (b.streak || 1) - (a.streak || 1) || String(a.sealTime || "99").localeCompare(String(b.sealTime || "99")));

  // 昨日涨停题材：既要给页面做「较上日」对比，也是判断负反馈的基准。
  const previousThemes = aggregateThemeOccurrences([...(yesterdayCodes || [])].map((code) => ({
    names: yesterday.concepts.get(code) || [],
    streak: streakAgainst(sets.slice(1), code)
  })));

  // 上一交易日的涨停家数与最高板可由既定连板历史直接反推：
  // sets[0] 就是昨日涨停名单，逐个回看 sets[1..] 即得它昨天的板高。
  // 这样环比不依赖"历史日定格快照"（历史日拿不到封板时间，永远补不出来）。
  // 但封板时间与概念在历史日确实取不到，因此标记 partial，让页面只展示能算的部分。
  const previousDay = yesterdayCodes?.size ? (() => {
    let maxStreak = 0;
    for (const code of yesterdayCodes) maxStreak = Math.max(maxStreak, streakAgainst(sets.slice(1), code));
    return {
      tradingDate: baseTradingDate,
      limitUpCount: yesterdayCodes.size,
      limitDownCount: previousDownCount,
      maxStreak: maxStreak || null,
      firstSealCount: null,
      // 昨日涨停题材（家数/最高板），供页面画「较上日」与负反馈基准
      concepts: previousThemes.map((theme) => ({ name: theme.name, limitCount: theme.count, maxStreak: theme.maxStreak })),
      partial: true,
      verified: Boolean(historyResult.complete)
    };
  })() : null;

  // 天梯：按板高降序
  const tierMap = new Map();
  for (const stock of stocks) {
    const streak = stock.streak || 1;
    if (!tierMap.has(streak)) tierMap.set(streak, []);
    tierMap.get(streak).push(stock.code);
  }
  const ladder = [...tierMap].sort((a, b) => b[0] - a[0])
    .map(([streak, codes]) => ({ streak, label: limitStreakLabel(streak), count: codes.length, stocks: codes }));
  const levels = new Set(tierMap.keys());
  let ladderDepth = 0;
  while (levels.has(ladderDepth + 1)) ladderDepth += 1;

  // 断板带：昨日最高板里今日没再接上的，是退潮最直接的信号，优先于"今天最高几板"。
  const brokenStreaks = brokenCodes.length ? {
    streak: topStreak,
    totalCount: topCodes.length,
    brokenCount: brokenCodes.length,
    promotedCount: topCodes.length - brokenCodes.length,
    broken: brokenCodes.map((code) => {
      const reviewed = newsReview.brokenConcepts.get(code) || [];
      const list = reviewed.length ? reviewed : (brokenConceptMap.get(code) || []);
      const best = list.find(isWhitelistTheme) || list[0] || null;
      return { code, name: nameByCode.get(code) || null, concept: best ? conceptLabelOf(best) : null };
    }),
    namesComplete: nameByCode.size > 0,
    // 断板股本身是否有概念，而不是"这批名单里是否有人带概念"；资讯复核结果也算
    conceptsComplete: brokenCodes.every((code) =>
      (newsReview.brokenConcepts.get(code) || []).length > 0 || (brokenConceptMap.get(code) || []).length > 0)
  } : null;

  // 同一份名单顺带补全未晋级股简称，零额外调用
  promotion.failed = promotion.failed.map((item) => ({ ...item, name: nameByCode.get(item.code) || null }));

  // 题材强弱：涨停题材 vs 跌停题材，叠加昨日涨停题材与今日断板/未晋级题材。
  // 断板题材用「昨日该股所属概念」而非今日概念（今日已无涨停，资讯也查不到）。
  const brokenThemes = aggregateThemeOccurrences(promotion.failed.map((item) => ({
    names: brokenConceptMap.get(item.code) || [],
    streak: item.fromStreak || 1
  })));
  const themeStrength = buildThemeStrength({
    upThemes: themeCountsOf(stocks),
    downThemes: themeCountsOf(downStocks),
    previousThemes,
    brokenThemes
  });
  // 概念聚合不再只讲涨停：涨跌强弱状态直接挂在同一行，页面只保留一个题材模块
  const conceptBoard = mergeThemeBoard({ concepts: aggregateConcepts(stocks), themeStrength }).slice(0, 30);

  // 晋级成功的个股按题材归类：只看晋级率不够，还要知道"分子"落在哪些题材上
  const promotedCodes = new Set(promotion.promoted.map((item) => item.code));
  const promotedStocks = stocks.filter((stock) => promotedCodes.has(stock.code));
  promotion.themeBreakdown = aggregateConcepts(promotedStocks)
    .slice(0, 8)
    .map((concept) => ({
      name: concept.name,
      limitCount: concept.limitCount,
      maxStreak: concept.maxStreak,
      whitelist: concept.whitelist
    }));

  // 封板时间分布
  const bucketed = new Map(SEAL_BUCKETS.map((bucket) => [bucket.label, []]));
  bucketed.set("时间未知", []); bucketed.set("其他", []);
  for (const stock of stocks) bucketed.get(stock.bucket)?.push(stock.code);
  const sealTimeBuckets = [...bucketed].filter(([, codes]) => codes.length)
    .map(([label, codes]) => ({ label, count: codes.length, stocks: codes }));

  const firstSealCount = stocks.filter((stock) => clockMinutes(stock.sealTime) != null && clockMinutes(stock.sealTime) < 600).length;

  const summary = {
    limitUpCount: stocks.length,
    limitDownCount: downStocks.length,
    upDownNet: stocks.length - downStocks.length,
    maxStreak: ladder[0]?.streak || 0,
    ladderDepth,
    firstSealCount,
    stCount,
    limitDownStCount: downStCount,
    newsConceptFilled,
    newsConceptReviewed: newsReview.reviewed,
    newsConceptAborted: newsReview.aborted,
    brandConceptChecked: brandReview.checked,
    brandConceptPruned: brandReview.pruned,
    brandConceptSkipped: Boolean(brandReview.skipped),
    promotionRate: promotion.overallRate,
    yesterdayLimitUpCount: promotion.baseLimitUpCount,
    previousLimitDownCount: previousDownCount,
    negativeFeedbackThemes: themeStrength.filter((theme) => theme.negativeFeedback).length,
    // 一字板=集合竞价直接封板，是竞价强度最硬的证据（今日涨停股口径，零额外取数）
    auctionSealCount: stocks.filter((stock) => stock.isAuctionSeal).length,
    // 昨日涨停股今日表现（赚钱效应）：今日涨跌幅中位数 / 隔夜开盘（竞价）溢价中位数
    premiumMedian: premium?.median ?? null,
    premiumSampleSize: premium?.sampleSize ?? 0,
    auctionPremiumMedian: premium?.auction?.median ?? null
  };
  // 顶部亮点：把「主线 / 赚钱效应 / 竞价 / 接力 / 高度 / 封板 / 集中度 / 负反馈 / 冰点 / 断板」
  // 压缩成几句话，先看结论再看明细。结构类维度依赖 ladder 与 concepts，必须传原始天梯与合并后的题材行。
  const highlights = buildHighlights({
    summary, themeStrength, brokenStreaks, concepts: conceptBoard, ladder, quoteTime, premium
  });

  return {
    tradingDate: dataDay,
    requestedDate: day,
    capturedAt: new Date().toISOString(),
    quoteTime,
    degraded: stocks.length === 0,
    summary,
    // 跌停明细：题材判断与涨停同口径（同题材族归一、剔除 ST）
    limitDown: {
      day: dataDay,
      count: downStocks.length,
      stCount: downStCount,
      stocks: downStocks,
      concepts: themeCountsOf(downStocks).slice(0, 30),
      complete: downResult.complete,
      cappedSectors: downResult.cappedSectors || [],
      errors: downResult.errors || []
    },
    themeStrength,
    highlights,
    // 昨日涨停股今日溢价（赚钱效应）：首板/连板分组与竞价溢价，取不到则为 null
    premium,
    ladder, stocks, sealTimeBuckets,
    concepts: conceptBoard,
    promotion,
    previous: previousDay,
    brokenStreaks,
    // 触顶板块家数会被截断，页面需要据此标注"可能不全"
    dataQuality: {
      cappedSectors: eventResult.cappedSectors || [],
      truncated: (eventResult.cappedSectors || []).length > 0,
      historyComplete: Boolean(historyResult.complete),
      limitDownComplete: Boolean(downResult.complete),
      errors: [...errors]
    },
    errors
  };
}

export { LIMIT_STYLE_TAG_PATTERN, limitConceptEligible, isWhitelistTheme, boardOf, sealBucketLabel, SEAL_BUCKETS, localDate };
