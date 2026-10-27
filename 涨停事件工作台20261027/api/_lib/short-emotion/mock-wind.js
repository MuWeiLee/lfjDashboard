// Offline fixtures for local development and tests (WIND_MOCK=1).
// Shapes mirror real Wind MCP results closely enough to exercise the whole engine;
// the numbers are synthetic and must never be shown as market data.

const TZ = "Asia/Shanghai";

function beijingNow() {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23"
  }).formatToParts(new Date()).map((part) => [part.type, part.value]));
  return { day: `${parts.year}${parts.month}${parts.day}`, time: `${parts.hour}:${parts.minute}:${parts.second}` };
}

function quoteTime() {
  const now = beijingNow();
  return `${now.day} ${now.time}`;
}

function table(columns, rows) {
  return { columns: columns.map((name) => ({ name })), rows };
}

function result(inner) {
  return { content: [{ type: "text", text: JSON.stringify(inner) }] };
}

const LIMIT_UP = [
  ["300024.SZ", "机器人A", "机器人;人形机器人;减速器"],
  ["002527.SZ", "新时达", "机器人;人形机器人;工业母机"],
  ["603728.SH", "鸣志电器", "机器人;人形机器人;丝杠"],
  ["300124.SZ", "汇川样本", "机器人;工业自动化"],
  ["688256.SH", "寒武样本", "AI算力;芯片;数据中心"],
  ["603019.SH", "中科样本", "AI算力;服务器;数据中心"],
  ["300308.SZ", "光模样本", "CPO;光模块;AI算力"],
  ["600598.SH", "北大荒样本", "农业;种业;粮食"]
];

const CONCEPTS = [
  ["8841416.WI", "人形机器人指数", 3.1, 101.8, 98.6],
  ["8841234.WI", "CPO概念指数", 2.4, 87.2, 85.4],
  ["8841102.WI", "AI算力指数", 1.9, 66.1, 64.9],
  ["8841301.WI", "种业指数", 1.6, 41.3, 40.6],
  ["8841555.WI", "商业航天指数", 0.8, 55.2, 54.8]
];

const TW_LIMIT = [["6223.TWO", "旺硅"], ["6515.TW", "颖崴"], ["2603.TW", "长荣海运"], ["3008.TW", "大立光"]];

// 历史日涨停名单：所有历史口径必须走同一份，否则「昨日涨停溢价」会被引擎的
// 口径护栏（返回值必须绝大多数命中昨日涨停名单）拒收，本地页面就看不到该结论。
const historicalLimitUp = (day) => LIMIT_UP.slice(0, String(day).endsWith("1") ? 2 : 4);

function mockTaiwan(serverType, toolName, params, now, qt) {
  const question = String(params.question || params.query || "");
  if (toolName === "get_index_price_indicators") {
    const codes = String(params.windcode).split(",");
    return result({ data: table(["最新成交价", "涨跌幅", "成交额", "近3分钟涨跌幅", "交易时间", "Wind代码"],
      codes.map((code, index) => [1000 + index * 37, code === "TWII.TW" ? 0.42 : 2.6 - index * 0.3, 8.4e11 / (index + 1), index < 3 ? 0.5 - index * 0.1 : 0.02, qt, code])) });
  }
  if (toolName === "get_index_kline") {
    const rows = [];
    for (let offset = 14; offset >= 0; offset -= 1) {
      const date = new Date(Date.UTC(Number(now.day.slice(0, 4)), Number(now.day.slice(4, 6)) - 1, Number(now.day.slice(6, 8)) - offset));
      if ([0, 6].includes(date.getUTCDay())) continue;
      rows.push([`${date.toISOString().slice(0, 10)}T00:00:00.000+08:00`, "49000", "49100", "49200", "48900", "800000000000"]);
    }
    return result({ data: table(["TIME", "OPEN", "MATCH", "HIGH", "LOW", "TURNOVER"], rows) });
  }
  if (toolName === "get_index_technicals") {
    return result({ data: { data: [table(["Wind代码", "最新指数成份上涨数量", "最新指数成份下跌数量", "最新指数成份平盘数量"], [["TWII.TW", 620, 380, 90]])] } });
  }
  if (toolName === "search_global_stocks") {
    const day = (question.match(/(\d{8})涨跌幅/) || [])[1] || now.day;
    const pick = /大于等于9\.5%/.test(question) ? TW_LIMIT : /小于等于-9\.5%/.test(question) ? TW_LIMIT.slice(0, 1) : /大于5%/.test(question) ? TW_LIMIT.concat(TW_LIMIT) : /小于-5%/.test(question) ? TW_LIMIT.slice(0, 2) : TW_LIMIT;
    const total = /大于0/.test(question) ? 640 : /小于0/.test(question) ? 410 : /等于0/.test(question) ? 85 : pick.length;
    const rows = pick.map(([code, name]) => [code, name, /小于/.test(question) ? -9.8 : 9.9, `${day} 10:00:00`, Number(day)]);
    return result({ data: { data: [{ ...table(["Wind代码", "证券简称", "最新涨跌幅", "交易时间", "日期"], rows), excelTotalCount: Math.max(total, rows.length) }] } });
  }
  if (toolName === "get_financial_data") {
    if (/成分股今日涨跌幅排名前十/.test(question)) {
      return result({ data: { data: [table(["Wind代码", "证券简称", "最新涨跌幅", "交易时间", "日期"],
        [["6223.TWO", "旺硅", 9.96], ["6515.TW", "颖崴", 9.7], ["6510.TWO", "精测", 6.2], ["3661.TW", "世芯-KY", 2.1], ["2330.TW", "台积电", 0.4]].map((row) => [...row, qt, now.day]))] } });
    }
    if (/的最新涨跌幅$/.test(question)) {
      const codes = question.replace(/的最新涨跌幅$/, "").split("、");
      return result({ data: { data: [table(["Wind代码", "证券简称", "最新涨跌幅"], codes.map((code, index) => [code, `样本${index + 1}`, 4.5 - index]))] } });
    }
    return result({ data: { data: [] } });
  }
  if (toolName === "get_financial_news") {
    return result({ data: { items: [
      { title: "台股探针族群走强", content: "探针族群旺矽(6223)、颖崴(6515)、精测(6510)同步上涨，半导体先进制程需求带动。航运股集体上涨。", date: `${now.day.slice(0, 4)}-${now.day.slice(4, 6)}-${now.day.slice(6, 8)}`, source: "Wind样例", relevance: 0.8 }
    ] } });
  }
  return result({ data: [] });
}

export function mockWindResult(serverType, toolName, params) {
  const now = beijingNow();
  const qt = quoteTime();
  const question = String(params.question || params.query || "");
  if (/\.TWO?\b|台湾|台股/.test(JSON.stringify(params))) return mockTaiwan(serverType, toolName, params, now, qt);

  if (serverType === "index_data" && toolName === "get_index_price_indicators") {
    return result({ data: [table(
      ["Wind代码", "最新成交价", "涨跌幅", "成交额", "上涨家数", "下跌家数", "平盘家数", "交易时间"],
      [["881001.WI", 6123.45, 0.86, 1_235_000_000_000, 3312, 1876, 142, qt]]
    )] });
  }
  if (serverType === "index_data" && toolName === "get_index_kline") {
    const rows = [];
    for (let offset = 14; offset >= 1; offset -= 1) {
      const date = new Date(Date.UTC(Number(now.day.slice(0, 4)), Number(now.day.slice(4, 6)) - 1, Number(now.day.slice(6, 8)) - offset));
      if ([0, 6].includes(date.getUTCDay())) continue;
      rows.push([date.toISOString().slice(0, 10).replaceAll("-", ""), 6000 + offset]);
    }
    return result({ data: [table(["TIME", "收盘价"], rows)] });
  }
  if (serverType === "index_data" && toolName === "get_index_technicals") {
    const [hh, mm] = qt.slice(9, 14).split(":").map(Number);
    const prevMinute = hh * 60 + mm - 5;
    const prev = `${now.day} ${String(Math.floor(prevMinute / 60)).padStart(2, "0")}:${String(prevMinute % 60).padStart(2, "0")}:00`;
    return result({ data: [table(
      ["Wind代码", "证券简称", "最新价格", "最新价格.交易时间", "5分前价格", "5分前价格.交易时间"],
      CONCEPTS.map(([code, name, , price, before]) => [code, name, price, `${qt.slice(0, 14)}:00`, before, prev])
    )] });
  }
  if (serverType === "stock_data" && toolName === "search_stocks") {
    if (/跌停/.test(question)) {
      return result({ data: [table(["Wind代码", "证券简称", "涨跌停状态", "交易时间"], [["600001.SH", "样本跌停", "跌停", qt]])] });
    }
    const historical = question.match(/筛选(\d{8})收盘价/);
    const rows = historical
      ? historicalLimitUp(historical[1]).map(([code, name]) => [code, name])
      : LIMIT_UP.map(([code, name], index) => [code, name, "涨停", qt, `${now.day} 10:${String(10 + index).padStart(2, "0")}:00`]);
    return result({ data: [table(historical ? ["Wind代码", "证券简称"] : ["Wind代码", "证券简称", "涨跌停状态", "交易时间", "涨停时间"], rows)] });
  }
  if (serverType === "analytics_data" && toolName === "get_financial_data") {
    if (/涨幅大于5%/.test(question)) return result({ data: [table(["统计口径", "涨幅大于5%股票家数"], [["沪深A股", 128]])] });
    if (/跌幅大于5%/.test(question)) return result({ data: [table(["统计口径", "跌幅大于5%股票家数"], [["沪深A股", 21]])] });
    // 昨日涨停溢价：名单必须与「昨日涨停名单」一致，否则真实引擎的口径护栏会拒收（这是刻意设计）
    const premium = question.match(/^(\d{8})涨停股票在(\d{8})的最新涨跌幅排名$/);
    if (premium) {
      const rows = historicalLimitUp(premium[1]).map(([code, name], index) => [code, name, Number((6.8 - index * 3.1).toFixed(2))]);
      return result({ data: [table(["Wind代码", "证券简称", "最新涨跌幅"], rows)] });
    }
    // 竞价溢价：用「开盘涨幅」列名，验证解析与分流
    const auction = question.match(/^(\d{8})涨停股票在(\d{8})的开盘涨幅$/);
    if (auction) {
      const rows = historicalLimitUp(auction[1]).map(([code, name], index) => [code, name, Number((3.4 - index * 2.2).toFixed(2))]);
      return result({ data: [table(["Wind代码", "证券简称", "开盘涨幅"], rows)] });
    }
    if (/概念指数涨跌幅排名前十/.test(question)) {
      return result({ data: [table(["Wind代码", "证券简称", "涨跌幅", "交易时间"], CONCEPTS.map(([code, name, change]) => [code, name, change, qt]))] });
    }
    // 资金流向：今日流入/流出榜、5/20 日榜、单概念每日序列
    if (/主力净流出额/.test(question) && /今日/.test(question)) {
      return result({ data: [table(["Wind代码", "证券简称", "主力净流入额", "成交额", "交易时间"], [
        ["8841301.WI", "种业指数", 8.6, 120.4, qt],
        ["8841555.WI", "商业航天指数", 5.2, 88.1, qt],
        ["8841900.WI", "银行指数", 3.4, 210.6, qt]
      ])] });
    }
    if (/主力净流入额/.test(question) && /今日/.test(question)) {
      return result({ data: [table(["Wind代码", "证券简称", "主力净流入额", "成交额", "交易时间"], [
        ["8841416.WI", "人形机器人指数", 26.9, 180.2, qt],
        ["8841234.WI", "CPO概念指数", 18.4, 96.7, qt],
        ["8841102.WI", "AI算力指数", 12.7, 143.5, qt],
        ["8841666.WI", "液冷服务器指数", 7.9, 64.3, qt],
        ["8841777.WI", "稳定币指数", 4.1, 52.8, qt]
      ])] });
    }
    if (/近\d+日主力净流出额/.test(question)) {
      return result({ data: [table(["Wind代码", "证券简称", "主力净流出额合计", "成交额合计"], [
        ["8841301.WI", "种业指数", 18.2, 640.3],
        ["8841555.WI", "商业航天指数", 9.4, 302.8],
        ["8841900.WI", "银行指数", 6.1, 880.2]
      ])] });
    }
    if (/近\d+日主力净流入额合计/.test(question)) {
      const days = Number((question.match(/近(\d+)日/) || [])[1] || 5);
      const factor = days >= 20 ? 4.2 : 2.1;
      return result({ data: [table(["Wind代码", "证券简称", "主力净流入额合计", "成交额合计", "主力净流入占比(%)"], CONCEPTS.map(([code, name, change], index) => [code, name, Number((change * 12 * factor).toFixed(2)), Number((change * 96 * factor).toFixed(1)), Number((change * 0.7).toFixed(2))]).concat([["8841301.WI", "种业指数", -18.2 * factor, 640.3 * factor, -2.8]]))] });
    }
    if (/每日主力净流入额/.test(question)) {
      const days = Number((question.match(/近(\d+)个交易日/) || [])[1] || 5);
      const name = question.replace(/近\d+个交易日.*$/, "");
      const seed = [...name].reduce((sum, char) => sum + char.charCodeAt(0), 0) % 9;
      const rows = [];
      for (let offset = days - 1; offset >= 0; offset -= 1) {
        const date = new Date(Date.UTC(Number(now.day.slice(0, 4)), Number(now.day.slice(4, 6)) - 1, Number(now.day.slice(6, 8)) - offset));
        if ([0, 6].includes(date.getUTCDay())) continue;
        const day = date.toISOString().slice(0, 10).replaceAll("-", "");
        const amount = Number(((seed % 5) - 2 + (offset % 3) * 1.2).toFixed(2));
        rows.push([day, amount * 3, 300 + seed]);
      }
      return result({ data: [table(["日期", "主力净流入额", "成交额"], rows)] });
    }
    const conceptOf = question.match(/^(\d{6}\.(?:SZ|SH))所属概念板块$/);
    if (conceptOf) {
      const stock = LIMIT_UP.find(([code]) => code === conceptOf[1]);
      return result({ data: [table(["Wind代码", "所属概念板块"], [[conceptOf[1], stock?.[2] || "其他"]])] });
    }
    if (/概念成分股最新涨跌幅排名前十/.test(question)) {
      const seed = question.length;
      return result({ data: [table(
        ["Wind代码", "证券简称", "最新成交价", "今日开盘价", "今日最高价", "今日最低价", "涨跌幅", "成交额", "换手率", "量比", "交易时间"],
        [0, 1, 2, 3, 4].map((index) => [`30${seed % 10}${index}1${index}.SZ`, `成分样本${index + 1}`, 12.3 + index, 11.8, 12.6 + index, 11.6, 7.2 - index * 1.3, 8e8 - index * 1e8, 6.1 - index, 1.6, qt])
      )] });
    }
    return result({ data: [] });
  }
  if (serverType === "financial_docs" && toolName === "get_financial_news") {
    return result({ data: { items: [
      { title: "工信部发布人形机器人产业支持政策", content: "政策明确支持人形机器人核心部件量产，减速器与丝杠订单有望增长。", date: `${now.day.slice(0, 4)}-${now.day.slice(4, 6)}-${now.day.slice(6, 8)}`, source: "Wind样例", relevance: 0.91 },
      { title: "光模块龙头订单饱满", content: "数据中心建设提速，CPO与光模块需求旺盛，订单增长。", date: `${now.day.slice(0, 4)}-${now.day.slice(4, 6)}-${now.day.slice(6, 8)}`, source: "Wind样例", relevance: 0.84 }
    ] } });
  }
  return result({ data: [] });
}
