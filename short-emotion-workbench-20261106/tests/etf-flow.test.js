// @vitest-environment node
import { ETF_FLOW_KEY, ETF_UNIVERSE, ETF_ALERT_CONFIG, parseEtfRows, deriveNetFlow, shareScaleOf, buildEtfFlow, computeWindowAlerts, refreshEtfFlow, readEtfFlow } from "../api/_lib/short-emotion/etf-flow.js";

const COLUMNS = ["Wind代码", "证券简称", "近21交易日每日收盘价", "近21交易日每日收盘价时间", "交易币种", "近21交易日每日基金份额", "近21交易日每日基金份额时间"];

function payload(rows) {
  return { data: { data: [{ columns: COLUMNS.map((name) => ({ name })), rows }] } };
}

const memoryStore = () => {
  const map = new Map();
  return {
    map,
    kvGet: async (key) => (map.has(key) ? { value: map.get(key) } : null),
    kvSet: async (key, value) => { map.set(key, value); }
  };
};

describe("ETF 净申赎推导（Δ份额 × 收盘价）", () => {
  it("按万份口径换算成亿元", () => {
    // 510300：10-08 200 万份 → 10-09 201 万份（+1 万份 × 1e4 × 4.1 元 = 4.1 亿）
    // 10-10/10-11 是周末，份额与价格不变 → 剔除；10-12 赎回 2 万份 × 1e4 × 4.2 元 = -8.4 亿
    const rows = [
      { date: "20261008", price: 4.0, share: 2_000_000 },
      { date: "20261009", price: 4.1, share: 2_010_000 },
      { date: "20261010", price: 4.1, share: 2_010_000 },
      { date: "20261011", price: 4.1, share: 2_010_000 },
      { date: "20261012", price: 4.2, share: 1_990_000 }
    ];
    expect(deriveNetFlow(rows, { days: 5 })).toEqual([
      { date: "20261009", amount: 4.1 },
      { date: "20261012", amount: -8.4 }
    ]);
  });

  it("Wind 若直接返回「份」也按同一口径换算", () => {
    const rows = [
      { date: "20261008", price: 4.0, share: 20_000_000_000 },
      { date: "20261009", price: 4.1, share: 20_100_000_000 },
      { date: "20261012", price: 4.2, share: 19_900_000_000 }
    ];
    expect(shareScaleOf(rows.map((row) => row.share))).toBe(1);
    expect(deriveNetFlow(rows, { days: 5 })).toEqual([
      { date: "20261009", amount: 4.1 },
      { date: "20261012", amount: -8.4 }
    ]);
  });

  it("只保留近 N 个交易日的变动", () => {
    const rows = Array.from({ length: 12 }, (_, index) => ({
      date: `202610${String(index + 1).padStart(2, "0")}`,
      price: 3,
      share: 1_000_000 + index * 10_000
    }));
    const flow = deriveNetFlow(rows, { days: 5 });
    expect(flow).toHaveLength(5);
    expect(flow.at(-1).date).toBe("20261012");
  });
});

describe("多代码宽表解析与快照", () => {
  it("区分收盘价 / 收盘价时间 / 基金份额 / 份额时间四列", () => {
    const parsed = parseEtfRows(payload([
      ["510050.SH", "华夏上证50ETF", 2.938, "2026-10-01", "CNY", 693876.6757, "20261001"],
      ["510050.SH", "华夏上证50ETF", 2.918, "2026-10-08", "CNY", 693516.68, "20261008"],
      ["510300.SH", "华泰柏瑞沪深300ETF", 4.432, "2026-10-01", "CNY", 2411958.769, "20261001"],
      ["510300.SH", "华泰柏瑞沪深300ETF", 4.389, "2026-10-08", "CNY", 2406378.77, "20261008"]
    ]));
    expect([...parsed.keys()]).toEqual(["510050.SH", "510300.SH"]);
    expect(parsed.get("510050.SH").name).toBe("华夏上证50ETF");
    expect(parsed.get("510050.SH").rows).toHaveLength(2);
    expect(parsed.get("510050.SH").rows[1].price).toBe(2.918);
  });

  it("快照只保留指定 ETF 并给出日期轴", () => {
    const rows = [];
    for (const [code, base] of [["510300.SH", 2_000_000], ["510500.SH", 800_000]]) {
      for (let index = 0; index < 6; index += 1) {
        const day = String(index + 8).padStart(2, "0");
        rows.push([code, code === "510300.SH" ? "华泰柏瑞沪深300ETF" : "南方中证500ETF", 4, `2026-10-${day}`, "CNY", base + index * 20_000, `202610${day}`]);
      }
    }
    const snapshot = buildEtfFlow([payload(rows)], { now: new Date("2026-10-20T08:00:00Z"), days: 5 });
    expect(snapshot.dates).toEqual(["20261009", "20261010", "20261011", "20261012", "20261013"]);
    expect(snapshot.tradingDate).toBe("20261013");
    expect(snapshot.series.map((line) => line.code)).toEqual(["510300.SH", "510500.SH"]);
    expect(snapshot.series[0].label).toBe("沪深300");
    expect(snapshot.series[0].points).toHaveLength(5); // 6 个份额点 → 5 个变动日
    expect(snapshot.missing).toEqual(ETF_UNIVERSE.filter((item) => !["510300.SH", "510500.SH"].includes(item.code)).map((item) => item.code));
  });

  it("空快照返回 pending 占位，不抛错", async () => {
    const snapshot = await readEtfFlow(memoryStore());
    expect(snapshot.pending).toBe(true);
    expect(snapshot.series).toEqual([]);
    expect(snapshot.basis).toContain("基金份额");
  });
});

describe("computeWindowAlerts（单日阈值 / 连续天数 / 方向）", () => {
  const dates = ["20261001", "20261002", "20261003", "20261004", "20261005", "20261006", "20261007"];
  const line = (code, amounts) => ({
    code,
    label: code,
    points: amounts.map((amount, index) => ({ date: dates[index], amount }))
  });
  const run = (amounts) => computeWindowAlerts([line("510300.SH", amounts)], dates.slice(0, amounts.length));

  it("单日净申购 ≥ 50 亿触发，并记录日期与最大一笔", () => {
    const result = run([10, 60, -5]);
    expect(result.summary.count).toBe(1);
    expect(result.byCode["510300.SH"].singleDay.hits).toEqual([{ date: "20261002", amount: 60 }]);
    expect(result.byCode["510300.SH"].singleDay.max).toEqual({ date: "20261002", amount: 60 });
    expect(result.summary.topSingle).toMatchObject({ code: "510300.SH", date: "20261002", amount: 60 });
  });

  it("未达阈值不触发", () => {
    const result = run([10, 49.9, 20]);
    expect(result.summary.count).toBe(0);
    expect(result.byCode["510300.SH"].singleDay.hits).toEqual([]);
    expect(result.byCode["510300.SH"].singleDay.max).toBeNull();
    expect(result.summary.topSingle).toBeNull();
  });

  it("连续 5 日净申购触发", () => {
    const result = run([-5, 10, 10, 10, 10, 10]);
    const streak = result.byCode["510300.SH"].streak;
    expect(streak.direction).toBe("in");
    expect(streak.days).toBe(5);
    expect(streak.alert).toBe(true);
    expect(result.summary.topStreak).toMatchObject({ code: "510300.SH", direction: "in", days: 5 });
  });

  it("中间中断只数末尾连续段，不计入", () => {
    const result = run([10, 10, -3, 10, 10, 10, 10]);
    const streak = result.byCode["510300.SH"].streak;
    expect(streak.days).toBe(4);
    expect(streak.alert).toBe(false);
    expect(result.summary.topStreak).toBeNull();
  });

  it("连续净赎回方向为 out", () => {
    const result = run([-10, -10, -10, -10, -10]);
    const streak = result.byCode["510300.SH"].streak;
    expect(streak.direction).toBe("out");
    expect(streak.days).toBe(5);
    expect(streak.alert).toBe(true);
    expect(result.summary.topStreak).toMatchObject({ direction: "out", days: 5 });
  });

  it("阈值来自配置常量", () => {
    expect(ETF_ALERT_CONFIG).toEqual({ singleDayAmount: 50, streakDays: 5 });
    const result = computeWindowAlerts([line("510300.SH", [30, 30])], ["20261001", "20261002"], { config: { singleDayAmount: 30, streakDays: 2 } });
    expect(result.summary.count).toBe(1);
    expect(result.byCode["510300.SH"].streak.alert).toBe(true);
  });
});

describe("refreshEtfFlow（mock Wind + 内存存储）", () => {
  beforeAll(() => { process.env.WIND_MOCK = "1"; });

  it("拉取 8 只宽基 ETF 的近 20 个交易日净申赎", async () => {
    const store = memoryStore();
    const output = await refreshEtfFlow(store, { now: new Date("2026-11-05T09:00:00Z") });
    expect(output.skipped).toBeUndefined();
    expect(output.value.series).toHaveLength(ETF_UNIVERSE.length);
    expect(output.value.dates).toHaveLength(20);
    expect(output.value.basis).toContain("Δ基金份额");
    const amounts = output.value.series.flatMap((line) => line.points.map((point) => point.amount));
    expect(amounts.some((amount) => amount > 0)).toBe(true);
    expect(amounts.some((amount) => amount < 0)).toBe(true);
    expect(store.map.get(ETF_FLOW_KEY)).toEqual(output.value);
  });

  it("新数据更旧时保留缓存（静默降级）", async () => {
    const store = memoryStore();
    store.map.set(ETF_FLOW_KEY, { tradingDate: "20991231", series: [{ code: "510300.SH", points: [] }] });
    const output = await refreshEtfFlow(store, { now: new Date("2026-11-05T09:00:00Z") });
    expect(output.skipped).toBe(true);
    expect(store.map.get(ETF_FLOW_KEY).tradingDate).toBe("20991231");
  });
});
