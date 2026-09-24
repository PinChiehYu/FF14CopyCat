// Cloudflare Worker 代理（worker/）的網址；本機預設為 `npm run worker:dev` 的位址。
export const API_BASE = (import.meta.env.VITE_API_BASE || 'http://localhost:8787').replace(/\/$/, '')
