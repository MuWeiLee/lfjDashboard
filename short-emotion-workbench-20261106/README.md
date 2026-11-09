# ShortEmotion · 短线情绪工作台（打包版 2026-11-06）

A股 / 台股短线情绪看板，含情绪总览、市场广度、涨停情绪、资金流向、全球联动、题材雷达、情绪路径，以及宽基 ETF 净申赎。
页面只读快照，不直接调用 Wind；取数由定时任务或「刷新」按钮触发。

本包是当前工作区的全量代码，解压安装依赖后即可运行。

## 快速开始

```bash
npm install
npm test          # vitest，8 个测试文件 / 136 条用例
npm run dev       # http://localhost:3000/cn
```

- 端口：默认 `3000`，可用 `PORT` 覆盖。
- 数据模式：`scripts/dev-server.mjs` 默认 `SHORT_EMOTION_STORE=file`、`SHORT_EMOTION_DATA_DIR=./short-emotion-data`，即直接读包内快照，**不需要 Wind、不需要线上数据分支**，解压即可看到当前页面效果。
- 只想改读其他数据目录：`SHORT_EMOTION_DATA_DIR=<目录> npm run dev`。
- Windows 可直接双击 `start-short-emotion.cmd`（已内置 file 模式、端口 3000、自动打开 `/cn`）。

页面入口：

| 路径 | 内容 |
| --- | --- |
| `/cn`、`/` | A股 |
| `/tw` | 台股（盘后快照、繁体） |
| `/zt` | 涨停情绪 |
| `/cn-short-emotion`、`/tw-short-emotion`、`/short-emotion` | 旧地址，跳转到 `/cn`、`/tw` |

## 依赖

- Node.js 22.x（`package.json` engines）。
- 运行时依赖：无。开发依赖：`vitest@4.0.17`、`opencc-js@1.0.5`（构建繁简字表用）。
- 刷新取数需要 Wind key：`WIND_API_KEY` 或 `WIND_API_KEY_LFJ / _HF / _ZZY / _XX / _YYH`（按序轮换）。
- 线上「刷新」需要 `GITHUB_ACTIONS_TOKEN`；本地没有时会直接在本进程取数。
- 包内**不含 `.env`**（含私钥），需自行配置；也不含 `node_modules`。

## 目录结构

```
api/                     接口层
  short-emotion.js       /api/short-emotion 入口
  _lib/short-emotion/    取数、评分、存储、定时任务
public/short-emotion/    静态页面（index.html / app.js / twsvp.css / limit.* / vendor）
scripts/                 本地 dev server、取数、涨停页构建
short-emotion-data/      本地数据快照（见下方说明）
tests/                   vitest 用例
sql/                     数据库脚本（Supabase 方案备用）
.github/workflows/       定时任务
vercel.json              部署配置（输出目录 public）
```

## 模块作用

### `api/_lib/short-emotion/`

| 文件 | 作用 |
| --- | --- |
| `engine.js` | A股情绪评分：市场广度、极端反馈、连板梯队、赚钱效应、题材聚焦、成交环境。 |
| `tw-engine.js` | 台股版本（产业指数口径）。 |
| `limit-engine.js` | 涨停/连板情绪、次日溢价、涨停复盘队列。 |
| `etf-flow.js` | **宽基 ETF 净申赎**：规模变化与资金净流入/流出。 |
| `fund-flow.js` | 资金流向：主力净流入、行业与 5/20 日窗口。 |
| `global-linkage.js` | **全球联动**：13 个主题、28 组中美/中韩配对；日收益对齐（美股 T-1、韩股同日）算方向同步率、周收益相关系数 r、新闻热度与区间统计。 |
| `schedule.js` | 定时任务编排：按资源取数并写入快照。 |
| `service.js` | 快照读取与资源路由（页面读数据的唯一入口）。 |
| `store.js` | 存储后端：`file` / `github` / `supabase` / `memory`。 |
| `wind-client.js` | Wind MCP 调用、多 key 轮换与额度耗尽切换。 |
| `mock-wind.js` | 本地与测试用的 Wind 假数据。 |
| `github.js` | 触发 GitHub Actions、查询运行状态。 |
| `hant.js` | 简体 → 繁体转换（台股页面）。 |

### `public/short-emotion/`

`index.html` / `app.js` / `twsvp.css` 为短线情绪工作台主页面；`limit.html` / `limit.js` 为涨停情绪页；`hant-map.js` 为繁简字表；`vendor/html-to-image.js` 用于导出图片；`logo.svg` 为临时标识。

### `scripts/`

`dev-server.mjs` 本地服务（3000）；`short-emotion/refresh.mjs` 取数并落盘；`limitup/*` 涨停页构建与探测；`backfill-fund-flow.mjs` 资金流历史回填；`*.ps1` 环境与启动脚本。

## 接口

```
GET  /api/short-emotion?market=cn|tw&resource=emotion|anomalies|history|news|fund-flow|etf-flow|global-linkage|limitup|status|refresh-status
POST /api/short-emotion?market=cn|tw&action=refresh
```

- GET 返回对应资源的快照内容；CDN 缓存 2 分钟，`fresh=1` 跳过缓存。
- POST 触发一次刷新：有 `GITHUB_ACTIONS_TOKEN` 走 Actions，否则本地直接取数。
- 资源未生成时返回 503 `not_ready`。

`global-linkage` 返回结构：

```
{ asOf, tradingDate, window, heat, basis, filter, source,
  groups: [{ market: "US"|"KR", label, note, checked,
    themes: [{ theme, pairs: [{
      id,
      cn:   { code, name, changePct, perf: { day, week, "60d" } },
      peer: { code, name, changePct, perf: { day, week, "60d" } },
      relation, heat, peerHeat,
      direction: { syncRate, samples },
      weekly: { correlation, samples },
      lag }] }] }],
  stats: { defined, shown, priceMissing[], heatMissing[] },
  missing }
```

## 口径说明

- **相关性**：取卡内各配对的周收益 Pearson r，按 `|r|` 分档：`<0.3` 低、`0.3–0.6` 中、`≥0.6` 高；多配对显示区间（如 `低~中`），全负标 `(反向)`、正负混杂标 `(含反向)`。
- **涨跌幅**：日=最近交易日；周=本周至今；60 日=近 60 个交易日。
- **美股 T-1**：美股收益序列整体后移 1 个交易日再与 A股对齐；韩股同日对齐。
- **热度**：Wind 新闻热度（0–100）近 30 个交易日；中美配对只用 A股侧热度。

## 数据快照说明

`short-emotion-data/` 是**数据快照，不是代码**：

- `index.json`、`kv/*.json`（情绪、异动、新闻、资金流、ETF 净申赎、全球联动、涨停等最新快照与历史窗口）、`history/*.json`（每日情绪历史）。
- 生成时间 2026-11-06，用于解压后直接看到当前页面效果。
- 该快照的 `perf` 字段为空（Wind 额度耗尽），对应日/周收益显示「—」，60 日收益仍为真实值。
- 如不需要历史，可只保留 `kv/*_latest.json`。

## 当前环境限制

1. **Wind 额度耗尽**：刷新可能失败或字段缺失（热度、收益）；不影响已写入快照的浏览。
2. **日/周收益依赖快照 `perf` 字段**：当前快照 `perf` 为 `null`，日/周收益列显示「—」，60 日收益来自行情序列。
3. **美股无新闻热度**：中美配对的热度只统计 A股侧。
4. **部分 A 股热度缺失**：见快照 `stats.heatMissing`，对应卡片显示「—」。
5. **相关性精度**：r 落库前四舍五入到 2 位小数；页面已改为档位显示，不再暴露数值差异。
6. **无 `.env`**：需要 Wind key 才能刷新，否则只能看包内快照。

## 验证

- `vitest run`：8 个测试文件、136 条用例全部通过。
- 页面在 1440 / 1280 / 900 / 390 四个视口无横向溢出。
