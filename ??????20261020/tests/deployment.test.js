// 独立部署的配置检查：网址路由（vercel.json）、数据任务（GitHub Actions）、仓库名。
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(__dirname, "..");
const workflow = readFileSync(resolve(root, ".github/workflows/short-emotion.yml"), "utf8");
const vercel = JSON.parse(readFileSync(resolve(root, "vercel.json"), "utf8"));

const SHORT_EMOTION_CRON = "0,30 1-7 * * 1-5";
const PAGE = "/short-emotion/index.html";

describe("网址（A股 / 台股）", () => {
  const rewrites = Object.fromEntries((vercel.rewrites || []).map((r) => [r.source, r.destination]));
  const redirects = Object.fromEntries((vercel.redirects || []).map((r) => [r.source, r.destination]));

  it("首页、/cn、/tw 都由同一个页面提供", () => {
    for (const path of ["/", "/cn", "/cn/", "/tw", "/tw/"]) expect(rewrites[path]).toBe(PAGE);
  });

  it("TWSVP 时期的旧网址跳到新网址", () => {
    expect(redirects["/cn-short-emotion"]).toBe("/cn");
    expect(redirects["/cn-short-emotion/"]).toBe("/cn");
    expect(redirects["/tw-short-emotion"]).toBe("/tw");
    expect(redirects["/tw-short-emotion/"]).toBe("/tw");
    expect(redirects["/short-emotion"]).toBe("/cn");
  });

  it("页面按路径识别市场：/tw 和旧的 /tw-short-emotion 是台股，其余是 A股", () => {
    const html = readFileSync(resolve(root, "public/short-emotion/index.html"), "utf8");
    const pattern = new RegExp(html.match(/root\.dataset\.market = \/(.+?)\/\.test/)[1]);
    for (const path of ["/tw", "/tw/", "/tw-short-emotion", "/tw-short-emotion/"]) expect(pattern.test(path)).toBe(true);
    for (const path of ["/", "/cn", "/cn/", "/twxyz", "/short-emotion/index.html"]) expect(pattern.test(path)).toBe(false);
    // app.js 用同一个判断
    const app = readFileSync(resolve(root, "public/short-emotion/app.js"), "utf8");
    expect(app.split(pattern.source).length - 1).toBe(2);
  });

  it("页面引用的静态文件都存在", () => {
    const html = readFileSync(resolve(root, "public/short-emotion/index.html"), "utf8");
    const refs = [...html.matchAll(/(?:href|src)="(\/short-emotion\/[^"?]+)/g)].map((m) => m[1]);
    expect(refs.length).toBeGreaterThan(3);
    for (const ref of refs) expect(() => readFileSync(resolve(root, "public", `.${ref}`))).not.toThrow();
  });
});

describe("数据任务（GitHub Actions）", () => {
  it("工作日 09:00–15:30（北京时间）每 30 分钟运行", () => {
    const schedules = [...workflow.matchAll(/-\s*cron:\s*"([^"]+)"/g)].map((m) => m[1]);
    expect(schedules).toEqual([SHORT_EMOTION_CRON]);
    expect(workflow).toContain(`github.event.schedule == '${SHORT_EMOTION_CRON}'`);
  });

  it("手动运行的参数与页面「刷新」发送的一致，标题带市场", async () => {
    for (const input of ["target:", "force:", "market:"]) expect(workflow).toContain(`      ${input}`);
    expect(workflow).toContain("format('short-emotion {0} refresh', inputs.market)");
  });

  it("vercel.json 没有定时任务（Hobby 计划不支持每天多次）", () => {
    expect(vercel.crons).toBeUndefined();
  });
});

describe("仓库", () => {
  it("刷新与读数据都指向 leemuweiuiux/ShortEmotion", async () => {
    delete process.env.SHORT_EMOTION_REPO;
    const github = await import("../api/_lib/short-emotion/github.js");
    expect(github.DATA_RAW_BASE).toBe("https://raw.githubusercontent.com/leemuweiuiux/ShortEmotion");

    process.env.GITHUB_ACTIONS_TOKEN = "test-token";
    const calls = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = async (url, options = {}) => {
      calls.push(String(url));
      if (String(url).includes("/runs?")) return new Response(JSON.stringify({ workflow_runs: [] }), { status: 200 });
      return new Response(null, { status: 204 });
    };
    try {
      await github.requestRefresh("cn");
    } finally {
      globalThis.fetch = realFetch;
      delete process.env.GITHUB_ACTIONS_TOKEN;
    }
    expect(calls.at(-1)).toBe("https://api.github.com/repos/leemuweiuiux/ShortEmotion/actions/workflows/short-emotion.yml/dispatches");
  });
});
