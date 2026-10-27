// Orchestration for 短线情绪工作台 (A股 cn / 台股 tw):
//   runScheduledRefresh — the only code path that calls Wind (GitHub Actions cron / manual trigger)
//   readResource        — what page visitors get: stored snapshots, never a Wind call
import * as cnEngine from "./engine.js";
import * as twEngine from "./tw-engine.js";
import { loadLimitUpBoard } from "./limit-engine.js";
import { getStore, storageMode } from "./store.js";
import { duePlan, scheduleSummary, scheduleFor, MARKETS } from "./schedule.js";
import { getApiKeys, isMockMode } from "./wind-client.js";
import { toTraditional } from "./hant.js";
import { appendTodaySample, refreshWindows, readFundFlow } from "./fund-flow.js";

const MARKET_CONFIG = {
  cn: { engine: cnEngine, transform: async (value) => value },
  tw: { engine: twEngine, transform: toTraditional }
};

export { MARKETS };

export function normalizeMarket(value) {
  const market = String(value || "cn").toLowerCase();
  if (!MARKET_CONFIG[market]) throw Object.assign(new Error(`未知市场：${value}`), { statusCode: 404 });
  return market;
}

const KEY = {
  emotion: "emotion:latest",
  anomalies: "anomalies:latest",
  news: "news:latest",
  limitup: "limitup:latest",
  limitupDay: (day) => `limitup:day:${day}`,
  lastRun: "cron:last-run",
  engineState: (day) => `engine-state:${day}`,
  engineStateLatest: "engine-state:latest",
  calendar: (day) => `calendar:${day}`,
  slotLock: (day, slot) => `lock:slot:${day}:${slot}`,
  bootstrapLock: (day) => `lock:bootstrap:${day}`
};

const errorText = (error) => String(error?.message || error);
const quoteDayOf = (snapshot) => String(snapshot?.quoteTime || "").replace(/\D/g, "").slice(0, 8);
const ALL_JOBS = { emotion: true, anomalies: true, news: true, fundFlow: true, limitup: true, cleanup: false };

/**
 * Refreshes whatever is due in the current Beijing 5-minute slot.
 * force=true (CRON_SECRET-authorised manual run) runs every job once.
 * Outside the schedule it only bootstraps an empty store, at most once a day.
 */
export async function runScheduledRefresh({ force = false, now = new Date(), market = "cn" } = {}) {
  market = normalizeMarket(market);
  const { engine, transform } = MARKET_CONFIG[market];
  const { loadEmotion, loadThemeAnomalies, loadNews, historyRecord, isTradingSessionHistory, exportEngineState, importEngineState } = engine;
  const SCHEDULE = scheduleFor(market);
  const store = getStore(market);
  const plan = duePlan(now, market);
  const result = { market, startedAt: now.toISOString(), beijingTime: `${plan.day} ${plan.label}`, mode: "scheduled", ran: [], skipped: [], errors: [] };
  const finish = async (status, extra = {}) => {
    const output = { ...result, ...extra, status, finishedAt: new Date().toISOString() };
    await store.kvSet(KEY.lastRun, output).catch(() => {});
    return output;
  };

  let jobs = { ...plan.jobs };
  if (force) {
    jobs = { ...ALL_JOBS };
    result.mode = "force";
  } else if (!plan.anyDue) {
    if (await store.kvGet(KEY.emotion)) return { ...result, status: "idle", reason: "不在定时窗口内，未调用 Wind" };
    if (!(await store.kvSetIfAbsent(KEY.bootstrapLock(plan.day), { at: now.toISOString() }))) {
      return { ...result, status: "idle", reason: "今日已尝试过初始化" };
    }
    jobs = { ...ALL_JOBS };
    result.mode = "bootstrap";
  } else {
    const calendar = await store.kvGet(KEY.calendar(plan.day));
    if (calendar?.value?.trading === false) return { ...result, status: "holiday", reason: "今日已判定为休市" };
    // Several triggers in the same slot (cron retries, manual hits) call Wind only once.
    if (!(await store.kvSetIfAbsent(KEY.slotLock(plan.day, plan.slot), { at: now.toISOString() }))) {
      return { ...result, status: "duplicate", reason: `本时段（${plan.label}）已更新过` };
    }
  }

  // 盘后收缩（节约 Wind 额度）：仅当「当日已完成收盘帧（行情时点为 15:00）」后，
  // 盘后刷新才只更新新闻催化；若当日快照仍是盘中时点（如 09:36），盘后刷新必须
  // 全量重跑以取 15:00 收盘数据，不能跳过。
  if (market === "cn" && plan.minute > 15 * 60) {
    const todayEmotion = (await store.kvGet(KEY.emotion).catch(() => null))?.value;
    const quoteMatch = String(todayEmotion?.quoteTime || "").match(/(\d{2}):(\d{2})/);
    const closeMinutes = quoteMatch ? Number(quoteMatch[1]) * 60 + Number(quoteMatch[2]) : null;
    const hasCloseFrame = todayEmotion && String(todayEmotion.tradingDate) === plan.day && closeMinutes != null && closeMinutes >= 15 * 60;
    if (hasCloseFrame) {
      jobs.emotion = false;
      jobs.anomalies = false;
      result.skipped.push("emotion/anomalies: 盘后收缩，仅刷新新闻催化（当日已有 15:00 收盘快照）");
    }
  }

  if (!isMockMode() && getApiKeys().length === 0) {
    return finish("error", { errors: ["WIND_API_KEY 未配置（Vercel → Settings → Environment Variables）"] });
  }

  // 当日状态优先；台股的连板名单需要跨日延续，所以再回退到最近一次保存的状态。
  const savedState = (await store.kvGet(KEY.engineState(plan.day)).catch(() => null))?.value
    || (await store.kvGet(KEY.engineStateLatest).catch(() => null))?.value;
  importEngineState(savedState, plan.day);

  let marketLive = true;
  if (jobs.emotion) {
    try {
      // 情绪方向上下文：以最近每日收分为对比基准，供 classify 判定“从冷转热=修复 / 从热转冷=分歧”。
      // 注意排除今日——dailyHistory 会把今日盘中快照也聚合进当日记，只能拿更早的交易日作基准。
      let continuity = null;
      try {
        const today = cnEngine.localDate();
        const daily = await store.dailyHistory();
        const scores = (daily || [])
          .filter((item) => String(item.tradingDate) !== today)
          .map((item) => Number(item.score)).filter(Number.isFinite);
        if (scores.length) {
          const prevScore = scores.at(-1);
          const tail = scores.slice(-5);
          continuity = {
            prevScore,
            avg5: tail.reduce((sum, value) => sum + value, 0) / tail.length,
            lastScores: scores.slice(-8), // 最近交易日序列（升序，用于“连续热区天数”判定）
            sample: scores.length
          };
        }
      } catch { /* 无历史时按截面档位判定 */ }
      const snapshot = await transform(await loadEmotion(undefined, continuity));
      const quoteDay = quoteDayOf(snapshot);
      if (SCHEDULE.endOfDay && quoteDay) {
        // 盘后模式（台股）：Wind 只有收盘数据，直接保存最近一个交易日的快照，每日曲线按交易日记一个点。
        const eodSnapshot = { ...snapshot, tradingDate: quoteDay, endOfDay: true };
        await store.kvSet(KEY.emotion, eodSnapshot);
        const record = historyRecord(eodSnapshot);
        await store.historyUpsert(record, isTradingSessionHistory(record));
        result.ran.push(`emotion(eod ${quoteDay})`);
      } else if (quoteDay === plan.day) {
        await store.kvSet(KEY.emotion, snapshot);
        const record = historyRecord(snapshot);
        await store.historyUpsert(record, isTradingSessionHistory(record));
        result.ran.push("emotion");
      } else if (result.mode !== "scheduled" && quoteDay) {
        // Manual/bootstrap run outside a session: show the last session's numbers, add no curve point.
        await store.kvSet(KEY.emotion, { ...snapshot, tradingDate: quoteDay, offSession: true });
        result.ran.push("emotion(off-session)");
      } else if (!quoteDay) {
        marketLive = false;
        result.errors.push(`emotion: Wind 未返回行情时间，保留上一份快照 | ${snapshot.errors.slice(0, 3).join(" | ")}`);
      } else if (plan.minute >= SCHEDULE.holidayCheckAfter) {
        await store.kvSet(KEY.calendar(plan.day), { trading: false, quoteDay, checkedAt: now.toISOString() });
        return finish("holiday", { reason: `行情时间停留在 ${quoteDay}，判定今日休市，今天不再调用 Wind` });
      } else {
        marketLive = false;
        result.skipped.push(`emotion: 行情尚未切换到 ${plan.day}`);
      }
    } catch (error) {
      result.errors.push(`emotion: ${errorText(error)}`);
    }
  }

  const tasks = [];
  if (jobs.anomalies && !marketLive && result.mode === "scheduled" && !SCHEDULE.endOfDay) {
    result.skipped.push("anomalies: 当日行情未就绪，跳过以免覆盖为旧数据");
  } else if (jobs.anomalies) {
    tasks.push(loadThemeAnomalies().then(transform).then(async (output) => {
      // A fully failed run (nothing returned) must not wipe the last good radar.
      if (!output.items.length && output.partial && await store.kvGet(KEY.anomalies)) {
        result.errors.push(`anomalies: 本次无有效结果，保留上一份 | ${output.errors.slice(0, 3).join(" | ")}`);
        return;
      }
      await store.kvSet(KEY.anomalies, output);
      result.ran.push("anomalies");
    }).catch((error) => { result.errors.push(`anomalies: ${errorText(error)}`); }));
  }
  if (jobs.news) {
    tasks.push(loadNews().then(transform).then(async (items) => {
      if (!items.length) { result.skipped.push("news: 无新结果"); return; }
      await store.kvSet(KEY.news, { asOf: new Date().toISOString(), items });
      result.ran.push("news");
    }).catch((error) => { result.errors.push(`news: ${errorText(error)}`); }));
  }
  if (market === "cn" && jobs.limitup) {
    // 涨停事件快照：分板块取数 + 连板历史，约 9 次 Wind 调用
    tasks.push((async () => {
      try {
        const board = await loadLimitUpBoard(plan.day);
        if (board.degraded) {
          result.skipped.push("limitup: Wind 未返回涨停列表，保留上一份快照");
          return;
        }
        await store.kvSet(KEY.limitup, board);
        await store.kvSet(KEY.limitupDay(board.tradingDate), board);
        result.ran.push("limitup");
        if (board.dataQuality?.truncated) result.errors.push(`limitup: ${(board.dataQuality.cappedSectors || []).join("/")}触顶 100 行，家数可能不全`);
      } catch (error) {
        result.errors.push(`limitup: ${errorText(error)}`);
      }
    })());
  }
  if (market === "cn" && jobs.fundFlow) {
    tasks.push((async () => {
      try {
        const sample = await appendTodaySample(store, { now });
        if (sample.skipped) result.skipped.push(`fund-flow: ${sample.reason || "本轮榜单为空，保留上一份快照"}`);
        else result.ran.push("fund-flow");
        const windows = await refreshWindows(store, { now });
        result.ran.push(...windows.built);
        if (windows.errors.length) result.errors.push(...windows.errors.slice(0, 3));
      } catch (error) {
        result.errors.push(`fund-flow: ${errorText(error)}`);
      }
    })());
  }
  await Promise.all(tasks);

  const engineState = exportEngineState(plan.day);
  await store.kvSet(KEY.engineState(plan.day), engineState).catch((error) => {
    result.errors.push(`engine-state: ${errorText(error)}`);
  });
  await store.kvSet(KEY.engineStateLatest, engineState).catch(() => {});

  if (jobs.cleanup) {
    try {
      const removedDays = await store.historyPrune(SCHEDULE.historyTradingDays);
      const cutoff = new Date(now.getTime() - 3 * 86_400_000).toISOString();
      for (const prefix of ["lock:", "engine-state:2", "calendar:", "fund-flow:today:"]) await store.kvDeleteOlderThan(prefix, cutoff);
      result.ran.push(`cleanup(-${removedDays}d)`);
    } catch (error) {
      result.errors.push(`cleanup: ${errorText(error)}`);
    }
  }

  return finish(result.errors.length && !result.ran.length ? "error" : "ok");
}

const EMPTY_ANOMALIES = {
  items: [],
  summary: { total: 0, rawTotal: 0, mergedTotal: 0, filteredOut: 0, minScore: 60 },
  limitData: { stockCount: 0, streakCounts: {} },
  partial: true,
  errors: []
};

export class NotReadyError extends Error {}

/** Stored data for page visitors. Never calls Wind. */
export async function readResource(resource, market = "cn", { fresh = false } = {}) {
  market = normalizeMarket(market);
  const { classify } = MARKET_CONFIG[market].engine;
  const SCHEDULE = scheduleFor(market);
  const store = getStore(market, { fresh });
  const meta = (entry) => ({ marketCode: market, storedAt: entry?.updatedAt || null, schedule: scheduleSummary(market) });

  if (resource === "emotion") {
    const entry = await store.kvGet(KEY.emotion);
    if (!entry) throw new NotReadyError(market === "tw"
      ? `暫無快照：首個數據將在下一個交易時段由定時任務生成（${scheduleSummary(market)}）`
      : `暂无快照：首个数据将在下一个交易时段由定时任务生成（${scheduleSummary(market)}）`);
    return { ...entry.value, ...meta(entry) };
  }
  if (resource === "anomalies") {
    const entry = await store.kvGet(KEY.anomalies);
    return entry ? { ...entry.value, ...meta(entry) } : { ...EMPTY_ANOMALIES, pending: true, ...meta(null) };
  }
  if (resource === "limitup") {
    // 涨停事件快照由 scripts/limitup/build.mjs 写入：kv/limitup_latest.json + kv/limitup_day_<day>.json
    const entry = await store.kvGet(KEY.limitup);
    if (!entry) throw new NotReadyError("暂无涨停事件快照：请先运行 node --env-file=.env scripts/limitup/build.mjs");
    const baseDay = entry.value?.promotion?.baseTradingDate || null;
    // 优先用上一交易日的完整定格快照（含封板时间与概念，可算概念环比）；
    // 该快照只有"当天收盘后跑过一次"才会存在，否则回落到快照内置的反推值（仅家数与最高板）。
    const baseEntry = baseDay ? await store.kvGet(KEY.limitupDay(baseDay)).catch(() => null) : null;
    return {
      ...entry.value,
      previous: baseEntry?.value ? {
        tradingDate: baseEntry.value.tradingDate,
        limitUpCount: baseEntry.value.summary?.limitUpCount ?? null,
        maxStreak: baseEntry.value.summary?.maxStreak ?? null,
        firstSealCount: baseEntry.value.summary?.firstSealCount ?? null,
        concepts: baseEntry.value.concepts || [],
        partial: false,
        verified: Boolean(baseEntry.value.dataQuality?.historyComplete)
      } : (entry.value?.previous || null),
      ...meta(entry)
    };
  }
  if (resource === "news") {
    const entry = await store.kvGet(KEY.news);
    return { items: entry?.value?.items || [], asOf: entry?.value?.asOf || null, ...meta(entry) };
  }
  if (resource === "history") {
    const latest = await store.kvGet(KEY.emotion);
    const tradingDate = latest?.value?.tradingDate || await store.historyLatestDate();
    const [history, daily] = await Promise.all([
      tradingDate ? store.historyForDate(tradingDate) : [],
      store.dailyHistory()
    ]);
    const dailyHistory = daily.slice(-SCHEDULE.historyTradingDays)
      .map((item) => ({ ...item, phase: classify(item.score, { upRatio: null }).phase }));
    return { tradingDate, history, dailyHistory };
  }
  if (resource === "fund-flow") {
    const latest = await store.kvGet(KEY.emotion).catch(() => null);
    const tradingDate = latest?.value?.tradingDate || null;
    return { ...(await readFundFlow(store, { tradingDate })), ...meta(latest) };
  }
  if (resource === "status") {
    const lastRun = await store.kvGet(KEY.lastRun).catch(() => null);
    return {
      ok: true,
      marketCode: market,
      storage: storageMode(),
      windKeyConfigured: getApiKeys().length > 0,
      mock: isMockMode(),
      schedule: scheduleSummary(market),
      lastRun: lastRun?.value || null
    };
  }
  throw Object.assign(new Error(`未知资源：${resource}`), { statusCode: 404 });
}
