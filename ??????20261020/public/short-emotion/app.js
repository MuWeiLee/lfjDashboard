import { HANT, HANT_FIXES } from "./hant-map.js?v=3";

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
let data = null;
let anomalyData = null;
let anomalyFilter = "all";
let timelineMode = /^\/tw(?:-short-emotion)?(?:\/|$)/.test(location.pathname) ? "daily" : "intraday";
let toastTimer = null;

// ── 市场：/cn（A股）与 /tw（台股）共用这一页（旧地址 /cn-short-emotion、/tw-short-emotion 会跳转过来）──
const MARKET = /^\/tw(?:-short-emotion)?(?:\/|$)/.test(location.pathname) ? "tw" : "cn";
const MARKETS = {
  cn: {
    label: "A股",
    pulseTitle: "A股短线情绪",
    indexLabel: "全A涨跌幅",
    indexPrefix: "全A",
    indexCode: "881001.WI",
    amountLabel: "两市成交额",
    amountNote: "Wind 全A口径",
    themeTitle: "题材热度排名",
    themePill: "A股 Wind 概念",
    themesTab: "题材雷达",
    breadthTitle: "市场广度",
    breadthUnit: "家数",
    anomalyTitle: "当日题材异动",
    anomalyDesc: "相似分支先归并为父题材，再按涨停、批量拉升与消息催化筛选高价值方向。",
    emptyThemes: "Wind 暂未返回A股概念排名。",
    // 盘中曲线：09:25–11:30、13:00–15:00（午休压缩掉）
    sessions: [[565, 690], [780, 900]],
    slotsWide: [[565, "09:25"], [600, "10:00"], [690, "11:30"], [810, "13:30"], [870, "14:30"], [900, "15:00"]],
    slotsNarrow: [[565, "09:25"], [630, "10:30"], [690, "11:30"], [840, "14:00"], [900, "15:00"]]
  },
  tw: {
    label: "台股",
    pulseTitle: "台股短线情绪",
    indexLabel: "加权指数涨跌幅",
    indexPrefix: "加权",
    indexCode: "TWII.TW",
    amountLabel: "上市成交额",
    amountNote: "新台币 · 加权指数口径",
    themeTitle: "产业热度排名",
    themePill: "证交所产业指数",
    themesTab: "产业雷达",
    // Wind 条件选股最多返回 100 只，数不出全市场涨跌家数，台股广度改用 27 个证交所产业指数
    breadthTitle: "产业广度",
    breadthUnit: "产业",
    anomalyTitle: "当日产业异动",
    anomalyDesc: "以证交所产业指数为题材，并纳入新闻点名的族群；按涨停（涨幅≥9.5%）与消息催化筛选。",
    emptyThemes: "Wind 暂未返回台股产业排名。",
    // 台股连续交易 09:00–13:30
    sessions: [[540, 815]],
    slotsWide: [[540, "09:00"], [600, "10:00"], [660, "11:00"], [720, "12:00"], [780, "13:00"], [810, "13:30"]],
    slotsNarrow: [[540, "09:00"], [630, "10:30"], [720, "12:00"], [810, "13:30"]]
  }
};
const CFG = MARKETS[MARKET];

// 台股页面显示繁体：页面文字与动态内容统一按字表转换（数据本身在定时任务里已转成繁体）。
function toHant(text) {
  let output = String(text).replace(/[\u4e00-\u9fff]/g, (char) => HANT[char] || char);
  for (const [pattern, replacement] of HANT_FIXES) output = output.replace(pattern, replacement);
  return output;
}

function hantify(root) {
  if (MARKET !== "tw" || !root) return;
  if (root.nodeType === Node.TEXT_NODE) {
    const next = toHant(root.nodeValue);
    if (next !== root.nodeValue) root.nodeValue = next;
    return;
  }
  if (root.nodeType !== Node.ELEMENT_NODE) return;
  for (const attribute of ["title", "aria-label"]) {
    const value = root.getAttribute(attribute);
    if (value && toHant(value) !== value) root.setAttribute(attribute, toHant(value));
  }
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (node.nodeType === Node.TEXT_NODE) {
      const next = toHant(node.nodeValue);
      if (next !== node.nodeValue) node.nodeValue = next;
    } else {
      for (const attribute of ["title", "aria-label"]) {
        const value = node.getAttribute(attribute);
        if (value && toHant(value) !== value) node.setAttribute(attribute, toHant(value));
      }
    }
  }
}

if (MARKET === "tw") {
  new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      if (mutation.type === "characterData") hantify(mutation.target);
      else if (mutation.type === "attributes") hantify(mutation.target);
      else mutation.addedNodes.forEach((node) => hantify(node));
    }
  }).observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ["title", "aria-label"] });
}

function applyMarketCopy() {
  setText("#pulse-title", CFG.pulseTitle);
  setText("#index-label", CFG.indexLabel);
  setText("#index-level", CFG.indexCode);
  setText("#amount-label", CFG.amountLabel);
  setText("#amount-note", CFG.amountNote);
  setText("#theme-title", CFG.themeTitle);
  setText("#theme-pill", CFG.themePill);
  setText("#themes-tab", CFG.themesTab);
  setText("#breadth-title", CFG.breadthTitle);
  setText("#breadth-tab", CFG.breadthTitle);
  setText("#anomaly-title", CFG.anomalyTitle);
  setText("#anomaly-desc", CFG.anomalyDesc);
  // 台股只有收盘数据：去掉「盘中」路径，只保留每日曲线
  if (MARKET === "tw") {
    $(".segmented")?.remove();
  }
  hantify(document.body);
}

const isEmbedded = new URLSearchParams(window.location.search).get("embed") === "1";
if (isEmbedded) {
  document.body.classList.add("embed");
  document.documentElement.classList.add("embed-root");
}

function reportEmbedHeight() {
  if (!isEmbedded || window.parent === window) return;
  const height = Math.max(document.body.scrollHeight, document.documentElement.scrollHeight);
  window.parent.postMessage({ type: "emotion-workbench-height", height }, "*");
}

if (isEmbedded && "ResizeObserver" in window) {
  new ResizeObserver(reportEmbedHeight).observe(document.body);
  window.addEventListener("load", reportEmbedHeight);
}

const dimensionNames = { breadth: "市场广度", limits: "极端反馈", ladder: "连板梯队", profit: "赚钱效应", themes: "题材聚焦", liquidity: "成交环境" };
const statusNames = { direct: "直接可取", derived: "本地派生", limited: "能力受限", error: "取数异常" };

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>'"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" }[char]));
}

function formatNumber(value) {
  return Number.isFinite(Number(value)) ? Number(value).toLocaleString("zh-CN") : "—";
}

function formatPct(value, digits = 2) {
  if (value == null) return "\u2014";
  if (!Number.isFinite(Number(value))) return "—";
  const number = Number(value);
  return `${number > 0 ? "+" : ""}${number.toFixed(digits)}%`;
}

function compactAmount(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return "—";
  if (Math.abs(number) >= 1e12) return `${(number / 1e12).toFixed(2)}万亿`;
  if (Math.abs(number) >= 1e8) return `${(number / 1e8).toFixed(0)}亿`;
  return number.toLocaleString("zh-CN");
}

function signClass(value) {
  return Number(value) > 0 ? "up-text" : Number(value) < 0 ? "down-text" : "";
}

// 所有数据来自定时任务写入的快照（交易日 09:00–15:00 每 30 分钟），页面不直接调用 Wind。
const API_BASE = "/api/short-emotion";

// fresh=true：刚完成一次刷新，跳过 CDN 与服务端缓存，直接读数据分支最新提交。
let readFresh = false;
async function api(resource, { fresh = readFresh } = {}) {
  const extra = fresh ? `&fresh=1&t=${Date.now()}` : "";
  const response = await fetch(`${API_BASE}?market=${MARKET}&resource=${encodeURIComponent(resource)}${extra}`, { headers: { Accept: "application/json" }, cache: fresh ? "no-store" : "default" });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw Object.assign(new Error(payload.error || `请求失败 (${response.status})`), { code: payload.code });
  return payload;
}

function shanghaiTimeLabel(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(date);
}

function toast(message, error = false) {
  const element = $("#toast");
  element.textContent = message;
  element.className = `toast show${error ? " error" : ""}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { element.className = "toast"; }, 3200);
}

function setText(selector, value) {
  const element = $(selector);
  if (element) element.textContent = value;
}

function renderHeader() {
  const quote = data.quoteTime ? String(data.quoteTime).replace(/^\d{4}(\d{2})(\d{2})\s?(\d{2}:\d{2}).*$/, "$1-$2 $3") : null;
  const stored = shanghaiTimeLabel(data.storedAt || data.capturedAt)?.split(" ").at(-1);
  const status = data.endOfDay ? `盘后快照${data.partial ? " · 部分数据可用" : ""}` : data.offSession ? "定时快照 · 非交易时段" : data.partial ? "定时快照 · 部分数据可用" : "定时快照";
  if (refreshRun.active) return; // 更新中由 renderRefreshState 接管状态条
  $("#connection-dot").className = data.partial ? "status-dot" : "status-dot ok";
  setText("#connection", status);
  const quoteLabel = data.endOfDay && quote ? `收盘数据 ${quote.slice(0, 5)}` : quote ? `行情时间 ${quote}` : "未返回行情时间";
  setText("#quote-time", `${quoteLabel}${stored ? ` · 快照 ${stored}` : ""}`);
  if (data.schedule) setText("#schedule-note", data.schedule);
  reportToolbarState({ connection: status, quoteTime: quote ? `行情时间 ${quote}` : "未返回行情时间", partial: data.partial });
}

function reportToolbarState(overrides = {}) {
  if (!isEmbedded || window.parent === window) return;
  window.parent.postMessage({ type: "emotion-toolbar-state", connection: data?.partial ? "Wind 部分数据可用" : "Wind 数据已连接", quoteTime: data?.quoteTime ? `行情时间 ${String(data.quoteTime).replace(/^(\d{8})\s?/, "$1 ")}` : "等待行情时间", partial: Boolean(data?.partial), ...overrides }, "*");
}

function renderPulse() {
  setText("#score", data.score);
  setText("#phase", data.regime.phase);
  setText("#posture", `当前姿态 · ${data.regime.posture}`);
  setText("#summary", data.regime.summary);
  setText("#phase-badge", data.regime.phase);
  $("#score-ring").style.setProperty("--score", data.score);
  const titles = {
    冰點: "先观察风险释放，不急于左侧抢修复",
    修復: "小仓试错，等待修复升级为共振",
    冰点: "先观察风险释放，不急于左侧抢修复",
    退潮: "降低交易频率，回避中高位接力",
    分歧: "聚焦核心，放弃无辨识度后排",
    修复: "小仓试错，等待修复升级为共振",
    主升: "围绕主线核心参与扩散与分歧回流",
    高潮: "去弱留强，防范次日一致转分歧"
  };
  setText("#action-title", titles[data.regime.phase] || "等待市场结构进一步确认");
  setText("#action-copy", `情绪分数 ${data.score}，操作姿态为“${data.regime.posture}”。评分来自广度、极端反馈、梯队、溢价、题材和成交环境。`);
  setText("#confirm-signal", data.score >= 57 ? "核心强势延续、后排不出现批量掉队" : "跌停与大跌收缩、昨日强势股溢价转正");
  setText("#risk-signal", data.score >= 70 ? "炸板上升、昨日涨停溢价快速转负" : "跌停扩散、高位股负反馈加剧");
  const names = MARKET === "tw" ? { ...dimensionNames, breadth: "产业广度", themes: "产业聚焦" } : dimensionNames;
  $("#dimension-bars").innerHTML = Object.entries(data.dimensions).map(([key, value]) => `<div class="dimension-item"><span>${escapeHtml(names[key] || key)}</span><div class="dimension-track"><i style="width:${Math.max(2, Number(value))}%"></i></div><b>${formatNumber(value)}</b></div>`).join("");
}

function renderMetrics() {
  setText("#index-change", formatPct(data.market.changePct));
  $("#index-change").className = signClass(data.market.changePct);
  setText("#index-level", Number.isFinite(data.market.index) ? `${CFG.indexPrefix} ${data.market.index.toFixed(2)}` : CFG.indexCode);
  setText("#amount", compactAmount(data.market.amount));
  setText("#premium", formatPct(data.profit.premium));
  $("#premium").className = signClass(data.profit.premium);
  $("#limit-pair").innerHTML = '<span class="up-text">' + formatNumber(data.extremes.limitUp) + '</span><i>/</i><span class="down-text">' + formatNumber(data.extremes.limitDown) + '</span>';
}

function renderBreadth() {
  const up = Number(data.market.up) || 0;
  const down = Number(data.market.down) || 0;
  const flat = Number(data.market.flat) || 0;
  const total = up + down + flat || 1;
  setText("#up-count", formatNumber(data.market.up));
  setText("#down-count", formatNumber(data.market.down));
  setText("#flat-count", formatNumber(data.market.flat));
  setText("#up-ratio", Number.isFinite(data.market.upRatio) ? `上涨占比 ${data.market.upRatio.toFixed(1)}%` : "—");
  $("#breadth-up").style.width = `${up / total * 100}%`;
  $("#breadth-down").style.width = `${down / total * 100}%`;
  $("#breadth-flat").style.width = `${flat / total * 100}%`;
  const ratio = Number(data.market.upRatio);
  const breadthText = !Number.isFinite(ratio) ? "广度数据暂缺。" : ratio >= 70 ? "市场呈现普涨，赚钱效应具备扩散基础。" : ratio >= 50 ? "上涨家数占优，但仍需结合涨停溢价判断强度。" : ratio >= 30 ? "下跌家数占优，当前更接近结构行情。" : "市场广度明显偏弱，指数表现可能掩盖个股风险。";
  setText("#breadth-read", MARKET === "tw" ? `${breadthText.replace(/家数/g, "产业")}（按 ${up + down + flat} 个证交所产业指数统计）` : breadthText);
  // 台股条件选股最多返回 100 只，达到上限显示「100+」
  const capped = (value, flag) => `${formatNumber(value)}${flag ? "+" : ""}`;
  setText("#limit-up", capped(data.extremes.limitUp, data.extremes.limitUpCapped));
  setText("#limit-down", capped(data.extremes.limitDown, data.extremes.limitDownCapped));
  setText("#big-up", capped(data.extremes.bigUp, data.extremes.bigUpCapped));
  setText("#big-down", capped(data.extremes.bigDown, data.extremes.bigDownCapped));
  const bigUp = Number(data.extremes.bigUp);
  const bigDown = Number(data.extremes.bigDown);
  const balance = Number.isFinite(bigUp + bigDown) && bigUp + bigDown ? bigUp / (bigUp + bigDown) * 100 : 50;
  $("#tail-balance i").style.left = `${balance}%`;
  setText("#tail-balance span", balance >= 55 ? "大涨尾部占优，弹性方向反馈较好" : balance <= 45 ? "大跌尾部占优，亏钱效应更强" : "大涨与大跌尾部接近平衡");
}

function renderThemes() {
  const themes = data.themes || [];
  if (!themes.length) {
    $("#theme-list").innerHTML = `<div class="empty">${CFG.emptyThemes}</div>`;
    return;
  }
  const max = Math.max(...themes.map((item) => Math.abs(Number(item.changePct))), 1);
  $("#theme-list").innerHTML = themes.map((item, index) => `<div class="theme-row"><span class="theme-rank">${String(index + 1).padStart(2, "0")}</span><span class="theme-name"><b>${escapeHtml(item.name)}</b><small>${escapeHtml(item.code)}</small></span><span class="theme-bar"><i style="width:${Math.max(4, Math.abs(item.changePct) / max * 100)}%"></i></span><span class="theme-change ${signClass(item.changePct)}">${formatPct(item.changePct)}</span></div>`).join("");
}

// 个股分层默认收起；记住用户展开过的题材，切换筛选后保持展开。
const openedStockThemes = new Set();
function stockDetailsOpen(name) {
  return openedStockThemes.has(name);
}
document.addEventListener("toggle", (event) => {
  const details = event.target;
  if (!(details instanceof HTMLDetailsElement) || !details.classList.contains("stock-details")) return;
  if (details.open) openedStockThemes.add(details.dataset.theme);
  else openedStockThemes.delete(details.dataset.theme);
}, true);

function renderAnomalies() {
  const summary = anomalyData?.summary || {};
  const sourceItems = anomalyData?.items || [];
  const filterLabels = { all: "全部异动", limit: "涨停点火", batch: "批量拉升", news: "消息催化" };
  const limitLabel = MARKET === "tw" ? "涨停（≥9.5%）" : "涨停";
  const filterCounts = {
    all: sourceItems.filter((item) => (item.tabScores?.all ?? item.score) >= 60).length,
    limit: sourceItems.filter((item) => item.signals.includes("limit") && (item.tabScores?.limit ?? item.score) >= 60).length,
    batch: sourceItems.filter((item) => item.signals.includes("batch") && (item.tabScores?.batch ?? item.score) >= 60).length,
    news: sourceItems.filter((item) => item.signals.includes("news") && (item.tabScores?.news ?? item.score) >= 60).length
  };
  $$(".anomaly-filter").forEach((button) => {
    const key = button.dataset.anomalyFilter;
    button.textContent = `${filterLabels[key]} ${filterCounts[key] || 0}`;
    button.setAttribute("aria-pressed", String(key === anomalyFilter));
  });
  const streakRank = (label) => label === "首板" ? 1 : Number.parseInt(label) || 99;
  const streakSummary = Object.entries(anomalyData?.limitData?.streakCounts || {}).sort((a, b) => streakRank(a[0]) - streakRank(b[0])).map(([label, count]) => `<span>${escapeHtml(label)} ${count}</span>`).join("");
  $("#anomaly-summary").innerHTML = `<span>${MARKET === "tw" ? "有效方向" : "有效题材"} ${summary.total || 0}</span><span>${limitLabel}样本 ${anomalyData?.limitData?.stockCount || 0}</span>${streakSummary}${MARKET === "tw" ? "" : `<span>已合并 ${Math.max(0, (summary.rawTotal || 0) - (summary.mergedTotal || 0))}</span>`}<span>过滤低分 ${summary.filteredOut || 0}</span><span>门槛 ≥ ${summary.minScore || 60}</span>`;
  const sorters = {
    all: (a, b) => (b.tabScores?.all ?? b.score) - (a.tabScores?.all ?? a.score) || (b.scoreBreakdown?.ladderTotalBonus || 0) - (a.scoreBreakdown?.ladderTotalBonus || 0) || (b.sortMetrics?.limitCount || 0) - (a.sortMetrics?.limitCount || 0),
    limit: (a, b) => (b.sortMetrics?.limitCount || b.limitStocks?.length || 0) - (a.sortMetrics?.limitCount || a.limitStocks?.length || 0) || (b.tabScores?.limit ?? b.score) - (a.tabScores?.limit ?? a.score),
    batch: (a, b) => (b.sortMetrics?.fiveMinuteChange || b.shortMove || 0) - (a.sortMetrics?.fiveMinuteChange || a.shortMove || 0) || (b.tabScores?.batch ?? b.score) - (a.tabScores?.batch ?? a.score),
    news: (a, b) => (b.sortMetrics?.newsMomentum || 0) - (a.sortMetrics?.newsMomentum || 0) || (b.tabScores?.news ?? b.score) - (a.tabScores?.news ?? a.score)
  };
  const sortLabels = MARKET === "tw"
    ? { all: "综合分降序", limit: "涨停家数降序", batch: "—", news: "产业涨跌幅降序" }
    : { all: "综合分降序", limit: "涨停家数降序", batch: "5分钟涨跌幅降序", news: "涨跌幅与涨速综合降序" };
  const items = sourceItems.filter((item) => (anomalyFilter === "all" || item.signals.includes(anomalyFilter)) && (item.tabScores?.[anomalyFilter] ?? item.score) >= 60).sort(sorters[anomalyFilter] || sorters.all);
  const quoteTime = anomalyData?.items?.[0]?.tradeTime ? `行情时间 ${anomalyData.items[0].tradeTime} · ` : "";
  setText("#anomaly-time", `${quoteTime}排序：${sortLabels[anomalyFilter]}`);
  const viewState = `<div class="anomaly-view-state"><b>${filterLabels[anomalyFilter]}</b><span>当前 ${items.length} 个题材 · ${sortLabels[anomalyFilter]}</span></div>`;
  if (!items.length) {
    $("#anomaly-list").innerHTML = `${viewState}<div class="anomaly-empty">当前筛选条件下没有识别到题材异动。</div>`;
    return;
  }
  const labels = { limit: "涨停点火", batch: "批量拉升", news: "消息催化" };
  const stockItems = (items, role) => items.length ? items.map((stock) => {
    const candidateRules = role === "ride" ? `<div class="candidate-rules"><p><strong>触发</strong><span>${escapeHtml(stock.trigger || "等待个股突破日内关键价位且题材动能保持为正")}</span></p><p><strong>失效</strong><span>${escapeHtml(stock.invalidation || "跌破日内关键支撑且题材5分钟动能转负")}</span></p></div>` : "";
    const streakBadge = role === "ignition" && Number(stock.limitStreak) >= 2 ? `<i class="streak-badge">${escapeHtml(stock.streakLabel || `${stock.limitStreak}连板`)}</i>` : "";
    const quote = Number.isFinite(Number(stock.changePct)) ? formatPct(stock.changePct) : role === "ignition" ? "涨停" : "—";
    return `<div class="role-stock"><span><b>${escapeHtml(stock.name)}</b><small>${escapeHtml(stock.code)}</small></span><span class="role-stock-metric"><em class="${signClass(stock.changePct)}">${quote}</em>${streakBadge}</span>${Number.isFinite(Number(stock.candidateScore)) ? `<i>候选分 ${stock.candidateScore}</i>` : ""}${candidateRules}</div>`;
  }).join("") : '<div class="role-empty">暂无有效标的</div>';
  $("#anomaly-list").innerHTML = viewState + items.map((item, index) => {
    const activeScore = item.tabScores?.[anomalyFilter] ?? item.score;
    const visibleSignals = anomalyFilter === "all" ? item.signals : [anomalyFilter];
    const chips = visibleSignals.map((signal) => `<span class="anomaly-chip ${signal}">${labels[signal]}</span>`).join("");
    const limitNames = (item.limitStocks || []).map((stock) => stock.name).join("、");
    const branchNames = (item.branches || []).map((branch) => branch.name);
    const details = [];
    if (branchNames.length > 1) details.push(`合并分支：${branchNames.join("、")}`);
    if ((anomalyFilter === "all" || anomalyFilter === "limit") && limitNames) details.push(`点火个股：${limitNames}`);
    if (item.ladder?.maxStreak >= 3) details.push(`最高${item.ladder.maxStreak}板，高度加分 +${item.ladder.highBoardBonus}`);
    if (item.ladder?.contiguousDepth >= 3) details.push(`完整首板至${item.ladder.contiguousDepth}板，梯队加分 +${item.ladder.ladderBonus}`);
    if (anomalyFilter === "batch") details.push(`批量拉升：5分钟涨跌幅 ${formatPct(item.sortMetrics?.fiveMinuteChange ?? item.shortMove)}`);
    if (!details.length) details.push(`日内涨幅 ${formatPct(item.dayChange)}`);
    const detail = details.join("；");
    const rankingMetric = anomalyFilter === "limit"
      ? `${item.sortMetrics?.limitCount || item.limitStocks?.length || 0}家涨停`
      : anomalyFilter === "batch"
        ? `5分钟 ${formatPct(item.sortMetrics?.fiveMinuteChange ?? item.shortMove)}`
        : anomalyFilter === "news"
          ? `${item.news?.length || 0}条催化`
          : `综合分 ${activeScore}`;
    const showNews = (anomalyFilter === "all" || anomalyFilter === "news") && item.news?.length;
    const newsCards = showNews ? `<div class="catalyst-news-list">${item.news.slice(0, 3).map((article) => `<article class="catalyst-news"><div class="catalyst-news-head"><b>${escapeHtml(article.title || "Wind市场消息")}</b><span>${escapeHtml(article.source || "Wind财经新闻")}${article.date ? ` · ${escapeHtml(article.date)}` : ""}</span></div><p><strong>刺激观点</strong>${escapeHtml(article.viewpoint || article.catalyst || "正文观点待补充")}</p><p><strong>可能影响</strong>${escapeHtml(article.impact || article.relation || `需要继续验证该消息对${item.name}基本面预期的实际影响。`)}</p>${article.matchedKeywords?.length ? `<div class="catalyst-keywords">${article.matchedKeywords.map((keyword) => `<i>${escapeHtml(keyword)}</i>`).join("")}${Number.isFinite(Number(article.relevanceScore)) ? `<em>关联度 ${article.relevanceScore}</em>` : ""}</div>` : ""}</article>`).join("")}</div>` : "";
    const displayStatus = anomalyFilter === "limit" ? "涨停点火" : anomalyFilter === "batch" ? "批量拉升" : anomalyFilter === "news" ? "消息催化" : item.status;
    const batchChip = (anomalyFilter === "all" || anomalyFilter === "batch") && item.shortMove != null && Number.isFinite(Number(item.shortMove)) ? `<span class="anomaly-chip batch">5分钟 ${formatPct(item.shortMove)}</span>` : "";
    const limitChip = (anomalyFilter === "all" || anomalyFilter === "limit") && item.limitStocks?.length ? `<span class="anomaly-chip limit">${item.limitStocks.length}只点火股</span>` : "";
    const highBoardChip = (anomalyFilter === "all" || anomalyFilter === "limit") && item.ladder?.maxStreak >= 3 ? `<span class="anomaly-chip ladder">最高${item.ladder.maxStreak}板 +${item.ladder.highBoardBonus}</span>` : "";
    const fullLadderChip = (anomalyFilter === "all" || anomalyFilter === "limit") && item.ladder?.contiguousDepth >= 3 ? `<span class="anomaly-chip ladder">完整1-${item.ladder.contiguousDepth}板 +${item.ladder.ladderBonus}</span>` : "";
    return `<article class="anomaly-card filter-${anomalyFilter}${index < 3 ? " primary" : ""}"><div class="anomaly-card-head"><div><b>${escapeHtml(item.name)}</b><small>${escapeHtml(item.code || "Wind概念映射")}</small><em class="anomaly-rank-metric">${rankingMetric}</em></div><span class="anomaly-score">${activeScore}</span></div><span class="anomaly-status">${escapeHtml(displayStatus)}</span><div class="anomaly-evidence">${chips}${batchChip}${limitChip}${highBoardChip}${fullLadderChip}</div><p class="anomaly-detail" title="${escapeHtml(detail)}">${escapeHtml(detail)}</p>${newsCards}<details class="stock-details" data-theme="${escapeHtml(item.name)}"${stockDetailsOpen(item.name) ? " open" : ""}><summary>个股分层 <small>点火 ${(item.limitStocks || []).length} · 跟风 ${(item.followers || []).length} · 候选 ${(item.rideable || []).length}</small></summary><div class="stock-layers"><section class="role-section ignition"><h4>点火个股 <small>率先封板</small></h4>${stockItems(item.limitStocks || [], "ignition")}</section><section class="role-section follower"><h4>跟风个股 <small>同步走强未封板</small></h4>${stockItems(item.followers || [], "follower")}</section><section class="role-section ride"><h4>候选上车 <small>需等待触发</small></h4>${stockItems(item.rideable || [], "ride")}</section></div></details></article>`;
  }).join("");
}

async function loadAnomalies(force = false) {
  $("#anomaly-list").innerHTML = '<div class="loading">正在读取分钟异动、涨停映射和新闻催化…</div>';
  anomalyData = await api("anomalies");
  renderAnomalies();
}

function renderDailyTimeline() {
  const allDaily = (data.dailyHistory || []).filter((item) => String(item.tradingDate || "").length === 8 && Number.isFinite(Number(item.score)))
    .sort((a, b) => String(a.tradingDate).localeCompare(String(b.tradingDate)));
  const history = allDaily.slice(-20);
  setText("#history-count", `近 ${history.length} 个交易日均值`);
  if (history.length < 2) {
    $("#timeline-chart").innerHTML = `<div class="empty">\u5df2\u6c89\u6dc0${history.length}\u4e2a\u65e5\u7ebf\u70b9\uff1b\u6bcf\u65e5\u6309\u5f53\u5929 n \u4e2a\u76d8\u4e2d\u5feb\u7167\u7b49\u6743\u5e73\u5747\uff0c\u540e\u7eed\u81ea\u52a8\u7d2f\u8ba1\u3002</div>`;
    return;
  }
  const { width, height } = chartSize();
  const pad = 25;
  const xAt = (index) => pad + index / Math.max(1, history.length - 1) * (width - pad * 2);
  const points = history.map((item, index) => ({ ...item, x: xAt(index), y: height - pad - Number(item.score) / 100 * (height - pad * 2) }));
  const line = points.map((point) => `${point.x},${point.y}`).join(" ");
  const area = `${points[0].x},${height - pad} ${line} ${points.at(-1).x},${height - pad}`;
  const grid = [25, 50, 75].map((score) => { const y = height - pad - score / 100 * (height - pad * 2); return `<line class="timeline-grid" x1="${pad}" y1="${y}" x2="${width - pad}" y2="${y}"/><text class="timeline-label" x="0" y="${y + 3}">${score}</text>`; }).join("");
  const dots = points.map((point, index) => `<circle class="timeline-dot" cx="${point.x}" cy="${point.y}" r="${index === points.length - 1 ? 5 : 3}"><title>${escapeHtml(point.tradingDate)} \u00b7 \u5747\u503c ${Number(point.score).toFixed(2)} \u00b7 n=${point.sampleCount} \u00b7 ${escapeHtml(point.phase)}</title></circle>`).join("");
  const axisIndexes = [...new Set([0, Math.round((history.length - 1) * .25), Math.round((history.length - 1) * .5), Math.round((history.length - 1) * .75), history.length - 1])];
  const axis = axisIndexes.map((index, slotIndex) => {
    const point = points[index];
    const label = `${point.tradingDate.slice(4, 6)}-${point.tradingDate.slice(6, 8)}`;
    const anchor = slotIndex === 0 ? "start" : slotIndex === axisIndexes.length - 1 ? "end" : "middle";
    return `<line class="timeline-grid timeline-time-grid" x1="${point.x}" y1="${pad}" x2="${point.x}" y2="${height - pad}"/><text class="timeline-label timeline-time-label" text-anchor="${anchor}" x="${point.x}" y="${height - 5}">${label}</text>`;
  }).join("");
  $("#timeline-chart").innerHTML = `<svg viewBox="0 0 ${width} ${height}" preserveAspectRatio="none"><defs><linearGradient id="areaGradientDaily" x1="0" y1="0" x2="0" y2="1"><stop class="timeline-stop" offset="0" stop-opacity=".12"/><stop class="timeline-stop" offset="1" stop-opacity="0"/></linearGradient></defs>${grid}${axis}<polygon class="timeline-area daily" points="${area}"/><polyline class="timeline-line" points="${line}"/>${dots}</svg>`;
}

// 按容器真实尺寸绘制，避免 viewBox 固定 1000×200 在手机上把文字和圆点横向压扁。
function chartSize() {
  const box = $("#timeline-chart");
  return { width: Math.max(280, Math.round(box?.clientWidth || 1000)), height: Math.max(150, Math.round(box?.clientHeight || 200)) };
}

function renderTimeline() {
  setText("#timeline-title", timelineMode === "daily" ? "每日情绪均值" : "盘中情绪路径");
  if (timelineMode === "daily") {
    renderDailyTimeline();
    return;
  }
  const shanghaiNow = new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date()).reduce((result, part) => ({ ...result, [part.type]: part.value }), {});
  const today = `${shanghaiNow.year}${shanghaiNow.month}${shanghaiNow.day}`;
  const nowMinute = Number(shanghaiNow.hour) * 60 + Number(shanghaiNow.minute);
  const parseSnapshot = (item) => {
    const quote = String(item.quoteTime || "");
    const quoteMatch = quote.match(/(\d{8})\s+(\d{2}):(\d{2})/);
    if (quoteMatch) return { ...item, snapshotDate: quoteMatch[1], minute: Number(quoteMatch[2]) * 60 + Number(quoteMatch[3]), timeLabel: `${quoteMatch[2]}:${quoteMatch[3]}` };
    const captured = new Date(item.capturedAt);
    if (Number.isNaN(captured.getTime())) return null;
    const parts = new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(captured).reduce((result, part) => ({ ...result, [part.type]: part.value }), {});
    return { ...item, snapshotDate: `${parts.year}${parts.month}${parts.day}`, minute: Number(parts.hour) * 60 + Number(parts.minute), timeLabel: `${parts.hour}:${parts.minute}` };
  };
  const tradingDate = String(data.tradingDate || today);
  const inSession = (minute) => CFG.sessions.some(([start, end]) => minute >= start && minute <= end);
  const history = (data.history || []).map(parseSnapshot).filter(Boolean)
    .filter((item) => item.snapshotDate === tradingDate)
    .filter((item) => inSession(item.minute))
    .filter((item) => tradingDate !== today || item.minute <= nowMinute)
    .sort((a, b) => a.minute - b.minute).slice(-60);
  const latestLabel = history.at(-1)?.timeLabel;
  setText("#history-count", `${history.length} 个当日快照${latestLabel ? ` · 截至 ${latestLabel}` : ""}`);
  if (history.length < 2) {
    $("#timeline-chart").innerHTML = '<div class="empty">交易时段每 30 分钟生成一个快照，至少两个快照后形成盘中曲线。</div>';
    return;
  }
  const { width, height } = chartSize();
  const pad = 25;
  // 把各交易时段首尾相接（A股去掉午休），算出某分钟在整个交易日中的位置。
  const tradingProgress = (minute) => {
    let elapsed = 0;
    for (const [start, end] of CFG.sessions) {
      if (minute <= end) return elapsed + Math.max(0, minute - start);
      elapsed += end - start;
    }
    return elapsed;
  };
  const totalTradingMinutes = CFG.sessions.reduce((sum, [start, end]) => sum + end - start, 0);
  const xAt = (minute) => pad + tradingProgress(minute) / totalTradingMinutes * (width - pad * 2);
  const points = history.map((item) => ({ x: xAt(item.minute), y: height - pad - Number(item.score) / 100 * (height - pad * 2), ...item }));
  const line = points.map((point) => `${point.x},${point.y}`).join(" ");
  const area = `${points[0].x},${height - pad} ${line} ${points.at(-1).x},${height - pad}`;
  const grid = [25, 50, 75].map((score) => { const y = height - pad - score / 100 * (height - pad * 2); return `<line class="timeline-grid" x1="${pad}" y1="${y}" x2="${width - pad}" y2="${y}"/><text class="timeline-label" x="0" y="${y + 3}">${score}</text>`; }).join("");
  const dots = points.map((point, index) => `<circle class="timeline-dot" cx="${point.x}" cy="${point.y}" r="${index === points.length - 1 ? 5 : 3}"><title>${escapeHtml(point.phase)} · ${point.score} · ${escapeHtml(point.timeLabel)}</title></circle>`).join("");
  const slots = (width < 480 ? CFG.slotsNarrow : CFG.slotsWide).map(([minute, label]) => ({ minute, label }));
  const axis = slots.map((slot, index) => { const x = xAt(slot.minute); const anchor = index === 0 ? "start" : index === slots.length - 1 ? "end" : "middle"; return `<line class="timeline-grid timeline-time-grid" x1="${x}" y1="${pad}" x2="${x}" y2="${height - pad}"/><text class="timeline-label timeline-time-label" text-anchor="${anchor}" x="${x}" y="${height - 5}">${slot.label}</text>`; }).join("");
  $("#timeline-chart").innerHTML = `<svg viewBox="0 0 ${width} ${height}" preserveAspectRatio="none"><defs><linearGradient id="areaGradient" x1="0" y1="0" x2="0" y2="1"><stop class="timeline-stop" offset="0" stop-opacity=".12"/><stop class="timeline-stop" offset="1" stop-opacity="0"/></linearGradient></defs>${grid}${axis}<polygon class="timeline-area" points="${area}"/><polyline class="timeline-line" points="${line}"/>${dots}</svg>`;
}

function renderAll() {
  renderHeader();
  renderPulse();
  renderMetrics();
  renderBreadth();
  renderThemes();
  renderTimeline();
}

async function loadEmotion(force = false) {
  const button = $("#refresh");
  button.dataset.loading = "1";
  button.disabled = true;
  if (!refreshRun.active) button.textContent = "读取中…";
  reportToolbarState({ refreshing: true });
  try {
    data = await api("emotion");
    const historyPayload = await api("history").catch(() => null);
    if (historyPayload) {
      data.history = historyPayload.history || data.history || [];
      data.dailyHistory = historyPayload.dailyHistory || data.dailyHistory || [];
    }
    renderAll();
    loadNews();
    await loadAnomalies(force);

  } catch (error) {
    const notReady = error.code === "not_ready";
    $("#connection-dot").className = notReady ? "status-dot" : "status-dot bad";
    setText("#connection", notReady ? "暂无快照" : "快照读取异常");
    if (notReady) {
      setText("#phase", "等待开盘");
      setText("#summary", error.message);
      $("#anomaly-list").innerHTML = '<div class="anomaly-empty">首个交易时段快照生成后自动显示。</div>';
    }
    reportToolbarState({ connection: notReady ? "暂无快照" : "快照读取异常", error: !notReady });
    toast(error.message, !notReady);
  } finally {
    delete button.dataset.loading;
    updateRefreshButton();
    reportToolbarState({ refreshing: false });
  }
}

async function loadNews() {
  $("#news-list").innerHTML = '<div class="loading">正在读取新闻快照…</div>';
  try {
    const payload = await api("news");
    const items = payload.items || [];
    const asOf = shanghaiTimeLabel(payload.asOf);
    setText("#news-asof", asOf ? `快照 ${asOf}` : "等待快照");
    $("#news-list").innerHTML = items.length ? items.slice(0, 5).map((item) => `<article class="news-item"><b>${escapeHtml(item.title || "Wind 市场信息")}</b><span>${escapeHtml(item.date || "")} · 相关度 ${Number(item.relevance || 0).toFixed(2)}</span><p>${escapeHtml(String(item.content || "").slice(0, 170))}${String(item.content || "").length > 170 ? "…" : ""}</p></article>`).join("") : '<div class="empty">暂无新闻快照，交易日 09:00 起每 30 分钟更新。</div>';
  } catch (error) {
    $("#news-list").innerHTML = `<div class="empty">${escapeHtml(error.message)}</div>`;
    toast(error.message, true);
  }
}

// ── 导出图片：长图（整页一张）或小卡（每个模块一张），在浏览器内用 html-to-image 生成 ──
const EXPORT_WIDTH = 600;

function exportDay() {
  return new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date()).replaceAll("/", "-");
}

function exportBackground() {
  return getComputedStyle(document.documentElement).getPropertyValue("--bg").trim() || "#efefef";
}

/** 克隆一段页面内容，去掉按钮和 id，展开折叠内容。 */
function cloneForExport(node, { openDetails = true } = {}) {
  const clone = node.cloneNode(true);
  clone.removeAttribute("id");
  clone.querySelectorAll("[id]").forEach((item) => item.removeAttribute("id"));
  clone.querySelectorAll("button").forEach((item) => item.remove());
  clone.querySelectorAll("details").forEach((item) => { if (openDetails) item.open = true; else item.remove(); });
  clone.querySelectorAll(".news-list").forEach((item) => { item.style.maxHeight = "none"; item.style.overflow = "visible"; });
  return clone;
}

function exportHeader(subtitle = "") {
  const head = document.createElement("div");
  head.className = "export-head";
  const quote = $("#quote-time")?.textContent || "";
  head.innerHTML = `<img src="/short-emotion/logo.svg" alt="ShortEmotion"><div><b>${escapeHtml(toHant(`短线情绪 · ${CFG.label}`))}${subtitle ? ` · ${escapeHtml(subtitle)}` : ""}</b><small>${escapeHtml(quote)}</small></div>`;
  return head;
}

function exportFooter() {
  const footer = document.createElement("div");
  footer.className = "export-footer";
  footer.textContent = toHant(`ShortEmotion · 数据来源 Wind · 仅用于研究与情绪观察，不构成投资建议`);
  return footer;
}

async function renderShell(nodes, extraClass = "") {
  const host = document.createElement("div");
  host.className = "export-host";
  const shell = document.createElement("div");
  shell.className = `export-shell ${extraClass}`.trim();
  shell.style.width = `${EXPORT_WIDTH}px`;
  shell.append(...nodes);
  host.append(shell);
  document.body.append(host);
  try {
    await document.fonts?.ready;
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const height = Math.ceil(shell.scrollHeight);
    if (height > 30000) throw new Error("页面过长，请改用「导出小卡」");
    // iOS Safari 单张 canvas 约 1600 万像素上限，按尺寸自动降低倍率。
    // 浏览器 canvas 单边最多约 16384 像素，长图再按高度限制倍率，避免底部被截掉。
    const pixelRatio = Math.max(0.5, Math.min(2, window.devicePixelRatio || 1, Math.sqrt(16_000_000 / (EXPORT_WIDTH * height)), 16_000 / height));
    const blob = await window.htmlToImage.toBlob(shell, { width: EXPORT_WIDTH, height, pixelRatio, backgroundColor: exportBackground() });
    if (!blob) throw new Error("浏览器未能生成图片");
    return blob;
  } finally {
    host.remove();
  }
}

/** 小卡：每个模块一张，标题 + 行情时间 + 模块内容 + 免责声明。 */
function exportCardSources() {
  const title = (node, fallback) => node?.querySelector(".card-title")?.textContent?.trim() || fallback;
  const sources = [];
  const add = (node, name, options) => { if (node && node.offsetParent !== null) sources.push({ node, name: title(node, name), ...options }); };
  add($(".pulse-card"), "情绪温度");
  add($(".signal-card"), "交易姿态");
  const metrics = $(".metric-strip");
  if (metrics) sources.push({ node: metrics, name: toHant("核心指标") });
  $$("#breadth .card").forEach((card) => add(card, "广度"));
  // 异动：取当前筛选下的前 3 个方向，各自一张（不含个股分层明细）
  $$(".anomaly-card").slice(0, 3).forEach((card) => {
    const name = card.querySelector(".anomaly-card-head b")?.textContent?.trim() || "";
    sources.push({ node: card, name: `${$("#anomaly-title")?.textContent || ""} · ${name}`, openDetails: false });
  });
  add($("#theme-ranking"), "热度排名");
  add($(".catalyst-panel"), "事件催化");
  add($(".timeline-panel"), "情绪路径");
  return sources;
}

async function exportLongImage() {
  const main = document.querySelector("main");
  const clone = cloneForExport(main);
  const active = $(".anomaly-filter.active");
  if (active) {
    const marker = document.createElement("span");
    marker.className = "export-filter-marker";
    marker.textContent = `当前视图：${active.textContent}`;
    clone.querySelector(".anomaly-toolbar")?.prepend(marker);
  }
  clone.querySelectorAll(".status-bar").forEach((item) => item.remove());
  const blob = await renderShell([exportHeader(), clone, exportFooter()]);
  return [{ blob, name: toHant(`AI短线情绪-${CFG.label}-${exportDay()}.png`), title: toHant("长图") }];
}

async function exportSmallCards(onProgress) {
  const sources = exportCardSources();
  const files = [];
  for (let index = 0; index < sources.length; index += 1) {
    const source = sources[index];
    onProgress?.(index + 1, sources.length);
    const blob = await renderShell([exportHeader(source.name), cloneForExport(source.node, { openDetails: source.openDetails !== false }), exportFooter()], "export-card");
    files.push({ blob, name: toHant(`AI短线情绪-${CFG.label}-${exportDay()}-${String(index + 1).padStart(2, "0")}.png`), title: source.name });
  }
  return files;
}

function downloadBlob(blob, name) {
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = name;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(link.href), 4000);
}

async function shareOrDownload(files) {
  const asFiles = typeof File === "function" ? files.map((item) => new File([item.blob], item.name, { type: "image/png" })) : [];
  if (asFiles.length && window.matchMedia("(pointer: coarse)").matches && navigator.canShare?.({ files: asFiles })) {
    await navigator.share({ files: asFiles, title: toHant("AI短线情绪") }).catch((error) => { if (error?.name !== "AbortError") throw error; });
    return;
  }
  for (const item of files) {
    downloadBlob(item.blob, item.name);
    await new Promise((resolve) => setTimeout(resolve, 350));
  }
}

/** 小卡预览：可逐张保存，也可一次全部分享/下载。手机上长按图片也能存到相册。 */
function showGallery(files) {
  closeGallery();
  const urls = files.map((item) => URL.createObjectURL(item.blob));
  const overlay = document.createElement("div");
  overlay.className = "export-gallery";
  overlay.setAttribute("role", "dialog");
  overlay.setAttribute("aria-label", "导出小卡");
  overlay.innerHTML = `<div class="gallery-sheet"><div class="gallery-head"><b>导出小卡 · ${files.length} 张</b><button class="pill-btn gallery-all" type="button">全部保存</button><button class="nav-btn gallery-close" type="button" aria-label="关闭">✕</button></div><p class="gallery-hint">点单张图片下方的「保存」逐张保存；手机上也可以长按图片存到相册。</p><div class="gallery-grid">${files.map((item, index) => `<figure><img src="${urls[index]}" alt="${escapeHtml(item.title)}"><figcaption><span>${escapeHtml(item.title)}</span><button class="gallery-save" type="button" data-index="${index}">保存</button></figcaption></figure>`).join("")}</div></div>`;
  overlay.addEventListener("click", async (event) => {
    if (event.target === overlay || event.target.closest(".gallery-close")) return closeGallery();
    const save = event.target.closest(".gallery-save");
    if (save) return shareOrDownload([files[Number(save.dataset.index)]]).catch((error) => toast(`保存失败：${error.message}`, true));
    if (event.target.closest(".gallery-all")) return shareOrDownload(files).catch((error) => toast(`保存失败：${error.message}`, true));
  });
  overlay._urls = urls;
  document.body.append(overlay);
  document.body.classList.add("gallery-open");
}

function closeGallery() {
  const overlay = $(".export-gallery");
  if (!overlay) return;
  (overlay._urls || []).forEach((url) => URL.revokeObjectURL(url));
  overlay.remove();
  document.body.classList.remove("gallery-open");
}

let exporting = false;
async function runExport(kind) {
  closeExportMenu();
  if (exporting) return;
  if (!data) return toast("当前没有可导出的短线情绪数据", true);
  if (!window.htmlToImage) return toast("导出组件尚未加载完成，请稍后重试", true);
  const button = $("#export-image");
  exporting = true;
  button.disabled = true;
  button.setAttribute("aria-busy", "true");
  reportToolbarState({ exporting: true });
  try {
    if (kind === "cards") {
      toast("正在生成小卡…");
      const files = await exportSmallCards((current, total) => toast(`正在生成小卡 ${current}/${total}…`));
      showGallery(files);
      toast(`已生成 ${files.length} 张小卡`);
    } else {
      toast("正在生成长图…");
      await shareOrDownload(await exportLongImage());
      toast("长图已生成");
    }
  } catch (error) {
    toast(`导出图片失败：${error instanceof Error ? error.message : String(error)}`, true);
  } finally {
    exporting = false;
    button.disabled = false;
    button.removeAttribute("aria-busy");
    reportToolbarState({ exporting: false });
  }
}

function closeExportMenu() {
  $(".export-menu")?.remove();
  $("#export-image")?.setAttribute("aria-expanded", "false");
}

function toggleExportMenu(event) {
  event.stopPropagation();
  if ($(".export-menu")) return closeExportMenu();
  const menu = document.createElement("div");
  menu.className = "export-menu";
  menu.setAttribute("role", "menu");
  menu.innerHTML = '<button type="button" role="menuitem" data-export="long"><b>导出长图</b><small>整页一张，适合存档</small></button><button type="button" role="menuitem" data-export="cards"><b>导出小卡</b><small>每个区块一张，适合分享</small></button>';
  menu.addEventListener("click", (clickEvent) => {
    const item = clickEvent.target.closest("[data-export]");
    if (item) runExport(item.dataset.export);
  });
  $(".nav").append(menu);
  $("#export-image").setAttribute("aria-expanded", "true");
}

document.addEventListener("click", (event) => { if (!event.target.closest(".export-menu")) closeExportMenu(); });
document.addEventListener("keydown", (event) => { if (event.key === "Escape") { closeExportMenu(); closeGallery(); } });

// 「刷新」每个浏览器每小时只能按一次（打开页面只读快照，不计入、也不触发更新）。
// 点刷新 = 真实调用 Wind MCP：服务端触发 GitHub Actions 数据任务，页面显示「数据更新中」并轮询进度，
// 任务完成后读取新快照，状态回到「定时快照」并显示新的快照时间。
const REFRESH_COOLDOWN_MS = 60 * 60 * 1000;
const REFRESH_KEY = `short-emotion:last-manual-refresh:${MARKET}`;
const REFRESH_TIMEOUT_MS = 6 * 60_000;
const refreshRun = { active: false, step: "", startedAt: 0, requestedAt: null, runId: null, timer: null, ticker: null };

function lastManualRefresh() {
  try { return Number(localStorage.getItem(REFRESH_KEY)) || 0; } catch { return 0; }
}

function refreshCooldownLeft() {
  return Math.max(0, REFRESH_COOLDOWN_MS - (Date.now() - lastManualRefresh()));
}

function updateRefreshButton() {
  const button = $("#refresh");
  if (!button) return;
  if (refreshRun.active) {
    button.disabled = true;
    button.textContent = "更新中…";
    button.title = "正在从 Wind 获取最新数据";
    return;
  }
  if (button.dataset.loading === "1") return;
  const left = refreshCooldownLeft();
  button.disabled = left > 0;
  button.textContent = left > 0 ? `${Math.ceil(left / 60_000)}分钟后可刷新` : "刷新";
  button.title = left > 0 ? "刷新每小时只能使用一次；交易时段每 30 分钟也会自动更新" : "从 Wind 获取最新数据";
}

const REFRESH_STEPS = {
  submitted: "已提交更新请求，等待任务启动…",
  queued: "排队中，即将开始获取数据…",
  in_progress: "正在从 Wind MCP 获取最新数据…",
  reading: "数据已写入，正在读取新快照…"
};

function renderRefreshState() {
  const bar = $(".status-bar");
  bar?.classList.toggle("updating", refreshRun.active);
  if (refreshRun.active) {
    const seconds = Math.max(0, Math.round((Date.now() - refreshRun.startedAt) / 1000));
    $("#connection-dot").className = "status-dot updating";
    setText("#connection", "数据更新中");
    setText("#quote-time", `${REFRESH_STEPS[refreshRun.step] || REFRESH_STEPS.submitted} 已用时 ${seconds} 秒（约 1–2 分钟）`);
  } else if (data) {
    renderHeader();
  }
  updateRefreshButton();
}

function stopRefresh() {
  refreshRun.active = false;
  clearTimeout(refreshRun.timer);
  clearInterval(refreshRun.ticker);
  refreshRun.timer = null;
  refreshRun.ticker = null;
  renderRefreshState();
}

function beginRefresh({ requestedAt = null, runId = null, step = "submitted", startedAt = Date.now(), poll = true } = {}) {
  Object.assign(refreshRun, { active: true, step, startedAt, requestedAt, runId });
  clearInterval(refreshRun.ticker);
  refreshRun.ticker = setInterval(renderRefreshState, 1000);
  renderRefreshState();
  if (poll) pollRefresh();
}

async function finishRefresh(success) {
  if (!success) {
    stopRefresh();
    toast("本次更新未完成，页面仍显示上一份快照，请稍后再试", true);
    return;
  }
  refreshRun.step = "reading";
  renderRefreshState();
  const before = data?.storedAt || null;
  readFresh = true;
  try {
    stopRefreshKeepingBar();
    await loadEmotion(true);
  } finally {
    readFresh = false;
    stopRefresh();
  }
  const after = data?.storedAt || null;
  const label = shanghaiTimeLabel(after)?.split(" ").at(-1);
  if (after && after !== before) {
    toast(`已更新：快照 ${label}`);
    const stamp = $("#quote-time");
    stamp?.classList.remove("just-updated");
    void stamp?.offsetWidth;
    stamp?.classList.add("just-updated");
  } else {
    toast(label ? `已是最新快照（${label}）` : "已读取最新快照");
  }
}

// 读取新数据时保留「数据更新中」的显示，直到渲染完成。
function stopRefreshKeepingBar() {
  clearTimeout(refreshRun.timer);
  refreshRun.timer = null;
}

async function pollRefresh() {
  clearTimeout(refreshRun.timer);
  if (!refreshRun.active) return;
  if (Date.now() - refreshRun.startedAt > REFRESH_TIMEOUT_MS) {
    stopRefresh();
    toast("更新耗时过长，页面仍显示上一份快照；交易时段每 30 分钟也会自动更新", true);
    return;
  }
  try {
    const payload = await api("refresh-status", { fresh: true });
    const run = payload.run;
    // 只认这次刷新对应的任务：已知任务 id，或提交之后才创建的任务（避免把上一次已完成的任务当成这次）
    const mine = run && (refreshRun.runId ? run.id === refreshRun.runId : Boolean(refreshRun.requestedAt) && Date.parse(run.createdAt) >= Date.parse(refreshRun.requestedAt) - 30_000);
    if (mine) {
      refreshRun.runId = run.id;
      if (run.status === "completed") return finishRefresh(run.conclusion === "success");
      refreshRun.step = run.status === "in_progress" ? "in_progress" : "queued";
      renderRefreshState();
    }
  } catch {
    // 网络抖动：继续轮询
  }
  refreshRun.timer = setTimeout(pollRefresh, 4000);
}

async function handleManualRefresh() {
  if (refreshRun.active) return;
  if (refreshCooldownLeft() > 0) {
    updateRefreshButton();
    toast("刷新每小时只能使用一次，交易时段每 30 分钟也会自动更新");
    return;
  }
  try { localStorage.setItem(REFRESH_KEY, String(Date.now())); } catch {}
  beginRefresh({ step: "submitted", poll: false }); // 先显示「数据更新中」，提交成功后再轮询进度
  try {
    const response = await fetch(`${API_BASE}?market=${MARKET}&action=refresh`, { method: "POST", headers: { Accept: "application/json" } });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw Object.assign(new Error(payload.error || `请求失败 (${response.status})`), { code: payload.code });
    if (payload.dispatched) {
      refreshRun.requestedAt = payload.requestedAt;
      if (payload.mode === "local") {
        // 本地模式：POST 已同步等 Wind 取数完成，无需轮询 GitHub 任务状态，直接收尾读取新快照。
        if (payload.errors?.length) console.warn("[refresh] 本次取数部分失败：", payload.errors);
        // 盘后收缩：收盘后当日已有快照，后端只更新新闻催化，行情/题材保持定格。
        const contracted = (payload.skipped || []).some((item) => /emotion\/anomalies/i.test(item));
        if (contracted) {
          const newsUpdated = (payload.ran || []).includes("news");
          stopRefresh();
          // 仍刷新一次页面数据（新闻等会变），但明示行情未重跑。
          refreshRun.step = "reading";
          renderRefreshState();
          readFresh = true;
          try {
            stopRefreshKeepingBar();
            await loadEmotion(true);
          } finally {
            readFresh = false;
            stopRefresh();
          }
          toast(newsUpdated ? "收盘后行情已定格：本次仅更新新闻催化，行情与题材数据保持不变" : "收盘后行情已定格：本时段无新数据（行情保持不变）");
          return;
        }
        return finishRefresh(payload.ok !== false);
      }
    } else if (payload.run) {
      // 其他人刚刚发起过刷新：直接跟随那一次的进度
      refreshRun.runId = payload.run.id;
      if (payload.run.status === "completed") return finishRefresh(payload.run.conclusion === "success");
    }
    pollRefresh();
  } catch (error) {
    try { localStorage.removeItem(REFRESH_KEY); } catch {} // 没刷新成功不占用每小时一次的额度
    stopRefresh();
    toast(error.code === "not_configured" ? "实时刷新服务尚未开通，页面显示的是最近一次定时快照" : `刷新失败：${error.message}`, true);
  }
}

// 打开页面时如果已有进行中的刷新（例如别人刚点过），同样显示「数据更新中」并等它完成。
async function resumeRunningRefresh() {
  try {
    const payload = await api("refresh-status", { fresh: true });
    const run = payload.run;
    if (run && run.status !== "completed" && Date.now() - Date.parse(run.createdAt) < REFRESH_TIMEOUT_MS) {
      beginRefresh({ runId: run.id, step: run.status === "in_progress" ? "in_progress" : "queued", startedAt: Date.parse(run.createdAt) });
    }
  } catch {}
}

setInterval(updateRefreshButton, 30_000);

let resizeTimer = null;
window.addEventListener("resize", () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => { if (data) renderTimeline(); }, 150);
});

function bindEvents() {
  $("#refresh").addEventListener("click", handleManualRefresh);
  $("#export-image").addEventListener("click", toggleExportMenu);

  $$(".anomaly-filter").forEach((button) => button.addEventListener("click", () => {
    anomalyFilter = button.dataset.anomalyFilter;
    $$(".anomaly-filter").forEach((item) => item.classList.toggle("active", item === button));
    renderAnomalies();
  }));
  $$(".timeline-toggle").forEach((button) => button.addEventListener("click", () => {
    timelineMode = button.dataset.timelineMode;
    $$(".timeline-toggle").forEach((item) => {
      const active = item === button;
      item.classList.toggle("active", active);
      item.setAttribute("aria-pressed", String(active));
    });
    renderTimeline();
  }));
  $$(".tab-btn").forEach((button) => button.addEventListener("click", () => {
    setActiveTab(button.dataset.target);
    document.getElementById(button.dataset.target)?.scrollIntoView({ behavior: "smooth", block: "start" });
  }));
  watchSections();
}

function setActiveTab(target) {
  $$(".tab-btn").forEach((item) => {
    const active = item.dataset.target === target;
    item.classList.toggle("active", active);
    // 手机上分栏可横向滚动：只调整分栏自身的横向位置，不触发页面滚动。
    const bar = item.parentElement;
    if (active && bar && (item.offsetLeft < bar.scrollLeft || item.offsetLeft + item.offsetWidth > bar.scrollLeft + bar.clientWidth)) {
      bar.scrollTo({ left: item.offsetLeft - 16, behavior: "smooth" });
    }
  });
}

// 滚动时高亮当前分区（同主站分栏的选中态）。
function watchSections() {
  if (!("IntersectionObserver" in window)) return;
  const visible = new Map();
  const observer = new IntersectionObserver((entries) => {
    entries.forEach((entry) => visible.set(entry.target.id, entry.isIntersecting));
    const current = $$(".tab-btn").map((button) => button.dataset.target).find((id) => visible.get(id));
    if (current) setActiveTab(current);
  }, { rootMargin: "-120px 0px -55% 0px" });
  $$(".tab-btn").forEach((button) => { const section = document.getElementById(button.dataset.target); if (section) observer.observe(section); });
}

applyMarketCopy();
bindEvents();
loadEmotion().then(resumeRunningRefresh);
