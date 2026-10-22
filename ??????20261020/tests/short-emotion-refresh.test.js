// @vitest-environment node
import handler from "../api/short-emotion.js";

function call(method, query) {
  return new Promise((resolve) => {
    const res = {
      headers: {},
      statusCode: 200,
      setHeader(key, value) { this.headers[key] = value; },
      status(code) { this.statusCode = code; return this; },
      json(body) { resolve({ status: this.statusCode, body, headers: this.headers }); return this; }
    };
    handler({ method, query }, res);
  });
}

describe("short-emotion refresh API", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
    delete process.env.GITHUB_ACTIONS_TOKEN;
  });

  it("runs a local refresh without a GitHub token", async () => {
    const status = await call("GET", { market: "tw", resource: "refresh-status" });
    expect(status.body).toMatchObject({ configured: false, run: null });
    const refresh = await call("POST", { market: "tw", action: "refresh" });
    // 无 GITHUB_ACTIONS_TOKEN → 本地模式：直接在当前进程跑 force 取数（202），不再要求 GitHub 配置。
    expect(refresh.status).toBe(202);
    expect(refresh.body).toMatchObject({ dispatched: true, mode: "local" });
  });

  it("dispatches the data job for the market, and reuses a running one", async () => {
    process.env.GITHUB_ACTIONS_TOKEN = "test-token";
    const calls = [];
    let runs = [];
    globalThis.fetch = async (url, options = {}) => {
      calls.push({ url: String(url), method: options.method || "GET", body: options.body });
      if (String(url).includes("/runs?")) return new Response(JSON.stringify({ workflow_runs: runs }), { status: 200 });
      if (String(url).endsWith("/dispatches")) return new Response(null, { status: 204 });
      return new Response("{}", { status: 404 });
    };
    const first = await call("POST", { market: "tw", action: "refresh" });
    expect(first.status).toBe(202);
    expect(first.body.dispatched).toBe(true);
    const dispatch = calls.find((item) => item.url.endsWith("/dispatches"));
    expect(JSON.parse(dispatch.body).inputs).toMatchObject({ target: "short-emotion", market: "tw" });

    runs = [{ id: 7, display_title: "short-emotion tw refresh", status: "in_progress", conclusion: null, created_at: new Date().toISOString(), updated_at: new Date().toISOString() }];
    const second = await call("POST", { market: "tw", action: "refresh" });
    expect(second.body).toMatchObject({ dispatched: false, reason: "running", run: { id: 7 } });
    const cn = await call("GET", { market: "cn", resource: "refresh-status" });
    expect(cn.body.run).toBeNull();
  });
});
