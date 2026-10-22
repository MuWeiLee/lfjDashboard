// 本地预览：node scripts/dev-server.mjs（或 npm run dev），打开 http://localhost:3000/cn 、/tw
//
// 按 vercel.json 的 redirects / rewrites 提供页面，/api/short-emotion 直接调用 api/short-emotion.js。
// 数据默认读线上 short-emotion-data 分支（只读，不调用 Wind）；
// 设 SHORT_EMOTION_DATA_DIR=<目录> 时改读本地检出的数据分支。
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const publicDir = path.join(root, "public");
const vercel = JSON.parse(await readFile(path.join(root, "vercel.json"), "utf8"));

// 本地预览时加载项目 .env（Wind API Key 等），已存在的环境变量优先，不覆盖。
async function loadDotEnv() {
  const envPath = path.join(root, ".env");
  try {
    const text = new TextDecoder().decode(await readFile(envPath));
    for (const line of text.split(/\r?\n/)) {
      const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
      if (match && process.env[match[1]] === undefined) process.env[match[1]] = match[2];
    }
    const windKeys = ["WIND_API_KEY_LFJ", "WIND_API_KEY_HF", "WIND_API_KEY_ZZY"].some((key) => process.env[key]);
    console.error(`[dev] ${windKeys ? ".env 已加载（Wind 刷新可用）" : ".env 未配置 Wind Key，页面刷新按钮不可用"}`);
  } catch { /* 无 .env 时静默 */ }
}
await loadDotEnv();

if (!process.env.SHORT_EMOTION_STORE) process.env.SHORT_EMOTION_STORE = process.env.SHORT_EMOTION_DATA_DIR ? "file" : "github";
const { default: api } = await import("../api/short-emotion.js");

const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".json": "application/json", ".png": "image/png" };
const port = Number(process.env.PORT || 3000);

function vercelResponse(res) {
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (body) => {
    if (!res.getHeader("Content-Type")) res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.end(JSON.stringify(body));
    return res;
  };
  return res;
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${port}`);
  try {
    const redirect = (vercel.redirects || []).find((r) => r.source === url.pathname);
    if (redirect) {
      res.writeHead(307, { Location: redirect.destination + url.search }).end();
      return;
    }
    if (url.pathname === "/api/short-emotion") {
      req.query = Object.fromEntries(url.searchParams);
      req.body = await readBody(req);
      await api(req, vercelResponse(res));
      return;
    }
    const rewrite = (vercel.rewrites || []).find((r) => r.source === url.pathname);
    const file = path.normalize(path.join(publicDir, decodeURIComponent(rewrite ? rewrite.destination : url.pathname)));
    if (!file.startsWith(publicDir + path.sep)) throw Object.assign(new Error("forbidden"), { code: "ENOENT" });
    const body = await readFile(file);
    res.writeHead(200, { "Content-Type": TYPES[path.extname(file)] || "application/octet-stream" }).end(body);
  } catch (error) {
    if (error?.code === "ENOENT" || error?.code === "EISDIR") res.writeHead(404).end("Not Found");
    else {
      console.error(error);
      if (!res.headersSent) res.writeHead(500);
      res.end(String(error?.message || error));
    }
  }
}).listen(port, () => {
  console.log(`ShortEmotion 本地预览：http://localhost:${port}/cn  （台股 /tw，数据：${process.env.SHORT_EMOTION_STORE}）`);
});
