// Cloudflare Worker 代理（worker/）的網址。網址本身不是秘密，直接寫在程式裡；
// 可用 VITE_API_BASE 覆寫（例如本機前端改連已部署的 Worker）。
const DEFAULT_API_BASE = import.meta.env.PROD
  ? 'https://ff14-copycat-api.ff14-copycat.workers.dev'
  : 'http://localhost:8787' // npm run worker:dev

export const API_BASE = (import.meta.env.VITE_API_BASE || DEFAULT_API_BASE).replace(/\/$/, '')
