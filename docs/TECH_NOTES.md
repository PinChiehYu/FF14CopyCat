# 網站技術紀錄

本文件記錄 https://pinchiehyu.github.io/FF14CopyCat/ 的**技術實作**：架構與部署、Worker API、資料處理與演算法、職業資料產生、外部資料來源、FFLogs 資料特性、測試資料、驗證數據、踩過的坑與技術變更紀錄。網頁的使用流程與判定規則見 [DESIGN.md](DESIGN.md)；開發指令與工作規則見 [CLAUDE.md](../CLAUDE.md)。

新增紀錄時放在對應主題下，註明日期與使用的日誌。

## 架構與部署

```
瀏覽器 ──► GitHub Pages（前端，靜態）
   │
   └──► Cloudflare Worker 代理 ──► FFLogs API v2（GraphQL，client credentials）
            │                  └─► Boilmaster 鏡像 xivapi-v2.xivcdn.com（技能繁中／簡中名稱）
            └── D1 資料庫 ff14-copycat-rankings（繁中服排名）◄── 定時觸發（每 15 分鐘掃描公開報告）
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
| `GET /abilities?ids=1,2,3` | 技能、效果（Buff）與道具的繁中名稱（見「技能繁中名稱」） | 1 天 |
| `GET /npc-names?name=A&name=B` | Boss（NPC）繁中名稱（見「Boss 繁中名稱」） | 1 天 |
| `GET /reports/:code/auto-attacks-taken?fight=` | 每位玩家承受的敵方普通攻擊總傷害 `{ 角色 ID: 傷害 }`，判斷 MT／ST（見「MT／ST 判斷」） | 10 分鐘 |
| `GET /reports/:code/targetability?fight&start&end` | 敵方可否選中的變化 `[{ timestamp, sourceID, targetable }]`（`TARGETABILITY_QUERY`：`hostilityType: Enemies`、`filterExpression: "type = 'targetabilityupdate'"`；`dataType=Casts` 的事件不含這類事件，`All` 又太大） | 10 分鐘 |
| `GET /tc-rankings?encounter&difficulty&job&minPr&maxPr` | 繁中服排名（D1）中 PR 在範圍內的紀錄 `{ count, rankings }`，最多 100 筆（見「繁中服排名」） | 5 分鐘 |

- 保護：`ALLOWED_ORIGINS`（`wrangler.toml`）檢查 Origin 並回 CORS 標頭；Cloudflare Rate Limiting 綁定 `RATE_LIMITER`（每 IP 60 次／分）；成功回應以不含 Origin 的網址為鍵放入 `caches.default`。
- client credentials 權杖在同一 isolate 內快取重用。所有訪客共用一組 FFLogs API 配額。
- `handler.ts` 不依賴 Workers 型別，快取與 ctx 以參數注入，可在 Node 的 Vitest 中測試。

## 前端資料處理

### 載入（`src/compare/load.ts`、`src/compare/Comparison.tsx`）
- 每邊 3 個請求：玩家全部事件（`dataType=All&source=玩家`）、敵方施放（`dataType=Casts&hostility=Enemies`）與敵方可否選中（`/targetability`，失敗時當成沒有）。載入後另以 `/abilities` 查詢兩邊出現過的技能繁中名稱（查詢失敗沿用英文）。
- **玩家施放**（`playerCasts()`）：只取 `sourceID` 為玩家者；有詠唱條的技能以同技能前一個 `begincast`（5 秒內）的時間取代 `cast`；被打斷的只有 `begincast`、不計；任何施放完成時清除尚未完成的 `begincast`（該詠唱已被取消），避免之後瞬發同一技能時配對到過期的開始時間。
- **普通攻擊**（Attack #7、Shot #8）另存 `autoAttacks`。
- **不紀錄的技能**：`withoutAbilities()` 在比較開始時移除 ignored 分類的施放。
- **位置**（`actorPositions()`）：事件中該角色為 source 的 `sourceResources` 或為 target 的 `targetResources`，座標 ÷100 為 yalm，同時間重複取樣去除。Boss 位置取施放最多次的敵人。
- **比較範圍**：參考時間 0～`min(參考長度, mineToRef(我的長度))`；我的一側以 `refToMine` 換回自己的時間後用 `clipSide()` 裁切，得到 `mineInRange`／`refInRange`。所有統計都用裁切後的資料，只有時間軸與 Boss 機制差異用完整資料。
- **Boss 無法選中**（`untargetableSpans()` → `SideData.untargetable`）：subType 為 Boss 的角色**全部**無法選中的時段（1 秒以上）。各 Boss 第一次變化是「變成無法選中」時，開打時可選中；反之開打時不可選中（M8S 第二階段的 Boss 本體是另一個角色，第一次變化是「變成可選中」）。光狼等 NPC 不算。實測 M8S `BF76r8yKh4wGaYkm` #10：3:01.6～4:00.2（召喚光狼）、4:45.0～4:51.8、6:40.1～7:25.6（轉場）；`dLWJGqBC9ZrmPDa4` #5：3:02.3～4:03.6、4:48.3～4:55.2、6:32.1～7:17.6。
- **並排時間軸的橫軸**（`analysis/displayAxis.ts` 的 `displayAxis()`）：平常為參考時間；推進差距（`pushDifferences()` 的相鄰錨點區段 `mineStart～mineEnd`／`refStart～refEnd`）兩邊各自照實際長度排開，較慢一方多花的時間在較快一方補上空白（`gaps`，我較慢時在參考推進結束後插入），推進後兩邊接回同一位置。`ref()`／`mine()` 把各自的時間換成顯示時間，`toRef()` 供點擊時間尺換回參考時間（落在空白時取推進完成的時間）。只影響時間軸；游標、播放與其他統計仍用參考時間。原本我多花的時間會被擠進參考推進的短區段（M8S 實例：我 6:29～6:40 的施放擠在參考 6:31.6～6:32.0）。
- **Boss 的普通攻擊名稱**：各 Boss 專用的普通攻擊常沒有遊戲名稱（例：M8S #42228，Action 表 en／tc／chs／ja 都是空字串），FFLogs 記為 `Attack`；`Comparison.tsx` 對英文名稱為 `Attack` 且查不到繁中的技能，改用 Action 7（普通攻擊）的繁中名稱「攻擊」。
- `Comparison.tsx` 持有共用的時間游標 `cursor`（參考時間）與時間軸捲動用的 `focus`（每次點擊產生新物件以觸發捲動）。
- 技能使用次數的分組由 `compare/usageGroups.ts` 的 `groupUsage()` 決定（普通攻擊、減傷、移動優先於 GCD 判斷），每組一個 `<tbody>`。

### 時間軸對齊（`src/analysis/alignment.ts`）

目的：把「我」的戰鬥時間換算成參考日誌中「同一個機制」的時間（`mineToRef()`，反向為 `refToMine()`）。所有比較都以參考時間呈現。

核心想法：**兩場從 0 同步開始，同一個機制在兩邊的時間差只會在「推進」時改變**。時間軸固定的戰鬥（熱舞綠光）時間差一直接近 0；依血量推進的戰鬥（呼嘯之劍第一階段結束）推進後時間差跳一次，之後維持在新的值。因此配對依時間，而不是依「同一技能的第 n 次」（隨機順序的機制會讓「第 n 次」配到另一段機制）。

流程（`Comparison.tsx` → `buildAlignment()`）：

0. **輸入：兩邊的敵方施放**（`load.ts`，`dataType=Casts&hostility=Enemies` 的 `cast` 事件，時間減去各自 fight 的 `startTime`），每筆附上施放者的遊戲 NPC ID（`TimedCast.source`）。
   - **只比較兩邊都有施放紀錄的敵人**（`withSharedCasters()`）：同一場戰鬥，雜兵的施放可能只被一邊的日誌記錄（熱舞綠光的青蛙舞者 Frogtourage 18362）。以遊戲 NPC ID 比對（名稱隨上傳者客戶端語言不同）；FFLogs 給沒有遊戲 ID 的角色（Boss 旁隱形的機制施放者）的是臨時編號 2,000,000＋角色編號，每份日誌不同，一律保留。
   - 無名稱的技能（`unknown_xxxx`）**也用來對齊**（出現時間穩定），對齊之後才由 `withoutUnnamedBossCasts()` 從顯示中移除。
1. **去重**（`keyedCasts()`）：依時間排序，同一技能 1 秒內重複施放算一次（多個分身、多個判定同時施放）。
2. **候選配對**：兩邊**同一技能**、時間差在 120 秒內（`MAX_DRIFT_MS`；騎士基準到戰鬥最後差 61 秒）的所有施放都列為候選。不限制施放次數（依時間配對時，頻繁的技能也不會錯位）。
3. **挑選錨點**（`bestChain()`，O(n²) 動態規劃，候選依我的時間、再依參考時間排序）：取兩邊時間都嚴格遞增、分數最高的一串。
   - 每個錨點 +1；與前一個錨點相距不到 1 秒時依比例（`FULL_GAIN_GAP_MS`）。密集的連續施放（熱舞綠光的 Let's Dance! Remix 每 0.75 秒一次、方向隨機）整段挪 3 步能多對上幾個同 ID 的施放，每個都算 1 分時會勝過時間差的穩定（實測 ±2.5 秒的錯配）。
   - 時間差（ref − mine）每跳 1 秒 −0.5、一次最多 −2（`OFFSET_JUMP_PENALTY_PER_S`、`MAX_JUMP_PENALTY`），從戰鬥開始 (0, 0) 起算。所以「從 0 開始、時間差穩定」的一串分數最高；真正的推進只跳一次，之後有 3 個以上錨點就值得。上限避免推進後錨點少時整段被捨棄。
3.5 **已知的機制分組（cactbot）**：有主要機制資料的 Boss（見「Boss 機制差異」的「主要機制資料」），`Comparison.tsx` 與前輩搜尋把 `mainMechanicGroups()` 以 `knownGroups` 傳給 `buildAlignment()`，**第一次對齊**就把 cactbot 同一條目的不同版本（放入 A／B 面、二連／三連／四連指向、4 拍／8 拍）當成同一個機制（同組 5 秒內算同一次）。實例：M5S `3hCzxvn79fRTbQGP` #30 與我的 A 面／B 面整段相反（相隔 19 秒），只看技能 ID 時我的 0:27.5 放入 A 面、指向的 4 下判定與播放 A 面（7 個錨點，+6.3 分）配到參考 19 秒後的 A 面，跳開再跳回只扣 4 分而勝出（時間差 −0.5～19.3 秒）；第一次對齊錯了，隨機機制組也找不到。加入已知分組後同一時間就配上（−0.5～0.3 秒）。
4. **隨機機制組與第二次對齊**：第一次對齊有 3 個以上錨點時，以其 `mineToRef` 找出隨機機制組（`variantGroups()`），再做一次步驟 1～3：
   - 找組：「另一邊 5 秒內沒有同一技能」的施放中，相距 1.5 秒內、**互為最近**的一對不同技能歸成同一組（union-find，會連鎖：二連—四連、三連—四連合成一組）。
   - 第二次對齊時同一組的技能視為同一個機制（候選配對以組為單位；組內 5 秒內的施放算同一次；與已知分組合併，`mergeGroups()`），我的「放入 A 面」就能配參考同一時間的「放入 B 面」，錨點更多。
   - 遊戲資料沒有「同一組隨機機制」的欄位，名稱也不可靠（放入 A 面／B 面名稱不同）；兩邊選到同一個變化時技能 ID 相同，第一次就會配上。只有一邊施放的機制（例如輸出夠高時被跳過的第二次空間斬）另一邊沒有對應，不會歸組。實測找到的組都是同一機制的變化：M8S Stonefang／Windfang、Eminent／Revolutionary Reign、Wolves' Reign 各版本、Hero's Blow 左右；M7S Smash Here／There、Brutish Swing、Lashing Lariat 左右；M5S 放入 A／B 面、二連／三連／四連指向、4 拍／8 拍節奏。
5. **換算**（`piecewise()`）：(0, 0) 加上所有錨點，錨點間線性內插，最後一個錨點之後斜率 1 外推。兩邊都嚴格遞增，`mineToRef` 與 `refToMine` 共用同一組錨點。
6. **推進差距**（`pushDifferences()`）：相鄰錨點間時間差跳 ≥ 3 秒，且前一錨點往前 30 秒、後一錨點往後 30 秒內錨點時間差的**中位數**也差 ≥ 3 秒（同號）才算；相距 15 秒內的跳變合併，合併後重算、未達 3 秒的捨棄。`deltaMs` > 0 表示我較慢推進。`Comparison.tsx` 只取比較範圍內的，傳給建議（`pushAdvice()`）、對齊說明列與時間軸 Boss 列。

演進（2026-09-27）：最初以「同一技能的第 n 次」配對（任一邊超過 8 次的技能不用）並取最長遞增子序列。熱舞綠光的隨機順序讓「第 n 次」一再配錯，陸續加上孤立錨點去除、分段去除「跳開又跳回」的段、首尾判斷、依分數挑選等補救（實例：對 `YAzxqkpVfBNmcMwj` #1 誤判 0:54「我快 9.7 秒」、對 `kCcYLfbxnTJ91Md6` #1 誤判「我快 20.2 秒」、對 `BQZ9kMd7KpR8J34D` #11 時間差範圍 −63.8～−0.3 秒並誤判兩個推進；M7S 武士基準誤判「我快 8.0 秒」）。使用者指出「兩邊從 0 開始、A 面／B 面一定同時觸發」後，改為依時間產生候選，補救的步驟（`dropDetours()` 等）與施放次數限制都不再需要而移除，錨點數也增加。

目前 10 組比較的結果（2026-09-27，加入 cactbot 已知分組後；錨點因同組 5 秒內算一次而略少）：

| 比較 | 錨點 | 時間差（ref − mine） | 推進差距 |
|---|---|---|---|
| M5S 我 vs `BQZ9kMd7KpR8J34D` #11 | 177 | −0.6～0.0 秒 | 無 |
| M5S 我 vs `WBNDQCdcrP6A1qkv` #16 | 178 | −1.2～−0.3 秒 | 無 |
| M5S 我 vs `kCcYLfbxnTJ91Md6` #1 | 175 | −1.4～−0.8 秒 | 無 |
| M5S 我 vs `Kwx3LyFJjz26pYRm` #16 | 176 | −0.5～0.1 秒 | 無 |
| M5S 我 vs `YAzxqkpVfBNmcMwj` #1 | 172 | −0.5～0.0 秒 | 無 |
| M5S 我 vs `3hCzxvn79fRTbQGP` #30（A／B 面整段相反） | 177 | −0.5～0.3 秒 | 無（沒有已知分組時 −0.5～19.3 秒） |
| M8S 武士基準 | 232 | −6.8～0.2 秒 | 參考 6:41.3 我慢 6.7 秒 |
| M8S 騎士基準 | 204 | −9.3～1.4 秒 | 參考 6:31.2 我慢 8.9 秒 |
| M7S 武士 | 162 | −0.2～0.8 秒 | 無 |
| M8S 黑魔驗證 | 205 | −12.5～0.7 秒 | 參考 6:24.9 我慢 11.3 秒 |

「我」在 M5S 為 `BF76r8yKh4wGaYkm` #1。每次對齊約 12～50 毫秒（候選較多時 O(n²)）。M5S 沒有依血量推進的轉場，時間差只有 1～2 秒內的誤差；M8S 第一階段結束依血量推進，推進差距都保留。參數（1 秒滿分間距、每秒 −0.5、上限 −2、120 秒）以這 9 組驗證：滿分間距 1～3 秒、施放次數上限 8／16／不限的組合結果都正確，取錨點最多的組合。
### 通用指標（`src/analysis/metrics.ts`）
- `gcdStats()`：GCD 間隔＝1.5～2.6 秒相鄰間隔的中位數，上限 2.5 秒；空檔＝每個間隔超出 GCD＋100 毫秒的部分加總。
- `lostGcdWindows()`：我的相鄰 GCD 間隔 > max(1.5×GCD, GCD＋1 秒) 時，換算到參考時間，計算參考在區間內（兩端各留半個 GCD）的 GCD 數。
- `abilityUsage()`／`matchPairs()`：同一技能兩邊的使用以動態規劃配對（不可交錯、相距 ≤ 30 秒；先求配對數最多、再求時間差總和最小），回傳平均時間差與參考未配對的使用 `unmatchedRef`（減傷／移動建議用）。使用 30 次以上的技能不配對。

### 站位（`src/analysis/positions.ts`）
- `positionAt()`：線性內插；玩家相鄰取樣超過 4 秒不內插、最多沿用 1 秒（`PLAYER_LIMITS`）；Boss 放寬為 30 秒／10 秒（`BOSS_LIMITS`）。
- `compareTracks()`：每 0.5 秒取樣兩人位置；對稱判斷以當下 Boss 位置與場地中心（`estimateCenter()`＝參考 Boss 位置中位數）為中心，做左右、前後、點對稱，取與我最近者。
- `divergences()`：距離 > 8 yalm、持續 ≥ 2 秒、間隔 2 秒內合併；對稱後 ≤ 6 yalm 且 < 原距離一半的點視為可由對稱解釋，同一種對稱超過區段一半時標示。
- `alignToBoss()`：我的位置加上（參考 Boss − 我的 Boss）的位移（兩場 Boss 位置都以 `BOSS_LIMITS` 內插，任一邊沒有時沿用原始位置），只供俯視圖的「對齊 Boss」視角；`compareTracks()` 仍用原始位置。以比較基準驗證判定是否該改用對齊後位置（2026-09-28）：
  | 比較 | 絕對位置 | 平移對齊 | 連面向旋轉（`toBossFrame`） |
  |---|---|---|---|
  | M8S 武士 | 16 段 | 16 | 22 |
  | M8S 騎士 | 24 | 24 | 22 |
  | M8S 黑魔 | 12 | 13 | 13 |
  | M7S 武士 | 13 | 12 | 23 |
  - M8S 平移量小（2～7% 的取樣平移 > 3 yalm）。M7S 第二階段 Boss 隨機站在兩側平台（我 3:08～4:03 在 (127, −8)、4:06 後 (73, 17)；參考相反），兩人都站在 Boss 往場中心那側：絕對距離約 20 yalm、平移後約 40 yalm、旋轉後 2～4 yalm。M6S（`WATKBdHRh7m8PNQt` #11 vs `QZ8tGLMJbzrAaHwP` #13）小怪階段平移平均 4、最大 15.6 yalm，站位差異段落因此改變。旋轉在 M8S 第二階段 Boss 面向隨坦克轉動時增加段數。沒有一種基準都對，判定維持絕對位置。
- `attachMechanics()`：參考日誌的 Boss 施放去重（1 秒）、排除施放超過 8 次的技能，取落在差異區段內、且當下 `distanceAt()` > 8 yalm 的施放，存入 `Divergence.mechanics`。

### Boss 機制差異（`src/analysis/mechanics.ts`）

輸入是對齊後的兩邊 Boss 施放（已經過 `withSharedCasters()` 與 `withoutUnnamedBossCasts()`，完整戰鬥、不裁切）。機制差異表用 `mainMechanics.ts` 的 `mainMechanicDifferences()`：有 cactbot 資料的 Boss（`mechanicData.generated.ts`，見下方「主要機制資料」）先只留主要機制的技能 ID，且不以施放次數排除（`maxOccurrences: Infinity`）；沒有資料的 Boss 與站位、建議仍用下列的全部低頻技能。機制差異的比較仍排除任一邊施放超過 8 次的技能（顯示用，頻繁的技能不算機制；對齊則不限制）。流程（`mechanicDifferences()`）：

1. 去重（同一技能 1 秒內算一次）、排除任一邊施放超過 8 次的技能。
2. 我的施放以 `mineToRef()` 換算成參考時間。
3. 同一技能在另一邊 5 秒內有施放就算相同（轉場附近對齊可能差幾秒），**一對一、時間差最小的先配**；有機制分組（`groupOf`，主要機制由 `mainMechanicDifferences()` 傳入）時，另一邊比這個配對更近處有同機制的其他版本，就不配（每下方向隨機的連續攻擊：同一時間是不同版本，不跨到下一下配同一版本；實例 M5S `2HVnbyKxLYpcq739` #15 放縱勁舞）；其餘為未配對的施放。只比到較短一方結束的時間。原本是「另一邊 5 秒內有同一技能就算相同」（不消耗），M8S 幻狼劍（Moonbeam's Bite 41922／41923，每 2 秒一下、第一下版本隨機）第一下版本不同時，我的 41922 被參考第二下的 41922 算成相同，參考第一下的 41923 被列成「只有參考」；M5S 放縱勁舞（42861／42862）、徹夜狂歡（41873～41876）每下方向隨機的差異也因此被隱藏。
4. 未配對的施放依時間排序，彼此相距 1.5 秒內的合併成一個時間點（`pushes` 傳入推進差距時，落在推進時段 refStart～refEnd 內的「只有一邊」不列出：例 M8S 推進較慢的一方在轉場前多一次空間斬）：兩邊都有 → `variant`（同一時間施放不同技能，隨機變化）；只有一邊 → `only-mine`／`only-ref`（多半是輸出不同造成的轉場差異，或被跳過的機制）。
5. 顯示（`Mechanics.tsx`）：`mergeRepeats()` 把同一招的連續結算（兩邊名稱與類型都相同、間隔 6 秒內）合併成一列；技能名稱同名只列一次，ID 放在滑鼠提示；兩邊名稱完全相同但 ID 不同（例如方向不同的版本）類型寫「不同版本」，並以虛線底線提示（`sameNameVariants()`）。

其他使用機制差異的地方：
- 站位差異（`positions.ts` 的 `attachVariants()`）：區段期間或開始前 10 秒內的 `variant` 附在 `Divergence.variant`，卡片標「機制不同」、不列入站位建議。
- 建議（`advice.ts` 的 `mechanicNote()`）：停手時段前 10 秒內到結束之間的 `variant` 附註在停手建議中。
- 「只有一邊」的主要機制，若另一邊同一時間（1.5 秒內）有非主要機制的施放就不列：那是同一招的另一個版本、只是 cactbot 沒列（實例：M5S 三連指向最後一下 #42808 在 cactbot 自成一條，二連指向同一時間的 #42799 不在 cactbot，原本列成「只有我」）。真正被跳過的機制（M8S 第二次空間斬）另一邊同一時間沒有施放，仍列出。
- 前輩日誌搜尋的「機制相同」（`mainMechanics.ts` 的 `variantPoints()`）：`buildAlignment()`（同樣傳入已知分組）後以 `mainMechanicDifferences()` 比較，`mergeRepeats()` 合併連續結算後，回傳每個 `variant` 時間點與涉及的主要機制（技能 ID 對應到該組最小的 ID）。差異數是時間點數（使用者要求：看同一時間點有幾處不同，而不是幾組機制不同），只算涉及勾選機制的時間點。cactbot 沒有「衍生技能」的資料（例：M8S 群狼劍在時間軸是獨立條目，`r8s.ts` 觸發器只處理掃擊／旋擊群狼劍 A911～A914，兩者都有讀條），無法確定是否為前一招的後續，因此各自算一處（使用者要求：不能確定就保留，不當特例處理）。畫面依繁中名稱合併同名機制（M8S 的圓形／扇形群狼劍是 cactbot 的兩組、繁中名稱都是「群狼劍」），只數勾選的機制；取消勾選的機制鍵存在 `localStorage` 的 `finder-ignored-mechanics:<encounterID>`。機制名稱在勾選「機制相同」時就一次查完該 Boss 所有主要 ID（`fetchAbilityNames()`，約 60～100 個 ID 一個請求）：實測比對開始後才查名稱時曾查不到（推測碰到 Worker 每分鐘次數限制），失敗會 5 秒後重試。尚未套用 `withSharedCasters()`（`loadBossCasts()` 沒有角色資料）。

#### 主要機制資料（`scripts/gen-mechanics.mjs` → `src/analysis/mechanicData.generated.ts`）

- 從 cactbot 的 `ui/raidboss/data/07-dt/raid/r5s.txt`～`r8s.txt` 抓時間軸，FFLogs encounterID 對應：97＝M5S Dancing Green、98＝M6S Sugar Riot、99＝M7S Brute Abombinator、100＝M8S Howling Blade（依 D1 的 zone 68 與實際報告確認）。
- 解析 `Ability { id: … }` 條目（含註解掉的 `#Ability`／`# Ability`，它們是不同步但實際存在的攻擊；`# Ability`〔# 後有空格〕原本沒被正規表示式讀到，漏了 M5S 放縱勁舞 `182.2 "Let's Dance! (Cleave) 1" # Ability { id: ["A76D", "A76E"] }` 的分組，兩個方向 42861／42862 被當成兩個機制），名稱以 `--` 開頭（`--sync--`、`--middle--` 等）的輔助條目不收。同一行的 ID、以及出現在多行的同一 ID 以 union-find 合併成一組機制。產生結果：M5S 30 組 64 個 ID、M6S 43／55、M7S 48／61、M8S 83／94。M5S 的 2／3／4 連指向因各階段的條目共用 ID 而合成一大組（28 個 ID），畫面上名稱最多列 3 個。
- 換季時在腳本的 `ENCOUNTERS` 加上新 Boss 後重新執行（不要手改產生的檔案）。
- 實測 M8S 武士（`FXLkqaK32PhQH8Ac` #1 vs `pwTF16cgnB9G7fWM` #29）：機制差異表 9 列（8 列不同變化：風之魔技／土之魔技、掃擊／旋擊群狼劍、群狼劍與摧枯拉朽的不同版本；1 列只有我：空間斬），名稱皆為繁中服名稱。搜尋前輩日誌（武士 PR 90～100，7 筆）每筆 2～6 種主要機制不同，勾選清單 6 項。
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

## 繁中服排名（2026-09-27）

### 調查：FFLogs 沒有繁中服排名
- `worldData.regions` 只有 NA、EU、JP、OC、CN、KR（各有子區域），**沒有繁中服**；`characterRankings(serverRegion: "TW")` 回「Invalid region specified」。
- 繁中服的報告在 FFLogs 上被標成其他區域（hqNYDGK9A4pmWVXB 為 JP、FXLkqaK32PhQH8Ac 為 CN），玩家的 `server` 是繁中服名稱（泰坦、奧汀、利維坦、迦樓羅、伊弗利特、鳳凰、巴哈姆特）。
- 繁中服報告的 `report.rankings(fightIDs)` 回傳 `{"data":[]}`：**不排名、沒有 PR**。但傷害表（`table(dataType: DamageDone)`）**仍有計算 rDPS**：每位角色有 `totalRDPS`、`totalRDPSTaken`、`totalRDPSGiven`、`totalADPS`、`totalNDPS`、`totalCDPS`（2026-09-27 以 FXLkqaK32PhQH8Ac、pwTF16cgnB9G7fWM 等 5 份繁中服日誌確認）；`totalRDPS`＝`total` − `totalRDPSTaken` ＋ `totalRDPSGiven`（8 個職業全部吻合，例如詩人 DPS 21,385 → rDPS 26,459）。除以表格的 `totalTime`（戰鬥長度，毫秒）即為每秒數值。國際服報告同樣查詢會回傳每位玩家的 `rankPercent`、`rank`（例如 `~811`）。
- `characterRankings` 回傳 `{ page, hasMorePages, count, rankings }`，`count` 是該頁筆數（100）而非總人數，也沒有 PR；每筆有 `name`、`server {name, region}`、`amount`、`duration`、`report {code, fightID, startTime}`、`bracketData`（例如 7.3）。
- `reportData.reports(zoneID, startTime, endTime, page, limit)` 不需公會或使用者即可列出公開報告，但沒有區域篩選；`total`／`last_page` 為 -1。

### 額度量測（`rateLimitData`）
- 每小時 3,600 點，所有訪客共用。
- 列出 25 份報告並含 `fights(killType: Kills)` 與 `masterData.actors(type: "Player")`：約 50 點；一次 100 份會超過查詢複雜度上限（50000）。
- 一場戰鬥的傷害表（`table(dataType: DamageDone)`）：約 2 點。
- 抽樣 zone 68（AAC Cruiserweight）100 份報告：67 份有繁中服玩家、189 場擊殺（含其他難度）。

### 實作（`worker/src/crawler.ts`、`worker/schema.sql`、D1 `ff14-copycat-rankings`，APAC）
- 定時觸發（`wrangler.toml` 的 `crons = ["7 * * * *", "37 * * * *"]`，`index.ts` 的 `scheduled` 依 `controller.cron` 分派）：每小時 7 分執行 `crawl()`，37 分執行 `pruneGoneReports()`。分開是因為 **Workers 免費方案每次執行最多 50 個對外請求**（FFLogs 查詢、授權；D1 不算）：原本確認排在掃描之後，掃描用掉 47 個（6 頁列表＋40 份傷害表＋授權），確認只做了 3 份，其餘因超過上限失敗而被當成暫時錯誤跳過（2026-09-27 以 `wrangler tail` 看到 `checkedReports: 3`）。`crawl()` 另外計算請求數（上限 47），用完時存入已處理的報告、不推進頁碼，下次重新列出同一頁（已處理的報告會跳過）。`crawl()`：
  - 每次最多 6 頁（每頁 25 份），分兩部分（進度都存在 `crawl_state`）：
    1. **先掃最近 2 天**（`recent_start`／`recent_page`）：一輪的起點在開始時固定為當時的「現在 − 2 天」、終點為每次執行的現在，跨次執行逐頁輪完；新上傳的報告只會讓後面的頁往後移，翻頁不會漏掉（可能重複列到，已處理的會跳過）。一輪掃完就停，下一輪留到下次執行。還在補舊資料時最多用 3 頁，補完後 6 頁都給最近 2 天。
    2. **剩下的頁數補舊資料**（`cursor`／`page`）：第一次從 60 天前開始，一個時間窗 1 天往後推，追上「現在 − 2 天」就停止；之後只有落後超過 12 小時（例如停擺過）才再補。
  - 跳過 `scanned_reports` 中已處理的報告；有繁中服玩家的報告，把零式（`difficulty` 101）擊殺的傷害表合成一個查詢（以 `f{fightID}:` 別名），`rDPS = totalRDPS ÷ 戰鬥秒數`（沒有 totalRDPS 時以 `total` 代替），只存繁中服玩家（排除極限技等非玩家）。
  - 這小時已用超過 2,000 點就跳過，把額度留給訪客。
  - 確認已收錄的報告是否仍公開（`pruneGoneReports()`，獨立觸發）：`parses` 中的報告依 `scanned_reports.checked_at`（沒有時用 `scanned_at`）由舊到新，超過 1 天沒確認的每次最多 40 份，各以只取 `code` 的查詢確認。FFLogs 對私人報告回「You do not have permission to view this report.」、已刪除回「This report does not exist.」（2026-09-27 確認），這兩種錯誤就刪除該報告的 `parses`（報告仍留在 `scanned_reports`，不會再收錄）；其他錯誤（額度、網路）不記錄確認時間，下次再試。
  - 掃描的副本：`CRAWL_ZONES = [68]`、`CRAWL_DIFFICULTY = 101`，**換季時要更新**。
- `scanned_reports` 另有 `checked_at`（最後一次確認仍公開的時間）。
- 資料表：`parses`（主鍵 report＋fight＋actor；只存 `rdps`，排名用索引 `parses_rdps`；另存戰鬥在報告中的開始／結束，供前端抓 Boss 施放比對機制）、`scanned_reports`、`crawl_state`。
- `tcRankings()`：取出該 Boss／職業的所有紀錄依 **rDPS** 排序（同 rDPS 以較早的報告優先），每位玩家（名稱＋伺服器）第一次出現的即其最好的一場；**每一場**的 PR 名次＝1＋其他玩家最好一場的 rDPS 高於這一場的人數（在由高到低的最好一場清單上二分搜尋，扣掉自己），`PR = floor((人數 − PR 名次) ÷ (人數 − 1) × 100)`：比較的母群與 FFLogs 相同（每個角色只算最好的一場），FFLogs 的確切百分位公式（兩端、同分）未驗證；回傳 PR 在範圍內的所有紀錄。回傳的 `rank` 則是這一場在所有場次（去重後）依 rDPS 的順位，每場不同。D1 中同一場擊殺常被隊伍中不同人重複上傳（例：劍十三@巴哈姆特 32973 DPS 同時在 `nQY4gy78XCRdTAWH` #24 與 `2Apm4MrbCR3jB7qT` #8，也有同一場 3 份的），以「玩家＋戰鬥的實際開始時間（`report_start + fight_start`）」去重：FFLogs 沒有跨報告的戰鬥識別碼，但同一場戰鬥在不同人上傳的報告中，實際開始時間完全相同（2026-09-27 查 D1：同玩家、同 Boss、開始時間相差 1 分鐘內的 920 組重複紀錄，差距全部為 0 毫秒，DPS、rDPS、長度也相同；原本以 DPS＋長度去重的結果一致，沒有誤判）。前端最多列 40 筆（勾「機制相同」時逐筆抓 Boss 施放，3 個並行，在 Worker 每 IP 每分鐘 60 次限制內）。
- 實測（2026-09-27）：
  - 第一次執行從 60 天前（7 月底）開始，35 份報告都沒有繁中服擊殺（該副本那時可能還沒有繁中服紀錄）。
  - 暫時把進度移到最近兩天驗證：50 份報告收錄 192 筆，涵蓋本季 4 隻 Boss（97～100）與 20 個職業；最高 DPS 為利維坦的忍者 Wqw 約 3.8 萬。
  - 最近兩天的時間窗翻到第 3 頁，推估每天約 50～100 份報告。
  - 驗證後把進度移回補舊資料的位置。
- 更新頻率：原為每 15 分鐘 2 頁，依使用者意見（專案不需要高頻更新）改為每小時 6 頁：
  - 每小時最多約 300 點列表＋少量傷害表，留大部分額度給訪客。
  - 補完 60 天約需 5 天。
- 補資料進度（2026-09-26 13:07 查詢）：每小時都有執行，每次 126～150 份報告；共掃 495 份、其中繁中服 20 份（約 4%）、200 筆紀錄。進度從 7/28 推進到 7/31（每天約 160 份報告），補到現在還要約 2.5 天，而近期擊殺要等補完才會掃到，因此改為每次先掃最近 2 天。
- 測試：`crawler.node.test.ts` 以 Node 24 內建的 `node:sqlite` 套用同一份 `schema.sql` 模擬 D1；這個檔案使用 Node 內建模組，Worker 的 tsconfig 排除它、改由 `tsconfig.node.json` 檢查。
- 前端：`compare/ReferenceFinder.tsx`；`loadBossCasts()`（`load.ts`）只需戰鬥的 ID 與開始／結束，直接用資料庫存的時間抓 Boss 施放；`analysis/mainMechanics.ts` 的 `variantPoints()` 以時間軸對齊後主要機制「不同變化」的時間點判斷機制是否相同。比對同時最多 3 個請求（Worker 每 IP 每分鐘 60 次）。

## MT／ST 判斷（`AUTO_ATTACKS_TAKEN_QUERY`）

- GraphQL `report.table(fightIDs, dataType: DamageTaken, hostilityType: Friendlies, filterExpression: "ability.name = 'attack'")`；過濾運算式不分大小寫，會比對到 Boss 的「Attack」。回傳的 `data.entries` 以受傷的玩家為單位（`id`、`total`、`abilities`），Worker 只取 `{ id: total }`。
- Boss 普通攻擊不是固定 ID：Howling Blade 的「Attack」有 42228、42226、42222、42225 等多個 ID（不同型態），所以用名稱過濾而不是 ID。實測只有兩位坦克出現在結果中。
- 騎士基準 hqNYDGK9A4pmWVXB #18：戰士 醉仙月月 3,638,563、騎士 神曲莊園 2,130,458 → 戰士為 MT。
- 前端 `useTankLoad()`（`App.tsx`）只在標準隊伍（2 坦 2 補 4 輸出，`isStandardParty()`）時查詢，每份報告每場戰鬥一次；`sortByPartySlot(players, tankLoad)` 坦克依承傷排序，資料到之前坦克不標位置，查詢失敗也不標。
- 部署後第一次請求新端點曾回 404「Not found」，重新部署後正常，推測是新版本尚未完全生效。

## 測試資料

| 用途 | 我的日誌 | 參考（前輩） | 備註 |
|---|---|---|---|
| **武士比較基準**（使用者指定） | `FXLkqaK32PhQH8Ac` #1，席德（source 6），Howling Blade 擊殺 13:50 | `pwTF16cgnB9G7fWM` #29，安祖卡（source 13），13:56 | 驗證功能時必測 |
| **騎士比較基準**（使用者指定） | `hqNYDGK9A4pmWVXB` #18，神曲莊園（source 40），Howling Blade 擊殺 13:53 | `khNfTaMtYwKBd36b` #10，Lavid（source 5），12:52 | 參考快 61 秒，可測大幅時間差與坦克技能 |
| 黑魔道士驗證 | `bX97vBapCPwKndL6` #3，春風醒（source 2），13:40 | `h6gRJZ2pfDFYMPjX` #13，Nana七（source 28），13:01 | |
| 暗黑騎士驗證 | `FXLkqaK32PhQH8Ac` #1，倉鼠教徒（source 4） | `pwTF16cgnB9G7fWM` #29，穎嵐（source 71） | 坦姿不紀錄與減傷建議 |
| 同隊滅團 vs 擊殺、冒煙測試 | `WATKBdHRh7m8PNQt` #10（Sugar Riot 滅團，Risen／毒蛇劍士 source 34） | 同報告 #11（擊殺） | 冒煙測試固定使用這份報告 |
| **熱舞綠光 UI 驗證**（使用者提供） | `BF76r8yKh4wGaYkm` #1（擊殺 9:02，黑魔道士 死魚眼等 8 人，連結未指定角色） | `b3ph7JxjD4BkVL6Q` #20（擊殺 8:27，黑魔道士 陰暗爬行初華） | Boss 機制差異 13 列：播放A/B面、N連指向、搖擺哈娑同名不同 ID（#42789／#42788）、4拍節奏兩邊差 13 秒各列一次 |
| 熱舞綠光同隊滅團 vs 擊殺 | `h6gRJZ2pfDFYMPjX` #3（滅團，Nana七 source 28） | 同報告 #4（擊殺） | 「四連指向、定格＆播放」同時 4 個 ID |
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
- **圖示**：`masterData.abilities[].icon`（如 `003000-003729.png`），網址 `https://assets.rpglogs.com/img/ff/abilities/<icon>`（`/icons/` 路徑會 403）。效果（Status）圖示原圖為 24×32 直式、技能圖示為正方形，顯示效果圖示時要維持 3:4 比例，否則會被壓扁。
- **食物效果時間延長**：BF76r8yKh4wGaYkm #1 的學者（source 14）開打當下帶有 #1001084 Rationing（食物效果時間延長）；另有部隊特效版 #1000360。與戰鬥無關，`analysis/buffs.ts` 的 `HIDDEN_STATUSES` 在開打前效果、自身效果時段與當下狀態都排除。
- **Boss**：施放最多次的敵人為主 Boss（Howling Blade 有多個同名 actor）。部分 Boss 技能沒有名稱（42672 顯示為 `unknown_a6b0`）。
- **隨機機制**：同一機制的隨機變化使用不同技能 ID，甚至同名不同 ID。Howling Blade：Windfang／Stonefang、Eminent Reign／Revolutionary Reign、Wolves' Reign（#41880/#43369 vs #42927/#43370 等）、Hero's Blow（#42079/#42080 vs #42081/#42082）、Sand Surge（#43138 vs #43520）。
- **語系**：FFLogs 有 `cn.`、`ja.` 等子網域，**沒有 `tw.fflogs.com`**；API 的 `translate` 只翻成英文。

## 小怪與多目標（2026-09-28 調查）

- FFLogs 對同名的多隻小怪只給一個角色 ID，以 `sourceInstance`／`targetInstance`（第幾隻）區分；本站的位置與施放都不看 instance，Boss 本體（subType Boss）在已看過的零式整場都只有 instance 1，因此不受影響。
- M7S（`dbN4HXY3QPzMRvDw` #4、`YbakGgfzPQjJ4MK7` #5）：Boss 本體 Brute Abombinator 1 隻；另有同名的隱形施放者（subType NPC、臨時 gameID 2,000,000＋ID，施放 320 次）；小怪 Blooming Abomination（gameID 18308）約 1:09～1:19 有 4 隻（instance 1～4）、約 8:25～8:38 再出現數隻。玩家在 3:00～5:30 打的都是 Boss 本體（在不同平台）。
- M6S（`WATKBdHRh7m8PNQt` #11、`QZ8tGLMJbzrAaHwP` #13）：Boss 本體 Sugar Riot 1 隻、隱形施放者 15 個 instance；小怪階段約 3:49～6:40：Mu（6 隻）、Yan（3）、Gimme Cat（3）、Feather Ray（4）、Jabberwock（2），另有 Sweet Shot（12，約 6:44～7:35，只施放）。小怪出現時有 `targetabilityupdate`（變成可選中），死亡不會再有；Boss 整場可選中，但玩家主要打小怪，Boss 位置取樣稀疏（有些 15 秒只有 1 筆）。
- 俯視圖目前不畫小怪。之後若要「標記小怪階段並跳過比較」，可從小怪（非 Boss、非臨時 gameID 的敵人）的可選中事件、玩家攻擊目標與死亡事件判斷期間。

## 開打前的資料（2026-09-26 調查）

以四組基準日誌實測（scratchpad 腳本 `prepull.mjs`、`prepull-auras.mjs`）：

- **帶 `fightIDs` 的事件查詢不會回傳 0:00 前的事件**：把 `startTime` 往前推 30 秒，結果與從 `fight.startTime` 開始相同（武士 FXLkqaK32PhQH8Ac #1 前 3 秒都是 18 筆，第一筆是 0:00 的 `combatantinfo`）。
- **`combatantinfo`（0:00）的 `auras`** 列出開打當下身上的效果，`ability` 為**狀態 ID＋1,000,000**（例如 1001233 = 狀態 1233 明鏡止水），`source` 為施放者：
  - 武士 席德：Meikyo Shisui、Tendo、True North（自己）、Well Fed，以及治療給的 Eukrasian Prognosis、Horoscope Helios、Helios Conjunction。
  - 武士 安祖卡：Meikyo Shisui、Tendo、True North、Dance Partner（舞者）、Eukrasian Prognosis。
  - 騎士 神曲莊園：Iron Will（坦姿）、Well Fed、Eukrasian Prognosis；騎士 Lavid：Galvanize、Peloton。
  - 黑魔 春風醒：Preferred World Bonus（source 0）、Well Fed、Galvanize、Peloton。
  - 已經消失的效果（例如開打前用掉的爆發藥以外的短效果）不會出現。
- **開打前詠唱的技能**：只有 0:00 後的 `cast`、沒有 `begincast`（Lavid Holy Spirit 0.36 秒、春風醒 Fire III 1.25 秒）；`playerCasts()` 因此以 `cast` 時間畫出。
- **不帶 `fightIDs` 也拿不到**（2026-09-27 實驗）：暫時在 Worker 加了只給報告時間範圍（`fight.startTime - 30000` 到 `fight.startTime`）、不指定戰鬥的查詢，五組基準都只回傳 1 筆 `combatantinfo`，沒有任何施放事件。FFLogs 不保留戰鬥以外的事件，開打前的確切時間無法取得；實驗端點已移除。
- 實作（`src/analysis/buffs.ts`）：`prepullEffects()` 取 `combatantinfo.auras` 中 `source` 為玩家自己的效果（排除別人給的與 source 0 的 Preferred World Bonus）；`selfBuffWindows()` 把這些效果視為從 0:00 開始的窗口。
- 狀態 ID 對應技能：要查遊戲 Status 表（名稱）；對應回 Action 需另建表（多數同名，例如 Meikyo Shisui 技能 7499／狀態 1233）。

## xivanalysis 規則移植評估（2026-09-26）

- 授權：**MIT**（可參考與移植，保留出處即可）。預設分支 `dawntrail`；職業模組在 `src/parser/jobs/<job>/modules/`，共用模組在 `src/parser/core/modules/`。
- 共用模組（可對應到本站的共用分析）：GlobalCooldown／AlwaysBeCasting（已有類似的 GCD 概況）、CooldownDowntime（冷卻漂移）、RaidBuffs、Tincture（爆發藥窗口）、Positionals（身位）、DoTs、Procs、Combos、Defensives、Swiftcast、Gauge、ActionWindow（`windows`／`evaluators`：Buff 窗口內的 GCD 數與技能限制）。
- 職業模組範例（武士 `sam/modules`）：AoeChecker、Buffs、Combos、Defensives、Fuka、Hagakure、Higanbana、Meikyo、OGCDDowntime、Positionals、ReadyProcs、Sen、Shoha、Tincture、Kenki。
  - `Meikyo.tsx` 繼承 `BuffWindow`：每次明鏡止水應打 3 個 GCD（少打為中等，嚴重不足為重大），且期間只能用月光、花車、雪風、滿月、櫻花等；戰鬥結束時的窗口放寬計算。使用施放事件與 Buff 施加／移除事件。
- 本站可用的資料：玩家事件已抓 `dataType=All`，包含 `applybuff`／`removebuff`（身上的效果）、`damage`（可判斷身位 `hitType`／方向相關欄位需再確認）、`resources`；Boss 事件另有。多數規則**不需要新的 FFLogs 請求**。
- 移植方式：不直接引用 xivanalysis 的框架（依賴其事件管線與資料表），而是在 `src/jobs/` 以本站的 `TimedCast` 與 Buff 事件重寫規則；技能／狀態 ID 以遊戲資料查證。先做共用的 Buff 窗口與冷卻漂移，再逐職業加規則。
- 比較方式：兩邊各自套規則得到窗口結果，再依對齊後時間配對；時間軸標示窗口與不合格處。

## 技能窗口（2026-09-27 實作）

- 資料（`src/analysis/buffs.ts`）：
  - `selfBuffWindows()`：玩家全部事件中 `sourceID` 與 `targetID` 都是玩家自己的 `applybuff`／`removebuff`，重複施加視為同一段；開打前已有的效果從 0:00 起算，到戰鬥結束仍未移除的標 `openEnded`。
  - `enemyDebuffWindows()`：玩家施加在敵人身上的 `applydebuff`／`removedebuff`，依「效果＋目標」追蹤，同一效果重疊的時段合併（範圍技能同時掛在多個敵人身上）。
  - 兩者合併存在 `SideData.buffs`（效果 ID 不重複）。`clipSide()` 會移除比較範圍外才開始的窗口，並把跨過結束點的截斷、標為 `openEnded`（不評分）。
- 規則格式：`src/jobs/windows.ts`（`WindowRule`、`windowRules()`、`ruleIds()`、`ruleName()`）；各職業規則：`src/jobs/windowRules.ts`。
  - 觸發方式三擇一：`statusId`（效果期間）、`action`（技能後固定時長，例如武神槍 20 秒、蛇靈氣 30 秒）、`allOf`（多個效果的交集，例如吟遊詩人三個 Buff）。
  - 要求：`expectedGcds`（依時間結束的窗口以 `ceil((長度 − 250 ms) ÷ GCD)` 封頂，`stacks` 為 true 時不封頂）、`gcdAdjust`（每用一次某技能 ±N）、`trackedGcds`／`ignoredGcds`、`allowedGcds`、`expectedActions`（`each`／`total`，可有 `openerCount`、`onlyIf`）、`limitedActions`（不應使用，開場可有 `openerAllowed`）、`openerMs`。
  - 問題說明由技能 ID 組成（`abilityName`，官方繁中），規則中不寫分組名稱。
- 評估：`evaluateWindows()`（`src/analysis/windows.ts`）以開始施放時間判斷技能是否在窗口內（`start ≤ t ≤ end + 100 ms`：最後一個 GCD 常在效果移除的同一時間施放）；`ruleWindows()` 依觸發方式取出窗口。前端以各自的 GCD 估計（`gcdStats`）封頂 GCD 數。
- 名稱：規則中的技能可能兩邊都沒用過、不在報告的技能清單中，`useAbilityNames()` 另把 `ruleIds()` 一起查繁中名稱，`abilityName` 在技能清單沒有時用查到的名稱。
- 規則的 ID（Action／Status 表查證，2026-09-27）：
  - 武士：明鏡止水 狀態 1233（技能 7499）；刃風 7477、曉風 36963、陣風 7478、士風 7479、風光 25780、月光 7481、花車 7482、雪風 7480、滿月 7484、櫻花 7485。
  - 騎士：戰逃反應 狀態 76（技能 20）、安魂祈禱 狀態 1368（Imperator 36921 也施加）；瀝血劍 3538、悔罪 16459、信念之劍 25748、真理之劍 25749、英勇之劍 25750、王權劍 3539、贖罪劍 16460、祈告劍 36918、葬送劍 36919、聖靈 7384、榮耀之劍 36922、償贖劍 25747（英文資料拼作 Expiacion）、厄運流轉 23、調停 16461、深仁厚澤 3541。
- **修正：明鏡止水只計連擊技**。第一版把窗口內所有 GCD 都算進去，結果武士兩邊幾乎全部不合格（1/16、2/17）：居合術、燕返、奧義斬浪不消耗明鏡止水，窗口常延續到這些技能之後。改為 `trackedGcds` 只看連擊技（與 xivanalysis 的 `ONLY_SHOW` 相同）後，兩邊都 16/16、17/17。
- 基準結果：
  - 騎士 hqNYDGK9A4pmWVXB #18：戰逃反應 1/13，其中 12 次缺調停；另有數次「其他 GCD」不足 3 個或 GCD 不足 8 個。安魂祈禱 12/13（8:34 缺英勇之劍，窗口長達 31 秒）。
  - 騎士 khNfTaMtYwKBd36b #10：戰逃反應 13/13、安魂祈禱 13/13。
- 效果名稱：Worker `/abilities` 的 `gameRow()` 把 1,000,000～1,099,999 對應到 Status 表（例如 1001233 → 明鏡止水、1000076 → 戰逃反應、Iron Will 1000079 → 鋼鐵信念）。

### 其餘職業的規則移植（2026-09-27）

- 來源：xivanalysis dawntrail 分支（commit b240252，2026-09-23）各職業繼承 `BuffWindow`／`RaidBuffWindow`／`BuffGroupWindow`／`TimedWindow` 的模組，以及各職業的 `Tincture`（強化藥，狀態 49）。以三個代理平行整理規則，ID 取自 xivanalysis 的 `src/data/{ACTIONS,STATUSES}`。
- 查證：
  - 所有規則 ID 以 Action／Status 表查英文與繁中名稱，與 xivanalysis 的名稱逐一對照（暫時腳本，未提交）。
  - 觸發效果都在實際日誌中出現過：強化藥 1000049（20 個職業都有）；百雷銃 1003906 是 `applydebuff` 施加在敵人身上。
  - 赤魔的魔元化 1001971 仍存在，魔連攻等使用舊 ID（7527、7529，沒有 7.4 新增的 45960～45962），可判斷基準日誌為 **7.4 以前**的版本。因此移植 xivanalysis 7.4 以前的規則：魔元化、絕槍的終結之心需先用血壤。
- 未移植：
  - 依量譜／MP／召喚獸階段或寵物施放判斷的模組：黑魔 RotationWatchdog、召喚 Summons（非窗口類別）、暗黑 EsteemWindow（影子的施放）、舞者 DirtyDancing（舞步）、機工 Wildfire／Hypercharge（非窗口類別）。
  - 詠唱時間相關：即刻詠唱、三連詠唱。
  - 只顯示不評分的：吟遊詩人單一 Buff 窗口、學者／武士／龍騎／繪靈的強化藥（xivanalysis 沒有要求）。
  - 自訂評估：武僧 BlitzEvaluator、吟遊詩人 Barrage 的特殊計算（這裡以施放次數代替）、機工強化藥的整備計算，以及各規則「趕時間」（`isRushedEndOfPullWindow`）的放寬。
- 驗證（6 場戰鬥 48 位玩家，事件快取在 scratchpad `event-cache/`；暫時腳本 `_all-windows.ts`，未提交）。合格數／評分窗口數：

| 職業 | 規則 | 結果 |
|---|---|---|
| 騎士 | 戰逃反應 | 13/13、13/13、9/14、6/13、1/13；安魂祈禱都 ≥ 13/14；強化藥大多全部合格 |
| 武士 | 明鏡止水 | 17/17、16/16、8/8、11/15 |
| 暗黑騎士 | 血亂 | 4 人全部合格；強化藥 0/1～2/3（暗影鋒 5 次、暗影使者 2 次較嚴） |
| 絕槍戰士 | 無情 | 6/6（修正終結之心前為 3/6） |
| 占星術師 | 占卜 | 7/7、4/7（拿掉焚灼前為 2/7、3/7） |
| 賢者 | 活化 | 全部合格；強化藥 1/3～3/3（發炎III 2 次） |
| 龍騎士 | 三種窗口 | 11/13～13/13，少數 GCD 少 1 個 |
| 忍者 | 百雷銃 | 3/14（雷遁之術只用 1 次 ×9、強甲破點突 ×7） |
| 毒蛇劍士 | 祖靈降臨 | 17/18～19/20；蛇靈氣 後 30 秒 4/7～7/7 |
| 吟遊詩人 | 三重 Buff | 7/7、2/7 |
| 舞者 | 技巧舞步結束 | 3/3、6/7、7/7 |
| 武僧 | 紅蓮極意／義結金蘭 | 5/6、3/3 |
| 赤魔道士 | 魔元化 | 7/7 |
| 召喚士 | 灼熱之光 | 7/7 |
| 繪靈法師 | 星空構想 | 4/7、4/7（重錘不足 3 次較常見） |
| 戰士／白魔／機工 | 強化藥 | 0/1～1/3（強化藥窗口要求較嚴） |

- 依驗證調整：絕槍戰士的終結之心改為窗口內用了血壤才要求（7.4 以前的規則）；占星術師占卜拿掉焚灼（xivanalysis 該規則沒有嚴重度、只在表格顯示）。
- 名稱修正：規則註解與 DESIGN.md 中憑記憶寫的名稱，改用 Action 表的官方繁中。例如：
  - 瀝血劍、榮耀之劍、曉風、陰冷收割、夜遊魂收割
  - 重錘掠刷、莫古利激流、馬蒂恩懲罰
  - 六合星導腳、三連詠唱

## 外部資料來源調查：cactbot 戰鬥時間軸（2026-09-27）

目的：確認能否用 cactbot（OverlayPlugin/cactbot，Apache-2.0）的時間軸檔案得知「哪些技能是同一個隨機機制」，以及是否能與本站的對齊與繁中服日誌配合。檔案：`ui/raidboss/data/07-dt/raid/r5s.txt`／`r7s.txt`／`r8s.txt`（raw.githubusercontent.com）。格式：`時間 "名稱" Ability { id: ["A39E", "A39D", …], source: "…" }`，同一個時間點的隨機變化（或同一招的多個 ID）寫在同一個條目的 id 陣列；另有 `--sync--` 條目（重新同步用）、`jump`／`label`。以 scratchpad 腳本比對 M5S（`BF76r8yKh4wGaYkm` #1 vs `BQZ9kMd7KpR8J34D` #11）、M7S 武士、M8S 騎士三組比較：

- **技能 ID 一致**：cactbot 的 16 進位 ID 就是繁中服日誌的技能 ID（例：Flip to A-side A750＝42880、Stonefang/Windfang A39D～A3A2＝41885～41890、Eminent/Revolutionary Reign A911～A914＝43281～43284、Wolves' Reign (circles) A398／A7AF＝41880／42927）。繁中服與國際服共用遊戲資料的技能 ID。
- **cactbot 只列每個機制的主要 ID**：日誌中 Boss 施放的不同 ID 只有 44%（M5S）、70%（M7S）、51%（M8S）出現在 cactbot；沒有的是多段判定與隱形施放者的 ID（例：Get Down! 的後續判定、Play A-Side #37832、各指向的第 2～4 段、M8S Wind Surge ×92、Stonefang #41905）。所以 cactbot 無法取代日誌推出的資料，只能補充。
- **分組不衝突**：本站從兩場比較推出的隨機機制組（M5S 14、M7S 12、M8S 10 組）中，能在 cactbot 找到的（M5S 9、M7S 6、M8S 7 組，含 3 組在 `--sync--` 條目）都落在**同一個** cactbot 條目；沒有任何一組被 cactbot 分到不同條目。找不到的都是上述的後續判定 ID。
- **時間與「從 0 開始」一致**：cactbot 條目時間與我的日誌中同 ID 施放的差距，M5S 前 3 分鐘 0.3～1.3 秒（隨時間慢慢累積）、M7S 全部在 ±0.5 秒內（104／104）、M8S 推進前 0.2～2.2 秒；M8S 推進後（依血量）固定時間比對不到（42／122），cactbot 以 sync 條目重新同步，概念與本站的錨點相同。
- **可用之處**：機制的可讀名稱（例如 "Wolves' Reign (cones)"，以主要 ID 的繁中名稱顯示）、新 Boss 第一場比較就知道主要 ID 的分組；後續判定的 ID 仍需依時間歸到最近的主要機制，或沿用本站的比較法。
- **採用**：使用者判斷對玩家重要的是主要 ID，因此機制差異表與搜尋前輩日誌只比較 cactbot 的主要機制（見「Boss 機制差異」的「主要機制資料」）；對齊仍用全部施放。

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
早期（對齊只有最長遞增子序列時）的實測，目前的做法與 9 組比較的結果見「前端資料處理／時間軸對齊」。

| 比較 | 錨點 | 時間差 | 觀察 |
|---|---|---|---|
| 同隊 Sugar Riot 滅團 vs 擊殺（`WATKBdHRh7m8PNQt` #10／#11） | 107 | -0.1～+0.3 秒 | 腳本幾乎完全一致 |
| 不同隊伍 Howling Blade（`pwTF16cgnB9G7fWM` #29／`bX97vBapCPwKndL6` #3） | 197 | -4.3～+0.2 秒 | 時間差呈階梯狀（0 → -2.6 → -4 秒），對應轉場提前 |
| 參考快 55 秒（`pwTF16cgnB9G7fWM` #29／`h6gRJZ2pfDFYMPjX` #13） | 175 | -16.5～+0.7 秒 | 0～206 秒為 0，之後 -3.5、-5.6，約 400 秒起穩定 -16.4 秒 |
| 武士比較基準 | 194 | -6.8～+0.2 秒 | |
| 騎士比較基準 | 171 | -9.3～+1.4 秒 | |
| 黑魔驗證 | 161 | -12.5～+0.7 秒 | |

原型比較：不限制施放次數時，高頻的 42672（50 次以上）造成錯誤配對（假的 3.8～6.9 秒時間差）並把正確錨點擠掉；限制 ≤ 8 次後回到 -0.1～+0.3 秒。最大無錨點區間 56 秒（402～459 秒，Howling Blade 轉場）；轉場提前是跳躍，但線性內插會把它平均分散在區段內。

轉場前後（2026-09-27，以 `scratchpad` 腳本對兩組比較基準跑 `buildAlignment()`）：Howling Blade 第一階段最後一招（`unknown_a38f` #8，Boss 血量到了才施放）也是錨點，轉場演出兩邊都是 56.5 秒，因此跳變集中在「最後一個共同錨點 → 轉場那招」這一小段，轉場後時間差固定（騎士 −9.3 ± 0.2 秒、武士 −6.7 ± 0.1 秒），不會把差距分散到 56 秒的轉場內。代價是我多花的時間被擠進參考很短的時間：騎士基準我 6:30.8～6:40.5（9.7 秒）對到參考 6:30.4～6:31.2（0.8 秒）。

`pushDifferences()` 實測：騎士 8.9 秒（我 6:30.8～6:40.5／參考 6:30.4～6:31.2）、武士 6.7 秒（6:32.2～6:47.8／6:32.4～6:41.3）、黑魔 11.3 秒（6:15.5～6:37.1／6:14.6～6:24.9）；熱舞綠光（`BF76r8yKh4wGaYkm` #1／`b3ph7JxjD4BkVL6Q` #20）原本誤判一筆（兩段跳變合併後為 0 秒），加上合併後重算即排除。武士第一階段 5:56 的 Moonbeam's Bite（隨機機制）造成 −3.8 秒的單點抖動，前後中位數不變，不算推進。

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
- **FFLogs 權杖端點 429**（2026-09-26）：短時間內多次部署 Worker 並測試後，`/oauth/token` 回 429，所有報告查詢失敗約數分鐘後自行恢復。權杖只快取在 isolate 記憶體，每次部署或新 isolate 都會重新取權杖。Worker 現在把權杖的 429 轉成 503，前端對 429／503 顯示「請求過多…請稍候一分鐘再試」。若再發生頻繁，可考慮把權杖放進 `caches.default` 或 KV 跨 isolate 共用。
- **摘要顯示的名稱**：`useSides()` 只依 ID 載入事件，`SideData.selection` 是載入當時的選擇（Boss 名稱可能還是英文）；`ComparisonLoader` 會把目前的選擇合併回 `SideData` 再交給 `Loaded`。
- **技能名稱查詢延遲**：`/abilities` 快取未命中時約 8 秒；在瀏覽器驗證繁中名稱時要等比較載入後再多等幾秒。
- **CSS 手機規則的位置**（2026-09-27）：`@media (max-width: 560px)` 區塊原本在 `index.css` 中段，之後才定義的元件樣式（狀態面板、圖示等）以相同權重蓋掉了手機規則，使部分手機調整沒有生效；手機區塊移到檔案最後。新增元件樣式要放在該區塊之前。
- **PowerShell 5.1 寫檔**：`Set-Content -Encoding utf8` 會在檔案開頭加 BOM；改用 Edit／Write 工具或 Node 寫檔。

## 技術上的已知限制

- 推進時間不同（例如轉場提前）是跳躍；轉場前後都有錨點時（Howling Blade 實測如此），跳變集中在很短的區段，我多花的時間在時間軸上會擠在一起（以推進差距標示）。若某個 Boss 在推進點前後缺少錨點，線性內插會把跳變分散到較長的區段，誤差數秒。
- 技能繁中名稱依賴第三方 Boilmaster 鏡像，失效時退回英文。
- 冒煙測試只用固定的測試報告 `WATKBdHRh7m8PNQt`；若該報告被刪除或設為私人，冒煙測試會失敗，需換報告。
- 奪魂者尚未以實際日誌驗證 GCD 分類。

## 技術變更紀錄

### 2026-09-28 俯視圖三種視角
- `positions.ts` 新增 `alignToBoss()`；`Comparison.tsx` 另算 `mineAlignedSamples`；`Positions.tsx` 的 `Arena` 分 `two-bosses`／`aligned`（`BossMarker` 畫圓點或邊緣箭頭），視角存在 `localStorage` 的 `arenaMode`（舊值 `arena` 視為兩個 Boss，預設 `aligned`）。站位差異仍以原始位置計算（驗證見「站位」）。

### 2026-09-28 cactbot 解析 `# Ability`；機制差異以同機制版本優先
- `scripts/gen-mechanics.mjs` 的正規表示式接受 `# Ability`，重新產生後 M5S 放縱勁舞 42861／42862 合為一組。修正前 M5S `BF76r8yKh4wGaYkm` #1 vs `2HVnbyKxLYpcq739` #15 的放縱勁舞（3:03～3:22，每 2.4 秒一下、方向隨機）整段錯開一下（時間差 −2.7 秒），修正後 −0.5～0.1 秒。
- `mechanicDifferences()` 新增 `groupOf` 選項。12 組比較（加上 `2HVnbyKxLYpcq739` #15、M8S `p9KhwaDtZbkHdzG3` #10）的機制差異都沒有「只有一邊」的列，推進差距不變。

### 2026-09-28 機制差異一對一配對、略過推進時段的單邊施放
- `mechanicDifferences()` 改為一對一配對並新增 `pushes` 選項；`Comparison.tsx` 兩個機制差異都傳入推進差距。實測：M8S 武士基準的「只有我 空間斬」不再列出，多了 5:52.8 幻狼劍不同版本；M5S `3hCzxvn79fRTbQGP` #30 多了 4 列不同版本（放縱勁舞 3:05.8／3:13.2、徹夜狂歡 6:52.3／6:59.7）。

### 2026-09-28 時間軸推進空白、Boss 無法選中、普通攻擊名稱
- Worker 新增 `/reports/:code/targetability`；`load.ts` 的 `untargetableSpans()`、`SideData.untargetable`（`clipSide()` 一併裁切）；`analysis/displayAxis.ts`；`Timeline.tsx` 改用顯示時間（少打 GCD 的時段改傳我的時間）；`pushTitle()` 移除「施放會擠在一起」。

### 2026-09-27 對齊使用 cactbot 的機制分組
- `buildAlignment()` 新增 `knownGroups`：cactbot 同一條目的不同版本從第一次對齊就視為同一機制（`mergeGroups()` 與比較找出的組合併）。修正 M5S 兩邊 A 面／B 面整段相反時，第一次對齊把整段配到另一邊 19 秒後的同名技能。`mainMechanicDifferences()` 不列另一邊同一時間有非主要施放的「只有一邊」。10 組比較結果見「時間軸對齊」。

### 2026-09-27 主要機制資料（cactbot）
- 新增 `scripts/gen-mechanics.mjs` 產生 `src/analysis/mechanicData.generated.ts`（encounterID → 主要機制的技能 ID 組）；`src/analysis/mainMechanics.ts` 提供 `mainMechanicGroups()`、`mainMechanicDifferences()`、`variantMechanics()`，取代 `mechanicMatch.ts`。`Comparison.tsx` 另算 `mainMechanics` 給機制差異表（`mechanics` 仍給站位與建議）。授權聲明加入 cactbot（Apache-2.0）。

### 2026-09-27 冷卻技是否好了就用
- 變更：
  - `src/jobs/cooldownRules.ts`：21 個職業的冷卻技組（`COOLDOWN_RULES`，共 106 筆含版本變體），移植自 xivanalysis dawntrail（b240252）各職業的 `CooldownDowntime`／`OGCDDowntime`／`GeneralCDDowntime`／`Cooldowns`／`oGCDs` 模組；技能 ID、冷卻時間、充能取自 xivanalysis `src/data/ACTIONS`（root＋版本層），115 個 ID 已以 Action 表英文名稱查證。版本變體：絕槍烈牙（7.4 起 2 次充能）、血壤（7.4 前 120 秒容許 10 秒延遲，之後 60 秒）、黑魔黑魔紋（7.1 起 2 次充能）、三連詠唱（7.2 前）、繪靈 Striking Muse（7.2 以外）。xivanalysis 的特殊計數（暗黑以 Scorn 效果計算 Living Shadow、忍者夢幻三段重複時間戳）未重現，以註解標註；絕槍 Sonic Break 的 `firseUseOffset` 拼字錯誤照原行為（0）。
  - `src/analysis/cooldowns.ts`：`maxUsages()`（移植 xivanalysis 的 `calculateMaxUsages`，含充能、`resetBy`、停機時累積充能）、`lateUses()`（以實際使用模擬充能，充能已滿的閒置時間扣掉停機與容許延遲）、`downtimeWindows()`（Boss 沒有位置、至少 5 秒的時段）、`cooldownUsage()`。
  - `patch.ts` 新增 `rulesForPatch()`／`pairRulesByPatch()`，技能窗口與冷卻技共用。
  - `Metrics.tsx` 的「冷卻技」分頁、`advice.ts` 的 `cooldownAdvice()`（已追蹤的技能不再出現一般的「少用」建議）。
- 修正經過：
  - 冷卻好的時間比實際施放晚幾毫秒（冷卻時間的四捨五入）時，模擬把那次施放當成沒有充能，計時沒有重設，下一次使用被算成晚了一整輪（騎士戰逃反應 573.296 秒施放、下一次在 634.1 秒被誤判晚 59.5 秒）。改為充能為 0 卻能使用時從這次使用重新計時。
  - 開打前用過的冷卻技（武士的明鏡止水）FFLogs 沒有施放紀錄，被算成 0:00 起閒置（M7S 誤判晚 26 秒）。改為開打當下身上有同名效果（英文名稱比對）時視為 0:00 用了一次。
  - 實際次數可能超過理論上限（參考明鏡止水 17／16），顯示與建議都以實際次數為上限（xivanalysis 同樣封頂 100%）。
- 基準結果（我／參考，用了／最多可用）：
  - 騎士：戰逃反應 13／13、13／13（晚用 1 次：轉場後 Boss 回來 15 秒才用）；調停 6／28 對 26／27（唯一的建議）；償贖劍 24／25、23／25。
  - 武士 M8S：明鏡止水 16／17 對 17／17、必殺劍·紅蓮 13／14 對 13／13、意氣衝天 7／7 對 7／7。
  - 武士 M7S：明鏡止水 13／13、必殺劍·紅蓮 10／11 對 11／11、意氣衝天 6／6。
### 2026-09-27 遊戲版本
- 變更：新增 `src/jobs/patch.ts`（`patchAt()`、`inPatchRange()`，繁中服的版本日期表；使用者決定只處理繁中服日誌，第一版的國際服日期表與伺服器判斷已拿掉）；`WindowRule` 新增 `patches`（適用版本範圍）與 `patchNote`，同一個 key 可有多個版本的規則，`windowRules(subType, patch)` 取第一個適用的；`pairedWindowRules()` 依 key 配對兩邊各自版本的規則；`WindowSummary.inapplicable` 表示該側版本沒有這條規則（`inapplicableSummary()`，建議不比較）。`Comparison.tsx` 的 `sidePatch()` 以 `report.startTime + fight.startTime` 判斷版本。
- 調查：
  - FFLogs 報告沒有遊戲版本：`masterData.gameVersion` 固定為 1（遊戲種類），`logVersion` 是 FFLogs 解析器版本（2026-08 的日誌為 75、2026-09 為 76）。
  - xivanalysis 依伺服器區域（GLOBAL／KOREAN／CHINESE）＋日期判斷版本（`src/data/PATCHES/patches.ts`），沒有繁中服；繁中服日誌在 FFLogs 被標成 JP 或 CN，會被當成國際服或國服而判為 7.4 以上。
  - 繁中服版本日期（官方公告與新聞）：7.1 2026-04-21、7.2 2026-07-28、7.25 2026-09-23；7.4 不在繁中服 2026 年的排程中。國際服：7.4 2025-12-16、7.5 2026-04-28。
  - xivanalysis 技能窗口中依版本分支的只有三處：`gnb/NoMercy`（7.4 起終結之心每窗都要求）、`rdm/Manafication`（`patch.after('7.3')` 起不初始化）、`pct/StarryMuse`（`patch.is('7.2')` 的特別規則）。
- 驗證：
  - 基準日誌都判為繁中服 7.2（8 月）或 7.25（9 月下旬）。
  - 繁中服 7.2 的內容搭配 **7.3 的職業技能調整**（使用者確認），因此 `patchAt()` 回傳繁中服版本與對應的國際服版本（`GamePatch.key`／`rules`，xivanalysis 的規則依國際服版本撰寫），規則依 `rules` 選用，介面只顯示繁中服版本。第一版把繁中服 7.2 直接當成國際服 7.2，繪靈（FXLkqaK32PhQH8Ac #1）套用了 7.2 的特別規則（不合格原因變為「GCD 只打 8 個」）；對應到國際服 7.3 後回到一般規則（4/7，重錘不足 3 次）。繁中服 7.0～7.15 的職業技能等同國際服 7.2（使用者確認），這段期間的繪靈日誌套用國際服 7.2 的星空構想規則。
  - 第一版曾以國際服絕槍（PnrG9CYmQHxV3yhN #5，Midgardsormr，7.5）對照繁中服絕槍（kCcYLfbxnTJ91Md6 #7，7.25），確認版本不同時的規則差異說明與各自評分；之後依使用者決定只處理繁中服。
- 維護：**繁中服每次改版都要更新 `patch.ts` 的 `TC_PATCHES`**；xivanalysis 新增版本分支時同步規則。
### 2026-09-27 rDPS
- 變更：Worker 新增 `GET /reports/:code/damage-done?fight`（`DAMAGE_DONE_QUERY`），只回傳 `totalTime` 與每位角色的數字欄位（`total*`、`activeTime`），省掉技能明細；前端 `fetchDamageSummary()`（`client.ts`）換算成每秒 DPS／rDPS／aDPS，`Comparison.tsx` 的 `useDamageSummaries()` 載入兩邊（不阻擋比較結果），摘要表新增 rDPS 列。
- 資料：見「繁中服排名／調查」— 繁中服日誌不排名但傷害表仍有 rDPS。騎士基準 15,853 對 20,788、武士基準 25,513 對 32,590。
### 2026-09-27 以 Boss 為中心的俯視圖
- 變更：`PositionSample` 加上 `facing`（弧度；`actorPositions()` 從 resources 的 `facing` ÷ 100 取得）；`positions.ts` 新增 `bossPoseAt()`（位置沿用 `BOSS_LIMITS` 內插，面向取 5 秒內最接近的取樣）與 `toBossFrame()`；`Positions.tsx` 新增 `BossArena` 與視角切換（`localStorage` 的 `arenaMode`）；`Comparison.tsx` 把我的 Boss 位置換算成參考時間（`mineBossSamples`）傳入。
- 面向定義（以實際資料驗證）：FFLogs 的 `facing` ÷ 100 為弧度 θ，面向方向為 **(cos θ, sin θ)**（與 x、y 同一平面）。驗證方式：
  - Boss 普通攻擊坦克時 Boss 應面向坦克：(cos θ, sin θ) 與「Boss→坦克」夾角小於約 25° 的比例為 19/27（`khNfTaMtYwKBd36b` #10）、33/39（`YbakGgfzPQjJ4MK7` #5）、36/44（`dbN4HXY3QPzMRvDw` #4），其他假設（sin/cos 對調、正負號）都不到一半。
  - 玩家攻擊 Boss 的事件同時有玩家（`sourceResources`）與 Boss（`targetResources`，含面向）：M8S MT 在正面（±45°）52%、距 Boss 中心中位數 13.4 yalm（M8S Boss 體型大），與圖上的統計完全一致；M7S MT（騎士）86%、ST（絕槍）65% 在正面；近戰武士 M8S 27%、M7S 約 50%（M7S 打法常站在正面）。
- 注意：`masterData.actors` 涵蓋整份報告，subType Boss 也包含其他戰鬥的 Boss（例如 hqNYDGK9A4pmWVXB 有 Omega 等）；事件只含這場戰鬥，所以不影響。同名玩家可能有多個 actor，要以 `fight.friendlyPlayers` 確認。
- 開發時踩到：Vite 在 PowerShell 連續寫入同一檔時讀到寫入中的內容，提供了缺少新屬性的舊編譯結果（頁面整個崩潰）；重新存檔即恢復。
### 2026-09-27 Boss 本體位置與俯視圖範圍
- 變更：`load.ts` 新增 `bossPositions()`：Boss 位置取 masterData 中 subType 為 Boss 的角色（沒有時退回施放最多的敵人），取樣來自敵方施放與玩家事件（攻擊 Boss 的 `targetResources`、被 Boss 攻擊的 `sourceResources`）。`Positions.tsx` 的 `bounds()` 改為游標前後 10 秒（`VIEW_WINDOW_MS`）、最小 30 yalm、對齊 5 yalm；新增 `EdgeArrow`。
- 資料（M8S `pwTF16cgnB9G7fWM` #29、M7S `dbN4HXY3QPzMRvDw` #4／`YbakGgfzPQjJ4MK7` #5）：
  - 施放最多的敵人是隱形的機制施放者（M8S 84 號 325 次、M7S 14／37 號 320 次，subType `NPC`），不是 Boss 本體；Boss 本體為 subType `Boss`（M8S 第一階段 80 號、第二階段 107 號；M7S 11／35 號）。原本以施放最多者為 Boss，俯視圖的 Boss 與以 Boss 為中心的對稱判斷都用錯位置。
  - 玩家事件中的 Boss 位置取樣遠多於 Boss 的施放（M8S 安祖卡：80 號 1116 筆、107 號 1310 筆；Boss 施放 45＋38 次）。
  - 敵方位置（含分身、小怪）分布約 53 yalm，因此範圍只納入 Boss，並取 5%～95% 百分位。
- 俯視圖範圍實測（每秒取樣）：
  - M7S：前後 30 秒時換場前後約 60 秒放大到 110～160 yalm，改為 10 秒後大部分為 40～60 yalm，超過 100 yalm 只剩換場擊飛的約 18 秒；範圍整場切換約 34 次。Boss 只有 6:04 的 1 秒在圖外（顯示邊緣箭頭）。
  - M8S（武士基準）：範圍 40～50 yalm；沒有 Boss 位置只剩 3:12～3:55（Boss 無法選取、打小狼）與 6:52～7:18（轉場）。
  - 舊版（整場固定、只依玩家）：M8S 兩組基準 Boss 在圖外各 1～2 個時間點，另有約 30 個時間點沒有 Boss 位置。
### 2026-09-27 極限技 ID
- 變更：`gen-job-data.mjs` 多抓 `ActionCategory`，產生 `LIMIT_BREAK_IDS`（ActionCategory 9 與 15 都是 Limit Break、非 PvP）；`abilityUsage()` 排除這些 ID。
- 資料：極限技以玩家本人為施放者記錄（不是 `LimitBreak` 假角色），例如 FXLkqaK32PhQH8Ac #1 席德的 Doom of the Living（2 次）、pwTF16cgnB9G7fWM #29 忍者的 Chimatsuri、WATKBdHRh7m8PNQt #11 的 Big Shot 與 Last Bastion。
### 2026-09-27 職業技能也收同名的變體 ID
- 變更：`scripts/gen-job-data.mjs` 依名稱找技能時，職業技能之外也收同名、沒有 ClassJob 的變體（原本只在找不到職業技能時才用），重新產生 `generated.ts`。
- 原因：黑騎的暗影步在遊戲資料有 36926（DRK）與 38512（沒有 ClassJob）兩個 ID，FFLogs 報告的技能清單兩個都有，實際施放記錄為 38512，因此被歸到「非 GCD」而不是「移動」。另外補進的同名變體（例如 8755 Hallowed Ground、27834 Icarus、17764 En Avant）只在日誌出現時才有作用。
- 全職業位移技檢查：以 `Action`＋`ActionTransient` 說明文字篩出所有會位移（rush、jump、dash、move 等）的非 PvP 職業技能，說明沒有威力（不造成傷害）的有 18 個：Repelling Shot、Between the Lines、Retrace、Aetherial Manipulation、En Avant、Elusive Jump、Winged Glide、Shadowstride、Trajectory、Thunderclap、Shukuchi、Smudge、Hell's Ingress、Hell's Egress、Regress、Icarus、Slither、Aetherial Shift，全部已在 `movement`（加上職能的 Sprint、Peloton）。會造成傷害的突進（Intervene、Onslaught、Primal Rend、Gyoten、Corps-a-corps、Forked Raiju、Dragonfire Dive、Stardiver 等）維持輸出技能。再以 12 份測試報告的技能清單交叉檢查：同名但不在分類中的 ID 只剩 PvP 版本（例如 29430 En Avant、39184 Slither，`IsPvP` 為 true），PvE 沒有遺漏。
### 2026-09-27 推進差距
- 變更：`alignment.ts` 新增 `pushDifferences()`、`pushTitle()` 與 `PushDifference`；`AdviceInput.pushes` 與 `pushAdvice()`；`Timeline` 新增 `pushes` prop（Boss 列的 `.push-marker`）；對齊說明列加上可點擊的 `.push-chip`。
- 原因：使用者詢問轉場前長度不固定時轉場後是否對齊；驗證結果見「實測結果／時間軸對齊」。
### 2026-09-27 排名掃描先掃最近兩天
- 變更：`crawl()` 拆成 `scanPage()`＋兩段：先掃最近 2 天（新的 `crawl_state` 鍵 `zone68:recent_start`、`zone68:recent_page`），再用剩下的頁數補舊資料（沿用 `cursor`／`page`）；補舊資料追上「現在 − 2 天」即停止，取代原本「追上現在後回頭重掃最近 2 天」。`CrawlResult` 新增 `recentPages`。每小時的總頁數與點數不變。
- 原因：補資料由舊往新，近期擊殺要等約 2.5 天補完才會出現；使用者選擇先掃最近兩天（不增加 API 用量）。

### 2026-09-27 死亡
- 變更：`load.ts` 新增 `deaths()`、`deathAt()`，`SideData` 新增 `deaths`（`clipSide()` 會裁切）；`AdviceInput` 新增 `deaths`、`mineDurationMs`。
- 資料：
  - `death` 事件的 `targetID` 是死者，`killingAbilityGameID`／`killerID` 是致命一擊與擊殺者（`abilityGameID` 為 0）。致命一擊偶爾缺少（例如 WATKBdHRh7m8PNQt #2 滅團時多人），改用死前最後一次受到的 `damage`。
  - FFLogs 沒有「復活」事件，以死亡後第一次自己施放技能的時間當作恢復行動（被拉起後到開始行動的空檔也算在內）；到戰鬥結束都沒有則為 null。
  - 快取的 48 位玩家中有 13 次死亡（多數是 WATKBdHRh7m8PNQt #2 的滅團）。

### 2026-09-27 讀條
- 變更：`load.ts` 新增 `castBars()`，`SideData` 新增 `castBars`；`StatusPanel` 顯示讀條與最近使用的技能（取自 `playerCasts`）。
- 資料：`begincast` 帶有 `duration`（該次的詠唱時間，已含加速，例如炎之四 1660 ms）。黑魔基準 152 次詠唱全部接著同技能的 `cast`。詠唱中不能使用其他技能，所以在同技能 `cast` 之前出現其他施放或新的詠唱，就視為原本的詠唱已取消。

### 2026-09-27 播放列與當下狀態
- 變更：
  - `analysis/buffs.ts` 新增 `playerAuras()`、`aurasAt()`、`hpSamples()`、`hpAt()`；`SideData` 新增 `auras`、`hp`（不裁切）。
  - 新增 `compare/Playback.tsx`、`compare/StatusPanel.tsx`（只列 `sourceId` 為玩家自己、非 Debuff 的效果）；`Timeline` 新增 `follow`，並把技能列拆成 `memo` 的 `TimelineLanes`。
- 資料：玩家的全部事件（`sourceID` 為玩家）中也包含別人對玩家的事件，別人給的 Buff、敵人給的 Debuff 都在其中。以騎士基準為例：隊友給的 `applybuff` 225 筆、敵人給的 `applydebuff` 61 筆（魔法／物理受傷加重、傷害降低等）。血量取自 `source／targetResources` 的 `hitPoints`、`maxHitPoints`、`absorb`。
- 效能：
  - 播放時游標最多每 50 ms 更新一次。
  - 不隨游標變動的區塊（建議、技能窗口、機制差異、指標）以 `useMemo` 包成 JSX；時間軸的技能列為 `memo` 元件（其標示陣列在 `Comparison` 以 `useMemo` 固定）。這樣游標更新時只重繪游標線、站位圖與當下狀態。
- 注意：播放以 `requestAnimationFrame` 推進，瀏覽器分頁被遮住或隱藏時不會前進（開發時在隱藏的瀏覽器面板中無法驗證播放）。

### 2026-09-27 繁中服掃描改為每小時
- 變更：`crons` 改為 `7 * * * *`，`PAGES_PER_RUN` 改為 6。
- 原因：使用者表示專案不需要高頻更新；實測每天的報告量不大（見「繁中服排名」）。

### 2026-09-27 繁中服排名資料庫
- 變更：建立 Cloudflare D1 `ff14-copycat-rankings`（綁定 `DB`）與定時觸發；新增 `worker/src/crawler.ts`、`worker/schema.sql`、`/tc-rankings` 端點；Worker 的 GraphQL 呼叫整理為 `queryGraphql()`；`fetchFightEvents()` 的戰鬥參數只需 ID 與起訖時間。
- 原因：FFLogs 不替繁中服排名，自建排名以支援「從繁中服排名找參考日誌」（見 DESIGN.md）。過程中曾加入國際服排名端點與暫時的探索查詢，確認不適用後都已移除。

### 2026-09-27 連結保存在本頁網址
- 變更：新增 `src/pageQuery.ts`（`readLogParam()`／`writeLogParam()`，以 `history.replaceState` 更新 `?mine=`、`?ref=`，不增加瀏覽紀錄）與 `fflogs/url.ts` 的 `reportUrl()`；`LogPicker` 以網址參數為初始值，輸入時寫回，選好戰鬥與角色時改寫為 `reportUrl(code, fight, source)`（只改網址，不改輸入框，避免 `ReportSelector` 的 key 改變而重設手動選擇）。
- 原因：重新整理後保留輸入的連結（見 DESIGN.md）。

### 2026-09-27 其餘職業的技能窗口規則
- 變更：規則移到 `jobs/windowRules.ts`（18 個職業）；`WindowRule` 新增 `action`、`allOf`、`stacks`、`gcdAdjust`、`limitedActions`、`openerMs`，`ExpectedActions` 新增 `openerCount`、`onlyIf`；新增 `enemyDebuffWindows()`；`evaluateWindows()` 新增 GCD 間隔與戰鬥長度參數；`ruleIds()` 供查詢名稱。
- 原因：移植 xivanalysis 其餘職業的窗口規則（見「技能窗口」）。

### 2026-09-27 技能窗口與開打前效果
- 變更：新增 `analysis/buffs.ts`（自身效果窗口、開打前效果）、`analysis/windows.ts`（窗口評估）、`jobs/windows.ts`（武士、騎士規則）、`compare/Windows.tsx`；`SideData` 新增 `buffs`、`prepull`；`Timeline` 新增 `windows`；Worker `/abilities` 支援 Status 表。Worker 已部署。
- 原因：依 xivanalysis 的職業規則做技能窗口分析，並顯示開打前的效果（見 DESIGN.md）。

使用流程與設計的變更見 DESIGN.md 的「設計變更紀錄」。

### 2026-09-27 對齊改為依時間配對
- 變更：`buildAlignment()` 的候選配對由「同一技能的第 n 次」改為「同一技能、時間差 120 秒內的所有施放」，由 `bestChain()`（錨點依與前一個的間距計分、時間差跳動扣分）選出從 0 開始、時間差穩定的一串；移除 `dropDetours()`、`levels()`、施放次數限制（`maxOccurrences`）與 `Anchor.occurrence`。保留隨機機制組與第二次對齊。
- 原因：使用者指出兩邊從 0 開始、A 面／B 面一定同時觸發，應依時間找機制。見「前端資料處理／時間軸對齊」。

### 2026-09-27 移除挑選錨點的實驗程式碼；整理對齊文件
- 修正：`6de6b96` 推送的 `bestChain()` 留有調參實驗用的 `globalThis.__jump`，扣分上限實際為 0.5（定稿的修改因同一指令中的刪檔動作被擋下而沒有執行）。改為定稿的上限 2，9 組比較結果與上限 0.5 時完全相同。
- 文件：「前端資料處理／時間軸對齊」「Boss 機制差異」改寫為完整流程（步驟、參數、原因、演進與 9 組比較的結果）。

### 2026-09-27 只比較兩邊都有記錄的施放者
- 資料：同一場熱舞綠光，`kCcYLfbxnTJ91Md6` #1 的敵方施放有 Frogtourage（青蛙舞者，gameID 18362）的伴舞波動 #42871、搖擺哈娑 #42869／#42870 等 86 次，`BF76r8yKh4wGaYkm` #1 完全沒有 Frogtourage 的施放（兩邊都有 Boss 本體 18361 與隱形的機制施放者）。因此機制差異列出多列「只有參考」，並混進同名的「不同變化」。另外 Boss 旁隱形施放者的 gameID 是 FFLogs 的臨時編號 2,000,000＋角色編號（2000021 與 2000013），每份日誌不同，不能跨日誌比對（第一版以 gameID 比對時把它當成只有一邊有，錨點由 138 掉到 81）。
- 變更：`TimedCast.source`（施放者的 gameID，`toCasts()` 對 Boss 施放附上，臨時編號不附）；`load.ts` 的 `withSharedCasters()` 在 `Comparison.tsx` 對齊之前去掉只有一邊有施放紀錄的敵人（沒有 source 的一律保留）。`Mechanics.tsx` 兩邊名稱完全相同的不同變化類型寫「不同版本」。
- 已知限制：前輩日誌搜尋的「機制相同」比對（`loadBossCasts()` 沒有角色資料）尚未套用。
- 驗證：該組機制差異由 12 列變為 7 列真正的差異，錨點 138、時間差 −1.4～−0.8 秒不變。

### 2026-09-27 錨點改依分數挑選
- 變更：`alignment.ts` 的 `longestIncreasing()` 改為 `bestChain()`（見「時間軸對齊」第 3 點）。
- 驗證：9 組比較中 M5S 五組時間差範圍都在 1.5 秒內、沒有推進差距；M8S 武士／騎士／黑魔的推進差距（6.7／8.9／11.3 秒）不變；M7S 不變。

### 2026-09-27 技能窗口的戰鬥尾聲放寬
- xivanalysis 調查（dawntrail 分支）：`ExpectedGcdCountEvaluator` 以 `calculateExpectedGcdsForTime()`＝`min(expected, ceil((end − start) ÷ GCD))` 計算（沒有層數的起點加 weaveDelay），窗口被戰鬥結束截斷時 end 就是戰鬥結束，要求自然降低（有層數的也封頂）；`ExpectedActionsEvaluator` 預設不降低，由各職業的 `adjustCount` 處理。`BuffWindow.isRushedEndOfPullWindow()`＝「效果持續時間 ≥ 戰鬥剩餘時間（從窗口開始算）」，BuffWindow 本身沒有使用，由職業模組呼叫：例如 `drg/modules/BattleLitany.tsx` 在趕時間的窗口每項技能要求減 1（Nastrond 減 `NASTRONDS_PER_WINDOW`）；`pld/modules/FightOrFlight.tsx` 沒有任何尾聲處理。
- 變更：`evaluateWindows()` 新增 `fightEndMs`（這一側不裁切的戰鬥長度）。未結束（`openEnded`）的窗口結束點離戰鬥結束 ≤ 1 秒時為被擊殺截斷（`EvaluatedWindow.rushed`）：照常評分，GCD 數一律依長度封頂（含 `stacks`），`expectedActions` 每項減 1（減到 0 不要求）；其餘未結束的（被比較範圍截斷）維持不評分。以窗口是否到戰鬥結束判斷，而不是 xivanalysis 的「效果持續時間 ≥ 剩餘時間」，因為我們的窗口結束點已是實際截斷點。
- 驗證：騎士基準參考的最後一次強化藥（12:23～12:52，擊殺 12:52）由不評分改為合格並註明尾聲；我的最後一次強化藥（被比較範圍 13:01 截斷）仍不評分。

### 2026-09-27 確認報告改為獨立的定時觸發
- 變更：`wrangler.toml` 新增 `37 * * * *`；`pruneGoneReports()` 改為匯出、獨立執行（每次最多 40 份，回傳 `checkedReports／removedReports／failedReports`，非私人／刪除的錯誤以 `console.warn` 記錄）；`crawl()` 計算對外請求數並在上限前停止。Worker 已部署。
- 原因：Workers 免費方案每次執行最多 50 個對外請求，確認排在掃描之後只做到 3 份（見「繁中服排名／實作」）。

### 2026-09-27 Boss 強制控場
- 變更：`buffs.ts` 新增 `debuffsOnPlayer()`（敵人施加在玩家身上的 applydebuff／removedebuff；原本的 `enemyDebuffWindows()` 是玩家施加在敵人身上的），`SideData.bossDebuffs`（`clipSide()` 一併裁切，名稱也一併查繁中）；新增 `analysis/control.ts`：`controlStatuses()`（兩場每次期間 1～10 秒、期間內〔施加後 0.3 秒起〕沒有開始 GCD 的效果）、`controlWindows()`（重疊合併）、`attachControl()`（與停手區間重疊 ≥ 1 秒時設 `LostWindow.control`）；`Comparison.tsx` 去掉無名稱的效果（例如與完美收尾同時的 #1004515 Unknown_11A3）；`advice.ts` 的停手建議排除控場段、合併成一則參考；`Metrics.tsx` 顯示「控場」標籤；`StatusPanel.tsx` 以 `SideData.bossDebuffs`（完整資料）在讀條欄顯示控場條（`Comparison.tsx` 的 `control` 與 `namedStatus` 傳入）。控場效果的判斷不要求兩邊同時被施加，也不要求兩邊都有（每個效果收集兩邊所有期間，逐一檢查期間內有無 GCD）。
- 驗證：M5S `BF76r8yKh4wGaYkm` #1 對 `Kwx3LyFJjz26pYRm` #16 的 1:39.5–1:46.4、對 `YAzxqkpVfBNmcMwj` #1 的 5:43.4–5:49.4 標為控場（完美收尾）；對 `WBNDQCdcrP6A1qkv`、`kCcYLfbxnTJ91Md6` 兩邊控場時間相同，本來就不算少打。M8S 騎士（13 段停手）、武士（5 段）與 M7S 武士（9 段）沒有任何一段被標為控場。

### 2026-09-27 強制控場的 debuff（調查）
- 資料：M5S `BF76r8yKh4wGaYkm` #1（騎士 source 16）玩家全部事件中，敵人施加在玩家身上的 debuff 有：Burn Baby Burn（蹦迪，#1004461）1:18.3–1:41.8、5:26.0–5:45.5；緊接著 In the Spotlight（完美收尾，#1004471）1:42.3–1:45.3、5:46.0–5:49.1 與無名稱的 #1004515（Unknown_11A3，同一段時間）；另有魔法受傷加重、出血、音頻炸彈α、伴舞波動耐性降低等一般 debuff。完美收尾期間 GCD 由 1:39.5（先鋒劍）停到 1:46.4（暴亂劍），間隔 6.9 秒（正常約 2.5 秒）。
- 可行做法：以 applydebuff／removedebuff 取得控場時段（`buffs.ts` 目前只取自身施加的效果與施加在敵人身上的，需另外取敵人施加在玩家身上的），在少打 GCD 的時段中扣除或標示。哪些 debuff 算控場需要逐一列表（名稱無法判斷；無名稱的效果也可能是控場），或以「兩邊在同一段都停手」自動判斷。

### 2026-09-27 對齊時把隨機機制的變化視為同一機制
- 變更：`buildAlignment()` 改為兩次對齊，新增 `variantGroups()`；`occurrences()` 可依組編號（見「時間軸對齊」）。`dropDetours()` 保留，處理剩下的錯配。
- 原因：使用者指出放入 A 面／B 面、二連／三連／四連指向是成對的隨機機制，希望直接找出同一組。

### 2026-09-27 對齊改以分段去掉配錯的錨點
- 變更：`dropSpikes()`（逐一去掉孤立錨點）改為 `dropDetours()`（依時間差分段，去掉跳開又跳回的段與首尾的少數錨點段），見「時間軸對齊」。
- 原因：使用者回報 `WBNDQCdcrP6A1qkv` #16 開場仍未對齊（連續 5 個錨點配錯，逐一判斷的方法擋不住）。

### 2026-09-27 對齊也檢查首尾的孤立錨點
- 變更：`dropSpikes()` 對第一個與最後一個錨點改以單側判斷（見「時間軸對齊」）。
- 原因：使用者回報 M5S 比較出現奇怪的推進差距（M5S 沒有依血量推進的轉場，只有收尾長度不同）。

### 2026-09-27 強化藥依效果判斷
- 資料：繁中服的道具 ID 不一定對得上遊戲資料。`Kwx3LyFJjz26pYRm` #16（2026-08-04，騎士 source 83）在 0:06.6 與 6:14.5 使用道具 46026 HQ，之後身上出現強化藥效果（Medicated），但 FFLogs 與遊戲資料（xivapi 的 en／tc）都把 46026 對應到武器「Ceremonial Chakrams／典禮圓月輪」；2026-09 的繁中服日誌同一種藥記為 45995（Grade 3 Gemdraught of Strength），兩者相差 31。因此比較時被當成兩個不同技能，建議出現「典禮圓月輪少用 2 次」。
- 變更：`load.ts` 新增 `potionIds()`（使用後 3 秒內得到 Medicated〔1000049〕的道具）與 `unifyPotions()`（兩邊的強化藥統一成同一個 ID，沿用我的，我沒用過時用參考的）；`Comparison.tsx` 在該 ID 的英文名稱不像藥水時改顯示「強化藥」並用強化藥效果的圖示；藥水名稱判斷移到 `fflogs/report.ts` 的 `isPotionName()`，另有 `isItemId()`。

### 2026-09-27 隱藏沒有名稱的 Boss 技能
- 資料：熱舞綠光的 #42693 在 FFLogs 顯示為 `unknown_a6c5`（`unknown_` ＋ 16 進位 ID）；遊戲資料 Action 表的名稱在英、日、簡中、繁中都是空字串（ActionCategory 為 Ability），`/abilities` 查不到名稱。實際為 Boss 對 `Environment` 施放、沒有傷害的動作，出現在下一個機制開始前約 2 秒（`BF76r8yKh4wGaYkm` #1：0:21 放入A面前、1:11 迪斯可地獄前、2:22 大合奏前），應為演出或移動。
- 變更：`fflogs/report.ts` 新增 `isUnnamedAbility()`；`Comparison.tsx` 以含無名技能的 Boss 施放建立對齊（仍是有用的錨點），之後以 `load.ts` 的 `withoutUnnamedBossCasts()` 移除，機制差異、站位卡片與建議、當下狀態、時間軸都不顯示；`abilityName()` 遇到這類名稱顯示「無名稱技能」。

### 2026-09-27 站位差異附上隨機機制差異
- 變更：`positions.ts` 新增 `Divergence.variant` 與 `attachVariants()`（區段期間或開始前 `VARIANT_LEAD_MS` 10 秒內的 `kind === 'variant'` 機制差異；建議的 `mechanicNote()` 共用同一個常數）；`Comparison.tsx` 先算 `mechanicDifferences()` 再算站位；`advice.ts` 的 `positionAdvice()` 排除有 `variant` 的段、合併成一則；`Positions.tsx` 顯示「機制不同」。
- 實測：熱舞綠光 `BF76r8yKh4wGaYkm` #1 vs `YAzxqkpVfBNmcMwj` #1 的 7 段站位差異中，3:58–4:15 標為機制不同（我 4 拍節奏／參考 8 拍節奏）；開場 A 面／B 面期間兩人相距未超過 8 yalm，沒有站位差異。

### 2026-09-27 對齊去掉孤立錨點
- 變更：`buildAlignment()` 在 LIS 之後以 `dropSpikes()` 去掉時間差與前後都不同的錨點（見「時間軸對齊」）。對齊（時間軸換算）、推進差距與 Boss 機制差異都受影響。
- 原因：使用者回報熱舞綠光比較出現明顯錯誤的推進差距；原因是隨機順序的機制配錯錨點。

### 2026-09-27 排名每場各自計算 PR
- 變更：`tcRankings()` 的名次與 PR 改為每場擊殺各自計算（見上方實作），不再沿用玩家最好一場的 PR。實測武士 M8S PR 90～100：安祖卡 29,431 那場自己的 PR 低於 90，不再列出。
- 原因：見 DESIGN.md。

### 2026-09-27 繁中服排名改用 rDPS
- 變更：`parses` 新增 `rdps` 欄位與 `parses_rdps` 索引（正式資料庫以 `ALTER TABLE parses ADD COLUMN rdps REAL` 加上，`schema.sql` 已同步）；`crawl()` 存入 rDPS，並以 `fillRdps()` 替舊紀錄補上；`tcRankings()` 依 rDPS 排名並回傳 `rdps`。上線時舊紀錄另以 scratchpad 腳本透過已部署的 `/reports/:code/damage-done` 端點一次補齊（365 場戰鬥）。
- 原因：使用者要求排名比較使用 rDPS（詳見 DESIGN.md）。
- 後續（同日）：去重改用戰鬥的實際開始時間，DPS 不再需要，移除 `dps` 欄位、`parses_rank` 索引與 `fillRdps()`（正式資料庫以 `ALTER TABLE parses DROP COLUMN dps` 移除；報告 `613M9CjHKbmXT7rL` 已被設為私人、查不到 rDPS，刪除其 8 筆紀錄）。

### 2026-09-27 定期移除設為私人或刪除的報告
- 變更：`crawl()` 最後執行 `pruneGoneReports()`；`scanned_reports` 新增 `checked_at`（正式資料庫以 `ALTER TABLE scanned_reports ADD COLUMN checked_at INTEGER` 加上）。
- 原因：使用者要求定期清理；收錄後被設為私人的報告（例 `613M9CjHKbmXT7rL`）會留在排名中但打不開。

### 2026-09-27 排名回傳每人所有擊殺
- 變更：	cRankings() 不再 GROUP BY name, server，改在程式中計算每人最好一場的名次與 PR，回傳範圍內玩家的所有紀錄並去除重複上傳；ReferenceFinder 的 MAX_LISTED 20 → 40。Worker 已部署。
- 原因：只取最好一場時常找不到隨機機制相同的參考（見 DESIGN.md）。

### 2026-09-26 MT／ST 查詢端點；隊伍位置排序
- 變更：Worker 新增 `/reports/:code/auto-attacks-taken`（`table` 查詢，DamageTaken＋名稱過濾）；`jobs/names.ts` 新增 `sortByPartySlot()`、`isStandardParty()`；`Dropdown` 新增 `lockLabel`。Worker 已部署。
- 原因：角色選單依隊伍位置排序並依實際坦 Boss 判斷 MT／ST（見 DESIGN.md）。

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
