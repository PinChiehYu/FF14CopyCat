# FF14 CopyCat

比較兩份 FFLogs 日誌（自己與高階玩家），以時間軸與站位對照分析，協助模仿高階玩家的操作。

## 開發

需要 Node.js 24+。

```bash
npm install
cp .env.example .env.local   # 填入 FFLogs Client ID
npm run dev
```

| 指令 | 用途 |
| --- | --- |
| `npm run dev` | 本機開發伺服器 |
| `npm run build` | 型別檢查並建置到 `dist/` |
| `npm test` | 執行所有測試 |
| `npm run lint` | oxlint |

## 部署

推送到 `main` 後由 GitHub Actions 建置並部署到 GitHub Pages。首次設定：

1. Repo 的 Settings → Pages → Source 選擇 **GitHub Actions**。
2. 在 [FFLogs API Clients](https://www.fflogs.com/api/clients/) 建立 **public（PKCE）** 用戶端，Redirect URL 填 `https://<帳號>.github.io/<repo>/`（本機開發另加 `http://localhost:5173/`）。
3. Settings → Secrets and variables → Actions → **Variables** 新增 `FFLOGS_CLIENT_ID`。
