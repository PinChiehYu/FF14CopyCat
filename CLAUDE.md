# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

Vite + React + TypeScript，測試用 Vitest，lint 用 oxlint。Node.js 24。

```bash
npm run dev                          # http://localhost:5173
npm run build                        # tsc -b && vite build → dist/
npm test                             # vitest run
npx vitest run src/fflogs/url.test.ts   # 單一測試檔
npx vitest run -t "parses report"       # 依測試名稱篩選
npm run lint
```

- 在這台 Windows 機器上，Node 裝在 `C:\Program Files\nodejs`；若 shell 找不到 `node`/`npm`，先把它加進 PATH。
- 在 Git Bash 設定 `BASE_PATH=/xxx/` 會被 MSYS 改寫成 Windows 路徑，需加 `MSYS_NO_PATHCONV=1`。

## 部署與設定

- 目標為 GitHub Pages 專案站台 `https://<user>.github.io/<repo>/`。`.github/workflows/deploy.yml` 在 push 到 `main` 時執行 lint → test → build → deploy，並以 repo 名稱設定 `BASE_PATH`（`vite.config.ts` 的 `base`）。程式中的站內路徑一律透過 `import.meta.env.BASE_URL` 組出，不要寫死 `/`。
- FFLogs 驗證採 **OAuth PKCE**（`src/fflogs/auth.ts`），不需要也不可放 client secret。Client ID 來自 `VITE_FFLOGS_CLIENT_ID`（本機 `.env.local`；CI 讀 repo variable `FFLOGS_CLIENT_ID`）。OAuth 回呼導回站台根目錄，由 `main.tsx` 在 React 掛載前呼叫 `handleRedirect()` 處理。
- PKCE 權杖是使用者權杖，GraphQL 查詢走 `/api/v2/user` 端點（`src/fflogs/client.ts` 的 `gql()`）。

## 專案目標

一個部署於 GitHub（預計 GitHub Pages 之類的靜態網頁）的 FF14 戰鬥日誌比較工具，協助玩家模仿並學習高階玩家的操作：

1. 使用者貼上兩個 fflogs.com 報告連結（通常一份是自己、一份是參考的高階玩家）。
2. 分別在兩份日誌中指定要比較的角色（與戰鬥場次）。
3. 進行類似 [xivanalysis](https://xivanalysis.com/) 的職業分析（GCD 使用率、技能循環、資源溢出、Buff 對齊等）。
4. 以**戰鬥時間軸**與**角色位置**兩個維度對齊比較兩位玩家。
5. 輸出具體的改進建議。

## 領域與架構注意事項

- **FFLogs 連結解析**：格式為 `https://www.fflogs.com/reports/<reportCode>#fight=<id|last>&source=<actorId>...`。需從中取出 report code、fight id，並可能預選 source（角色）。
- **資料來源為 FFLogs API v2（GraphQL）**，端點 `https://www.fflogs.com/api/v2/client`（或使用者授權用的 `/api/v2/user`）。
  - 純靜態前端**不能內嵌 client secret**，因此採用 PKCE（見上方「部署與設定」）。
  - 事件查詢有分頁（`nextPageTimestamp`），需迴圈抓完整場戰鬥。
  - 事件的 `timestamp` 是相對於**整份報告**開始的毫秒數；比較兩份日誌前必須減去各自 fight 的 `startTime` 以正規化到戰鬥開始時間。
  - 位置資料需在事件查詢加上 `includeResources: true`，由 `sourceResources` / `targetResources` 的 `x`、`y`、`facing` 取得；位置只在有事件時才有取樣，時間上不連續，比較時需要插值或以最近取樣點對齊。
- **時間軸對齊**：兩份日誌的擊殺時間、轉場時間不同，單純用絕對時間比較會失準。應以 Boss 的技能事件（施放/傷害）作為錨點做分段對齊。
- **分析邏輯與職業相關**：建議把職業別的規則（技能 ID、GCD 定義、Buff 窗口）做成可擴充的模組，而非寫死在比較流程中。xivanalysis 為開源專案（GitHub: `xivanalysis/xivanalysis`），可作為職業規則與分析模組設計的參考。
