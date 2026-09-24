import { FFLOGS_AUTHORIZE_URL, FFLOGS_CLIENT_ID, FFLOGS_TOKEN_URL, redirectUri } from '../config'

// OAuth 2.0 Authorization Code + PKCE：純前端即可向 FFLogs 取得使用者權杖，不需要 client secret。

const VERIFIER_KEY = 'fflogs.pkce.verifier'
const STATE_KEY = 'fflogs.pkce.state'
const TOKEN_KEY = 'fflogs.token'

interface StoredToken {
  accessToken: string
  expiresAt: number
}

function base64Url(bytes: Uint8Array): string {
  let binary = ''
  for (const b of bytes) binary += String.fromCharCode(b)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export function randomString(byteLength = 32): string {
  return base64Url(crypto.getRandomValues(new Uint8Array(byteLength)))
}

export async function codeChallenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))
  return base64Url(new Uint8Array(digest))
}

export function isConfigured(): boolean {
  return FFLOGS_CLIENT_ID !== ''
}

/** 導向 FFLogs 授權頁。 */
export async function startLogin(): Promise<void> {
  const verifier = randomString()
  const state = randomString(16)
  sessionStorage.setItem(VERIFIER_KEY, verifier)
  sessionStorage.setItem(STATE_KEY, state)

  const url = new URL(FFLOGS_AUTHORIZE_URL)
  url.search = new URLSearchParams({
    client_id: FFLOGS_CLIENT_ID,
    response_type: 'code',
    redirect_uri: redirectUri(),
    code_challenge: await codeChallenge(verifier),
    code_challenge_method: 'S256',
    state,
  }).toString()
  window.location.assign(url)
}

/**
 * 若目前網址帶有 OAuth 回呼參數，交換權杖並清掉網址上的參數。
 * 回傳是否處理了回呼。
 */
export async function handleRedirect(): Promise<boolean> {
  const params = new URLSearchParams(window.location.search)
  const code = params.get('code')
  if (!code) return false

  const verifier = sessionStorage.getItem(VERIFIER_KEY)
  const expectedState = sessionStorage.getItem(STATE_KEY)
  sessionStorage.removeItem(VERIFIER_KEY)
  sessionStorage.removeItem(STATE_KEY)
  window.history.replaceState(null, '', redirectUri())

  if (!verifier || params.get('state') !== expectedState) {
    throw new Error('OAuth state 不符，請重新登入。')
  }

  const res = await fetch(FFLOGS_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: FFLOGS_CLIENT_ID,
      redirect_uri: redirectUri(),
      code,
      code_verifier: verifier,
    }),
  })
  if (!res.ok) throw new Error(`FFLogs 權杖交換失敗：${res.status}`)

  const body = (await res.json()) as { access_token: string; expires_in: number }
  const token: StoredToken = {
    accessToken: body.access_token,
    expiresAt: Date.now() + body.expires_in * 1000,
  }
  localStorage.setItem(TOKEN_KEY, JSON.stringify(token))
  return true
}

export function getAccessToken(): string | null {
  try {
    const raw = localStorage.getItem(TOKEN_KEY)
    if (!raw) return null
    const token = JSON.parse(raw) as StoredToken
    return token.expiresAt > Date.now() + 60_000 ? token.accessToken : null
  } catch {
    return null
  }
}

export function logout(): void {
  localStorage.removeItem(TOKEN_KEY)
}
