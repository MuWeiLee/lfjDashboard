// @vitest-environment node
import { duePlan } from "../api/_lib/short-emotion/schedule.js";

// Beijing time helper: 2026-10-12 is a Monday.
const bj = (date, time) => new Date(`${date}T${time}:00+08:00`);
const due = (date, time) => Object.entries(duePlan(bj(date, time)).jobs).filter(([, on]) => on).map(([name]) => name).sort();

describe("短线情绪 schedule (every 30 min, 09:00–15:00 Beijing)", () => {
  it("09:00 pre-open refreshes news only", () => {
    expect(due("2026-10-12", "09:00")).toEqual(["news"]);
  });

  it("trading slots refresh market data, fund flow and news", () => {
    for (const time of ["09:30", "10:00", "11:30", "13:00", "14:30"]) {
      expect(due("2026-10-12", time)).toEqual(["anomalies", "emotion", "fundFlow", "news"]);
    }
  });

  it("lunch break refreshes news only", () => {
    expect(due("2026-10-12", "12:00")).toEqual(["news"]);
    expect(due("2026-10-12", "12:30")).toEqual(["news"]);
  });

  it("15:00 is the last run and includes cleanup", () => {
    expect(due("2026-10-12", "15:00")).toEqual(["anomalies", "cleanup", "emotion", "fundFlow", "news"]);
    expect(due("2026-10-12", "15:30")).toEqual([]);
  });

  it("a delayed GitHub run stays in its 30-minute slot", () => {
    expect(duePlan(bj("2026-10-12", "10:17")).slot).toBe(600);
    expect(due("2026-10-12", "10:17")).toEqual(["anomalies", "emotion", "fundFlow", "news"]);
  });

  it("weekends and off-hours never call Wind", () => {
    expect(due("2026-10-17", "10:00")).toEqual([]);
    expect(due("2026-10-12", "08:30")).toEqual([]);
    expect(due("2026-10-12", "20:00")).toEqual([]);
  });
});

describe("台股 schedule (end-of-day snapshots inside the existing 09:00–15:30 cron)", () => {
  const twDue = (date, time) => Object.entries(duePlan(bj(date, time), "tw").jobs).filter(([, on]) => on).map(([name]) => name).sort();

  it("09:00 takes the previous close plus news", () => {
    expect(twDue("2026-10-12", "09:00")).toEqual(["anomalies", "emotion", "news"]);
  });

  it("during the session only news updates (Wind Taiwan quotes are end-of-day)", () => {
    for (const time of ["09:30", "11:00", "13:00", "13:30"]) {
      expect(twDue("2026-10-12", time)).toEqual(["news"]);
    }
  });

  it("15:00 and 15:30 take the day's close; 15:30 also cleans up", () => {
    expect(twDue("2026-10-12", "15:00")).toEqual(["anomalies", "emotion"]);
    expect(twDue("2026-10-12", "15:30")).toEqual(["anomalies", "cleanup", "emotion"]);
  });
});

describe("runScheduledRefresh (mock Wind, memory store)", () => {
  let runScheduledRefresh;
  let readResource;

  beforeAll(async () => {
    process.env.WIND_MOCK = "1";
    delete process.env.SUPABASE_URL;
    ({ runScheduledRefresh, readResource } = await import("../api/_lib/short-emotion/service.js"));
  });

  it("forced run stores snapshots that the read API serves", async () => {
    const result = await runScheduledRefresh({ force: true });
    expect(result.status).toBe("ok");
    expect(result.ran).toEqual(expect.arrayContaining(["emotion", "anomalies", "news"]));
    const emotion = await readResource("emotion");
    expect(emotion.score).toBeGreaterThan(0);
    expect(emotion.storedAt).toBeTruthy();
    const history = await readResource("history");
    expect(history.history.length).toBeGreaterThan(0);
  });

  it("outside the schedule with data present it stays idle", async () => {
    const result = await runScheduledRefresh({ now: bj("2026-10-12", "20:00") });
    expect(result.status).toBe("idle");
  });

  it("a slot runs at most once", async () => {
    // Future weekday: mock quotes carry today's date, so the market looks closed for that day.
    const first = await runScheduledRefresh({ now: bj("2030-01-07", "09:00") });
    const second = await runScheduledRefresh({ now: bj("2030-01-07", "09:10") });
    expect(first.ran).toEqual(["news"]);
    expect(second.status).toBe("duplicate");
  });

  it("marks a holiday when quotes never switch to the day, then stops calling Wind", async () => {
    const check = await runScheduledRefresh({ now: bj("2030-01-07", "10:00") });
    expect(check.status).toBe("holiday");
    const later = await runScheduledRefresh({ now: bj("2030-01-07", "10:30") });
    expect(later.status).toBe("holiday");
    expect(later.ran).toEqual([]);
  });
});

describe("台股 refresh (mock Wind, memory store)", () => {
  let runScheduledRefresh;
  let readResource;

  beforeAll(async () => {
    process.env.WIND_MOCK = "1";
    ({ runScheduledRefresh, readResource } = await import("../api/_lib/short-emotion/service.js"));
  });

  it("stores a 台股 snapshot separately from A股", async () => {
    const result = await runScheduledRefresh({ force: true, market: "tw" });
    expect(result.status).toBe("ok");
    expect(result.market).toBe("tw");
    const emotion = await readResource("emotion", "tw");
    expect(emotion.marketCode).toBe("tw");
    expect(emotion.market.up).toBeGreaterThan(0);
    expect(emotion.extremes.limitUp).toBeGreaterThan(0);
    expect(emotion.themes[0].code).toMatch(/^TWSE\d+\.TW$/);
    expect(emotion.schedule).toContain("13:30");
    const anomalies = await readResource("anomalies", "tw");
    expect(anomalies.items.length).toBeGreaterThan(0);
    expect(anomalies.items.every((item) => !item.signals.includes("batch"))).toBe(true);
    const cn = await readResource("emotion", "cn");
    expect(cn.themes[0].code).not.toMatch(/^TWSE/);
  });

  it("rejects unknown markets", async () => {
    await expect(readResource("emotion", "hk")).rejects.toThrow("未知市场");
  });
});
