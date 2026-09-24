# FF14 CopyCat

比較兩份 FFLogs 日誌（自己與高階玩家），以時間軸與站位對照分析，協助模仿高階玩家的操作。

網站：https://pinchiehyu.github.io/FF14CopyCat/

## 架構

- 前端（`src/`）：Vite + React，部署在 GitHub Pages。
- API 代理（`worker/`）：Cloudflare Worker，持有 FFLogs API 金鑰並轉發查詢，訪客不需登入 FFLogs。

## 開發

需要 Node.js 24+。

```bash
npm install
cp worker/.dev.vars.example worker/.dev.vars   # 填入 FFLogs client ID / secret
npm run worker:dev                              # 終端機 1：Worker，http://localhost:8787
npm run dev                                     # 終端機 2：前端，http://localhost:5173
```

| 指令 | 用途 |
| --- | --- |
| `npm run dev` | 前端開發伺服器 |
| `npm run worker:dev` | 本機執行 Worker 代理 |
| `npm run build` | 型別檢查並建置前端到 `dist/` |
| `npm test` | 執行所有測試（含 Worker） |
| `npm run lint` | oxlint |
| `npm run worker:deploy` | 部署 Worker 到 Cloudflare |

## 部署

### Worker（首次與每次修改 `worker/` 後）

1. 在 [FFLogs API Clients](https://www.fflogs.com/api/clients/) 建立用戶端（**不要**勾選 public client），Redirect URL 可填網站網址，取得 client ID 與 secret。
2. 登入 Cloudflare 並部署：
   ```bash
   npx wrangler login
   npm run worker:deploy
   ```
3. 在 Cloudflare 儀表板的 Worker → Settings → Variables and Secrets 新增 **Secret** `FFLOGS_CLIENT_ID`、`FFLOGS_CLIENT_SECRET`（或用 `npx wrangler secret put <名稱> -c worker/wrangler.toml`）。
4. 目前部署於 `https://ff14-copycat-api.ff14-copycat.workers.dev`；若網址改變，要同步更新 `src/config.ts`。

### 前端

推送到 `main` 後由 GitHub Actions 建置並部署到 GitHub Pages。Repo 的 Settings → Pages → Source 必須是 **GitHub Actions**（若設成 Deploy from a branch，GitHub 會另外把原始碼直接發布上去並覆蓋建置結果）。
