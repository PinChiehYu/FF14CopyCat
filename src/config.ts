export const FFLOGS_AUTHORIZE_URL = 'https://www.fflogs.com/oauth/authorize'
export const FFLOGS_TOKEN_URL = 'https://www.fflogs.com/oauth/token'
// PKCE 取得的是使用者權杖，須打 /user 端點（/client 端點要 client credentials）。
export const FFLOGS_API_URL = 'https://www.fflogs.com/api/v2/user'

export const FFLOGS_CLIENT_ID = import.meta.env.VITE_FFLOGS_CLIENT_ID ?? ''

// OAuth 回呼導回站台根目錄（含 GitHub Pages 的 repo 子路徑）。
export function redirectUri(): string {
  return new URL(import.meta.env.BASE_URL, window.location.origin).toString()
}
