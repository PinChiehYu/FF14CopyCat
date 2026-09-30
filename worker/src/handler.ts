import { abilityNames, gameRow } from './abilityNames'
import { tcRankings, type DbLike, type Graphql } from './crawler'
import { npcNames } from './npcNames'
import { storedTimelines } from './timelines'
import { AUTO_ATTACKS_TAKEN_QUERY, DAMAGE_DONE_QUERY, EVENTS_QUERY, REPORT_QUERY, TARGETABILITY_QUERY } from './queries'

export interface Env {
  FFLOGS_CLIENT_ID: string
  FFLOGS_CLIENT_SECRET: string
  ALLOWED_ORIGINS: string
  RATE_LIMITER?: { limit(options: { key: string }): Promise<{ success: boolean }> }
  /** 繁中服排名資料庫（D1） */
  DB?: DbLike
}

export interface CacheLike {
  match(request: Request): Promise<Response | undefined>
  put(request: Request, response: Response): Promise<void>
}

export interface Context {
  waitUntil(promise: Promise<unknown>): void
}

const TOKEN_URL = 'https://www.fflogs.com/oauth/token'
const API_URL = 'https://www.fflogs.com/api/v2/client'
const CACHE_SECONDS = 600
// 技能名稱只隨遊戲版本改變，快取一天
const NAME_CACHE_SECONDS = 86_400
const MAX_ABILITY_IDS = 500
// 繁中服排名每 15 分鐘更新一次
const TC_RANKINGS_CACHE_SECONDS = 300
const MAX_NPC_NAMES = 20
// Boss 英文名稱：字母、數字、空白與常見標點
const NPC_NAME = /^[A-Za-z0-9 '\-.,:!&]{1,80}$/

const REPORT_CODE = /^(?:a:)?[A-Za-z0-9]{1,32}$/
const INTEGER = /^\d+$/
const DATA_TYPES = new Set([
  'All',
  'Buffs',
  'Casts',
  'CombatantInfo',
  'DamageDone',
  'DamageTaken',
  'Deaths',
  'Debuffs',
  'Healing',
  'Resources',
])
const HOSTILITY_TYPES = new Set(['Friendlies', 'Enemies'])

class HttpError extends Error {
  readonly status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

// client credentials 權杖：先看同一個 isolate 的記憶體，再看 Cloudflare 快取（同一個資料中心的 isolate 共用），
// 都沒有才向 FFLogs 換新的。只存在記憶體時，重新部署後每個新 isolate 都要換一次，短時間多次部署會被權杖端點限流。
let cachedToken: { value: string; expiresAt: number } | null = null
let tokenStore: CacheLike | null = null
// 快取鍵：不對外的網址（不會與代理的路徑相同），含 client ID，換帳號時不沿用
const tokenKey = (env: Env) => new Request(`https://fflogs-token.internal/${encodeURIComponent(env.FFLOGS_CLIENT_ID)}`)
// 到期前這麼久就換新的
const TOKEN_REFRESH_MARGIN_MS = 60_000

export function resetTokenCache(): void {
  cachedToken = null
  tokenStore = null
}

/** 設定跨 isolate 共用權杖的快取（Workers 的 caches.default；測試可注入） */
export function setTokenStore(store: CacheLike | null): void {
  tokenStore = store
}

const fresh = (token: { expiresAt: number } | null): boolean => !!token && token.expiresAt > Date.now() + TOKEN_REFRESH_MARGIN_MS

async function getToken(env: Env): Promise<string> {
  if (cachedToken && fresh(cachedToken)) return cachedToken.value

  // 快取失敗時照常向 FFLogs 換權杖
  try {
    const stored = await tokenStore?.match(tokenKey(env))
    const token = stored ? ((await stored.json()) as { value: string; expiresAt: number }) : null
    if (token && fresh(token)) {
      cachedToken = token
      return token.value
    }
  } catch (err) {
    console.warn('token cache read failed', err)
  }

  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${btoa(`${env.FFLOGS_CLIENT_ID}:${env.FFLOGS_CLIENT_SECRET}`)}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials',
  })
  // 權杖端點也有請求上限；Worker 重新部署後每個新 isolate 都要重新取得權杖
  if (res.status === 429) throw new HttpError(503, 'FFLogs token rate limit reached, try again later')
  if (!res.ok) throw new HttpError(502, `FFLogs token request failed: ${res.status}`)

  const body = (await res.json()) as { access_token: string; expires_in: number }
  cachedToken = { value: body.access_token, expiresAt: Date.now() + body.expires_in * 1000 }
  try {
    // 到期前一分鐘就不再使用（fresh 的判斷），max-age 只是讓快取自行清掉。
    // 不能標 private（Cache API 不存 private 的回應）；快取只有本 Worker 讀得到，也沒有路徑會回傳這個鍵
    await tokenStore?.put(
      tokenKey(env),
      new Response(JSON.stringify(cachedToken), {
        headers: { 'Content-Type': 'application/json', 'Cache-Control': `max-age=${body.expires_in}` },
      }),
    )
  } catch (err) {
    console.warn('token cache write failed', err)
  }
  return cachedToken.value
}

async function queryGraphql<T>(env: Env, query: string, variables: Record<string, unknown>): Promise<T | undefined> {
  const res = await fetch(API_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${await getToken(env)}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ query, variables }),
  })
  if (res.status === 429) throw new HttpError(503, 'FFLogs API rate limit reached, try again later')
  if (!res.ok) throw new HttpError(502, `FFLogs API error: ${res.status}`)

  const body = (await res.json()) as { data?: T; errors?: { message: string }[] }
  if (body.errors?.length) throw new HttpError(400, body.errors.map((e) => e.message).join('; '))
  return body.data
}

/** 定時掃描用的 GraphQL 查詢函式。 */
export function graphqlFor(env: Env): Graphql {
  return (query, variables) => queryGraphql(env, query, variables)
}

async function queryReport(env: Env, query: string, variables: Record<string, unknown>): Promise<unknown> {
  const data = await queryGraphql<{ reportData?: { report?: unknown } }>(env, query, variables)
  const report = data?.reportData?.report
  if (!report) throw new HttpError(404, 'Report not found')
  return report
}

function optionalInt(params: URLSearchParams, name: string): number | undefined {
  const value = params.get(name)
  if (value === null) return undefined
  if (!INTEGER.test(value)) throw new HttpError(400, `Invalid ${name}`)
  return Number(value)
}

function requiredInt(params: URLSearchParams, name: string): number {
  const value = optionalInt(params, name)
  if (value === undefined) throw new HttpError(400, `Missing ${name}`)
  return value
}

function optionalEnum(params: URLSearchParams, name: string, allowed: Set<string>): string | undefined {
  const value = params.get(name)
  if (value === null) return undefined
  if (!allowed.has(value)) throw new HttpError(400, `Invalid ${name}`)
  return value
}

/** `ids=1,2,3`：FFLogs 的技能 ID（遊戲技能或道具），最多 MAX_ABILITY_IDS 個。 */
function abilityIds(params: URLSearchParams): number[] {
  const raw = params.get('ids')
  if (!raw) throw new HttpError(400, 'Missing ids')
  const parts = raw.split(',')
  if (parts.length > MAX_ABILITY_IDS) throw new HttpError(400, 'Too many ids')
  const ids = parts.map((p) => {
    if (!INTEGER.test(p) || gameRow(Number(p)) === null) throw new HttpError(400, 'Invalid ids')
    return Number(p)
  })
  return [...new Set(ids)]
}

/** `name=A&name=B`：Boss 的英文名稱，最多 MAX_NPC_NAMES 個。 */
function npcNameParams(params: URLSearchParams): string[] {
  const names = [...new Set(params.getAll('name'))]
  if (names.length === 0) throw new HttpError(400, 'Missing name')
  if (names.length > MAX_NPC_NAMES) throw new HttpError(400, 'Too many names')
  // 只允許一般的名稱字元，避免注入搜尋語法
  if (names.some((n) => !NPC_NAME.test(n))) throw new HttpError(400, 'Invalid name')
  return names
}

const JOB_NAME = /^[A-Za-z]{2,20}$/

// 名稱@伺服器（只用來不和自己比較；長度與字元限制避免異常輸入）
const PLAYER_KEY = /^[^@\s]{1,40}@[^@\s]{1,40}$/

/**
 * `GET /tc-rankings?encounter&difficulty&job&minPr&maxPr[&rdps&player]`：繁中服排名（自建資料庫）中 PR 在範圍內的紀錄；
 * 帶 rdps 時另外回傳該 rDPS 的 PR 與比它高的擊殺數（player 為「名稱@伺服器」，在資料庫中時不和自己比較）。
 */
async function tcRankingsRoute(params: URLSearchParams, env: Env): Promise<unknown> {
  if (!env.DB) throw new HttpError(503, 'Rankings database unavailable')
  const job = params.get('job') ?? ''
  if (!JOB_NAME.test(job)) throw new HttpError(400, 'Invalid job')
  const minPr = optionalInt(params, 'minPr') ?? 0
  const maxPr = optionalInt(params, 'maxPr') ?? 100
  if (minPr > 100 || maxPr > 100 || minPr > maxPr) throw new HttpError(400, 'Invalid PR range')
  const rdps = optionalInt(params, 'rdps')
  const player = params.get('player') ?? undefined
  if (player !== undefined && !PLAYER_KEY.test(player)) throw new HttpError(400, 'Invalid player')
  return tcRankings(
    env.DB,
    requiredInt(params, 'encounter'),
    requiredInt(params, 'difficulty'),
    job,
    minPr,
    maxPr,
    undefined,
    rdps === undefined ? undefined : { rdps, player },
  )
}

// 一次最多查幾場的預處理 Boss 施放（搜尋前輩日誌最多列 40 筆）
const MAX_PULLS = 40
const PULL_KEY = /^((?:a:)?[A-Za-z0-9]{1,32}):(\d{1,6})$/

/**
 * 已預處理場次的 Boss 施放（timelines.ts）：`pulls=報告:戰鬥,…` → `{ "報告:戰鬥": 編碼字串 }`；
 * 沒有預處理（或報告已不公開）的場次不回傳，前端改向 FFLogs 抓。
 */
async function pullTimelinesRoute(params: URLSearchParams, env: Env): Promise<Record<string, string>> {
  if (!env.DB) throw new HttpError(503, 'Rankings database unavailable')
  const keys = [...new Set((params.get('pulls') ?? '').split(',').filter(Boolean))]
  if (keys.length === 0 || keys.length > MAX_PULLS) throw new HttpError(400, 'Invalid pulls')
  const pulls = keys.map((key) => {
    const match = PULL_KEY.exec(key)
    if (!match) throw new HttpError(400, 'Invalid pulls')
    return { report: match[1], fight: Number(match[2]) }
  })
  return storedTimelines(env.DB, pulls)
}

async function route(url: URL, env: Env): Promise<{ data: unknown; cacheSeconds: number }> {
  if (url.pathname.replace(/\/$/, '') === '/tc-rankings') {
    return { data: await tcRankingsRoute(url.searchParams, env), cacheSeconds: TC_RANKINGS_CACHE_SECONDS }
  }
  if (url.pathname.replace(/\/$/, '') === '/pull-timelines') {
    return { data: await pullTimelinesRoute(url.searchParams, env), cacheSeconds: CACHE_SECONDS }
  }
  if (url.pathname.replace(/\/$/, '') === '/npc-names') {
    const { names, complete } = await npcNames(npcNameParams(url.searchParams))
    // 有名稱查詢失敗時只短暫快取，之後可再重查
    return { data: names, cacheSeconds: complete ? NAME_CACHE_SECONDS : 60 }
  }
  if (url.pathname.replace(/\/$/, '') === '/abilities') {
    try {
      return { data: await abilityNames(abilityIds(url.searchParams)), cacheSeconds: NAME_CACHE_SECONDS }
    } catch (err) {
      if (err instanceof HttpError) throw err
      throw new HttpError(502, `Ability name lookup failed: ${err instanceof Error ? err.message : err}`)
    }
  }
  return { data: await reportRoute(url, env), cacheSeconds: CACHE_SECONDS }
}

async function reportRoute(url: URL, env: Env): Promise<unknown> {
  const match = /^\/reports\/([^/]+)(\/events|\/auto-attacks-taken|\/damage-done|\/targetability)?\/?$/.exec(url.pathname)
  if (!match) throw new HttpError(404, 'Not found')

  const code = decodeURIComponent(match[1])
  if (!REPORT_CODE.test(code)) throw new HttpError(400, 'Invalid report code')

  if (!match[2]) return queryReport(env, REPORT_QUERY, { code })

  const params = url.searchParams
  if (match[2] === '/auto-attacks-taken') {
    const report = (await queryReport(env, AUTO_ATTACKS_TAKEN_QUERY, {
      code,
      fightIDs: [requiredInt(params, 'fight')],
    })) as { table: { data?: { entries?: { id: number; total: number }[] } } }
    // 只回傳每位玩家承受的普通攻擊總傷害 { 角色 ID: 傷害 }，省掉表格其餘欄位
    return Object.fromEntries((report.table.data?.entries ?? []).map((e) => [e.id, e.total]))
  }
  if (match[2] === '/damage-done') {
    const report = (await queryReport(env, DAMAGE_DONE_QUERY, {
      code,
      fightIDs: [requiredInt(params, 'fight')],
    })) as { table: { data?: { totalTime?: number; entries?: Record<string, unknown>[] } } }
    // 每位角色只回傳數字欄位：總傷害 total、FFLogs 有計算時的 totalRDPS／totalADPS／totalNDPS 等、activeTime
    return {
      totalTime: report.table.data?.totalTime ?? null,
      entries: Object.fromEntries(
        (report.table.data?.entries ?? []).map((e) => [
          e.id,
          Object.fromEntries(Object.entries(e).filter(([k, v]) => typeof v === 'number' && (k.startsWith('total') || k === 'activeTime'))),
        ]),
      ),
    }
  }

  if (match[2] === '/targetability') {
    const report = (await queryReport(env, TARGETABILITY_QUERY, {
      code,
      fightIDs: [requiredInt(params, 'fight')],
      startTime: requiredInt(params, 'start'),
      endTime: requiredInt(params, 'end'),
    })) as { events: { data?: { timestamp: number; sourceID?: number; targetable?: number }[] } }
    // 只回傳時間、角色與可否選中
    return (report.events.data ?? []).map((e) => ({ timestamp: e.timestamp, sourceID: e.sourceID, targetable: e.targetable === 1 }))
  }
  const report = (await queryReport(env, EVENTS_QUERY, {
    code,
    fightIDs: [requiredInt(params, 'fight')],
    startTime: requiredInt(params, 'start'),
    endTime: requiredInt(params, 'end'),
    sourceID: optionalInt(params, 'source'),
    dataType: optionalEnum(params, 'dataType', DATA_TYPES),
    hostilityType: optionalEnum(params, 'hostility', HOSTILITY_TYPES),
  })) as { events: unknown }
  return report.events
}

function corsHeaders(origin: string): HeadersInit {
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  }
}

function json(body: unknown, status: number, extraHeaders: HeadersInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...extraHeaders },
  })
}

export async function handleRequest(
  request: Request,
  env: Env,
  ctx: Context,
  cache: CacheLike | null,
): Promise<Response> {
  const origin = request.headers.get('Origin') ?? ''
  const allowed = env.ALLOWED_ORIGINS.split(',').map((o) => o.trim())
  // Origin 可被非瀏覽器用戶端偽造；這裡只防止其他網站直接在瀏覽器中使用本代理。
  if (!allowed.includes(origin)) return json({ error: 'Origin not allowed' }, 403)

  const cors = corsHeaders(origin)
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors })
  if (request.method !== 'GET') return json({ error: 'Method not allowed' }, 405, cors)

  if (env.RATE_LIMITER) {
    const ip = request.headers.get('CF-Connecting-IP') ?? 'unknown'
    const { success } = await env.RATE_LIMITER.limit({ key: ip })
    if (!success) return json({ error: 'Too many requests' }, 429, cors)
  }

  const url = new URL(request.url)
  // 快取鍵不含 Origin，CORS 標頭在回應時才加上。
  const cacheKey = new Request(url.toString())
  const cached = await cache?.match(cacheKey)
  if (cached) {
    const response = new Response(cached.body, cached)
    for (const [key, value] of Object.entries(cors)) response.headers.set(key, value)
    return response
  }

  try {
    const { data, cacheSeconds } = await route(url, env)
    const body = JSON.stringify(data)
    if (cache) {
      const toCache = new Response(body, {
        headers: { 'Content-Type': 'application/json', 'Cache-Control': `public, max-age=${cacheSeconds}` },
      })
      ctx.waitUntil(cache.put(cacheKey, toCache))
    }
    return new Response(body, { headers: { 'Content-Type': 'application/json', ...cors } })
  } catch (err) {
    if (err instanceof HttpError) return json({ error: err.message }, err.status, cors)
    console.error(err)
    return json({ error: 'Internal error' }, 500, cors)
  }
}
