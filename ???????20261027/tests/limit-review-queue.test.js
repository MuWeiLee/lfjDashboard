// @vitest-environment node
// 资讯复核队列：断板 → 连板 → 首板。顺序错位会让断板概念拿不到、首板先耗尽额度。
import {
  aggregateConcepts, applyNewsConcepts, buildNewsReviewQueue, pickPrimaryConcept,
  pruneUnsupportedBrandConcepts, quoteDayOf, selectStockNews, snapshotDayMismatch
} from "../api/_lib/short-emotion/limit-engine.js";
import { detectThemeFamilies } from "../api/_lib/short-emotion/engine.js";

const stock = (code, streak, sealTime) => ({ code, name: `股${code}`, streak, sealTime });

describe("limit-up news review queue", () => {
  it("puts broken boards first, then streak desc, then earlier seal time, first boards last", () => {
    const stocks = [
      stock("000001.SZ", 1, "09:35:00"),
      stock("000002.SZ", 3, "10:00:00"),
      stock("000003.SZ", 2, "09:31:00"),
      stock("000004.SZ", 2, "09:30:00"),
      stock("000005.SZ", null, "09:40:00")
    ];
    const nameByCode = new Map([["600001.SH", "断板甲"], ["600002.SH", "断板乙"]]);

    const queue = buildNewsReviewQueue(stocks, ["600001.SH", "600002.SH"], nameByCode);

    expect(queue.map((item) => item.code)).toEqual([
      "600001.SH", "600002.SH",
      "000002.SZ", "000004.SZ", "000003.SZ", "000001.SZ", "000005.SZ"
    ]);
    // 断板股必须带 broken 标记，否则结果会写进天梯个股而不是断板带
    expect(queue.filter((item) => item.broken).map((item) => item.code)).toEqual(["600001.SH", "600002.SH"]);
    expect(queue.filter((item) => !item.broken).every((item) => item.stock)).toBe(true);
  });

  it("skips broken codes without a name and does not mutate the stock list", () => {
    const stocks = [stock("000001.SZ", 1, "09:35:00"), stock("000002.SZ", 2, "09:30:00")];
    const snapshot = stocks.map((item) => item.code);

    const queue = buildNewsReviewQueue(stocks, ["600009.SH"], new Map());

    expect(queue.map((item) => item.code)).toEqual(["000002.SZ", "000001.SZ"]);
    expect(stocks.map((item) => item.code)).toEqual(snapshot);
  });
});

describe("news concepts override Wind concepts", () => {
  it("replaces Wind concepts with the families found in news", () => {
    const item = { code: "300024.SZ", concepts: ["机器人", "减速器", "专精特新小巨人"], newsVerified: false };

    expect(applyNewsConcepts(item, ["机器人", "算力与通信"])).toBe(true);
    expect(item.concepts).toEqual(["机器人", "算力与通信"]);
    expect(item.conceptSource).toBe("news");
    expect(item.newsVerified).toBe(true);
  });

  it("dedupes repeated family names from news", () => {
    const item = { code: "300024.SZ", concepts: [] };

    applyNewsConcepts(item, ["机器人", "机器人"]);

    expect(item.concepts).toEqual(["机器人"]);
  });

  it("keeps Wind concepts when news finds no theme, and marks the stock as reviewed", () => {
    const item = { code: "600001.SH", concepts: ["种业"] };

    expect(applyNewsConcepts(item, [])).toBe(false);
    expect(item.concepts).toEqual(["种业"]);
    expect(item.conceptSource).toBe("wind");
    expect(item.newsVerified).toBe(true);
  });

  it("leaves the concept list empty when neither source has a theme", () => {
    const item = { code: "600002.SH", concepts: [] };

    expect(applyNewsConcepts(item, [])).toBe(false);
    expect(item.concepts).toEqual([]);
    expect(item.conceptSource).toBe("none");
  });
});

describe("news theme detection", () => {
  it("ignores media boilerplate that happens to contain 证券", () => {
    const text = "证券之星消息，青岛食品10月26日涨停收盘；证券代码：001219，证券简称：青岛食品";

    expect(detectThemeFamilies(text)).not.toContain("金融科技与券商");
  });

  it("still detects the real family in a 证券之星 recap title", () => {
    const text = "证券之星消息，某股涨停：人形机器人概念热股";

    expect(detectThemeFamilies(text)).toEqual(["机器人"]);
  });
});

describe("concept aggregation", () => {
  it("merges the family label with Wind aliases into one row", () => {
    const groups = aggregateConcepts([
      { code: "000001.SZ", concepts: ["汽车智能化"], streak: 2, sealTime: "09:31:00" },
      { code: "000002.SZ", concepts: ["华为汽车", "车联网"], streak: 1, sealTime: "09:40:00" }
    ]);

    expect(groups).toHaveLength(1);
    expect(groups[0].name).toBe("汽车智能化");
    expect(groups[0].limitCount).toBe(2);
    expect(groups[0].whitelist).toBe(true);
    expect(groups[0].aliases).toEqual(["汽车智能化", "华为汽车", "车联网"]);
  });
});

describe("stock-specific news selection", () => {
  it("drops generic market pieces and articles that never mention the stock", () => {
    const items = [
      { title: "每日大事件｜马斯克为点赞加入转账功能", content: "通过其支付服务X Money发放" },
      { title: "延华智能涨停：智慧城市概念热股", content: "延华智能10月26日涨停" },
      { title: "某公司发布新产品", content: "与这只股票无关" }
    ];

    const relevant = selectStockNews(items, "延华智能");

    expect(relevant).toHaveLength(1);
    expect(relevant[0].title).toContain("延华智能");
  });
});

describe("main-business validation of brand concepts", () => {
  it("drops 家电 when the business is set-top boxes and broadband gear", () => {
    const result = pruneUnsupportedBrandConcepts(
      ["家电", "F5G", "AI应用"],
      "数字机顶盒、宽带网络连接设备、VR/AR虚拟现实"
    );

    expect(result.dropped).toEqual(["家电"]);
    expect(result.concepts).toEqual(["F5G", "AI应用"]);
  });

  it("keeps 家电 when the business really is home appliances", () => {
    const result = pruneUnsupportedBrandConcepts(["家电"], "冰箱、空调、洗衣机等家用电器研发与销售");

    expect(result.dropped).toEqual([]);
    expect(result.concepts).toEqual(["家电"]);
  });

  it("keeps the tag when the business text is missing", () => {
    const result = pruneUnsupportedBrandConcepts(["家电"], "");

    expect(result.dropped).toEqual([]);
    expect(result.concepts).toEqual(["家电"]);
  });

  it("picks a business-supported primary concept after pruning", () => {
    const counts = new Map([["F5G", 6], ["AI应用", 4], ["家电", 6]]);
    const { concepts } = pruneUnsupportedBrandConcepts(["家电", "F5G", "AI应用"], "机顶盒、宽带CPE");

    expect(pickPrimaryConcept(concepts, counts)).toBe("F5G");
  });

  it("prefers the concept the main business actually matches", () => {
    const counts = new Map([["F5G", 6], ["消费电子产业", 1]]);

    expect(pickPrimaryConcept(["F5G", "消费电子产业"], counts, "消费电子、智能终端研发与销售")).toBe("消费电子产业");
    expect(pickPrimaryConcept(["F5G", "消费电子产业"], counts)).toBe("F5G");
  });
});

describe("trading-day guard", () => {
  it("extracts the quote date from the Wind timestamp", () => {
    expect(quoteDayOf("2026-10-26T15:31:00+08:00")).toBe("20261026");
    expect(quoteDayOf(null)).toBeNull();
  });

  it("flags quotes that are still the previous close", () => {
    // 盘前跑 10-27：行情还停在 10-26 收盘
    expect(snapshotDayMismatch("2026-10-26T15:31:00+08:00", "20261027")).toBe(true);
    expect(snapshotDayMismatch("2026-10-26T15:31:00+08:00", "20261026")).toBe(false);
    expect(snapshotDayMismatch(null, "20261026")).toBe(false);
  });
});
