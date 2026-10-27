// 短线情绪工作台 — 定时刷新（由 .github/workflows/short-emotion.yml 在 GitHub Actions 中运行）
//
// 读取 short-emotion-data 分支检出的目录（SHORT_EMOTION_DATA_DIR），按 schedule.js 判断本时段
// 该跑哪些任务、调用 Wind 计算快照并写回该目录；工作流随后把目录推回数据分支。
// 页面（/cn、/tw）只从数据分支读取，不调用 Wind。
//
// 用法：node scripts/short-emotion/refresh.mjs [--force] [--market=cn|tw|all]
//   --force   忽略时间窗口立即刷新全部数据（手动触发时使用）
//   --market  默认 all：A股写在数据目录根部，台股写在 tw/ 子目录
import { readFile } from "node:fs/promises";

process.env.SHORT_EMOTION_STORE ||= "file";
process.env.SHORT_EMOTION_DATA_DIR ||= "short-emotion-data";

const { getStore } = await import("../../api/_lib/short-emotion/store.js");
const { isTradingSessionHistory } = await import("../../api/_lib/short-emotion/engine.js");
const { runScheduledRefresh } = await import("../../api/_lib/short-emotion/service.js");

const args = process.argv.slice(2);
const force = args.includes("--force");
const marketArg = (args.find((arg) => arg.startsWith("--market=")) || "--market=all").split("=")[1];
const markets = marketArg === "all" ? ["cn", "tw"] : [marketArg];

// 首次运行：导入原工作台 2026-08-18 至 09-03 的 A股盘中快照，作为「每日」曲线的起点。
if (markets.includes("cn")) {
  const store = getStore("cn");
  if (!(await store.historyLatestDate())) {
    const seed = JSON.parse(await readFile(new URL("./seed-history.json", import.meta.url), "utf8"));
    for (const record of seed) await store.historyUpsert(record, isTradingSessionHistory(record));
    console.log(`seeded ${seed.length} history records`);
  }
}

// 两个市场互不影响：一个失败不阻止另一个更新，最后统一报告。
const failures = [];
for (const market of markets) {
  const result = await runScheduledRefresh({ force, market });
  console.log(JSON.stringify(result, null, 2));
  if (result.status === "error") failures.push(`${market}: ${result.errors.join(" | ")}`);
}
if (failures.length) {
  console.error(`::error::短线情绪刷新失败：${failures.join(" || ")}`);
  process.exit(1);
}
