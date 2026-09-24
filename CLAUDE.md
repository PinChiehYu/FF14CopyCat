# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 工作規則

- **一律使用繁體中文與使用者對話**（程式碼識別字、commit message 維持英文）。
- **每次推送新程式碼後都要確認新版已建置並通過測試**：push 到 `main` 會觸發 `.github/workflows/deploy.yml`（lint → test → build → deploy → 冒煙測試）。推送後追蹤該次 workflow 直到完成，失敗就查原因修正；並以下方的比較基準日誌在正式站實際操作驗證這次的變更。改了 `worker/` 則先 `npm run worker:deploy` 再推送前端。
- **系統設計有調整時，必須記錄到 [docs/DESIGN.md](docs/DESIGN.md)**：更新「目前設計」對應段落，並在「設計變更紀錄」新增一筆（日期、變更內容、原因），與實作放在同一個 commit。設計調整包含：架構／部署方式、資料流與 API 端點、外部服務、分析方法與演算法、已與使用者議定的規格或優先順序。純 bug 修正或重構不需記錄。本檔（CLAUDE.md）的架構描述也要同步更新。

## Commands

Vite + React + TypeScript，測試用 Vitest，lint 用 oxlint。Node.js 24。

```bash
npm run dev                          # http://localhost:5173
npm run build                        # tsc -b && vite build → dist/
npm test                             # vitest run
npx vitest run src/fflogs/url.test.ts   # 單一測試檔
npx vitest run -t "parses report"       # 依測試名稱篩選
npm run lint
npm run worker:dev                   # 本機 Worker 代理 http://localhost:8787（需 worker/.dev.vars）
npm run worker:deploy                # 部署 Worker 到 Cloudflare（需先 npx wrangler login）
npx wrangler deploy -c worker/wrangler.toml --dry-run --outdir <tmp>   # 不登入即可驗證 Worker 設定
node scripts/smoke-test.mjs          # 對正式站與 Worker 做實際請求的冒煙測試（CI 部署後自動執行）
```

- 在這台 Windows 機器上，Node 裝在 `C:\Program Files\nodejs`；若 shell 找不到 `node`/`npm`，先把它加進 PATH。
- 在 Git Bash 設定 `BASE_PATH=/xxx/` 會被 MSYS 改寫成 Windows 路徑，需加 `MSYS_NO_PATHCONV=1`。
- `tsc -b` 同時檢查前端（`tsconfig.app.json`）與 Worker（`worker/tsconfig.json`，WebWorker lib，不含 DOM）；Vitest 會一併執行 `worker/` 下的測試。

## 架構：GitHub Pages 前端 + Cloudflare Worker 代理

- **前端**（`src/`）：部署到 GitHub Pages 專案站台 `https://pinchiehyu.github.io/FF14CopyCat/`。`.github/workflows/deploy.yml` 在 push 到 `main` 時執行 lint → test → build → deploy，並以 repo 名稱設定 `BASE_PATH`（`vite.config.ts` 的 `base`）。站內路徑一律透過 `import.meta.env.BASE_URL` 組出，不要寫死 `/`。
- **Worker 代理**（`worker/`）：持有 FFLogs client credentials（`wrangler secret` 的 `FFLOGS_CLIENT_ID` / `FFLOGS_CLIENT_SECRET`），向 `/api/v2/client` 查詢。訪客不需登入 FFLogs。已部署於 `https://ff14-copycat-api.ff14-copycat.workers.dev`；前端的 Worker 網址寫在 `src/config.ts`（正式建置用已部署網址、開發模式用 `localhost:8787`，可用 `VITE_API_BASE` 覆寫）。Worker 網址或 `ALLOWED_ORIGINS` 變更時兩邊要一起改。Worker 不隨 GitHub Actions 部署，要手動 `npm run worker:deploy`。
- **代理只開放固定的 REST 端點**，GraphQL 查詢寫死在 `worker/src/queries.ts`，前端不能送任意查詢：
  - `GET /reports/:code` → 報告、fights、masterData.actors、masterData.abilities
  - `GET /reports/:code/events?fight&start&end[&source][&dataType][&hostility]` → 一頁事件（`includeResources: true`）；前端 `fetchFightEvents()` 依 `nextPageTimestamp` 翻頁
  - `GET /abilities?ids=...` → 技能繁中名稱（`worker/src/abilityNames.ts`，查 Boilmaster 鏡像 `xivapi-v2.xivcdn.com` 的 `tc`，佔位或空白時以 `chs` 經 opencc-js 轉繁）。前端顯示名稱為繁中、英文在 `Ability.englishName`；**依名稱判斷的規則要用英文名稱**
  - 新增資料需求時：在 `queries.ts` 加查詢、在 `handler.ts` 的 `route()` 加端點與參數驗證、在 `src/fflogs/types.ts` 加型別。改了查詢欄位要同步更新 `types.ts`。
- Worker 行為：`ALLOWED_ORIGINS`（`wrangler.toml`）檢查 Origin 並回 CORS 標頭；Cloudflare Rate Limiting 綁定 `RATE_LIMITER`（每 IP 60 次/分）；成功回應以不含 Origin 的 URL 為鍵放進 `caches.default` 10 分鐘。`handler.ts` 不依賴 Workers 型別，快取與 ctx 以參數注入，方便在 Node 的 Vitest 中測試。
- 所有訪客共用同一組 FFLogs API 配額（points/hour），新增查詢時要考慮快取與請求次數；前端的報告查詢已對輸入做 debounce。
- **改了 `worker/` 要記得 `npm run worker:deploy`**；前端依賴的新欄位需先部署 Worker 再推送前端。查詢只「增加」欄位時對舊前端相容。

## 前端比較流程

`App.tsx`（貼連結、選戰鬥與玩家；選擇規則在 `compare/autoSelect.ts` 的 `resolveSelection()`，參考日誌以我的 Boss／職業為 `preferred` 自動選擇）→ `compare/Comparison.tsx`（檢查同 Boss／同職業、載入 4 組施放事件）→ `analysis/alignment.ts`（`buildAlignment()` 產生 `mineToRef()`）→ `compare/AdviceList.tsx`（`analysis/advice.ts` 的規則式建議，彙整下列各分析）＋ `compare/Mechanics.tsx`（`analysis/mechanics.ts` 的 Boss 機制差異）＋ `compare/Metrics.tsx`（`analysis/metrics.ts` 的 GCD 概況、少打 GCD 的時段、技能次數與時機）＋ `compare/Positions.tsx`（`analysis/positions.ts` 的站位差異與對稱判斷、俯視圖）＋ `compare/Timeline.tsx`（以參考時間為橫軸的並排時間軸，可標示區段與捲動到指定時間）。玩家施放時間取開始施放（`load.ts` 的 `playerCasts()` 以 `begincast` 取代 `cast`）。玩家資料抓 `dataType=All`，施放與位置都從中取得（全部事件中也有別人對玩家的施放，要以 `sourceID` 過濾）。`Comparison.tsx` 持有共用的時間游標 `cursor`（參考時間）與時間軸捲動用的 `focus`。所有統計都用裁切到比較範圍的 `mineInRange`／`refInRange`（`clipSide()`），只有時間軸與 Boss 機制差異用完整資料；新增統計時也要用裁切後的資料。

- 對齊演算法的細節與設計理由見 [docs/DESIGN.md](docs/DESIGN.md)；調整門檻（`maxOccurrences`、`dedupeMs`）前先用實際日誌驗證。
- 職業規則放在 `src/jobs/<job>.ts`，實作 `JobModule` 並加入 `jobs/index.ts` 的 `JOBS`；以 FFLogs `subType`（如 `Viper`）查找。
- React 19 中 `ref` 是保留 prop，元件 prop 不要命名為 `ref`（比較雙方用 `mine` / `reference`）。
- 本機測試可在 `.env.local` 設 `VITE_API_BASE=https://ff14-copycat-api.ff14-copycat.workers.dev` 直接連已部署的 Worker（`ALLOWED_ORIGINS` 已含 `http://localhost:5173`）。測試用公開報告：`WATKBdHRh7m8PNQt`（fight 10 滅團 / 11 擊殺 Sugar Riot，Viper 玩家 source=34）；**使用者指定的比較基準**（皆為 Howling Blade 擊殺，驗證功能時兩組都要測）：
  - 武士：我的日誌 `https://www.fflogs.com/reports/FXLkqaK32PhQH8Ac?fight=1`（席德，source 6）、高階玩家 `https://www.fflogs.com/reports/pwTF16cgnB9G7fWM?fight=29`（安祖卡，source 13）。
  - 騎士：我的日誌 `https://www.fflogs.com/reports/hqNYDGK9A4pmWVXB?fight=18`（神曲莊園，source 40）、高階玩家 `https://www.fflogs.com/reports/khNfTaMtYwKBd36b?fight=10`（Lavid，source 5）。參考擊殺快 61 秒，可測大幅時間差與坦克技能。
- 新增或修改職業模組時，用 `begincast` 為起點計算 GCD 間隔驗證分類（見 DESIGN.md 職業模組一節）。

## 專案目標

一個部署於 GitHub Pages 的 FF14 戰鬥日誌比較工具，協助玩家模仿並學習高階玩家的操作：

1. 使用者貼上兩個 fflogs.com 報告連結（通常一份是自己、一份是參考的高階玩家）。
2. 分別在兩份日誌中指定要比較的角色（與戰鬥場次）。
3. 進行類似 [xivanalysis](https://xivanalysis.com/) 的職業分析（GCD 使用率、技能循環、資源溢出、Buff 對齊等）。
4. 以**戰鬥時間軸**與**角色位置**兩個維度對齊比較兩位玩家。
5. 輸出具體的改進建議。

## 領域與架構注意事項

- **FFLogs 連結解析**：格式為 `https://www.fflogs.com/reports/<reportCode>#fight=<id|last>&source=<actorId>...`。需從中取出 report code、fight id，並可能預選 source（角色）。
- **資料來源為 FFLogs API v2（GraphQL）**，一律經由 Worker 代理存取（見上方架構）。
  - 事件查詢有分頁（`nextPageTimestamp`），需迴圈抓完整場戰鬥。
  - 事件的 `timestamp` 是相對於**整份報告**開始的毫秒數；比較兩份日誌前必須減去各自 fight 的 `startTime` 以正規化到戰鬥開始時間。
  - 位置資料需在事件查詢加上 `includeResources: true`，由 `sourceResources` / `targetResources` 的 `x`、`y`、`facing` 取得；位置只在有事件時才有取樣，時間上不連續，比較時需要插值或以最近取樣點對齊。座標單位為 1/100 yalm（例如場地中心 (100, 100) 記為 `x: 10000, y: 10000`）。
  - `masterData.actors` 中 type 為 `Player` 的不全是真人：極限技會以 subType `LimitBreak` 的假角色（名稱如 `Limit Break`、`Multiple Players`）出現，且同名玩家可能另有 subType `Unknown` 的項目。選玩家一律透過 `src/fflogs/report.ts` 的 `playersInFight()`。
  - 單一玩家整場戰鬥的全部事件約 4000 筆、1.4 MB，一頁（limit 10000）通常就能取完；Boss 事件用 `hostility=Enemies`。
- **時間軸對齊**：兩份日誌的擊殺時間、轉場時間不同，單純用絕對時間比較會失準。應以 Boss 的技能事件（施放/傷害）作為錨點做分段對齊。
- **分析邏輯與職業相關**：建議把職業別的規則（技能 ID、GCD 定義、Buff 窗口）做成可擴充的模組，而非寫死在比較流程中。xivanalysis 為開源專案（GitHub: `xivanalysis/xivanalysis`），可作為職業規則與分析模組設計的參考。
