# 系統設計

本文件描述 FF14 CopyCat **目前的設計**（架構、資料流、分析方法與規則）與設計變更紀錄。實測資料、資料來源調查、驗證結果與參數調整經過見 [TECH_NOTES.md](TECH_NOTES.md)；開發指令見 [CLAUDE.md](../CLAUDE.md)。

## 架構

```
瀏覽器 ──► GitHub Pages（前端，靜態）
   │
   └──► Cloudflare Worker 代理 ──► FFLogs API v2（GraphQL，client credentials）
                               └─► Boilmaster 鏡像 xivapi-v2.xivcdn.com（技能繁中／簡中名稱）
```

- **前端**：Vite + React + TypeScript，部署於 https://pinchiehyu.github.io/FF14CopyCat/ ，由 GitHub Actions 在 push 到 `main` 時建置部署（Pages Source 必須為 GitHub Actions）。
- **CI／CD**（`.github/workflows/deploy.yml`）：每次 push 到 `main` 自動執行 lint → 單元測試 → 建置 → 部署 → **冒煙測試**（`scripts/smoke-test.mjs`）。冒煙測試對正式站與 Worker 發出實際請求：確認正式站已換成本次建置且指向 Worker、Worker 能回傳報告與含位置的事件、會拒絕未允許的來源；正式站更新有延遲，最多重試約 1 分鐘。Pull request 只執行到建置。
- **Worker 代理**：https://ff14-copycat-api.ff14-copycat.workers.dev ，持有 FFLogs client ID / secret（Cloudflare Secrets），訪客不需登入 FFLogs。手動以 `npm run worker:deploy` 部署。
- **前端取得 Worker 網址**：寫在 `src/config.ts`（網址非機密），可用 `VITE_API_BASE` 覆寫。

## Worker API

只開放固定端點，GraphQL 查詢寫死在 Worker 內，前端無法送任意查詢：

| 端點 | 內容 | 快取 |
|---|---|---|
| `GET /reports/:code` | 報告標題、fights、masterData.actors、masterData.abilities（技能名稱與圖示） | 10 分鐘 |
| `GET /reports/:code/events?fight&start&end[&source][&dataType][&hostility]` | 一頁事件（含位置資料 `includeResources`），前端依 `nextPageTimestamp` 翻頁 | 10 分鐘 |
| `GET /abilities?ids=1,2,3` | 技能的繁中名稱（見「技能名稱」） | 1 天 |

保護措施：Origin 白名單（CORS）、每 IP 每分鐘 60 次限流、成功回應依不含 Origin 的網址快取。所有訪客共用一組 FFLogs API 配額。

## 使用流程

1. 貼上兩個 FFLogs 報告連結（我的／參考）。
2. 載入報告，選擇戰鬥與玩家（排除極限技等假角色）。選擇的優先順序（`src/compare/autoSelect.ts`）：
   1. 使用者在下拉選單的手動選擇（換戰鬥時角色回到自動選擇）。
   2. 連結中的 `fight`、`source`。
   3. **參考日誌依「我的日誌」自動選擇**：戰鬥選同一 Boss（`encounterID`）的最後一次擊殺，沒有擊殺則選最後一場；角色在該戰鬥中與我同職業者恰好一位時自動選取，兩位以上或沒有時不選並提示原因。
   4. 都沒有時：戰鬥選最後一場，角色不選。
3. 兩邊都選好後，檢查是否可比較（同一 Boss `encounterID`、同一職業 `subType`），不符則顯示原因。
4. 各自載入玩家全部事件（`dataType=All&source=玩家`，取施放、普通攻擊與位置）與敵方施放（`dataType=Casts&hostility=Enemies`，取 Boss 施放與位置），共 4 個請求；時間換算為戰鬥時間。載入後另查技能繁中名稱。
5. 以 Boss 施放對齊時間軸，裁切到比較範圍，依序顯示：摘要（戰鬥長度、比較範圍、對齊錨點）→ 建議 → Boss 機制差異 → GCD 概況與少打 GCD 的時段 → 技能使用次數 → 站位比較 → 並排時間軸。

## 資料前處理（`src/compare/load.ts`）

- **玩家施放**：只取玩家自己（`sourceID`）的施放；施放時間取「開始施放」——有詠唱條的技能以同技能前一個 `begincast`（5 秒內）取代 `cast`，被打斷的詠唱不計。任何施放完成時清除尚未完成的 `begincast`（代表那些詠唱已被取消），避免之後瞬發同一技能時配對到過期的開始時間。
- **普通攻擊**（Attack #7、Shot #8）另存 `autoAttacks`：不畫在時間軸、不計入 GCD 與建議，只列入技能使用次數。
- **不紀錄的技能**（ignored 分類，例如坦克的挑釁、坦姿開關）在比較開始時就從玩家施放中移除（`withoutAbilities()`）。
- **Boss 施放**：敵方的 `cast` 事件。
- **位置**：事件中該角色為 source 的 `sourceResources` 或為 target 的 `targetResources`，座標 ÷100 為 yalm；同時間重複取樣去除。Boss 位置取施放最多次的敵人。

## 比較範圍

所有統計（GCD、少打 GCD 的時段、技能使用次數、站位、建議）只計算**兩場戰鬥都在進行的時段**：參考時間 0～`min(參考長度, mineToRef(我的長度))`，我的一側以 `refToMine` 換回自己的時間後用 `clipSide()` 裁切。較長一方超出的部分沒有比較對象，不列入統計；時間軸仍完整顯示，但以虛線與半透明遮罩標示「比較範圍外」，摘要列出比較範圍與被排除的秒數。Boss 機制差異只列到較短一方結束。

## 分析

開發順序（已與使用者確認，皆已完成）：① 時間軸對齊＋並排時間軸 → ② 通用指標 → ③ 站位比較 → ④ 建議。另有 Boss 機制差異與技能繁中名稱。

### ① 時間軸對齊（`src/analysis/alignment.ts`）

以參考日誌的時間為基準，把「我」的時間換算成參考日誌中「同一個機制」的時間：

1. 敵方施放依時間排序；同一技能 1 秒內重複施放（多個分身同時施放）視為一次。
2. 錨點候選 = 兩份日誌中「同一技能 ID 的第 n 次施放」。
3. 只用低頻技能：任一邊施放超過 8 次的技能（自動攻擊、反覆出現的招式）不當錨點，否則次數容易錯位。
4. 依我的時間排序後，取參考時間嚴格遞增的最長子序列（LIS），捨棄與時間順序矛盾的配對（例如隨機變化的機制）；同一時間點只留一個錨點。
5. 戰鬥開始 (0, 0) 為隱含錨點；錨點間線性內插，最後一個錨點後以斜率 1 外推。`mineToRef` 與反向的 `refToMine` 用同一組錨點。
6. 錨點少於 5 個時提示對齊可能不準。

### 並排時間軸（`src/compare/Timeline.tsx`）

- 橫軸為參考日誌時間，可縮放（10～80 px/秒）。
- 列：Boss 施放（錨點以紫色標示）、參考 GCD／oGCD、我 GCD／oGCD（已對齊）。無職業模組時不分 GCD／oGCD。
- 圖示來自 FFLogs `masterData.abilities` 的 `icon`；滑鼠停留顯示技能名稱（繁中＋英文）與原始／對齊後時間。
- 標示：我的戰鬥較短時以紅線標示結束位置；少打 GCD 的時段在我的列上以紅色區塊標示；比較範圍外以遮罩標示；共用時間游標以紫線顯示，點擊時間尺可移動游標。

### 職業模組（`src/jobs/`）

- `JobModule`：`subType`（FFLogs 的職業名稱）、中文名稱（`jobs/names.ts`）、`isGcd(abilityId)`，以及職業專屬技能的分類 `ignored`、`mitigation`、`movement`、`utility`。
- **所有 21 個戰鬥職業都有基本規則**，由遊戲資料產生（`scripts/gen-job-data.mjs` → `src/jobs/generated.ts`，`jobs/index.ts` 據此建立模組）：
  - **GCD**：Action 表中 `CooldownGroup` 或 `AdditionalCooldownGroup` 為 58（公共冷卻）的非 PvP 玩家技能，全職業共用一個集合。含有自己冷卻但會觸發公共冷卻的技能（例如 Meditate、Vicewinder），以及 GCD 較短的技能（舞者舞步、忍者結印、賢者 Eukrasia、機工 Blazing Shot 等）。
  - **職業專屬分類**：腳本中以 7.x 英文技能名稱列出各職業的減傷、移動、不紀錄、輔助技能，執行時查表取得 ID，名稱找不到就報錯。
  - 遊戲改版新增技能後重新執行腳本。之後各職業的詳細分析（類似 xivanalysis，例如冷卻與爆發窗口）可在 `jobs/` 下另建檔案擴充基本模組。
- **技能分類**（`jobs/roleActions.ts` 的 `abilityCategory()`，職能技能內建、職業專屬技能由模組提供）：

  | 分類 | 內容 | 處理 |
  |---|---|---|
  | ignored | 坦克的挑釁、退避、坦姿開關（Iron Will、Defiance、Grit、Royal Guard 與其解除） | 從時間軸、技能次數、建議中移除（使用者指定不需紀錄） |
  | mitigation | 減傷：Rampart、Reprisal、Feint、Addle，以及職業減傷 | **專屬建議**（使用者指定為重要的學習課題） |
  | movement | 衝刺，以及職業位移技能 | **專屬建議**（同上） |
  | utility | 其他輔助：True North、Arm's Length、Second Wind、Bloodbath、Lucid Dreaming、Interject 等 | 合併為一則低優先建議 |
  | normal | 其他（輸出技能） | 一般規則 |
- **職業名稱**：`jobs/names.ts` 內建所有職業的官方繁中名稱（遊戲 ClassJob 表），介面上的職業一律以繁中顯示（例如 BlackMage → 黑魔道士、Viper → 毒蛇劍士）。
- 職業專屬分類（完整清單見 `scripts/gen-job-data.mjs`）：
  | 職業 | mitigation（減傷） | movement（移動） | 其他 |
  |---|---|---|---|
  | 騎士 | Sentinel／Guardian、Bulwark、Hallowed Ground、Sheltron／Holy Sheltron、Divine Veil、Intervention、Passage of Arms、Cover | — | ignored：Iron Will 與解除；utility：Clemency |
  | 戰士 | Vengeance／Damnation、Raw Intuition／Bloodwhetting、Nascent Flash、Thrill of Battle、Holmgang、Shake It Off | — | utility：Equilibrium |
  | 暗黑騎士 | Shadow Wall／Shadowed Vigil、Dark Mind、The Blackest Night、Oblation、Living Dead、Dark Missionary | Shadowstride | |
  | 絕槍戰士 | Nebula／Great Nebula、Camouflage、Aurora、Superbolide、Heart of Light、Heart of Stone／Corundum | Trajectory | |
  | 白魔道士 | Temperance、Divine Caress、Aquaveil、Divine Benison | Aetherial Shift | |
  | 學者 | Sacred Soil、Expedient、Fey Illumination、Deployment Tactics | — | |
  | 占星術師 | Collective Unconscious、Neutral Sect、Exaltation、Sun Sign | — | |
  | 賢者 | Kerachole、Holos、Panhaima、Haima、Taurochole | Icarus | |
  | 武僧 | Riddle of Earth、Mantra | Thunderclap | |
  | 龍騎士 | — | Elusive Jump、Winged Glide | |
  | 忍者 | Shade Shift | Shukuchi | |
  | 武士 | Third Eye、Tengentsu | — | |
  | 奪魂者 | Arcane Crest | Hell's Ingress／Egress、Regress | |
  | 毒蛇劍士 | — | Slither | |
  | 吟遊詩人 | Troubadour、Nature's Minne | Repelling Shot | |
  | 機工士 | Tactician、Dismantle | — | |
  | 舞者 | Shield Samba、Improvisation、Curing Waltz | En Avant | |
  | 黑魔道士 | Manaward | Aetherial Manipulation、Between the Lines、Retrace | |
  | 召喚士 | Radiant Aegis | — | |
  | 赤魔道士 | Magick Barrier | — | |
  | 繪靈法師 | Tempera Coat、Tempera Grassa | Smudge | |

  職能技能（`jobs/roleActions.ts`）：ignored＝Provoke、Shirk、各坦克姿態與解除；mitigation＝Rampart、Reprisal、Feint、Addle；movement＝Sprint、Peloton；utility＝其餘職能技能。
- 新增職業時，以實際日誌計算以 `begincast` 為起點的相鄰 GCD 間隔驗證分類：分布應集中在該職業 GCD 附近，不應出現遠小於 GCD 的間隔（驗證結果記在 TECH_NOTES.md）。

### ② 通用指標（`src/analysis/metrics.ts`、`src/compare/Metrics.tsx`）

以「與參考在同一段戰鬥中比較」為原則，因為原始空檔包含 Boss 無法攻擊的時間，單看數字沒有意義。

- **GCD 概況**（需職業模組判斷 GCD）：GCD 數；GCD 間隔＝1.5～2.6 秒相鄰間隔的中位數，**上限 2.5 秒**（GCD 最長 2.5 秒，實測間隔受延遲略長，取樣時多容許 100 毫秒）；空檔總計＝每個間隔超出 GCD＋100 毫秒的部分加總。GCD 慢 10 毫秒以上時提示。
- **少打 GCD 的時段**：我的相鄰 GCD 間隔超過 max(1.5×GCD, GCD＋1 秒) 時，把該區間換算到參考時間，計算參考在區間內（兩端各留半個 GCD）施放的 GCD 數；大於 0 才列出。雙方都停手的時段自然被排除。點擊可捲動時間軸到該處。
- **技能使用次數**：各技能（含普通攻擊）我 vs 參考的次數與差距；標示「普通攻擊」「減傷」「移動」「GCD」。不紀錄的技能（ignored）不列出。
- **平均時機**：同一技能兩邊的使用依時間順序配對（不可交錯，相距 30 秒內），以動態規劃先求配對數最多、再求時間差總和最小，平均配對的時間差；允許跳過，避免次數不同時後面全部錯位。使用 30 次以上的技能不計算。

### ③ 站位比較（`src/analysis/positions.ts`、`src/compare/Positions.tsx`）

- **取樣**：我的位置先換算成參考時間，兩人每 0.5 秒線性內插取樣。玩家相鄰取樣超過 4 秒不內插（最多沿用 1 秒）；Boss 取樣稀疏，放寬為 30 秒／10 秒。
- **站位差異時段**：兩人距離超過 8 yalm、持續至少 2 秒（相隔 2 秒內的區段合併）。
- **不同攻略的判斷**：把參考位置分別以「當下 Boss 位置」與「場地中心（參考 Boss 位置的中位數）」為中心做左右、前後、點對稱，取與我最近者。對稱後距離 ≤ 6 yalm 且小於原距離一半，視為「對稱能解釋」；同一種對稱能解釋區段過半時間，才標示「可能是 X 對稱站位」。
- **介面**：距離折線圖（門檻虛線、差異時段色塊，灰色為可能對稱，點擊可跳轉）、俯視圖（格線 5 yalm、北方朝上、前 5 秒軌跡、Boss 位置）、時間滑桿、差異時段清單。與時間軸共用時間游標：拖曳滑桿或點圖表只移動游標；點清單（含少打 GCD 的時段、建議的「查看」）會同時捲動時間軸。

### Boss 機制差異（`src/analysis/mechanics.ts`、`src/compare/Mechanics.tsx`）

列出兩場戰鬥中 Boss 機制不同的時間點，讓使用者知道站位／走位差異可能是機制造成：

1. Boss 施放去重（同技能 1 秒內算一次），排除施放超過 8 次的技能。
2. 我的施放換算成參考時間。同一技能在另一邊 5 秒內也有施放就算相同（轉場附近對齊可能差幾秒）。
3. 沒配對的施放依時間合併成時間點（1.5 秒內）：兩邊都有 → **不同變化**（隨機機制）；只有一邊 → **只有我／只有參考**（常是輸出較高的一方提早轉場而跳過）。超過較短一方戰鬥結束時間的不列。
4. 同名不同 ID 的技能（例如 Hero's Blow 左右兩種版本）顯示時附上 ID。

### ④ 建議（`src/analysis/advice.ts`、`src/compare/AdviceList.tsx`）

**規則式**產生（不需要 API 金鑰、結果可預期、零成本），顯示在比較結果最上方，依重要性（優先／建議／參考）排序，同等級維持產生順序（停手 → GCD 速度 → 技能 → 站位）。可定位到時間點的建議有「查看」按鈕。

| 規則 | 條件 | 等級 |
|---|---|---|
| 停手總結 | 有少打 GCD 的時段 | 共少 ≥ 3 個 GCD 為優先 |
| 個別停手（最多 3 段） | 依參考同段 GCD 數排序；同段兩人平均距離 > 5 yalm 時補充「可能是走位路線不同」 | 參考 ≥ 3 個 GCD 為優先 |
| GCD 較慢 | 比參考慢 > 10 毫秒；估計整場少打 `長度/參考GCD − 長度/我的GCD` 個 | 估計 ≥ 3 個為優先 |
| 爆發藥少用 | 英文名稱含 Gemdraught／Tincture 等 | 優先 |
| oGCD 少用 ≥ 2 次 | 參考使用 ≤ 30 次；非職能／防禦技能 | 優先 |
| oGCD 各少用 1 次 | 合併為一則 | 建議 |
| 使用了參考沒用的 GCD | ≥ 3 次（例如武士的 Enpi，代表離 Boss 太遠） | 建議 |
| 技能平均較晚使用 | 配對 ≥ 2 次、平均晚 > 5 秒（含 GCD，例如 Higanbana）；一般技能 | 建議 |
| **減傷／移動：參考有用、我沒有對應使用** | 參考的使用在我的前後 30 秒內沒有對應（`AbilityUsage.unmatchedRef`）或次數較少；列出參考的使用時間（最多 5 個），「查看」跳到第一個 | 未對應或少用 ≥ 2 次為優先，否則建議 |
| **減傷／移動：平均較晚使用** | 配對 ≥ 2 次、平均晚 > 5 秒 | 建議 |
| 站位不同（最多 3 段） | 非對稱、持續 ≥ 5 秒；與停手時段重疊時為優先 | 建議／優先 |
| 可能是不同攻略 | 標示為對稱的站位差異合併為一則 | 參考 |
| 輔助技能少用 | utility 分類合併為一則 | 參考 |
| （不紀錄） | ignored 分類 | — |

- GCD 技能（連擊等）的次數差是少打 GCD 的結果，已由停手與 GCD 速度涵蓋，不列為「少用」。
- 與機制差異整合：站位差異或停手時段開始前 10 秒內到結束之間有「不同變化」時，建議中註明機制不同（同名不同 ID 附上 ID）；該站位差異降為「參考」等級。

### 技能名稱（`worker/src/abilityNames.ts`）

- **Worker `GET /abilities?ids=1,2,3`**：向 Boilmaster 鏡像批次（每批 100 個）查詢 `language=tc`；繁中為 `_rsv_…` 佔位或空白者再查 `language=chs`，以 opencc-js（`cn` → `tw`，只轉字元與台灣異體字、不改用詞）轉為繁體（依使用者決定）。回傳 `{ id: { name, source: 'tc' | 'chs' } }`，兩者都沒有的技能不回傳。最多 500 個 ID，ID 需 ≤ 1,000,000（道具不在 Action 表）。
- **前端**：比較資料載入後查詢兩邊出現過的所有技能（玩家、普通攻擊、Boss），以繁中名稱取代顯示名稱、英文保留在 `Ability.englishName`（滑鼠停留時顯示）。查詢失敗時沿用英文，不影響比較。**依名稱判斷的規則（藥水）使用英文名稱。**

## 待辦與未決事項

（2026-09-25 收尾時整理；下次開發從這裡開始）

### 需要使用者確認
- **第一階段的對稱站位判斷是否正確**：武士比較基準中，7:00 前有數段被標為「可能是點對稱／左右對稱站位」（例如 0:48–0:56、3:10–3:41），尚無法驗證是分配不同還是站位錯誤；若誤判多，可改為只在距離很大（例如 > 20 yalm）時才判斷對稱。
- 第二階段的左右相反站位：已知與 Hero's Blow 方向不同同時發生，需使用者以實際攻略確認是機制造成還是攻略不同。

### 已知限制
- 轉場提前是「跳躍」，錨點間線性內插會把跳躍平均分散在區段內（最長 56 秒無錨點），誤差數秒；可改為偵測轉場點（Boss 目標切換、無敵等）分段對齊。
- 新版本 Boss 技能沒有官方繁中名稱，以簡中轉繁顯示，用詞可能與遊戲內繁中不同；繁中資料更新後自動改用官方名稱。
- 技能繁中名稱依賴第三方 Boilmaster 鏡像（`xivapi-v2.xivcdn.com`），失效時退回英文。
- 冒煙測試只用固定的測試報告 `WATKBdHRh7m8PNQt`；若該報告被刪除或設為私人，冒煙測試會失敗，需換報告。
- 站位差異門檻 8 yalm、平均時機配對窗口 30 秒、對齊的低頻門檻 8 次等參數，只以比較基準調整過。

### 可能的後續方向
- 各職業的詳細分析（類似 xivanalysis）：目前所有職業只有基本規則（GCD、減傷、移動分類）。奪魂者尚未以實際日誌驗證。
- 職業規則加入冷卻時間與團隊爆發窗口：計算冷卻技的理論最大使用次數、爆發窗口內的技能內容（需要每個職業的冷卻與 Buff 資料）。
- 建議改由 LLM 產生或潤飾（經 Worker 呼叫，需 API 金鑰與費用）；目前為規則式。
- 死亡、受到的傷害等資料尚未分析。

## 設計變更紀錄

### 2026-09-25 所有職業的基本規則（由遊戲資料產生）
- 變更：新增 `scripts/gen-job-data.mjs` 從 Action 表產生 `src/jobs/generated.ts`（GCD 集合與 21 個職業的技能分類），取代手寫的四個職業模組；Peloton 改為移動；施放完成時清除過期的 `begincast`。
- 原因：使用者要求所有職業先有初步實作，詳細分析之後再做。以遊戲資料判斷 GCD 比手寫清單完整且不易出錯（手寫時曾把 Meditate 判為 oGCD、把 ID 38 誤當成 Release Iron Will）；以真實日誌驗證所有職業時發現取消詠唱後會配對到過期的 begincast。

### 2026-09-25 技能分類（不紀錄／減傷／移動／輔助）；職業名稱繁中
- 變更：以 `abilityCategory()` 取代原本的 `utility` 與建議內的職能技能清單；坦克的挑釁、退避、坦姿開關不紀錄；減傷與衝刺等移動技能新增專屬建議，列出參考有用而我沒有對應使用的時間點；介面上的職業名稱改為官方繁中（`jobs/names.ts`），並修正模組中錯誤的職業名稱（黑魔法師 → 黑魔道士、蝰蛇劍士 → 毒蛇劍士）。
- 原因：使用者指出對坦克而言挑釁、退避、坦姿開關無須紀錄，但減傷與衝刺是很重要的學習課題（原本被合併為低優先的「職能與防禦技能」）；並要求職業名稱也翻成繁中。

### 2026-09-25 拆分文件
- 變更：實測資料、資料來源調查、驗證結果、參數調整經過與部署踩過的坑移到 `docs/TECH_NOTES.md`；本文件只描述目前設計與設計變更。
- 原因：使用者要求把技術紀錄與系統設計分開。

### 2026-09-25 新增黑魔道士職業規則
- 變更：職業模組加入 BlackMage（GCD 分類與防禦／移動技能）。
- 原因：使用者要求。

### 2026-09-25 技能繁中名稱
- 變更：Worker 新增 `/abilities`，從 Boilmaster 鏡像取官方繁中名稱，沒有時以簡中轉繁（opencc-js）；前端以繁中顯示技能名稱，英文保留在滑鼠提示。新增外部依賴 `xivapi-v2.xivcdn.com`。
- 原因：比較基準為繁中版伺服器，使用者需要遊戲內的繁中名稱；FFLogs 與官方 XIVAPI 都沒有繁中。新版本 Boss 技能在繁中資料中只有佔位字串，依使用者決定以簡中轉繁顯示。

### 2026-09-25 只比較兩場戰鬥重疊的時段；GCD 上限 2.5 秒
- 變更：所有統計只計算到較短一方結束（時間軸標示範圍外）；對齊加入反向換算 `refToMine`；GCD 推估上限 2.5 秒；普通攻擊列入技能使用次數但不畫在時間軸。
- 原因：使用者指出較長一方多出的時間沒有比較標的，不應計入；GCD 最長 2.5 秒，實測受延遲影響會略超過。

### 2026-09-25 Boss 機制差異、騎士職業規則、防禦技分類
- 變更：新增 Boss 機制差異列表並整合進建議；新增 Paladin 模組；`JobModule` 加入 `utility`，職能技能清單擴充到所有職業；新增騎士比較基準。
- 原因：使用者要求列出 Boss 隨機機制不同處；武士日誌顯示第二階段的左右相反站位很可能是隨機機制（Hero's Blow 方向）造成。以騎士日誌測試時，建議把坦克的減傷與輔助技能當成「冷卻好就用」的輸出技能，是錯誤建議，因此加入防禦／輔助分類。

### 2026-09-25 規則式建議（階段 ④）
- 變更：新增規則式建議，整合停手、GCD 速度、技能使用、站位的分析結果，依重要性排序並可跳轉；GCD 統計與技能使用改在 `Comparison` 計算一次，供指標與建議共用。
- 原因：先以規則式提供可預期、零成本的建議；以比較基準實測後修正「把 GCD 次數差當成冷卻技少用」的錯誤建議，並合併次要項目。

### 2026-09-25 站位比較（階段 ③）
- 變更：玩家事件改抓全部事件以取得密集的位置取樣；新增站位差異時段、對稱站位判斷、距離圖、俯視圖與共用時間游標。
- 原因：只抓施放時位置取樣太稀疏；不同隊伍在第二階段採用左右相反的站位，連 Boss 位置也相反，因此對稱判斷需同時以 Boss 與場地中心為中心，並要求同一種對稱能解釋過半時間以減少誤判。

### 2026-09-25 通用指標（階段 ②）
- 變更：新增 GCD 概況、少打 GCD 的時段（可跳到時間軸並以紅色標示）、技能使用次數與平均時機；玩家施放時間改用開始施放（`begincast`）。
- 原因：原始空檔含 Boss 無法攻擊的時間，因此以「參考在同一段仍在施放」判定真正的損失；時機配對改用可跳過的動態規劃，避免次數不同時全部錯位。

### 2026-09-25 部署後自動冒煙測試；更新比較基準
- 變更：CI 在部署後加入冒煙測試，以實際請求驗證正式站與 Worker；比較基準改為 `FXLkqaK32PhQH8Ac` #1（我）vs `pwTF16cgnB9G7fWM` #29（高階玩家）的武士。
- 原因：使用者要求每次推送新程式碼都自動建置新版並測試；單元測試無法發現部署層面的問題（例如 Pages 來源設定錯誤、Worker 網址錯誤）。

### 2026-09-25 參考日誌自動選擇戰鬥與角色
- 變更：參考日誌依「我的日誌」的 Boss 與職業自動選擇戰鬥（同 Boss 最後一次擊殺）與角色（同職業恰好一位時）；同職業有兩位以上時由使用者選擇。連結中指定的 fight / source 與手動選擇仍優先。
- 原因：使用者要求簡化流程，只需貼上高階玩家的報告連結即可開始比較。

### 2026-09-25 新增武士職業規則
- 變更：職業模組加入 Samurai（GCD／oGCD 分類）。
- 原因：使用者的比較基準日誌為武士。

### 2026-09-25 時間軸對齊與並排時間軸（階段 ①）
- 變更：確認開發順序（時間軸對齊 → 通用指標 → 站位 → 建議）與首個職業 Viper；實作以 Boss 低頻技能第 n 次施放為錨點、LIS 過濾的對齊演算法，以及並排施放時間軸；Worker 報告查詢加入 `masterData.abilities`；新增職業模組架構。
- 原因：對齊是所有比較的基礎；高頻技能（自動攻擊等）會造成次數錯位，因此只用低頻技能並以 LIS 去除矛盾配對。

### 2026-09-25 Worker 網址改寫在程式中
- 變更：前端的 Worker 網址由 GitHub Actions 變數 `API_BASE` 改為寫在 `src/config.ts`，`VITE_API_BASE` 僅作覆寫用。
- 原因：網址非機密；建置時變數未被讀到導致正式站連到 localhost，改寫在程式中可移除這個設定依賴。

### 2026-09-25 改用 Cloudflare Worker 代理（取代 OAuth PKCE）
- 變更：移除前端的 FFLogs PKCE 登入，改由 Cloudflare Worker 以 client credentials 代為查詢，只開放固定 REST 端點。
- 原因：希望使用者像 xivanalysis 一樣貼上連結即可使用，不需擁有 FFLogs 帳號或登入；client secret 無法放在 GitHub Pages 靜態網站中，需要伺服器端代理。
- 代價：需維護 Cloudflare 帳號；所有訪客共用 API 配額，因此加入快取與限流。

### 2026-09-25 初始架構
- 變更：建立 Vite + React + TypeScript 專案，部署到 GitHub Pages（專案站台，base path 由 repo 名稱決定）；FFLogs 驗證採 OAuth PKCE。
- 原因：專案需在 github.io 上執行，只能是靜態網站；PKCE 不需要 client secret。
