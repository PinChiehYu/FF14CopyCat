# 系統設計

本文件記錄 FF14 CopyCat 的目前設計與每次設計變更。實作細節與開發指令見 [CLAUDE.md](../CLAUDE.md)。

## 目前設計

### 架構

```
瀏覽器 ──► GitHub Pages（前端，靜態）
   │
   └──► Cloudflare Worker 代理 ──► FFLogs API v2（GraphQL，client credentials）
```

- **前端**：Vite + React + TypeScript，部署於 https://pinchiehyu.github.io/FF14CopyCat/ ，由 GitHub Actions 在 push 到 `main` 時建置部署（Pages Source 必須為 GitHub Actions）。
- **CI／CD**（`.github/workflows/deploy.yml`）：每次 push 到 `main` 自動執行 lint → 單元測試 → 建置 → 部署 → **冒煙測試**（`scripts/smoke-test.mjs`）。冒煙測試對正式站與 Worker 發出實際請求：確認正式站已換成本次建置且指向 Worker、Worker 能回傳報告與含位置的事件、會拒絕未允許的來源；正式站更新有延遲，最多重試約 1 分鐘。Pull request 只執行到建置。
- **Worker 代理**：https://ff14-copycat-api.ff14-copycat.workers.dev ，持有 FFLogs client ID / secret（Cloudflare Secrets），訪客不需登入 FFLogs。手動以 `npm run worker:deploy` 部署。
- **前端取得 Worker 網址**：寫在 `src/config.ts`（網址非機密），可用 `VITE_API_BASE` 覆寫。

### Worker API

只開放固定端點，GraphQL 查詢寫死在 Worker 內，前端無法送任意查詢：

| 端點 | 內容 |
|---|---|
| `GET /reports/:code` | 報告標題、fights、masterData.actors、masterData.abilities（技能名稱與圖示） |
| `GET /reports/:code/events?fight&start&end[&source][&dataType][&hostility]` | 一頁事件（含位置資料 `includeResources`），前端依 `nextPageTimestamp` 翻頁 |

保護措施：Origin 白名單（CORS）、每 IP 每分鐘 60 次限流、成功回應快取 10 分鐘。所有訪客共用一組 FFLogs API 配額。

### 使用流程（目前已實作）

1. 貼上兩個 FFLogs 報告連結（我的／參考）。
2. 載入報告，選擇戰鬥與玩家（排除極限技等假角色）。選擇的優先順序（`src/compare/autoSelect.ts`）：
   1. 使用者在下拉選單的手動選擇（換戰鬥時角色回到自動選擇）。
   2. 連結中的 `fight`、`source`。
   3. **參考日誌依「我的日誌」自動選擇**：戰鬥選同一 Boss（`encounterID`）的最後一次擊殺，沒有擊殺則選最後一場；角色在該戰鬥中與我同職業者恰好一位時自動選取，兩位以上或沒有時不選並提示原因。
   4. 都沒有時：戰鬥選最後一場，角色不選。
3. 兩邊都選好後，檢查是否可比較（同一 Boss `encounterID`、同一職業 `subType`），不符則顯示原因。
4. 各自載入玩家施放（`dataType=Casts&source=玩家`）與敵方施放（`dataType=Casts&hostility=Enemies`），共 4 個請求；只取 `type === 'cast'`，時間換算為戰鬥時間。
5. 以 Boss 施放對齊時間軸，顯示並排施放時間軸。

### 比較分析

開發順序（已與使用者確認）：**① 時間軸對齊＋並排時間軸（已完成）** → ② 通用指標（GCD 使用率、冷卻技次數）→ ③ 站位比較 → ④ 建議。職業規則先支援 **Viper（蝰蛇劍士）**。

#### ① 時間軸對齊（`src/analysis/alignment.ts`）

以參考日誌的時間為基準，把「我」的時間換算成參考日誌中「同一個機制」的時間：

1. 敵方施放依時間排序；同一技能 1 秒內重複施放（多個分身同時施放）視為一次。
2. 錨點候選 = 兩份日誌中「同一技能 ID 的第 n 次施放」。
3. 只用低頻技能：任一邊施放超過 8 次的技能（自動攻擊、反覆出現的招式）不當錨點，否則次數容易錯位、產生錯誤配對。
4. 依我的時間排序後，取參考時間嚴格遞增的最長子序列（LIS），捨棄與時間順序矛盾的配對（例如隨機變化的機制）。
5. 戰鬥開始 (0, 0) 為隱含錨點；錨點間線性內插，最後一個錨點後以斜率 1 外推。
6. 錨點少於 5 個時提示對齊可能不準。

實測：

| 比較 | 錨點 | 時間差 | 觀察 |
|---|---|---|---|
| 同一隊伍 Sugar Riot 滅團 vs 擊殺（`WATKBdHRh7m8PNQt` #10 / #11） | 107 | -0.1～+0.3 秒 | 腳本幾乎完全一致 |
| 不同隊伍 Howling Blade 擊殺（`pwTF16cgnB9G7fWM` #29 / `bX97vBapCPwKndL6` #3，13:56 vs 13:40） | 197 | -4.3～+0.2 秒 | 時間差呈階梯狀（0 → -2.6 → -4 秒），對應轉場提前 |
| Howling Blade 擊殺，參考快 55 秒（`pwTF16cgnB9G7fWM` #29 / `h6gRJZ2pfDFYMPjX` #13，武士 安祖卡） | 175 | -16.5～+0.7 秒 | 0～206 秒為 0，之後 -3.5、-5.6，約 400 秒起穩定 -16.4 秒 |

已知限制：
- 同一機制的隨機變化會使用不同技能 ID（例如 42641/42642），因此不會成為錨點。
- 轉場提前是「跳躍」，但錨點間線性內插會把跳躍平均分散在整個區段（例如 402～459 秒之間 56 秒沒有錨點）。目前誤差在數秒內；之後可考慮以 Boss 目標切換或無敵等事件辨識轉場點改為分段對齊。
- 比較基準（使用者指定）：我的日誌 `FXLkqaK32PhQH8Ac` #1（武士 席德，13:50 擊殺）vs 高階玩家 `pwTF16cgnB9G7fWM` #29（武士 安祖卡，13:56 擊殺）：194 個錨點、時間差 -6.8～+0.2 秒；GCD 342 vs 360、oGCD 175 vs 207。

#### 並排時間軸（`src/compare/Timeline.tsx`）

- 橫軸為參考日誌時間，可縮放（10～80 px/秒）。
- 列：Boss 施放（錨點以紫色標示）、參考 GCD／oGCD、我 GCD／oGCD（已對齊）。無職業模組時不分 GCD／oGCD。
- 圖示來自 FFLogs `masterData.abilities` 的 `icon`，網址 `https://assets.rpglogs.com/img/ff/abilities/<icon>`。
- 我的戰鬥較短（滅團）時以紅線標示結束位置。

#### 職業模組（`src/jobs/`）

- `JobModule`：`subType`、中文名稱、`isGcd(abilityId)`，之後會加入冷卻時間、爆發窗口等規則。
- 已支援：
  - Viper（蝰蛇劍士）：技能 ID 34606–34633 為 GCD、34634–34647 為 oGCD；職能技能與藥水為 oGCD。
  - Samurai（武士）：ID 不連續，以明確列表定義 GCD（連擊、居合術、燕返、奧義斬浪等，含已被取代的舊技能）；其餘為 oGCD。以使用者的兩份日誌驗證：GCD 間隔集中在 2.0～2.25 秒，無小於 1.25 秒的間隔（代表沒有把 oGCD 誤判為 GCD）。
- 注意：有詠唱條的技能（居合術、奧義斬浪等），FFLogs 的 `cast` 事件在詠唱結束時，因此時間軸上的位置比按下技能的時間晚約 1.3 秒；之後計算 GCD 使用率時需改用 `begincast`。

#### 之後的階段（提案）

- ② 通用指標：GCD 使用率／空檔、冷卻技使用次數 vs 理論最大值、爆發窗口內容。
- ③ 站位：對齊後重新取樣位置並計算距離，以俯視圖呈現；站位差異僅提示，不直接判錯。
- ④ 建議：先用規則式，之後可選擇加入 LLM 摘要。

待決定：站位差異（不同攻略）的處理方式、建議產生方式。

## 設計變更紀錄

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
- 原因：對齊是所有比較的基礎；以實際日誌分析發現高頻技能（自動攻擊等）會造成次數錯位，因此只用低頻技能並以 LIS 去除矛盾配對。

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
