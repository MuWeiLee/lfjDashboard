const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
let data = null;
let anomalyData = null;
let anomalyFilter = "all";
let timelineMode = "intraday";
let toastTimer = null;

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

async function api(url) {
  const response = await fetch(url, { headers: { Accept: "application/json" } });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || `请求失败 (${response.status})`);
  return payload;
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
  const quote = data.quoteTime ? String(data.quoteTime).replace(/^(\d{8})\s?/, "$1 ") : null;
  $("#connection-dot").className = data.partial ? "" : "ok";
  setText("#connection", data.partial ? "Wind 部分数据可用" : "Wind 数据已连接");
  setText("#quote-time", quote ? `行情时间 ${quote}` : "未返回行情时间");
  reportToolbarState({ connection: data.partial ? "Wind 部分数据可用" : "Wind 数据已连接", quoteTime: quote ? `行情时间 ${quote}` : "未返回行情时间", partial: data.partial });
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
  $("#dimension-bars").innerHTML = Object.entries(data.dimensions).map(([key, value]) => `<div class="dimension-item"><span>${escapeHtml(dimensionNames[key] || key)}</span><div class="dimension-track"><i style="width:${Math.max(2, Number(value))}%"></i></div><b>${formatNumber(value)}</b></div>`).join("");
}

function renderMetrics() {
  setText("#index-change", formatPct(data.market.changePct));
  $("#index-change").className = signClass(data.market.changePct);
  setText("#index-level", Number.isFinite(data.market.index) ? `全A ${data.market.index.toFixed(2)}` : "881001.WI");
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
  setText("#breadth-read", !Number.isFinite(ratio) ? "广度数据暂缺。" : ratio >= 70 ? "市场呈现普涨，赚钱效应具备扩散基础。" : ratio >= 50 ? "上涨家数占优，但仍需结合涨停溢价判断强度。" : ratio >= 30 ? "下跌家数占优，当前更接近结构行情。" : "市场广度明显偏弱，指数表现可能掩盖个股风险。");
  setText("#limit-up", formatNumber(data.extremes.limitUp));
  setText("#limit-down", formatNumber(data.extremes.limitDown));
  setText("#big-up", formatNumber(data.extremes.bigUp));
  setText("#big-down", formatNumber(data.extremes.bigDown));
  const bigUp = Number(data.extremes.bigUp);
  const bigDown = Number(data.extremes.bigDown);
  const balance = Number.isFinite(bigUp + bigDown) && bigUp + bigDown ? bigUp / (bigUp + bigDown) * 100 : 50;
  $("#tail-balance i").style.left = `${balance}%`;
  setText("#tail-balance span", balance >= 55 ? "大涨尾部占优，弹性方向反馈较好" : balance <= 45 ? "大跌尾部占优，亏钱效应更强" : "大涨与大跌尾部接近平衡");
}

function renderThemes() {
  const themes = data.themes || [];
  if (!themes.length) {
    $("#theme-list").innerHTML = '<div class="empty">Wind 暂未返回A股概念排名。</div>';
    return;
  }
  const max = Math.max(...themes.map((item) => Math.abs(Number(item.changePct))), 1);
  $("#theme-list").innerHTML = themes.map((item, index) => `<div class="theme-row"><span class="theme-rank">${String(index + 1).padStart(2, "0")}</span><span class="theme-name"><b>${escapeHtml(item.name)}</b><small>${escapeHtml(item.code)}</small></span><span class="theme-bar"><i style="width:${Math.max(4, Math.abs(item.changePct) / max * 100)}%"></i></span><span class="theme-change">${formatPct(item.changePct)}</span></div>`).join("");
}

function renderAnomalies() {
  const summary = anomalyData?.summary || {};
  const sourceItems = anomalyData?.items || [];
  const filterLabels = { all: "全部异动", limit: "涨停点火", batch: "批量拉升", news: "消息催化" };
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
  $("#anomaly-summary").innerHTML = `<span>有效题材 ${summary.total || 0}</span><span>涨停样本 ${anomalyData?.limitData?.stockCount || 0}</span>${streakSummary}<span>已合并 ${Math.max(0, (summary.rawTotal || 0) - (summary.mergedTotal || 0))}</span><span>过滤低分 ${summary.filteredOut || 0}</span><span>门槛 ≥ ${summary.minScore || 60}</span>`;
  const sorters = {
    all: (a, b) => (b.tabScores?.all ?? b.score) - (a.tabScores?.all ?? a.score) || (b.scoreBreakdown?.ladderTotalBonus || 0) - (a.scoreBreakdown?.ladderTotalBonus || 0) || (b.sortMetrics?.limitCount || 0) - (a.sortMetrics?.limitCount || 0),
    limit: (a, b) => (b.sortMetrics?.limitCount || b.limitStocks?.length || 0) - (a.sortMetrics?.limitCount || a.limitStocks?.length || 0) || (b.tabScores?.limit ?? b.score) - (a.tabScores?.limit ?? a.score),
    batch: (a, b) => (b.sortMetrics?.fiveMinuteChange || b.shortMove || 0) - (a.sortMetrics?.fiveMinuteChange || a.shortMove || 0) || (b.tabScores?.batch ?? b.score) - (a.tabScores?.batch ?? a.score),
    news: (a, b) => (b.sortMetrics?.newsMomentum || 0) - (a.sortMetrics?.newsMomentum || 0) || (b.tabScores?.news ?? b.score) - (a.tabScores?.news ?? a.score)
  };
  const sortLabels = { all: "综合分降序", limit: "涨停家数降序", batch: "5分钟涨跌幅降序", news: "涨跌幅与涨速综合降序" };
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
    const batchChip = (anomalyFilter === "all" || anomalyFilter === "batch") && Number.isFinite(Number(item.shortMove)) ? `<span class="anomaly-chip batch">5分钟 ${formatPct(item.shortMove)}</span>` : "";
    const limitChip = (anomalyFilter === "all" || anomalyFilter === "limit") && item.limitStocks?.length ? `<span class="anomaly-chip limit">${item.limitStocks.length}只点火股</span>` : "";
    const highBoardChip = (anomalyFilter === "all" || anomalyFilter === "limit") && item.ladder?.maxStreak >= 3 ? `<span class="anomaly-chip ladder">最高${item.ladder.maxStreak}板 +${item.ladder.highBoardBonus}</span>` : "";
    const fullLadderChip = (anomalyFilter === "all" || anomalyFilter === "limit") && item.ladder?.contiguousDepth >= 3 ? `<span class="anomaly-chip ladder">完整1-${item.ladder.contiguousDepth}板 +${item.ladder.ladderBonus}</span>` : "";
    return `<article class="anomaly-card filter-${anomalyFilter}${index < 3 ? " primary" : ""}"><div class="anomaly-card-head"><div><b>${escapeHtml(item.name)}</b><small>${escapeHtml(item.code || "Wind概念映射")}</small><em class="anomaly-rank-metric">${rankingMetric}</em></div><span class="anomaly-score">${activeScore}</span></div><span class="anomaly-status">${escapeHtml(displayStatus)}</span><div class="anomaly-evidence">${chips}${batchChip}${limitChip}${highBoardChip}${fullLadderChip}</div><p class="anomaly-detail" title="${escapeHtml(detail)}">${escapeHtml(detail)}</p>${newsCards}<div class="stock-layers"><section class="role-section ignition"><h4>点火个股 <small>率先封板</small></h4>${stockItems(item.limitStocks || [], "ignition")}</section><section class="role-section follower"><h4>跟风个股 <small>同步走强未封板</small></h4>${stockItems(item.followers || [], "follower")}</section><section class="role-section ride"><h4>候选上车 <small>需等待触发</small></h4>${stockItems(item.rideable || [], "ride")}</section></div></article>`;
  }).join("");
}

async function loadAnomalies(force = false) {
  $("#anomaly-list").innerHTML = '<div class="loading">正在读取分钟异动、涨停映射和新闻催化…</div>';
  anomalyData = await api(`/api/anomalies${force ? "?refresh=1" : ""}`);
  renderAnomalies();
}

function renderDailyTimeline() {
  const allDaily = (data.dailyHistory || []).filter((item) => String(item.tradingDate || "").length === 8 && Number.isFinite(Number(item.score)))
    .sort((a, b) => String(a.tradingDate).localeCompare(String(b.tradingDate)));
  const history = allDaily.slice(-20);
  setText("#history-count", `${allDaily.length} \u4e2a\u4ea4\u6613\u65e5 \u00b7 \u663e\u793a\u6700\u8fd1${history.length}\u65e5\u5747\u503c`);
  if (history.length < 2) {
    $("#timeline-chart").innerHTML = `<div class="empty">\u5df2\u6c89\u6dc0${history.length}\u4e2a\u65e5\u7ebf\u70b9\uff1b\u6bcf\u65e5\u6309\u5f53\u5929 n \u4e2a\u76d8\u4e2d\u5feb\u7167\u7b49\u6743\u5e73\u5747\uff0c\u540e\u7eed\u81ea\u52a8\u7d2f\u8ba1\u3002</div>`;
    return;
  }
  const width = 1000;
  const height = 200;
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
  $("#timeline-chart").innerHTML = `<svg viewBox="0 0 ${width} ${height}" preserveAspectRatio="none"><defs><linearGradient id="areaGradientDaily" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#c8f16a" stop-opacity=".48"/><stop offset="1" stop-color="#c8f16a" stop-opacity=".04"/></linearGradient></defs>${grid}${axis}<polygon class="timeline-area daily" points="${area}"/><polyline class="timeline-line" points="${line}"/>${dots}</svg>`;
}

function renderTimeline() {
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
  const history = (data.history || []).map(parseSnapshot).filter(Boolean)
    .filter((item) => item.snapshotDate === tradingDate)
    .filter((item) => (item.minute >= 565 && item.minute <= 690) || (item.minute >= 780 && item.minute <= 900))
    .filter((item) => tradingDate !== today || item.minute <= nowMinute)
    .sort((a, b) => a.minute - b.minute).slice(-60);
  const latestLabel = history.at(-1)?.timeLabel;
  setText("#history-count", `${history.length} 个当日快照${latestLabel ? ` · 截至 ${latestLabel}` : ""}`);
  if (history.length < 2) {
    $("#timeline-chart").innerHTML = '<div class="empty">已写入首个快照；至少两次刷新后形成盘中曲线。</div>';
    return;
  }
  const width = 1000;
  const height = 200;
  const pad = 25;
  const tradingProgress = (minute) => minute <= 690 ? minute - 565 : 125 + minute - 780;
  const totalTradingMinutes = 245;
  const xAt = (minute) => pad + tradingProgress(minute) / totalTradingMinutes * (width - pad * 2);
  const points = history.map((item) => ({ x: xAt(item.minute), y: height - pad - Number(item.score) / 100 * (height - pad * 2), ...item }));
  const line = points.map((point) => `${point.x},${point.y}`).join(" ");
  const area = `${points[0].x},${height - pad} ${line} ${points.at(-1).x},${height - pad}`;
  const grid = [25, 50, 75].map((score) => { const y = height - pad - score / 100 * (height - pad * 2); return `<line class="timeline-grid" x1="${pad}" y1="${y}" x2="${width - pad}" y2="${y}"/><text class="timeline-label" x="0" y="${y + 3}">${score}</text>`; }).join("");
  const dots = points.map((point, index) => `<circle class="timeline-dot" cx="${point.x}" cy="${point.y}" r="${index === points.length - 1 ? 5 : 3}"><title>${escapeHtml(point.phase)} · ${point.score} · ${escapeHtml(point.timeLabel)}</title></circle>`).join("");
  const slots = [{ minute: 565, label: "09:25" }, { minute: 600, label: "10:00" }, { minute: 690, label: "11:30" }, { minute: 810, label: "13:30" }, { minute: 870, label: "14:30" }, { minute: 900, label: "15:00" }];
  const axis = slots.map((slot, index) => { const x = xAt(slot.minute); const anchor = index === 0 ? "start" : index === slots.length - 1 ? "end" : "middle"; return `<line class="timeline-grid timeline-time-grid" x1="${x}" y1="${pad}" x2="${x}" y2="${height - pad}"/><text class="timeline-label timeline-time-label" text-anchor="${anchor}" x="${x}" y="${height - 5}">${slot.label}</text>`; }).join("");
  $("#timeline-chart").innerHTML = `<svg viewBox="0 0 ${width} ${height}" preserveAspectRatio="none"><defs><linearGradient id="areaGradient" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#c8f16a" stop-opacity=".48"/><stop offset="1" stop-color="#c8f16a" stop-opacity=".04"/></linearGradient></defs>${grid}${axis}<polygon class="timeline-area" points="${area}"/><polyline class="timeline-line" points="${line}"/>${dots}</svg>`;
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
  button.disabled = true;
  button.textContent = "读取中…";
  reportToolbarState({ refreshing: true });
  try {
    data = await api(`/api/emotion${force ? "?refresh=1" : ""}`);
    const historyPayload = await api("/api/history").catch(() => null);
    if (historyPayload) {
      data.history = historyPayload.history || data.history || [];
      data.dailyHistory = historyPayload.dailyHistory || data.dailyHistory || [];
    }
    renderAll();
    await loadAnomalies(force);
    toast(force ? "Wind 情绪数据已刷新" : "情绪工作台加载完成");
  } catch (error) {
    $("#connection-dot").className = "bad";
    setText("#connection", "Wind 数据连接异常");
    reportToolbarState({ connection: "Wind 数据连接异常", error: true });
    toast(error.message, true);
  } finally {
    button.disabled = false;
    button.textContent = "刷新数据";
    reportToolbarState({ refreshing: false });
  }
}

async function loadNews() {
  const button = $("#load-news");
  button.disabled = true;
  button.textContent = "加载中…";
  $("#news-list").innerHTML = '<div class="loading">正在检索 Wind 财经新闻…</div>';
  try {
    const payload = await api("/api/news");
    const items = payload.items || [];
    $("#news-list").innerHTML = items.length ? items.slice(0, 5).map((item) => `<article class="news-item"><b>${escapeHtml(item.title || "Wind 市场信息")}</b><span>${escapeHtml(item.date || "")} · 相关度 ${Number(item.relevance || 0).toFixed(2)}</span><p>${escapeHtml(String(item.content || "").slice(0, 170))}${String(item.content || "").length > 170 ? "…" : ""}</p></article>`).join("") : '<div class="empty">未检索到相关催化。</div>';
  } catch (error) {
    $("#news-list").innerHTML = `<div class="empty">${escapeHtml(error.message)}</div>`;
    toast(error.message, true);
  } finally {
    button.disabled = false;
    button.textContent = "刷新 Wind 新闻";
  }
}

async function exportEmotionImage() {
  const button = $("#export-image");
  const main = document.querySelector("main");
  if (!main || !data) return toast("当前没有可导出的短线情绪数据", true);
  const originalText = button.textContent;
  button.disabled = true;
  button.textContent = "正在生成完整长图…";
  reportToolbarState({ exporting: true });
  try {
    const clone = main.cloneNode(true);
    const activeFilter = clone.querySelector(".anomaly-filter.active");
    if (activeFilter) {
      const marker = document.createElement("span");
      marker.className = "export-filter-marker";
      marker.textContent = `当前视图：${activeFilter.textContent}`;
      activeFilter.closest(".anomaly-toolbar")?.prepend(marker);
    }
    clone.querySelectorAll("button").forEach((node) => node.remove());
    clone.querySelectorAll(".news-list").forEach((node) => { node.style.maxHeight = "none"; node.style.overflow = "visible"; });
    const response = await fetch("/api/export-image", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ width: 1440, html: clone.outerHTML })
    });
    if (!response.ok) {
      const payload = await response.json().catch(() => ({}));
      throw new Error(payload.error || `图片服务返回 ${response.status}`);
    }
    const png = await response.blob();
    const link = document.createElement("a");
    const day = new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date()).replaceAll("/", "-");
    link.href = URL.createObjectURL(png);
    link.download = `AI短线情绪-${day}.png`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 2000);
    toast("AI短线情绪完整长图已导出");
  } catch (error) {
    toast(`导出图片失败：${error instanceof Error ? error.message : String(error)}`, true);
  } finally {
    button.disabled = false;
    button.textContent = originalText;
    reportToolbarState({ exporting: false });
  }
}

window.addEventListener("message", (event) => {
  if (!isEmbedded || !["http://127.0.0.1:4310", "http://localhost:4310"].includes(event.origin)) return;
  if (event.data?.type !== "emotion-workbench-command") return;
  if (event.data.command === "refresh") loadEmotion(true);
  if (event.data.command === "export-image") exportEmotionImage();
});

function bindEvents() {
  $("#refresh").addEventListener("click", () => loadEmotion(true));
  $("#export-image").addEventListener("click", exportEmotionImage);
  $("#load-news").addEventListener("click", loadNews);
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
  $$(".nav-item").forEach((button) => button.addEventListener("click", () => {
    $$(".nav-item").forEach((item) => item.classList.toggle("active", item === button));
    document.getElementById(button.dataset.target)?.scrollIntoView({ behavior: "smooth", block: "start" });
  }));
}

bindEvents();
loadEmotion();
