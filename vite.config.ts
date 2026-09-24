import react from '@vitejs/plugin-react'
import { defineConfig } from 'vitest/config'

// GitHub Pages 專案站台位於 https://<user>.github.io/<repo>/，
// 部署 workflow 會以 repo 名稱設定 BASE_PATH；本機開發維持 '/'。
export default defineConfig({
  base: process.env.BASE_PATH ?? '/',
  plugins: [react()],
  test: {
    environment: 'node',
  },
})
