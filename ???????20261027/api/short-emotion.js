// 短线情绪工作台 — 页面接口（/cn A股、/tw 台股）
//
// GET  /api/short-emotion?market=cn|tw&resource=emotion|anomalies|history|news|status
//      读取定时任务写入数据分支的快照，不调用 Wind；CDN 缓存 2 分钟。带 fresh=1 时跳过缓存（刷新完成后读取）。
// GET  /api/short-emotion?market=cn|tw&resource=refresh-status
//      最近一次手动刷新任务的状态（排队中 / 获取中 / 完成）。
// POST /api/short-emotion?market=cn|tw&action=refresh
//      用户点「刷新」：触发 GitHub Actions 数据任务，真实调用 Wind MCP 并写入新快照。
import { readResource, runScheduledRefresh, NotReadyError, normalizeMarket } from "./_lib/short-emotion/service.js";
import { requestRefresh, latestRefreshRun, githubToken } from "./_lib/short-emotion/github.js";

const RESOURCES = new Set(["emotion", "anomalies", "history", "news", "fund-flow", "limitup", "status", "refresh-status"]);

// 本地模式（未配置 GITHUB_ACTIONS_TOKEN）下，最近一次「点击刷新」直接在本进程调用 Wind 取数。
// 记录完成态供前端轮询 refresh-status 收尾；进程重启后清空（下一次点击刷新会重建）。
let localRefreshState = { at: 0, ok: false };

/**
 * 触发一次真实刷新：
 * - 有 GITHUB_ACTIONS_TOKEN（线上 Vercel）→ 触发 GitHub Actions 数据任务；
 * - 无 token（本地预览）→ 当前进程直接跑 force 取数，写入本地 store。
 */
async function dispatchRefresh(market) {
  if (githubToken()) return requestRefresh(market);
  const started = Date.now();
  const output = await runScheduledRefresh({ force: true, market });
  const ok = !(output.status === "error" && !(output.ran || []).length);
  localRefreshState = { at: Date.now(), ok };
  // 盘后收缩（当日已有收盘快照时仅更新新闻）通过 skipped 告诉前端，避免误以为行情已刷新。
  const skipped = (output.skipped || []).filter((item) => !item.startsWith("cleanup"));
  return {
    dispatched: true,
    requestedAt: new Date(started).toISOString(),
    mode: "local",
    ok,
    ran: output.ran || [],
    skipped,
    errors: (output.errors || []).slice(0, 10)
  };
}

function fail(res, error) {
  const notReady = error instanceof NotReadyError;
  const code = notReady ? "not_ready" : error?.code || "server_error";
  res.setHeader("Cache-Control", notReady ? "public, max-age=0, s-maxage=60" : "no-store");
  res.status(notReady ? 503 : error?.statusCode || 500).json({ error: error instanceof Error ? error.message : String(error), code });
}

export default async function handler(req, res) {
  let market;
  try {
    market = normalizeMarket(req.query?.market);
  } catch {
    res.status(404).json({ error: "市场不存在" });
    return;
  }

  if (req.method === "POST") {
    if (req.query?.action !== "refresh") {
      res.status(404).json({ error: "接口不存在" });
      return;
    }
    res.setHeader("Cache-Control", "no-store");
    try {
      res.status(202).json({ market, ...(await dispatchRefresh(market)) });
    } catch (error) {
      fail(res, error);
    }
    return;
  }

  if (req.method !== "GET") {
    res.setHeader("Allow", "GET, POST");
    res.status(405).json({ error: "Method Not Allowed" });
    return;
  }

  const resource = String(req.query?.resource || "emotion");
  if (!RESOURCES.has(resource)) {
    res.status(404).json({ error: "接口不存在" });
    return;
  }

  if (resource === "refresh-status") {
    res.setHeader("Cache-Control", "no-store");
    if (!githubToken()) {
      // 本地模式：没有 GitHub 任务可查。返回最近一次本地刷新的完成态（10 分钟内），让前端收尾读新快照。
      const fresh = localRefreshState.at > 0 && Date.now() - localRefreshState.at < 10 * 60_000;
      res.status(200).json({
        market,
        configured: false,
        mode: "local",
        run: fresh
          ? { id: "local", status: "completed", conclusion: localRefreshState.ok ? "success" : "failure", created_at: new Date(localRefreshState.at - 60_000).toISOString(), updated_at: new Date(localRefreshState.at).toISOString(), run_started_at: new Date(localRefreshState.at - 60_000).toISOString() }
          : null
      });
      return;
    }
    try {
      res.status(200).json({ market, configured: true, run: await latestRefreshRun(market) });
    } catch (error) {
      fail(res, error);
    }
    return;
  }

  const fresh = req.query?.fresh === "1";
  try {
    const payload = await readResource(resource, market, { fresh });
    res.setHeader("Cache-Control", resource === "status" || fresh
      ? "no-store"
      : "public, max-age=0, s-maxage=120, stale-while-revalidate=600");
    res.status(200).json(payload);
  } catch (error) {
    fail(res, error);
  }
}
