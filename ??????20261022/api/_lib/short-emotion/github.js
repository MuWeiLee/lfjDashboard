// 「刷新」= 真实调用 Wind MCP：Vercel 通过 GitHub API 触发数据任务（short-emotion.yml 的手动运行），
// 任务在 GitHub Actions 里取 Wind 数据、写入 short-emotion-data 分支，页面轮询任务状态后读取新快照。
//
// 需要 Vercel 环境变量 GITHUB_ACTIONS_TOKEN（或 GITHUB_ACTION_TOKEN）：GitHub fine-grained token，只授权本仓库，
// 权限 Actions: Read and write、Contents: Read。未配置时刷新返回 not_configured。
const REPO = process.env.SHORT_EMOTION_REPO || "leemuweiuiux/ShortEmotion";
const WORKFLOW = "short-emotion.yml";
const DATA_BRANCH = "short-emotion-data";
const API = "https://api.github.com";

export function githubToken(env = process.env) {
  return String(env.GITHUB_ACTIONS_TOKEN || env.GITHUB_ACTION_TOKEN || "").trim() || null;
}

async function github(path, { method = "GET", body } = {}) {
  const token = githubToken();
  if (!token) throw Object.assign(new Error("刷新服务未配置（缺少 GITHUB_ACTIONS_TOKEN）"), { code: "not_configured", statusCode: 501 });
  const response = await fetch(`${API}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "shortemotion",
      ...(body ? { "Content-Type": "application/json" } : {})
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(10_000)
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw Object.assign(new Error(`GitHub ${method} ${path.split("?")[0]} ${response.status}: ${text.slice(0, 160)}`), { statusCode: 502 });
  }
  return response.status === 204 ? null : response.json();
}

// 手动运行的标题里带市场（见工作流 run-name），据此区分 A股 / 台股。
const runTitle = (market) => `short-emotion ${market} refresh`;

function summarizeRun(run) {
  if (!run) return null;
  return {
    id: run.id,
    status: run.status, // queued | in_progress | completed
    conclusion: run.conclusion, // success | failure | cancelled | null
    createdAt: run.created_at,
    updatedAt: run.updated_at,
    startedAt: run.run_started_at || null
  };
}

/** 最近一次该市场的手动刷新任务。 */
export async function latestRefreshRun(market) {
  const payload = await github(`/repos/${REPO}/actions/workflows/${WORKFLOW}/runs?event=workflow_dispatch&per_page=15`);
  const run = (payload?.workflow_runs || []).find((item) => String(item.display_title || item.name || "").includes(runTitle(market)));
  return summarizeRun(run);
}

const ACTIVE = new Set(["queued", "in_progress", "waiting", "requested", "pending"]);
// 同一市场 2 分钟内只触发一次，多个用户同时点刷新时共用同一次更新，避免重复消耗 Wind 额度。
const MIN_INTERVAL_MS = 2 * 60_000;

/** 触发一次真实刷新；已有进行中或刚完成的刷新时直接复用。 */
export async function requestRefresh(market) {
  const latest = await latestRefreshRun(market).catch(() => null);
  if (latest && ACTIVE.has(latest.status)) return { dispatched: false, reason: "running", run: latest };
  if (latest && Date.now() - Date.parse(latest.createdAt) < MIN_INTERVAL_MS) return { dispatched: false, reason: "recent", run: latest };
  const requestedAt = new Date().toISOString();
  await github(`/repos/${REPO}/actions/workflows/${WORKFLOW}/dispatches`, {
    method: "POST",
    body: { ref: "main", inputs: { target: "short-emotion", force: "true", market } }
  });
  return { dispatched: true, requestedAt, run: null };
}

/** 数据分支最新提交（读快照时按提交读取，绕开 raw.githubusercontent.com 约 5 分钟的缓存）。 */
export async function dataBranchHead() {
  const payload = await github(`/repos/${REPO}/git/ref/heads/${DATA_BRANCH}`);
  return payload?.object?.sha || null;
}

export const DATA_RAW_BASE = `https://raw.githubusercontent.com/${REPO}`;
export { DATA_BRANCH };
