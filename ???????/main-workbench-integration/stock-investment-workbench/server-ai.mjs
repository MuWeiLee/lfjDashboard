import http from "node:http";
import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createAiDecisionEngine } from "./ai-decision-engine.mjs";
import { createSelectionBacktest } from "./ai-selection-backtest.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const externalPort = Number(process.env.PORT || 4310);
const innerPort = Number(process.env.AI_INNER_PORT || 4312);
const corePort = Number(process.env.INTERNAL_PORT || 4311);
const innerOrigin = `http://127.0.0.1:${innerPort}`;
const aiStateFile = path.join(__dirname, "data", "ai-decision.json");
const backtestStateFile = path.join(__dirname, "data", "ai-selection-backtest.json");
const skillDir = process.env.WIND_MCP_SKILL_DIR || path.join(os.homedir(), ".agents", "skills", "wind-mcp-skill");
const windCli = path.join(skillDir, "scripts", "cli.mjs");

const WIND_MAX_CONCURRENCY = 2;
let windActiveCalls = 0;
const windWaiters = [];

async function withWindSlot(task) {
  if (windActiveCalls >= WIND_MAX_CONCURRENCY) {
    await new Promise((resolve) => windWaiters.push(resolve));
  }
  windActiveCalls += 1;
  try {
    return await task();
  } finally {
    windActiveCalls -= 1;
    windWaiters.shift()?.();
  }
}

function safeError(error) {
  const message = error instanceof Error ? error.message : String(error);
  return message.replaceAll(skillDir, "[wind-mcp-skill]").slice(0, 1200);
}

function sendJson(res, status, payload) {
  const body = Buffer.from(JSON.stringify(payload));
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Content-Length": body.length, "Cache-Control": "no-store" });
  res.end(body);
}

async function readRequestBody(req, limit = 25 * 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new Error("复盘内容过长，无法导出图片");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function exportReviewPng(req, res) {
  const payload = JSON.parse((await readRequestBody(req)).toString("utf8"));
  const width = Math.max(640, Math.min(900, Number(payload.width) || 750));
  if (!payload.html || typeof payload.html !== "string") throw new Error("没有可导出的复盘内容");
  const edgeCandidates = ["C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe", "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe"];
  let edge;
  for (const candidate of edgeCandidates) { try { await fs.access(candidate); edge = candidate; break; } catch {} }
  if (!edge) throw new Error("未找到 Microsoft Edge，无法生成图片");
  const jobDir = await fs.mkdtemp(path.join(os.tmpdir(), "wind-review-export-"));
  const htmlFile = path.join(jobDir, "review.html");
  const pngFile = path.join(jobDir, "review.png");
  const croppedPngFile = path.join(jobDir, "review-cropped.png");
  const css = `
    html,body{margin:0;padding:0;width:100%;max-width:100%;background:#fff;color:#173442;overflow-x:hidden;font-family:"Microsoft YaHei","PingFang SC",Arial,sans-serif;-webkit-font-smoothing:antialiased}
    *{box-sizing:border-box;min-width:0;height:auto!important;max-height:none!important}
    .ai-review-report{display:block;width:100%;max-width:100%;margin:0;padding:112px 16px 52px 32px;background:#fff;overflow:hidden;position:relative}
    .ai-review-report>header,.ai-review-lead,.ai-review-article,.ai-review-tomorrow,.ai-review-closing{display:block;width:100%;max-width:none;margin:0;padding-left:0;padding-right:0}
    .ai-export-brand{position:absolute;top:34px;right:24px;display:flex;align-items:center;gap:10px;color:#123847;opacity:.72;font-size:22px;font-weight:800;letter-spacing:.04em;white-space:nowrap}
    .ai-export-brand svg{display:block;width:42px;height:38px;overflow:visible}
    .ai-export-brand rect{fill:#123847}.ai-export-brand .jj-one{fill:#fff}.ai-export-brand .jj-two{fill:#15958e}.ai-export-brand .jj-line{fill:none;stroke:#69d7cf;stroke-width:3.5;stroke-linecap:round;stroke-linejoin:round}.ai-export-brand .jj-tail{fill:#123847}
    .ai-review-report>header{padding-bottom:30px;border-bottom:1px solid #dfe7eb}
    .ai-review-report>header span{display:block;margin-bottom:8px;color:#168b86;font-size:20px;font-weight:800;letter-spacing:.08em}
    .ai-review-report>header small{display:block;color:#78909b;font-size:18px}
    .ai-review-report h2{margin:20px 0 18px;font-size:38px;line-height:1.42;font-weight:800;letter-spacing:-.02em;overflow-wrap:anywhere}
    .ai-review-report h3{margin:0 0 18px;font-size:30px;line-height:1.5;font-weight:800;overflow-wrap:anywhere}
    .ai-review-report p{display:block;margin:0 0 22px;font-size:24px;line-height:1.85;font-weight:400;text-align:justify;text-align-last:left;text-justify:inter-ideograph;white-space:normal;word-break:normal;overflow-wrap:anywhere}
    .ai-review-lead{padding-top:30px;padding-bottom:12px;border-bottom:1px solid #e5ebef}
    .ai-review-article section{display:block;padding:34px 0 12px;border-bottom:1px solid #e5ebef}
    .ai-review-tomorrow{margin-top:34px;padding:30px 28px 14px;border-radius:14px;background:#eef8f6}
    .ai-review-closing{margin-top:28px;padding:24px 26px;border-left:5px solid #15958e;background:#f5faf9;font-size:25px;line-height:1.8;font-weight:800}
    .ai-review-report blockquote{display:block;width:100%;max-width:none;margin:26px 0;padding:24px 26px;border-left:5px solid #15958e;background:#f7fafb;font-size:25px;line-height:1.8;font-weight:700;overflow-wrap:anywhere}
  `;
  const document = `<!doctype html><html><head><meta charset="utf-8"><style>${css}</style></head><body>${payload.html}<script>requestAnimationFrame(()=>requestAnimationFrame(()=>{const article=document.querySelector(".ai-review-report");const bottom=article?article.getBoundingClientRect().bottom:0;const height=Math.ceil(Math.max(document.body.scrollHeight,document.documentElement.scrollHeight,bottom)+96);document.documentElement.setAttribute("data-export-height",String(height));document.documentElement.setAttribute("data-export-scroll-width",String(document.documentElement.scrollWidth));document.documentElement.setAttribute("data-export-client-width",String(document.documentElement.clientWidth));}));<\/script></body></html>`;
  const runEdge = (args, capture = false) => new Promise((resolve, reject) => {
    const child = spawn(edge, args, { windowsHide: true, stdio: capture ? ["ignore", "pipe", "ignore"] : "ignore" });
    let stdout = "";
    if (capture) child.stdout.on("data", (chunk) => { stdout += chunk.toString("utf8"); });
    const timer = setTimeout(() => { child.kill(); reject(new Error("生成图片超时")); }, 30000);
    child.on("error", (error) => { clearTimeout(timer); reject(error); });
    child.on("exit", (code) => { clearTimeout(timer); code === 0 ? resolve(stdout) : reject(new Error(`Edge导出失败（${code}）`)); });
  });
  try {
    await fs.writeFile(htmlFile, document, "utf8");
    const common = ["--headless=new", "--disable-gpu", "--hide-scrollbars", "--no-first-run", "--no-default-browser-check", "--run-all-compositor-stages-before-draw", "--virtual-time-budget=1500"];
    const dumped = await runEdge([...common, `--user-data-dir=${path.join(jobDir, "measure-profile")}`, "--dump-dom", pathToFileURL(htmlFile).href], true);
    const measured = Number(dumped.match(/data-export-height="(\d+)"/)?.[1]);
    const scrollWidth = Number(dumped.match(/data-export-scroll-width="(\d+)"/)?.[1]);
    const clientWidth = Number(dumped.match(/data-export-client-width="(\d+)"/)?.[1]);
    if (scrollWidth > clientWidth) throw new Error(`移动端布局横向溢出：${scrollWidth}/${clientWidth}`);
    if (!Number.isFinite(measured) || measured < 100) throw new Error("无法测量复盘完整高度");
    if (measured > 30000) throw new Error("复盘内容过长，请拆分后导出");
    const height = Math.min(30000, Math.ceil(measured + 2400));
    await runEdge([...common, `--user-data-dir=${path.join(jobDir, "capture-profile")}`, `--window-size=${width},${height}`, `--screenshot=${pngFile}`, pathToFileURL(htmlFile).href]);
    await new Promise((resolve, reject) => {
      const cropper = spawn("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", path.join(__dirname, "crop-export-image.ps1"), "-InputPath", pngFile, "-OutputPath", croppedPngFile, "-BottomPadding", "48"], { windowsHide: true, stdio: "ignore" });
      const timer = setTimeout(() => { cropper.kill(); reject(new Error("图片裁边超时")); }, 30000);
      cropper.on("error", (error) => { clearTimeout(timer); reject(error); });
      cropper.on("exit", (code) => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error(`图片裁边失败（${code}）`)); });
    });
    const png = await fs.readFile(croppedPngFile);
    res.writeHead(200, { "Content-Type": "image/png", "Content-Length": png.length, "Cache-Control": "no-store", "X-Export-Width": String(width), "X-Export-Height": String(height) });
    res.end(png);
  } finally {
    await fs.rm(jobDir, { recursive: true, force: true }).catch(() => {});
  }
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

async function windCallOnce(serverType, toolName, params, timeoutMs = 60_000) {
  await fs.access(windCli);
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [windCli, "call", serverType, toolName, JSON.stringify(params)], {
      cwd: skillDir,
      windowsHide: true,
      env: process.env
    });
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
          if (parsed?.error?.agent_action) parsed.error.message = parsed.error.agent_action;
          reject(new Error(`${parsed?.error?.code || "WIND_ERROR"}: ${parsed?.error?.message || stderr || "Wind调用失败"}`));
        } catch { reject(new Error(stderr || stdout || `Wind CLI退出码${code}`)); }
        return;
      }
      try { resolve(unpackWind(stdout)); } catch (error) { reject(error); }
    });
  });
}

async function windCall(serverType, toolName, params, timeoutMs = 60_000) {
  const delays = [0, 1200, 3000];
  let lastError = null;
  for (let attempt = 0; attempt < delays.length; attempt += 1) {
    if (delays[attempt]) await new Promise((resolve) => setTimeout(resolve, delays[attempt]));
    try {
      return await withWindSlot(() => windCallOnce(serverType, toolName, params, timeoutMs));
    } catch (error) {
      lastError = error;
      const text = safeError(error);
      const retryable = text.includes('NETWORK_ERROR') || text.includes('QUOTA_ERROR');
      if (!retryable || attempt === delays.length - 1) throw error;
    }
  }
  throw lastError || new Error('Wind调用失败');
}

async function innerJson(pathname) {
  const response = await fetch(`${innerOrigin}${pathname}`);
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error || `内部服务错误${response.status}`);
  return payload;
}

async function proxy(req, res, url) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const body = chunks.length ? Buffer.concat(chunks) : undefined;
  const response = await fetch(`${innerOrigin}${url.pathname}${url.search}`, {
    method: req.method,
    headers: { "Content-Type": req.headers["content-type"] || "application/json" },
    body
  });
  const buffer = Buffer.from(await response.arrayBuffer());
  res.writeHead(response.status, {
    "Content-Type": response.headers.get("content-type") || "application/octet-stream",
    "Content-Length": buffer.length,
    "Cache-Control": "no-store"
  });
  res.end(buffer);
}

async function serveIndex(res) {
  const response = await fetch(`${innerOrigin}/`);
  let html = await response.text();
  html = html.replace("</head>", "  <link rel=\"stylesheet\" href=\"/ai.css\">\n</head>");
  html = html.replace("</body>", "  <script type=\"module\" src=\"/ai.js?v=2\"></script>\n</body>");
  const body = Buffer.from(html);
  res.writeHead(200, {
    "Content-Type": "text/html; charset=utf-8",
    "Content-Length": body.length,
    "Cache-Control": "no-cache",
    "Content-Security-Policy": "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; img-src 'self' data: blob:; frame-src 'self' http://127.0.0.1:4320"
  });
  res.end(body);
}

const mime = { ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8" };
async function serveLocal(res, filename) {
  const body = await fs.readFile(path.join(__dirname, "public-ai", filename));
  res.writeHead(200, { "Content-Type": mime[path.extname(filename)] || "application/octet-stream", "Content-Length": body.length, "Cache-Control": "no-cache" });
  res.end(body);
}

const child = spawn(process.execPath, [path.join(__dirname, "server-auto.mjs")], {
  cwd: __dirname,
  windowsHide: true,
  env: { ...process.env, PORT: String(innerPort), INTERNAL_PORT: String(corePort) },
  stdio: ["ignore", "pipe", "pipe"]
});
child.stdout.on("data", (chunk) => process.stdout.write(`[auto] ${chunk}`));
child.stderr.on("data", (chunk) => process.stderr.write(`[auto] ${chunk}`));
child.on("exit", (code) => { if (code !== 0) console.error(`自动信号服务退出：${code}`); });

const selectionBacktest = createSelectionBacktest({ file: backtestStateFile, windCall });
const aiEngine = createAiDecisionEngine({
  windCall,
  automationStatus: () => innerJson("/api/automation/status"),
  readBaseState: () => innerJson("/api/state"),
  stateFile: aiStateFile,
  safeError,
  selectionBacktest
});

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || `127.0.0.1:${externalPort}`}`);
    if (req.method === "GET" && url.pathname === "/") return await serveIndex(res);
    if (req.method === "GET" && url.pathname === "/ai.js") return await serveLocal(res, "ai.js");
    if (req.method === "GET" && url.pathname === "/ai.css") return await serveLocal(res, "ai.css");
    if (req.method === "GET" && url.pathname === "/api/ai/status") return sendJson(res, 200, aiEngine.status());
    if (req.method === "GET" && url.pathname === "/api/ai/backtest") return sendJson(res, 200, selectionBacktest.status());
    if (req.method === "POST" && url.pathname === "/api/ai/run") return sendJson(res, 200, await aiEngine.run({ reason: "manual" }));
    if (req.method === "POST" && url.pathname === "/api/ai/review/run") return sendJson(res, 200, await aiEngine.runReview({ reason: "review-manual" }));
    if (req.method === "POST" && url.pathname === "/api/ai/review/export-image") return await exportReviewPng(req, res);
    return await proxy(req, res, url);
  } catch (error) {
    sendJson(res, 500, { error: safeError(error) });
  }
});

async function waitForInner() {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const response = await fetch(`${innerOrigin}/api/health`);
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("内部自动信号工作台启动超时");
}

await waitForInner();
await selectionBacktest.start();
await aiEngine.start();
server.listen(externalPort, "127.0.0.1", () => console.log(`AI原生投资决策工作台：http://127.0.0.1:${externalPort}`));

function shutdown() {
  child.kill();
  server.close(() => process.exit(0));
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

















