// 本地构建涨停事件快照：取数 → 计算 → 落库（仅本地验证用，不接定时任务）。
// 用法：node --env-file=.env scripts/limitup/build.mjs [YYYYMMDD]
import { resolve } from "node:path";
import { loadLimitUpBoard, localDate, quoteDayOf, snapshotDayMismatch } from "../../api/_lib/short-emotion/limit-engine.js";

const argDay = String(process.argv[2] || "");
const day = /^\d{8}$/.test(argDay) ? argDay : null;

// 与 dev-server 一致：本地固定 file 模式，写入 SHORT_EMOTION_DATA_DIR（默认 ./short-emotion-data）
if (!process.env.SHORT_EMOTION_STORE) process.env.SHORT_EMOTION_STORE = "file";
if (!process.env.SHORT_EMOTION_DATA_DIR) process.env.SHORT_EMOTION_DATA_DIR = resolve("short-emotion-data");
const { getStore } = await import("../../api/_lib/short-emotion/store.js");

const dataDir = resolve(process.env.SHORT_EMOTION_DATA_DIR);
const kvDir = resolve(dataDir, "kv");

console.log(`构建涨停事件快照${day ? ` ${day}` : "（今日）"} → ${kvDir}`);

const board = await loadLimitUpBoard(day || undefined);

// 非交易时段（盘前 / 周末）Wind 返回的还是上一交易日的收盘快照。
// 板块以「行情日期」为交易日落库，所以这里只提示、不拦写盘：写成上一交易日是对的。
const requestedDay = day || localDate();
const staleQuotes = snapshotDayMismatch(board.quoteTime, requestedDay);

// 板高文案：1 板统一叫「首板」，控制台也不该出现「1板」
const boardText = (streak) => (Number(streak) >= 2 ? `${Number(streak)}板` : "首板");

// ── 控制台报告 ──────────────────────────────────────────────────────────
console.log("");
console.log(`交易日 ${board.tradingDate} | 行情时间 ${board.quoteTime || "-"} | 降级 ${board.degraded}`);
if (staleQuotes) {
  console.log(`ℹ 行情仍是 ${quoteDayOf(board.quoteTime)} 收盘（本地 ${requestedDay}，非交易时段），快照按行情日期落库。`);
}
console.log(`涨停 ${board.summary.limitUpCount} 家 | 最高 ${boardText(board.summary.maxStreak)} | 梯队深度 ${board.summary.ladderDepth} | 早盘(≤10:00)封板 ${board.summary.firstSealCount} 家 | 已剔除 ST ${board.summary.stCount} 家`);
const previousDown = board.summary.previousLimitDownCount;
console.log(`跌停 ${board.summary.limitDownCount} 家${previousDown == null ? "" : `（上日 ${previousDown} 家）`} | 涨跌停差 ${board.summary.upDownNet} | 已剔除 ST ${board.summary.limitDownStCount ?? 0} 家 | 负反馈题材 ${board.summary.negativeFeedbackThemes ?? 0} 个`);
console.log(`一字板 ${board.summary.auctionSealCount ?? 0} 家（集合竞价直接封板）`);
if (board.premium) {
  const { premium } = board;
  console.log(`昨日涨停溢价${premium.complete ? "" : "（护栏未通过）"}: ${premium.sampleSize} 只样本，中位数 ${premium.median == null ? "-" : `${premium.median}%`}，上涨占比 ${premium.upRatio == null ? "-" : (premium.upRatio * 100).toFixed(0) + "%"}`);
  console.log(`  首板 ${premium.first.count} 只 中位数 ${premium.first.median == null ? "-" : `${premium.first.median}%`} | 连板 ${premium.ladder.count} 只 中位数 ${premium.ladder.median == null ? "-" : `${premium.ladder.median}%`}`);
  console.log(premium.auction
    ? `  竞价溢价：${premium.auction.sampleSize} 只样本，开盘涨幅中位数 ${premium.auction.median}%`
    : `  竞价溢价：未取到（${premium.auctionError || "措辞待验证"}）`);
  if (premium.error) console.log(`  ! ${premium.error}`);
} else {
  console.log("昨日涨停溢价: 未取数（盘前构建或缺少昨日涨停名单）");
}
console.log(`资讯复核 ${board.summary.newsConceptReviewed ?? 0} 只（断板→连板→首板） | 资讯定题材 ${board.summary.newsConceptFilled ?? 0} 只${board.summary.newsConceptAborted ? " | 已熔断" : ""}`);
console.log(`主营复核 ${board.summary.brandConceptChecked ?? 0} 只 | 剔除无主营支撑的集团品牌标签 ${board.summary.brandConceptPruned ?? 0} 只${board.summary.brandConceptSkipped ? "（资讯熔断，已跳过）" : ""}`);
console.log("");
console.log("今日亮点:");
for (const item of board.highlights || []) console.log(`  [${item.tone}] ${item.title} — ${item.detail}`);

console.log("");
if (board.brokenStreaks) {
  const { broken, streak, brokenCount, totalCount } = board.brokenStreaks;
  console.log(`断板：昨日 ${boardText(streak)} ${brokenCount}/${totalCount} 家未晋级 — ${broken.map((item) => `${item.name ? `${item.name}(${item.code})` : item.code}${item.concept ? `[${item.concept}]` : ""}`).join(" ")}`);
}
console.log("涨停天梯:");
for (const tier of board.ladder) console.log(`  ${tier.label.padEnd(6)} ${String(tier.count).padStart(3)} 家  ${tier.stocks.slice(0, 8).join(" ")}${tier.stocks.length > 8 ? " …" : ""}`);
console.log("");
console.log("封板时间分布:");
for (const bucket of board.sealTimeBuckets) console.log(`  ${bucket.label.padEnd(14)} ${String(bucket.count).padStart(3)} 家`);
console.log("");
console.log("概念题材聚合 Top15（★=白名单 ⚠=负反馈；强弱状态与跌停/断板已并进同一行）:");
for (const concept of board.concepts.slice(0, 15)) {
  const mark = concept.negativeFeedback ? "⚠" : concept.whitelist ? "★" : " ";
  const weak = [
    concept.downCount ? `跌停${concept.downCount}` : null,
    concept.brokenCount ? `断板${concept.brokenCount}` : null,
    concept.previousUpCount ? `昨日${concept.previousUpCount}家` : null
  ].filter(Boolean).join(" ");
  console.log(`  ${mark} ${String(concept.status || "-").padEnd(2)} ${concept.name.padEnd(16)} 涨停${String(concept.limitCount).padStart(3)}家 最高${boardText(concept.maxStreak)} 首封${concept.firstSealTime || "-"} ${weak}`);
}
console.log("");
console.log("题材强弱全量（含只有跌停、没有涨停的弱方向）:");
for (const theme of (board.themeStrength || []).slice(0, 15)) {
  console.log(`  ${String(theme.status).padEnd(2)} ${theme.negativeFeedback ? "⚠" : " "} ${theme.name.padEnd(16)} 涨停${String(theme.upCount).padStart(3)} 跌停${String(theme.downCount).padStart(3)} 断板${String(theme.brokenCount).padStart(3)} 昨日${String(theme.previousUpCount).padStart(3)}家 最高${boardText(theme.maxUpStreak)}`);
}
console.log("");
console.log(`跌停股 ${board.limitDown?.count ?? 0} 家:`);
for (const stock of board.limitDown?.stocks || []) console.log(`  ${stock.name}(${stock.code}) ${stock.boardType} ${stock.downTime || "-"} ${stock.concepts.slice(0, 3).join("/") || "无题材"}`);
console.log("");
const { promotion } = board;
console.log(`晋级率（基准 ${promotion.baseTradingDate || "-"}，基准涨停 ${promotion.baseLimitUpCount} 家）: 整体 ${promotion.overallRate == null ? "-" : (promotion.overallRate * 100).toFixed(1) + "%"}`);
for (const tier of promotion.tiers) console.log(`  ${tier.label.padEnd(6)} ${String(tier.promotedCount).padStart(3)}/${String(tier.baseCount).padEnd(3)} = ${tier.rate == null ? "-" : (tier.rate * 100).toFixed(1) + "%"}`);
if (promotion.tiers.length) console.log(`  晋级个股: ${promotion.promoted.map((item) => `${item.code}(${item.fromStreak}→${item.toStreak})`).join(" ") || "无"}`);
if (board.errors.length) {
  console.log("");
  console.log("告警:");
  board.errors.forEach((message) => console.log(`  ! ${message}`));
}

// ── 落库 ────────────────────────────────────────────────────────────────
if (board.degraded) {
  console.log("");
  console.log("⚠ 结果降级（0 只涨停），为避免污染快照，跳过写盘。");
  process.exit(1);
}
// 必须走 store.kvSet：它会包一层 { value, updatedAt }，与 readResource 的读取格式一致。
// 直接写裸 JSON 会让 /api/short-emotion?resource=limitup 读到 undefined。
const store = getStore("cn");
console.log("");
console.log("落库:");
for (const key of ["limitup:latest", `limitup:day:${board.tradingDate}`]) {
  await store.kvSet(key, board);
  console.log(`  写入 ${key} → ${kvDir} (${JSON.stringify(board).length} bytes)`);
}
process.exit(0);
