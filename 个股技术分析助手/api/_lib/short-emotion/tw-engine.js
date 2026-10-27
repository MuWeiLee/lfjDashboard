// 台股短線情緒引擎：只用 Wind MCP。
//
// 与 A股引擎（engine.js）输出同样结构的快照，页面共用一套渲染：
//   loadEmotion        — 加权指数、涨跌家数、涨跌停、大涨大跌、昨日涨停溢价、连板、产业排名、量能
//   loadThemeAnomalies — 以证交所产业指数为题材：涨停点火（成分股）、消息催化（Wind 台股新闻）
//                        Wind 没有台股盘中涨速与概念指数，这两项不做（与产品确认）。
//   loadNews           — Wind 台股新闻
// Wind 没有台股概念指数，题材以产业指数为主，新闻里点名的「XX族群」作为补充。
// 文字一律先用简体产出，service 在写入前统一转换为繁体（hant.js）。
import {
  windCall, tables, objects, fulfilled, reason, runWindTasks, runWindTasksInBatches,
  clamp, scoreBreadth, scoreLimit, scorePremium, classify, limitStreakLabel, localDate
} from "./engine.js";

const INDEX_CODE = "TWII.TW";
const LIMIT_PCT = 9.5; // 台股涨跌幅限制 10%，因价格档位，涨停实际约 9.5%–10%
const MIN_SCORE = 60;
const MAX_ITEMS = 12;
const LIMIT_SIGNAL_MIN = 2;
const HISTORY_DAYS = 10;

// 证交所产业指数（不含「未含金融」「电子类」等综合指数）。
export const TW_INDUSTRIES = [
  ["TWSE071.TW", "半导体"], ["TWSE075.TW", "电子零组件"], ["TWSE073.TW", "光电"], ["TWSE072.TW", "计算机及外围设备"],
  ["TWSE074.TW", "通信网路"], ["TWSE076.TW", "电子通路"], ["TWSE077.TW", "信息服务"], ["TWSE078.TW", "其他电子"],
  ["TWSE010.TW", "金融保险"], ["TWSE021.TW", "航运"], ["TWSE013.TW", "电机机械"], ["TWSE014.TW", "电器电缆"],
  ["TWSE069.TW", "生技医疗"], ["TWSE068.TW", "化学工业"], ["TWSE012.TW", "塑料"], ["TWSE017.TW", "钢铁"],
  ["TWSE019.TW", "汽车"], ["TWSE070.TW", "油电燃气"], ["TWSE006.TW", "建材营造"], ["TWSE022.TW", "观光"],
  ["TWSE023.TW", "贸易百货"], ["TWSE007.TW", "食品"], ["TWSE008.TW", "纺织"], ["TWSE011.TW", "水泥"],
  ["TWSE016.TW", "玻璃陶瓷"], ["TWSE018.TW", "橡胶"], ["TWSE009.TW", "造纸"]
];
const INDUSTRY_NAME = new Map(TW_INDUSTRIES);

// 新闻 → 产业的关键词（Wind 新闻为简体）。
const INDUSTRY_KEYWORDS = {
  半导体: ["半导体", "晶圆", "芯片", "IC设计", "封测", "探针", "先进制程", "先进封装", "CoWoS", "台积电", "联发科", "硅智财", "ASIC"],
  电子零组件: ["被动元件", "CCL", "铜箔基板", "PCB", "印刷电路板", "连接器", "散热", "载板", "ABF"],
  光电: ["光学", "镜头", "面板", "LED", "光通讯", "CPO", "硅光子", "大立光"],
  计算机及外围设备: ["AI服务器", "服务器", "笔电", "机壳", "主板", "鸿海", "广达", "纬创"],
  通信网路: ["网通", "交换器", "低轨卫星", "卫星", "5G", "光纤"],
  电子通路: ["电子通路", "通路商"],
  信息服务: ["软件", "资安", "云端", "数据中心"],
  其他电子: ["EMS", "代工", "电子代工"],
  金融保险: ["金控", "银行", "寿险", "保险", "证券"],
  航运: ["航运", "货柜", "散装", "运价", "长荣", "阳明", "万海", "航空"],
  电机机械: ["机械", "自动化", "机器人", "设备", "重电"],
  电器电缆: ["电线电缆", "电缆", "电力设备"],
  生技医疗: ["生技", "新药", "医疗", "医材"],
  化学工业: ["化工", "特化"],
  塑料: ["塑化", "石化", "台塑"],
  钢铁: ["钢铁", "钢价", "中钢"],
  汽车: ["汽车", "电动车", "车用"],
  油电燃气: ["电力", "储能", "天然气", "燃气", "绿能"],
  建材营造: ["营建", "建设", "房市", "营造"],
  观光: ["观光", "旅游", "餐饮", "饭店"],
  贸易百货: ["百货", "零售", "电商"],
  食品: ["食品", "饮料"],
  纺织: ["纺织", "成衣", "机能布"],
  水泥: ["水泥"],
  玻璃陶瓷: ["玻璃", "陶瓷"],
  橡胶: ["橡胶", "轮胎"],
  造纸: ["造纸", "纸业"]
};

const errorText = (error) => String(error?.message || error);
const num = (value) => (value == null || value === "" ? null : Number.isFinite(Number(value)) ? Number(value) : null);

/** Wind 的时间字段有 ISO 和 "yyyyMMdd HH:mm:ss" 两种，统一成后者（UTC+8）。 */
export function normalizeQuoteTime(value) {
  if (value == null || value === "") return null;
  const text = String(value).trim();
  const plain = text.match(/^(\d{8})\s+(\d{2}):(\d{2})(?::(\d{2}))?/);
  if (plain) return `${plain[1]} ${plain[2]}:${plain[3]}:${plain[4] || "00"}`;
  const date = new Date(text);
  if (Number.isNaN(date.getTime())) return null;
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23"
  }).formatToParts(date).map((part) => [part.type, part.value]));
  return `${parts.year}${parts.month}${parts.day} ${parts.hour}:${parts.minute}:${parts.second}`;
}

const dayOfQuote = (value) => (normalizeQuoteTime(value) || "").slice(0, 8);

/** search_global_stocks 结果：明细行 + Wind 给出的总数。 */
function screenResult(payload) {
  const table = tables(payload)[0];
  const rows = objects(table).map((row) => ({
    code: row["Wind代码"],
    name: row["证券简称"],
    changePct: num(row["最新涨跌幅"] ?? row["涨跌幅"]),
    day: String(row["日期"] ?? "").slice(0, 8) || dayOfQuote(row["交易时间"])
  })).filter((row) => row.code);
  const total = Number(table?.excelTotalCount);
  return { rows, total: Number.isFinite(total) ? total : rows.length };
}

// Wind 条件选股最多返回 100 只：达到上限时页面显示「100+」。
const SCREEN_CAP = 100;
const isCapped = (screen) => Boolean(screen) && screen.rows.length >= SCREEN_CAP && screen.total <= screen.rows.length;

/** 只计当日有成交的股票；明细被截断时按当日占比推算总数。 */
function countForDay(screen, day) {
  if (!screen) return null;
  const today = screen.rows.filter((row) => row.day === day);
  if (screen.rows.length >= screen.total) return today.length;
  if (!screen.rows.length) return screen.total;
  return Math.round(screen.total * today.length / screen.rows.length);
}

const screenTw = (condition) => windCall("global_stock_data", "search_global_stocks", { question: `筛选台湾上市柜股票中${condition}的股票` });

// ── 跨日状态：每日涨停名单（连板） ──
let state = { limitHistory: {}, tradingDates: [] };

export function exportEngineState(day = localDate()) {
  const days = Object.keys(state.limitHistory).sort().slice(-HISTORY_DAYS);
  return {
    day,
    market: "tw",
    limitHistory: Object.fromEntries(days.map((key) => [key, state.limitHistory[key]])),
    tradingDates: state.tradingDates.slice(-HISTORY_DAYS * 2)
  };
}

export function importEngineState(saved) {
  if (!saved || saved.market !== "tw") return;
  state = {
    limitHistory: saved.limitHistory && typeof saved.limitHistory === "object" ? { ...saved.limitHistory } : {},
    tradingDates: Array.isArray(saved.tradingDates) ? saved.tradingDates : []
  };
}

async function tradingCalendar(day) {
  const begin = new Date(Date.UTC(Number(day.slice(0, 4)), Number(day.slice(4, 6)) - 1, Number(day.slice(6, 8)) - 30));
  const beginDay = begin.toISOString().slice(0, 10).replaceAll("-", "");
  const payload = await windCall("index_data", "get_index_kline", { windcode: INDEX_CODE, begin_date: beginDay, end_date: day });
  const rows = objects(tables(payload)[0]).map((row) => ({
    day: dayOfQuote(row.TIME),
    turnover: num(row.TURNOVER)
  })).filter((row) => row.day);
  if (rows.length) state.tradingDates = [...new Set([...state.tradingDates, ...rows.map((row) => row.day)])].sort();
  return rows;
}

function previousTradingDays(day, count) {
  return state.tradingDates.filter((date) => date < day).slice(-count);
}

/** 连板数：今天涨停 + 往前连续几个交易日也在涨停名单里。缺少某日名单时就此停止计数。 */
function streakOf(code, day) {
  let streak = 1;
  for (const date of previousTradingDays(day, HISTORY_DAYS).reverse()) {
    const list = state.limitHistory[date];
    if (!Array.isArray(list) || !list.includes(code)) break;
    streak += 1;
  }
  return streak;
}

/** 首次运行时补齐前几个交易日的涨停名单（每天一次请求，之后由每日快照累积）。 */
async function backfillLimitHistory(day, count = 4) {
  const missing = previousTradingDays(day, count).filter((date) => !Array.isArray(state.limitHistory[date]));
  if (!missing.length) return [];
  const results = await runWindTasks(missing.map((date) => () => screenTw(`${date}涨跌幅大于等于${LIMIT_PCT}%`)));
  const errors = [];
  results.forEach((result, index) => {
    const screen = result.status === "fulfilled" ? screenResult(result.value) : null;
    if (screen?.rows.length) state.limitHistory[missing[index]] = screen.rows.map((row) => row.code);
    else errors.push(`连板回补 ${missing[index]}: ${reason(result) || "无数据"}`);
  });
  return errors;
}

/** 批量查询多只台股的最新涨跌幅（每次最多 20 只）。 */
async function latestChanges(codes) {
  const unique = [...new Set(codes)].filter(Boolean);
  const chunks = [];
  for (let index = 0; index < unique.length; index += 20) chunks.push(unique.slice(index, index + 20));
  const results = await runWindTasksInBatches(chunks.map((chunk) => () => windCall("analytics_data", "get_financial_data", { question: `${chunk.join("、")}的最新涨跌幅` })), 4);
  const changes = new Map();
  results.forEach((result) => {
    for (const table of tables(fulfilled(result))) {
      for (const row of objects(table)) {
        const value = num(row["最新涨跌幅"] ?? row["涨跌幅"]);
        if (row["Wind代码"] && value != null) changes.set(row["Wind代码"], { name: row["证券简称"], changePct: value });
      }
    }
  });
  return { changes, errors: results.map(reason).filter(Boolean) };
}

async function industrySnapshot(indexes) {
  const payload = await windCall("index_data", "get_index_price_indicators", {
    windcode: TW_INDUSTRIES.map(([code]) => code).join(","),
    indexes
  });
  return objects(tables(payload)[0]).map((row) => ({
    code: row["Wind代码"],
    name: INDUSTRY_NAME.get(row["Wind代码"]) || row["中文简称"] || row["Wind代码"],
    level: num(row["最新成交价"]),
    changePct: num(row["涨跌幅"]),
    amount: num(row["成交额"]),
    tradeTime: normalizeQuoteTime(row["交易时间"])
  })).filter((row) => row.code && row.changePct != null);
}

function scoreLadder(streaks) {
  if (!streaks.length) return 50;
  const multi = streaks.filter((value) => value >= 2).length;
  const max = Math.max(...streaks);
  return clamp(38 + multi * 6 + (max - 1) * 8 + Math.min(streaks.length, 40) * .3);
}

function scoreLiquidity(today, history) {
  const values = history.map((row) => row.turnover).filter((value) => Number.isFinite(value) && value > 0).slice(-5);
  if (!Number.isFinite(today) || !values.length) return { score: 50, ratio: null };
  const average = values.reduce((sum, value) => sum + value, 0) / values.length;
  const ratio = today / average;
  return { score: clamp(50 + (ratio - 1) * 80), ratio };
}

function scoreIndustries(themes) {
  if (!themes.length) return 50;
  const sorted = [...themes].sort((a, b) => b.changePct - a.changePct);
  const first = sorted[0].changePct;
  const fifth = sorted[Math.min(4, sorted.length - 1)].changePct;
  const positive = themes.filter((item) => item.changePct > 0).length / themes.length;
  return clamp(40 + first * 3 + fifth * 2 + (positive - .5) * 30);
}

let inflight = null;

export async function loadEmotion() {
  if (inflight) return inflight;
  inflight = (async () => {
    const day = localDate();
    const errors = [];
    let calendar = [];
    try { calendar = await tradingCalendar(day); } catch (error) { errors.push(`交易日历: ${errorText(error)}`); }
    errors.push(...await backfillLimitHistory(day).catch((error) => [`连板回补: ${errorText(error)}`]));

    const calls = await runWindTasks([
      () => windCall("index_data", "get_index_price_indicators", { windcode: INDEX_CODE, indexes: "最新成交价,涨跌幅,成交额,交易时间" }),
      () => screenTw(`今日涨跌幅大于等于${LIMIT_PCT}%`),
      () => screenTw(`今日涨跌幅小于等于-${LIMIT_PCT}%`),
      () => screenTw("今日涨跌幅大于5%"),
      () => screenTw("今日涨跌幅小于-5%"),
      () => industrySnapshot("最新成交价,涨跌幅,成交额,交易时间")
    ]);
    const indexRow = objects(tables(fulfilled(calls[0]))[0])[0] || {};
    // 以行情日期为准：盘前/收盘后 Wind 返回的是最近一个交易日的数据，按日历「今天」会全部被过滤掉。
    const rawQuoteTime = normalizeQuoteTime(indexRow["交易时间"]);
    const dataDay = rawQuoteTime?.slice(0, 8) || day;
    // 非盘中时 Wind 的时间是 00:00:00，显示为当日收盘 13:30
    const quoteTime = rawQuoteTime && / 00:00:00$/.test(rawQuoteTime) ? `${dataDay} 13:30:00` : rawQuoteTime;
    const screens = calls.slice(1, 5).map((result) => (fulfilled(result) ? screenResult(fulfilled(result)) : null));
    const [limitUpScreen, limitDownScreen, bigUpScreen, bigDownScreen] = screens;
    // 广度：Wind 的条件选股最多返回 100 只，无法数出全市场涨跌家数；改用 27 个证交所产业指数的涨跌家数。
    const allIndustries = fulfilled(calls[5]) || [];
    const up = allIndustries.length ? allIndustries.filter((item) => item.changePct > 0).length : null;
    const down = allIndustries.length ? allIndustries.filter((item) => item.changePct < 0).length : null;
    const flat = allIndustries.length ? allIndustries.filter((item) => item.changePct === 0).length : null;
    const breadthSource = "证交所产业指数涨跌家数";
    const limitUpRows = (limitUpScreen?.rows || []).filter((row) => row.day === dataDay);
    const limitDownRows = (limitDownScreen?.rows || []).filter((row) => row.day === dataDay);
    const limitUp = limitUpScreen ? countForDay(limitUpScreen, dataDay) : null;
    const limitDown = limitDownScreen ? countForDay(limitDownScreen, dataDay) : null;
    const bigUp = countForDay(bigUpScreen, dataDay);
    const bigDown = countForDay(bigDownScreen, dataDay);
    const themes = [...allIndustries].sort((a, b) => b.changePct - a.changePct)
      .slice(0, 10).map((item) => ({ code: item.code, name: `${item.name}`, changePct: item.changePct, tradeTime: item.tradeTime }));

    // 记录行情日的涨停名单（连板计算用）
    if (limitUpRows.length) state.limitHistory[dataDay] = limitUpRows.map((row) => row.code);
    const streaks = limitUpRows.map((row) => streakOf(row.code, dataDay));

    // 昨日涨停溢价：前一交易日涨停股今天的平均涨跌幅
    const previousDay = previousTradingDays(dataDay, 1)[0] || null;
    const previousLimits = previousDay ? state.limitHistory[previousDay] || [] : [];
    let premium = null;
    let premiumSample = 0;
    if (previousLimits.length) {
      const { changes, errors: changeErrors } = await latestChanges(previousLimits);
      errors.push(...changeErrors);
      const values = previousLimits.map((code) => changes.get(code)?.changePct).filter(Number.isFinite);
      premiumSample = values.length;
      premium = values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
    }

    const amount = num(indexRow["成交额"]);
    const liquidity = scoreLiquidity(amount, calendar.filter((row) => row.day < dataDay));
    const upRatio = Number.isFinite(up) && Number.isFinite(down) && up + down > 0 ? up / (up + down) * 100 : null;
    const dimensions = {
      breadth: Math.round(scoreBreadth(up, down)),
      limits: Math.round(scoreLimit(limitUp, limitDown, bigUp, bigDown)),
      ladder: Math.round(scoreLadder(streaks)),
      profit: Math.round(scorePremium(premium)),
      themes: Math.round(scoreIndustries(allIndustries)),
      liquidity: Math.round(liquidity.score)
    };
    const score = Math.round(clamp(dimensions.breadth * .2 + dimensions.limits * .2 + dimensions.ladder * .15 + dimensions.profit * .2 + dimensions.themes * .15 + dimensions.liquidity * .1));
    errors.push(...calls.map(reason).filter(Boolean));
    errors.push(...[
      [!Object.keys(indexRow).length, "加权指数"], [up == null || down == null, "产业涨跌家数"],
      [limitUp == null, "涨停家数"], [limitDown == null, "跌停家数"], [bigUp == null, "大涨家数"],
      [bigDown == null, "大跌家数"], [premium == null, "昨日涨停溢价"], [!themes.length, "产业排名"]
    ].filter(([missing]) => missing).map(([, name]) => `NO_RESULTS: ${name}未返回`));

    return {
      marketCode: "tw",
      tradingDate: day,
      capturedAt: new Date().toISOString(),
      quoteTime,
      source: "Wind AI Fin Market（台股）",
      score,
      regime: classify(score, { upRatio }),
      dimensions,
      marketMeta: { indexName: "台湾加权指数", indexCode: INDEX_CODE, currency: "TWD", breadthSource, liquidityRatio: liquidity.ratio },
      market: {
        index: num(indexRow["最新成交价"]),
        changePct: num(indexRow["涨跌幅"]),
        amount,
        up, down, flat, upRatio
      },
      extremes: { limitUp, limitDown, bigUp, bigDown, bigUpCapped: isCapped(bigUpScreen), bigDownCapped: isCapped(bigDownScreen), limitUpCapped: isCapped(limitUpScreen), limitDownCapped: isCapped(limitDownScreen), limitUpStocks: limitUpRows.slice(0, 80), limitDownStocks: limitDownRows.slice(0, 40) },
      ladder: {
        maxStreak: streaks.length ? Math.max(...streaks) : 0,
        multiBoard: streaks.filter((value) => value >= 2).length,
        counts: streaks.reduce((counts, value) => { const label = limitStreakLabel(value); counts[label] = (counts[label] || 0) + 1; return counts; }, {})
      },
      profit: { premium, sampleSize: premiumSample, baseTradingDate: previousDay, currentTradingDate: dataDay, method: "前一交易日涨停股（涨幅≥9.5%）今日涨跌幅等权平均" },
      themes,
      coverage: [
        { name: "市场广度", status: up != null ? "direct" : "error", note: breadthSource },
        { name: "涨跌停与大涨大跌", status: limitUp != null ? "derived" : "error", note: "涨跌幅≥9.5%视为涨停（台股涨跌幅限制10%）" },
        { name: "昨日涨停溢价", status: premium != null ? "derived" : "error", note: `前一交易日涨停股今日等权平均（${premiumSample}只）` },
        { name: "连板", status: "derived", note: "每日涨停名单本地累计" },
        { name: "题材", status: "limited", note: "Wind无台股概念指数，以证交所产业指数代替" }
      ],
      errors,
      partial: errors.length > 0
    };
  })().finally(() => { inflight = null; });
  return inflight;
}

function industryNewsMatches(news, industryName) {
  const keywords = INDUSTRY_KEYWORDS[industryName] || [industryName];
  const matches = [];
  for (const article of news) {
    const text = `${article.title || ""}。${article.content || ""}`;
    const hits = keywords.filter((keyword) => text.includes(keyword));
    if (!hits.length) continue;
    const sentence = text.split(/[。！？\n]/).find((part) => hits.some((keyword) => part.includes(keyword))) || article.title || "";
    matches.push({
      title: article.title || "Wind台股新闻",
      source: article.source || "Wind财经新闻",
      date: article.date || "",
      viewpoint: sentence.trim().slice(0, 140),
      impact: `新闻点名${hits.slice(0, 3).join("、")}，关注${industryName}资金是否持续流入。`,
      matchedKeywords: hits.slice(0, 5),
      relevanceScore: Math.round((Number(article.relevance) || 0) * 100)
    });
  }
  return matches;
}

/** 新闻里「XX族群」附近出现的股票代码，例如「探针族群 旺矽(6223)、颖崴(6515)」。 */
export function newsGroups(news) {
  const groups = new Map();
  for (const article of news) {
    const text = `${article.title || ""}。${article.content || ""}`;
    for (const sentence of text.split(/[。！？\n；]/)) {
      const names = [...sentence.matchAll(/([一-龥A-Za-z]{2,6})族群/g)]
        .map((match) => match[1].replace(/^(?:以及|还有|包括|带动|其中|其他|整体|相关|与|及|和|跟|的|在|让|使|由|对)+/, ""))
        .filter((name) => name.length >= 2 && !/^(相关|各|其他|这些|该|多个|热门|部分|个别)$/.test(name));
      if (!names.length) continue;
      const stocks = [...sentence.matchAll(/([一-龥A-Za-z-]{2,8})[（(](\d{4,6}[A-Z]?)[)）]/g)].map((match) => ({ name: match[1], code: match[2] }));
      for (const name of names) {
        if (!groups.has(name)) groups.set(name, { name, stocks: new Map(), articles: [] });
        const group = groups.get(name);
        stocks.forEach((stock) => group.stocks.set(stock.code, stock));
        if (!group.articles.includes(article)) group.articles.push(article);
      }
    }
  }
  return [...groups.values()].map((group) => ({ ...group, stocks: [...group.stocks.values()] }));
}


let anomalyInflight = null;

export async function loadThemeAnomalies() {
  if (anomalyInflight) return anomalyInflight;
  anomalyInflight = (async () => {
    const day = localDate();
    const errors = [];
    const [industryResult, limitResult, newsResult] = await runWindTasks([
      () => industrySnapshot("最新成交价,涨跌幅,成交额,交易时间"),
      () => screenTw(`今日涨跌幅大于等于${LIMIT_PCT}%`),
      () => windCall("financial_docs", "get_financial_news", { query: `${day}台股盘中热点族群题材`, top_k: 10 })
    ]);
    errors.push(...[industryResult, limitResult, newsResult].map(reason).filter(Boolean));
    const industries = fulfilled(industryResult) || [];
    const tradeTime = industries.map((item) => item.tradeTime).filter(Boolean).sort().at(-1) || null;
    const dataDay = tradeTime?.slice(0, 8) || day;
    const limitRows = (fulfilled(limitResult) ? screenResult(fulfilled(limitResult)).rows : []).filter((row) => row.day === dataDay);
    const news = fulfilled(newsResult)?.data?.items || fulfilled(newsResult)?.data?.data?.items || [];

    // 候选产业：涨幅前 8 + 新闻点名的产业，逐个查询成分股排名。
    const newsHits = new Map(industries.map((item) => [item.code, industryNewsMatches(news, item.name)]));
    const byChange = [...industries].sort((a, b) => b.changePct - a.changePct).slice(0, 8);
    const byNews = industries.filter((item) => newsHits.get(item.code).length).sort((a, b) => newsHits.get(b.code).length - newsHits.get(a.code).length).slice(0, 4);
    const candidates = [...new Map([...byChange, ...byNews].map((item) => [item.code, item])).values()];
    const memberResults = await runWindTasksInBatches(candidates.map((item) => () => windCall("analytics_data", "get_financial_data", {
      question: `台湾${item.name}指数成分股今日涨跌幅排名前十`
    })), 5);
    const knownSuffix = new Map(limitRows.map((row) => [row.code.split(".")[0], row.code]));

    const buildItem = (base, members, articles, kind) => {
      const limitStocks = members.filter((row) => row.changePct >= LIMIT_PCT).map((row) => {
        const streak = streakOf(row.code, dataDay);
        return { code: row.code, name: row.name, changePct: row.changePct, limitStreak: streak, streakLabel: limitStreakLabel(streak) };
      });
      const followers = members.filter((row) => row.changePct >= 3 && row.changePct < LIMIT_PCT).slice(0, 5);
      const rideable = members.filter((row) => row.changePct > 0 && row.changePct < 3).slice(0, 2).map((row, index) => ({
        ...row,
        candidateScore: Math.round(clamp(60 + row.changePct * 6 - index * 4)),
        trigger: `站稳日内均价且${base.name}指数维持红盘`,
        invalidation: "跌破今日开盘价或产业指数翻黑"
      }));
      const dayChange = base.changePct;
      const signals = [];
      if (limitStocks.length >= LIMIT_SIGNAL_MIN) signals.push("limit");
      if (articles.length) signals.push("news");
      const streaks = limitStocks.map((stock) => stock.limitStreak);
      const maxStreak = streaks.length ? Math.max(...streaks) : 0;
      const highBoardBonus = maxStreak >= 3 ? Math.min(12, (maxStreak - 2) * 4) : 0;
      let contiguousDepth = 0;
      for (let depth = 1; depth <= maxStreak; depth += 1) { if (streaks.includes(depth)) contiguousDepth = depth; else break; }
      const ladderBonus = contiguousDepth >= 3 ? 4 : 0;
      const limitStrength = signals.includes("limit") ? Math.min(100, 62 + (limitStocks.length - LIMIT_SIGNAL_MIN) * 9 + Math.max(0, dayChange) * 2) : 0;
      const batchStrength = 0;
      const newsStrength = signals.includes("news") ? Math.min(100, 50 + articles.length * 10 + Math.max(0, dayChange) * 5) : 0;
      const resonance = signals.length >= 2 ? 6 : 0;
      const all = Math.round(clamp(Math.max(limitStrength, newsStrength) * .75 + (limitStrength + newsStrength) / 2 * .25 + resonance + highBoardBonus + ladderBonus + Math.max(0, dayChange) * 1.5));
      const tabScores = {
        all,
        limit: signals.includes("limit") ? Math.round(clamp(limitStrength * .85 + newsStrength * .15 + highBoardBonus)) : 0,
        batch: 0,
        news: signals.includes("news") ? Math.round(clamp(newsStrength * .8 + limitStrength * .2)) : 0
      };
      let status = signals.includes("limit") ? "涨停点火" : signals.includes("news") ? "消息观察" : "温和走强";
      if (signals.length >= 2) status = "催化共振";
      return {
        name: base.name,
        code: base.code,
        kind,
        dayChange,
        shortMove: null,
        tradeTime: base.tradeTime || tradeTime,
        score: all,
        tabScores,
        signals,
        status,
        limitStocks,
        followers,
        rideable,
        news: articles.slice(0, 3),
        branches: [],
        ladder: { maxStreak, contiguousDepth, highBoardBonus, ladderBonus, totalBonus: highBoardBonus + ladderBonus },
        scoreBreakdown: { limit: Math.round(limitStrength), batch: Math.round(batchStrength), news: Math.round(newsStrength), resonance, highBoardBonus, ladderBonus, ladderTotalBonus: highBoardBonus + ladderBonus },
        sortMetrics: {
          limitCount: limitStocks.length,
          fiveMinuteChange: 0,
          newsMomentum: Math.round((dayChange || 0) * 100) / 100
        }
      };
    };

    const rawItems = candidates.map((item, index) => {
      const members = [];
      for (const table of tables(fulfilled(memberResults[index]))) {
        for (const row of objects(table)) {
          const changePct = num(row["最新涨跌幅"] ?? row["涨跌幅"]);
          if (row["Wind代码"] && changePct != null && /\.TWO?$/.test(row["Wind代码"])) members.push({ code: row["Wind代码"], name: row["证券简称"], changePct });
        }
      }
      members.sort((a, b) => b.changePct - a.changePct);
      return buildItem(item, members, newsHits.get(item.code) || [], "industry");
    });
    errors.push(...memberResults.map(reason).filter(Boolean));

    // 新闻族群：至少点名 2 只股票，查询它们今天的涨跌幅。
    const groups = newsGroups(news).filter((group) => group.stocks.length >= 2).slice(0, 4);
    if (groups.length) {
      // 新闻里只有数字代码，不知道是上市（.TW）还是上柜（.TWO），两种都查，只有一种会有数据。
      const codes = groups.flatMap((group) => group.stocks.flatMap((stock) => knownSuffix.has(stock.code) ? [knownSuffix.get(stock.code)] : [`${stock.code}.TW`, `${stock.code}.TWO`]));
      const { changes, errors: changeErrors } = await latestChanges(codes);
      errors.push(...changeErrors);
      for (const group of groups) {
        const members = group.stocks.map((stock) => {
          const code = [knownSuffix.get(stock.code), `${stock.code}.TW`, `${stock.code}.TWO`].find((candidate) => candidate && changes.has(candidate));
          const quote = code && changes.get(code);
          return quote ? { code, name: quote.name || stock.name, changePct: quote.changePct } : null;
        }).filter(Boolean).sort((a, b) => b.changePct - a.changePct);
        if (!members.length) continue;
        const average = members.reduce((sum, row) => sum + row.changePct, 0) / members.length;
        const articles = group.articles.slice(0, 3).map((article) => ({
          title: article.title || "Wind台股新闻",
          source: article.source || "Wind财经新闻",
          date: article.date || "",
          viewpoint: (`${article.title || ""}。${article.content || ""}`.split(/[。！？\n]/).find((part) => part.includes(`${group.name}族群`)) || "").trim().slice(0, 140),
          impact: `新闻点名${group.name}族群，观察资金是否持续扩散。`,
          matchedKeywords: [`${group.name}族群`],
          relevanceScore: Math.round((Number(article.relevance) || 0) * 100)
        }));
        rawItems.push(buildItem({ name: `${group.name}族群`, code: "新闻族群", changePct: Math.round(average * 100) / 100, tradeTime }, members, articles, "news-group"));
      }
    }

    const items = rawItems.filter((item) => item.tabScores.all >= MIN_SCORE || item.signals.length)
      .sort((a, b) => b.score - a.score || b.sortMetrics.limitCount - a.sortMetrics.limitCount).slice(0, MAX_ITEMS);
    const streakCounts = limitRows.reduce((counts, row) => {
      const label = limitStreakLabel(streakOf(row.code, dataDay));
      counts[label] = (counts[label] || 0) + 1;
      return counts;
    }, {});
    return {
      marketCode: "tw",
      asOf: new Date().toISOString(),
      tradingDate: day,
      items,
      summary: {
        total: items.filter((item) => item.tabScores.all >= MIN_SCORE).length,
        rawTotal: rawItems.length,
        mergedTotal: rawItems.length,
        filteredOut: rawItems.length - items.filter((item) => item.tabScores.all >= MIN_SCORE).length,
        minScore: MIN_SCORE
      },
      limitData: { stockCount: limitRows.length, streakCounts },
      source: "Wind台股产业指数、条件选股、成分股排名、台股新闻",
      partial: errors.length > 0,
      errors
    };
  })().finally(() => { anomalyInflight = null; });
  return anomalyInflight;
}

export async function loadNews() {
  const payload = await windCall("financial_docs", "get_financial_news", { query: `${localDate()}台股热点题材催化`, top_k: 5 });
  return payload?.data?.items || payload?.data?.data?.items || [];
}

// 台股连续交易 09:00–13:30
export function historyTradingMinute(item) {
  const match = String(item.quoteTime || "").match(/(\d{8})\s+(\d{2}):(\d{2})/);
  if (!match || match[1] !== String(item.tradingDate || "")) return null;
  return Number(match[2]) * 60 + Number(match[3]);
}

export function isTradingSessionHistory(item) {
  const minute = historyTradingMinute(item);
  return Number.isFinite(minute) && minute >= 9 * 60 && minute <= 13 * 60 + 35;
}

export function historyRecord(snapshot) {
  return { tradingDate: snapshot.tradingDate, capturedAt: snapshot.capturedAt, quoteTime: snapshot.quoteTime, score: snapshot.score, phase: snapshot.regime.phase, up: snapshot.market.up, down: snapshot.market.down, limitUp: snapshot.extremes.limitUp, limitDown: snapshot.extremes.limitDown, premium: snapshot.profit.premium };
}

export { classify };
