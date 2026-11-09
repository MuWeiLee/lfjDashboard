// @vitest-environment node
import { vi } from "vitest";

// Wind 调用在本文件内被替换成可控的假实现（不影响其他测试文件）。
const wind = vi.hoisted(() => ({ prices: {}, heat: {}, fail: false, questions: [] }));
vi.mock("../api/_lib/short-emotion/wind-client.js", () => ({
  callWindTool: async (server, tool, params) => {
    const question = params?.question || "";
    wind.questions.push(question);
    if (wind.fail) throw new Error("WIND_UNAVAILABLE");
    if (question.includes("新闻热度历史走势")) {
      const code = question.replace("新闻热度历史走势", "");
      const rows = wind.heat[code];
      return rows ? { data: { data: [{ columns: HEAT_COLUMNS.map((name) => ({ name })), rows }] } } : { data: { data: [] } };
    }
    const codes = question.replace(/近\d+个交易日每日收盘价$/, "").split(",").filter(Boolean);
    const rows = codes.flatMap((code) => wind.prices[code] || []);
    return rows.length ? { data: { data: [{ columns: COLUMNS.map((name) => ({ name })), rows }] } } : { data: { data: [] } };
  }
}));

const {
  GLOBAL_LINKAGE_KEY, LINK_WINDOW, HEAT_WINDOW, PAIR_RELATIONS, LINK_FILTER, LINK_BASIS,
  parseCloseSeries, parseHeatSeries, heatSummary, dailyReturns, periodChange, pearson, alignReturns,
  directionStats, weeklyReturns, stockPerformance, buildGlobalLinkage, refreshGlobalLinkage, readGlobalLinkage
} = await import("../api/_lib/short-emotion/global-linkage.js");

const COLUMNS = ["Wind代码", "证券简称", `近${LINK_WINDOW + 1}交易日每日收盘价`, `近${LINK_WINDOW + 1}交易日每日收盘价时间`, "交易币种"];
const HEAT_COLUMNS = ["Wind代码", "证券简称", "历史每日热度", "历史每日热度时间"];

/** 61 个连续自然日（只用于构造日期串，不校验日历）：覆盖 60 日窗口 + 1 个基准点。 */
const DATES = Array.from({ length: LINK_WINDOW + 1 }, (_, index) => {
  const day = new Date(Date.UTC(2026, 7, 1) + index * 86400000);
  return `2026-${String(day.getUTCMonth() + 1).padStart(2, "0")}-${String(day.getUTCDate()).padStart(2, "0")}`;
});

/** 按给定的日涨跌幅序列造收盘价（起点 100），dates 可截短。 */
function series(code, name, changes, dates = DATES) {
  let price = 100;
  const rows = [[code, name, price, dates[0], "CNY"]];
  changes.forEach((change, index) => {
    price *= 1 + change / 100;
    rows.push([code, name, Number(price.toFixed(4)), dates[index + 1], "CNY"]);
  });
  return rows;
}

/** 造热度宽表：values 依次落在 DATES 上。 */
function heatSeries(code, name, values) {
  return values.map((value, index) => [code, name, value, DATES[index]]);
}

const flatValues = (value, length = 40) => Array.from({ length }, () => value);

// 60 个日涨跌幅：完全相同 → r = 1；两个互相正交的 4 周期 → r ≈ 0
const SAME = Array.from({ length: LINK_WINDOW }, (_, index) => [1, -2, 3, 0.5, -1, 2, 1.5, -0.5, 2.5, -1.5][index % 10]);
const CYCLE_A = Array.from({ length: LINK_WINDOW }, (_, index) => [1, 1, -1, -1][index % 4]);
const CYCLE_B = Array.from({ length: LINK_WINDOW }, (_, index) => [1, -1, 1, -1][index % 4]);

/** 价格：覆盖若干只，其余留空以验证「取数缺失也不删除条目」。 */
function fixtures() {
  wind.prices = {
    "688981.SH": series("688981.SH", "中芯国际", CYCLE_A),
    "603986.SH": series("603986.SH", "兆易创新", SAME),
    "000660.KS": series("000660.KS", "SK海力士(SK HYNIX)", SAME),
    "300308.SZ": series("300308.SZ", "中际旭创", CYCLE_A),
    "AVGO.O": series("AVGO.O", "博通(BROADCOM)", CYCLE_B)
  };
  wind.heat = {
    "688981.SH": heatSeries("688981.SH", "中芯国际", flatValues(70)),
    "603986.SH": heatSeries("603986.SH", "兆易创新", flatValues(90)),
    "300308.SZ": heatSeries("300308.SZ", "中际旭创", flatValues(95)),
    "000660.KS": heatSeries("000660.KS", "SK海力士(SK HYNIX)", flatValues(88)),
    "005930.KS": heatSeries("005930.KS", "三星电子", flatValues(96))
  };
  wind.questions.length = 0;
}

const memoryStore = () => {
  const map = new Map();
  return {
    map,
    kvGet: async (key) => (map.has(key) ? map.get(key) : null),
    kvSet: async (key, value) => { map.set(key, { value, updatedAt: new Date().toISOString() }); }
  };
};

const allPairs = (snapshot) => snapshot.groups.flatMap((group) => group.themes.flatMap((theme) => theme.pairs));
const findPair = (snapshot, id) => allPairs(snapshot).find((pair) => pair.id === id);

describe("收盘价解析与涨跌幅", () => {
  it("过滤 0 价/无效行并按代码归并", () => {
    const map = parseCloseSeries({ data: { data: [{ columns: COLUMNS.map((name) => ({ name })), rows: [
      ["688981.SH", "中芯国际", 100, "2026-10-01", "CNY"],
      ["688981.SH", "中芯国际", 0, "2026-10-02", "CNY"],
      ["688981.SH", "中芯国际", 110, "2026-10-03", "CNY"],
      ["TSM.N", "台积电", 500, "2026-10-01", "USD"]
    ] }] } });
    expect([...map.keys()]).toEqual(["688981.SH", "TSM.N"]);
    expect(map.get("688981.SH").points).toEqual([
      { date: "20261001", price: 100 },
      { date: "20261003", price: 110 }
    ]);
  });

  it("日涨跌幅与区间涨跌幅", () => {
    const points = [{ date: "20261001", price: 100 }, { date: "20261002", price: 110 }, { date: "20261003", price: 99 }];
    expect(dailyReturns(points).get("20261002")).toBeCloseTo(10, 6);
    expect(dailyReturns(points).get("20261003")).toBeCloseTo(-10, 6);
    expect(periodChange(points)).toBeCloseTo(-1, 6);
  });

  it("区间涨跌幅样本不足时返回 null", () => {
    expect(periodChange([{ date: "20261001", price: 100 }])).toBeNull();
  });
});

describe("新闻热度解析与 30 日均值", () => {
  it("按日期归并热度点，跳过无效值", () => {
    const map = parseHeatSeries({ data: { data: [{ columns: HEAT_COLUMNS.map((name) => ({ name })), rows: [
      ["688981.SH", "中芯国际", 88.5, "2026-10-01"],
      ["688981.SH", "中芯国际", null, "2026-10-02"],
      ["688981.SH", "中芯国际", 91, "2026-10-03"]
    ] }] } });
    expect(map.get("688981.SH").points).toEqual([
      { date: "20261001", heat: 88.5 },
      { date: "20261003", heat: 91 }
    ]);
  });

  it("只取最近 30 个有效交易日做算术平均，并给出区间", () => {
    const points = Array.from({ length: 40 }, (_, index) => ({ date: `2026${String(index).padStart(4, "0")}`, heat: index + 1 }));
    const summary = heatSummary(points);
    expect(summary.samples).toBe(HEAT_WINDOW);
    expect(summary.average).toBe(25.5); // 11..40 的平均
    expect(summary.latest).toBe(40);
    expect(summary.startDate).toBe(points[10].date);
    expect(summary.endDate).toBe(points[39].date);
  });

  it("没有热度数据时全部返回 null，不补零", () => {
    expect(heatSummary([])).toEqual({ average: null, latest: null, latestDate: null, samples: 0, startDate: null, endDate: null });
  });
});

describe("个股日 / 周涨跌幅（复用收盘价序列，不额外取数）", () => {
  it("日=最近交易日较前一交易日，周=上周最后收盘到本周最新收盘", () => {
    const points = [
      { date: "20260925", price: 100 }, // 上周五
      { date: "20260928", price: 102 }, // 本周一
      { date: "20260929", price: 102 },
      { date: "20260930", price: 101 }
    ];
    const perf = stockPerformance(points);
    expect(perf.day).toBe(-0.98); // 101 / 102 - 1
    expect(perf.dayDate).toBe("20260930");
    expect(perf.prevDate).toBe("20260929");
    expect(perf.week).toBe(1); // 101 / 100 - 1
    expect(perf.weekStart).toBe("20260928");
    expect(perf.weekBaseDate).toBe("20260925");
  });

  it("本周只有第一个交易日时，周涨跌幅等于当日涨跌幅，不拿上周数据累加", () => {
    const perf = stockPerformance([{ date: "20260925", price: 100 }, { date: "20260928", price: 105 }]);
    expect(perf.day).toBe(5);
    expect(perf.week).toBe(5);
    expect(perf.weekStart).toBe("20260928");
    expect(perf.weekBaseDate).toBe("20260925");
  });

  it("数据不足返回 null，不补零", () => {
    expect(stockPerformance([{ date: "20260930", price: 100 }])).toMatchObject({ day: null, week: null, dayDate: "20260930" });
    expect(stockPerformance([])).toEqual({ day: null, dayDate: null, prevDate: null, week: null, weekStart: null, weekBaseDate: null });
  });
});

describe("相关性与交易日对齐（仅作参考字段）", () => {
  it("完全同向 → 1，完全反向 → -1", () => {
    const up = [1, 2, -1, 3, -2, 1.5];
    const aligned = up.map((value, index) => [`2026100${index + 1}`, value, value * 2]);
    expect(pearson(aligned).value).toBe(1);
    const inverse = up.map((value, index) => [`2026100${index + 1}`, value, -value]);
    expect(pearson(inverse).value).toBe(-1);
  });

  it("样本少于 5 个时不计算", () => {
    expect(pearson([["20261001", 1, 1], ["20261002", 2, 2]])).toEqual({ value: null, samples: 2 });
  });

  it("美股按 T-1 对齐：A股 T 的涨跌幅对上海外 T-1", () => {
    const cn = new Map([["20261002", 1], ["20261003", 2], ["20261004", 3]]);
    const peer = new Map([["20261001", 10], ["20261002", 20], ["20261003", 30]]);
    expect(alignReturns(cn, peer, 1)).toEqual([
      ["20261002", 1, 10],
      ["20261003", 2, 20],
      ["20261004", 3, 30]
    ]);
  });

  it("韩股同日对齐时取当天值", () => {
    const cn = new Map([["20261002", 1], ["20261003", 2]]);
    const peer = new Map([["20261002", 5], ["20261003", 6]]);
    expect(alignReturns(cn, peer, 0)).toEqual([["20261002", 1, 5], ["20261003", 2, 6]]);
  });

  it("方向同步率给出同涨/同跌占比，平盘不计同步但计入总天数", () => {
    const aligned = [["20261001", 1, 2], ["20261002", 3, 1], ["20261003", -1, -2], ["20261004", 0, -1]];
    expect(directionStats(aligned)).toEqual({ syncRate: 0.75, upRate: 0.5, downRate: 0.25, samples: 4 });
  });

  it("周收益按自然周复利聚合，周一作为分组键", () => {
    // 2026-08-03 是周一
    const aligned = [
      ["20260803", 10, 5], ["20260804", 10, 5], ["20260807", -10, -5],
      ["20260810", 20, 10], ["20260811", 0, 0]
    ];
    const weeks = weeklyReturns(aligned);
    expect(weeks).toHaveLength(2);
    expect(weeks[0][0]).toBe("20260803");
    expect(weeks[0][1]).toBeCloseTo((1.1 * 1.1 * 0.9 - 1) * 100, 4);
    expect(weeks[0][2]).toBeCloseTo((1.05 * 1.05 * 0.95 - 1) * 100, 4);
  });
});

describe("buildGlobalLinkage（按热度排序，相关性不筛选）", () => {
  let snapshot = null;
  let pairs = [];

  beforeAll(() => {
    fixtures();
    const pricePayload = {
      data: {
        data: [{
          columns: COLUMNS.map((name) => ({ name })),
          rows: Object.values(wind.prices).flat()
        }]
      }
    };
    const heatPayload = {
      data: {
        data: [{
          columns: HEAT_COLUMNS.map((name) => ({ name })),
          rows: ["688981.SH", "603986.SH", "300308.SZ", "000660.KS", "005930.KS"].flatMap((code) => wind.heat[code])
        }]
      }
    };
    snapshot = buildGlobalLinkage([pricePayload], { now: new Date("2026-11-05T09:00:00Z"), heatPayloads: [heatPayload] });
    pairs = allPairs(snapshot);
  });

  it("28 组配对全部展示，不因相关性低而删除", () => {
    expect(pairs).toHaveLength(28);
    expect(snapshot.stats).toMatchObject({ defined: 28, shown: 28 });
    expect(snapshot.window).toBe(LINK_WINDOW);
    expect(snapshot.heat.window).toBe(HEAT_WINDOW);
    expect(snapshot.heat.coverage.requested).toBe(25); // 17 只 A股 + 8 只韩股
    expect(snapshot.heat.coverage.available).toBe(5);
    expect(snapshot.heat.coverage.missing).toContain("000768.SZ"); // Wind 没返回就记 missing，不补零
    expect(snapshot.filter).toBe(LINK_FILTER);
    expect(snapshot.basis).toBe(LINK_BASIS);
    expect(LINK_FILTER).toContain("28 组");
    expect(LINK_FILTER).toContain("不构成筛选条件");
    expect(LINK_BASIS).toContain("新闻热度");
  });

  it("热度降序排名，跨中美/中韩统一排；热度缺失不占名次", () => {
    const ranked = pairs.filter((pair) => pair.heat.rank != null).sort((a, b) => a.heat.rank - b.heat.rank);
    expect(ranked[0].cn.code).toBe("300308.SZ"); // 95
    expect(ranked[0].heat.rank).toBe(1);
    expect(ranked[0].heat.average).toBe(95);
    expect(ranked[1].heat.average).toBe(90);
    expect(ranked[2].heat.average).toBe(90); // 兆易创新两组并列第 2
    expect(ranked[2].heat.rank).toBe(2);
    const missing = pairs.filter((pair) => pair.heat.average == null);
    expect(missing.length).toBeGreaterThan(0);
    expect(missing.every((pair) => pair.heat.rank == null)).toBe(true);
  });

  it("排序落地到主题与配对：同主题内热度高的在前", () => {
    const semi = snapshot.groups.find((group) => group.market === "US").themes.find((theme) => theme.theme === "半导体");
    expect(semi.pairs.map((pair) => pair.cn.name)).toEqual(["兆易创新", "中芯国际", "中芯国际", "北方华创"]);
    const firstTheme = snapshot.groups.find((group) => group.market === "KR").themes[0];
    expect(firstTheme.theme).toBe("半导体"); // 中芯 70 / 兆易 90，高于其他中韩主题
  });

  it("相关性只是参考字段：取值照实展示，不生成 pass/strength", () => {
    const pair = findPair(snapshot, "kr-semi-hynix");
    expect(pair.direction).toMatchObject({ syncRate: 1, samples: LINK_WINDOW });
    expect(pair.direction).not.toHaveProperty("pass");
    expect(pair.weekly.correlation).toBe(1);
    expect(pair).not.toHaveProperty("strength");
    const orthogonal = findPair(snapshot, "us-ai-avgo");
    expect(Math.abs(orthogonal.weekly.correlation)).toBeLessThan(0.5); // 相关性低也保留
  });

  it("每组带一句产业链关系说明", () => {
    for (const pair of pairs) {
      expect(pair.relation).toBe(PAIR_RELATIONS[pair.id]);
      expect(pair.relation.length).toBeGreaterThan(10);
    }
  });

  it("海外侧热度单独记录：韩股有值、美股为空", () => {
    expect(findPair(snapshot, "kr-semi-hynix").peerHeat.average).toBe(88);
    expect(findPair(snapshot, "kr-semi-hynix").peerHeat.samples).toBe(HEAT_WINDOW);
    expect(findPair(snapshot, "us-semi-tsm").peerHeat.average).toBeNull();
  });

  it("价格缺失时字段留空但仍保留条目，并计入 priceMissing", () => {
    const pair = findPair(snapshot, "us-semi-tsm");
    expect(pair.peer.changePct).toBeNull();
    expect(pair.peer.perf).toEqual({ day: null, dayDate: null, prevDate: null, week: null, weekStart: null, weekBaseDate: null });
    expect(pair.weekly).toEqual({ correlation: null, samples: 0 });
    expect(snapshot.stats.priceMissing).toContain("TSM.N");
    expect(snapshot.stats.priceMissing).not.toContain("688981.SH");
    expect(snapshot.stats.perfMissing).toContain("TSM.N");
  });

  it("每只个股带日 / 周涨跌幅，A股侧日期跟随快照交易日", () => {
    const pair = findPair(snapshot, "kr-semi-hynix");
    expect(pair.cn.perf.dayDate).toBe(snapshot.tradingDate);
    expect(pair.peer.perf.dayDate).toBe(snapshot.tradingDate);
    expect(Number.isFinite(pair.cn.perf.day)).toBe(true);
    expect(Number.isFinite(pair.cn.perf.week)).toBe(true);
    expect(Number.isFinite(pair.peer.perf.week)).toBe(true);
  });

  it("美股侧日涨跌幅用自己的 T-1 日期，不套用 A股交易日", () => {
    const cnRows = series("688981.SH", "中芯国际", [1, 1, 1], ["2026-09-25", "2026-09-28", "2026-09-29", "2026-09-30"]);
    const usRows = series("TSM.N", "台积电", [2, 2, 2], ["2026-09-24", "2026-09-25", "2026-09-28", "2026-09-29"]);
    const payload = { data: { data: [{ columns: COLUMNS.map((name) => ({ name })), rows: [...cnRows, ...usRows] }] } };
    const next = buildGlobalLinkage([payload]);
    const pair = findPair(next, "us-semi-tsm");
    expect(next.tradingDate).toBe("20260930");
    expect(pair.cn.perf).toMatchObject({ day: 1, week: 3.03, dayDate: "20260930" });
    expect(pair.peer.perf).toMatchObject({ day: 2, week: 4.04, dayDate: "20260929" });
  });
});

describe("refreshGlobalLinkage（假 Wind + 内存存储）", () => {
  beforeEach(() => fixtures());

  it("只对 A股与韩股取热度，美股不发无意义的请求", async () => {
    const store = memoryStore();
    const output = await refreshGlobalLinkage(store, { now: new Date("2026-11-05T09:00:00Z") });
    expect(output.value).toBeTruthy();
    const heatQuestions = wind.questions.filter((question) => question.includes("新闻热度历史走势"));
    expect(heatQuestions).toHaveLength(25);
    expect(heatQuestions.some((question) => question.includes("TSM.N"))).toBe(false);
    expect(heatQuestions.some((question) => question.includes("036570.KS"))).toBe(true);
    expect(store.map.get(GLOBAL_LINKAGE_KEY).value.heat.coverage.requested).toBe(25);
  });

  it("Wind 全部失败时不写缓存", async () => {
    wind.fail = true;
    const store = memoryStore();
    const output = await refreshGlobalLinkage(store, { now: new Date("2026-11-05T09:00:00Z") });
    expect(output.skipped).toBe(true);
    expect(store.map.size).toBe(0);
    wind.fail = false;
  });

  it("Wind 返回更早的交易日时保留上一份快照", async () => {
    const store = memoryStore();
    await store.kvSet(GLOBAL_LINKAGE_KEY, { tradingDate: "20261106", groups: [] });
    const output = await refreshGlobalLinkage(store, { now: new Date("2026-11-05T09:00:00Z") });
    expect(output.skipped).toBe(true);
    expect(store.map.get(GLOBAL_LINKAGE_KEY).value.tradingDate).toBe("20261106");
  });

  it("读取时补 pending=false 与 storedAt", async () => {
    const store = memoryStore();
    await refreshGlobalLinkage(store, { now: new Date("2026-11-05T09:00:00Z") });
    const read = await readGlobalLinkage(store);
    expect(read.pending).toBe(false);
    expect(read.storedAt).toBeTruthy();
    expect(allPairs(read)).toHaveLength(28);
  });
});
