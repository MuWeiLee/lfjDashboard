// 短线情绪观测引擎 — ported from lfjDashboard/短线情绪工作台/stock-investment-workbench/server-emotion.mjs
//
// Scoring, theme-anomaly radar and news-catalyst logic are kept as in the original.
// Serverless changes only:
//   * Wind calls go through callWindTool (HTTPS MCP) instead of spawning cli.mjs;
//   * no HTTP server / static file serving / local JSON history file — the caller
//     (service.js) persists snapshots and history in Supabase;
//   * the Edge + PowerShell PNG exporter is dropped (the page exports in-browser);
//   * per-day caches (concept membership, limit-up history, previous trading date)
//     can be exported/imported so cron runs on cold instances don't refetch them.
import { callWindTool } from "./wind-client.js";

const cacheTtlMs = 60_000;
let inflight = null;
let anomalyInflight = null;
const conceptMembershipCache = new Map();
const investmentLogicCache = new Map();
const stockCatalystCache = new Map();
const themeMomentumCache = new Map();
const themeMomentumCacheTtlMs = 300_000;
let lastValidLimitStocks = [];
let lastValidLimitTradingDate = null;
let lastValidLimitCapturedAt = 0;
let cachedLimitHistory = null;
let cachedPreviousTradingDate = null;
let cachedLiquidityHistory = null;
let cachedAnomalies = null;
let anomalyCachedAt = 0;

const newsThemeRules = [
  { name: "农业种植", keywords: ["农业", "种植", "种业", "粮食", "大豆", "玉米", "育种", "农产品"] },
  { name: "机器人", keywords: ["机器人", "人形机器人", "减速器", "灵巧手", "丝杠"] },
  { name: "AI算力", keywords: ["人工智能", "AI", "算力", "服务器", "数据中心", "CPO", "光模块"] },
  { name: "半导体", keywords: ["半导体", "芯片", "存储器", "光刻", "先进封装", "晶圆"] },
  { name: "医药", keywords: ["医药", "创新药", "CXO", "医疗", "生物制药", "疫苗"] },
  { name: "消费", keywords: ["消费", "零售", "食品饮料", "白酒", "旅游", "免税"] },
  { name: "军工", keywords: ["军工", "商业航天", "卫星", "低空经济", "航空装备"] },
  { name: "有色金属", keywords: ["有色", "黄金", "铜", "铝", "稀土", "锂矿", "钨"] },
  { name: "油气", keywords: ["油气", "石油", "天然气", "原油", "页岩气"] },
  { name: "房地产", keywords: ["房地产", "地产", "房屋", "物业", "城市更新"] },
  { name: "金融科技", keywords: ["金融科技", "证券", "券商", "互联网金融", "数字货币"] }
].map((rule) => ({ ...rule, pattern: new RegExp(rule.keywords.join("|"), "iu") }));

const NEWS_CATALYST_DRIVERS = [
  { name: "事件冲击", pattern: /极端气候|极端天气|灾害|事件催化|关税|制裁|冲突|禁运/, mechanism: "供需扰动、风险溢价与事件预期" },
  { name: "政策支持", pattern: /政策|规划|意见|方案|通知|支持|补贴|改革|收储/, mechanism: "政策预期、资源投入或需求释放" },
  { name: "价格变化", pattern: /涨价|提价|价格(?:上涨|上行|走高|创新高)|报价上调|期货.{0,8}(?:上涨|走强)/, mechanism: "产品价格与产业链盈利预期" },
  { name: "需求与订单", pattern: /需求|订单|中标|销售|出货|渗透率|景气|增长|扩张/, mechanism: "需求增量、订单兑现与收入预期" },
  { name: "供给变化", pattern: /减产|停产|短缺|供给收缩|库存下降|限产|产能出清/, mechanism: "供需格局与价格弹性" },
  { name: "技术与产业进展", pattern: /突破|发布|上市|量产|首发|大会|商业化|获批|投产/, mechanism: "产业进程、估值锚与风险偏好" },
  { name: "业绩验证", pattern: /业绩|盈利|净利润|营收|扭亏|预增|高增长/, mechanism: "盈利兑现与估值重估" }
];
const NEGATIVE_NEWS_VIEW = /规避|回避|减配|低配|减持|撤出|流出|谨慎看待|不确定性(?:较高|上升|增加)|承压|压制|压力(?:加大|上升|增加)|回吐|走弱|抛压|下跌|利空|下调|调降|不及预期|低于预期|没那么强|需求(?:走弱|放缓|下降|萎缩)|景气(?:回落|下行)|增长放缓|订单下降|销量下降|亏损|风险暴露|违约|暴雷|恶化|收紧|限制|禁止/;
const POSITIVE_NEWS_VIEW = /利好|受益|支持|鼓励|加码|上调|调升|增持|布局|改善|修复|回暖|提振|释放需求|扩大需求|需求(?:增长|提升|旺盛)|订单(?:增长|增加|落地|饱满)|中标|签约|销售增长|出货增长|渗透率提升|景气(?:上行|提升)|高增长|预增|扭亏|涨价|提价|供给收缩|减产|停产|短缺|库存下降|限产|产能出清|补贴|改革|收储|突破|获批|量产|投产|商业化|国产替代|自主可控/;
const RECAP_ARTICLE_TITLE = /复盘|收评|午评|早评|盘后|盘点|回顾|内参|操盘必读|财经早餐|A股早报|早间资讯|晨报|特别提示|市场综述|行情综述|涨停板.{0,12}(?:机会|风险)|放量.{0,8}(?:调整|长阴)|震荡筑底|两市.{0,12}(?:涨|跌|震荡)|A股.{0,12}(?:调整|收涨|收跌|走强|反弹)/;
const NON_VIEWPOINT_TEXT = /编辑\s*[｜|:：]|作者\s*[｜|:：]|执业证书编号|特别提示|免责声明|风险提示\s*[：:]|仅供.{0,30}参考|不构成.{0,20}建议|投资者适当性管理办法|本公众号发布的观点|客户参考|责任编辑|版权声明/;
const MARKET_RESULT_TEXT = /收涨|收跌|涨停|跌停|大涨|大跌|高开|低开|跳水|冲高回落|股价.{0,8}(?:上涨|下跌)|板块.{0,8}(?:上涨|下跌|走强|走弱)/;
const EXOGENOUS_CATALYST_TEXT = /政策|规划|通知|补贴|改革|订单|中标|签约|销售|出货|需求|量产|发布|突破|获批|投产|涨价|提价|减产|停产|短缺|收储|审评|医保|商保|关税|制裁|禁运/;

const THEME_IMPACT_TARGETS = [
  { pattern: /农业|种植|种业|粮食/, target: "种业、种植与农产品供需" },
  { pattern: /机器人/, target: "机器人本体、执行器、减速器等核心环节" },
  { pattern: /AI|人工智能|算力/, target: "算力基础设施、光模块、服务器及AI应用" },
  { pattern: /半导体/, target: "芯片设计、制造、设备与材料" },
  { pattern: /医药|医疗/, target: "创新药研发、审批、支付与商业化放量" },
  { pattern: /消费/, target: "零售、食品饮料、旅游等可选与必选消费" },
  { pattern: /军工|航天|航空/, target: "航空航天装备、卫星及军工配套" },
  { pattern: /有色|金属|材料/, target: "资源品价格、材料加工与下游需求" },
  { pattern: /油气|石油|原油/, target: "油气开采、炼化、储运及相关设备" },
  { pattern: /房地产|地产/, target: "地产销售、融资、开发及后周期产业链" },
  { pattern: /金融|券商|证券/, target: "券商、交易服务与金融科技业务" }
];

function cleanNewsText(value) {
  return String(value || "").replace(/<[^>]+>/g, " ").replace(/&nbsp;|&#160;/gi, " ").replace(/\s+/g, " ").trim();
}

function sanitizeNewsContent(value) {
  let text = String(value || "").replace(/<[^>]+>/g, " ").replace(/&nbsp;|&#160;/gi, " ");
  const cutoff = text.search(NON_VIEWPOINT_TEXT);
  if (cutoff >= 0) text = text.slice(0, cutoff);
  return cleanNewsText(text);
}

function isRecapArticle(article) {
  const title = cleanNewsText(article.title);
  if (RECAP_ARTICLE_TITLE.test(title)) return true;
  const lead = sanitizeNewsContent(article.content || article.summary || article.abstract).slice(0, 700);
  const recapTerms = lead.match(/今日市场|昨日市场|盘面|收盘|指数|成交额|上涨家数|下跌家数|涨停|跌停|资金流入|资金流出|板块轮动/g) || [];
  return recapTerms.length >= 5;
}

function parseNewsPublishDate(article) {
  const raw = article?.date ?? article?.publish_time ?? article?.publishTime
    ?? article?.publish_date ?? article?.publishDate ?? article?.datetime ?? article?.published_at;
  if (raw == null || raw === "") return null;
  const match = String(raw).trim().match(/(19|20)\d{2}[-/.年]?\d{1,2}[-/.月]?\d{1,2}/);
  if (!match) return null;
  const parts = match[0].match(/((?:19|20)\d{2})\D?(\d{1,2})\D?(\d{1,2})/);
  if (!parts) return null;
  const year = Number(parts[1]), month = Number(parts[2]), date = Number(parts[3]);
  const value = new Date(Date.UTC(year, month - 1, date));
  if (value.getUTCFullYear() !== year || value.getUTCMonth() !== month - 1 || value.getUTCDate() !== date) return null;
  const day = `${year}${String(month).padStart(2, "0")}${String(date).padStart(2, "0")}`;
  return { raw: String(raw), day };
}

function fallbackNewsWindowStart(day) {
  const match = String(day).match(/^(\d{4})(\d{2})(\d{2})$/);
  if (!match) return day;
  const value = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  return calendarOffset(day, value.getUTCDay() === 1 ? -3 : -1);
}

function newsFreshness(article, startDay, endDay) {
  const published = parseNewsPublishDate(article);
  if (!published) return { accepted: false, reason: "undated", published: null };
  if (published.day < startDay || published.day > endDay) return { accepted: false, reason: "stale", published };
  return { accepted: true, reason: null, published };
}

function inferThemeImpact(themeName, driverName, sentence, sentiment) {
  const target = THEME_IMPACT_TARGETS.find((item) => item.pattern.test(themeName))?.target || `${themeName}相关产业链`;
  const negative = sentiment === "negative";
  if (/审评|医保|商保|支付空间|获批/.test(sentence)) return `${negative ? "可能压制" : "可能缩短研发成果兑现周期并扩大可支付需求，改善"}${target}的商业化与盈利预期。`;
  if (/极端气候|极端天气|灾害/.test(sentence)) return `可能扰动供给和产量预期，改变${target}的价格弹性与库存价值。`;
  if (/重复使用火箭|卫星发射|商业航天/.test(sentence) && /突破|量产|首发|发射/.test(sentence)) return `可能降低发射成本或提高任务频次，带动${target}的订单与产业化预期。`;
  const impacts = {
    "政策支持": `${negative ? "可能削弱" : "可能增强"}${target}的政策确定性、资源投入和需求释放预期。`,
    "价格变化": `${negative ? "可能压低" : "可能抬升"}${target}的产品价格与盈利预期，同时需要关注上下游成本传导。`,
    "需求与订单": `${negative ? "可能削弱" : "可能提升"}${target}的订单、出货和收入兑现预期。`,
    "供给变化": `可能改变${target}的供需平衡、库存水平和价格弹性。`,
    "技术与产业进展": `${negative ? "可能延缓" : "可能加快"}${target}的量产、渗透率提升和商业化兑现。`,
    "业绩验证": `${negative ? "可能下修" : "可能上修"}${target}的盈利预测和估值中枢。`,
    "事件冲击": `可能通过供需扰动或风险溢价变化影响${target}的价格与交易预期。`
  };
  return impacts[driverName] || `可能改变${target}的基本面预期和资金关注度。`;
}

function newsCatalystSummary(article, themeName, rule = null) {
  const title = cleanNewsText(article.title);
  const content = sanitizeNewsContent(article.content || article.summary || article.abstract);
  const fullText = `${title} ${content}`;
  const keywords = [...new Set([themeName, ...(rule?.keywords || [])].filter(Boolean))];
  const articleKeywords = keywords.filter((keyword) => fullText.toLowerCase().includes(keyword.toLowerCase()));
  if (!articleKeywords.length) return null;
  const sentences = [title, ...content.split(/(?<=[。！？；!?;])|\n+/)].map(cleanNewsText).filter((text) => text.length >= 8 && !NON_VIEWPOINT_TEXT.test(text));
  const ranked = sentences.map((sentence, index) => {
    const sentenceKeywords = articleKeywords.filter((keyword) => sentence.toLowerCase().includes(keyword.toLowerCase()));
    const keywordHits = sentenceKeywords.length;
    const driverHits = NEWS_CATALYST_DRIVERS.filter((driver) => driver.pattern.test(sentence)).length;
    return { sentence, sentenceKeywords, score: keywordHits * 5 + driverHits * 4 + (index === 0 ? 1 : 0), keywordHits, driverHits };
  }).filter((entry) => entry.keywordHits > 0).sort((a, b) => b.score - a.score || b.sentence.length - a.sentence.length);
  const best = ranked[0];
  if (!best || (best.score < 9 && !fullText.includes(themeName))) return null;
  const driver = NEWS_CATALYST_DRIVERS.find((item) => item.pattern.test(best.sentence));
  if (!driver) return null;
  // 消息催化只保留对当前题材具有正向传导的观点。出现规避、减配、
  // 下调等明确负向表述时，即使题材当日下跌或句中另有“布局”等词也不展示。
  if (NEGATIVE_NEWS_VIEW.test(best.sentence)) return null;
  if (!POSITIVE_NEWS_VIEW.test(best.sentence)) return null;
  if (MARKET_RESULT_TEXT.test(best.sentence) && !EXOGENOUS_CATALYST_TEXT.test(best.sentence)) return null;
  if (themeName === "消费" && best.sentenceKeywords.every((keyword) => keyword === "消费")) return null;
  if (themeName === "金融科技" && best.sentenceKeywords.every((keyword) => keyword === "证券") && !/券商|金融科技|互联网金融|数字货币|证券公司|资本市场|交易制度/.test(best.sentence)) return null;
  const viewpoint = best.sentence.slice(0, 190) + (best.sentence.length > 190 ? "…" : "");
  const driverName = driver?.name || "直接题材催化";
  const mechanism = driver?.mechanism || "题材关注度与资金风险偏好";
  const sentiment = "positive";
  const impact = inferThemeImpact(themeName, driverName, best.sentence, sentiment);
  return {
    viewpoint,
    catalyst: `${driverName}：${viewpoint}`,
    impact,
    relation: `潜在影响：${impact}`,
    driver: driverName,
    mechanism,
    sentiment,
    matchedKeywords: best.sentenceKeywords.slice(0, 5),
    relevanceScore: Math.min(100, 55 + best.keywordHits * 10 + best.driverHits * 10)
  };
}

const GENERIC_NEWS_THEME_NAMES = new Set(["农业种植", "机器人", "AI算力", "半导体", "医药", "消费", "军工", "有色金属", "油气", "房地产", "金融科技", "人工智能", "AI"]);
function specificNewsBranchName(rule, catalyst, fallbackName) {
  if (!rule) return fallbackName;
  const candidates = (catalyst?.matchedKeywords || []).filter((keyword) => keyword && keyword !== rule.name && !GENERIC_NEWS_THEME_NAMES.has(keyword));
  return candidates.sort((a, b) => b.length - a.length)[0] || fallbackName;
}

function clamp(value, min = 0, max = 100) {
  return Math.min(max, Math.max(min, Number(value) || 0));
}

function localDate(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(date);
  const value = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${value.year}${value.month}${value.day}`;
}

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

async function windCall(serverType, toolName, params, timeoutMs = 35_000) {
  const cacheableMomentumCall = serverType === "index_data" && toolName === "get_index_technicals";
  const momentumCacheKey = cacheableMomentumCall ? `${serverType}:${toolName}:${JSON.stringify(params)}` : null;
  const cachedMomentum = momentumCacheKey ? themeMomentumCache.get(momentumCacheKey) : null;
  if (cachedMomentum && Date.now() - cachedMomentum.capturedAt < themeMomentumCacheTtlMs) return cachedMomentum.payload;
  const payload = unpackWind(await callWindTool(serverType, toolName, params, { timeoutMs }));
  if (momentumCacheKey) {
    payload._capturedAt = new Date().toISOString();
    themeMomentumCache.set(momentumCacheKey, { capturedAt: Date.now(), payload });
  }
  return payload;
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

function summedScalar(payload, matcher) {
  for (const table of tables(payload)) {
    const nameIndex = table.columns.findIndex((column) => matcher.test(column.name));
    if (nameIndex < 0 || !table.rows.length) continue;
    const values = table.rows.map((row) => Number(row[nameIndex])).filter(Number.isFinite);
    if (values.length) return values.reduce((sum, value) => sum + value, 0);
  }
  return null;
}

function percentileColumn(payload, matcher) {
  const values = [];
  for (const table of tables(payload)) {
    const valueIndex = table.columns.findIndex((column) => matcher.test(column.name));
    if (valueIndex < 0) continue;
    for (const row of table.rows) {
      const raw = row[valueIndex];
      if (raw == null || raw === "") continue;
      const value = Number(raw);
      if (Number.isFinite(value)) values.push(value);
    }
  }
  if (!values.length) return { value: null, sampleSize: 0, method: "median" };
  values.sort((a, b) => a - b);
  const mid = values.length >> 1;
  const value = values.length % 2 ? values[mid] : (values[mid - 1] + values[mid]) / 2;
  return { value, sampleSize: values.length, method: "median" };
}

function uniqueWindCodeCount(payload) {
  if (!payload) return null; // 调用失败（未返回表数据）才视为未知，真实 0 只返回 0。
  const codes = new Set();
  for (const table of tables(payload)) {
    const index = table.columns.findIndex((column) => column.name === "Wind代码");
    if (index < 0) continue;
    for (const row of table.rows) if (row[index]) codes.add(row[index]);
  }
  return codes.size;
}

function aggregatedStockCount(payload, matcher) {
  for (const table of tables(payload)) {
    const index = table.columns.findIndex((column) => matcher.test(String(column.name || "")));
    if (index < 0) continue;
    for (const row of table.rows) {
      const value = Number(row[index]);
      if (Number.isInteger(value) && value >= 0) return value;
    }
  }
  return null;
}

function fulfilled(result) { return result.status === "fulfilled" ? result.value : null; }
function reason(result) { return result.status === "rejected" ? String(result.reason?.message || result.reason) : null; }

async function runWindTasks(tasks) {
  const results = await Promise.allSettled(tasks.map((task) => task()));
  for (let index = 0; index < results.length; index += 1) {
    const message = reason(results[index]) || "";
    const empty = results[index].status === "fulfilled" && tables(results[index].value).length === 0;
    if (!empty && !/NETWORK_ERROR|ETIMEDOUT|ECONNRESET|ECONNREFUSED/.test(message)) continue;
    await new Promise((resolve) => setTimeout(resolve, 300));
    try {
      results[index] = { status: "fulfilled", value: await tasks[index]() };
    } catch (error) {
      results[index] = { status: "rejected", reason: error };
    }
  }
  return results;
}

async function runWindTasksInBatches(tasks, batchSize = 10) {
  const output = [];
  for (let index = 0; index < tasks.length; index += batchSize) {
    output.push(...await runWindTasks(tasks.slice(index, index + batchSize)));
  }
  return output;
}

function scoreBreadth(up, down) {
  const total = Number(up) + Number(down);
  return total ? clamp(Number(up) / total * 100) : 50;
}

function scoreLimit(limitUp, limitDown, bigUp, bigDown) {
  // 跌停权重 2.5（历史回测：对“涨停40/跌停20”这类负反馈不再给中性50分）
  const balance = (Number(limitUp) || 0) - (Number(limitDown) || 0) * 2.5;
  const tails = ((Number(bigUp) || 0) - (Number(bigDown) || 0)) / 12;
  return clamp(50 + balance / 2 + tails);
}

function scorePremium(premium) {
  // 不对称斜率（正 10 / 负 8，历史回测：负面日不再被过度惩罚到 30 以下）
  return premium != null && Number.isFinite(Number(premium))
    ? clamp(50 + Number(premium) * (Number(premium) >= 0 ? 10 : 8))
    : 50;
}

function scoreTheme(themes) {
  if (!themes.length) return 50;
  const first = Number(themes[0].changePct) || 0;
  const fifth = Number(themes[Math.min(4, themes.length - 1)].changePct) || 0;
  // 题材广度：头部强弱之外，还要看前 10 名中是普涨还是单点爆发，避免单一题材拉高分数。
  const ups = themes.filter((item) => (Number(item.changePct) || 0) > 0).length;
  const ratio = ups / themes.length;
  const breadthFactor = ratio >= 0.8 ? 8 : ratio >= 0.5 ? 3 : ratio < 0.3 ? -6 : 0;
  return clamp(42 + first * 4 + fifth * 2 + breadthFactor);
}

function scoreLadder(limitStocks, streakComplete = false) {
  if (!limitStocks || limitStocks.length === 0) return 30; // 无涨停 → 中性
  if (!streakComplete) return 30; // 连板历史缺失 → 中性（不罚不奖），避免把首板海啸误算成强梯队
  const metrics = limitLadderMetrics(limitStocks);
  const multiBoard = Object.entries(metrics.counts)
    .filter(([key]) => Number(key) >= 2).reduce((sum, [, count]) => sum + count, 0);
  // 连板梯队只衡量“连板质量”：高度 + 深度 + 连板家数。涨停总数属广度，由 breadth/limits 计分。
  let score = 20;
  if (metrics.maxStreak >= 3) score += Math.min(32, (metrics.maxStreak - 2) * 8);
  else if (metrics.maxStreak === 2) score += 4;
  if (metrics.contiguousDepth >= 2) score += Math.min(20, (metrics.contiguousDepth - 1) * 4);
  score += Math.min(14, multiBoard * 2);
  return clamp(score);
}

function scoreLiquidity(predictedAmount, historyTurnovers = []) {
  if (predictedAmount == null || !Number.isFinite(Number(predictedAmount))) return 50;
  const sorted = historyTurnovers.map((x) => Number(x.amount)).filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return 50;
  const rank = percentileRank(Number(predictedAmount), sorted);
  return scoreFromPercentile(rank);
}

function percentileRank(value, sortedArray) {
  if (!sortedArray.length) return 0.5;
  let lo = 0, hi = sortedArray.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (sortedArray[mid] < value) lo = mid + 1; else hi = mid;
  }
  return lo / sortedArray.length;
}

function scoreFromPercentile(rank) {
  const p = clamp(rank, 0, 1);
  if (p <= 0.1) return Math.round(20 + p / 0.1 * 10);
  if (p <= 0.3) return Math.round(30 + (p - 0.1) / 0.2 * 15);
  if (p <= 0.5) return Math.round(45 + (p - 0.3) / 0.2 * 15);
  if (p <= 0.7) return Math.round(60 + (p - 0.5) / 0.2 * 15);
  if (p <= 0.9) return Math.round(75 + (p - 0.7) / 0.2 * 15);
  return Math.round(90 + (p - 0.9) / 0.1 * 10);
}

// 状态机阈值：较热区间边界与「主升」所需的连续热区天数（今日前连续 ≥N 日，加今日合计 ≥N+1 日）。
const HOT_BOUNDARY = 70;
const MAIN_RISE_HOT_STREAK = 2;

function classify(score, metrics) {
  const dims = metrics?.dimensions || {};
  const upRatio = Number(metrics?.upRatio);
  const breadth = Number(dims.breadth);
  const liq = Number(dims.liquidity);
  const profit = Number(dims.profit);
  const changePct = Number(metrics?.changePct);
  const cont = metrics?.continuity || null;
  const has = (value) => Number.isFinite(value);

  // 情绪方向（用户观点：分歧/修复是方向词而非高度词）。
  // 对比基准优先昨日分，缺失时用近 5 日平均；|Δ| ≥ 6 分才算方向。
  let trend = null;
  if (cont) {
    const ref = has(cont.prevScore) ? cont.prevScore : has(cont.avg5) ? cont.avg5 : null;
    if (has(ref) && has(score)) {
      const delta = score - ref;
      trend = delta >= 6 ? "up" : delta <= -6 ? "down" : "flat";
    }
  }

  // ① 绝对强度：截面档位（仅命名基线，最终以方向修正为准）
  let base;
  if (score <= 28) base = { phase: "冰点", posture: "观望", tone: "cold", summary: "极端亏钱效应占优，等待风险释放收敛。" };
  else if (score <= 42) base = { phase: "退潮", posture: "防守", tone: "risk", summary: "负反馈仍在扩散，优先降低接力和追高暴露。" };
  else if (score <= 56) base = { phase: "分歧", posture: "精选", tone: "watch", summary: "多空反馈混杂，只跟踪辨识度最高的核心。" };
  else if (score <= 70) base = { phase: "修复", posture: "试错", tone: "repair", summary: "赚钱效应开始恢复，但仍需确认持续性。" };
  else if (score <= 86) base = { phase: "主升", posture: "进攻", tone: "hot", summary: "广度、涨停和溢价形成正反馈，关注主线扩散。" };
  else base = upRatio >= 70
    ? { phase: "高潮", posture: "去弱留强", tone: "peak", summary: "一致性处于高位，机会与次日分歧风险同时放大。" }
    : { phase: "主升", posture: "进攻", tone: "hot", summary: "强势集中在局部方向，避免把结构行情当作全面高潮。" };

  // 热区持续性：今日之前连续多少个交易日维持在较热区间（>HOT_BOUNDARY）
  // —— 主升必须靠“几天维持热区”确认，单日跳升只能算启动。
  let prevHotStreak = 0;
  if (cont && Array.isArray(cont.lastScores)) {
    for (let index = cont.lastScores.length - 1; index >= 0; index -= 1) {
      if (Number(cont.lastScores[index]) > HOT_BOUNDARY) prevHotStreak += 1; else break;
    }
  }
  const currentHot = score > HOT_BOUNDARY; // 70
  const sustainedHot = prevHotStreak >= MAIN_RISE_HOT_STREAK; // 今日前已连续多日热 → 加今日即连续 ≥MAIN+1 日

  // ② 方向 × 持续性修正：热→冷=分歧；热区（含横盘）=按连续热区天数给启动/主升；
  // 冷→温=修复；flat 且非热区保持截面档位。
  if (trend === "down") {
    if (score > HOT_BOUNDARY) {
      base = { phase: "分歧", posture: "精选", tone: "watch", summary: "情绪自高位回落，热度仍在但接力降温，进入分歧期，只做辨识度核心。" };
    } else if (base.phase === "修复") {
      base = { phase: "分歧", posture: "精选", tone: "watch", summary: "修复遇阻，情绪再度降温，按分歧对待，降低追高。" };
    } else if (score <= 42) {
      base = { phase: "退潮", posture: "防守", tone: "risk", summary: "情绪继续走低，退潮持续，等待亏钱效应收敛。" };
    }
  } else if (currentHot) {
    // 今日已在较热区间：连续热区达标 → 主升/高潮；否则属单日骤升 → 启动（无论今日涨跌）。
    if (sustainedHot) {
      base = score > HOT_BOUNDARY + 16 && upRatio >= 70
        ? { phase: "高潮", posture: "去弱留强", tone: "peak", summary: "情绪连续多日维持在较强区间且一致性极高，机会与次日分歧风险同时放大。" }
        : { phase: "主升", posture: "进攻", tone: "hot", summary: `情绪已连续 ${prevHotStreak + 1} 日维持在较热区间，赚钱效应持续扩散，进入主升，关注主线扩散与高标接力。` };
    } else {
      base = { phase: "启动", posture: "进攻", tone: "hot", summary: "情绪单日骤升进入较热区间，属行情启动而非主升，需连续热区确认，先跟随最强主线、控制单日追高。" };
    }
  } else if (trend === "up" && score <= 42) {
    base = { phase: "修复", posture: "试错", tone: "repair", summary: "情绪自冰点/退潮回升，广度与涨停开始修复，按反弹修复对待，先轻仓试错。" };
  } else if (trend === "up") {
    base = { phase: "修复", posture: "试错", tone: "repair", summary: "情绪自低位回暖、从分歧走向修复，赚钱效应正在恢复，关注持续确认。" };
  }

  // ③ 盈利确认否决：热区（趋势未知/横盘）分数靠涨停体量虚高时，仍降为修复
  if (score >= 70 && has(profit) && profit < 50 && trend !== "up") {
    return { phase: "修复", posture: "试错", tone: "repair", summary: "涨停人气与广度偏强，但昨日涨停今日无正溢价，追涨资金并不赚钱，属结构性修复而非主升，等赚钱效应确认。" };
  }

  // ④ 缩量 / 指数未共振（维持原有）
  if (score > 56 && has(liq) && liq < 30 && !(changePct > 0.2)) {
    return { phase: "分歧", posture: "精选", tone: "watch", summary: "涨停接力局部活跃，但成交显著缩量、指数未共振，属存量资金抱团，不按主升处理，只跟踪辨识度核心。" };
  }
  if (score > 70 && has(liq) && liq < 45 && changePct <= 0 && (!has(breadth) || breadth < 60)) {
    return { phase: "修复", posture: "试错", tone: "repair", summary: "涨停与溢价反馈偏强，但缩量、指数与广度未确认，按结构性修复对待，等待放量验证。" };
  }
  return base;
}

function normalizeThemes(payload) {
  return tables(payload).flatMap(objects).map((row) => ({
    code: row["Wind代码"],
    name: row["证券简称"],
    changePct: Number(Object.entries(row).find(([key]) => key.includes("涨跌幅"))?.[1]),
    tradeTime: row["交易时间"] || null
  })).filter((item) => item.code && item.name && Number.isFinite(item.changePct))
    .filter((item) => !/^\[(?:HK|US)\]/i.test(item.name))
    // 题材温度维度同样剔除风格类/资金流类指数（陆股通轻仓、成交主力、MSCI 等），
    // 否则“陆股通轻仓 +5.7%”这类非叙事指数会污染头部排名（与 anomaly 侧口径对齐）。
    .filter((item) => !NON_NARRATIVE_ANOMALY_PATTERN.test(item.name))
    .slice(0, 10);
}

const anomalyThemeName = (value) => String(value || "").replace(/^[[^]]+]/, "").replace(/(?:Wind)?(?:概念)?指数$|概念板块$|板块$|精选$/g, "").trim();
// 题材异动个股角色（领涨/龙头/中军/跟风/候选/点火展示）仅保留沪深主板与创业板：
// 上证 60xxxx、深证 000/001/002/003、创业板 300/301；排除科创板(688/689)与北交所(83/87/92/43号段)。
const isTradableRoleStock = (code) => /^(?:600\d{3}|601\d{3}|603\d{3}|605\d{3}|000\d{3}|001\d{3}|002\d{3}|003\d{3}|300\d{3}|301\d{3})$/.test(String(code).split(".")[0]);
const ANOMALY_MIN_SCORE = 60;
const LIMIT_THEME_MIN_STOCKS = 3;
const BATCH_SIGNAL_MIN_5M = 1.5;
const BATCH_SCORE_BASE = 45;
const BATCH_SCORE_PER_POINT = 8;
const ANOMALY_MAX_ITEMS = 12;
function weightedThemeScore(components, weights) {
  const active = Object.entries(weights).filter(([key]) => Number(components[key]) > 0);
  const weightTotal = active.reduce((sum, [, weight]) => sum + weight, 0);
  if (!weightTotal) return 0;
  return Math.round(clamp(active.reduce((sum, [key, weight]) => sum + components[key] * weight, 0) / weightTotal));
}

function limitLadderMetrics(stocks) {
  const counts = {};
  for (const stock of stocks) {
    const streak = Math.max(1, Number(stock.limitStreak) || 1);
    counts[streak] = (counts[streak] || 0) + 1;
  }
  const levels = new Set(Object.keys(counts).map(Number));
  const maxStreak = levels.size ? Math.max(...levels) : 0;
  let contiguousDepth = 0;
  while (levels.has(contiguousDepth + 1)) contiguousDepth += 1;
  const highBoardBonus = maxStreak >= 6 ? 8 : maxStreak === 5 ? 7 : maxStreak === 4 ? 5 : maxStreak === 3 ? 3 : 0;
  const ladderBonus = contiguousDepth >= 6 ? 6 : contiguousDepth === 5 ? 5 : contiguousDepth === 4 ? 4 : contiguousDepth === 3 ? 2 : 0;
  return { counts, maxStreak, contiguousDepth, highBoardBonus, ladderBonus, totalBonus: Math.min(14, highBoardBonus + ladderBonus) };
}

function allAnomalyScore(components, limitCount, resonanceBonus, ladderBonus = 0) {
  if (limitCount >= LIMIT_THEME_MIN_STOCKS) {
    const limitMainScore = 70 + Math.min(24, (limitCount - LIMIT_THEME_MIN_STOCKS) * 6);
    const batchBonus = components.batch > 0 ? 3 + Math.max(0, components.batch - 60) / 40 * 5 : 0;
    const newsBonus = components.news > 0 ? 2 + Math.max(0, components.news - 60) / 40 * 4 : 0;
    const crossSignalBonus = Math.min(2, resonanceBonus);
    return Math.round(clamp(limitMainScore + batchBonus + newsBonus + crossSignalBonus + ladderBonus));
  }
  const batchScore = components.batch > 0 ? 55 + components.batch * .17 : 0;
  const newsScore = components.news > 0 ? 55 + components.news * .17 : 0;
  const crossSignalBonus = components.batch > 0 && components.news > 0 ? 4 : 0;
  const nonLimitScore = Math.max(batchScore, newsScore) + crossSignalBonus + Math.min(2, resonanceBonus);
  // 非涨停驱动的题材上限从 74 放开到 82：普涨日涨停分散、单题材涨停<3 时，纯批量/消息题材也能上榜。
  return Math.round(clamp(Math.min(82, nonLimitScore) + ladderBonus));
}
// Specific families win before broader ones. Exclusions prevent shared words such
// as "消费" and "材料" from silently merging unrelated industries.
const ANOMALY_THEME_FAMILIES = [
  { id: "agriculture", name: "农业产业链", test: /中农发系|央企农业|农业农村部系|种植业|大豆|生物育种|一号文件|粮食|农机|农垦|种业|农业|猪产业|生猪|养殖|畜牧|禽产业|水产/, exclude: /农业银行|农商行|农业保险/ },
  { id: "robotics", name: "机器人产业链", test: /人形机器人|机器人|减速器|执行器|机器视觉|丝杠|关节|伺服系统/, business: /机器人|减速器|伺服|数控|自动化|智能装备|机械/ },
  { id: "semiconductor", name: "半导体产业链", test: /半导体|存储|HBM|芯片|集成电路|先进封装|晶圆|光刻|碳化硅|氮化镓|磷化铟/, business: /半导体|芯片|集成电路|封装|晶圆|光刻|电子元器件|微电子/ },
  { id: "aerospace-defense", name: "航空航天与军工", test: /商业航天|卫星|航天|航空发动机|低空经济|军工|国防|无人机/ },
  { id: "healthcare", name: "医药产业链", test: /医药|医疗|医院|创新药|CRO|CXO|ADC|中药|疫苗|医疗器械|生物制药|化学制药/ },
  { id: "power-grid", name: "电力与电网产业链", test: /电力设备|智能电网|电网|特高压|发电运营|核电|虚拟电厂|电力运营/ },
  { id: "new-energy", name: "新能源产业链", test: /光伏|风电|锂电|储能|新能源车|电动车|充电桩|固态电池|钠离子电池|氢能/ },
  { id: "automotive", name: "汽车智能化产业链", test: /华为汽车|汽车配件|智能驾驶|无人驾驶|汽车电子|车联网|汽车零部件|整车/ },
  { id: "ai-app", name: "AI应用与软件产业链", test: /^AI$|人工智能|AI应用|AI手机|AI穿戴|多模态|智能体|AIGC|大模型|数字经济|云计算|信创|AI软件/, business: /人工智能|大模型|AIGC|算法|机器学习|自然语言|计算机视觉|智能语音|软件|信息技术|云计算|数据服务|数字化|信息系统|智能体/ },
  { id: "compute-comm", name: "算力与通信产业链", test: /算力|AI算力|液冷|服务器|光通信|CPO|光模块|数据中心|高速铜连接|铜缆高速连接|5G|6G|射频|天线|毫米波|通信设备/, business: /服务器|数据中心|光模块|光通信|通信|射频|天线|交换机|路由器|算力|液冷|散热|温控|铜缆|网络设备/ },
  { id: "consumer-electronics", name: "消费电子产业链", test: /消费电子|TWS|PCB|智能穿戴|折叠屏|面板/, business: /消费电子|电子|耳机|可穿戴|智能穿戴|面板|显示|PCB|智能终端|声学|光学/ },
  { id: "nonferrous", name: "有色金属产业链", test: /有色|稀土|贵金属|黄金|白银|工业金属|铜矿|铝业/ },
  { id: "advanced-materials", name: "新材料产业链", test: /碳纤维|超导|新材料|超硬材料|金属非金属新材料/, exclude: /半导体材料|医药材料|建筑材料/ },
  { id: "consumer", name: "消费产业链", test: /白酒|啤酒|食品饮料|食品|饮料|零售|旅游|酒店|免税|家电|乳业|调味品|餐饮|百货|商贸|预制菜|宠物经济/, exclude: /消费电子|电子消费|消费建材|医药消费|医疗消费/ },
  { id: "finance", name: "金融科技与券商", test: /金融科技|证券|券商|保险|互金|支付|数字货币|稳定币|银行/ },
  { id: "property-infrastructure", name: "地产与基建产业链", test: /房地产|地产开发|物业管理|城市更新|建筑施工|基础设施|基建/ },
  { id: "energy", name: "传统能源产业链", test: /石油|天然气|油气|煤炭|页岩气|炼化/ }
];
const NON_NARRATIVE_ANOMALY_PATTERN = /^(?:TMT|大消费|新质生产力综合|三新|双循环|先进制造|老经济|新经济|资源股|成长|价值|质量|规模|均衡)$|(?:大|中|小|微)盘(?:成长|价值|均衡|风格|股)?|(?:大|中|小|微)市值(?:成长|价值|均衡)?|成长(?:风格|股|指数|精选)?$|价值(?:风格|股|指数|精选)?$|质量风格|规模风格|高盈利成长|低估值|高估值|蓝筹|白马|核心资产|茅指数|高贝塔|低贝塔|高波动|低波动|顺周期|逆周期|转融券|融资融券|场外期权|挂钩标的|证券公司.*业务|股权激励|全样本|样本池|样本|金股|券商推荐|机构推荐|超涨|超跌|市场情绪|情绪指数|打板|连板|首板|涨停|跌停|炸板|破板|一字板|反包|领涨|龙头|中军|补涨|跟风|竞价|抢筹|趋势股|突破股|放量股|缩量股|高开|低开|非.?ST|ST股|强势股|活跃股|高换手|低换手|高价股|低价股|微盘股|小盘股|大盘股|绩优股|亏损股|昨日|近\d+日|龙虎榜|陆股通|基金重仓|机构重仓|北向重仓|高股息|红利|低波|动量|等权|全A|百元股|次新股|解禁|破净|破发|风格指数|成交额|成交量|换手率|振幅|涨速|量比|市值|市盈率|市净率|排名|排行|榜单|股票池|精选组合|策略指数|因子指数|点位贡献|预增|预减|含可转债|可转债正股|行业龙头|地方国企|华为平台|举牌/i;
const VERIFIED_STANDALONE_THEME_PATTERN = /首发经济|两岸融合|一带一路|统一大市场|自贸区|自贸港|国企改革|供销社|乡村振兴|西部大开发|东北振兴|成渝特区|粤港澳大湾区|长三角|海洋经济|新型城镇化|设备更新|以旧换新|碳中和|碳交易|文化传媒|影视|院线|游戏|短剧|出版|教育产业|体育产业|物流|航运|港口|机场|铁路|轨道交通|水泥|玻璃|建筑材料|化工|化肥|农药|造纸|纺织|服装|工程机械|工业母机|机床|船舶|环保|水务|燃气|数据要素|网络安全|工业互联网|物联网/;
function anomalyFamily(name) {
  const value = String(name || "").trim();
  if (!value) return null;
  // 族名本身不一定命中自己的匹配式（如「汽车智能化」不在 automotive 的 test 里），
  // 但资讯反推出来的就是族名，必须能回到同一族，否则同一件事会被拆成两行
  const byLabel = ANOMALY_THEME_FAMILIES.find((rule) => {
    const label = rule.name.replace(/产业链$/, "");
    return (value === rule.name || value === label) && !rule.exclude?.test(value);
  });
  if (byLabel) return byLabel;
  return ANOMALY_THEME_FAMILIES.find((rule) => rule.test.test(value) && !rule.exclude?.test(value)) || null;
}
// 从新闻 / 主营文本反推题材族：仅用于 Wind「所属概念板块」为空的个股兜底
// 资讯署名与披露套话含「证券」，不剔除会把普通个股误判成券商题材
const NEWS_THEME_BOILERPLATE = /证券之星|证券时报|证券日报|证券代码|证券简称|证券交易所|证券营业部|证券公司|中国证券报|上海证券报|券商中国|证监会|中国人民银行|人民银行|银行间|银行卡|银行贷款|商业银行|银行理财/g;
export function detectThemeFamilies(text) {
  const source = String(text || "").replace(NEWS_THEME_BOILERPLATE, " ");
  if (source.length < 4) return [];
  const names = [];
  for (const family of ANOMALY_THEME_FAMILIES) {
    family.test.lastIndex = 0;
    if (!family.test.test(source)) continue;
    if (family.exclude) {
      family.exclude.lastIndex = 0;
      if (family.exclude.test(source)) continue;
    }
    names.push(family.name.replace(/产业链$/, ""));
  }
  return names;
}
// 中军主营校验：题材家族业务词表命中且不是「参股/持股」这类财务投资语境才算主营匹配。
// 目的：参股民营银行、参股券商一类的概念成分（如三一重工参股三湘银行）不应占据中军。
export function familyBusinessMatch(text, family) {
  const value = String(text || "");
  const rule = family?.business || family?.test;
  if (!value || !rule) return true;
  if (!rule.test(value) || family.exclude?.test(value)) return false;
  const clauses = value.split(/[。；;\n]/).filter(Boolean);
  return clauses.some((clause) => rule.test(clause) && !/参股|持股|股权|出资|发起设立|战略投资|财务投资/.test(clause));
}
function isEligibleNarrativeTheme(name) {
  const value = anomalyThemeName(name);
  if (!value || NON_NARRATIVE_ANOMALY_PATTERN.test(value)) return false;
  return Boolean(anomalyFamily(value) || VERIFIED_STANDALONE_THEME_PATTERN.test(value));
}
function selectPrimaryConcept(concepts, activeThemeNames, limitConceptCounts = new Map()) {
  const valid = concepts.filter(isEligibleNarrativeTheme);
  const active = activeThemeNames.map((name) => ({ name, family: anomalyFamily(name) }));
  return valid.map((name) => {
    const family = anomalyFamily(name);
    let score = 0;
    const peerLimitCount = Number(limitConceptCounts.get(name) || 0);
    if (peerLimitCount >= 2) score += (peerLimitCount - 1) * 180;
    if (active.some((item) => item.name === name)) score += 120;
    if (family && active.some((item) => item.family?.id === family.id)) score += 80;
    if (family) score += 35;
    if (name.length >= 3 && name.length <= 10) score += 12;
    if (/产业链|产业|行业|设备|材料|科技|农业|医药|汽车|机器人|半导体|消费|能源/.test(name)) score += 8;
    if (/系$/.test(name)) score -= 4;
    return { name, score, peerLimitCount };
  }).sort((a, b) => b.score - a.score || a.name.length - b.name.length)[0]?.name || null;
}

function limitConceptFrequency(stocks) {
  const counts = new Map();
  for (const stock of stocks) {
    const concepts = new Set((stock.concepts || []).filter(isEligibleNarrativeTheme));
    concepts.forEach((name) => counts.set(name, (counts.get(name) || 0) + 1));
  }
  return counts;
}
function mergeAnomalyThemes(items) {
  const groups = new Map();
  for (const item of items) {
    if (!isEligibleNarrativeTheme(item.name)) continue;
    const family = anomalyFamily(item.name);
    const key = family ? `family:${family.id}` : `single:${anomalyThemeName(item.name).toLowerCase()}`;
    if (!groups.has(key)) groups.set(key, {
      name: family?.name || item.name, code: family ? null : item.code, score: 0, signals: new Set(),
      shortMove: null, dayChange: null, tradeTime: null, limitStocks: [], news: [], branches: []
    });
    const group = groups.get(key);
    group.branches.push({ name: item.name, code: item.code, shortMove: item.shortMove, dayChange: item.dayChange, tradeTime: item.tradeTime });
    item.signals.forEach((signal) => group.signals.add(signal));
    item.limitStocks.forEach((stock) => { if (!group.limitStocks.some((entry) => entry.code === stock.code)) group.limitStocks.push(stock); });
    item.news.forEach((article) => {
      const familyImpact = family ? inferThemeImpact(family.name, article.driver, article.viewpoint || "", article.sentiment) : article.impact;
      const normalizedArticle = family ? { ...article, impact: familyImpact, relation: `潜在影响：${familyImpact}` } : article;
      if (!group.news.some((entry) => entry.title === normalizedArticle.title)) group.news.push(normalizedArticle);
    });
    if (item.shortMove != null && (group.shortMove == null || Math.abs(item.shortMove) > Math.abs(group.shortMove))) group.shortMove = item.shortMove;
    if (item.dayChange != null && (group.dayChange == null || item.dayChange > group.dayChange)) group.dayChange = item.dayChange;
    group.tradeTime = [group.tradeTime, item.tradeTime].filter(Boolean).sort().at(-1) || null;
  }
  return [...groups.values()].map((group) => ({ ...group, branches: [...new Map(group.branches.map((branch) => [branch.name, branch])).values()] }));
}
function anomalyRows(payload, mode) {
  const seen = new Set();
  return tables(payload).flatMap(objects).map((row) => mode === "theme" ? {
    code: row["Wind代码"], name: anomalyThemeName(row["证券简称"]),
    dayChange: Number(row["涨跌幅"]),
    shortMove: Number(row["近5分每分涨跌幅"] ?? row["近5分最大涨跌幅"]),
    tradeTime: row["交易时间"] || row["指标时间"] || null
  } : {
    code: row["Wind代码"], name: row["证券简称"], status: row["涨跌停状态"],
    tradeTime: row["交易时间"] || null, sealTime: row["涨跌停时间"] || row["涨停时间"] || null
  }).filter((x) => x.code && x.name && !/^\*?ST/i.test(x.name) && (mode === "theme" ? Number.isFinite(x.shortMove) && isEligibleNarrativeTheme(x.name) : !seen.has(x.code) && seen.add(x.code)))
    .sort((a, b) => mode === "theme" ? b.shortMove - a.shortMove : String(b.sealTime || b.tradeTime || "").localeCompare(String(a.sealTime || a.tradeTime || ""))).slice(0, mode === "theme" ? 50 : Number.MAX_SAFE_INTEGER);
}
function validatedIndexMomentumRow(payload, fallback, expectedDay) {
  const row = tables(payload).flatMap(objects)[0];
  if (!row) return null;
  const tradeTime = row["\u4ea4\u6613\u65f6\u95f4"] || row["\u6307\u6807\u65f6\u95f4"] || fallback.tradeTime || null;
  const tradeDay = String(tradeTime || "").replace(/\D/g, "").slice(0, 8);
  const shortMove = Number(row["5\u5206\u949f\u6da8\u8dcc\u5e45"]);
  if (!Number.isFinite(shortMove) || (expectedDay && tradeDay !== expectedDay)) return null;
  const dayChange = Number(row["\u6da8\u8dcc\u5e45"]);
  return {
    ...fallback,
    name: anomalyThemeName(row["\u4e2d\u6587\u7b80\u79f0"] || row["\u8bc1\u5238\u7b80\u79f0"] || fallback.name),
    shortMove,
    dayChange: Number.isFinite(dayChange) ? dayChange : null,
    tradeTime,
    momentumSource: "index_price_indicators.5m_change"
  };
}
async function validateThemeMomentum(candidates, day) {
  const indexes = "\u4e2d\u6587\u7b80\u79f0,\u6da8\u8dcc\u5e45,5\u5206\u949f\u6da8\u8dcc\u5e45,\u4ea4\u6613\u65f6\u95f4";
  const now = Date.now();
  const rows = [];
  const errors = [];
  const missing = candidates.filter((item) => {
    const cached = themeMomentumCache.get(item.code);
    if (!cached || cached.day !== day || now - cached.capturedAt >= themeMomentumCacheTtlMs) return true;
    rows.push({ ...item, ...cached.row });
    return false;
  });
  const results = await runWindTasksInBatches(missing.map((item) => () => windCall(
    "index_data",
    "get_index_price_indicators",
    { windcode: item.code, indexes },
    12_000
  )), 12);
  missing.forEach((item, index) => {
    const result = results[index];
    const validated = result?.status === "fulfilled" ? validatedIndexMomentumRow(result.value, item, day) : null;
    if (validated) {
      rows.push(validated);
      themeMomentumCache.set(item.code, { day, capturedAt: now, row: validated });
    }
    else errors.push(`${item.code}: ${reason(result) || "missing_or_stale_5m_change"}`);
  });
  return { rows, errors, candidateCount: candidates.length, validatedCount: rows.length, requestedCount: missing.length, cacheHitCount: candidates.length - missing.length };
}
function quoteMinuteStamp(value) {
  const matched = String(value || "").match(/(\d{4})\D?(\d{2})\D?(\d{2})\D+(\d{2}):(\d{2})(?::(\d{2}))?/);
  if (!matched) return null;
  return Date.UTC(Number(matched[1]), Number(matched[2]) - 1, Number(matched[3]), Number(matched[4]), Number(matched[5]), Number(matched[6] || 0));
}

function quoteDateKey(value) {
  const matched = String(value || "").match(/(\d{4})\D?(\d{2})\D?(\d{2})/);
  return matched ? `${matched[1]}${matched[2]}${matched[3]}` : null;
}

function localThemeMomentumRows(payload) {
  const seen = new Set();
  const rawRows = tables(payload).flatMap(objects);
  let pricePairCount = 0;
  let exactTimeCount = 0;
  let inferredTimeCount = 0;
  const capturedAt = payload?._capturedAt || new Date().toISOString();
  const capturedStamp = Date.parse(capturedAt);
  const rows = rawRows.map((row) => {
    const currentPrice = Number(row["最新价格"] ?? row["最新成交价"]);
    const previousPrice = Number(row["5分前价格"]);
    const sourceTradeTime = row["最新价格.交易时间"] || row["最新交易时间"] || row["交易时间"] || null;
    const sourcePreviousTime = row["5分前价格.交易时间"] || row["5分前交易时间"] || null;
    const currentStamp = quoteMinuteStamp(sourceTradeTime);
    const previousStamp = quoteMinuteStamp(sourcePreviousTime);
    const elapsedMinutes = currentStamp != null && previousStamp != null ? (currentStamp - previousStamp) / 60_000 : null;
    const pricesValid = Number.isFinite(currentPrice) && currentPrice > 0 && Number.isFinite(previousPrice) && previousPrice > 0;
    if (pricesValid) pricePairCount += 1;
    const exactTime = Number.isFinite(elapsedMinutes) && elapsedMinutes >= 4 && elapsedMinutes <= 6.5;
    const dateOnlyTime = currentStamp == null && previousStamp == null
      && quoteDateKey(sourceTradeTime) != null && quoteDateKey(sourceTradeTime) === quoteDateKey(sourcePreviousTime);
    if (pricesValid && exactTime) exactTimeCount += 1;
    if (pricesValid && dateOnlyTime) inferredTimeCount += 1;
    const validPair = pricesValid && (exactTime || dateOnlyTime);
    const tradeTime = exactTime ? sourceTradeTime : validPair ? capturedAt : sourceTradeTime;
    const previousTime = exactTime ? sourcePreviousTime : validPair && Number.isFinite(capturedStamp) ? new Date(capturedStamp - 300_000).toISOString() : sourcePreviousTime;
    return {
      code: row["Wind代码"],
      name: anomalyThemeName(row["证券简称"] || row["中文简称"]),
      dayChange: null,
      shortMove: validPair ? Math.round((currentPrice / previousPrice - 1) * 10_000) / 100 : null,
      tradeTime,
      previousTime,
      currentPrice: validPair ? currentPrice : null,
      previousPrice: validPair ? previousPrice : null,
      momentumSource: "wind_current_price_vs_5m_ago_price"
    };
  }).filter((item) => item.code && item.name && item.shortMove != null && !seen.has(item.code) && seen.add(item.code)
    && !NON_NARRATIVE_ANOMALY_PATTERN.test(item.name))
    .sort((a, b) => b.shortMove - a.shortMove).slice(0, 50);
  return { rows, diagnostics: { rawCount: rawRows.length, pricePairCount, exactTimeCount, inferredTimeCount } };
}
function windCodeSet(payload) {
  const codes = new Set();
  for (const row of tables(payload).flatMap(objects)) {
    const code = row["Wind代码"];
    if (code) codes.add(code);
  }
  return codes;
}
function limitStreakLabel(streak) {
  return Number(streak) >= 2 ? `${Number(streak)}连板` : "首板";
}
function calendarOffset(day, offsetDays) {
  const date = new Date(Date.UTC(Number(day.slice(0, 4)), Number(day.slice(4, 6)) - 1, Number(day.slice(6, 8)) + offsetDays));
  return date.toISOString().slice(0, 10).replaceAll("-", "");
}
function recentTradingDates(payload, day, count = 5) {
  return [...new Set(tables(payload).flatMap(objects).map((row) => String(row.TIME || row["日期"] || "").replace(/\D/g, "").slice(0, 8))
    .filter((value) => value.length === 8 && value < day))].sort().slice(-count).reverse();
}
async function loadLimitHistory(day) {
  if (cachedLimitHistory?.day === day) return cachedLimitHistory;
  const errors = [];
  let calendarPayload = null;
  try {
    calendarPayload = await windCall("index_data", "get_index_kline", { windcode: "881001.WI", begin_date: calendarOffset(day, -15), end_date: day });
  } catch (error) {
    errors.push(`交易日历: ${String(error?.message || error)}`);
  }
  const dates = recentTradingDates(calendarPayload, day, 5);
  if (dates.length < 5) errors.push(`交易日历仅返回${dates.length}个历史交易日`);
  const sets = [];
  for (const date of dates) {
    let codes = new Set();
    let lastError = null;
    for (let attempt = 0; attempt < 3 && codes.size === 0; attempt += 1) {
      try {
        const payload = await windCall("stock_data", "search_stocks", { question: `筛选${date}收盘价等于当日涨停价的沪深A股` });
        codes = windCodeSet(payload);
        lastError = null;
      } catch (error) {
        lastError = String(error?.message || error);
      }
      if (codes.size === 0 && attempt < 2) await new Promise((resolve) => setTimeout(resolve, 300));
    }
    if (lastError) errors.push(`${date}涨停名单: ${lastError}`);
    sets.push(codes);
  }
  const output = { day, dates, sets, complete: errors.length === 0 && sets.length === 5, errors };
  if (output.complete) cachedLimitHistory = output;
  return output;
}

async function previousTradingDate(day) {
  if (cachedPreviousTradingDate?.day === day) return cachedPreviousTradingDate.date;
  const historyDate = cachedLimitHistory?.day === day ? cachedLimitHistory.dates?.[0] : null;
  if (historyDate) {
    cachedPreviousTradingDate = { day, date: historyDate };
    return historyDate;
  }
  const payload = await windCall("index_data", "get_index_kline", {
    windcode: "881001.WI",
    begin_date: calendarOffset(day, -15),
    end_date: day
  });
  const date = recentTradingDates(payload, day, 1)[0] || null;
  cachedPreviousTradingDate = { day, date };
  return date;
}
async function loadLiquidityHistory(day) {
  if (cachedLiquidityHistory?.day === day && cachedLiquidityHistory.turnovers.length >= 10) return cachedLiquidityHistory;
  try {
    const payload = await windCall("index_data", "get_index_kline", {
      windcode: "881001.WI",
      begin_date: calendarOffset(day, -60),
      end_date: calendarOffset(day, -1)
    });
    const turnovers = tables(payload).flatMap(objects)
      .map((row) => {
        const date = String(row.TIME || "").replace(/\D/g, "").slice(0, 8);
        const amount = Number(row.TURNOVER ?? row["成交额"] ?? row.Amount ?? row.amount);
        return { date, amount };
      })
      .filter((x) => x.date && x.date.length === 8 && Number.isFinite(x.amount) && x.amount > 0 && x.date < day);
    const output = { day, turnovers };
    if (turnovers.length >= 10) cachedLiquidityHistory = output;
    return output;
  } catch (error) {
    return { day, turnovers: [], error: String(error?.message || error) };
  }
}

// A 股成交节奏模板（U 型：开盘/尾盘放量、午盘缩量），键为当日分钟数（570 = 9:30）。
// 值为该时点累计成交占全天比例的经验近似，用于盘中外推全天成交额。
const TURNOVER_PROFILE = [
  [570, 0.18], [600, 0.28], [630, 0.35], [660, 0.42], [690, 0.53],
  [780, 0.56], [810, 0.64], [840, 0.73], [870, 0.83], [900, 1.00]
];
function cumulativeTurnoverShare(minute) {
  if (minute < 570) return 0.05;
  if (minute >= 900) return 1;
  let i = 0;
  while (i < TURNOVER_PROFILE.length - 1 && TURNOVER_PROFILE[i + 1][0] <= minute) i += 1;
  const [t0, s0] = TURNOVER_PROFILE[i];
  const [t1, s1] = TURNOVER_PROFILE[i + 1];
  return s0 + (s1 - s0) * (minute - t0) / (t1 - t0);
}

function predictFullDayAmount(currentAmount, tradeTimeStr) {
  if (currentAmount == null || !Number.isFinite(Number(currentAmount))) return null;
  const m = String(tradeTimeStr || "").match(/(\d{2}):(\d{2})/);
  const nowMin = m ? Number(m[1]) * 60 + Number(m[2]) : null;
  if (nowMin == null) return Number(currentAmount);
  if (nowMin < 570) return Number(currentAmount) * 20; // 未开盘，按 5% 累计占比外推
  if (nowMin >= 900) return Number(currentAmount);
  return Number(currentAmount) / cumulativeTurnoverShare(nowMin);
}

const NON_BUSINESS_CONCEPT_PATTERN = /全部A股|全A|基金重仓|陆股通|等权|动量|小市值|小盘股|微盘股|大盘股|私募重仓|融资融券|深股通|沪股通|QFII|综合$|可转债正股|标普道琼斯|MSCI|富时罗素|成交主力|贷款回购|股票回购|保底增持|近期减持|股权激励|员工持股|预增|预减|业绩预|国资$/;
function conceptNamesFromValue(value) {
  return [...new Set(String(value || "").split(/[;；]/).map(anomalyThemeName)
    .filter((name) => name && !NON_BUSINESS_CONCEPT_PATTERN.test(name) && isEligibleNarrativeTheme(name)))];
}
function conceptsOf(payload) {
  return [...new Set(tables(payload).flatMap(objects).flatMap((row) => conceptNamesFromValue(row["所属概念板块"])))];
}
async function enrichLimitStocks(day, stocks) {
  const missing = stocks.filter((x) => !conceptMembershipCache.has(`${day}:${x.code}`));
  const results = missing.length ? await runWindTasksInBatches(missing.map((x) => () => windCall("analytics_data", "get_financial_data", { question: `${x.code}所属概念板块` }, 12_000)), 12) : [];
  missing.forEach((x, i) => conceptMembershipCache.set(`${day}:${x.code}`, conceptsOf(fulfilled(results[i]))));
  return stocks.map((x) => ({ ...x, concepts: conceptMembershipCache.get(`${day}:${x.code}`) || [] }));
}
function constituentRows(payload, expectedDay = null) {
  return tables(payload).flatMap(objects).map((row) => {
    const findNumber = (...names) => {
      for (const name of names) {
        const entry = Object.entries(row).find(([key]) => key === name || key.includes(name));
        if (entry && Number.isFinite(Number(entry[1]))) return Number(entry[1]);
      }
      return null;
    };
    const tradeTime = row["交易时间"] || row["今日交易时间"] || row["指标时间"] || row["日期"] || null;
    return {
      code: row["Wind代码"], name: row["证券简称"],
      changePct: findNumber("涨跌幅"), amount: findNumber("成交额"),
      turnover: findNumber("换手率"), volumeRatio: findNumber("量比"),
      price: findNumber("最新成交价", "今日最新价", "成交价"), open: findNumber("今日开盘价", "开盘价"),
      high: findNumber("今日最高价", "最高价"), low: findNumber("今日最低价", "最低价"), tradeTime,
      concepts: conceptNamesFromValue(row["所属概念板块"]),
      mcap: findNumber("总市值", "市值")
    };
  }).filter((x) => x.code && x.name && Number.isFinite(x.changePct)
    && (!expectedDay || String(x.tradeTime || "").replace(/\D/g, "").startsWith(expectedDay)));
}
function normalizedThemeToken(value) {
  return anomalyThemeName(value).replace(/产业链|产业|概念|主题|板块|精选|相关/g, "").replace(/[^\p{L}\p{N}]+/gu, "").toLowerCase();
}
function exactConceptOverlap(concept, branchName) {
  const conceptToken = normalizedThemeToken(concept), branchToken = normalizedThemeToken(branchName);
  if (conceptToken.length < 2 || branchToken.length < 2) return false;
  if (/^(?:消费|材料|能源|科技|汽车|农业|医药|金融|证券|AI|TMT)$/i.test(branchToken)) return conceptToken === branchToken;
  return conceptToken === branchToken || conceptToken.includes(branchToken) || (conceptToken.length >= 3 && branchToken.includes(conceptToken));
}
function articleText(article) {
  return `${cleanNewsText(article?.title)} ${sanitizeNewsContent(article?.content || article?.summary || article?.abstract)}`;
}
function candidateNewsEvidence(stock, branches, news) {
  for (const article of news || []) {
    const text = articleText(article);
    if (!text.includes(stock.name) && !text.includes(stock.code)) continue;
    const matchedBranch = branches.find((branch) => {
      const token = normalizedThemeToken(branch);
      return token.length >= 2 && text.toLowerCase().includes(token);
    });
    if (matchedBranch) return { branch: matchedBranch, title: cleanNewsText(article.title) };
  }
  return null;
}
function candidateThemeEvidence(theme, row, news, investmentLogic = "") {
  const branches = row.candidateBranches?.length ? row.candidateBranches : (theme.branches || []).map((branch) => branch.name);
  const exactConcepts = row.concepts.filter((concept) => branches.some((branch) => exactConceptOverlap(concept, branch)));
  if (exactConcepts.length) return { accepted: true, level: "exact_concept", evidence: `精确概念：${exactConcepts.slice(0, 3).join("、")}` };
  const newsHit = candidateNewsEvidence(row, branches, news);
  if (newsHit) return { accepted: true, level: "stock_news", evidence: `当日催化：${newsHit.branch} · ${newsHit.title}` };
  const newsOnly = theme.signals.length === 1 && theme.signals[0] === "news";
  if (newsOnly) return { accepted: false, level: "unverified_news_theme", evidence: "新闻型题材缺少个股概念重合或当日催化" };
  const exactBusinessBranch = branches.find((branch) => {
    const token = normalizedThemeToken(branch);
    return token.length >= 2 && String(investmentLogic).toLowerCase().includes(token);
  });
  if (exactBusinessBranch) return { accepted: true, level: "business_exact", evidence: `主营/投资逻辑命中：${exactBusinessBranch}` };
  const themeFamily = anomalyFamily(theme.name) || branches.map(anomalyFamily).find(Boolean);
  const familyConcepts = themeFamily ? row.concepts.filter((concept) => anomalyFamily(concept)?.id === themeFamily.id) : [];
  if (familyConcepts.length) return { accepted: true, level: "family_concept", evidence: `同产业链概念：${familyConcepts.slice(0, 3).join("、")}` };
  if (themeFamily && themeFamily.test.test(String(investmentLogic)) && !themeFamily.exclude?.test(String(investmentLogic))) {
    return { accepted: true, level: "business_family", evidence: `主营/投资逻辑支持：${themeFamily.name}` };
  }
  return { accepted: false, level: "unrelated", evidence: "未找到概念、主营或当日催化证据" };
}
function investmentLogicText(payload) {
  return tables(payload).flatMap(objects).flatMap((row) => Object.values(row)).filter((value) => value != null).join(" ");
}
async function loadInvestmentLogic(day, stock) {
  const key = `${day}:${stock.code}`;
  if (investmentLogicCache.has(key)) return investmentLogicCache.get(key);
  const payload = await windCall("stock_data", "get_stock_basicinfo", { question: `${stock.code}公司主营业务和核心产品` }, 12_000);
  const text = investmentLogicText(payload);
  investmentLogicCache.set(key, text);
  return text;
}
async function loadStockCatalyst(day, stock) {
  const branches = stock.candidateBranches || [];
  const key = `${day}:${stock.code}:${branches.join("|")}`;
  if (stockCatalystCache.has(key)) return stockCatalystCache.get(key);
  const payload = await windCall("financial_docs", "get_financial_news", {
    query: `${day}${stock.name}${branches.slice(0, 2).join("、")}上涨原因投资逻辑`, top_k: 5
  }, 12_000);
  const items = payload?.data?.items || payload?.data?.data?.items || [];
  stockCatalystCache.set(key, items);
  return items;
}
async function loadCandidateSupplement(day, stock) {
  const [logicResult, newsResult] = await Promise.allSettled([loadInvestmentLogic(day, stock), loadStockCatalyst(day, stock)]);
  return {
    investmentLogic: logicResult.status === "fulfilled" ? logicResult.value : "",
    stockNews: newsResult.status === "fulfilled" ? newsResult.value : [],
    errors: [logicResult, newsResult].filter((result) => result.status === "rejected").map((result) => String(result.reason?.message || result.reason))
  };
}
function stockRoleLayers(theme, rows, options = {}) {
  const midBlocked = options.midBlocked || new Set();
  const ignitionCodes = new Set(theme.limitStocks.map((x) => x.code));
  const usable = rows.filter((x) => !ignitionCodes.has(x.code) && isTradableRoleStock(x.code) && x.changePct < 9.5);

  // 核心梯队：领涨 / 龙头 / 中军（各一只，互不重叠，并从前序列表排除避免重复展示）
  // 领涨 = 最先涨停或率先带动题材：从点火（涨停，仅沪深主板/创业板）股里按封板时间
  // 最早（sealTime）选取；无封板时间时以连板高度优先（更早启动的既有空间板视为率先带动）。
  const ignitionTradable = (theme.limitStocks || []).filter((x) => isTradableRoleStock(x.code));
  // 点火股行本身不含涨跌幅：先看成分股序列是否已有实值；否则标记 pctFallback，
  // 由 enrichThemeCandidates 批量向行情接口补查精确涨跌幅（不再统一按 10%/20% 拍脑袋）。
  const leadPrecise = (stock) => {
    const hit = rows.find((r) => r.code === (stock && stock.code));
    if (hit && Number.isFinite(hit.changePct)) return { pct: hit.changePct, precise: true };
    const prefix = String(stock && stock.code).split(".")[0];
    return { pct: /^3\d{5}/.test(prefix) ? 20 : 10, precise: false };
  };
  const leadRaw = [...ignitionTradable].sort((a, b) => {
    const ta = String(a.sealTime || "");
    const tb = String(b.sealTime || "");
    if (ta && tb && ta !== tb) return ta.localeCompare(tb);
    return (Number(b.limitStreak) || 1) - (Number(a.limitStreak) || 1);
  })[0];
  const leadInfo = leadRaw ? leadPrecise(leadRaw) : null;
  const lead = leadRaw ? [{ ...leadRaw, changePct: leadInfo.pct, pctFallback: !leadInfo.precise, role: "领涨", roleLabel: "领涨", markLimit: true, reason: "当日率先封板/最先涨停，带动题材点火" }] : [];
  const leadCodes = new Set(lead.map((x) => x.code));

  // 龙头 = 业务相关性最高且涨幅较大：从全部成分股（含涨停，排除已选领涨）中，
  // 以题材归属强度（分支涨停/涨3%+家数，即业务与主题契合度）为主、涨幅为辅综合排序。
  const leaderRow = rows.filter((x) => !leadCodes.has(x.code) && isTradableRoleStock(x.code)).map((x) => {
    const attr = candidateAttributionScore(theme, x);
    return { x, combo: attr.score + (Number(x.changePct) || 0) * 5 };
  }).sort((a, b) => b.combo - a.combo)[0];
  const leader = leaderRow ? [{ ...leaderRow.x, role: "龙头", roleLabel: "龙头", reason: "题材业务契合度最高且涨幅居前，板块辨识度核心" }] : [];
  const leaderCodes = new Set(leader.map((x) => x.code));

  // 中军 = 板块内体量/跟随担当：优先按「成交额分位 + 总市值分位」双因素取最优；
  // 成分股量价字段缺失时，取题材内涨幅中位的标的兜底（跟随主线主力），避免空字段假断言。
  let mid = [];
  const midCandidates = usable.filter((x) => !leadCodes.has(x.code) && !leaderCodes.has(x.code) && !midBlocked.has(x.code));
  if (midCandidates.length) {
    const hasNumeric = midCandidates.some((x) => (Number.isFinite(x.amount) && x.amount > 0) || (Number.isFinite(x.mcap) && x.mcap > 0));
    if (hasNumeric) {
      const byAmount = [...midCandidates].sort((a, b) => (b.amount || 0) - (a.amount || 0));
      const byMcap = [...midCandidates].sort((a, b) => (Number(b.mcap) || 0) - (Number(a.mcap) || 0));
      const bestMid = midCandidates.map((x) => {
        const aRank = byAmount.length ? byAmount.indexOf(x) / byAmount.length : 1;
        const hasMcap = midCandidates.some((y) => Number.isFinite(y.mcap) && y.mcap > 0);
        const mRank = hasMcap && byMcap.length ? byMcap.indexOf(x) / byMcap.length : aRank;
        return { x, combo: (aRank + mRank) / 2, aRank };
      }).sort((a, b) => a.combo - b.combo || a.aRank - b.aRank)[0];
      const aRank = bestMid.aRank;
      mid = [{ ...bestMid.x, role: "中军", roleLabel: "中军",
        reason: `成交额${aRank <= 0.3 ? "居前" : "活跃"}·承接主线的中大市值方向` }];
    } else {
      const byGainMid = midCandidates.slice().sort((a, b) => (a.changePct || 0) - (b.changePct || 0));
      mid = [{ ...byGainMid[Math.floor(byGainMid.length / 2)], role: "中军", roleLabel: "中军", reason: "成分股量价字段暂缺，按题材内中游涨幅兜底（跟随主线主力）" }];
    }
  }
  const midCodes = new Set(mid.map((x) => x.code));

  const coreExcluded = new Set([...leadCodes, ...leaderCodes, ...midCodes]);
  const followers = usable.filter((x) => !coreExcluded.has(x.code) && x.changePct >= 3)
    .sort((a, b) => b.changePct - a.changePct || (b.amount || 0) - (a.amount || 0)).slice(0, 3)
    .map((x) => ({ ...x, role: "跟风", reason: x.themeEvidence || "题材归属已经二次校验" }));

  // 候选上车 = “后续更有上涨潜力”而非“当日涨幅最大”：
  // 1) 只看涨幅适中（2.5%~5.5% 且未涨停）——已大涨/涨停的兑现充分，不适合上车；
  // 2) 结构性排除已入选核心梯队/跟风的股票，角色之间不再重合；
  // 3) 评分=题材归属强度（分支涨停数/涨幅≥3%家数）+ 温和涨幅 + 量能适中放大 +
  //    换手活跃 + 成交活跃 + 题材分钟动能为正。
  const followerCodes = new Set(followers.map((x) => x.code));
  const rideable = usable.filter((x) => x.changePct >= 2.5 && x.changePct < 5.5
      && !coreExcluded.has(x.code) && !followerCodes.has(x.code))
    .map((x) => {
      const attr = candidateAttributionScore(theme, x);
      const attrBonus = Math.min(30, attr.score / 15);
      const changeBonus = Math.min(20, (x.changePct || 0) * 3);
      const volumeRatio = Number(x.volumeRatio || 1);
      const volBonus = volumeRatio >= 1.2 && volumeRatio <= 3 ? 12 : volumeRatio > 3 ? 5 : 4;
      const turnover = Number(x.turnover) || 0;
      const turnBonus = turnover >= 2 && turnover <= 10 ? 10 : Math.min(5, turnover);
      const liqBonus = Math.min(12, Math.log10(Math.max(x.amount || 1, 1)) * 1.6);
      const momentumBonus = Number(theme.shortMove) > 0 ? 6 : 0;
      return {
        ...x,
        candidateScore: Math.round(clamp(attrBonus + changeBonus + volBonus + turnBonus + liqBonus + momentumBonus)),
        attrBranch: attr.branch,
        attrBranchLimitCount: attr.branchLimitCount,
        attrBranchAdvanceCount: attr.branchAdvanceCount
      };
    }).sort((a, b) => b.candidateScore - a.candidateScore || (b.amount || 0) - (a.amount || 0)).slice(0, 2)
    .map((x) => {
      const volumeTrigger = Math.max(1.2, Math.min(2, Number(x.volumeRatio || 1) * 1.1));
      const nearHigh = x.high != null ? x.high * 0.995 : null;
      const fallbackTriggerPct = Math.min(9, Math.max(2.5, x.changePct + 0.8));
      const fallbackInvalidPct = Math.max(0.5, x.changePct - 3);
      const trigger = nearHigh != null
        ? `最新价站上${nearHigh.toFixed(2)}（日内高点附近），量比达到${volumeTrigger.toFixed(1)}以上，且题材5分钟动能为正`
        : `涨幅进一步达到${fallbackTriggerPct.toFixed(1)}%并放量，且题材5分钟动能为正`;
      const invalidationPrice = x.open != null && x.low != null ? Math.max(x.open, x.low) : x.open ?? x.low;
      const invalidation = invalidationPrice != null
        ? `跌破${invalidationPrice.toFixed(2)}（开盘价/日内低点防线），或题材5分钟动能转负且个股同步回落`
        : `涨幅回落至${fallbackInvalidPct.toFixed(1)}%以下，或题材5分钟动能转负且个股同步回落`;
      return { ...x, role: "候选上车", trigger, invalidation };
    });
  return { followers, rideable, lead, leader, mid };
}
function candidateAttributionScore(theme, row) {
  const exactStats = (row.branchStats || []).filter((stat) => row.concepts.some((concept) => exactConceptOverlap(concept, stat.name)));
  const best = exactStats.sort((a, b) => b.limitCount - a.limitCount || b.advanceCount - a.advanceCount || a.rank - b.rank)[0]
    || { name: row.candidateBranches?.[0] || theme.name, limitCount: 0, advanceCount: 0, rank: 99 };
  const score = best.limitCount * 100 + best.advanceCount * 5 + Math.max(0, 11 - best.rank)
    + (theme.limitStocks?.length || 0) * 8 + (theme.signals?.includes("batch") ? 20 : 0) + (theme.signals?.includes("news") ? 15 : 0);
  return { score, branch: best.name, branchLimitCount: best.limitCount, branchAdvanceCount: best.advanceCount, branchRank: best.rank };
}
// 中军主营校验（方案B）：中军若仅靠概念归属入选（尤其「参股民营银行」这类财务投资分支），
// 用公司主营文本复核：与题材家族业务词表不匹配则降级（交给跟风/候选层），并重新选中军。
// 取数失败时保留原中军，避免一次 Wind 抖动把核心梯队打空。
async function verifyMidBusiness(day, outputs) {
  let pending = outputs.map((entry) => {
    const family = anomalyFamily(entry.item.name)
      || (entry.item.branches || []).map((branch) => anomalyFamily(branch.name)).find(Boolean);
    const candidate = entry.out.mid?.[0];
    if (!family || !candidate) return null;
    if (/^business_/.test(String(candidate.themeEvidenceLevel || ""))) return null;
    return { entry, family, blocked: new Set() };
  }).filter(Boolean);

  for (let round = 0; round < 3 && pending.length; round += 1) {
    const checks = pending
      .map((state) => ({ state, candidate: state.entry.out.mid?.[0] }))
      .filter((check) => check.candidate);
    if (!checks.length) break;
    const results = await runWindTasksInBatches(checks.map(({ candidate }) => () => loadInvestmentLogic(day, candidate)), 3);
    const retry = [];
    checks.forEach(({ state, candidate }, index) => {
      const result = results[index];
      if (!result || result.status === "rejected") return; // 取数失败保留原中军
      if (familyBusinessMatch(result.value, state.family)) return;
      if (process.env.SE_DEBUG_MID) console.log(`[mid-check] ${state.entry.item.name} 降级 ${candidate.name} 主营=${String(result.value).slice(0, 60)}`);
      state.blocked.add(candidate.code);
      const layers = stockRoleLayers(state.entry.item, state.entry.attributedRows, { midBlocked: state.blocked });
      state.entry.out = { ...state.entry.out, ...layers };
      retry.push(state);
    });
    pending = retry;
  }
}

async function enrichThemeCandidates(day, items, marketNews = []) {
  const targets = items;
  const jobs = targets.flatMap((item) => (item.branches?.length ? item.branches : [{ name: item.name }]).slice(0, 4).map((branch) => ({ item, branch })));
  const results = await runWindTasks(jobs.map((job) => () => windCall("analytics_data", "get_financial_data", {
    question: `${job.branch.name}概念成分股最新涨跌幅排名前十，返回Wind代码、证券简称、所属概念板块、最新成交价、今日开盘价、今日最高价、今日最低价、涨跌幅、成交额、换手率、量比、总市值和交易时间`
  }, 12_000)));
  const lookup = new Map(targets.map((item) => [item, { rows: [], errors: [] }]));
  jobs.forEach((job, index) => {
    const entry = lookup.get(job.item);
    const branchRows = constituentRows(fulfilled(results[index]), day);
    const branchLimitCount = branchRows.filter((row) => row.changePct >= 9.5).length;
    const branchAdvanceCount = branchRows.filter((row) => row.changePct >= 3).length;
    entry.rows.push(...branchRows.map((row, rank) => ({
      ...row,
      candidateBranches: [job.branch.name],
      branchStats: [{ name: job.branch.name, rank: rank + 1, limitCount: branchLimitCount, advanceCount: branchAdvanceCount }]
    })));
    if (reason(results[index])) entry.errors.push(reason(results[index]));
  });
  const mergedRows = new Map();
  targets.forEach((item) => {
    const rows = new Map();
    for (const row of lookup.get(item)?.rows || []) {
      const previous = rows.get(row.code);
      rows.set(row.code, previous ? {
        ...previous,
        concepts: [...new Set([...previous.concepts, ...row.concepts])],
        candidateBranches: [...new Set([...previous.candidateBranches, ...row.candidateBranches])],
        branchStats: [...(previous.branchStats || []), ...(row.branchStats || [])]
      } : row);
    }
    mergedRows.set(item, [...rows.values()].sort((a, b) => b.changePct - a.changePct));
  });
  const ambiguous = targets.flatMap((item) => mergedRows.get(item).map((row) => ({
    item, row, validation: candidateThemeEvidence(item, row, marketNews)
  }))).filter((entry) => !entry.validation.accepted && entry.row.changePct >= 3)
    .sort((a, b) => b.row.changePct - a.row.changePct).slice(0, 6);
  const logicResults = await runWindTasksInBatches(ambiguous.map(({ row }) => () => loadCandidateSupplement(day, row)), 3);
  ambiguous.forEach((entry, index) => {
    const supplement = fulfilled(logicResults[index]) || {};
    entry.row.investmentLogic = supplement.investmentLogic || "";
    entry.row.stockNews = supplement.stockNews || [];
    entry.row.supplementErrors = supplement.errors || (reason(logicResults[index]) ? [reason(logicResults[index])] : []);
  });
  const validatedEntries = items.map((item) => {
    const match = lookup.get(item);
    if (!match) return { item, match: null, rows: [], rejected: [] };
    const rejected = [];
    const rows = mergedRows.get(item).map((row) => {
      const validation = candidateThemeEvidence(item, row, [...marketNews, ...(row.stockNews || [])], row.investmentLogic);
      if (!validation.accepted) {
        rejected.push({ code: row.code, name: row.name, reason: validation.evidence });
        return null;
      }
      const { investmentLogic, stockNews, supplementErrors, ...publicRow } = row;
      return { ...publicRow, themeEvidence: validation.evidence, themeEvidenceLevel: validation.level };
    }).filter(Boolean);
    return { item, match, rows, rejected };
  });
  const primaryThemeByStock = new Map();
  validatedEntries.forEach((entry) => entry.rows.forEach((row) => {
    const attribution = candidateAttributionScore(entry.item, row);
    const previous = primaryThemeByStock.get(row.code);
    if (!previous || attribution.score > previous.attribution.score) primaryThemeByStock.set(row.code, { item: entry.item, attribution });
  }));
  const outputs = validatedEntries.map(({ item, match, rows, rejected }) => {
    if (!match) return { item, attributedRows: [], out: { ...item, followers: [], rideable: [], lead: [], leader: [], mid: [], stockCoverage: "not_requested" } };
    const attributedRows = rows.filter((row) => {
      const primary = primaryThemeByStock.get(row.code);
      if (primary?.item === item) {
        row.primaryAttributionBranch = primary.attribution.branch;
        row.attributionEvidence = `${primary.attribution.branch}分支涨停${primary.attribution.branchLimitCount}只、涨幅≥3%共${primary.attribution.branchAdvanceCount}只`;
        return true;
      }
      if (primary) rejected.push({ code: row.code, name: row.name, reason: `多概念主归因调整为${primary.item.name}·${primary.attribution.branch}` });
      return false;
    });
    const layers = stockRoleLayers(item, attributedRows);
    const stockError = match.errors[0] || (!attributedRows.length ? `NO_RESULTS: ${item.name}成分股均未通过概念/催化二次校验或已归入更强题材` : null);
    return { item, attributedRows, out: { ...item, ...layers, limitStocks: (item.limitStocks || []).filter((x) => isTradableRoleStock(x.code)), rejectedCandidates: rejected, stockCoverage: attributedRows.length ? "verified" : "unavailable", stockError } };
  });
  // 中军主营校验：概念归属入选的（尤其参股类分支）再用主营文本复核按家族降级，见 verifyMidBusiness。
  await verifyMidBusiness(day, outputs);
  // 领涨等点火池标的若涨跌幅为兜底值（pctFallback），按题材批量向行情接口补查精确涨跌幅。
  const needRefill = outputs.map(({ item, out }) => {
    const lead = out.lead || [];
    const codes = lead.filter((x) => x.pctFallback).map((x) => x.code);
    return codes.length ? { item, codes, lead } : null;
  }).filter(Boolean);
  if (needRefill.length) {
    const refillResults = await runWindTasksInBatches(needRefill.map(({ codes }) => () => windCall("analytics_data", "get_financial_data", {
      question: `以下沪深A股最新涨跌幅：${codes.join(",")}，返回Wind代码和涨跌幅`
    }, 12_000)), 2);
    needRefill.forEach((entry, index) => {
      const payload = fulfilled(refillResults[index]);
      if (!payload) return;
      const exactRows = tables(payload).flatMap(objects);
      entry.lead.forEach((stock) => {
        const hit = exactRows.find((r) => String(r["Wind代码"]) === stock.code);
        if (hit && Number.isFinite(Number(hit["涨跌幅"]))) {
          stock.changePct = Number(hit["涨跌幅"]);
          stock.pctFallback = false;
        }
      });
    });
  }
  return outputs.map(({ out }) => out);
}
async function loadThemeAnomalies(force = false) {
  if (!force && cachedAnomalies && Date.now() - anomalyCachedAt < 15_000) return { ...cachedAnomalies, cached: true };
  if (anomalyInflight) return anomalyInflight;
  anomalyInflight = (async () => {
    const day = localDate();
    const [results, newsPayload] = await Promise.all([
      runWindTasks([
        () => windCall("index_data", "get_index_technicals", { question: "A股Wind概念指数按最近5分钟涨幅排名前五十，返回Wind代码、证券简称、当前刷新时点的最新成交价和交易时间、当前时间往前推5分钟时点的成交价和交易时间；不要返回日涨跌幅，不要把今日涨跌幅当作5分钟涨跌幅" }),
        () => windCall("analytics_data", "get_financial_data", { question: "A股Wind概念指数最新5分钟涨跌幅排名前五十" }),
        () => windCall("stock_data", "search_stocks", { question: "筛选当前最新成交价等于涨停价的沪深A股" })
      ].filter((_, index) => index !== 1)),
      windCall("financial_docs", "get_financial_news", { query: `${day}当日最新A股题材利好消息催化`, top_k: 30 }).catch(() => null)
    ]);
    const momentum = localThemeMomentumRows(fulfilled(results[0]));
    const shorts = momentum.rows;
    const rawLimitStocks = anomalyRows(fulfilled(results[1]), "limit");
    const streakResult = await loadLimitHistory(day);
    const streakDataComplete = streakResult.complete;
    let limitDataSource = "current_price_equals_limit_price";
    let limitDataIncomplete = false;
    let limitStocks = [];
    if (rawLimitStocks.length) {
      limitStocks = await enrichLimitStocks(day, rawLimitStocks.map((stock) => {
        let limitStreak = streakDataComplete ? 1 : null;
        if (limitStreak != null) {
          for (const codes of streakResult.sets) {
            if (!codes.has(stock.code)) break;
            limitStreak += 1;
          }
        }
        return { ...stock, limitStreak, streakLabel: limitStreak == null ? null : limitStreakLabel(limitStreak) };
      }));
      lastValidLimitStocks = limitStocks;
      lastValidLimitTradingDate = day;
      lastValidLimitCapturedAt = Date.now();
    } else if (lastValidLimitTradingDate === day && lastValidLimitStocks.length && Date.now() - lastValidLimitCapturedAt <= 30_000) {
      limitStocks = lastValidLimitStocks;
      limitDataSource = "last_valid_cache_30s";
      limitDataIncomplete = true;
    } else {
      limitDataSource = "unavailable";
      limitDataIncomplete = true;
    }
    const news = newsPayload?.data?.items || newsPayload?.data?.data?.items || [];
    const newsWindowStart = streakResult.dates?.[0] || await previousTradingDate(day).catch(() => null) || fallbackNewsWindowStart(day);
    const map = new Map();
    const ensure = (name, code = null) => {
      const key = anomalyThemeName(name).replace(/[·・s-—_/（）()]/g, "").toLowerCase();
      if (!map.has(key)) map.set(key, { name: anomalyThemeName(name), code, score: 0, signals: new Set(), shortMove: null, dayChange: null, tradeTime: null, limitStocks: [], news: [] });
      return map.get(key);
    };
    shorts.forEach((x) => {
      const item = ensure(x.name, x.code);
      Object.assign(item, { shortMove: x.shortMove, dayChange: x.dayChange, tradeTime: x.tradeTime });
      if (x.shortMove >= BATCH_SIGNAL_MIN_5M) item.signals.add("batch");
    });
    const activeThemeNames = shorts.map((item) => item.name);
    const limitConceptCounts = limitConceptFrequency(limitStocks);
    limitStocks.forEach((stock) => {
      const name = selectPrimaryConcept(stock.concepts, activeThemeNames, limitConceptCounts);
      if (!name) return;
      const item = ensure(name); item.signals.add("limit");
      if (!item.limitStocks.some((x) => x.code === stock.code)) item.limitStocks.push({ code: stock.code, name: stock.name, sealTime: stock.sealTime, primaryConcept: name, limitStreak: stock.limitStreak, streakLabel: stock.streakLabel });
      item.score += item.limitStocks.length === 1 ? 40 : 24;
    });
    let excludedNewsArticles = 0;
    let excludedStaleNewsArticles = 0;
    let excludedUndatedNewsArticles = 0;
    let matchedNewsArticles = 0;
    news.forEach((article) => {
      const freshness = newsFreshness(article, newsWindowStart, day);
      if (!freshness.accepted) {
        if (freshness.reason === "undated") excludedUndatedNewsArticles += 1;
        else excludedStaleNewsArticles += 1;
        return;
      }
      if (isRecapArticle(article)) { excludedNewsArticles += 1; return; }
      const articleText = `${cleanNewsText(article.title)} ${sanitizeNewsContent(article.content || article.summary || article.abstract)}`, names = new Map();
      newsThemeRules.forEach((rule) => { if (rule.pattern.test(articleText)) names.set(rule.name, rule); });
      map.forEach((item) => { if (item.name.length >= 2 && articleText.includes(item.name)) names.set(item.name, null); });
      const candidates = [];
      names.forEach((rule, name) => {
        const catalyst = newsCatalystSummary(article, name, rule);
        if (!catalyst) return;
        const item = ensure(specificNewsBranchName(rule, catalyst, name));
        const move = Number(item.shortMove ?? item.dayChange ?? 0);
        if (catalyst.sentiment === "negative" && move >= 0) return;
        candidates.push({ item, catalyst });
      });
      const accepted = candidates.sort((a, b) => b.catalyst.relevanceScore - a.catalyst.relevanceScore).slice(0, 2);
      if (accepted.length) matchedNewsArticles += 1;
      accepted.forEach(({ item, catalyst }) => {
        item.signals.add("news");
        if (item.news.length < 3) item.news.push({
          title: article.title || "Wind市场消息",
          date: freshness.published.raw,
          source: article.source || article.media || article.source_name || article.provider || "Wind财经新闻",
          ...catalyst
        });
        item.score += item.news.length === 1 ? 18 : 5;
      });
    });
    const rawItems = [...map.values()].filter((item) => isEligibleNarrativeTheme(item.name));
    const mergedItems = mergeAnomalyThemes(rawItems);
    // 普涨松动阈值：当日没有一个题材涨停≥3（涨停分散在各题材）时，按 55 而非 60 过滤，
    // 避免有效批量/消息题材大面积塌陷。
    const hasLimitAnchor = mergedItems.some((item) => item.signals.has("limit") && item.limitStocks.length >= LIMIT_THEME_MIN_STOCKS);
    const minScore = hasLimitAnchor ? ANOMALY_MIN_SCORE : 55;
    const rankedItems = mergedItems.map((item) => {
      const ladder = limitLadderMetrics(item.limitStocks);
      const limit = item.signals.has("limit") && item.limitStocks.length >= LIMIT_THEME_MIN_STOCKS;
      const batch = item.signals.has("batch"), newsHit = item.signals.has("news");
      const effectiveSignals = [...item.signals].filter((signal) => signal !== "limit" || limit);
      let status = limit ? "局部点火" : batch ? "批量拉升" : "消息观察";
      if (limit && batch) status = "强化扩散";
      else if (newsHit && (limit || batch)) status = "催化共振";
      const sortMetrics = {
        limitCount: item.limitStocks.length,
        maxStreak: ladder.maxStreak,
        ladderDepth: ladder.contiguousDepth,
        ladderBonus: ladder.totalBonus,
        fiveMinuteChange: Number(item.shortMove) || 0,
        newsMomentum: Math.round(((Number(item.dayChange) || 0) * .55 + (Number(item.shortMove) || 0) * .45) * 100) / 100
      };
      const limitStrength = limit ? Math.min(100, 65 + Math.max(0, item.limitStocks.length - LIMIT_THEME_MIN_STOCKS) * 15) : 0;
      const batchStrength = batch ? Math.min(100, 60 + Math.max(0, Number(item.shortMove) - BATCH_SIGNAL_MIN_5M) * 16) : 0;
      const relevanceValues = item.news.map((article) => Number(article.relevanceScore)).filter(Number.isFinite);
      const averageRelevance = relevanceValues.length ? relevanceValues.reduce((sum, value) => sum + value, 0) / relevanceValues.length : 70;
      const newsCountStrength = Math.min(100, 45 + item.news.length * 15);
      const newsMomentumStrength = clamp(50 + sortMetrics.newsMomentum * 10);
      const newsStrength = newsHit ? Math.round(clamp(averageRelevance * .55 + newsCountStrength * .25 + newsMomentumStrength * .20)) : 0;
      const components = { limit: limitStrength, batch: batchStrength, news: newsStrength };
      const signalCount = [limit, batch, newsHit].filter(Boolean).length;
      const resonanceBonus = signalCount >= 3 ? 6 : signalCount >= 2 ? 3 : 0;
      const tabScores = {
        all: allAnomalyScore(components, item.limitStocks.length, resonanceBonus, ladder.totalBonus),
        limit: limit ? weightedThemeScore(components, { limit: 75, batch: 15, news: 10 }) : 0,
        batch: batch ? weightedThemeScore(components, { batch: 75, limit: 15, news: 10 }) : 0,
        news: newsHit ? weightedThemeScore(components, { news: 70, batch: 20, limit: 10 }) : 0
      };
      const scoreBreakdown = { limit: Math.round(limitStrength), batch: Math.round(batchStrength), news: Math.round(newsStrength), resonance: resonanceBonus, highBoardBonus: ladder.highBoardBonus, ladderBonus: ladder.ladderBonus, ladderTotalBonus: ladder.totalBonus };
      return { ...item, score: tabScores.all, tabScores, scoreBreakdown, ladder, sortMetrics, status, signals: effectiveSignals };
    }).filter((item) => isEligibleNarrativeTheme(item.name) && item.tabScores.all >= minScore)
      .sort((a, b) => b.score - a.score || b.scoreBreakdown.ladderTotalBonus - a.scoreBreakdown.ladderTotalBonus || b.sortMetrics.limitCount - a.sortMetrics.limitCount).slice(0, ANOMALY_MAX_ITEMS);
    const items = await enrichThemeCandidates(day, rankedItems, news);
    const errors = results.map(reason).filter(Boolean);
    errors.push(...streakResult.errors);
    if (minScore !== ANOMALY_MIN_SCORE) errors.push(`题材热度门槛按普涨日宽松处理（${minScore}）`);
    if (!streakDataComplete) errors.push("NO_RESULTS: 连板明细本次未返回，未将未知股票标记为首板");
    if (limitDataIncomplete) errors.push(limitDataSource.startsWith("last_valid_cache") ? "Wind实时涨停名单本次空返，已短暂保留30秒内最近一次有效点火数据" : "Wind实时涨停名单本次未返回有效数据");
    const streakCounts = limitStocks.reduce((counts, stock) => {
      const label = stock.streakLabel || "待确认";
      counts[label] = (counts[label] || 0) + 1;
      return counts;
    }, {});
    const verifiedCandidateCodes = new Set(items.flatMap((item) => [...(item.followers || []), ...(item.rideable || [])].map((stock) => stock.code)));
    const rejectedCandidateCount = items.reduce((sum, item) => sum + (item.rejectedCandidates?.length || 0), 0);
    const output = { asOf: new Date().toISOString(), tradingDate: day, items,
      summary: { total: items.length, rawTotal: rawItems.length, mergedTotal: mergedItems.length, filteredOut: mergedItems.length - items.length, minScore, limitThemes: items.filter((x) => x.signals.includes("limit")).length, batchThemes: items.filter((x) => x.signals.includes("batch")).length, newsThemes: items.filter((x) => x.signals.includes("news")).length, verifiedCandidates: verifiedCandidateCodes.size, rejectedCandidates: rejectedCandidateCount },
      limitData: { source: limitDataSource, stockCount: limitStocks.length, complete: !limitDataIncomplete, streakSource: "current_limits_intersect_consecutive_historical_close_limits", streakTradingDates: streakResult.dates, streakCounts },
      newsDiagnostics: { sourceArticles: news.length, windowStart: newsWindowStart, windowEnd: day, excludedStaleArticles: excludedStaleNewsArticles, excludedUndatedArticles: excludedUndatedNewsArticles, excludedRecapArticles: excludedNewsArticles, matchedArticles: matchedNewsArticles, maxThemesPerArticle: 2 },
      momentumDiagnostics: { source: "wind_current_price_vs_5m_ago_price", field: "(current_price/price_5m_ago-1)*100", validatedCount: shorts.length, strictField: true, requestCacheSeconds: cacheTtlMs / 1000, ...momentum.diagnostics },
      source: "Wind概念指数分钟行情、全量涨停明细、完整个股概念归属、财经新闻", partial: errors.length > 0 || !newsPayload, errors };
    cachedAnomalies = output; anomalyCachedAt = Date.now(); return output;
  })().finally(() => { anomalyInflight = null; });
  return anomalyInflight;
}

function latestQuoteTime(indexRow, themes) {
  return [indexRow?.["交易时间"], ...themes.map((item) => item.tradeTime)].filter(Boolean).sort().at(-1) || null;
}

function historyTradingMinute(item) {
  const tradingDate = String(item.tradingDate || "");
  const quoteMatch = String(item.quoteTime || "").match(/(\d{8})\s+(\d{2}):(\d{2})/);
  if (quoteMatch && quoteMatch[1] === tradingDate) return Number(quoteMatch[2]) * 60 + Number(quoteMatch[3]);
  const captured = new Date(item.capturedAt);
  if (Number.isNaN(captured.getTime())) return null;
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hourCycle: "h23"
  }).formatToParts(captured).map((part) => [part.type, part.value]));
  if (`${parts.year}${parts.month}${parts.day}` !== tradingDate) return null;
  return Number(parts.hour) * 60 + Number(parts.minute);
}

function isTradingSessionHistory(item) {
  const minute = historyTradingMinute(item);
  return Number.isFinite(minute) && ((minute >= 565 && minute <= 690) || (minute >= 780 && minute <= 900));
}

function aggregateDailyHistory(history) {
  const groups = new Map();
  for (const item of history) {
    const tradingDate = String(item.tradingDate || "");
    const score = Number(item.score);
    if (!tradingDate || !Number.isFinite(score) || !isTradingSessionHistory(item)) continue;
    if (!groups.has(tradingDate)) groups.set(tradingDate, []);
    groups.get(tradingDate).push(item);
  }
  return [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([tradingDate, items]) => {
    const score = Math.round(items.reduce((sum, item) => sum + Number(item.score), 0) / items.length * 100) / 100;
    return {
      tradingDate,
      score,
      phase: classify(score, { upRatio: null }).phase,
      sampleCount: items.length,
      firstCapturedAt: items[0].capturedAt,
      lastCapturedAt: items.at(-1).capturedAt
    };
  });
}

async function loadEmotion(force = false, continuity = null) {
  if (inflight) return inflight;
  inflight = (async () => {
    const day = localDate();
    let previousDay = null;
    let previousDayError = null;
    try {
      previousDay = await previousTradingDate(day);
    } catch (error) {
      previousDayError = `前一交易日: ${String(error?.message || error)}`;
    }
    const calls = await runWindTasks([
      () => windCall("index_data", "get_index_price_indicators", { windcode: "881001.WI", indexes: "最新成交价,涨跌幅,成交额,上涨家数,下跌家数,平盘家数,交易时间" }),
      () => windCall("stock_data", "search_stocks", { question: "筛选当前最新成交价等于涨停价的沪深A股" }),
      () => windCall("stock_data", "search_stocks", { question: "筛选当前最新成交价等于跌停价的沪深A股" }),
      () => windCall("analytics_data", "get_financial_data", { question: "当前沪深A股涨幅大于5%的股票家数" }),
      () => windCall("analytics_data", "get_financial_data", { question: "当前沪深A股跌幅大于5%的股票家数" }),
      () => {
        if (!previousDay) throw new Error(previousDayError || "NO_RESULTS: 前一交易日未识别");
        return windCall("analytics_data", "get_financial_data", { question: `${previousDay}涨停股票在${day}的最新涨跌幅排名` });
      },
      () => windCall("analytics_data", "get_financial_data", { question: `${day}A股Wind概念指数涨跌幅排名前十` })
    ]);
    const indexPayload = fulfilled(calls[0]);
    const indexRow = objects(tables(indexPayload)[0])[0] || {};
    const limitUpStocks = tables(fulfilled(calls[1])).flatMap(objects).filter((r) => r["Wind代码"]).map((r) => ({ code: r["Wind代码"], name: r["证券简称"] || "" }));
    const limitUp = limitUpStocks.length || uniqueWindCodeCount(fulfilled(calls[1]));
    const limitDown = uniqueWindCodeCount(fulfilled(calls[2]));
    const bigUp = aggregatedStockCount(fulfilled(calls[3]), /涨幅大于5%.*家数$/);
    const bigDown = aggregatedStockCount(fulfilled(calls[4]), /跌幅大于5%.*家数$/);
    const premiumDetail = percentileColumn(fulfilled(calls[5]), /^(?:(?:最新|今日|当日).*|\d{8}|\d{4}年\d{1,2}月\d{1,2}日)涨跌幅$/);
    const premium = premiumDetail.value;
    const themes = normalizeThemes(fulfilled(calls[6]));
    const up = Number(indexRow["上涨家数"]);
    const down = Number(indexRow["下跌家数"]);
    const flat = Number(indexRow["平盘家数"]);
    const upRatio = Number.isFinite(up + down) && up + down > 0 ? up / (up + down) * 100 : null;
    const errors = calls.map(reason).filter(Boolean);
    let ladderScore = 50;
    try {
      const streakResult = await loadLimitHistory(day);
      const enrichedLimitStocks = limitUpStocks.map((stock) => {
        let limitStreak = 1;
        if (streakResult.complete) {
          for (const codes of streakResult.sets) {
            if (!codes.has(stock.code)) break;
            limitStreak += 1;
          }
        }
        return { ...stock, limitStreak };
      });
      ladderScore = scoreLadder(enrichedLimitStocks, streakResult.complete);
    } catch (ladderError) {
      errors.push(`连板梯队: ${String(ladderError?.message || ladderError)}`);
    }
    let liquidityScore = 50;
    try {
      const liquidityHistory = await loadLiquidityHistory(day);
      const predicted = predictFullDayAmount(indexRow["成交额"], indexRow["交易时间"]);
      liquidityScore = scoreLiquidity(predicted, liquidityHistory.turnovers);
    } catch (liqError) {
      errors.push(`成交环境: ${String(liqError?.message || liqError)}`);
    }
    const dimensions = { breadth: Math.round(scoreBreadth(up, down)), limits: Math.round(scoreLimit(limitUp, limitDown, bigUp, bigDown)), ladder: Math.round(ladderScore), profit: Math.round(scorePremium(premium)), themes: Math.round(scoreTheme(themes)), liquidity: Math.round(liquidityScore) };
    // 权重校准：ladder/liquidity 满血计分后分布已向 50 中枢收敛，profit（赚钱效应）权重上调、ladder 下调，
    // 避免连板家数等“体量”信号喧宾夺主，突出追涨是否真正盈利这一短线核心。
    const score = Math.round(clamp(dimensions.breadth * .20 + dimensions.limits * .20 + dimensions.ladder * .10 + dimensions.profit * .25 + dimensions.themes * .15 + dimensions.liquidity * .10));
    const regime = classify(score, { upRatio, changePct: Number(indexRow["涨跌幅"]), dimensions, continuity });
    const refScore = continuity != null && Number.isFinite(continuity.prevScore) ? continuity.prevScore : Number.isFinite(continuity?.avg5) ? continuity.avg5 : null;
    const trend = Number.isFinite(refScore) ? (score - refScore >= 6 ? "up" : score - refScore <= -6 ? "down" : "flat") : null;
    const missing = [
      [!indexPayload, "市场广度"], [limitUp == null, "涨停家数"], [limitDown == null, "跌停家数"],
      [bigUp == null, "大涨家数"], [bigDown == null, "大跌家数"], [premium == null, "昨日涨停溢价"],
      [themes.length === 0, "题材排名"]
    ].filter(([isMissing]) => isMissing).map(([, name]) => `NO_RESULTS: ${name}未返回`);
    errors.push(...missing);
    const snapshot = {
      tradingDate: day,
      capturedAt: new Date().toISOString(),
      quoteTime: latestQuoteTime(indexRow, themes),
      source: "Wind AI Fin Market",
      score,
      regime,
      trend,
      dimensions,
      market: { index: Number(indexRow["最新成交价"]), changePct: Number(indexRow["涨跌幅"]), amount: Number(indexRow["成交额"]), up: Number.isFinite(up) ? up : null, down: Number.isFinite(down) ? down : null, flat: Number.isFinite(flat) ? flat : null, upRatio },
      extremes: { limitUp, limitDown, bigUp, bigDown },
      profit: { premium, sampleSize: premiumDetail.sampleSize, baseTradingDate: previousDay, currentTradingDate: day, method: "前一交易日涨停股票今日涨跌幅分位（中位数）" },
      themes,
      coverage: [
        { name: "市场广度", status: indexPayload ? "direct" : "error", note: "全A指数直接返回上涨、下跌、平盘与成交额" },
        { name: "涨跌停与大涨大跌", status: [limitUp, limitDown, bigUp, bigDown].some((item) => item != null) ? "direct" : "error", note: "Wind结构化取数" },
        { name: "昨日涨停溢价", status: premium != null ? "derived" : "error", note: premium != null ? "Wind明细本地中位数（" + premiumDetail.sampleSize + "只）" : "Wind未返回前一交易日涨停股今日涨跌幅明细" },
        { name: "连板与晋级率", status: "derived", note: "多日涨停名单本地计算最高板、梯队完整度与涨停总数" },
        { name: "成交额", status: indexRow["成交额"] != null ? "direct" : "error", note: "近60交易日成交额分位数，盘中按时间外推全天" },
        { name: "炸板率与盘中曲线", status: "derived", note: "依赖分钟级快照持续沉淀" },
        { name: "L2排撤单", status: "limited", note: "需要额外高频或L2数据授权" }
      ],
      errors,
      partial: errors.length > 0
    };
    return snapshot;
  })().finally(() => { inflight = null; });
  return inflight;
}

async function loadNews() {
  const payload = await windCall("financial_docs", "get_financial_news", { query: `${localDate()}A股市场热点催化`, top_k: 5 });
  return payload?.data?.items || payload?.data?.data?.items || [];
}

function historyRecord(snapshot) {
  return { tradingDate: snapshot.tradingDate, capturedAt: snapshot.capturedAt, quoteTime: snapshot.quoteTime, score: snapshot.score, phase: snapshot.regime.phase, up: snapshot.market.up, down: snapshot.market.down, limitUp: snapshot.extremes.limitUp, limitDown: snapshot.extremes.limitDown, premium: snapshot.profit.premium };
}

// Per-day caches survive across cron runs (cold instances) via service.js.
function exportEngineState(day = localDate()) {
  const concepts = {};
  for (const [key, value] of conceptMembershipCache) {
    if (key.startsWith(`${day}:`)) concepts[key.slice(day.length + 1)] = value;
  }
  return {
    day,
    concepts,
    limitHistory: cachedLimitHistory?.day === day
      ? { ...cachedLimitHistory, sets: cachedLimitHistory.sets.map((codes) => [...codes]) }
      : null,
    previousTradingDate: cachedPreviousTradingDate?.day === day ? cachedPreviousTradingDate.date : null
  };
}

function importEngineState(state, day = localDate()) {
  if (!state || state.day !== day) return;
  for (const [code, concepts] of Object.entries(state.concepts || {})) {
    if (Array.isArray(concepts)) conceptMembershipCache.set(`${day}:${code}`, concepts);
  }
  if (state.limitHistory?.complete && Array.isArray(state.limitHistory.sets)) {
    cachedLimitHistory = { ...state.limitHistory, sets: state.limitHistory.sets.map((codes) => new Set(codes)) };
  }
  if (state.previousTradingDate) cachedPreviousTradingDate = { day, date: state.previousTradingDate };
}

// Shared helpers for the 台股 engine (tw-engine.js) and the 涨停事件 engine (limit-engine.js).
export {
  windCall,
  tables,
  objects,
  fulfilled,
  reason,
  runWindTasks,
  runWindTasksInBatches,
  clamp,
  scoreBreadth,
  scoreLimit,
  scorePremium,
  limitStreakLabel,
  calendarOffset,
  recentTradingDates,
  anomalyThemeName,
  anomalyFamily,
  conceptNamesFromValue,
  isEligibleNarrativeTheme,
  NON_NARRATIVE_ANOMALY_PATTERN,
  NON_BUSINESS_CONCEPT_PATTERN,
  VERIFIED_STANDALONE_THEME_PATTERN,
  loadLimitHistory,
  previousTradingDate
};

export {
  loadEmotion,
  loadThemeAnomalies,
  loadNews,
  aggregateDailyHistory,
  isTradingSessionHistory,
  historyRecord,
  classify,
  localDate,
  exportEngineState,
  importEngineState
};
