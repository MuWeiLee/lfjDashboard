# ShortEmotion · 短線情緒

A股 / 台股短線情緒看板：**https://lfjmwl.com**（Vercel 預設網址 stockmarketshortemotion.vercel.app 也可用）。

由 [twsvp-frontend](https://github.com/MuWeiLee/twsvp-frontend) 的「短線情緒」原樣遷出（來源 `69593b1`，PR #126），獨立部署。twsvp.com 保留自己的短線情緒頁面，兩站各自取數、互不依賴。

| 網址 | 內容 |
| --- | --- |
| `/`、`/cn` | A股 |
| `/tw` | 台股（盤後快照，繁體） |
| `/cn-short-emotion`、`/tw-short-emotion`、`/short-emotion` | 舊網址，跳轉到 `/cn`、`/tw` |

## 運作方式

```
GitHub Actions（.github/workflows/short-emotion.yml，工作日 09:00–15:30 每 30 分鐘）
  └─ scripts/short-emotion/refresh.mjs 呼叫 Wind MCP 計算快照
       └─ 強制推送到 short-emotion-data 分支（A股在根目錄，台股在 tw/）
Vercel
  ├─ public/short-emotion/        靜態頁面
  └─ api/short-emotion.js         只讀資料分支；POST action=refresh 時觸發上面的工作流
```

頁面不直接呼叫 Wind。「刷新」按鈕每個瀏覽器每小時一次，同一市場 2 分鐘內多人點擊共用同一次任務。

## 部署設定（只需做一次）

1. **GitHub 倉庫 Secret**：Settings → Secrets and variables → Actions → 新增 `WIND_API_KEY`。
   也可改用 `WIND_API_KEY_LFJ / _HF / _ZZY / _XX / _YYH`，程式會依序輪換，某把額度耗盡時自動切換到下一把。
   沒設定之前，定時任務會自動跳過（只留一條警告），不會寄失敗通知。
2. **Vercel**：匯入本倉庫，Framework 選 Other，其餘保持預設（`vercel.json` 已指定輸出目錄 `public`）。
3. **Vercel 環境變數** `GITHUB_ACTIONS_TOKEN`：GitHub fine-grained token，只授權本倉庫，
   權限 Actions: Read and write、Contents: Read-only。沒有它頁面照常顯示，只是「刷新」不可用。

## 本地開發

```bash
npm install
npm test            # 單元測試
npm run dev         # http://localhost:3000/cn ，預設讀線上資料分支
SHORT_EMOTION_DATA_DIR=./short-emotion-data npm run dev   # 改讀本地檢出的資料分支
```

手動跑一次取數（需要 `WIND_API_KEY` 或任一 `WIND_API_KEY_*`）：`WIND_API_KEY=... npm run refresh -- --force --market=all`

## 第二階段待辦

- 正式品牌與 Logo（目前 `public/short-emotion/logo.svg` 是臨時標識）
- 外觀設定的 localStorage 鍵名仍為 `twsvp_theme`、`twsvp_price_scheme`；樣式檔仍叫 `twsvp.css`
