// 全球联动（中美 / 中韩）——按「讨论热度 + 产业链实质关联」组织
//
// 数据来源（页面会展示）：
//   收盘价：Wind analytics_data.get_financial_data「近61个交易日每日收盘价」宽表
//   讨论热度：Wind analytics_data.get_financial_data「<代码>新闻热度历史走势」
//             （Wind 新闻热度，0–100 的日频指标，直接取用，不做二次建模）
//
// 排序口径：
//   热度 = A股标的近 HEAT_WINDOW(30) 个交易日「新闻热度」的算术平均。
//   28 组配对都带 A股腿，排序口径统一；海外侧热度只作对照（韩股有、美股无）。
//   热度缺失的配对排在最后并标注，不删除、不补零。
//
// 相关性的角色：
//   方向同步率 / 周收益 Pearson 只作为参考字段展示，
//   不参与筛选、不影响排序，页面上明确标注「实测联动，仅供参考，不构成筛选条件」。
//
// 产业关系：
//   每组一句，依据公开主营事实撰写（上游供给 / 下游客户 / 同一需求驱动 / 直接竞争）。
import { callWindTool } from "./wind-client.js";

export const GLOBAL_LINKAGE_KEY = "global-linkage:latest";
export const LINK_WINDOW = 60; // 相关性参考窗口（交易日）
export const HEAT_WINDOW = 30; // 热度统计窗口（交易日）
const REQUEST_DAYS = LINK_WINDOW + 1; // 多取 1 个点算首日涨跌幅
// Wind 宽表返回有行数上限：实测 4 代码 × 21 日 = 84 行能完整返回，
// 7 代码 × 21 日 = 147 行会被截断（只剩 14 个交易日）。
// 因此按「行数上限 ÷ 请求天数」反推每批代码数：21 日窗口为 4 个/批，60 日窗口退化为逐只取数。
const ROW_LIMIT = 84;
const BATCH_SIZE = Math.max(1, Math.floor(ROW_LIMIT / REQUEST_DAYS));
// 热度接口按 QPS 限流，串行取数并在两次之间留间隔（测试环境不等待）。
const HEAT_DELAY_MS = Number(process.env.SHORT_EMOTION_HEAT_DELAY_MS ?? (process.env.NODE_ENV === "test" ? 0 : 350));

// 美股收盘晚于 A股：用 T-1 的海外涨跌幅对应 A股 T。
export const LAG = { US: 1, KR: 0 };

export const GLOBAL_GROUPS = [
  {
    market: "US",
    label: "中美联动",
    note: `A股个股 vs 美股个股，按近 ${HEAT_WINDOW} 个交易日新闻热度排序；美股无该指标，热度只统计 A股一侧。`
  },
  {
    market: "KR",
    label: "中韩联动",
    note: `A股个股 vs 韩股个股，按近 ${HEAT_WINDOW} 个交易日新闻热度排序；两侧热度均来自 Wind。`
  }
];

export const LINK_BASIS = `排序依据：近${HEAT_WINDOW}个交易日 Wind 新闻热度均值（0–100 日频指标，取每日热度算术平均）；相关性（方向同步率、周收益 Pearson）仅作参考，不参与筛选与排序`;

// 只放「真的对得上」的个股配对：同一条产业链的同类公司，不用指数、不用组合替代。
export const GLOBAL_PAIR_THEMES = [
  // ── 中美 ──────────────────────────────────────────────
  {
    market: "US", theme: "半导体",
    pairs: [
      { id: "us-semi-tsm", cn: { code: "688981.SH", name: "中芯国际" }, peer: { code: "TSM.N", name: "台积电" } },
      { id: "us-semi-amd", cn: { code: "688981.SH", name: "中芯国际" }, peer: { code: "AMD.O", name: "超威半导体" } },
      { id: "us-semi-mu", cn: { code: "603986.SH", name: "兆易创新" }, peer: { code: "MU.O", name: "美光科技" } },
      { id: "us-semi-amat", cn: { code: "002371.SZ", name: "北方华创" }, peer: { code: "AMAT.O", name: "应用材料" } }
    ]
  },
  {
    market: "US", theme: "AI算力",
    pairs: [
      { id: "us-ai-avgo", cn: { code: "300308.SZ", name: "中际旭创" }, peer: { code: "AVGO.O", name: "博通" } },
      { id: "us-ai-dell", cn: { code: "000977.SZ", name: "浪潮信息" }, peer: { code: "DELL.N", name: "戴尔科技" } }
    ]
  },
  {
    market: "US", theme: "消费电子",
    pairs: [
      { id: "us-ce-luxshare", cn: { code: "002475.SZ", name: "立讯精密" }, peer: { code: "AAPL.O", name: "苹果" } },
      { id: "us-ce-goer", cn: { code: "002241.SZ", name: "歌尔股份" }, peer: { code: "AAPL.O", name: "苹果" } }
    ]
  },
  {
    market: "US", theme: "新能源车",
    pairs: [
      { id: "us-ev-catl", cn: { code: "300750.SZ", name: "宁德时代" }, peer: { code: "TSLA.O", name: "特斯拉" } },
      { id: "us-ev-byd", cn: { code: "002594.SZ", name: "比亚迪" }, peer: { code: "TSLA.O", name: "特斯拉" } }
    ]
  },
  {
    market: "US", theme: "光伏",
    pairs: [
      { id: "us-solar-longi", cn: { code: "601012.SH", name: "隆基绿能" }, peer: { code: "FSLR.O", name: "第一太阳能" } },
      { id: "us-solar-jinko", cn: { code: "688223.SH", name: "晶科能源" }, peer: { code: "FSLR.O", name: "第一太阳能" } }
    ]
  },
  {
    market: "US", theme: "创新药",
    pairs: [
      { id: "us-bio-hengrui", cn: { code: "600276.SH", name: "恒瑞医药" }, peer: { code: "LLY.N", name: "礼来" } },
      { id: "us-bio-junshi", cn: { code: "688180.SH", name: "君实生物" }, peer: { code: "MRNA.O", name: "莫德纳" } }
    ]
  },
  {
    market: "US", theme: "游戏传媒",
    pairs: [
      { id: "us-media-ntes", cn: { code: "002624.SZ", name: "完美世界" }, peer: { code: "NTES.O", name: "网易" } },
      { id: "us-media-nflx", cn: { code: "300413.SZ", name: "芒果超媒" }, peer: { code: "NFLX.O", name: "奈飞" } }
    ]
  },
  {
    market: "US", theme: "军工",
    pairs: [
      { id: "us-def-lmt", cn: { code: "600760.SH", name: "中航沈飞" }, peer: { code: "LMT.N", name: "洛克希德马丁" } },
      { id: "us-def-rtx", cn: { code: "000768.SZ", name: "中航西飞" }, peer: { code: "RTX.N", name: "雷神技术" } }
    ]
  },

  // ── 中韩 ──────────────────────────────────────────────
  {
    market: "KR", theme: "半导体",
    pairs: [
      { id: "kr-semi-samsung", cn: { code: "688981.SH", name: "中芯国际" }, peer: { code: "005930.KS", name: "三星电子" } },
      { id: "kr-semi-hynix", cn: { code: "603986.SH", name: "兆易创新" }, peer: { code: "000660.KS", name: "SK海力士" } }
    ]
  },
  {
    market: "KR", theme: "消费电子",
    pairs: [
      { id: "kr-ce-luxshare", cn: { code: "002475.SZ", name: "立讯精密" }, peer: { code: "005930.KS", name: "三星电子" } },
      { id: "kr-ce-goer", cn: { code: "002241.SZ", name: "歌尔股份" }, peer: { code: "005930.KS", name: "三星电子" } }
    ]
  },
  {
    market: "KR", theme: "新能源车",
    pairs: [
      { id: "kr-ev-catl", cn: { code: "300750.SZ", name: "宁德时代" }, peer: { code: "373220.KS", name: "LG新能源" } },
      { id: "kr-ev-hyundai", cn: { code: "002594.SZ", name: "比亚迪" }, peer: { code: "005380.KS", name: "现代汽车" } }
    ]
  },
  {
    market: "KR", theme: "游戏传媒",
    pairs: [
      { id: "kr-media-ncsoft", cn: { code: "002624.SZ", name: "完美世界" }, peer: { code: "036570.KS", name: "NCSOFT" } },
      { id: "kr-media-naver", cn: { code: "300413.SZ", name: "芒果超媒" }, peer: { code: "035420.KS", name: "NAVER" } }
    ]
  },
  {
    market: "KR", theme: "创新药",
    pairs: [
      { id: "kr-bio-samsungbio", cn: { code: "600276.SH", name: "恒瑞医药" }, peer: { code: "207940.KS", name: "三星生物制剂" } },
      { id: "kr-bio-celltrion", cn: { code: "688180.SH", name: "君实生物" }, peer: { code: "068270.KS", name: "赛尔群" } }
    ]
  }
];

// 产业链关系：一句话说清两侧的实质关系（依据公开主营事实）。
export const PAIR_RELATIONS = {
  "us-semi-tsm": "同属晶圆代工，先进制程上直接竞争：台积电是制程与产能标杆，中芯国际承接国产替代订单",
  "us-semi-amd": "超威半导体是 Fabless 设计公司、中芯国际是代工厂，同受 AI 芯片与先进制程需求驱动",
  "us-semi-mu": "同做存储芯片：美光是国际存储龙头，兆易创新做 NOR/利基 DRAM，直接竞争且共享存储价格周期",
  "us-semi-amat": "同做半导体设备：应用材料是全球龙头，北方华创做国产替代，属直接竞争",
  "us-ai-avgo": "博通供应交换芯片与光 DSP，中际旭创做光模块，属上游芯片供给与下游模块的同一条 AI 算力链",
  "us-ai-dell": "同做服务器整机，直接竞争，同受 AI 服务器资本开支驱动",
  "us-ce-luxshare": "立讯精密是苹果核心组装与零部件供应商，属下游客户关系（苹果为其第一大客户）",
  "us-ce-goer": "歌尔股份为苹果提供声学器件与整机代工，属下游客户关系",
  "us-ev-catl": "宁德时代是特斯拉动力电池供应商，属下游客户关系，并同受电动车需求驱动",
  "us-ev-byd": "同为整车厂，在电动车市场直接竞争，同受终端需求与价格战驱动",
  "us-solar-longi": "同属光伏组件/电池片制造商，直接竞争，共享装机需求与硅料价格周期",
  "us-solar-jinko": "同属光伏组件制造商，直接竞争，美国市场是双方共同战场",
  "us-bio-hengrui": "同做创新药：礼来在 GLP-1 等赛道领先，恒瑞以国内为主，部分靶点直接竞争",
  "us-bio-junshi": "同做抗体/mRNA 类创新药，莫德纳是 mRNA 龙头，技术路线与融资环境同源，部分适应症竞争",
  "us-media-ntes": "同做游戏研发与运营，直接竞争，同受版号节奏与流水周期驱动",
  "us-media-nflx": "同为长视频平台（会员+广告变现），商业模式对标但市场不重叠，属同一流媒体需求驱动",
  "us-def-lmt": "同为战斗机整机厂，中美主力机型直接对标竞争，同受国防预算驱动",
  "us-def-rtx": "中航西飞做运输机/轰炸机整机，雷神做导弹与航电，同属军工链但环节不同，共享国防开支驱动",
  "kr-semi-samsung": "三星电子既是晶圆代工竞争者又是存储龙头，与中芯国际在成熟制程直接竞争",
  "kr-semi-hynix": "SK海力士是 DRAM/NAND 龙头，兆易创新做利基存储，直接竞争且共享存储价格周期",
  "kr-ce-luxshare": "立讯精密为三星等安卓阵营提供连接器与组装，属供应链客户关系，同时三星是终端竞争者",
  "kr-ce-goer": "歌尔股份为三星等提供声学器件与整机代工，属供应链客户关系",
  "kr-ev-catl": "同做动力电池，直接竞争，争夺全球装机份额",
  "kr-ev-hyundai": "同为整车厂，在电动车与出口市场直接竞争",
  "kr-media-ncsoft": "同做 MMORPG 等游戏研发，端游/手游品类重叠，直接竞争",
  "kr-media-naver": "NAVER 是韩国门户与内容平台，芒果超媒是长视频平台，同属内容+广告变现，模式对标、非直接竞争",
  "kr-bio-samsungbio": "三星生物制剂做 CDMO 代工生产，恒瑞医药是创新药研发方，属上下游订单关系",
  "kr-bio-celltrion": "赛尔群做生物类似药与抗体药，君实生物做创新药，同属生物药赛道，部分适应症直接竞争"
};

// ── 解析 ──────────────────────────────────────────────

const RE = { code: /Wind代码|^代码$/, name: /证券简称|^名称$/, price: /每日收盘价|收盘价/, date: /收盘价时间|日期|交易时间/ };

function unwrap(outer) {
  const text = outer?.content?.find?.((item) => item.type === "text")?.text;
  if (!text) return outer;
  try { return JSON.parse(text); } catch { return { data: text }; }
}

function tables(payload) {
  const value = payload?.data?.data ?? payload?.data;
  if (Array.isArray(value)) return value.filter((item) => item?.columns && Array.isArray(item.rows));
  return value?.columns && Array.isArray(value.rows) ? [value] : [];
}

function pick(names, includes, excludes = []) {
  return names.find((name) => includes.some((pattern) => pattern.test(name)) && !excludes.some((pattern) => pattern.test(name)));
}

function dateKey(value) {
  const digits = String(value || "").replace(/\D/g, "");
  return digits.length >= 8 ? digits.slice(0, 8) : null;
}

const round = (value, digits = 2) => Math.round(value * 10 ** digits) / 10 ** digits;

/** Wind 宽表 → Map<code, { name, points: [{ date, price }] }>（只保留价格 > 0 的真实交易日）。 */
export function parseCloseSeries(...payloads) {
  const output = new Map();
  for (const payload of payloads) {
    for (const table of tables(payload)) {
      const names = table.columns.map((item) => item.name);
      const codeKey = pick(names, [RE.code]);
      const nameKey = pick(names, [RE.name]);
      const priceKey = pick(names, [RE.price], [/时间/]);
      const dateKeyName = pick(names, [RE.date]);
      if (!codeKey || !priceKey || !dateKeyName) continue;
      const index = (key) => names.indexOf(key);
      for (const row of table.rows) {
        const code = String(row[index(codeKey)] || "").trim();
        const date = dateKey(row[index(dateKeyName)]);
        const price = Number(row[index(priceKey)]);
        if (!code || !date || !Number.isFinite(price) || price <= 0) continue;
        const entry = output.get(code) || { code, name: nameKey ? String(row[index(nameKey)] || "").trim() : "", points: [] };
        if (!entry.points.some((point) => point.date === date)) entry.points.push({ date, price });
        output.set(code, entry);
      }
    }
  }
  for (const entry of output.values()) entry.points.sort((a, b) => a.date.localeCompare(b.date));
  return output;
}

/** Wind 新闻热度宽表 → Map<code, { name, points: [{ date, heat }] }>（0–100 的日频值）。 */
export function parseHeatSeries(...payloads) {
  const output = new Map();
  for (const payload of payloads) {
    for (const table of tables(payload)) {
      const names = table.columns.map((item) => item.name);
      const codeKey = pick(names, [RE.code]);
      const nameKey = pick(names, [RE.name]);
      const heatKey = pick(names, [/历史每日热度|每日热度|^热度$/], [/时间/]);
      const heatDateKey = pick(names, [/历史每日热度时间|时间|日期/], [/^$/]);
      if (!codeKey || !heatKey || !heatDateKey) continue;
      const index = (key) => names.indexOf(key);
      for (const row of table.rows) {
        const code = String(row[index(codeKey)] || "").trim();
        const date = dateKey(row[index(heatDateKey)]);
        const raw = row[index(heatKey)];
        const heat = raw === null || raw === undefined || raw === "" ? NaN : Number(raw);
        if (!code || !date || !Number.isFinite(heat)) continue;
        const entry = output.get(code) || { code, name: nameKey ? String(row[index(nameKey)] || "").trim() : "", points: [] };
        if (!entry.points.some((point) => point.date === date)) entry.points.push({ date, heat });
        output.set(code, entry);
      }
    }
  }
  for (const entry of output.values()) entry.points.sort((a, b) => a.date.localeCompare(b.date));
  return output;
}

/** 热度汇总：最近 window 个有效交易点的算术平均；没有数据时全部返回 null，绝不补零。 */
export function heatSummary(points, window = HEAT_WINDOW) {
  const valid = (points || []).filter((point) => Number.isFinite(point.heat));
  const slice = valid.slice(-window);
  if (!slice.length) {
    return { average: null, latest: null, latestDate: null, samples: 0, startDate: null, endDate: null };
  }
  const average = slice.reduce((sum, point) => sum + point.heat, 0) / slice.length;
  return {
    average: round(average, 2),
    latest: round(slice[slice.length - 1].heat, 2),
    latestDate: slice[slice.length - 1].date,
    samples: slice.length,
    startDate: slice[0].date,
    endDate: slice[slice.length - 1].date
  };
}

/** 日涨跌幅序列（%），按日期对齐后计算。 */
export function dailyReturns(points) {
  const map = new Map();
  for (let index = 1; index < points.length; index += 1) {
    const prev = points[index - 1].price;
    if (!prev) continue;
    map.set(points[index].date, (points[index].price / prev - 1) * 100);
  }
  return map;
}

/** 区间涨跌幅（%）：用最近 window 个有效点。 */
export function periodChange(points, window = LINK_WINDOW) {
  const slice = points.slice(-(window + 1));
  if (slice.length < 2) return null;
  const first = slice[0].price;
  const last = slice[slice.length - 1].price;
  if (!first) return null;
  return round((last / first - 1) * 100, 2);
}

/** Pearson 相关系数（自动按交易日对齐，并把海外序列整体后移 lag 个交易日）。 */
export function pearson(aligned) {
  const pairs = aligned.filter(([, a, b]) => Number.isFinite(a) && Number.isFinite(b));
  if (pairs.length < 5) return { value: null, samples: pairs.length };
  const n = pairs.length;
  const meanA = pairs.reduce((sum, [, a]) => sum + a, 0) / n;
  const meanB = pairs.reduce((sum, [, , b]) => sum + b, 0) / n;
  let cov = 0;
  let varA = 0;
  let varB = 0;
  for (const [, a, b] of pairs) {
    cov += (a - meanA) * (b - meanB);
    varA += (a - meanA) ** 2;
    varB += (b - meanB) ** 2;
  }
  if (!varA || !varB) return { value: null, samples: n };
  return { value: round(cov / Math.sqrt(varA * varB), 2), samples: n };
}

/**
 * 对齐两组日涨跌幅：
 *   以 A股日期为锚，lag=1（美股）取「日期严格早于锚日」的最近一个海外交易日，
 *   lag=0（韩股）取「日期不晚于锚日」的最近一个海外交易日。
 * 这样即使两地节假日不同（A股国庆休市而美股照常），也不会产生空对空的对齐。
 */
export function alignReturns(cnReturns, peerReturns, lag = 0, window = LINK_WINDOW) {
  const cnDates = [...cnReturns.keys()].sort().slice(-window);
  const peerDates = [...peerReturns.keys()].sort();
  const output = [];
  for (const date of cnDates) {
    let target = null;
    for (let index = peerDates.length - 1; index >= 0; index -= 1) {
      const candidate = peerDates[index];
      if (lag === 0 ? candidate <= date : candidate < date) { target = candidate; break; }
    }
    output.push([date, cnReturns.get(date), target ? peerReturns.get(target) : null]);
  }
  return output;
}

/**
 * 方向同步率：对齐样本里「同涨」+「同跌」天数占总天数的比例。
 * 一方上涨一方下跌记不同步；任一方平盘（0%）既不算同涨也不算同跌，但计入总天数。
 * 这里只作为参考字段，不设门槛。
 */
export function directionStats(aligned) {
  const pairs = aligned.filter(([, a, b]) => Number.isFinite(a) && Number.isFinite(b));
  const total = pairs.length;
  if (!total) return { syncRate: null, upRate: null, downRate: null, samples: 0 };
  const up = pairs.filter(([, a, b]) => a > 0 && b > 0).length;
  const down = pairs.filter(([, a, b]) => a < 0 && b < 0).length;
  return {
    syncRate: round((up + down) / total, 4),
    upRate: round(up / total, 4),
    downRate: round(down / total, 4),
    samples: total
  };
}

/** 自然周的周一（YYYYMMDD）作为分组键。 */
function weekKey(date) {
  const year = Number(date.slice(0, 4));
  const month = Number(date.slice(4, 6));
  const day = Number(date.slice(6, 8));
  const stamp = Date.UTC(year, month - 1, day);
  const monday = stamp - ((new Date(stamp).getUTCDay() + 6) % 7) * 86400000;
  const value = new Date(monday);
  return `${value.getUTCFullYear()}${String(value.getUTCMonth() + 1).padStart(2, "0")}${String(value.getUTCDate()).padStart(2, "0")}`;
}

/**
 * 个股日 / 周涨跌幅（%），直接用已有收盘价序列，不额外取数。
 *   日 = 最近一个交易日较前一交易日
 *   周 = 本周首个交易日至最新收盘（基准为上一交易日收盘），本周只有一天时等于日涨跌幅
 * 数据不足时返回 null，页面显示占位，绝不补零。
 */
export function stockPerformance(points) {
  const valid = (points || []).filter((point) => Number.isFinite(point.price) && point.price > 0);
  const last = valid.length ? valid[valid.length - 1] : null;
  if (!last) return { day: null, dayDate: null, prevDate: null, week: null, weekStart: null, weekBaseDate: null };
  const previous = valid.length > 1 ? valid[valid.length - 2] : null;
  const key = weekKey(last.date);
  const firstOfWeek = valid.find((point) => weekKey(point.date) === key) || null;
  const weekBase = firstOfWeek && valid.indexOf(firstOfWeek) > 0 ? valid[valid.indexOf(firstOfWeek) - 1] : null;
  return {
    day: previous ? round((last.price / previous.price - 1) * 100, 2) : null,
    dayDate: last.date,
    prevDate: previous?.date || null,
    week: weekBase ? round((last.price / weekBase.price - 1) * 100, 2) : null,
    weekStart: firstOfWeek?.date || null,
    weekBaseDate: weekBase?.date || null
  };
}

/** 把对齐后的日涨跌幅按自然周复利聚合成周收益（%），返回 [周一日期, A股周收益, 海外周收益]。 */
export function weeklyReturns(aligned) {
  const weeks = new Map();
  for (const [date, a, b] of aligned) {
    if (!Number.isFinite(a) || !Number.isFinite(b)) continue;
    const key = weekKey(String(date));
    const entry = weeks.get(key) || { cn: 1, peer: 1 };
    entry.cn *= 1 + a / 100;
    entry.peer *= 1 + b / 100;
    weeks.set(key, entry);
  }
  return [...weeks.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) => [key, round((entry.cn - 1) * 100, 4), round((entry.peer - 1) * 100, 4)]);
}

/** 热度降序：有值的在前，缺失的在后；同值按 id 保证顺序稳定。 */
const byHeat = (left, right) => {
  const a = left.heat?.average;
  const b = right.heat?.average;
  if (a == null && b == null) return left.id.localeCompare(right.id);
  if (a == null) return 1;
  if (b == null) return -1;
  return b - a || left.id.localeCompare(right.id);
};

/**
 * 组装快照：groups[].themes[].pairs[]，28 组全部保留。
 * 相关性不参与筛选，热度只影响排序；取数缺失的字段留空并记入 stats。
 */
export function buildGlobalLinkage(payloads, { now = new Date(), priceMissingCodes = [], heatPayloads = [], heatMissingCodes = [] } = {}) {
  const prices = parseCloseSeries(...payloads);
  const heat = parseHeatSeries(...heatPayloads);
  const priceMissing = new Set(priceMissingCodes);
  const heatMissing = new Set(heatMissingCodes);
  const perfMissing = new Set();
  let defined = 0;

  const groups = GLOBAL_GROUPS.map((group) => {
    const themes = [];
    for (const theme of GLOBAL_PAIR_THEMES.filter((item) => item.market === group.market)) {
      const pairs = theme.pairs.map((pair) => {
        defined += 1;
        const cnEntry = prices.get(pair.cn.code);
        const peerEntry = prices.get(pair.peer.code);
        const cnPerf = stockPerformance(cnEntry?.points);
        const peerPerf = stockPerformance(peerEntry?.points);
        const aligned = cnEntry && peerEntry
          ? alignReturns(dailyReturns(cnEntry.points), dailyReturns(peerEntry.points), LAG[group.market])
          : [];
        const direction = directionStats(aligned);
        const weekly = pearson(weeklyReturns(aligned));
        if (!cnEntry) priceMissing.add(pair.cn.code);
        if (!peerEntry) priceMissing.add(pair.peer.code);
        if (cnPerf.day == null || cnPerf.week == null) perfMissing.add(pair.cn.code);
        if (peerPerf.day == null || peerPerf.week == null) perfMissing.add(pair.peer.code);
        return {
          id: pair.id,
          cn: { code: pair.cn.code, name: cnEntry?.name || pair.cn.name, changePct: cnEntry ? periodChange(cnEntry.points) : null, perf: cnPerf },
          peer: { code: pair.peer.code, name: peerEntry?.name || pair.peer.name, changePct: peerEntry ? periodChange(peerEntry.points) : null, perf: peerPerf },
          relation: PAIR_RELATIONS[pair.id] || "",
          heat: heatSummary(heat.get(pair.cn.code)?.points || []),
          peerHeat: heatSummary(heat.get(pair.peer.code)?.points || []),
          direction,
          weekly: { correlation: weekly.value, samples: weekly.samples },
          lag: LAG[group.market]
        };
      });
      pairs.sort(byHeat);
      themes.push({ theme: theme.theme, pairs });
    }
    themes.sort((left, right) => {
      const a = left.pairs[0]?.heat?.average;
      const b = right.pairs[0]?.heat?.average;
      if (a == null && b == null) return left.theme.localeCompare(right.theme);
      if (a == null) return 1;
      if (b == null) return -1;
      return b - a;
    });
    return { market: group.market, label: group.label, note: group.note, checked: pairCount(group.market), themes };
  });

  // 全局热度排名：跨中美/中韩一起排，缺失热度不占名次，同热度并列同名次。
  const flat = groups.flatMap((group) => group.themes.flatMap((theme) => theme.pairs));
  flat.sort(byHeat);
  let rank = 0;
  let lastHeat = null;
  let lastRank = 0;
  for (const pair of flat) {
    const value = pair.heat.average;
    if (value == null) { pair.heat.rank = null; continue; }
    if (lastHeat != null && Math.abs(value - lastHeat) < 1e-9) {
      pair.heat.rank = lastRank;
      continue;
    }
    rank += 1;
    pair.heat.rank = rank;
    lastHeat = value;
    lastRank = rank;
  }

  const ranges = flat.flatMap((pair) => [pair.heat, pair.peerHeat]).filter((item) => item.samples);
  const start = ranges.map((item) => item.startDate).filter(Boolean).sort()[0] || null;
  const end = ranges.map((item) => item.endDate).filter(Boolean).sort().at(-1) || null;
  // 请求过但 Wind 没有返回数据的代码，也要算进 missing，避免 22/25 却写 missing:none。
  const requestedHeat = heatCodes();
  const noData = requestedHeat.filter((code) => !heat.has(code));
  const missingHeat = [...new Set([...noData, ...heatMissing])];

  return {
    asOf: now.toISOString(),
    tradingDate: [...prices.values()].flatMap((entry) => entry.points.map((point) => point.date)).sort().at(-1) || null,
    window: LINK_WINDOW,
    heat: {
      metric: "Wind 新闻热度（0–100）",
      source: "Wind analytics_data.get_financial_data「新闻热度历史走势」",
      window: HEAT_WINDOW,
      aggregation: `近${HEAT_WINDOW}个交易日每日热度算术平均`,
      ranking: "按 A股标的新闻热度均值降序；美股无该指标，中美配对只统计 A股一侧",
      range: { start, end },
      coverage: { requested: requestedHeat.length, available: [...heat.keys()].length, missing: missingHeat },
      reference: "方向同步率 / 周收益相关性仅作参考，不构成筛选条件"
    },
    basis: LINK_BASIS,
    filter: LINK_FILTER,
    source: "Wind analytics_data.get_financial_data（日频收盘价 + 新闻热度）",
    groups,
    stats: { defined, shown: flat.length, priceMissing: [...priceMissing], perfMissing: [...perfMissing], heatMissing: missingHeat },
    missing: [...new Set([...priceMissing, ...perfMissing, ...missingHeat])].slice(0, 40)
  };
}

/** 某市场在配置里定义的配对数。 */
function pairCount(market) {
  return GLOBAL_PAIR_THEMES.filter((item) => item.market === market).reduce((sum, item) => sum + item.pairs.length, 0);
}

/** A股一侧的代码（每组配对都带 A股腿，热度排序就靠它）。 */
const cnCodes = () => [...new Set(GLOBAL_PAIR_THEMES.flatMap((theme) => theme.pairs.map((pair) => pair.cn.code)))];
/** 韩股一侧的代码（美股无新闻热度，不浪费请求）。 */
const krCodes = () => [...new Set(GLOBAL_PAIR_THEMES.filter((item) => item.market === "KR").flatMap((item) => item.pairs.map((pair) => pair.peer.code)))];

const questionOf = (codes) => `${codes.join(",")}近${REQUEST_DAYS}个交易日每日收盘价`;
const heatQuestionOf = (code) => `${code}新闻热度历史走势`;
const priceCodes = () => [...new Set(GLOBAL_PAIR_THEMES.flatMap((theme) => theme.pairs.flatMap((pair) => [pair.cn.code, pair.peer.code])))];
const heatCodes = () => [...new Set([...cnCodes(), ...krCodes()])];

// 展示口径里写清楚总组数，避免手写数字和配置不一致。
export const LINK_FILTER = `不按相关性筛选，${GLOBAL_PAIR_THEMES.reduce((sum, item) => sum + item.pairs.length, 0)} 组配对全部展示；按热度均值降序排列，热度缺失的排在最后并标注；相关性仅用于标注「实测联动，仅供参考，不构成筛选条件」`;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** 刷新快照：分批取收盘价 + 串行取热度；失败只记 missing，绝不写入编造数据。 */
export async function refreshGlobalLinkage(store, { now = new Date() } = {}) {
  const payloads = [];
  const priceMissingCodes = [];
  const codes = priceCodes();
  for (let index = 0; index < codes.length; index += BATCH_SIZE) {
    const batch = codes.slice(index, index + BATCH_SIZE);
    try {
      payloads.push(unwrap(await callWindTool("analytics_data", "get_financial_data", { question: questionOf(batch) }, { timeoutMs: 60_000 })));
    } catch (error) {
      priceMissingCodes.push(...batch);
    }
  }

  const heatPayloads = [];
  const heatMissingCodes = [];
  for (const code of heatCodes()) {
    try {
      heatPayloads.push(unwrap(await callWindTool("analytics_data", "get_financial_data", { question: heatQuestionOf(code) }, { timeoutMs: 60_000 })));
    } catch (error) {
      heatMissingCodes.push(code);
    }
    await sleep(HEAT_DELAY_MS);
  }

  const next = buildGlobalLinkage(payloads, { now, priceMissingCodes, heatPayloads, heatMissingCodes });
  const ready = next.groups.some((group) => group.themes.some((theme) => theme.pairs.some((pair) => Number.isFinite(pair.cn.changePct) || pair.heat.average != null)));
  if (!ready) return { skipped: true, reason: "Wind 未返回收盘价与热度，保留上一份快照", missing: next.missing };
  const cached = (await store.kvGet(GLOBAL_LINKAGE_KEY).catch(() => null))?.value;
  if (cached?.tradingDate && next.tradingDate && next.tradingDate < cached.tradingDate) {
    return { skipped: true, reason: "Wind 返回的日期早于缓存，保留上一份快照" };
  }
  await store.kvSet(GLOBAL_LINKAGE_KEY, next);
  return { value: next };
}

const EMPTY = {
  pending: true,
  asOf: null,
  tradingDate: null,
  window: LINK_WINDOW,
  heat: {
    metric: "Wind 新闻热度（0–100）",
    source: "Wind analytics_data.get_financial_data「新闻热度历史走势」",
    window: HEAT_WINDOW,
    aggregation: `近${HEAT_WINDOW}个交易日每日热度算术平均`,
    ranking: "按 A股标的新闻热度均值降序；美股无该指标，中美配对只统计 A股一侧",
    range: { start: null, end: null },
    coverage: { requested: 0, available: 0, missing: [] },
    reference: "方向同步率 / 周收益相关性仅作参考，不构成筛选条件"
  },
  basis: LINK_BASIS,
  filter: LINK_FILTER,
  source: "Wind analytics_data.get_financial_data（日频收盘价 + 新闻热度）",
  groups: [],
  stats: { defined: 0, shown: 0, priceMissing: [], perfMissing: [], heatMissing: [] },
  missing: []
};

export async function readGlobalLinkage(store) {
  const entry = await store.kvGet(GLOBAL_LINKAGE_KEY).catch(() => null);
  if (!entry?.value) return { ...EMPTY };
  return { ...entry.value, pending: false, storedAt: entry.updatedAt || null };
}
