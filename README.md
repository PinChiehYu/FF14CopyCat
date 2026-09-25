# FF14 CopyCat

比較兩份 FFLogs 日誌（自己與高階玩家），以時間軸與站位對照分析，協助模仿高階玩家的操作。

網站：https://pinchiehyu.github.io/FF14CopyCat/

## 功能

貼上自己與高階玩家的 FFLogs 報告連結、選擇戰鬥與角色（參考日誌會依你的 Boss 與職業自動選擇），即可得到：

- **建議**：依重要性排序的改進建議，可跳到對應時間點。
- **Boss 機制差異**：兩場戰鬥中 Boss 隨機機制不同的時間點。
- **GCD 概況與少打 GCD 的時段**：GCD 數、GCD 間隔、你停手但參考仍在輸出的時段。
- **技能使用次數**：各技能（含普通攻擊）的次數差距與平均使用時機。
- **站位比較**：距離圖、俯視圖、站位不同的時段（標示可能是對稱攻略）。
- **並排時間軸**：以 Boss 機制對齊兩人的技能施放。

兩場戰鬥長度不同時，只比較兩邊都在進行的時段。技能名稱以繁體中文顯示。

所有戰鬥職業都有基本規則（GCD／oGCD 分類、減傷與移動技能），由遊戲資料產生；各職業的詳細分析之後再加入。減傷與衝刺等移動技能有專屬建議；坦克的挑釁、退避、坦姿開關不列入比較。

文件：
- [docs/DESIGN.md](docs/DESIGN.md)：系統設計（架構、分析方法與規則、待辦事項、設計變更紀錄）。
- [docs/TECH_NOTES.md](docs/TECH_NOTES.md)：技術紀錄（測試資料、FFLogs 資料特性、資料來源調查、實測結果、踩過的坑）。

## 架構

- 前端（`src/`）：Vite + React，部署在 GitHub Pages。
- API 代理（`worker/`）：Cloudflare Worker，持有 FFLogs API 金鑰並轉發查詢，訪客不需登入 FFLogs；另代查技能繁中名稱。

## 開發

需要 Node.js 24+。

```bash
npm install
cp worker/.dev.vars.example worker/.dev.vars   # 填入 FFLogs client ID / secret
npm run worker:dev                              # 終端機 1：Worker，http://localhost:8787
npm run dev                                     # 終端機 2：前端，http://localhost:5173
```

或在 `.env.local` 設定 `VITE_API_BASE=https://ff14-copycat-api.ff14-copycat.workers.dev`，本機前端直接連已部署的 Worker。

| 指令 | 用途 |
| --- | --- |
| `npm run dev` | 前端開發伺服器 |
| `npm run worker:dev` | 本機執行 Worker 代理 |
| `npm run build` | 型別檢查並建置前端到 `dist/` |
| `npm test` | 執行所有測試（含 Worker） |
| `npm run lint` | oxlint |
| `npm run worker:deploy` | 部署 Worker 到 Cloudflare |
| `node scripts/smoke-test.mjs` | 對正式站與 Worker 做冒煙測試 |

## 部署

### Worker（首次與每次修改 `worker/` 後）

1. 在 [FFLogs API Clients](https://www.fflogs.com/api/clients/) 建立用戶端（**不要**勾選 public client），Redirect URL 可填網站網址，取得 client ID 與 secret。
2. 登入 Cloudflare 並部署：
   ```bash
   npx wrangler login
   npm run worker:deploy
   ```
3. 在 Cloudflare 儀表板的 Worker → Settings → Variables and Secrets 新增 **Secret** `FFLOGS_CLIENT_ID`、`FFLOGS_CLIENT_SECRET`（或用 `npx wrangler secret put <名稱> -c worker/wrangler.toml`）。在儀表板修改後要按 Deploy 才會生效。
4. 目前部署於 `https://ff14-copycat-api.ff14-copycat.workers.dev`；若網址改變，要同步更新 `src/config.ts`。

### 前端

推送到 `main` 後由 GitHub Actions 建置、部署到 GitHub Pages，並執行冒煙測試。Repo 的 Settings → Pages → Source 必須是 **GitHub Actions**（若設成 Deploy from a branch，GitHub 會另外把原始碼直接發布上去並覆蓋建置結果）。
