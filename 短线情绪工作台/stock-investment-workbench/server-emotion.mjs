import http from "node:http";
import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(root, "public-emotion");
const dataDir = path.join(root, "data");
const historyFile = path.join(dataDir, "emotion-history.json");
const skillDir = process.env.WIND_MCP_SKILL_DIR || path.join(os.homedir(), ".agents", "skills", "wind-mcp-skill");
const windCli = path.join(skillDir, "scripts", "cli.mjs");
const port = Number(process.env.EMOTION_PORT || process.env.PORT || 4320);
const cacheTtlMs = Number(process.env.EMOTION_CACHE_MS || 60_000);
const maxHistoryTradingDays = 60;
const maxHistoryRecords = 10_000;

async function readRequestBody(req, limit = 25 * 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new Error("短线情绪页面内容过长，无法导出图片");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function exportEmotionPng(req, res) {
  const payload = JSON.parse((await readRequestBody(req)).toString("utf8"));
  const width = Math.max(1000, Math.min(1800, Number(payload.width) || 1440));
  if (!payload.html || typeof payload.html !== "string") throw new Error("没有可导出的短线情绪内容");
  const edgeCandidates = ["C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe", "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe"];
  let edge;
  for (const candidate of edgeCandidates) { try { await fs.access(candidate); edge = candidate; break; } catch {} }
  if (!edge) throw new Error("未找到 Microsoft Edge，无法生成图片");
  const jobDir = await fs.mkdtemp(path.join(os.tmpdir(), "wind-emotion-export-"));
  const htmlFile = path.join(jobDir, "emotion.html");
  const pngFile = path.join(jobDir, "emotion.png");
  const croppedPngFile = path.join(jobDir, "emotion-cropped.png");
  const styleFiles = ["styles.css", "anomaly.css", "roles.css", "anomaly-tabs.css"];
  const styles = (await Promise.all(styleFiles.map((name) => fs.readFile(path.join(publicDir, name), "utf8")))).join("\n");
  const exportStyles = `
    html,body{margin:0;padding:0;width:100%;background:#f3f4f0;overflow-x:hidden}
    body{min-width:0}.export-shell{width:100%;padding:28px;background:#f3f4f0}
    .export-shell main{display:block!important;grid-column:auto!important;width:100%!important;max-width:none!important;margin:0!important;padding:0!important}
    .export-shell .topbar{padding:18px 22px;margin-bottom:16px;border:1px solid #dfe2da;border-radius:16px;background:#fff}
    .export-shell button,.export-shell .toast{display:none!important}
    .export-shell .news-list{max-height:none!important;overflow:visible!important}
    .export-footer{padding:22px 4px 6px;color:#7b827a;font-size:11px;text-align:center}
  `;
  const document = `<!doctype html><html><head><meta charset="utf-8"><style>${styles}\n${exportStyles}</style></head><body><div class="export-shell">${payload.html}<div class="export-footer">Wind AI短线情绪 · 数据仅用于研究与情绪观察，不构成投资建议</div></div><script>requestAnimationFrame(()=>requestAnimationFrame(()=>{const root=document.querySelector(".export-shell");const height=Math.ceil(Math.max(document.body.scrollHeight,document.documentElement.scrollHeight,root?root.getBoundingClientRect().bottom:0)+64);document.documentElement.setAttribute("data-export-height",String(height));document.documentElement.setAttribute("data-export-scroll-width",String(document.documentElement.scrollWidth));document.documentElement.setAttribute("data-export-client-width",String(document.documentElement.clientWidth));}));<\/script></body></html>`;
  const runEdge = (args, capture = false) => new Promise((resolve, reject) => {
    const child = spawn(edge, args, { windowsHide: true, stdio: capture ? ["ignore", "pipe", "ignore"] : "ignore" });
    let stdout = "";
    if (capture) child.stdout.on("data", (chunk) => { stdout += chunk.toString("utf8"); });
    const timer = setTimeout(() => { child.kill(); reject(new Error("生成图片超时")); }, 45000);
    child.on("error", (error) => { clearTimeout(timer); reject(error); });
    child.on("exit", (code) => { clearTimeout(timer); code === 0 ? resolve(stdout) : reject(new Error(`Edge导出失败（${code}）`)); });
  });
  try {
    await fs.writeFile(htmlFile, document, "utf8");
    const common = ["--headless=new", "--disable-gpu", "--hide-scrollbars", "--no-first-run", "--no-default-browser-check", "--run-all-compositor-stages-before-draw", "--virtual-time-budget=1500"];
    const dumped = await runEdge([...common, `--user-data-dir=${path.join(jobDir, "measure-profile")}`, "--dump-dom", pathToFileURL(htmlFile).href], true);
    const measuredFromDom = Number(dumped.match(/data-export-height="(\d+)"/)?.[1]);
    const measured = Number.isFinite(measuredFromDom) && measuredFromDom >= 400
      ? measuredFromDom
      : Math.min(28000, Math.max(2400, Math.ceil(payload.html.length * .48)));
    const scrollWidth = Number(dumped.match(/data-export-scroll-width="(\d+)"/)?.[1]);
    const clientWidth = Number(dumped.match(/data-export-client-width="(\d+)"/)?.[1]);
    if (Number.isFinite(scrollWidth) && Number.isFinite(clientWidth) && scrollWidth > clientWidth) throw new Error(`导出布局横向溢出：${scrollWidth}/${clientWidth}`);
    if (measured > 30000) throw new Error("短线情绪页面过长，请减少题材卡片后导出");
    const height = Math.min(30000, Math.ceil(measured + 1800));
    await runEdge([...common, `--user-data-dir=${path.join(jobDir, "capture-profile")}`, `--window-size=${width},${height}`, `--screenshot=${pngFile}`, pathToFileURL(htmlFile).href]);
    await new Promise((resolve, reject) => {
      const cropper = spawn("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", path.join(root, "crop-emotion-export-image.ps1"), "-InputPath", pngFile, "-OutputPath", croppedPngFile, "-BottomPadding", "36"], { windowsHide: true, stdio: "ignore" });
      const timer = setTimeout(() => { cropper.kill(); reject(new Error("图片裁边超时")); }, 30000);
      cropper.on("error", (error) => { clearTimeout(timer); reject(error); });
      cropper.on("exit", (code) => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error(`图片裁边失败（${code}）`)); });
    });
    const png = await fs.readFile(croppedPngFile);
    res.writeHead(200, { "Content-Type": "image/png", "Content-Length": png.length, "Cache-Control": "no-store", "X-Export-Width": String(width), "X-Export-Height": String(measured) });
    res.end(png);
  } finally {
    await fs.rm(jobDir, { recursive: true, force: true }).catch(() => {});
  }
}

let cachedEmotion = null;
let cachedAt = 0;
let inflight = null;
let cachedAnomalies = null;
let anomalyCachedAt = 0;
let anomalyInflight = null;
const conceptMembershipCache = new Map();
const themeMomentumCache = new Map();
const themeMomentumCacheTtlMs = 300_000;
let lastValidLimitStocks = [];
let lastValidLimitTradingDate = null;
let lastValidLimitCapturedAt = 0;
let cachedLimitHistory = null;
let cachedPreviousTradingDate = null;

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

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml"
};

function json(res, status, payload) {
  const body = Buffer.from(JSON.stringify(payload));
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Content-Length": body.length, "Cache-Control": "no-store" });
  res.end(body);
}

function clamp(value, min = 0, max = 100) {
  return Math.min(max, Math.max(min, Number(value) || 0));
}

function localDate(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(date);
  const value = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${value.year}${value.month}${value.day}`;
}

function unpackWind(stdout) {
  const outer = JSON.parse(stdout);
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
  await fs.access(windCli);
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [windCli, "call", serverType, toolName, JSON.stringify(params)], { cwd: skillDir, windowsHide: true, env: process.env });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill(), timeoutMs);
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        try {
          const parsed = JSON.parse(stdout);
          reject(new Error(`${parsed?.error?.code || "WIND_ERROR"}: ${parsed?.error?.message || stderr || "Wind调用失败"}`));
        } catch {
          reject(new Error(stderr || stdout || `Wind CLI退出码${code}`));
        }
        return;
      }
      try {
        const payload = unpackWind(stdout);
        if (momentumCacheKey) {
          payload._capturedAt = new Date().toISOString();
          themeMomentumCache.set(momentumCacheKey, { capturedAt: Date.now(), payload });
        }
        resolve(payload);
      } catch (error) { reject(error); }
    });
  });
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

function averageColumn(payload, matcher) {
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
  return {
    value: values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null,
    sampleSize: values.length
  };
}

function uniqueWindCodeCount(payload) {
  const codes = new Set();
  for (const table of tables(payload)) {
    const index = table.columns.findIndex((column) => column.name === "Wind代码");
    if (index < 0) continue;
    for (const row of table.rows) if (row[index]) codes.add(row[index]);
  }
  return codes.size || null;
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
  const balance = (Number(limitUp) || 0) - (Number(limitDown) || 0) * 2;
  const tails = ((Number(bigUp) || 0) - (Number(bigDown) || 0)) / 5;
  return clamp(50 + balance / 2 + tails);
}

function scorePremium(premium) {
  return premium != null && Number.isFinite(Number(premium)) ? clamp(50 + Number(premium) * 12.5) : 50;
}

function scoreTheme(themes) {
  if (!themes.length) return 50;
  const first = Number(themes[0].changePct) || 0;
  const fifth = Number(themes[Math.min(4, themes.length - 1)].changePct) || 0;
  return clamp(42 + first * 4 + fifth * 2);
}

function classify(score, metrics) {
  if (score <= 28) return { phase: "冰点", posture: "观望", tone: "cold", summary: "极端亏钱效应占优，等待风险释放收敛。" };
  if (score <= 42) return { phase: "退潮", posture: "防守", tone: "risk", summary: "负反馈仍在扩散，优先降低接力和追高暴露。" };
  if (score <= 56) return { phase: "分歧", posture: "精选", tone: "watch", summary: "多空反馈混杂，只跟踪辨识度最高的核心。" };
  if (score <= 70) return { phase: "修复", posture: "试错", tone: "repair", summary: "赚钱效应开始恢复，但仍需确认持续性。" };
  if (score <= 86) return { phase: "主升", posture: "进攻", tone: "hot", summary: "广度、涨停和溢价形成正反馈，关注主线扩散。" };
  return Number(metrics.upRatio) >= 70
    ? { phase: "高潮", posture: "去弱留强", tone: "peak", summary: "一致性处于高位，机会与次日分歧风险同时放大。" }
    : { phase: "主升", posture: "进攻", tone: "hot", summary: "强势集中在局部方向，避免把结构行情当作全面高潮。" };
}

function normalizeThemes(payload) {
  return tables(payload).flatMap(objects).map((row) => ({
    code: row["Wind代码"],
    name: row["证券简称"],
    changePct: Number(Object.entries(row).find(([key]) => key.includes("涨跌幅"))?.[1]),
    tradeTime: row["交易时间"] || null
  })).filter((item) => item.code && item.name && Number.isFinite(item.changePct))
    .filter((item) => !/^\[(?:HK|US)\]/i.test(item.name)).slice(0, 10);
}

const anomalyThemeName = (value) => String(value || "").replace(/^[[^]]+]/, "").replace(/(?:Wind)?(?:概念)?指数$|概念板块$|板块$|精选$/g, "").trim();
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
  return Math.round(clamp(Math.min(74, nonLimitScore) + ladderBonus));
}
const ANOMALY_THEME_FAMILIES = [
  { id: "agriculture", name: "农业产业链", test: /中农发系|央企农业|农业农村部系|种植业|大豆|生物育种|一号文件|粮食|农业|农机|农垦|种业/ },
  { id: "robotics", name: "机器人产业链", test: /机器人|人形机器人|减速器|执行器|机器视觉|丝杠|关节/ },
  { id: "artificial-intelligence", name: "人工智能产业链", test: /AI应用|多模态|智能体|AIGC|算力|光通信|CPO|光模块|数据中心/ },
  { id: "semiconductor", name: "半导体产业链", test: /半导体|存储|HBM|芯片|集成电路|先进封装|晶圆|光刻/ },
  { id: "aerospace-defense", name: "航空航天与军工", test: /商业航天|卫星|航天|航空发动机|低空经济|军工|国防/ },
  { id: "healthcare", name: "医药产业链", test: /医药|医疗|创新药|CRO|CXO|ADC|中药|疫苗|医疗器械|生物制药/ },
  { id: "new-energy", name: "新能源产业链", test: /光伏|风电|锂电|储能|新能源车|电动车|充电桩/ },
  { id: "power-grid", name: "电力与电网产业链", test: /电力设备|电网|特高压|智能电网|发电运营|核电/ },
  { id: "automotive", name: "汽车智能化产业链", test: /华为汽车|汽车配件|智能驾驶|无人驾驶|汽车电子|车联网/ },
  { id: "materials", name: "有色与新材料", test: /有色|金属|稀土|铜|铝|黄金|碳纤维|超导|新材料/ },
  { id: "consumer", name: "消费产业链", test: /白酒|啤酒|食品|饮料|零售|旅游|酒店|家电|消费/ },
  { id: "finance", name: "金融科技与券商", test: /金融科技|证券|券商|保险|互金|支付/ }
];
const NON_NARRATIVE_ANOMALY_PATTERN = /转融券|融资融券|场外期权|挂钩标的|证券公司.*业务|股权激励|全样本|样本池|样本|金股|券商推荐|机构推荐|超涨|超跌|市场情绪|情绪指数|打板|连板|首板|涨停|跌停|炸板|破板|一字板|反包|领涨|龙头|中军|补涨|跟风|竞价|抢筹|趋势股|突破股|放量股|缩量股|高开|低开|非.?ST|ST股|强势股|活跃股|高换手|低换手|高价股|低价股|微盘股|小盘股|大盘股|绩优股|亏损股|昨日|近\d+日|龙虎榜|陆股通|基金重仓|机构重仓|北向重仓|高股息|红利|低波|动量|等权|全A|百元股|次新股|解禁|破净|破发|风格指数|成交额|成交量|换手率|振幅|涨速|量比|市值|市盈率|市净率|排名|排行|榜单|股票池|精选组合|策略指数|因子指数|点位贡献|预增|预减|含可转债|可转债正股|行业龙头|地方国企|华为平台|举牌/i;
function anomalyFamily(name) {
  return ANOMALY_THEME_FAMILIES.find((rule) => rule.test.test(name)) || null;
}
function selectPrimaryConcept(concepts, activeThemeNames) {
  const valid = concepts.filter((name) => name && !NON_NARRATIVE_ANOMALY_PATTERN.test(name));
  const active = activeThemeNames.map((name) => ({ name, family: anomalyFamily(name) }));
  return valid.map((name) => {
    const family = anomalyFamily(name);
    let score = 0;
    if (active.some((item) => item.name === name)) score += 120;
    if (family && active.some((item) => item.family?.id === family.id)) score += 80;
    if (family) score += 35;
    if (name.length >= 3 && name.length <= 10) score += 12;
    if (/产业链|产业|行业|设备|材料|科技|农业|医药|汽车|机器人|半导体|消费|能源/.test(name)) score += 8;
    if (/系$/.test(name)) score -= 4;
    return { name, score };
  }).sort((a, b) => b.score - a.score || a.name.length - b.name.length)[0]?.name || null;
}
function mergeAnomalyThemes(items) {
  const groups = new Map();
  for (const item of items) {
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
  }).filter((x) => x.code && x.name && (mode === "theme" ? Number.isFinite(x.shortMove) && !NON_NARRATIVE_ANOMALY_PATTERN.test(x.name) : !seen.has(x.code) && seen.add(x.code)))
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
function conceptsOf(payload) {
  const excluded = /全部A股|全A|基金重仓|陆股通|等权|动量|小市值|小盘股|私募重仓|融资融券|深股通|沪股通|综合$|可转债正股|预增|国资$/;
  const values = tables(payload).flatMap(objects).flatMap((row) => String(row["所属概念板块"] || "").split(/[;；]/));
  return [...new Set(values.map(anomalyThemeName).filter((x) => x && !excluded.test(x) && !NON_NARRATIVE_ANOMALY_PATTERN.test(x)))];
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
    const tradeTime = row["交易时间"] || row["指标时间"] || null;
    return {
      code: row["Wind代码"], name: row["证券简称"],
      changePct: findNumber("涨跌幅"), amount: findNumber("成交额"),
      turnover: findNumber("换手率"), volumeRatio: findNumber("量比"),
      price: findNumber("最新成交价", "成交价"), open: findNumber("今日开盘价", "开盘价"),
      high: findNumber("今日最高价", "最高价"), low: findNumber("今日最低价", "最低价"), tradeTime
    };
  }).filter((x) => x.code && x.name && Number.isFinite(x.changePct)
    && (!expectedDay || String(x.tradeTime || "").replace(/\D/g, "").startsWith(expectedDay)));
}
function stockRoleLayers(theme, rows) {
  const ignitionCodes = new Set(theme.limitStocks.map((x) => x.code));
  const usable = rows.filter((x) => !ignitionCodes.has(x.code) && !/^688/.test(String(x.code)) && x.changePct < 9.5);
  const followers = usable.filter((x) => x.changePct >= 3)
    .sort((a, b) => b.changePct - a.changePct || (b.amount || 0) - (a.amount || 0)).slice(0, 3)
    .map((x) => ({ ...x, role: "跟风", reason: "题材同步走强，尚未封板" }));
  const rideable = usable.filter((x) => x.changePct >= 1.5 && x.changePct <= 8.5)
    .map((x) => {
      const liquidity = x.amount == null ? 0 : Math.min(18, Math.log10(Math.max(x.amount, 1)) * 2);
      const activity = x.turnover == null ? 0 : Math.min(15, x.turnover * 1.2);
      return { ...x, candidateScore: Math.round(clamp(35 + x.changePct * 4 + liquidity + activity)) };
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
  return { followers, rideable };
}
async function enrichThemeCandidates(day, items) {
  const targets = items;
  const jobs = targets.flatMap((item) => (item.branches?.length ? item.branches : [{ name: item.name }]).slice(0, 4).map((branch) => ({ item, branch })));
  const results = await runWindTasks(jobs.map((job) => () => windCall("analytics_data", "get_financial_data", {
    question: `${job.branch.name}概念成分股最新涨跌幅排名前十，返回Wind代码、证券简称、最新成交价、今日开盘价、今日最高价、今日最低价、涨跌幅、成交额、换手率、量比和交易时间`
  }, 12_000)));
  const lookup = new Map(targets.map((item) => [item, { rows: [], errors: [] }]));
  jobs.forEach((job, index) => {
    const entry = lookup.get(job.item);
    entry.rows.push(...constituentRows(fulfilled(results[index]), day));
    if (reason(results[index])) entry.errors.push(reason(results[index]));
  });
  return items.map((item) => {
    const match = lookup.get(item);
    if (!match) return { ...item, followers: [], rideable: [], stockCoverage: "not_requested" };
    const rows = [...new Map(match.rows.sort((a, b) => b.changePct - a.changePct).map((row) => [row.code, row])).values()];
    const layers = stockRoleLayers(item, rows);
    const stockError = match.errors[0] || (!rows.length ? `NO_RESULTS: ${item.name}成分股涨跌幅未返回` : null);
    return { ...item, ...layers, stockCoverage: rows.length ? "available" : "unavailable", stockError };
  });
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
    limitStocks.forEach((stock) => {
      const name = selectPrimaryConcept(stock.concepts, activeThemeNames);
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
        const item = ensure(name);
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
    const rawItems = [...map.values()];
    const mergedItems = mergeAnomalyThemes(rawItems);
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
    }).filter((item) => item.tabScores.all >= ANOMALY_MIN_SCORE)
      .sort((a, b) => b.score - a.score || b.scoreBreakdown.ladderTotalBonus - a.scoreBreakdown.ladderTotalBonus || b.sortMetrics.limitCount - a.sortMetrics.limitCount).slice(0, ANOMALY_MAX_ITEMS);
    const items = await enrichThemeCandidates(day, rankedItems);
    const errors = results.map(reason).filter(Boolean);
    errors.push(...streakResult.errors);
    if (!streakDataComplete) errors.push("NO_RESULTS: 连板明细本次未返回，未将未知股票标记为首板");
    if (limitDataIncomplete) errors.push(limitDataSource.startsWith("last_valid_cache") ? "Wind实时涨停名单本次空返，已短暂保留30秒内最近一次有效点火数据" : "Wind实时涨停名单本次未返回有效数据");
    const streakCounts = limitStocks.reduce((counts, stock) => {
      const label = stock.streakLabel || "待确认";
      counts[label] = (counts[label] || 0) + 1;
      return counts;
    }, {});
    const output = { asOf: new Date().toISOString(), tradingDate: day, items,
      summary: { total: items.length, rawTotal: rawItems.length, mergedTotal: mergedItems.length, filteredOut: mergedItems.length - items.length, minScore: ANOMALY_MIN_SCORE, limitThemes: items.filter((x) => x.signals.includes("limit")).length, batchThemes: items.filter((x) => x.signals.includes("batch")).length, newsThemes: items.filter((x) => x.signals.includes("news")).length },
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

async function readHistory() {
  try {
    const parsed = JSON.parse(await fs.readFile(historyFile, "utf8"));
    return Array.isArray(parsed) ? parsed : [];
  } catch { return []; }
}

function trimHistory(history) {
  const retainedDays = [...new Set(history.map((item) => String(item.tradingDate || "")).filter(Boolean))]
    .sort().slice(-maxHistoryTradingDays);
  const retainedDaySet = new Set(retainedDays);
  return history.filter((item) => retainedDaySet.has(String(item.tradingDate || ""))).slice(-maxHistoryRecords);
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

async function appendHistory(snapshot) {
  await fs.mkdir(dataDir, { recursive: true });
  const history = await readHistory();
  const last = history.at(-1);
  const record = { tradingDate: snapshot.tradingDate, capturedAt: snapshot.capturedAt, quoteTime: snapshot.quoteTime, score: snapshot.score, phase: snapshot.regime.phase, up: snapshot.market.up, down: snapshot.market.down, limitUp: snapshot.extremes.limitUp, limitDown: snapshot.extremes.limitDown, premium: snapshot.profit.premium };
  if (!last || Date.parse(snapshot.capturedAt) - Date.parse(last.capturedAt) >= 120_000) history.push(record);
  else history[history.length - 1] = record;
  const trimmed = trimHistory(history);
  const temporary = `${historyFile}.tmp`;
  await fs.writeFile(temporary, JSON.stringify(trimmed, null, 2), "utf8");
  await fs.rename(temporary, historyFile);
  return trimmed;
}

async function loadEmotion(force = false) {
  if (!force && cachedEmotion && Date.now() - cachedAt < cacheTtlMs) return { ...cachedEmotion, cached: true };
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
    const limitUp = uniqueWindCodeCount(fulfilled(calls[1]));
    const limitDown = uniqueWindCodeCount(fulfilled(calls[2]));
    const bigUp = aggregatedStockCount(fulfilled(calls[3]), /涨幅大于5%.*家数$/);
    const bigDown = aggregatedStockCount(fulfilled(calls[4]), /跌幅大于5%.*家数$/);
    const premiumDetail = averageColumn(fulfilled(calls[5]), /^(?:(?:最新|今日|当日).*|\d{8}|\d{4}年\d{1,2}月\d{1,2}日)涨跌幅$/);
    const premium = premiumDetail.value;
    const themes = normalizeThemes(fulfilled(calls[6]));
    const up = Number(indexRow["上涨家数"]);
    const down = Number(indexRow["下跌家数"]);
    const flat = Number(indexRow["平盘家数"]);
    const upRatio = Number.isFinite(up + down) && up + down > 0 ? up / (up + down) * 100 : null;
    const dimensions = { breadth: Math.round(scoreBreadth(up, down)), limits: Math.round(scoreLimit(limitUp, limitDown, bigUp, bigDown)), ladder: 50, profit: Math.round(scorePremium(premium)), themes: Math.round(scoreTheme(themes)), liquidity: 50 };
    const score = Math.round(clamp(dimensions.breadth * .15 + dimensions.limits * .20 + dimensions.ladder * .20 + dimensions.profit * .20 + dimensions.themes * .15 + dimensions.liquidity * .10));
    const regime = classify(score, { upRatio });
    const errors = calls.map(reason).filter(Boolean);
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
      dimensions,
      market: { index: Number(indexRow["最新成交价"]), changePct: Number(indexRow["涨跌幅"]), amount: Number(indexRow["成交额"]), up: Number.isFinite(up) ? up : null, down: Number.isFinite(down) ? down : null, flat: Number.isFinite(flat) ? flat : null, upRatio },
      extremes: { limitUp, limitDown, bigUp, bigDown },
      profit: { premium, sampleSize: premiumDetail.sampleSize, baseTradingDate: previousDay, currentTradingDate: day, method: "前一交易日涨停股票今日涨跌幅等权平均" },
      themes,
      coverage: [
        { name: "市场广度", status: indexPayload ? "direct" : "error", note: "全A指数直接返回上涨、下跌、平盘与成交额" },
        { name: "涨跌停与大涨大跌", status: [limitUp, limitDown, bigUp, bigDown].some((item) => item != null) ? "direct" : "error", note: "Wind结构化取数" },
        { name: "昨日涨停溢价", status: premium != null ? "derived" : "error", note: premium != null ? "Wind明细本地等权平均（" + premiumDetail.sampleSize + "只）" : "Wind未返回前一交易日涨停股今日涨跌幅明细" },
        { name: "连板与晋级率", status: "derived", note: "下一阶段由多日涨停名单本地计算" },
        { name: "炸板率与盘中曲线", status: "derived", note: "依赖分钟级快照持续沉淀" },
        { name: "L2排撤单", status: "limited", note: "需要额外高频或L2数据授权" }
      ],
      errors,
      partial: errors.length > 0
    };
    snapshot.history = await appendHistory(snapshot);
    snapshot.dailyHistory = aggregateDailyHistory(snapshot.history);
    cachedEmotion = snapshot;
    cachedAt = Date.now();
    return snapshot;
  })().finally(() => { inflight = null; });
  return inflight;
}

async function loadNews() {
  const payload = await windCall("financial_docs", "get_financial_news", { query: `${localDate()}A股市场热点催化`, top_k: 5 });
  return payload?.data?.items || payload?.data?.data?.items || [];
}

async function serveStatic(res, url) {
  const requestPath = url.pathname === "/" ? "/index.html" : url.pathname;
  const resolved = path.resolve(publicDir, `.${decodeURIComponent(requestPath)}`);
  if (!resolved.startsWith(path.resolve(publicDir))) return json(res, 403, { error: "禁止访问" });
  try {
    const body = await fs.readFile(resolved);
    res.writeHead(200, { "Content-Type": mimeTypes[path.extname(resolved)] || "application/octet-stream", "Content-Length": body.length, "Cache-Control": path.extname(resolved) === ".html" ? "no-store" : "public, max-age=300" });
    res.end(body);
  } catch (error) {
    if (error?.code === "ENOENT") return json(res, 404, { error: "页面不存在" });
    throw error;
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || `127.0.0.1:${port}`}`);
  try {
    if (req.method === "GET" && url.pathname === "/api/health") {
      let windReady = true;
      try { await fs.access(windCli); } catch { windReady = false; }
      return json(res, 200, { ok: true, windReady, port });
    }
    if (req.method === "GET" && url.pathname === "/api/emotion") return json(res, 200, await loadEmotion(url.searchParams.get("refresh") === "1"));
    if (req.method === "GET" && url.pathname === "/api/anomalies") return json(res, 200, await loadThemeAnomalies(url.searchParams.get("refresh") === "1"));
    if (req.method === "POST" && url.pathname === "/api/export-image") return await exportEmotionPng(req, res);
    if (req.method === "GET" && url.pathname === "/api/history") {
      const history = await readHistory();
      return json(res, 200, { history, dailyHistory: aggregateDailyHistory(history) });
    }
    if (req.method === "GET" && url.pathname === "/api/news") return json(res, 200, { items: await loadNews() });
    if (url.pathname.startsWith("/api/")) return json(res, 404, { error: "接口不存在" });
    return await serveStatic(res, url);
  } catch (error) {
    return json(res, 500, { error: error instanceof Error ? error.message : String(error) });
  }
});

server.listen(port, "127.0.0.1", () => console.log(`Wind短线情绪观测工作台：http://127.0.0.1:${port}`));
function shutdown() { server.close(() => process.exit(0)); }
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
