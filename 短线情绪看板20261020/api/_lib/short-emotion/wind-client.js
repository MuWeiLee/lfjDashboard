// Wind AI Fin Market MCP client for Vercel functions (短线情绪工作台).
//
// Ported from wind-mcp-skill/scripts/cli.mjs (v1.7.0). The original workbench
// spawned `node cli.mjs call ...` as a child process for every request; here the
// same JSON-RPC-over-HTTPS exchange (initialize + tools/call, multi-key quota
// failover, route/param validation, SSE parsing) runs in-process with fetch.

const SKILL_VERSION = "1.7.0";
const CLIENT_NAME = "shortemotion";

const SERVERS = {
  stock_data: "https://mcp.wind.com.cn/vserver_stock_data/mcp/",
  global_stock_data: "https://mcp.wind.com.cn/vserver_global_stock_data/mcp/",
  fund_data: "https://mcp.wind.com.cn/vserver_fund_data/mcp/",
  index_data: "https://mcp.wind.com.cn/vserver_index_data/mcp/",
  bond_data: "https://mcp.wind.com.cn/vserver_bond_data/mcp/",
  financial_docs: "https://mcp.wind.com.cn/vserver_financial_docs/mcp/",
  economic_data: "https://mcp.wind.com.cn/vserver_economic_data/mcp/",
  analytics_data: "https://mcp.wind.com.cn/vserver_analytics_data/mcp/"
};

// Copied from wind-mcp-skill/references/tool-manifest.json.
const TOOL_MANIFEST = {
  stock_data: ["search_stocks", "get_stock_price_indicators", "get_stock_kline", "get_stock_quote", "get_stock_basicinfo", "get_stock_fundamentals", "get_stock_equity_holders", "get_stock_events", "get_stock_technicals", "get_risk_metrics"],
  global_stock_data: ["search_global_stocks", "get_global_stock_price_indicators", "get_global_stock_kline", "get_global_stock_quote", "get_global_stock_basicinfo", "get_global_stock_fundamentals", "get_global_stock_equity_holders", "get_global_stock_events", "get_global_stock_technicals", "get_global_stock_risk_metrics"],
  fund_data: ["search_funds", "get_fund_price_indicators", "get_fund_kline", "get_fund_quote", "get_fund_info", "get_fund_financials", "get_fund_holdings", "get_fund_performance", "get_fund_holders", "get_fund_company_info"],
  index_data: ["get_index_price_indicators", "get_index_kline", "get_index_quote", "get_index_basicinfo", "get_index_fundamentals", "get_index_technicals"],
  bond_data: ["get_bond_basicinfo", "get_bond_issuer_info", "get_bond_market_data", "get_bond_financial_data"],
  financial_docs: ["get_company_announcements", "get_financial_news"],
  economic_data: ["get_economic_data"],
  analytics_data: ["get_financial_data"]
};

export class WindError extends Error {
  constructor(code, detail) {
    super(`${code}: ${detail}`);
    this.name = "WindError";
    this.code = code;
  }
}

class QuotaExhaustedError extends Error {}

// Same key order as the CLI: LFJ (or plain WIND_API_KEY), HF, ZZY.
export function getApiKeys(env = process.env) {
  const keys = [];
  const add = (label, key) => {
    const value = String(key || "").trim();
    if (value && !keys.some((item) => item.key === value)) keys.push({ label, key: value });
  };
  add("LFJ", env.WIND_API_KEY_LFJ || env.WIND_API_KEY);
  add("HF", env.WIND_API_KEY_HF);
  add("ZZY", env.WIND_API_KEY_ZZY);
  return keys;
}

export function isMockMode(env = process.env) {
  return env.WIND_MOCK === "1";
}

function isQuotaExhaustedMessage(message) {
  return /\bquota\s*(?:is\s*)?(?:exhausted|exceeded)\b|\bdaily\s*(?:request\s*)?limit\b|\binsufficient\s*(?:account\s*)?balance\b|单日请求次数超限|额度(?:已)?(?:用完|耗尽|不足|超限)|余额不足|请先充值/i.test(String(message || ""));
}

const ERROR_PATTERNS = [
  ["TEMPORARILY_UNAVAILABLE", /temporarily_unavailable/i],
  ["INVALID_PARAM_VALUE", /invalid_param_value/i],
  ["INVALID_PARAM_NAME", /invalid_param_name/i],
  ["QUOTA_ERROR", /单日请求次数超限|daily.*limit|余额不足|请先充值|insufficient.*balance|请求过于频繁|qps.*limit|too.*frequent/i],
  ["AUTH_ERROR", /密钥无效|key.*invalid|unauthorized|认证失败|auth.*fail/i],
  ["NO_RESULTS", /未获取到数据|"NO_RESULTS"|no\s*results?|not\s*found|empty\s*result/i],
  ["PARAM_VALIDATION_ERROR", /参数验证失败|参数.*(错误|非法|无效)|字段.*(不存在|不识别|不支持|非法)|invalid\s*(param|argument|field)|missing\s*(param|argument|field|required)/i],
  ["NETWORK_ERROR", /服务.*暂不可用|服务.*不可用|service\s+unavailable|temporarily\s+unavailable/i],
  ["TOOL_RUNTIME_ERROR", /TOOL_ERROR|tool.*error|工具.*(执行|运行).*错误|runtime.*error/i]
];

function inferErrorCode(message) {
  for (const [code, pattern] of ERROR_PATTERNS) if (pattern.test(message || "")) return code;
  return "UNKNOWN";
}

const HTTP_ERROR_MAP = { 401: "AUTH_ERROR", 429: "QUOTA_ERROR", 500: "NETWORK_ERROR", 502: "NETWORK_ERROR", 503: "NETWORK_ERROR", 504: "NETWORK_ERROR" };

function fail(message, serverType) {
  const detail = `${message} (server=${serverType})`;
  const code = inferErrorCode(message);
  if (code === "QUOTA_ERROR" && isQuotaExhaustedMessage(message)) throw new QuotaExhaustedError(detail);
  throw new WindError(code, detail);
}

function validateCall(serverType, toolName, params) {
  if (!SERVERS[serverType]) throw new WindError("ROUTE_ERROR", `未知 server_type: ${serverType}`);
  if (!TOOL_MANIFEST[serverType].includes(toolName)) throw new WindError("ROUTE_ERROR", `工具名 "${toolName}" 不属于 server_type "${serverType}"`);
  if (!params || typeof params !== "object" || Array.isArray(params)) throw new WindError("PARAM_VALIDATION_ERROR", "params 必须是 JSON object");
  const errors = [];
  for (const key of ["question", "query", "metricIdsStr", "windcode", "indexes"]) {
    if (!(key in params)) continue;
    if (typeof params[key] !== "string") errors.push(`字段 '${key}' 必须是字符串`);
    else if (!params[key].trim()) errors.push(`字段 '${key}' 不能为空或全空白`);
  }
  for (const key of ["question", "query", "metricIdsStr"]) {
    if (typeof params[key] === "string" && /\s/.test(params[key])) errors.push(`字段 '${key}' 不得含空格或其它空白字符`);
  }
  // 指数快照工具支持多个代码（逗号分隔），其它工具只允许单个标的。
  const multiCodeTool = serverType === "index_data" && toolName === "get_index_price_indicators";
  if (typeof params.windcode === "string" && params.windcode.includes(",") && !multiCodeTool) errors.push("字段 'windcode' 只允许单个标的");
  for (const key of ["begin_date", "end_date", "beginDate", "endDate", "date", "tradeDate"]) {
    if (key in params && typeof params[key] === "string" && !/^\d{8}$/.test(params[key])) errors.push(`字段 '${key}' 日期格式错误，要求 yyyyMMdd`);
  }
  if (errors.length) throw new WindError("PARAM_VALIDATION_ERROR", errors.join("；"));
}

function parseSSE(text) {
  const trimmed = text.trim();
  if (trimmed.startsWith("{")) {
    try { return JSON.parse(trimmed); } catch {}
  }
  let last = null;
  for (const line of text.split(/\r?\n/)) if (line.startsWith("data: ")) last = line.slice(6);
  if (last) return JSON.parse(last);
  throw new Error(`响应格式无法识别：${text.slice(0, 200)}`);
}

async function mcpRequest(serverType, method, params, { apiKey, timeoutMs }) {
  let response;
  try {
    response = await fetch(SERVERS[serverType], {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: "application/json, text/event-stream",
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: Date.now(), method, params }),
      signal: AbortSignal.timeout(timeoutMs)
    });
  } catch (error) {
    throw new WindError("NETWORK_ERROR", `${error?.message || error} (server=${serverType})`);
  }

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    const code = HTTP_ERROR_MAP[response.status] || "UNKNOWN";
    const detail = `HTTP ${response.status} (server=${serverType})${body ? ` | ${body.slice(0, 200)}` : ""}`;
    if (code === "QUOTA_ERROR" && isQuotaExhaustedMessage(body)) throw new QuotaExhaustedError(detail);
    throw new WindError(code, detail);
  }

  let payload;
  try {
    payload = parseSSE(await response.text());
  } catch (error) {
    throw new WindError("TOOL_RUNTIME_ERROR", `${error.message} (server=${serverType})`);
  }
  if (payload.error) fail(payload.error.message || JSON.stringify(payload.error), serverType);
  if (payload.result?.isError) fail(payload.result.content?.[0]?.text || JSON.stringify(payload.result), serverType);

  // Some tools wrap business errors inside content[0].text as a JSON string.
  const innerText = payload.result?.content?.[0]?.text;
  if (typeof innerText === "string") {
    let inner = null;
    try { inner = JSON.parse(innerText); } catch {}
    if (inner && typeof inner.mcp_tool_error_code === "number" && inner.mcp_tool_error_code !== 0) {
      fail(inner.mcp_tool_error_msg || JSON.stringify(inner), serverType);
    }
    if (inner?.error && (inner.error.code || inner.error.message)) {
      fail(inner.error.code ? `${inner.error.code}: ${inner.error.message || ""}` : inner.error.message, serverType);
    }
  }
  return payload.result;
}

let mockModulePromise = null;

/**
 * Calls one Wind tool and returns the raw MCP result ({ content: [...] }),
 * exactly what `cli.mjs call` printed to stdout.
 */
export async function callWindTool(serverType, toolName, params, { timeoutMs = 35_000 } = {}) {
  validateCall(serverType, toolName, params);

  if (isMockMode()) {
    mockModulePromise ||= import("./mock-wind.js");
    return (await mockModulePromise).mockWindResult(serverType, toolName, params);
  }

  const keys = getApiKeys();
  if (!keys.length) throw new WindError("AUTH_ERROR", "WIND_API_KEY（或 WIND_API_KEY_LFJ / _HF / _ZZY）未配置");

  const deadline = Date.now() + timeoutMs;
  const remaining = () => Math.max(1_000, deadline - Date.now());
  let lastQuotaError = null;
  for (const account of keys) {
    try {
      await mcpRequest(serverType, "initialize", {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: CLIENT_NAME, version: SKILL_VERSION }
      }, { apiKey: account.key, timeoutMs: Math.min(15_000, remaining()) });
      return await mcpRequest(serverType, "tools/call", {
        name: toolName,
        arguments: params,
        _meta: { clientVersion: SKILL_VERSION }
      }, { apiKey: account.key, timeoutMs: remaining() });
    } catch (error) {
      if (!(error instanceof QuotaExhaustedError)) throw error;
      lastQuotaError = `${account.label}: ${error.message}`;
    }
  }
  throw new WindError("QUOTA_ERROR", `所有已配置 Wind API Key 的额度均已耗尽 | ${lastQuotaError || "无详情"}`);
}
