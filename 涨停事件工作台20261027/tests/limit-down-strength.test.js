// @vitest-environment node
// 跌停 + 题材强弱 + 顶部亮点：纯函数单测。
// 口径一旦跑偏，页面就会把「跌停扩散」读成「走强」，因此这里锁死判定规则。
import {
  aggregateThemeOccurrences, buildHighlights, buildThemeStrength, isLimitDownRow, mergeThemeBoard, summarizePremium
} from "../api/_lib/short-emotion/limit-engine.js";

describe("limit-down row filter", () => {
  const day = "20261027";
  const statusKey = "2026年10月27日涨跌停状态";

  it("accepts rows whose queried-day status is -1", () => {
    expect(isLimitDownRow({ [statusKey]: "-1", Wind代码: "002343.SZ" }, day)).toBe(true);
    expect(isLimitDownRow({ [statusKey]: -1 }, day)).toBe(true);
  });

  it("rejects limit-up rows and semantic drift rows", () => {
    expect(isLimitDownRow({ [statusKey]: "1" }, day)).toBe(false);
    // 「近一年每日涨跌停状态」是 Wind 语义跑偏带出来的历史行，不是当日跌停
    expect(isLimitDownRow({ "近一年每日涨跌停状态": -1 }, day)).toBe(false);
    expect(isLimitDownRow({ "2026年10月27日前一年每日涨跌停状态": -1 }, day)).toBe(false);
  });

  it("rejects rows that carry another day's status column", () => {
    // Wind 把「当日跌停」理解成「区间跌停」时，行里带的是别的日期的状态列
    expect(isLimitDownRow({ "2026年10月23日涨跌停状态": "-1", 涨跌停时间: "2026-10-23T14:00:00+08:00" }, day)).toBe(false);
    expect(isLimitDownRow({ 首次跌停日期: "2026-10-23" }, day)).toBe(false);
  });

  it("falls back to a valid limit-down time when the status column is absent", () => {
    expect(isLimitDownRow({ 涨跌停时间: "2026-10-27T09:31:00+08:00" }, day)).toBe(true);
    expect(isLimitDownRow({}, day)).toBe(false);
  });
});

describe("aggregateThemeOccurrences", () => {
  it("normalizes family aliases and keeps the highest streak", () => {
    const themes = aggregateThemeOccurrences([
      { names: ["人形机器人", "减速器"], streak: 1 },
      { names: ["机器人"], streak: 3 },
      { names: ["机器人", "算力"], streak: 2 }
    ]);
    const robot = themes.find((theme) => theme.name === "机器人");
    expect(robot).toMatchObject({ count: 3, maxStreak: 3 });
    // 同一只股票族内多个概念只计一次，否则家数会虚高
    expect(themes.find((theme) => theme.name === "算力与通信")).toMatchObject({ count: 1, maxStreak: 2 });
  });

  it("returns an empty list for an empty input", () => {
    expect(aggregateThemeOccurrences([])).toEqual([]);
  });
});

describe("buildThemeStrength", () => {
  const base = {
    upThemes: [
      { name: "机器人", count: 4, maxStreak: 3 },
      { name: "算力与通信", count: 2, maxStreak: 1 }
    ],
    downThemes: [
      { name: "机器人", count: 1 },
      { name: "影视", count: 3 }
    ],
    previousThemes: [
      { name: "机器人", count: 6, maxStreak: 4 },
      { name: "影视", count: 1, maxStreak: 1 }
    ],
    brokenThemes: [{ name: "机器人", count: 2 }]
  };

  it("classifies main-up, divergence, weakness and ice-point themes", () => {
    const themes = buildThemeStrength(base);
    const byName = new Map(themes.map((theme) => [theme.name, theme]));

    expect(byName.get("机器人")).toMatchObject({ upCount: 4, downCount: 1, brokenCount: 2, net: 3, status: "分歧", tone: "warn" });
    expect(byName.get("算力与通信")).toMatchObject({ upCount: 2, downCount: 0, status: "走强", tone: "up" });
    expect(byName.get("影视")).toMatchObject({ upCount: 0, downCount: 3, status: "冰点", tone: "down" });
  });

  it("does not call a 2-name theme 主升 no matter how high its board is", () => {
    // 2 只涨停（含一只 2 板）只是试错资金，标成主升会误导仓位
    const themes = buildThemeStrength({
      upThemes: [{ name: "机器人", count: 2, maxStreak: 2 }]
    });
    expect(themes[0]).toMatchObject({ status: "走强" });

    // 就算那 2 家里有一只 4 板高标，题材整体也只有 2 家，仍不是主升
    const oneLadder = buildThemeStrength({ upThemes: [{ name: "航空航天与军工", count: 2, maxStreak: 4 }] });
    expect(oneLadder[0]).toMatchObject({ status: "走强", tone: "up" });

    // 3 只全首板同样只是「走强」
    const threeFlat = buildThemeStrength({ upThemes: [{ name: "消费", count: 3, maxStreak: 1 }] });
    expect(threeFlat[0]).toMatchObject({ status: "走强" });
  });

  it("requires both a ladder and scale for 主升", () => {
    // 3 板以上且至少 3 家（有高度也要有规模）
    expect(buildThemeStrength({ upThemes: [{ name: "机器人", count: 3, maxStreak: 3 }] })[0])
      .toMatchObject({ status: "主升", tone: "up" });
    // 或 2 板且至少 4 家（有规模）
    expect(buildThemeStrength({ upThemes: [{ name: "算力", count: 4, maxStreak: 2 }] })[0])
      .toMatchObject({ status: "主升", tone: "up" });
    // 2 板但只有 3 家：规模不够，仍是走强
    expect(buildThemeStrength({ upThemes: [{ name: "算力", count: 3, maxStreak: 2 }] })[0])
      .toMatchObject({ status: "走强" });
    // 一只孤零零的首板题材：异动
    expect(buildThemeStrength({ upThemes: [{ name: "杂毛", count: 1, maxStreak: 1 }] })[0])
      .toMatchObject({ status: "异动", tone: "warn" });
  });

  it("flags negative feedback when a hot theme gets a limit-down today", () => {
    const themes = buildThemeStrength(base);
    const byName = new Map(themes.map((theme) => [theme.name, theme]));

    expect(byName.get("机器人").negativeFeedback).toBe(true);
    // 昨日只有 1 家涨停的影视，即使今天 3 家跌停也不算「主线负反馈」
    expect(byName.get("影视").negativeFeedback).toBe(false);
    expect(themes[0].name).toBe("机器人");
  });

  it("does not call pure broken boards negative feedback", () => {
    // 晋级率低的日子几乎每个题材都在断板，若把断板也算负反馈，冰点预警会被刷成噪音
    const themes = buildThemeStrength({
      previousThemes: [{ name: "消费电子", count: 6, maxStreak: 3 }],
      brokenThemes: [{ name: "消费电子", count: 6 }]
    });
    expect(themes[0]).toMatchObject({ status: "退潮", negativeFeedback: false });
  });

  it("marks a hot theme whose limit-ups halved as cooling instead of main-up", () => {
    const themes = buildThemeStrength({
      upThemes: [{ name: "机器人", count: 5, maxStreak: 2 }],
      previousThemes: [{ name: "机器人", count: 17, maxStreak: 5 }]
    });
    expect(themes[0]).toMatchObject({ status: "降温", tone: "warn" });
  });

  it("does not flag a theme that still has more limit-ups than yesterday", () => {
    // 昨天 5 家、今天 6 家 + 1 家跌停：是分歧，不是「突然负反馈」
    const themes = buildThemeStrength({
      upThemes: [{ name: "消费", count: 6, maxStreak: 5 }],
      downThemes: [{ name: "消费", count: 1 }],
      previousThemes: [{ name: "消费", count: 5, maxStreak: 2 }]
    });
    expect(themes[0]).toMatchObject({ status: "分歧", negativeFeedback: false });
  });

  it("treats a 2-board leader from yesterday as a hot theme even with few names", () => {
    const themes = buildThemeStrength({
      downThemes: [{ name: "机器人", count: 1 }],
      previousThemes: [{ name: "机器人", count: 2, maxStreak: 2 }]
    });
    expect(themes[0]).toMatchObject({ status: "走弱", negativeFeedback: true });
  });

  it("drops themes with no action today", () => {
    const themes = buildThemeStrength({ previousThemes: [{ name: "机器人", count: 9, maxStreak: 5 }] });
    expect(themes).toEqual([]);
  });
});

describe("buildHighlights", () => {
  const feedbackTheme = {
    name: "机器人", upCount: 1, downCount: 2, brokenCount: 3,
    previousUpCount: 6, previousMaxStreak: 4, negativeFeedback: true, status: "分歧", tone: "warn"
  };
  const strongTheme = {
    name: "算力与通信", upCount: 4, downCount: 0, brokenCount: 0,
    previousUpCount: 1, previousMaxStreak: 1, negativeFeedback: false, status: "主升", tone: "up", maxUpStreak: 3
  };

  it("warns about an ice point when limit-downs spread and a former main line turns negative", () => {
    const highlights = buildHighlights({
      summary: { limitUpCount: 12, limitDownCount: 8, maxStreak: 4 },
      themeStrength: [feedbackTheme, strongTheme],
      brokenStreaks: { streak: 5, brokenCount: 2, totalCount: 3 }
    });

    // 主线永远排第一，风险/退潮类结论放后面
    expect(highlights[0]).toMatchObject({ tone: "up", title: "主线 · 算力与通信" });
    expect(highlights[1]).toMatchObject({ tone: "warn", title: "冰点预警" });
    expect(highlights.some((item) => item.title.includes("负反馈 · 机器人"))).toBe(true);
    expect(highlights.length).toBeLessThanOrEqual(6);
  });

  it("puts the main line ahead of weakness and fading themes", () => {
    const faded = {
      name: "消费电子", upCount: 0, downCount: 0, brokenCount: 6,
      previousUpCount: 6, previousMaxStreak: 3, negativeFeedback: false, status: "退潮", tone: "down"
    };
    const highlights = buildHighlights({
      summary: { limitUpCount: 26, limitDownCount: 1, maxStreak: 3 },
      themeStrength: [feedbackTheme, faded, strongTheme]
    });
    expect(highlights[0]).toMatchObject({ title: "主线 · 算力与通信" });
    // 负反馈、退潮都排在主线之后
    expect(highlights.findIndex((item) => item.title === "负反馈 · 机器人")).toBeGreaterThan(0);
    expect(highlights.findIndex((item) => item.title === "退潮 · 消费电子")).toBeGreaterThan(0);
  });

  it("does not call it an ice point when limit-ups still outnumber limit-downs", () => {
    const highlights = buildHighlights({
      summary: { limitUpCount: 40, limitDownCount: 6, maxStreak: 6 },
      themeStrength: [strongTheme]
    });
    expect(highlights.some((item) => item.title === "冰点预警")).toBe(false);
  });

  it("picks the main line from 主升 themes, not from a 2-name follower group", () => {
    const follower = {
      name: "杂毛题材", upCount: 2, downCount: 0, brokenCount: 0, previousUpCount: 2,
      previousMaxStreak: 2, negativeFeedback: false, status: "走强", tone: "up", maxUpStreak: 2
    };
    const highlights = buildHighlights({
      summary: { limitUpCount: 12, limitDownCount: 0, maxStreak: 3 },
      themeStrength: [follower, strongTheme]
    });
    expect(highlights.some((item) => item.title === "主线 · 算力与通信")).toBe(true);
    expect(highlights.some((item) => item.title.includes("杂毛题材"))).toBe(false);
  });

  it("surfaces a fading main line even when it has no limit-downs", () => {
    const faded = {
      name: "消费电子", upCount: 0, downCount: 0, brokenCount: 6,
      previousUpCount: 6, previousMaxStreak: 3, negativeFeedback: false, status: "退潮", tone: "down"
    };
    const highlights = buildHighlights({
      summary: { limitUpCount: 26, limitDownCount: 1, maxStreak: 3 },
      themeStrength: [faded, strongTheme]
    });
    expect(highlights.some((item) => item.title === "退潮 · 消费电子")).toBe(true);
  });

  it("falls back to a sentiment summary when there is no signal", () => {
    expect(buildHighlights({ summary: { limitUpCount: 30, limitDownCount: 0 } }))
      .toEqual([{ tone: "up", title: "情绪偏强", detail: "涨停 30 家、跌停 0 家，暂无题材负反馈" }]);
  });

  it("flags a weak relay (晋级率) as money-losing follow-through", () => {
    const highlights = buildHighlights({
      summary: { limitUpCount: 30, limitDownCount: 2, promotionRate: 0.1, yesterdayLimitUpCount: 20 }
    });
    const relay = highlights.find((item) => item.title === "接力亏钱");
    expect(relay).toMatchObject({ tone: "down" });
    expect(relay.detail).toContain("20 家涨停仅 2 家晋级（10%）");
  });

  it("flags a strong relay only when yesterday had enough limit-ups", () => {
    expect(buildHighlights({
      summary: { limitUpCount: 30, promotionRate: 0.5, yesterdayLimitUpCount: 20 }
    }).some((item) => item.title === "接力顺畅")).toBe(true);
    // 昨日只有 4 家涨停，晋级率再高也是样本太小
    expect(buildHighlights({
      summary: { limitUpCount: 30, promotionRate: 0.75, yesterdayLimitUpCount: 4 }
    }).some((item) => item.title === "接力顺畅")).toBe(false);
  });

  it("warns about a gap under the top board and praises a complete ladder", () => {
    const gap = buildHighlights({
      summary: { limitUpCount: 20, maxStreak: 4, ladderDepth: 2 },
      ladder: [{ streak: 4, count: 1 }, { streak: 2, count: 3 }]
    });
    expect(gap.find((item) => item.title === "高度断层")).toMatchObject({ tone: "warn" });

    const solid = buildHighlights({
      summary: { limitUpCount: 20, maxStreak: 4, ladderDepth: 4 },
      ladder: [{ streak: 4, count: 1 }, { streak: 3, count: 3 }, { streak: 2, count: 5 }]
    });
    expect(solid.some((item) => item.title === "高度断层")).toBe(false);
    expect(solid.find((item) => item.title === "空间打开")).toMatchObject({ tone: "up" });
  });

  it("detects a mid-ladder gap even when the tier right under the top board is filled", () => {
    // 5 板 1 家、4 板 3 家、3 板 0 家：最高板下面一层有人，中位部队却已脱节
    const highlights = buildHighlights({
      summary: { limitUpCount: 20, maxStreak: 5, ladderDepth: 2 },
      ladder: [{ streak: 5, count: 1 }, { streak: 4, count: 3 }, { streak: 2, count: 6 }]
    });
    const gap = highlights.find((item) => item.title === "高度断层");
    expect(gap).toMatchObject({ tone: "warn" });
    expect(gap.detail).toContain("3 板断档");
    expect(highlights.some((item) => item.title === "空间打开")).toBe(false);
  });

  it("judges seal quality by the share of limit-ups sealed before 10:00", () => {
    const late = buildHighlights({ summary: { limitUpCount: 20, firstSealCount: 4 } });
    expect(late.find((item) => item.title === "封板偏晚")).toMatchObject({ tone: "warn" });
    const firm = buildHighlights({ summary: { limitUpCount: 20, firstSealCount: 15 } });
    expect(firm.find((item) => item.title === "封板扎实")).toMatchObject({ tone: "up" });
  });

  it("measures theme concentration by the union of the top-3 themes", () => {
    const codes = Array.from({ length: 20 }, (_, index) => `00000${index}`);
    const concept = (name, size, offset) => ({ name, limitCount: size, stocks: codes.slice(offset, offset + size) });
    const focused = buildHighlights({
      summary: { limitUpCount: 20 },
      concepts: [concept("机器人", 8, 0), concept("算力", 7, 8), concept("消费", 1, 15), concept("杂毛", 1, 16)]
    });
    // 前 3 题材：机器人 8 家 + 算力 7 家 + 消费 1 家 = 覆盖 16/20
    expect(focused.find((item) => item.title === "主线清晰")?.detail).toContain("80%");

    const scattered = buildHighlights({
      summary: { limitUpCount: 20 },
      // 4 个题材各 2 家，彼此不重叠：前 3 只覆盖 6/20
      concepts: [concept("A", 2, 0), concept("B", 2, 2), concept("C", 2, 4), concept("D", 2, 6)]
    });
    expect(scattered.find((item) => item.title === "题材发散")).toMatchObject({ tone: "warn" });
  });

  it("ranks structural risks ahead of structural highlights", () => {
    const highlights = buildHighlights({
      summary: { limitUpCount: 20, promotionRate: 0.1, yesterdayLimitUpCount: 20, firstSealCount: 16 }
    });
    const relay = highlights.findIndex((item) => item.title === "接力亏钱");
    const firm = highlights.findIndex((item) => item.title === "封板扎实");
    expect(relay).toBeGreaterThanOrEqual(0);
    expect(firm === -1 || relay < firm).toBe(true);
  });

  it("hides relay and seal-quality verdicts on an intraday snapshot", () => {
    // 盘中只统计「此刻已封板/已晋级」的股票：早封占比必然偏高、晋级率必然偏低，
    // 直接下结论会给出方向相反的信号，因此 14:00 前一律不出这两条。
    const summary = {
      limitUpCount: 34, limitDownCount: 4, promotionRate: 0.03, yesterdayLimitUpCount: 59, firstSealCount: 33
    };
    const intraday = buildHighlights({ summary, quoteTime: "2026-10-27T10:06:00+08:00" });
    expect(intraday.some((item) => item.title === "接力亏钱")).toBe(false);
    expect(intraday.some((item) => item.title === "封板扎实")).toBe(false);

    const closing = buildHighlights({ summary, quoteTime: "2026-10-27T15:00:00+08:00" });
    expect(closing.some((item) => item.title === "接力亏钱")).toBe(true);
    expect(closing.some((item) => item.title === "封板扎实")).toBe(true);
  });
});

describe("mergeThemeBoard", () => {
  const concept = (name, limitCount, extra = {}) => ({
    name, limitCount, maxStreak: 1, firstSealTime: "09:35:00", whitelist: false,
    streakDistribution: { 1: limitCount }, stocks: ["1"], hasLeader: false, ...extra
  });

  it("attaches strength state, limit-down and broken counts to concept rows", () => {
    const board = mergeThemeBoard({
      concepts: [concept("机器人", 6, { hasLeader: true, maxStreak: 3 })],
      themeStrength: [{
        name: "机器人", upCount: 6, downCount: 2, brokenCount: 3,
        previousUpCount: 8, status: "分歧", tone: "warn", negativeFeedback: true
      }]
    });
    expect(board[0]).toMatchObject({
      name: "机器人", limitCount: 6, downCount: 2, brokenCount: 3,
      status: "分歧", tone: "warn", negativeFeedback: true, downOnly: false
    });
  });

  it("adds themes that only have limit-downs so weakness stays visible", () => {
    const board = mergeThemeBoard({
      concepts: [concept("机器人", 6, { hasLeader: true })],
      themeStrength: [
        { name: "机器人", upCount: 6, downCount: 0, status: "主升", tone: "up", negativeFeedback: false },
        { name: "影视", upCount: 0, downCount: 3, status: "冰点", tone: "down", negativeFeedback: false }
      ]
    });
    const film = board.find((row) => row.name === "影视");
    expect(film).toMatchObject({ limitCount: 0, downCount: 3, downOnly: true, status: "冰点" });
    // 有涨停的题材排在有梯队的题材前面，跌停-only 的沉底但不消失
    expect(board.map((row) => row.name)).toEqual(["机器人", "影视"]);
  });

  it("drops noise themes: a single limit-up is never a theme", () => {
    const board = mergeThemeBoard({
      concepts: [concept("一只涨停", 1), concept("两只涨停", 2)],
      themeStrength: [
        { name: "一只涨停", upCount: 1, downCount: 1, brokenCount: 4, status: "分歧", tone: "warn", negativeFeedback: true },
        { name: "两只涨停", upCount: 2, downCount: 0, status: "走强", tone: "up", negativeFeedback: false },
        // 只有 1 家跌停：同样是噪音
        { name: "影视", upCount: 0, downCount: 1, status: "走弱", tone: "down", negativeFeedback: false }
      ]
    });
    expect(board.map((row) => row.name)).toEqual(["两只涨停"]);
  });

  it("keeps fading themes with heavy broken boards after the strength card is gone", () => {
    const board = mergeThemeBoard({
      concepts: [concept("算力", 6, { hasLeader: true })],
      themeStrength: [
        { name: "算力", upCount: 6, downCount: 0, status: "主升", tone: "up", negativeFeedback: false },
        // 昨日主线今天一只涨停都没有：全靠断板体现退潮
        { name: "消费电子", upCount: 0, downCount: 0, brokenCount: 5, previousUpCount: 6, status: "退潮", tone: "down", negativeFeedback: false },
        // 只断了 1 家，噪音，不占版面
        { name: "玻璃", upCount: 0, downCount: 0, brokenCount: 1, previousUpCount: 1, status: "退潮", tone: "down", negativeFeedback: false }
      ]
    });
    const faded = board.find((row) => row.name === "消费电子");
    expect(faded).toMatchObject({ limitCount: 0, downCount: 0, brokenCount: 5, downOnly: true, status: "退潮", tone: "down" });
    expect(board.some((row) => row.name === "玻璃")).toBe(false);
    expect(board.map((row) => row.name)).toEqual(["算力", "消费电子"]);
  });

  it("puts negative-feedback themes first", () => {
    const board = mergeThemeBoard({
      concepts: [concept("算力", 8, { hasLeader: true }), concept("消费", 3)],
      themeStrength: [
        { name: "算力", upCount: 8, downCount: 0, status: "主升", tone: "up", negativeFeedback: false },
        { name: "消费", upCount: 1, downCount: 2, previousUpCount: 5, status: "分歧", tone: "warn", negativeFeedback: true }
      ]
    });
    expect(board[0].name).toBe("消费");
  });
});

describe("summarizePremium（昨日涨停股今日溢价）", () => {
  const codes = ["a", "b", "c", "d", "e", "f"];
  // a/b 是首板，c/d/e/f 是连板
  const streakOf = (code) => (["c", "d", "e", "f"].includes(code) ? 2 : 1);

  it("splits first-board and ladder groups and keeps the median", () => {
    const values = new Map([["a", 4], ["b", 2], ["c", 6], ["d", 8], ["e", 10], ["f", 12]]);
    const premium = summarizePremium({ values, codes, streakOf });
    expect(premium).toMatchObject({
      sampleSize: 6,
      median: 7,
      upRatio: 1,
      first: { count: 2, median: 3 },
      ladder: { count: 4, median: 9 }
    });
  });

  it("ignores codes that were not in yesterday's limit-up list", () => {
    const values = new Map([["a", 3], ["zzz", 99], ["c", -1]]);
    const premium = summarizePremium({ values, codes, streakOf });
    expect(premium.sampleSize).toBe(2);
    expect(premium.median).toBe(1);
    expect(premium.upRatio).toBe(0.5);
  });

  it("returns nulls instead of zero when nothing came back", () => {
    expect(summarizePremium({ values: new Map(), codes, streakOf }))
      .toMatchObject({ sampleSize: 0, median: null, upRatio: null, first: { count: 0, median: null } });
  });
});

describe("buildHighlights · 赚钱效应与竞价强度", () => {
  const premium = (extra = {}) => ({
    sampleSize: 20, median: 1, upRatio: 0.5,
    first: { count: 10, median: 1 }, ladder: { count: 10, median: 1 }, auction: null, ...extra
  });

  it("warns when yesterday's limit-ups lose money today", () => {
    const highlights = buildHighlights({
      summary: { limitUpCount: 20 },
      premium: premium({ median: -3.4, upRatio: 0.2 })
    });
    const item = highlights.find((entry) => entry.title === "赚钱效应差");
    expect(item).toMatchObject({ tone: "down" });
    expect(item.detail).toContain("中位数 -3.4%");
    expect(item.detail).toContain("上涨占比 20%");
  });

  it("stays silent in the neutral band so it does not spam every day", () => {
    const highlights = buildHighlights({ summary: { limitUpCount: 20 }, premium: premium({ median: 1.2 }) });
    expect(highlights.some((entry) => entry.title.startsWith("赚钱效应"))).toBe(false);
  });

  it("needs a big first-board / ladder gap before blaming the height", () => {
    const split = buildHighlights({
      summary: { limitUpCount: 20 },
      premium: premium({ median: 2, first: { count: 12, median: 4 }, ladder: { count: 8, median: -1 } })
    });
    expect(split.find((entry) => entry.title === "高度不被认可")).toMatchObject({ tone: "warn" });

    const mild = buildHighlights({
      summary: { limitUpCount: 20 },
      premium: premium({ median: 2, first: { count: 12, median: 2 }, ladder: { count: 8, median: 1 } })
    });
    expect(mild.some((entry) => entry.title === "高度不被认可")).toBe(false);
  });

  it("degrades quietly when the premium fetch is missing", () => {
    const highlights = buildHighlights({ summary: { limitUpCount: 20 }, premium: null });
    expect(highlights.some((entry) => entry.title.startsWith("赚钱效应"))).toBe(false);
  });

  it("calls the auction strong on one-character boards, weak when yesterday's names gap down", () => {
    const strong = buildHighlights({
      summary: { limitUpCount: 20, auctionSealCount: 4 },
      premium: premium({ auction: { sampleSize: 20, median: 2.5 } })
    });
    const item = strong.find((entry) => entry.title === "竞价强势");
    expect(item).toMatchObject({ tone: "up" });
    expect(item.detail).toContain("4 家一字板（占涨停 20%）");
    expect(item.detail).toContain("开盘中位数 +2.5%");

    const weak = buildHighlights({
      summary: { limitUpCount: 20, auctionSealCount: 0 },
      premium: premium({ auction: { sampleSize: 20, median: -2.2 } })
    });
    expect(weak.find((entry) => entry.title === "竞价走弱")).toMatchObject({ tone: "down" });
  });

  it("flags a board with no one-character seal only when there are enough limit-ups", () => {
    expect(buildHighlights({ summary: { limitUpCount: 20, auctionSealCount: 0 } })
      .some((entry) => entry.title === "无一字板")).toBe(true);
    // 涨停太少时「没有一字板」不构成信号
    expect(buildHighlights({ summary: { limitUpCount: 6, auctionSealCount: 0 } })
      .some((entry) => entry.title === "无一字板")).toBe(false);
  });

  it("ranks the main line first and the money-making read before negative feedback", () => {
    const strongTheme = {
      name: "算力与通信", upCount: 4, downCount: 0, brokenCount: 0, previousUpCount: 1,
      previousMaxStreak: 1, negativeFeedback: false, status: "主升", tone: "up", maxUpStreak: 3
    };
    const feedbackTheme = {
      name: "机器人", upCount: 1, downCount: 2, brokenCount: 3, previousUpCount: 6,
      previousMaxStreak: 4, negativeFeedback: true, status: "分歧", tone: "warn"
    };
    const highlights = buildHighlights({
      summary: { limitUpCount: 20, limitDownCount: 2 },
      themeStrength: [feedbackTheme, strongTheme],
      premium: premium({ median: -3 })
    });
    expect(highlights[0].title).toBe("主线 · 算力与通信");
    expect(highlights.findIndex((entry) => entry.title === "赚钱效应差"))
      .toBeLessThan(highlights.findIndex((entry) => entry.title.startsWith("负反馈")));
  });
});

describe("板高文案", () => {
  it("never writes 1板: a one-board height is always 首板", () => {
    // 断板层与当日高度都是 1 板（全场只有首板）时的文案
    const highlights = buildHighlights({
      summary: { limitUpCount: 9, maxStreak: 1 },
      brokenStreaks: { streak: 1, brokenCount: 2, totalCount: 4 }
    });
    const texts = highlights.map((item) => `${item.title} ${item.detail}`).join(" ");
    expect(texts).not.toContain("1板");
    expect(texts).toContain("首板");
    expect(highlights.find((item) => item.title === "高位断板").detail)
      .toBe("昨日 首板 2/4 家未晋级，高度止步于 首板");
  });
});
