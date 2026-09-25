# 網站技術紀錄

本文件記錄 https://pinchiehyu.github.io/FF14CopyCat/ 的**技術實作**：架構與部署、Worker API、資料處理與演算法、職業資料產生、外部資料來源、FFLogs 資料特性、測試資料、驗證數據、踩過的坑與技術變更紀錄。網頁的使用流程與判定規則見 [DESIGN.md](DESIGN.md)；開發指令與工作規則見 [CLAUDE.md](../CLAUDE.md)。

新增紀錄時放在對應主題下，註明日期與使用的日誌。

## 架構與部署

```
瀏覽器 ──► GitHub Pages（前端，靜態）
   │
   └──► Cloudflare Worker 代理 ──► FFLogs API v2（GraphQL，client credentials）
                               └─► Boilmaster 鏡像 xivapi-v2.xivcdn.com（技能繁中／簡中名稱）
```

- **前端**：Vite + React + TypeScript，GitHub Pages 專案站台；`vite.config.ts` 的 `base` 由建置時的 `BASE_PATH`（repo 名稱）決定。Pages Source 必須為 GitHub Actions。
- **CI／CD**（`.github/workflows/deploy.yml`）：push 到 `main` 自動執行 lint → 單元測試 → 建置 → 部署 → **冒煙測試**（`scripts/smoke-test.mjs`）。冒煙測試對正式站與 Worker 發出實際請求：確認正式站引用的 JS 是本次建置的檔名（`EXPECTED_SCRIPT`）且指向 Worker、Worker 能回傳報告與含位置的事件、會拒絕未允許的來源；Pages 更新有延遲，最多重試約 1 分鐘。Pull request 只執行到建置。
- **Worker 代理**：https://ff14-copycat-api.ff14-copycat.workers.dev ，持有 FFLogs client ID／secret（Cloudflare Secrets，於儀表板設定），以 client credentials 向 `/api/v2/client` 查詢。不隨 GitHub Actions 部署，要手動 `npm run worker:deploy`；前端依賴新欄位時先部署 Worker 再推送前端。
- **前端的 Worker 網址**：寫在 `src/config.ts`（網址非機密；正式建置用已部署網址、開發模式用 `localhost:8787`），可用 `VITE_API_BASE` 覆寫。Worker 網址或 `ALLOWED_ORIGINS` 變更時兩邊要一起改。

## Worker API（`worker/src/handler.ts`）

只開放固定端點，GraphQL 查詢寫死在 `worker/src/queries.ts`，前端無法送任意查詢：

| 端點 | 內容 | 快取 |
|---|---|---|
| `GET /reports/:code` | 報告標題、fights、masterData.actors、masterData.abilities（技能名稱與圖示） | 10 分鐘 |
| `GET /reports/:code/events?fight&start&end[&source][&dataType][&hostility]` | 一頁事件（`includeResources: true`、`limit: 10000`），前端 `fetchFightEvents()` 依 `nextPageTimestamp` 翻頁 | 10 分鐘 |
| `GET /abilities?ids=1,2,3` | 技能繁中名稱（見「技能繁中名稱」） | 1 天 |
| `GET /npc-names?name=A&name=B` | Boss（NPC）繁中名稱（見「Boss 繁中名稱」） | 1 天 |

- 保護：`ALLOWED_ORIGINS`（`wrangler.toml`）檢查 Origin 並回 CORS 標頭；Cloudflare Rate Limiting 綁定 `RATE_LIMITER`（每 IP 60 次／分）；成功回應以不含 Origin 的網址為鍵放入 `caches.default`。
- client credentials 權杖在同一 isolate 內快取重用。所有訪客共用一組 FFLogs API 配額。
- `handler.ts` 不依賴 Workers 型別，快取與 ctx 以參數注入，可在 Node 的 Vitest 中測試。

## 前端資料處理

### 載入（`src/compare/load.ts`、`src/compare/Comparison.tsx`）
- 每邊 2 個請求：玩家全部事件（`dataType=All&source=玩家`）與敵方施放（`dataType=Casts&hostility=Enemies`）。載入後另以 `/abilities` 查詢兩邊出現過的技能繁中名稱（查詢失敗沿用英文）。
- **玩家施放**（`playerCasts()`）：只取 `sourceID` 為玩家者；有詠唱條的技能以同技能前一個 `begincast`（5 秒內）的時間取代 `cast`；被打斷的只有 `begincast`、不計；任何施放完成時清除尚未完成的 `begincast`（該詠唱已被取消），避免之後瞬發同一技能時配對到過期的開始時間。
- **普通攻擊**（Attack #7、Shot #8）另存 `autoAttacks`。
- **不紀錄的技能**：`withoutAbilities()` 在比較開始時移除 ignored 分類的施放。
- **位置**（`actorPositions()`）：事件中該角色為 source 的 `sourceResources` 或為 target 的 `targetResources`，座標 ÷100 為 yalm，同時間重複取樣去除。Boss 位置取施放最多次的敵人。
- **比較範圍**：參考時間 0～`min(參考長度, mineToRef(我的長度))`；我的一側以 `refToMine` 換回自己的時間後用 `clipSide()` 裁切，得到 `mineInRange`／`refInRange`。所有統計都用裁切後的資料，只有時間軸與 Boss 機制差異用完整資料。
- `Comparison.tsx` 持有共用的時間游標 `cursor`（參考時間）與時間軸捲動用的 `focus`（每次點擊產生新物件以觸發捲動）。
- 技能使用次數的分組由 `compare/usageGroups.ts` 的 `groupUsage()` 決定（普通攻擊、減傷、移動優先於 GCD 判斷），每組一個 `<tbody>`。

### 時間軸對齊（`src/analysis/alignment.ts`）
1. 敵方施放依時間排序；同一技能 1 秒內重複施放視為一次。
2. 錨點候選＝兩份日誌中「同一技能 ID 的第 n 次施放」；任一邊施放超過 8 次的技能不當錨點。
3. 依我的時間排序後取參考時間嚴格遞增的最長子序列（LIS）；同一時間點只留一個錨點。
4. 戰鬥開始 (0, 0) 為隱含錨點；錨點間線性內插、最後錨點後斜率 1 外推。`mineToRef` 與反向 `refToMine` 共用錨點（`piecewise()`）。

### 通用指標（`src/analysis/metrics.ts`）
- `gcdStats()`：GCD 間隔＝1.5～2.6 秒相鄰間隔的中位數，上限 2.5 秒；空檔＝每個間隔超出 GCD＋100 毫秒的部分加總。
- `lostGcdWindows()`：我的相鄰 GCD 間隔 > max(1.5×GCD, GCD＋1 秒) 時，換算到參考時間，計算參考在區間內（兩端各留半個 GCD）的 GCD 數。
- `abilityUsage()`／`matchPairs()`：同一技能兩邊的使用以動態規劃配對（不可交錯、相距 ≤ 30 秒；先求配對數最多、再求時間差總和最小），回傳平均時間差與參考未配對的使用 `unmatchedRef`（減傷／移動建議用）。使用 30 次以上的技能不配對。

### 站位（`src/analysis/positions.ts`）
- `positionAt()`：線性內插；玩家相鄰取樣超過 4 秒不內插、最多沿用 1 秒（`PLAYER_LIMITS`）；Boss 放寬為 30 秒／10 秒（`BOSS_LIMITS`）。
- `compareTracks()`：每 0.5 秒取樣兩人位置；對稱判斷以當下 Boss 位置與場地中心（`estimateCenter()`＝參考 Boss 位置中位數）為中心，做左右、前後、點對稱，取與我最近者。
- `divergences()`：距離 > 8 yalm、持續 ≥ 2 秒、間隔 2 秒內合併；對稱後 ≤ 6 yalm 且 < 原距離一半的點視為可由對稱解釋，同一種對稱超過區段一半時標示。
- `attachMechanics()`：參考日誌的 Boss 施放去重（1 秒）、排除施放超過 8 次的技能，取落在差異區段內、且當下 `distanceAt()` > 8 yalm 的施放，存入 `Divergence.mechanics`。

### Boss 機制差異（`src/analysis/mechanics.ts`）
Boss 施放去重（同技能 1 秒內算一次）、排除施放超過 8 次的技能；我的施放換算成參考時間；同技能在另一邊 5 秒內有施放即算相同；未配對的施放以 1.5 秒內合併成時間點，兩邊都有為 `variant`，否則 `only-mine`／`only-ref`；超過較短一方結束時間的不列。

### 建議（`src/analysis/advice.ts`）
- 輸入各分析結果、`abilityName`（顯示名稱，可能是繁中）、`englishName`（依名稱判斷的規則使用，例如藥水 `/Gemdraught|Tincture|Draught|Potion/`）、`category`（技能分類）。
- 減傷／移動建議使用 `AbilityUsage.unmatchedRef` 列出參考有用而我沒有對應使用的時間（最多 5 個）。
- 與機制差異整合：`mechanicNear()` 找時段開始前 10 秒內到結束之間的 `variant`。

## 職業資料（`src/jobs/`）

- **`scripts/gen-job-data.mjs` → `src/jobs/generated.ts`**（不要手改；遊戲改版後重新執行，約 100 個請求）：
  - 分頁讀取整張 Action 表（`limit=500`、`after`，約 51,500 列）。
  - **GCD**：`CooldownGroup` 或 `AdditionalCooldownGroup` 為 58 的非 PvP 玩家技能（`IsPlayerAction` 或 `ClassJobLevel > 0`），共 735 個 ID，全職業共用。
  - **職業專屬分類**：腳本中以 7.x 英文名稱列出各職業的 ignored／mitigation／movement／utility，依名稱在該職業與基本職業（例如 PLD 與 GLA）的技能中查 ID，找不到再找沒有 ClassJob 的變形技能；**名稱找不到就報錯**。
- `jobs/index.ts`：依 generated.ts 建立 21 個職業的 `JobModule`（`isGcd` 共用 `GCD_IDS`）。之後的詳細分析可在 `jobs/` 另建檔案擴充。
- `jobs/roleActions.ts`：職能技能分類（ignored：Provoke、Shirk、各坦姿與解除；mitigation：Rampart、Reprisal、Feint、Addle；movement：Sprint、Peloton；utility：其餘）與 `abilityCategory(id, job)`。
- `jobs/names.ts`：`jobName(subType)`，官方繁中職業名稱（ClassJob 表 `language=tc`）。
- **驗證方法**：以實際日誌計算以 `begincast` 為起點的相鄰 GCD 間隔，分布應集中在該職業 GCD 附近；短間隔需確認是否為較短的 GCD（舞步、結印等）。技能 ID 以 `https://xivapi-v2.xivcdn.com/api/sheet/Action?rows=<ids>&fields=Name,ClassJob.Abbreviation&language=en` 查證，憑記憶寫入的 ID 都應先查證。

## 技能繁中名稱（`worker/src/abilityNames.ts`）

- Worker `GET /abilities?ids=`：依 ID 範圍決定查哪張表（`gameRow()`）——小於 1,000,000 為 Action 表；`0x2000000 + 道具 ID`（HQ 再加 1,000,000）為 Item 表。向 Boilmaster 鏡像批次（每批 100 個）查 `language=tc`；結果為 `_rsv_…` 佔位或空白者再查 `language=chs`，以 opencc-js（`opencc-js/cn2t`，`from: 'cn', to: 'tw'`，只轉字元與台灣異體字、不改用詞）轉繁。HQ 道具名稱加「（HQ）」。回傳 `{ FFLogs ID: { name, source: 'tc' | 'chs' } }`，都沒有的不回傳。最多 500 個 ID，不在兩種範圍內的 ID 回 400。
- 前端（`fetchAbilityNames()`、`Comparison.tsx` 的 `useAbilityNames()`）：以繁中取代 `Ability.name`，英文保留在 `Ability.englishName`。
- Worker 打包後 2 MB（gzip 503 KB），大部分是簡轉繁詞典；免費方案上限 3 MB。快取未命中時查詢約需 8 秒。

## Boss 繁中名稱（`worker/src/npcNames.ts`）

- FFLogs 的 `fight.name` 與 NPC 角色名稱都是英文；NPC 的 `gameID`（例如 Howling Blade 為 18215）是 BNpcBase，**不是** BNpcName 表的列（查 BNpcName/18215 得 404）。
- 因此以英文名稱搜尋：`/api/search?sheets=BNpcName&query=Singular="<name>"&language=en&limit=1`，取第一列再以 `/api/sheet/BNpcName/<row>?fields=Singular&language=tc` 取繁中；沒有時查 `chs` 以 opencc 轉繁。搜尋區分大小寫，找不到時再以全小寫重查（遊戲中部分 NPC 名稱為小寫，例如 living liquid）。
- Worker `GET /npc-names`：`name` 參數最多 20 個，只允許 `[A-Za-z0-9 '\-.,:!&]`（避免注入搜尋語法），否則 400。回傳 `{ 英文: { name, source } }`，查不到的不回傳。
- 每個名稱的 xivapi 請求逾時 8 秒；有名稱逾時或失敗時仍回 200（該名稱不回傳），但回應只快取 60 秒，之後可重查。
- 前端（`App.tsx` 的 `useReport()`）：報告載入後**先以英文顯示並可立即選擇**，另以 `fetchFightNames()` 查詢，查到後以 `translateReport()` 把 `Fight.name` 換成繁中、英文放在 `Fight.englishName`。戰鬥名稱以 `/` 拆段逐段翻譯（FFLogs 對多 NPC 的戰鬥用 `a / b / ...` 命名），不合規則的段落（如 `...`）不送出。查詢失敗時沿用英文。
- 名稱晚到會換掉 `Selection` 物件，`Comparison.tsx` 的 `useSides()` 只依選擇的鍵（報告／戰鬥／角色 ID）重新載入，避免重抓事件。
- 第一版在報告載入時等待翻譯才顯示，名稱未快取時約 7 秒（騎士基準報告 4 個名稱），正式站上曾停在「載入報告中」，因此改為不阻擋。
- 實測：Howling Blade→呼嘯之劍、Dancing Green→熱舞綠光、Sugar Riot→糖彩狂潮、Brute Abombinator→野蠻憎惡、Valigarmanda→艷翼蛇鳥、living liquid→有生命活水、Cruise Chaser→巡航驅逐者、Queen Eternal→永恆女王；Striking Dummy 查不到（保留英文）。

## 測試資料

| 用途 | 我的日誌 | 參考（高階玩家） | 備註 |
|---|---|---|---|
| **武士比較基準**（使用者指定） | `FXLkqaK32PhQH8Ac` #1，席德（source 6），Howling Blade 擊殺 13:50 | `pwTF16cgnB9G7fWM` #29，安祖卡（source 13），13:56 | 驗證功能時必測 |
| **騎士比較基準**（使用者指定） | `hqNYDGK9A4pmWVXB` #18，神曲莊園（source 40），Howling Blade 擊殺 13:53 | `khNfTaMtYwKBd36b` #10，Lavid（source 5），12:52 | 參考快 61 秒，可測大幅時間差與坦克技能 |
| 黑魔道士驗證 | `bX97vBapCPwKndL6` #3，春風醒（source 2），13:40 | `h6gRJZ2pfDFYMPjX` #13，Nana七（source 28），13:01 | |
| 暗黑騎士驗證 | `FXLkqaK32PhQH8Ac` #1，倉鼠教徒（source 4） | `pwTF16cgnB9G7fWM` #29，穎嵐（source 71） | 坦姿不紀錄與減傷建議 |
| 同隊滅團 vs 擊殺、冒煙測試 | `WATKBdHRh7m8PNQt` #10（Sugar Riot 滅團，Risen／毒蛇劍士 source 34） | 同報告 #11（擊殺） | 冒煙測試固定使用這份報告 |
| 不同隊伍的對齊測試 | `pwTF16cgnB9G7fWM` #29 | `bX97vBapCPwKndL6` #3（13:40）、`h6gRJZ2pfDFYMPjX` #13（13:01） | 後者為同一玩家安祖卡 |

已排除的連結：`bX97vBapCPwKndL6` #3 沒有武士參戰（報告中的武士 瓏系莉亞 未參與任何一場戰鬥）；`h6gRJZ2pfDFYMPjX` #4 是 Dancing Green，與 Howling Blade 不同 Boss。

## FFLogs 資料特性

- **時間**：事件 `timestamp` 相對於整份報告開始；需減去 fight 的 `startTime`。
- **連結格式**：`fight`、`source` 可能在 hash（`#fight=5`）或 query string（`?fight=29`）；`fight=last` 代表最後一場；區域子網域（`tw.`、`cn.`）也會出現在網址中；匿名報告代碼以 `a:` 開頭。
- **玩家清單**：`masterData.actors` 中 type 為 `Player` 的包含極限技假角色（subType `LimitBreak`，名稱 `Limit Break`、`Multiple Players`）與 subType `Unknown` 的重複項。`fights[].friendlyPlayers` 列出參戰者；報告中可能有角色沒有參與任何戰鬥。subType 等於英文職業名稱去空白（`BlackMage`、`DarkKnight`）。
- **事件量**（單一玩家整場，約 13 分鐘）：
  | 查詢 | 位置取樣 | 中位間隔 | 最大間隔 | 大小 |
  |---|---|---|---|---|
  | `dataType=Casts&source=玩家` | 0.62 筆/秒 | 1.4 秒 | 47 秒 | 213 KB |
  | `dataType=DamageDone` | 0.90 筆/秒 | 0.9 秒 | 48 秒 | 798 KB |
  | `dataType=All&source=玩家` | 1.80 筆/秒 | 0.4 秒 | 3.7 秒 | 1.7 MB |

  `limit: 10000` 時一頁通常就能取完。`Buffs` 沒有位置資料。
- **位置**：`sourceResources`／`targetResources` 的 `x`、`y`（1/100 yalm，場地中心約 (10000, 10000)）、`facing`；需要 `includeResources: true`。
- **施放事件**：有詠唱條的技能先有 `begincast`、詠唱結束才有 `cast`；被打斷的只有 `begincast`。開場預詠唱（例如黑魔的 Fire III）沒有 `begincast`。
- **普通攻擊**：`dataType=All` 中每場約 300 次 `cast`（Attack #7；遠程為 Shot #8），`dataType=Casts` 中沒有。
- **技能與道具 ID**：技能即遊戲的 Action ID；使用道具以 **`0x2000000`（33,554,432）＋道具 ID** 表示，HQ 道具再加 1,000,000。例：34600427 = 33,554,432 + 1,000,000 + 45995（Grade 3 Gemdraught of Strength，繁中「3級剛力之寶藥」）、34600428 → 45996（巧力）、34600430 → 45998（智力）。以 Item 表 `language=en／tc／chs` 驗證過（2026-09-26）。
- **圖示**：`masterData.abilities[].icon`（如 `003000-003729.png`），網址 `https://assets.rpglogs.com/img/ff/abilities/<icon>`（`/icons/` 路徑會 403）。
- **Boss**：施放最多次的敵人為主 Boss（Howling Blade 有多個同名 actor）。部分 Boss 技能沒有名稱（42672 顯示為 `unknown_a6b0`）。
- **隨機機制**：同一機制的隨機變化使用不同技能 ID，甚至同名不同 ID。Howling Blade：Windfang／Stonefang、Eminent Reign／Revolutionary Reign、Wolves' Reign（#41880/#43369 vs #42927/#43370 等）、Hero's Blow（#42079/#42080 vs #42081/#42082）、Sand Surge（#43138 vs #43520）。
- **語系**：FFLogs 有 `cn.`、`ja.` 等子網域，**沒有 `tw.fflogs.com`**；API 的 `translate` 只翻成英文。

## 外部資料來源調查：技能繁中名稱（2026-09-25）

| 來源 | 結果 |
|---|---|
| FFLogs | 沒有繁中（見上） |
| XIVAPI v2（`v2.xivapi.com`） | 只有國際版語言 en、ja、de、fr |
| Boilmaster 鏡像（`xivapi-v2.xivcdn.com`） | 支援 `language=chs` 與 `language=tc`；`cht`、`zh`、`zh-TW` 回 400。`/api/sheet/Action?rows=1,2,3&fields=Name&language=tc` 可批次查詢，`limit` 上限 500 |

| 技能 | en | ja | chs | tc |
|---|---|---|---|---|
| 7490 | Hissatsu: Shinten | 必殺剣・震天 | 必杀剑·震天 | 必殺劍·震天 |
| 34606 | Steel Fangs | 壱の牙【咬創】 | 咬噬尖齿 | 壹之牙【咬創】（與簡中用詞不同，不能用簡轉繁代替） |
| 36921 | Imperator | インペラトル | 绝对统治 | 絕對統治 |
| 41880（Boss，較舊） | Wolves' Reign | 群狼剣 | 群狼剑 | 群狼劍 |
| 42079（Boss，新版本） | Hero's Blow | 鎧袖一触 | 摧枯拉朽 | `_rsv_42079_-1_7_0_0_…`（佔位） |
| 42672（Boss） | （空白） | （空白） | （空白） | （空白） |

新內容的名稱在客戶端資料中以 `_rsv_` 佔位、由伺服器提供，資料挖掘拿不到。

## 職業與技能 ID 查證（2026-09-25）

- **職業繁中名稱**（ClassJob 表 `language=tc`）：騎士、戰士、暗黑騎士、絕槍戰士、白魔道士、學者、占星術師、賢者、武僧、龍騎士、忍者、武士、奪魂者、毒蛇劍士、吟遊詩人、機工士、舞者、黑魔道士、召喚士、赤魔道士、繪靈法師、青魔道士。先前自行翻譯的「黑魔法師」「蝰蛇劍士」與官方不符，已改正。
- **坦克姿態與職能技能 ID**：Provoke 7533、Shirk 7537、Iron Will 28、**Release Iron Will 32065**、Defiance 48、Release Defiance 32066、Grit 3629、Release Grit 32067、Royal Guard 16142、Release Royal Guard 32068、Rampart 7531、Reprisal 7535、Feint 7549、Addle 7560、Sprint 3、Peloton 7557、Third Eye 7498、Tengentsu 36962。**ID 38 是戰士的 Berserk**，先前騎士模組誤把它當成 Release Iron Will。

## 實測結果

### 時間軸對齊
| 比較 | 錨點 | 時間差 | 觀察 |
|---|---|---|---|
| 同隊 Sugar Riot 滅團 vs 擊殺（`WATKBdHRh7m8PNQt` #10／#11） | 107 | -0.1～+0.3 秒 | 腳本幾乎完全一致 |
| 不同隊伍 Howling Blade（`pwTF16cgnB9G7fWM` #29／`bX97vBapCPwKndL6` #3） | 197 | -4.3～+0.2 秒 | 時間差呈階梯狀（0 → -2.6 → -4 秒），對應轉場提前 |
| 參考快 55 秒（`pwTF16cgnB9G7fWM` #29／`h6gRJZ2pfDFYMPjX` #13） | 175 | -16.5～+0.7 秒 | 0～206 秒為 0，之後 -3.5、-5.6，約 400 秒起穩定 -16.4 秒 |
| 武士比較基準 | 194 | -6.8～+0.2 秒 | |
| 騎士比較基準 | 171 | -9.3～+1.4 秒 | |
| 黑魔驗證 | 161 | -12.5～+0.7 秒 | |

原型比較：不限制施放次數時，高頻的 42672（50 次以上）造成錯誤配對（假的 3.8～6.9 秒時間差）並把正確錨點擠掉；限制 ≤ 8 次後回到 -0.1～+0.3 秒。最大無錨點區間 56 秒（402～459 秒，Howling Blade 轉場）；轉場提前是跳躍，但線性內插會把它平均分散在區段內。

### 比較範圍
騎士（我長 61 秒）排除我最後 52.2 秒後，GCD 差距從 -5 變為 -25；武士排除參考最後 13.5 秒，GCD 差距從 -18 變為 -12。

### 通用指標（比較基準）
| | 武士（席德／安祖卡） | 騎士（神曲莊園／Lavid） | 黑魔（春風醒／Nana七） |
|---|---|---|---|
| GCD 數（比較範圍內） | 342／354 | 260／285 | 315／311 |
| GCD 間隔 | 2.175／2.141 秒 | 2.497／2.500 秒（Lavid 原始中位數 2.505，受上限） | 2.443／2.408 秒 |
| 空檔總計 | 80.7／62.4 秒 | 122.7／58.5 秒 | 52.4／52.7 秒 |
| 少打 GCD 的時段 | 4 段共 6 個（最大 8:01 停手 9.1 秒） | 13 段共 19 個 | 1 段共 2 個 |
| 普通攻擊 | 294／298 | 296／293 | |

武士的 GCD 差距中，約 14 秒（36 毫秒 × 約 380 次）來自 GCD 較慢。

### 站位
武士比較基準：15 段差異，11 段標示可能對稱。7:29 起（第二階段平台）兩人持續相距約 33 yalm。30 秒平均座標（參考時間約早 6.8 秒）：

| 我的時間 | 我 | 我的 Boss | 參考 | 參考的 Boss |
|---|---|---|---|---|
| 450 秒 | (113, 107) | (100, 102) | (88, 103) | (100, 101) |
| 570 秒 | (110, 92) | (93, 93) | (89, 91) | (108, 93) |
| 600 秒 | (115, 105) | (113, 101) | (99, 118) | (87, 100) |
| 810 秒 | (83, 105) | (87, 95) | (116, 106) | (114, 98) |

兩隊東西相反，連 Boss 也相反；同時段 Boss 機制差異顯示 Hero's Blow 方向不同，很可能是機制造成。第一階段的對稱標示尚未驗證。

### Boss 機制差異
- 武士比較基準：13 處，12 處為隨機變化；另有 6:39 Extraplanar Pursuit 只有我。
- 騎士比較基準：20 處，11 處為隨機變化；其餘多為只有我（Moonbeam's Bite ×4、Fanged Charge、Fanged Maw，參考快 61 秒跳過）。

### 減傷與移動建議
騎士比較基準：干預少用 5 次、雪仇少用 3 次、壁壘少用 3 次、衝刺少用 3 次、鐵壁有 2 次時機不同、極致防禦平均晚 9.4 秒。武士：天眼通少用 6 次、衝刺 0 vs 6 次、牽制少用 5 次。暗黑騎士驗證：暗影步少用 4 次、雪仇少用 3 次、獻奉與鐵壁時機不同；深惡痛絕、挑釁、退避不出現。

### GCD 判斷規則與全職業驗證
- **規則**：Action 表 `CooldownGroup` 或 `AdditionalCooldownGroup` 為 58。以 37 個已人工分類的技能核對（18 GCD、19 oGCD）全部相符，包括 ClassJob 為空的變形技能（Midare Setsugekka，`IsPlayerAction` 為 false）與有充能的 GCD（Vicewinder：`CooldownGroup` 15、`AdditionalCooldownGroup` 58）。唯一不同是 **Meditate（7497）**：類別是 Ability、60 秒冷卻，但 `AdditionalCooldownGroup` 58 會觸發公共冷卻，占一個 GCD，資料的判斷才正確，人工分類錯了。自動集合涵蓋手寫四個職業全部 95 個 GCD。
- **全職業驗證**（以 begincast 為起點的相鄰 GCD 間隔，6 場 Howling Blade 戰鬥、55 位玩家、19 個職業；沒有奪魂者的日誌）：

  | 結果 | 職業 |
  |---|---|
  | 沒有小於 1.5 秒的間隔 | 騎士、戰士、暗黑騎士、絕槍戰士、白魔道士、學者、龍騎士、武士、毒蛇劍士、吟遊詩人、繪靈法師 |
  | 短間隔是 GCD 本身較短（分類正確） | 舞者 舞步約 1.0 秒；忍者 結印約 0.5 秒；賢者 Eukrasia 約 1.0 秒；武僧 Forbidden Meditation 約 1.0 秒；機工士 Blazing Shot 約 1.5 秒；召喚士 Emerald Rite 約 1.5 秒；赤魔道士 近戰連擊約 1.5 秒 |
  | 開場預詠唱 | 黑魔道士 Fire III → High Thunder 約 0.6 秒；赤魔道士 Veraero III → Verthunder III 約 0.6 秒 |
  | 負的間隔（資料處理錯誤，已修正） | 占星術師、赤魔道士：詠唱被取消後殘留的 begincast 配對到之後瞬發的同一技能 |

- 各職業 GCD 間隔中位數：多數約 2.41～2.50 秒；武士 2.14～2.18、毒蛇劍士 2.10～2.14、忍者 2.10、武僧 1.93、黑魔道士 2.15～2.44（依黑魔紋）。
- 手寫模組時期的驗證：武士集中 2.0～2.25 秒（以 `cast` 計時時，約 1.33 秒者皆在居合術等詠唱技能之後）；騎士集中 2.45～2.5 秒，560 多個 GCD 中只有一個 1.52 秒；毒蛇劍士技能 ID 34606–34633 為 GCD、34634–34647 為 oGCD。

## 參數調整與錯誤修正經過

- **平均時機配對**：初版第 n 次對第 n 次，次數不同時後面全部錯位，出現「Feint 晚 164.8 秒」「Hagakure 早 434.9 秒」；改為可跳過的動態規劃配對、30 秒窗口後合理（Tengentsu 早 0.8 秒、Feint 晚 2.3 秒）。
- **Boss 機制差異窗口**：初版同技能 1.5 秒內才算相同，把轉場附近差 2～3 秒的同一機制（Moonbeam's Bite）列成「只有我」＋「只有參考」；放寬為 5 秒後武士從 18 處降為 13 處。
- **對稱站位判斷**：只以 Boss 為中心時，第二階段連 Boss 都相反的情況判斷不出來；加入場地中心後 13／15 段被標示，太寬鬆；要求同一種對稱解釋過半時間、對稱後 ≤ 6 yalm 後為 11／15。
- **Boss 位置內插**：Boss 位置只來自 Boss 施放、取樣稀疏，沿用玩家的 4 秒內插限制時大多取不到位置，改為 30 秒／10 秒。
- **位置資料來源**：只抓施放時位置最大間隔 47 秒，改抓全部事件（最大 3.7 秒），請求數不變。
- **建議清單**：初版把連擊 GCD（Shifu、Jinpu…）的次數差列為「冷卻好就用」、把坦克減傷列為少用，是錯誤建議；改為只比較 oGCD、加入技能分類並合併次要項目，武士從 27 則減為 15 則。
- **GCD 上限**：使用者指出 GCD 最長 2.5 秒；實測間隔受延遲影響略長（2.505 秒），改為取樣到 2.6 秒、推估上限 2.5 秒。
- **普通攻擊**：改抓全部事件後出現約 300 個 Attack 圖示塞滿 oGCD 列；改為另存 `autoAttacks`，不畫在時間軸但列入技能次數。
- **技能分類**：原本把坦克減傷、挑釁、衝刺都歸為低優先；依使用者意見改為四類分類與專屬建議。
- **GCD 判斷**：手寫清單改為遊戲資料的公共冷卻群組（手寫時曾把 Meditate 判為 oGCD、把 ID 38 誤當成 Release Iron Will）。
- **取消的詠唱**：施放完成時清除過期的 begincast（全職業驗證時在占星術師、赤魔道士發現負的間隔）。
- **機制結算時的站位差異**：初版取「差異區段與機制結算前 3 秒～後 1 秒重疊」，武士比較基準 15 段全被標示，且掛上還沒分開時結算的機制（例如 0:47.1 群狼劍，當下只相距 2.8 yalm）；改為「結算時間在區段內且當下相距 > 8 yalm」後，列出的機制都確實相距超過門檻。Howling Blade 機制密集，15 段仍全部有機制結算，屬實；建議依是否同時少打 GCD 與距離挑出最多 5 段。

## 部署與開發踩過的坑

- **GitHub Pages 重複部署**：Pages Source 設成 Deploy from a branch 時，GitHub 另外跑 `pages build and deployment` 把原始碼（未建置的 `index.html`）發布上去，與 Actions 的部署互相覆蓋；需改為 GitHub Actions。冒煙測試會檢查頁面是否引用 `/src/` 原始碼。
- **Actions 變數未生效**：原本以 repo variable `API_BASE` 注入 Worker 網址，建置時讀到空值導致正式站連 `localhost:8787`；網址非機密，改寫在 `src/config.ts`。
- **Cloudflare Secret 未部署的版本**：在儀表板刪除 Secret 而未按 Deploy 時，會產生未部署的新版本；下次 `wrangler deploy` 會以最新設定為準而使 Secret 消失。用 `npx wrangler secret list`、`versions list`、`deployments status` 檢查。
- **wrangler login**：自動開啟瀏覽器失敗時，用 `npx wrangler login --browser=false` 取得網址讓使用者手動開啟。
- **GitHub SSH**：本機 `known_hosts` 有 GitHub 2023 年前的舊 RSA 金鑰導致警告；使用者需自行把 SSH 金鑰加到 GitHub。
- **npm 安裝腳本**：npm 11 預設阻擋 esbuild、workerd 的 postinstall（allow-scripts 警告），實際不影響建置與 `wrangler dev`。
- **瀏覽器平滑捲動**：同時對頁面（`scrollIntoView` smooth）與內層容器（`scrollTo` smooth）平滑捲動時，瀏覽器會中斷內層捲動；內層改為立即設定 `scrollLeft`。
- **React 19 `ref` prop**：元件 prop 命名為 `ref` 會被當成保留 prop（lint 報 Cannot access refs during render），改名為 `reference`。
- **瀏覽器快取**：推送後正式站可能仍顯示舊版，加查詢字串（例如 `?v=<commit>`）或重新整理即可。
- **技能名稱查詢延遲**：`/abilities` 快取未命中時約 8 秒；在瀏覽器驗證繁中名稱時要等比較載入後再多等幾秒。
- **PowerShell 5.1 寫檔**：`Set-Content -Encoding utf8` 會在檔案開頭加 BOM；改用 Edit／Write 工具或 Node 寫檔。

## 技術上的已知限制

- 轉場提前是跳躍，錨點間線性內插會把跳躍平均分散在區段內（最長 56 秒無錨點），誤差數秒；可改為偵測轉場點（Boss 目標切換、無敵等）分段對齊。
- 技能繁中名稱依賴第三方 Boilmaster 鏡像，失效時退回英文。
- 冒煙測試只用固定的測試報告 `WATKBdHRh7m8PNQt`；若該報告被刪除或設為私人，冒煙測試會失敗，需換報告。
- 奪魂者尚未以實際日誌驗證 GCD 分類。

## 技術變更紀錄

使用流程與設計的變更見 DESIGN.md 的「設計變更紀錄」。

### 2026-09-26 共用分頁元件；職能分類
- 變更：新增 `src/ui/Tabs.tsx`（role=tablist，左右鍵切換，選中的分頁消失時回到第一個），用於建議與技能使用次數；`Dropdown` 新增 `disabled`；`jobs/names.ts` 新增 `jobRole()`（tank／healer／dps）；`resolveSelection()` 回傳 `locked`，有 `preferred` 時 `players` 只含同職業玩家。
- 原因：介面改為分頁與鎖定參考角色（見 DESIGN.md）。

### 2026-09-26 Boss 名稱查詢；自訂下拉選單
- 變更：Worker 新增 `/npc-names`（BNpcName 以英文搜尋）；前端載入報告後翻譯戰鬥名稱；新增 `src/ui/Dropdown.tsx` 取代戰鬥與角色的原生 `<select>`。Worker 已部署。
- 原因：NPC 的 gameID 對不到名稱表，只能以英文名稱搜尋；原生 `<select>` 的選項無法排版徽章。

### 2026-09-26 道具名稱查詢
- 變更：Worker `/abilities` 依 ID 範圍改查 Item 表（`gameRow()`），前端也送出道具範圍的 ID；Worker 已部署。
- 原因：爆發藥等道具的 FFLogs ID 為 `0x2000000 + 道具 ID`（HQ 加 1,000,000），可對應到 Item 表的官方繁中名稱。

### 2026-09-25 所有職業的規則由遊戲資料產生
- 變更：新增 `scripts/gen-job-data.mjs` 產生 `src/jobs/generated.ts`（GCD 集合與 21 個職業的技能分類），取代手寫的四個職業模組；Peloton 改為移動；施放完成時清除過期的 `begincast`。
- 原因：以遊戲資料判斷 GCD 比手寫清單完整且不易出錯；全職業驗證時發現取消詠唱的問題。

### 2026-09-25 技能分類與職業名稱模組
- 變更：新增 `jobs/roleActions.ts`（`abilityCategory()`）與 `jobs/names.ts`（`jobName()`）；`JobModule` 以 ignored／mitigation／movement／utility 取代原本的 `utility`；`AbilityUsage` 加入 `unmatchedRef`；比較開始時以 `withoutAbilities()` 移除 ignored 技能。
- 原因：配合技能分類與職業名稱的設計變更。

### 2026-09-25 技能繁中名稱
- 變更：Worker 新增 `/abilities`，查 Boilmaster 鏡像並以 opencc-js 簡轉繁；新增外部依賴 `xivapi-v2.xivcdn.com`。
- 原因：FFLogs 與官方 XIVAPI 都沒有繁中。

### 2026-09-25 比較範圍裁切
- 變更：對齊加入 `refToMine`；新增 `clipSide()`，統計改用裁切後的資料。
- 原因：配合「只比較兩場戰鬥重疊的時段」。

### 2026-09-25 玩家事件改抓全部事件
- 變更：玩家資料由 `dataType=Casts` 改為 `dataType=All`，施放、普通攻擊、位置都從中取得。
- 原因：只抓施放時位置取樣太稀疏。

### 2026-09-25 施放時間改用 begincast
- 變更：有詠唱條的技能以 `begincast` 為施放時間。
- 原因：`cast` 事件在詠唱結束時，時間軸與 GCD 間隔會偏差約 1.3 秒。

### 2026-09-25 部署後自動冒煙測試
- 變更：CI 在部署後執行冒煙測試，以實際請求驗證正式站與 Worker。
- 原因：使用者要求每次推送都自動建置並測試；單元測試無法發現部署層面的問題（例如 Pages 來源設定錯誤、Worker 網址錯誤）。

### 2026-09-25 報告查詢加入技能資料
- 變更：Worker 的報告查詢加入 `masterData.abilities`（技能名稱與圖示）。
- 原因：時間軸需要技能圖示與名稱。

### 2026-09-25 Worker 網址改寫在程式中
- 變更：前端的 Worker 網址由 GitHub Actions 變數 `API_BASE` 改為寫在 `src/config.ts`，`VITE_API_BASE` 僅作覆寫用。
- 原因：網址非機密；建置時變數未被讀到導致正式站連到 localhost。

### 2026-09-25 改用 Cloudflare Worker 代理（取代 OAuth PKCE）
- 變更：移除前端的 FFLogs PKCE 登入，改由 Cloudflare Worker 以 client credentials 代為查詢，只開放固定 REST 端點。
- 原因：client secret 無法放在 GitHub Pages 靜態網站中，需要伺服器端代理才能讓訪客免登入。
- 代價：需維護 Cloudflare 帳號；所有訪客共用 API 配額，因此加入快取與限流。

### 2026-09-25 初始架構
- 變更：建立 Vite + React + TypeScript 專案，部署到 GitHub Pages（專案站台，base path 由 repo 名稱決定）；FFLogs 驗證採 OAuth PKCE。
- 原因：專案需在 github.io 上執行，只能是靜態網站；PKCE 不需要 client secret。
