// 涨停事件工作台 — 页面脚本
// 数据来自 /api/short-emotion?market=cn&resource=limitup（只读快照，页面不调用 Wind）。
const API_BASE = "/api/short-emotion";
const $ = (selector) => document.querySelector(selector);
const setText = (selector, value) => { const element = $(selector); if (element) element.textContent = value ?? "—"; };

let toastTimer = 0;
function toast(message, error = false) {
  const element = $("#toast");
  element.textContent = message;
  element.className = `toast show${error ? " error" : ""}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { element.className = "toast"; }, 3200);
}

let readFresh = false;
async function api(resource, { fresh = readFresh } = {}) {
  const extra = fresh ? `&fresh=1&t=${Date.now()}` : "";
  const response = await fetch(`${API_BASE}?market=cn&resource=${encodeURIComponent(resource)}${extra}`, {
    headers: { Accept: "application/json" },
    cache: fresh ? "no-store" : "default"
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw Object.assign(new Error(payload.error || `请求失败 (${response.status})`), { code: payload.code });
  return payload;
}

const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]));
const pct = (value, digits = 1) => (value == null || !Number.isFinite(Number(value)) ? "—" : `${(Number(value) * 100).toFixed(digits)}%`);
const signed = (value, digits = 0) => (value == null || !Number.isFinite(Number(value)) ? null : `${Number(value) > 0 ? "+" : ""}${Number(value).toFixed(digits)}`);

function shanghaiTimeLabel(value) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(date);
}

// 封板时间 → 距 09:30 的分钟数，用于天梯内排序（集合竞价视为最早）
function sealRank(clock) {
  if (!clock) return 9999;
  const [hour, minute, second] = clock.split(":").map(Number);
  return hour * 3600 + minute * 60 + second;
}

const stockIndex = new Map();
let lastData = null;
function stocksOf(codes) {
  return (codes || []).map((code) => stockIndex.get(code)).filter(Boolean);
}

function renderHeader(data) {
  const dot = $("#connection-dot");
  const degraded = Boolean(data.degraded);
  dot.className = `status-dot${degraded ? "" : " ok"}`;
  setText("#connection", degraded ? "快照降级：未取到涨停列表" : "涨停事件快照");
  const quote = data.quoteTime ? String(data.quoteTime).replace(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}:\d{2}).*$/, "$2-$3 $4") : null;
  const stored = shanghaiTimeLabel(data.storedAt);
  setText("#quote-time", [quote ? `行情时间 ${quote}` : "未返回行情时间", stored ? `快照 ${stored}` : null].filter(Boolean).join(" · "));
}

// 环比箭头沿用红涨绿跌：上升红、下降绿、持平灰
function arrowOf(previousValue, value) {
  if (!Number.isFinite(previousValue) || !Number.isFinite(value)) return "";
  const delta = value - previousValue;
  if (delta === 0) return '<em class="lu-arrow flat">→</em>';
  return `<em class="lu-arrow ${delta > 0 ? "up" : "down"}">${delta > 0 ? "↑" : "↓"}</em>`;
}

function renderSummary(data) {
  const summary = data.summary || {};
  const previous = data.previous || null;

  setText("#m-limitup", summary.limitUpCount ?? "—");
  if (previous && Number.isFinite(previous.limitUpCount) && Number.isFinite(summary.limitUpCount)) {
    const delta = summary.limitUpCount - previous.limitUpCount;
    const note = $("#m-limitup-note");
    note.textContent = `较上日 ${signed(delta)} 家（${previous.limitUpCount} → ${summary.limitUpCount}）`;
    note.className = `lu-delta ${delta > 0 ? "up" : delta < 0 ? "down" : ""}`;
  } else {
    setText("#m-limitup-note", "今日涨停");
  }

  // 最高板：加环比箭头，板高下移意味着空间收缩
  const maxStreak = summary.maxStreak || 0;
  const previousStreak = previous?.maxStreak;
  $("#m-maxstreak").innerHTML = maxStreak ? `${streakText(maxStreak)}${arrowOf(previousStreak, maxStreak)}` : "—";
  const depthNote = `梯队深度 ${summary.ladderDepth ?? 0} 档`;
  setText("#m-maxstreak-note", Number.isFinite(previousStreak) && maxStreak
    ? `${depthNote} · 上日 ${streakText(previousStreak)}`
    : depthNote);

  // 早盘封板：历史日取不到封板时间，环比只能从日快照沉淀后才成立
  const firstSeal = summary.firstSealCount;
  const previousFirstSeal = previous?.firstSealCount;
  $("#m-firstseal").innerHTML = Number.isFinite(firstSeal)
    ? `${firstSeal}${arrowOf(previousFirstSeal, firstSeal)}`
    : "—";
  if (Number.isFinite(previousFirstSeal) && Number.isFinite(firstSeal)) {
    setText("#m-firstseal-note", `较上日 ${signed(firstSeal - previousFirstSeal)} 家（${previousFirstSeal} → ${firstSeal}）`);
  } else {
    setText("#m-firstseal-note", "环比待累积 · 历史日无封板时间");
  }

  setText("#m-promotion", pct(summary.promotionRate));
  setText("#m-promotion-note", summary.yesterdayLimitUpCount
    ? `基准 ${previous?.tradingDate || data.promotion?.baseTradingDate || "上一交易日"} 涨停 ${summary.yesterdayLimitUpCount} 家`
    : "基准数据缺失");

  // 跌停家数：上升代表恐慌扩散，用绿跌色提示；环比方向沿用红涨绿跌
  const limitDown = summary.limitDownCount;
  const previousDown = summary.previousLimitDownCount;
  setText("#m-limitdown", Number.isFinite(limitDown) ? limitDown : "—");
  const downNote = $("#m-limitdown-note");
  downNote.title = "跌停家数与上日均为 Wind 结构化事件表口径（剔除 ST）；历史日受口径影响可能存在偏差";
  if (Number.isFinite(previousDown) && Number.isFinite(limitDown)) {
    const delta = limitDown - previousDown;
    downNote.textContent = `较上日 ${signed(delta)} 家（${previousDown} → ${limitDown}）`;
    downNote.className = `lu-delta ${delta > 0 ? "down" : delta < 0 ? "up" : ""}`;
  } else {
    downNote.textContent = `已剔除 ST ${summary.limitDownStCount ?? 0} 家`;
    downNote.className = "lu-delta";
  }

  // 涨跌停差：正数偏强、负数偏弱，直接把「情绪温度」量化成一家数差
  const net = summary.upDownNet;
  const netElement = $("#m-netlimit");
  netElement.textContent = Number.isFinite(net) ? signed(net) : "—";
  netElement.className = Number.isFinite(net) ? (net > 0 ? "up" : net < 0 ? "down" : "") : "";
  setText("#m-netlimit-note", `涨停 ${summary.limitUpCount ?? 0} - 跌停 ${limitDown ?? 0}`);
}

// 今日亮点：把「主线 / 负反馈 / 冰点 / 高位断板」压成几句话，页面先给结论
function renderHighlights(data) {
  const highlights = Array.isArray(data.highlights) ? data.highlights : [];
  setText("#highlight-pill", highlights.length ? `${highlights.length} 条结论` : "无信号");
  const container = $("#highlights");
  if (!highlights.length) {
    container.innerHTML = '<div class="lu-empty">今日暂无明显强弱信号。</div>';
    return;
  }
  container.innerHTML = highlights.map((item) => `<div class="lu-highlight ${esc(item.tone || "")}">
    <b>${esc(item.title || "")}</b><span>${esc(item.detail || "")}</span>
  </div>`).join("");
}

// 题材强弱已并进概念聚合行内；这里只保留页面顶部的结论卡片

// 跌停股：题材聚合 + 个股标签（时间=首次跌停时间）
function renderLimitDown(data) {
  const limitDown = data.limitDown || {};
  const stocks = Array.isArray(limitDown.stocks) ? limitDown.stocks : [];
  const concepts = Array.isArray(limitDown.concepts) ? limitDown.concepts : [];
  setText("#limitdown-pill", stocks.length
    ? `${stocks.length} 家${limitDown.stCount ? ` · 另有 ST ${limitDown.stCount} 家` : ""}`
    : "无跌停");
  const container = $("#limitdown");
  if (!stocks.length) {
    container.innerHTML = `<div class="lu-empty">今日无跌停（已剔除 ST）${limitDown.complete === false ? "；跌停数据可能不完整" : ""}。</div>`;
    return;
  }
  const conceptLine = concepts.length
    ? `<div class="lu-down-concepts">跌停题材：${concepts.slice(0, 8).map((concept) => `<b>${esc(concept.name)}</b> ${concept.count}`).join(" · ")}</div>`
    : "";
  container.innerHTML = `${conceptLine}<div class="lu-down-list">${stocks.map((stock) => {
    const concept = stock.concepts?.length ? `<i class="lu-stock-tag">${esc(stock.concepts[0])}</i>` : "";
    return `<span class="lu-down-stock"><b>${esc(stock.name)}</b>${concept}<em>${esc(shortClock(stock.downTime))}</em></span>`;
  }).join("")}</div>`;
}

// 首板常年占七成，全列会把高位板挤走，因此只展开前 12 只
const LADDER_COLLAPSE = 12;
const expandedTiers = new Set();
const shortClock = (clock) => (clock ? String(clock).slice(0, 5) : "--");
// 板高文案：1 板一律叫「首板」（与后端 limitStreakLabel 口径一致），2 板以上才写成「N板」，
// 免得页面上到处出现「1板」这种短线圈里没人这么说的写法。
const streakText = (streak) => (Number(streak) >= 2 ? `${Number(streak)}板` : "首板");

function renderLadder(data) {
  const ladder = Array.isArray(data.ladder) ? data.ladder : [];
  const summary = data.summary || {};
  setText("#ladder-pill", ladder.length
    ? `${streakText(summary.maxStreak)} · 深度 ${summary.ladderDepth || 0}/${ladder.length}`
    : "无数据");

  // 断板带：昨日最高板今日未晋级，比"今天最高几板"更早反映退潮
  const broken = data.brokenStreaks;
  const brokenBox = $("#broken");
  if (broken && broken.brokenCount > 0) {
    const drop = (summary.maxStreak || 0) - broken.streak;
    const items = broken.broken.map((item) => {
      // 兼容旧快照：早期版本只存了代码字符串
      const code = typeof item === "string" ? item : item.code;
      const name = typeof item === "string" ? null : item.name;
      const concept = typeof item === "string" ? null : item.concept;
      const tag = concept ? `<i class="lu-stock-tag">${esc(concept)}</i>` : "";
      return `<span class="lu-broken-item" title="${esc(code)}"><b>${esc(name || code)}</b>${tag}${name ? `<em>${esc(code)}</em>` : ""}</span>`;
    }).join("");
    brokenBox.innerHTML = `<div class="lu-broken">
      <div class="lu-broken-head">⚠ 断板 <b>${streakText(broken.streak)}</b> ${broken.brokenCount}/${broken.totalCount} 家未晋级，高度${drop < 0 ? "回落" : "止步"}于 ${streakText(summary.maxStreak)}</div>
      <div class="lu-broken-list">${items}</div>
    </div>`;
  } else {
    brokenBox.innerHTML = "";
  }

  const container = $("#ladder");
  if (!ladder.length) {
    container.innerHTML = '<div class="lu-empty">今日暂无涨停天梯数据。</div>';
    return;
  }

  // 板高降序；同档内封板越早越靠前，也就是"谁先卡住身位"
  const ordered = [...ladder].sort((a, b) => b.streak - a.streak);
  const topCount = Math.max(...ordered.map((tier) => tier.count), 1);
  const topStreak = ordered[0]?.streak || 1;

  container.innerHTML = ordered.map((tier) => {
    const stocks = stocksOf(tier.stocks).sort((a, b) => sealRank(a.sealTime) - sealRank(b.sealTime));
    const collapsible = tier.streak === 1 && stocks.length > LADDER_COLLAPSE;
    const expanded = expandedTiers.has(tier.streak);
    const visible = collapsible && !expanded ? stocks.slice(0, LADDER_COLLAPSE) : stocks;
    const tags = visible.length
      ? visible.map((stock) => {
        const isLead = tier.streak === topStreak && stock.code === stocks[0]?.code;
        const concept = stock.primaryConcept
          ? `<i class="lu-stock-tag">${esc(stock.primaryConcept)}</i>`
          : "";
        return `<span class="lu-stock${isLead ? " is-lead" : ""}${stock.isST ? " is-st" : ""}"><b>${esc(stock.name)}</b>${concept}<em>${esc(shortClock(stock.sealTime))}</em></span>`;
      }).join("")
      : '<span class="lu-tier-empty">空缺（该板高无个股）</span>';
    const more = collapsible && !expanded
      ? `<button class="lu-more" type="button" data-tier="${tier.streak}">展开其余 ${stocks.length - LADDER_COLLAPSE} 只 ▾</button>`
      : "";
    const width = Math.max(2, Math.round(tier.count / topCount * 100));
    return `<div class="lu-tier">
      <div class="lu-tier-label"><b>${streakText(tier.streak)}</b></div>
      <div class="lu-tier-body">
        <div class="lu-tier-meta">
          <div class="lu-tier-bar"><i style="width:${width}%"></i></div>
          <div class="lu-tier-count">${tier.count}<small>家</small></div>
        </div>
        <div class="lu-tier-stocks">${tags}</div>
        ${more}
      </div>
    </div>`;
  }).join("");

  container.querySelectorAll(".lu-more").forEach((node) => {
    node.addEventListener("click", () => {
      expandedTiers.add(Number(node.dataset.tier));
      renderLadder(lastData || data);
    });
  });
}

function renderPromotion(data) {
  const promotion = data.promotion || {};
  const tiers = Array.isArray(promotion.tiers) ? promotion.tiers : [];
  setText("#promo-pill", promotion.baseTradingDate ? `基准 ${promotion.baseTradingDate}` : "无基准");
  $("#promo-overall").innerHTML = `<strong>${pct(promotion.overallRate)}</strong><span>${promotion.baseLimitUpCount
    ? `${promotion.promoted?.length ?? 0} / ${promotion.baseLimitUpCount} 家昨日涨停今日继续封板`
    : "缺少上一交易日涨停名单，无法计算"}</span>`;

  // 晋级成功的个股落在哪些题材上：只看比率不够，要知道"分子"的质量
  const themes = Array.isArray(promotion.themeBreakdown) ? promotion.themeBreakdown : [];
  $("#promo-themes").innerHTML = themes.length ? `
    <div class="lu-promo-themes-title">晋级个股题材归类 · 共 ${promotion.promoted?.length ?? 0} 只接力</div>
    <div class="lu-promo-themes-list">${themes.map((theme) => `<span class="lu-promo-theme">${theme.whitelist
      ? '<span class="lu-star">★</span>'
      : ""}<b>${esc(theme.name)}</b><em>${theme.limitCount} 只</em></span>`).join("")}</div>
  ` : "";

  if (!tiers.length) {
    $("#promo-list").innerHTML = '<div class="lu-empty">暂无可分层计算的晋级数据。</div>';
    setText("#promo-note", "晋级率需要上一交易日的涨停名单；首个交易日沉淀后自动生效。");
    return;
  }
  // 低位板在上，符合"从首板往上打"的阅读顺序
  const ordered = [...tiers].sort((a, b) => b.from - a.from);
  $("#promo-list").innerHTML = ordered.map((tier) => {
    const width = Math.max(1, Math.round((tier.rate ?? 0) * 100));
    return `<div class="lu-promo-row">
      <div class="lu-promo-tier">${tier.from}进${tier.to}</div>
      <div class="lu-promo-track"><i style="width:${width}%"></i></div>
      <div class="lu-promo-rate">${pct(tier.rate)} <em>${tier.promotedCount}/${tier.baseCount}</em></div>
    </div>`;
  }).join("");
  setText("#promo-note", "昨日各板高今日继续涨停的比例；高位板样本少，比率波动大，需结合家数看。");
}

function renderConcepts(data) {
  const concepts = Array.isArray(data.concepts) ? data.concepts : [];
  const leaders = concepts.filter((concept) => concept.hasLeader).length;
  // 负反馈题材往往只有 1 家涨停（已被「1 家涨停不算题材」过滤掉），
  // 因此名字从 themeStrength 取，避免标签显示 0 与顶部亮点自相矛盾
  const feedbackThemes = (Array.isArray(data.themeStrength) ? data.themeStrength : [])
    .filter((theme) => theme.negativeFeedback).map((theme) => theme.name);
  const feedback = feedbackThemes.length
    || (Number.isFinite(data.summary?.negativeFeedbackThemes) ? data.summary.negativeFeedbackThemes : 0)
    || concepts.filter((concept) => concept.negativeFeedback).length;
  const feedbackLabel = feedbackThemes.length
    ? ` · ⚠ ${feedbackThemes.slice(0, 2).join("/")}${feedbackThemes.length > 2 ? " 等" : ""}`
    : feedback ? ` · ${feedback} 个负反馈` : "";
  setText("#concept-pill", concepts.length
    ? `${concepts.length} 个题材 · ${leaders} 个有梯队${feedbackLabel}`
    : "无数据");
  const container = $("#concepts");
  if (!concepts.length) {
    container.innerHTML = '<div class="lu-empty">今日涨停个股未匹配到有效题材概念。</div>';
    return;
  }
  const previousCounts = new Map((data.previous?.concepts || []).map((concept) => [concept.name, concept.limitCount]));
  container.innerHTML = concepts.map((concept) => {
    // 展开时按板高降序、同板高按封板时间，先看龙头再看跟风
    const stocks = stocksOf(concept.stocks).sort((a, b) => (b.streak || 1) - (a.streak || 1) || sealRank(a.sealTime) - sealRank(b.sealTime));
    const delta = previousCounts.has(concept.name) ? (concept.limitCount || 0) - previousCounts.get(concept.name) : null;
    // 板高微条：一只股票一个方块，越深板越高，首板灰显 → 一眼区分"有梯队"和"全跟风"
    const distribution = concept.streakDistribution || {};
    const micro = Object.keys(distribution).map(Number).sort((a, b) => b - a).flatMap((streak) => {
      const opacity = Math.min(1, 0.32 + Math.min(streak - 1, 4) * 0.17).toFixed(2);
      return Array.from({ length: distribution[streak] }, () => (streak === 1
        ? '<i class="is-flat"></i>'
        : `<i style="opacity:${opacity}"></i>`));
    }).join("");
    const tags = stocks.length
      ? stocks.map((stock) => `<span class="lu-stock${stock.isST ? " is-st" : ""}"><b>${esc(stock.name)}</b><em>${streakText(stock.streak)} ${esc(shortClock(stock.sealTime))}</em></span>`).join("")
      : '<span class="lu-tier-empty">—</span>';
    // 强弱状态与跌停、断板家数：概念聚合不再只讲涨停，弱方向也要能一眼看到
    const status = concept.status
      ? `<span class="lu-status ${esc(concept.tone || "")}">${esc(concept.status)}</span>`
      : "";
    const meta = [
      concept.downOnly ? "无涨停" : ((concept.maxStreak || 1) === 1 ? "首板" : `最高 ${concept.maxStreak} 板`),
      concept.downOnly ? null : `首封 ${esc(shortClock(concept.firstSealTime))}`,
      concept.downCount ? `<span class="is-down">跌停 ${concept.downCount}</span>` : null,
      concept.brokenCount ? `<span class="is-broken">断板/未晋级 ${concept.brokenCount}</span>` : null,
      delta != null ? `较上日 ${signed(delta)}` : null
    ].filter(Boolean).join(" · ");
    // 右侧主数字：有涨停就报涨停家数；没有涨停的弱方向改报跌停/断板，避免出现「0 涨停」
    const countCell = concept.limitCount
      ? `${concept.limitCount}<small>涨停</small>`
      : concept.downCount
        ? `${concept.downCount}<small class="is-down">跌停</small>`
        : `${concept.brokenCount}<small class="is-broken">断板</small>`;
    return `<button class="lu-concept" type="button" aria-expanded="false">
      <div>
        <div class="lu-concept-name">${concept.negativeFeedback ? '<span class="lu-star">⚠</span>' : concept.whitelist ? '<span class="lu-star">★</span>' : ""}<b>${esc(concept.name)}</b>${status}</div>
        <div class="lu-micro">${micro}</div>
        <div class="lu-concept-meta">${meta}</div>
      </div>
      <div class="lu-concept-count">${countCell}</div>
      <div class="lu-concept-stocks">${tags}</div>
    </button>`;
  }).join("");

  container.querySelectorAll(".lu-concept").forEach((node) => {
    node.addEventListener("click", () => {
      const open = node.classList.toggle("open");
      node.setAttribute("aria-expanded", String(open));
    });
  });
}

function renderQuality(data) {
  const quality = data.dataQuality || {};
  const messages = [];
  if (quality.truncated) messages.push(`${(quality.cappedSectors || []).join("/")}触顶 Wind 100 行上限，该板块家数可能不全。`);
  if (quality.historyComplete === false) messages.push("上一交易日涨停名单不完整，晋级率可能偏差。");
  const errors = (data.errors || []).filter(Boolean);
  if (errors.length) messages.push(...errors);
  $("#quality").innerHTML = messages.length ? `<div class="lu-warn">${messages.map(esc).join("<br>")}</div>` : "";
}

function render(data) {
  lastData = data;
  stockIndex.clear();
  (data.stocks || []).forEach((stock) => stockIndex.set(stock.code, stock));
  renderHeader(data);
  renderSummary(data);
  renderHighlights(data);
  renderLadder(data);
  renderLimitDown(data);
  renderPromotion(data);
  renderConcepts(data);
  renderQuality(data);
}

let refreshing = false;
async function refresh() {
  if (refreshing) return;
  refreshing = true;
  const button = $("#refresh");
  button.disabled = true;
  button.textContent = "刷新中";
  try {
    const started = await fetch(`${API_BASE}?market=cn&action=refresh`, { method: "POST", headers: { Accept: "application/json" } });
    const payload = await started.json().catch(() => ({}));
    if (!started.ok) throw new Error(payload.error || `触发失败 (${started.status})`);
    if (payload.mode === "local") {
      // 本地模式：POST 已同步跑完取数，直接读新快照
      const errors = payload.errors || [];
      if (!payload.ok) toast(`刷新失败：${errors[0] || "Wind 未返回数据"}`, true);
      else toast(errors.length ? `已更新，但有 ${errors.length} 条告警` : "已更新涨停事件快照");
      const note = (payload.skipped || []).find((item) => item.includes("limitup"));
      if (note) toast(note, true);
    } else {
      toast("已触发后台任务，稍后自动更新");
      await new Promise((resolve) => setTimeout(resolve, 8000));
    }
    readFresh = true;
    render(await api("limitup", { fresh: true }));
  } catch (error) {
    toast(error.message || "刷新失败", true);
  } finally {
    readFresh = false;
    refreshing = false;
    button.disabled = false;
    button.textContent = "刷新";
  }
}

$("#refresh").addEventListener("click", refresh);

(async function boot() {
  try {
    render(await api("limitup"));
  } catch (error) {
    const notReady = error.code === "not_ready";
    toast(error.message || "读取失败", true);
    $("#connection-dot").className = "status-dot";
    setText("#connection", notReady ? "暂无快照" : "读取失败");
    setText("#quote-time", notReady ? "请先运行 scripts/limitup/build.mjs 生成快照" : (error.message || ""));
    ["#ladder", "#concepts", "#promo-themes", "#highlights", "#limitdown"].forEach((selector) => { $(selector).innerHTML = '<div class="lu-empty">暂无数据</div>'; });
  }
})();
