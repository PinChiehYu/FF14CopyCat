# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 工作規則

- **一律使用繁體中文與使用者對話**（程式碼識別字、commit message 維持英文）。
- **推送前先詢問**：完成一段工作後在本機 commit，回報結果並詢問是否推送；使用者回覆「推送」後才 `git push`（每次都要重新取得同意）。Worker 部署（`npm run worker:deploy`）屬於實作的一部分，可在前端推送前進行。
- 使用者常在工作進行中補充需求或更換測試資料；收到後在同一輪處理，並在回報中說明。
- **每次推送新程式碼後都要確認新版已建置並通過測試**：push 到 `main` 會觸發 `.github/workflows/deploy.yml`（lint → test → build → deploy → 冒煙測試）。推送後追蹤該次 workflow 直到完成，失敗就查原因修正；並以下方的比較基準日誌在正式站實際操作驗證這次的變更。改了 `worker/` 則先 `npm run worker:deploy` 再推送前端。
- **文件分兩份，各自維護**，與實作放在同一個 commit：
  - **[docs/DESIGN.md](docs/DESIGN.md)（網頁使用流程與設計）**：使用者看到與操作的一切——使用流程、比較結果頁各區塊的內容與互動、判定規則（比較範圍、GCD、少打 GCD、站位差異、機制差異）、技能分類與名稱呈現、建議規則、待辦與未決事項。使用流程或規則有調整時更新對應段落，並在「設計變更紀錄」新增一筆（日期、變更內容、原因）。不寫程式碼細節。
  - **[docs/TECH_NOTES.md](docs/TECH_NOTES.md)（網站技術紀錄）**：github.io 網站的技術實作——架構與部署、Worker API、資料處理與演算法實作、職業資料產生、技能名稱實作、測試資料、FFLogs 資料特性、外部資料來源調查、實測與驗證數據、參數調整與錯誤修正經過、部署與開發踩過的坑、技術上的已知限制。架構或實作有調整時在「技術變更紀錄」新增一筆；做了資料探索、以日誌驗證或修正錯誤判斷時補上紀錄。
  - 純 bug 修正或重構不需寫變更紀錄，但有值得記住的原因（例如資料特性）時記到 TECH_NOTES.md。
  - 本檔（CLAUDE.md）的架構描述也要同步更新。

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
node scripts/gen-job-data.mjs        # 從遊戲資料重新產生 src/jobs/generated.ts（GCD 集合、各職業技能分類；約 100 個請求）
```

- 在這台 Windows 機器上，Node 裝在 `C:\Program Files\nodejs`；若 shell 找不到 `node`/`npm`，先把它加進 PATH（PowerShell：`$env:Path = "C:\Program Files\nodejs;" + $env:Path`）。使用者自己的終端機也可能找不到 `npx`，需要請他們開新終端機或用完整路徑。
- 在 Git Bash 設定 `BASE_PATH=/xxx/` 會被 MSYS 改寫成 Windows 路徑，需加 `MSYS_NO_PATHCONV=1`。
- 開發環境注意事項：
  - Bash 工具執行含 heredoc 的長指令偶爾失敗（cwd 追蹤錯誤）；建立檔案用 Write 工具，指令改用 PowerShell。
  - PowerShell 的 `git commit -F -` 收不到 here-string；commit message 先寫到 scratchpad 檔案再 `git commit -F <檔案>`。
  - PowerShell 印中文前要設 `[Console]::OutputEncoding = [System.Text.Encoding]::UTF8`，否則亂碼。
  - 探索 FFLogs 資料時，用 scratchpad 的 Node 腳本直接打已部署的 Worker（加 `Origin: https://pinchiehyu.github.io` 標頭）。
  - 瀏覽器面板在視窗被遮住時截圖會失敗；改用 `javascript_tool` 讀 DOM 驗證，輸入連結用 `form_input`。
  - 在正式站驗證時瀏覽器可能用到快取的舊 `index.html`，網址加 `?v=<commit>` 強制載入新版。
  - deploy 步驟若因 GitHub Pages 502 失敗（建置正常），推一個空 commit 重新觸發即可；失敗原因用 `/actions/runs/<id>/jobs` 與 `/check-runs/<job id>/annotations` 查。
  - 短時間多次部署 Worker 可能讓 FFLogs 權杖端點回 429（數分鐘後恢復），部署後驗證若遇到先等一下。
  - GitHub CLI（`gh`）沒有安裝；查 workflow 狀態用公開 API：`https://api.github.com/repos/PinChiehYu/FF14CopyCat/actions/runs`。
  - `wrangler` 已在這台機器以使用者的 Cloudflare 帳號登入；Worker Secrets 由使用者在 Cloudflare 儀表板設定，不要要求使用者把 secret 貼到對話中。
- `tsc -b` 同時檢查前端（`tsconfig.app.json`）與 Worker（`worker/tsconfig.json`，WebWorker lib，不含 DOM）；Vitest 會一併執行 `worker/` 下的測試。

## 架構：GitHub Pages 前端 + Cloudflare Worker 代理

- **前端**（`src/`）：部署到 GitHub Pages 專案站台 `https://pinchiehyu.github.io/FF14CopyCat/`。`.github/workflows/deploy.yml` 在 push 到 `main` 時執行 lint → test → build → deploy → 冒煙測試（`scripts/smoke-test.mjs`，確認正式站已換成本次建置且 Worker 可用），並以 repo 名稱設定 `BASE_PATH`（`vite.config.ts` 的 `base`）。站內路徑一律透過 `import.meta.env.BASE_URL` 組出，不要寫死 `/`。
- **Worker 代理**（`worker/`）：持有 FFLogs client credentials（`wrangler secret` 的 `FFLOGS_CLIENT_ID` / `FFLOGS_CLIENT_SECRET`），向 `/api/v2/client` 查詢。訪客不需登入 FFLogs。已部署於 `https://ff14-copycat-api.ff14-copycat.workers.dev`；前端的 Worker 網址寫在 `src/config.ts`（正式建置用已部署網址、開發模式用 `localhost:8787`，可用 `VITE_API_BASE` 覆寫）。Worker 網址或 `ALLOWED_ORIGINS` 變更時兩邊要一起改。Worker 不隨 GitHub Actions 部署，要手動 `npm run worker:deploy`。
- **代理只開放固定的 REST 端點**，GraphQL 查詢寫死在 `worker/src/queries.ts`，前端不能送任意查詢：
  - `GET /reports/:code` → 報告、fights、masterData.actors、masterData.abilities
  - `GET /reports/:code/events?fight&start&end[&source][&dataType][&hostility]` → 一頁事件（`includeResources: true`）；前端 `fetchFightEvents()` 依 `nextPageTimestamp` 翻頁
  - `GET /abilities?ids=...` → 技能、效果與道具的繁中名稱（`worker/src/abilityNames.ts`，查 Boilmaster 鏡像 `xivapi-v2.xivcdn.com` 的 `tc`，佔位或空白時以 `chs` 經 opencc-js 轉繁；FFLogs 效果 ID＝1,000,000＋狀態 ID，查 Status 表；道具 ID＝`0x2000000`＋道具 ID，HQ 再加 1,000,000，查 Item 表）。前端顯示名稱為繁中、英文在 `Ability.englishName`；**依名稱判斷的規則要用英文名稱**
  - `GET /reports/:code/auto-attacks-taken?fight` → 每位玩家承受的敵方普通攻擊總傷害 `{ id: total }`（`table` 查詢以 `ability.name = 'attack'` 過濾），前端 `useTankLoad()` 用來判斷 MT／ST（角色選單排序與位置標示在 `jobs/names.ts` 的 `sortByPartySlot()`）
  - `GET /reports/:code/damage-done?fight` → 傷害表的數字欄位 `{ totalTime, entries: { id: { total, totalRDPS, totalRDPSTaken, totalRDPSGiven, totalADPS, … } } }`，前端 `fetchDamageSummary()` 換算成每秒 rDPS 等，顯示在摘要表（繁中服日誌不排名，但 FFLogs 仍計算 rDPS）
  - `GET /npc-names?name=A&name=B` → Boss 繁中名稱（`worker/src/npcNames.ts`，以英文名稱搜尋 BNpcName；NPC 的 gameID 對不到名稱表）。前端 `useReport()`（`App.tsx`）先以英文顯示報告，名稱查到後以 `translateReport()` 把 `Fight.name` 換成繁中、英文在 `Fight.englishName`（不阻擋選擇；`Comparison` 只依選擇的 ID 重新載入）
  - 新增資料需求時：在 `queries.ts` 加查詢、在 `handler.ts` 的 `route()` 加端點與參數驗證、在 `src/fflogs/types.ts` 加型別。改了查詢欄位要同步更新 `types.ts`。
- **繁中服排名**（FFLogs 沒有繁中服區域、不替繁中服排名）：Cloudflare D1 `ff14-copycat-rankings`（綁定 `DB`，結構在 `worker/schema.sql`，套用：`npx wrangler d1 execute ff14-copycat-rankings --remote --file worker/schema.sql`）＋定時觸發每小時執行 `worker/src/crawler.ts` 的 `crawl()`（每次最多 6 頁：先掃最近 2 天，剩下的頁數從 60 天前往後補舊資料），掃描零式的公開報告、存入繁中服玩家擊殺的 DPS 與 rDPS（傷害表的 `totalRDPS`）；**換季時更新 `CRAWL_ZONES`**。`GET /tc-rankings?encounter&difficulty&job&minPr&maxPr` 回傳 PR（依每人 rDPS 最好一場計算）在範圍內的玩家的所有擊殺，依 rDPS 排序、重複上傳的只留一筆；前端 `compare/ReferenceFinder.tsx`（從排名找參考日誌、可只顯示隨機機制相同的）。查看掃描狀況：`npx wrangler tail` 或以 `wrangler d1 execute --remote --command` 查 `crawl_state`／`parses`。
- Worker 行為：`ALLOWED_ORIGINS`（`wrangler.toml`）檢查 Origin 並回 CORS 標頭；Cloudflare Rate Limiting 綁定 `RATE_LIMITER`（每 IP 60 次/分）；成功回應以不含 Origin 的 URL 為鍵放進 `caches.default` 10 分鐘。`handler.ts` 不依賴 Workers 型別，快取與 ctx 以參數注入，方便在 Node 的 Vitest 中測試。
- 所有訪客共用同一組 FFLogs API 配額（points/hour），新增查詢時要考慮快取與請求次數；前端的報告查詢已對輸入做 debounce。
- **改了 `worker/` 要記得 `npm run worker:deploy`**；前端依賴的新欄位需先部署 Worker 再推送前端。查詢只「增加」欄位時對舊前端相容。

## 前端比較流程

`App.tsx`（貼連結、選戰鬥與玩家；選擇規則在 `compare/autoSelect.ts` 的 `resolveSelection()`，參考日誌以我的 Boss／職業為 `preferred` 自動選擇：戰鬥只列同 Boss（沒有時 `fightNote`），角色只列同職業、只有一位時 `locked`）→ `compare/Comparison.tsx`（檢查同 Boss／同職業；每邊載入玩家全部事件與敵方施放，共 4 個請求；載入後另查技能繁中名稱）→ `analysis/alignment.ts`（`buildAlignment()` 產生 `mineToRef()`；`pushDifferences()` 找出轉場等推進時間的差距）→ `compare/AdviceList.tsx`（`analysis/advice.ts` 的規則式建議，彙整下列各分析）＋ `compare/Windows.tsx`（技能窗口：`jobs/windowRules.ts` 的職業規則〔移植自 xivanalysis，格式在 `jobs/windows.ts`〕以 `analysis/windows.ts` 評估 `analysis/buffs.ts` 取出的自身效果與施加在敵人身上的效果窗口；開打前效果取自 0:00 的 `combatantinfo.auras`，顯示在摘要表格）＋ `compare/Mechanics.tsx`（`analysis/mechanics.ts` 的 Boss 機制差異）＋ `compare/Metrics.tsx`（`analysis/metrics.ts` 的 GCD 概況、少打 GCD 的時段、技能次數與時機；「冷卻技」分頁為 `analysis/cooldowns.ts` 依 `jobs/cooldownRules.ts`〔移植自 xivanalysis 的 CooldownDowntime〕算出的用了／最多可用與晚用）＋ `compare/Positions.tsx`（`analysis/positions.ts` 的站位差異與對稱判斷、俯視圖〔場地／以 Boss 為中心，`bossPoseAt()`、`toBossFrame()`；Boss 位置取 subType 為 Boss 的角色，見 `load.ts` 的 `bossPositions()`〕；旁邊是 `compare/StatusPanel.tsx` 的當下狀態：血量、Buff／Debuff、Boss 施放）＋ `compare/Timeline.tsx`（以參考時間為橫軸的並排時間軸，可標示區段與捲動到指定時間）。玩家施放時間取開始施放（`load.ts` 的 `playerCasts()` 以 `begincast` 取代 `cast`）；普通攻擊（#7、#8）另存 `autoAttacks`，只列入技能使用次數。GCD 推估上限 2.5 秒（`metrics.ts`）。玩家資料抓 `dataType=All`，施放與位置都從中取得（全部事件中也有別人對玩家的施放，要以 `sourceID` 過濾）。`Comparison.tsx` 持有共用的時間游標 `cursor`（參考時間）、時間軸捲動用的 `focus` 與播放狀態（`compare/Playback.tsx` 固定在畫面底部）；播放時游標頻繁更新，不隨游標變動的區塊要用 `useMemo`／`memo` 避免重繪。所有統計都用裁切到比較範圍的 `mineInRange`／`refInRange`（`clipSide()`），只有時間軸與 Boss 機制差異用完整資料；新增統計時也要用裁切後的資料。

- 演算法實作、實測數據與調整經過見 [docs/TECH_NOTES.md](docs/TECH_NOTES.md)，使用者看到的判定規則見 [docs/DESIGN.md](docs/DESIGN.md)；調整門檻（`maxOccurrences`、`dedupeMs` 等）前先用實際日誌驗證，並把結果記到 TECH_NOTES.md，規則有變時同步更新 DESIGN.md。
- **遊戲版本**：`jobs/patch.ts` 依戰鬥日期對照繁中服的版本日期判斷版本（只處理繁中服日誌；FFLogs 報告沒有版本資訊），並對應到 xivanalysis 規則所用的**國際服版本**（繁中服 7.0～7.15 ＝ 國際服 7.2、繁中服 7.2 起 ＝ 國際服 7.3 的職業技能）；技能窗口規則依國際服版本分（`WindowRule.patches`），兩邊各自評分。**繁中服改版時更新 `TC_PATCHES`**。
- 職業規則：所有 21 個戰鬥職業的基本模組由 `jobs/index.ts` 依 `jobs/generated.ts` 建立（**generated.ts 不要手改**，改 `scripts/gen-job-data.mjs` 的技能名稱後重新執行）；以 FFLogs `subType`（如 `Viper`）查找。之後的職業詳細分析可在 `src/jobs/` 另建檔案擴充。技能分類（ignored／mitigation 自身減傷／partyMitigation 團隊減傷／movement／utility）由 `jobs/roleActions.ts` 的 `abilityCategory()` 決定：職能技能內建，職業專屬技能由模組提供；ignored 的技能在比較開始時就移除。介面上的職業名稱一律用 `jobs/names.ts` 的 `jobName()`（官方繁中）。**憑記憶寫的技能 ID 要先用遊戲資料查證**（方法見 TECH_NOTES.md）。
- React 19 中 `ref` 是保留 prop，元件 prop 不要命名為 `ref`（比較雙方用 `mine` / `reference`）。
- 本機測試可在 `.env.local` 設 `VITE_API_BASE=https://ff14-copycat-api.ff14-copycat.workers.dev` 直接連已部署的 Worker（`ALLOWED_ORIGINS` 已含 `http://localhost:5173`）。測試用公開報告：`WATKBdHRh7m8PNQt`（fight 10 滅團 / 11 擊殺 Sugar Riot，Viper 玩家 source=34）；**使用者指定的比較基準**（皆為 Howling Blade＝M8S 擊殺，驗證功能時兩組都要測）：
  - 武士：我的日誌 `https://www.fflogs.com/reports/FXLkqaK32PhQH8Ac?fight=1`（席德，source 6）、前輩 `https://www.fflogs.com/reports/pwTF16cgnB9G7fWM?fight=29`（安祖卡，source 13）。
  - 騎士：我的日誌 `https://www.fflogs.com/reports/hqNYDGK9A4pmWVXB?fight=18`（神曲莊園，source 40）、前輩 `https://www.fflogs.com/reports/khNfTaMtYwKBd36b?fight=10`（Lavid，source 5）。參考擊殺快 61 秒，可測大幅時間差與坦克技能。
  - **M7S（酷刑大爆彈，換場、Boss 大幅位移）**：武士 `https://www.fflogs.com/reports/dbN4HXY3QPzMRvDw?fight=4`（群青日和，source 6）vs `https://www.fflogs.com/reports/YbakGgfzPQjJ4MK7?fight=5`（布青，source 7）。使用者建議站位、Boss 位置、換場相關的功能以 M7S 與 M8S 測試（上面兩組都是 M8S）。
  - 黑魔道士（驗證用，非使用者指定）：`https://www.fflogs.com/reports/bX97vBapCPwKndL6?fight=3`（春風醒，source 2）vs `https://www.fflogs.com/reports/h6gRJZ2pfDFYMPjX?fight=13`（Nana七，source 28）。
- 所有戰鬥職業都有基本規則（GCD 由遊戲資料的公共冷卻群組判斷）。修改分類或 GCD 判斷後，用 `begincast` 為起點計算 GCD 間隔驗證（方法與結果見 TECH_NOTES.md「職業資料」「實測結果」；舞者、忍者、賢者等有較短的 GCD，短間隔不一定是錯誤）。所有測試日誌與已排除的連結也列在 TECH_NOTES.md「測試資料」。

## 專案目標

一個部署於 GitHub Pages 的 FF14 戰鬥日誌比較工具，協助玩家模仿並學習前輩的操作：

1. 使用者貼上兩個 fflogs.com 報告連結（通常一份是自己、一份是參考的前輩）。
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
- **時間軸對齊**：兩份日誌的擊殺時間、轉場時間不同，單純用絕對時間比較會失準；已實作以 Boss 低頻技能為錨點的分段對齊（`analysis/alignment.ts`）。
- **Boss 隨機機制**：同一機制的隨機變化常使用不同技能 ID（甚至同名不同 ID，例如 Hero's Blow #42079／#42081），站位差異可能是機制造成，見 `analysis/mechanics.ts`。
- **分析邏輯與職業相關**：職業別的規則（GCD 定義、防禦技，之後的冷卻與爆發窗口）放在 `src/jobs/` 的模組，而非寫死在比較流程中。xivanalysis 為開源專案（GitHub: `xivanalysis/xivanalysis`），可作為職業規則與分析模組設計的參考。
- 目前進度、未決事項與後續方向見 [docs/DESIGN.md](docs/DESIGN.md) 的「待辦與未決事項」（技術上的限制見 TECH_NOTES.md）；FFLogs 資料的更多細節（事件量、施放事件、普通攻擊、道具 ID、圖示網址、隨機機制實例）見 [docs/TECH_NOTES.md](docs/TECH_NOTES.md)。
