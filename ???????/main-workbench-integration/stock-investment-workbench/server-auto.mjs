import http from "node:http";
import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createAutomationEngine } from "./automation-engine.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(__dirname, "public");
const stateFile = path.join(__dirname, "data", "state.json");
const skillDir = process.env.WIND_MCP_SKILL_DIR || path.join(os.homedir(), ".agents", "skills", "wind-mcp-skill");
const windCli = path.join(skillDir, "scripts", "cli.mjs");
const externalPort = Number(process.env.PORT || 4310);
const internalPort = Number(process.env.INTERNAL_PORT || 4311);
const internalOrigin = `http://127.0.0.1:${internalPort}`;

function safeError(error) {
  const message = error instanceof Error ? error.message : String(error);
  return message.replaceAll(skillDir, "[wind-mcp-skill]").slice(0, 1000);
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store"
  });
  res.end(body);
}

async function parseBody(req) {
  let raw = "";
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 1_000_000) throw new Error("请求内容过大");
  }
  if (!raw) return {};
  try { return JSON.parse(raw); } catch { throw new Error("请求JSON格式无效"); }
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
          reject(new Error(`${parsed?.error?.code || "WIND_ERROR"}: ${parsed?.error?.message || stderr || "Wind调用失败"}`));
        } catch { reject(new Error(stderr || stdout || `Wind CLI退出码${code}`)); }
        return;
      }
      try { resolve(unpackWind(stdout)); } catch (error) { reject(error); }
    });
  });
}

async function internalJson(pathname) {
  const response = await fetch(`${internalOrigin}${pathname}`);
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error || `内部服务错误${response.status}`);
  return payload;
}

async function readState() {
  const state = JSON.parse(await fs.readFile(stateFile, "utf8"));
  state.signals = Array.isArray(state.signals) ? state.signals : [];
  state.automationRuns = Array.isArray(state.automationRuns) ? state.automationRuns : [];
  state.automation = state.automation || {};
  return state;
}

async function writeState(state) {
  const clean = { ...state, updatedAt: new Date().toISOString() };
  for (const key of ["positions", "candidates", "plans", "journal", "tasks", "signals", "automationRuns"]) {
    if (!Array.isArray(clean[key])) throw new Error(`状态字段${key}必须为数组`);
  }
  const temp = `${stateFile}.auto.tmp`;
  await fs.writeFile(temp, `${JSON.stringify(clean, null, 2)}\n`, "utf8");
  await fs.rename(temp, stateFile);
  return clean;
}

const automationEngine = createAutomationEngine({
  windCall,
  getMarketData: () => internalJson("/api/market"),
  getStockQuote: (code) => internalJson(`/api/quote?code=${encodeURIComponent(code)}`),
  readState,
  writeState,
  safeError
});

async function proxy(req, res, url) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const body = chunks.length ? Buffer.concat(chunks) : undefined;
  const response = await fetch(`${internalOrigin}${url.pathname}${url.search}`, {
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

async function serveInjectedIndex(res) {
  let html = await fs.readFile(path.join(publicDir, "index.html"), "utf8");
  html = html.replace("</head>", "  <link rel=\"stylesheet\" href=\"/auto.css\">\n</head>");
  html = html.replace("</body>", "  <script type=\"module\" src=\"/auto.js\"></script>\n</body>");
  const body = Buffer.from(html);
  res.writeHead(200, {
    "Content-Type": "text/html; charset=utf-8",
    "Content-Length": body.length,
    "Cache-Control": "no-cache",
    "Content-Security-Policy": "default-src 'self'; style-src 'self'; script-src 'self'; connect-src 'self'; img-src 'self' data:; frame-src 'self' http://127.0.0.1:4320"
  });
  res.end(body);
}

const mime = { ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".png": "image/png" };
async function serveLocal(res, filePath) {
  const body = await fs.readFile(filePath);
  res.writeHead(200, { "Content-Type": mime[path.extname(filePath)] || "application/octet-stream", "Content-Length": body.length });
  res.end(body);
}

const child = spawn(process.execPath, [path.join(__dirname, "server.mjs")], {
  cwd: __dirname,
  windowsHide: true,
  env: { ...process.env, PORT: String(internalPort) },
  stdio: ["ignore", "pipe", "pipe"]
});
child.stdout.on("data", (chunk) => process.stdout.write(`[core] ${chunk}`));
child.stderr.on("data", (chunk) => process.stderr.write(`[core] ${chunk}`));
child.on("exit", (code) => {
  if (code !== 0) console.error(`核心工作台服务退出：${code}`);
});

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || `127.0.0.1:${externalPort}`}`);
    if (req.method === "GET" && url.pathname === "/") return await serveInjectedIndex(res);
    if (req.method === "GET" && url.pathname === "/auto.js") return await serveLocal(res, path.join(__dirname, "public-auto", "auto.js"));
    if (req.method === "GET" && url.pathname === "/auto.css") return await serveLocal(res, path.join(__dirname, "public-auto", "auto.css"));
    if (req.method === "GET" && url.pathname === "/api/automation/status") return sendJson(res, 200, await automationEngine.status());
    if (req.method === "POST" && url.pathname === "/api/automation/run") return sendJson(res, 200, await automationEngine.run({ reason: "manual" }));
    if (req.method === "PUT" && url.pathname === "/api/automation/config") return sendJson(res, 200, await automationEngine.updateConfig(await parseBody(req)));
    if (req.method === "POST" && url.pathname === "/api/automation/signal") {
      const body = await parseBody(req);
      return sendJson(res, 200, await automationEngine.reviewSignal(String(body.id || ""), String(body.action || "")));
    }
    return await proxy(req, res, url);
  } catch (error) {
    sendJson(res, 500, { error: safeError(error) });
  }
});

async function waitForCore() {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      const response = await fetch(`${internalOrigin}/api/health`);
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error("核心工作台服务启动超时");
}

await waitForCore();
server.listen(externalPort, "127.0.0.1", () => {
  console.log(`自动信号投资工作台：http://127.0.0.1:${externalPort}`);
  automationEngine.start();
});

function shutdown() {
  child.kill();
  server.close(() => process.exit(0));
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
