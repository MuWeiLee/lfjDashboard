// Persistence for 短线情绪工作台 snapshots.
//
// SHORT_EMOTION_STORE picks the backend:
//   file     — JSON files in SHORT_EMOTION_DATA_DIR. Used by the GitHub Actions job,
//              which computes snapshots and pushes the directory to the
//              `short-emotion-data` branch (no database needed).
//   github   — read-only view of that branch over raw.githubusercontent.com.
//              Default on Vercel: page visitors only read.
//   supabase — PostgREST tables from sql/short_emotion.sql (optional, not used now).
//   memory   — in-process, for local dev and tests.
import { promises as fs } from "node:fs";
import path from "node:path";
import { githubToken, dataBranchHead, DATA_RAW_BASE, DATA_BRANCH } from "./github.js";

const KV_TABLE = "short_emotion_kv";
const HISTORY_TABLE = "short_emotion_history";
const DAILY_VIEW = "short_emotion_daily";
const HISTORY_SLOT_MS = 120_000; // one history row per 2-minute window, like the original workbench

function supabaseConfig(env = process.env) {
  const url = String(env.SUPABASE_URL || "").replace(/\/+$/, "");
  const key = env.SUPABASE_SERVICE_ROLE_KEY;
  return url && key ? { url, key } : null;
}

export function historySlot(capturedAt) {
  return Math.floor(Date.parse(capturedAt) / HISTORY_SLOT_MS);
}

class SupabaseStore {
  constructor({ url, key }) {
    this.base = `${url}/rest/v1`;
    this.headers = { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json" };
  }

  async request(path, { method = "GET", body, prefer, range } = {}) {
    const headers = { ...this.headers };
    if (prefer) headers.Prefer = prefer;
    if (range) Object.assign(headers, { "Range-Unit": "items", Range: range });
    const response = await fetch(`${this.base}/${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(15_000)
    });
    const text = await response.text();
    if (!response.ok) {
      const hint = response.status === 404 || /does not exist|schema cache/i.test(text)
        ? "（请先在 Supabase 执行 sql/short_emotion.sql）" : "";
      throw new Error(`Supabase ${method} ${path.split("?")[0]} ${response.status}${hint}: ${text.slice(0, 200)}`);
    }
    return text ? JSON.parse(text) : null;
  }

  async kvGet(key) {
    const rows = await this.request(`${KV_TABLE}?key=eq.${encodeURIComponent(key)}&select=value,updated_at`);
    return rows?.[0] ? { value: rows[0].value, updatedAt: rows[0].updated_at } : null;
  }

  async kvSet(key, value) {
    await this.request(`${KV_TABLE}?on_conflict=key`, {
      method: "POST",
      body: [{ key, value, updated_at: new Date().toISOString() }],
      prefer: "resolution=merge-duplicates,return=minimal"
    });
  }

  /** Atomic insert-if-absent; returns true when this caller created the key (used as a lock). */
  async kvSetIfAbsent(key, value) {
    const rows = await this.request(`${KV_TABLE}?on_conflict=key`, {
      method: "POST",
      body: [{ key, value, updated_at: new Date().toISOString() }],
      prefer: "resolution=ignore-duplicates,return=representation"
    });
    return Array.isArray(rows) && rows.length > 0;
  }

  async kvDeleteOlderThan(prefix, isoTime) {
    await this.request(`${KV_TABLE}?key=like.${encodeURIComponent(`${prefix}*`)}&updated_at=lt.${encodeURIComponent(isoTime)}`, {
      method: "DELETE", prefer: "return=minimal"
    });
  }

  async historyUpsert(record, inSession) {
    await this.request(`${HISTORY_TABLE}?on_conflict=slot`, {
      method: "POST",
      body: [{
        slot: historySlot(record.capturedAt),
        trading_date: record.tradingDate,
        captured_at: record.capturedAt,
        in_session: inSession,
        score: Number.isFinite(Number(record.score)) ? Number(record.score) : null,
        record
      }],
      prefer: "resolution=merge-duplicates,return=minimal"
    });
  }

  async historyLatestDate() {
    const rows = await this.request(`${HISTORY_TABLE}?select=trading_date&order=trading_date.desc&limit=1`);
    return rows?.[0]?.trading_date || null;
  }

  async historyForDate(tradingDate) {
    const rows = await this.request(
      `${HISTORY_TABLE}?trading_date=eq.${encodeURIComponent(tradingDate)}&select=record&order=captured_at.asc`,
      { range: "0-999" }
    );
    return (rows || []).map((row) => row.record);
  }

  async dailyHistory() {
    const rows = await this.request(`${DAILY_VIEW}?select=*&order=trading_date.asc`, { range: "0-999" });
    return (rows || []).map((row) => ({
      tradingDate: row.trading_date,
      score: Number(row.score),
      sampleCount: Number(row.sample_count),
      firstCapturedAt: row.first_captured_at,
      lastCapturedAt: row.last_captured_at
    }));
  }

  async historyPrune(keepTradingDays) {
    const latest = await this.historyLatestDate();
    const days = (await this.dailyHistory()).map((item) => item.tradingDate);
    const allDays = [...new Set([...days, ...(latest ? [latest] : [])])].sort();
    if (allDays.length <= keepTradingDays) return 0;
    const cutoff = allDays[allDays.length - keepTradingDays];
    await this.request(`${HISTORY_TABLE}?trading_date=lt.${encodeURIComponent(cutoff)}`, { method: "DELETE", prefer: "return=minimal" });
    return allDays.length - keepTradingDays;
  }
}

class MemoryStore {
  constructor() {
    this.kv = new Map();
    this.history = new Map();
  }
  async kvGet(key) { return this.kv.get(key) || null; }
  async kvSet(key, value) { this.kv.set(key, { value, updatedAt: new Date().toISOString() }); }
  async kvSetIfAbsent(key, value) {
    if (this.kv.has(key)) return false;
    await this.kvSet(key, value);
    return true;
  }
  async kvDeleteOlderThan(prefix, isoTime) {
    for (const [key, entry] of this.kv) if (key.startsWith(prefix) && entry.updatedAt < isoTime) this.kv.delete(key);
  }
  async historyUpsert(record, inSession) {
    this.history.set(historySlot(record.capturedAt), { record, inSession });
  }
  async historyLatestDate() {
    return [...this.history.values()].map((row) => row.record.tradingDate).sort().at(-1) || null;
  }
  async historyForDate(tradingDate) {
    return [...this.history.values()].map((row) => row.record).filter((record) => record.tradingDate === tradingDate)
      .sort((a, b) => a.capturedAt.localeCompare(b.capturedAt));
  }
  async dailyHistory() {
    return aggregateDaily([...this.history.values()]);
  }
  async historyPrune(keepTradingDays) {
    const days = [...new Set([...this.history.values()].map((row) => row.record.tradingDate))].sort();
    if (days.length <= keepTradingDays) return 0;
    const cutoff = days[days.length - keepTradingDays];
    for (const [slot, row] of this.history) if (row.record.tradingDate < cutoff) this.history.delete(slot);
    return days.length - keepTradingDays;
  }
}

// ───── 文件存储（GitHub Actions 中使用，目录随后推送到 short-emotion-data 分支）─────

const kvFileName = (key) => `${String(key).replace(/[^A-Za-z0-9_.-]/g, "_")}.json`;

function aggregateDaily(records) {
  const groups = new Map();
  for (const { record, inSession } of records) {
    if (!inSession || !Number.isFinite(Number(record.score))) continue;
    if (!groups.has(record.tradingDate)) groups.set(record.tradingDate, []);
    groups.get(record.tradingDate).push(record);
  }
  return [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([tradingDate, items]) => {
    items.sort((a, b) => a.capturedAt.localeCompare(b.capturedAt));
    return {
      tradingDate,
      score: Math.round(items.reduce((sum, item) => sum + Number(item.score), 0) / items.length * 100) / 100,
      sampleCount: items.length,
      firstCapturedAt: items[0].capturedAt,
      lastCapturedAt: items.at(-1).capturedAt
    };
  });
}

async function readJson(file, fallback) {
  try {
    return JSON.parse(await fs.readFile(file, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return fallback;
    throw error;
  }
}

async function writeJson(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.tmp`;
  await fs.writeFile(temporary, JSON.stringify(value), "utf8");
  await fs.rename(temporary, file);
}

class FileStore {
  constructor(dir) {
    this.dir = path.resolve(dir);
  }
  kvPath(key) { return path.join(this.dir, "kv", kvFileName(key)); }
  historyPath(day) { return path.join(this.dir, "history", `${day}.json`); }

  async kvGet(key) { return readJson(this.kvPath(key), null); }
  async kvSet(key, value) { await writeJson(this.kvPath(key), { value, updatedAt: new Date().toISOString() }); }
  async kvSetIfAbsent(key, value) {
    if (await this.kvGet(key)) return false;
    await this.kvSet(key, value);
    return true;
  }
  async kvDeleteOlderThan(prefix, isoTime) {
    const dir = path.join(this.dir, "kv");
    const names = await fs.readdir(dir).catch(() => []);
    const filePrefix = kvFileName(prefix).replace(/\.json$/, "");
    for (const name of names) {
      if (!name.startsWith(filePrefix)) continue;
      const entry = await readJson(path.join(dir, name), null);
      if (!entry || entry.updatedAt < isoTime) await fs.rm(path.join(dir, name), { force: true });
    }
  }

  async historyDays() {
    const names = await fs.readdir(path.join(this.dir, "history")).catch(() => []);
    return names.map((name) => name.match(/^(\d{8})\.json$/)?.[1]).filter(Boolean).sort();
  }
  async historyRows(day) { return readJson(this.historyPath(day), []); }

  // index.json 汇总每日均值与最新交易日，供只读端一次读取
  async rebuildIndex() {
    const rows = [];
    for (const day of await this.historyDays()) rows.push(...await this.historyRows(day));
    const days = await this.historyDays();
    await writeJson(path.join(this.dir, "index.json"), {
      updatedAt: new Date().toISOString(),
      latestDate: days.at(-1) || null,
      daily: aggregateDaily(rows)
    });
  }

  async historyUpsert(record, inSession) {
    const rows = await this.historyRows(record.tradingDate);
    const slot = historySlot(record.capturedAt);
    const next = rows.filter((row) => historySlot(row.record.capturedAt) !== slot);
    next.push({ record, inSession });
    next.sort((a, b) => a.record.capturedAt.localeCompare(b.record.capturedAt));
    await writeJson(this.historyPath(record.tradingDate), next);
    await this.rebuildIndex();
  }
  async historyLatestDate() { return (await this.historyDays()).at(-1) || null; }
  async historyForDate(day) { return (await this.historyRows(day)).map((row) => row.record); }
  async dailyHistory() { return (await readJson(path.join(this.dir, "index.json"), { daily: [] })).daily; }
  async historyPrune(keepTradingDays) {
    const days = await this.historyDays();
    if (days.length <= keepTradingDays) return 0;
    const removed = days.slice(0, days.length - keepTradingDays);
    for (const day of removed) await fs.rm(this.historyPath(day), { force: true });
    await this.rebuildIndex();
    return removed.length;
  }
}

// ───── 只读：从 GitHub 数据分支读取（Vercel 上的页面接口使用）─────

// 与 github.js 的 REPO 同源，换仓库时只需改一处（或设 SHORT_EMOTION_REPO）。
const DEFAULT_DATA_URL = `${DATA_RAW_BASE}/${DATA_BRANCH}`;
const READ_CACHE_MS = 30_000;
const readCache = new Map();

// raw.githubusercontent.com 按分支名读取会被缓存约 5 分钟；有 GITHUB_ACTIONS_TOKEN 时先查分支最新提交，
// 按提交 SHA 读取（内容不可变、立即可见），这样点「刷新」后页面能马上读到新快照。
const HEAD_CACHE_MS = 15_000;
let headCache = null;
async function currentHead(fresh) {
  if (!fresh && headCache && Date.now() - headCache.at < HEAD_CACHE_MS) return headCache.sha;
  const sha = await dataBranchHead();
  headCache = { at: Date.now(), sha };
  return sha;
}

class GithubReadStore {
  constructor(baseUrl, { sub = "", pinToCommit = false, fresh = false } = {}) {
    this.base = String(baseUrl).replace(/\/+$/, "");
    this.sub = sub;
    this.pinToCommit = pinToCommit;
    this.fresh = fresh;
  }
  async root() {
    if (this.pinToCommit) {
      const sha = await currentHead(this.fresh).catch(() => null);
      if (sha) return `${DATA_RAW_BASE}/${sha}${this.sub ? `/${this.sub}` : ""}`;
    }
    return this.sub ? `${this.base}/${this.sub}` : this.base;
  }
  async fetchJson(relative, fallback) {
    // 缓存按完整地址区分：A股（根目录）和台股（tw/）的同名文件不能互相命中。
    const url = `${await this.root()}/${relative}`;
    const cached = this.fresh ? null : readCache.get(url);
    if (cached && Date.now() - cached.at < READ_CACHE_MS) return cached.value;
    const response = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    if (response.status === 404) return fallback;
    if (!response.ok) throw new Error(`读取数据分支失败：${response.status} ${relative}`);
    const value = await response.json();
    readCache.set(url, { at: Date.now(), value });
    return value;
  }
  async kvGet(key) { return this.fetchJson(`kv/${kvFileName(key)}`, null); }
  async historyLatestDate() { return (await this.fetchJson("index.json", {})).latestDate || null; }
  async historyForDate(day) { return (await this.fetchJson(`history/${day}.json`, [])).map((row) => row.record); }
  async dailyHistory() { return (await this.fetchJson("index.json", { daily: [] })).daily || []; }
  readOnly() { throw new Error("GitHub 数据分支只读：快照由 GitHub Actions 写入"); }
  async kvSet() { this.readOnly(); }
  async kvSetIfAbsent() { this.readOnly(); }
  async kvDeleteOlderThan() { this.readOnly(); }
  async historyUpsert() { this.readOnly(); }
  async historyPrune() { this.readOnly(); }
}


export function storageMode(env = process.env) {
  const explicit = String(env.SHORT_EMOTION_STORE || "").toLowerCase();
  if (["file", "github", "supabase", "memory"].includes(explicit)) return explicit;
  if (env.SHORT_EMOTION_DATA_DIR) return "file";
  if (env.VERCEL) return "github";
  return "memory";
}

// 每个市场一份独立数据：A股（cn）在数据分支根目录（保持原有路径），台股（tw）在 tw/ 子目录。
const memoryStores = new Map();
export function marketSubdir(market = "cn") {
  return market === "cn" ? "" : market;
}

export function getStore(market = "cn", { fresh = false } = {}) {
  const mode = storageMode();
  const sub = marketSubdir(market);
  if (mode === "file") return new FileStore(path.join(process.env.SHORT_EMOTION_DATA_DIR || "short-emotion-data", sub));
  if (mode === "github") {
    const custom = process.env.SHORT_EMOTION_DATA_URL;
    const base = String(custom || DEFAULT_DATA_URL).replace(/\/+$/, "");
    return new GithubReadStore(base, { sub, pinToCommit: !custom && Boolean(githubToken()), fresh });
  }
  if (mode === "supabase") {
    if (market !== "cn") throw new Error("Supabase 存储只支持 A股（cn）");
    const config = supabaseConfig();
    if (!config) throw new Error("SHORT_EMOTION_STORE=supabase 但缺少 SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY");
    return new SupabaseStore(config);
  }
  if (!memoryStores.has(market)) memoryStores.set(market, new MemoryStore());
  return memoryStores.get(market);
}
