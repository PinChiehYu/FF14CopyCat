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
- **Worker 代理**：https://ff14-copycat-api.ff14-copycat.workers.dev ，持有 FFLogs client ID / secret（Cloudflare Secrets），訪客不需登入 FFLogs。手動以 `npm run worker:deploy` 部署。
- **前端取得 Worker 網址**：寫在 `src/config.ts`（網址非機密），可用 `VITE_API_BASE` 覆寫。

### Worker API

只開放固定端點，GraphQL 查詢寫死在 Worker 內，前端無法送任意查詢：

| 端點 | 內容 |
|---|---|
| `GET /reports/:code` | 報告標題、fights、masterData.actors |
| `GET /reports/:code/events?fight&start&end[&source][&dataType][&hostility]` | 一頁事件（含位置資料 `includeResources`），前端依 `nextPageTimestamp` 翻頁 |

保護措施：Origin 白名單（CORS）、每 IP 每分鐘 60 次限流、成功回應快取 10 分鐘。所有訪客共用一組 FFLogs API 配額。

### 使用流程（目前已實作）

1. 貼上兩個 FFLogs 報告連結（我的／參考）。
2. 載入報告，選擇戰鬥與玩家（可由連結的 `fight`、`source` 預選；排除極限技等假角色）。
3. 比較分析：**尚未實作**，設計討論中（見下方）。

### 比較分析（提案，待使用者確認）

- 前提：兩份日誌需為同一 Boss、同一職業。
- 時間軸對齊：以 Boss 第 n 次施放同一技能為錨點，錨點間線性伸縮。
- 技能循環分析：GCD 使用率／空檔、冷卻技使用次數、爆發窗口、並排施放時間軸。
- 站位比較：對齊後重新取樣位置並計算距離，以俯視圖呈現；站位差異僅提示，不直接判錯。
- 建議：先用規則式，之後可選擇加入 LLM 摘要。
- 建議開發順序：時間軸對齊＋並排時間軸 → 通用指標 → 站位 → 建議。

待決定：優先順序、先支援的職業、站位差異的處理方式、建議產生方式。

## 設計變更紀錄

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
