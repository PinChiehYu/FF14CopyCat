import { API_BASE } from '../config'
import type { EventDataType, FFLogsEvent, Fight, Report } from './types'

export class ApiError extends Error {
  readonly status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

// Worker 對 FFLogs 的逾時（20 秒）加上傳輸時間；請求偶爾沒有回應，逾時或 504 時重試一次，
// 仍失敗就顯示錯誤，不讓畫面一直停在載入中
const TIMEOUT_MS = 45_000
const TIMEOUT_MESSAGE = '伺服器沒有回應，請重新整理再試'

/** 帶逾時的 fetch；呼叫端取消時照常以 AbortError 結束，逾時則回傳 null。 */
async function fetchWithTimeout(url: string, signal?: AbortSignal): Promise<Response | null> {
  const controller = new AbortController()
  const onAbort = () => controller.abort()
  if (signal?.aborted) controller.abort()
  signal?.addEventListener('abort', onAbort)
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
  try {
    return await fetch(url, { signal: controller.signal })
  } catch (err) {
    if (controller.signal.aborted && !signal?.aborted) return null
    throw err
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', onAbort)
  }
}

// 與 Worker 的 DB_UNAVAILABLE 一致：排名資料庫（D1）無法使用，例如免費方案的每日讀取額度用完
const DB_UNAVAILABLE = 'Database unavailable'
export const DB_UNAVAILABLE_MESSAGE = '排名資料庫今天的查詢額度已用完，暫時無法搜尋前輩日誌，請直接貼上參考日誌的網址'

// 排名資料庫是否可用：任何一個請求回報無法使用後，本次瀏覽都視為不可用（只允許貼參考日誌）
let dbAvailable = true
const dbListeners = new Set<() => void>()
export const dbStatus = {
  subscribe(listener: () => void) {
    dbListeners.add(listener)
    return () => dbListeners.delete(listener)
  },
  available: () => dbAvailable,
}
function markDbUnavailable() {
  if (!dbAvailable) return
  dbAvailable = false
  for (const listener of dbListeners) listener()
}

async function get<T>(path: string, signal?: AbortSignal): Promise<T> {
  let res = await fetchWithTimeout(`${API_BASE}${path}`, signal)
  if (res === null || res.status === 504) res = await fetchWithTimeout(`${API_BASE}${path}`, signal)
  if (res === null) throw new ApiError(504, TIMEOUT_MESSAGE)
  if (!res.ok) {
    if (res.status === 504) throw new ApiError(504, TIMEOUT_MESSAGE)
    const body = (await res.json().catch(() => null)) as { error?: string } | null
    if (res.status === 503 && body?.error === DB_UNAVAILABLE) {
      markDbUnavailable()
      throw new ApiError(503, DB_UNAVAILABLE_MESSAGE)
    }
    // 429：本站的每 IP 限制；503：FFLogs 的請求上限
    if (res.status === 429 || res.status === 503) {
      throw new ApiError(res.status, '請求過多，暫時無法取得資料，請稍候一分鐘再試')
    }
    throw new ApiError(res.status, body?.error ?? `API 錯誤：${res.status}`)
  }
  return (await res.json()) as T
}

/** FFLogs 對報告的錯誤訊息（英文）換成說明 */
export function reportErrorMessage(message: string): string {
  if (/report does not exist/i.test(message)) return '找不到這份報告：連結可能有誤，或報告已刪除'
  if (/permission to view this report/i.test(message)) return '這份報告不公開（設為私人），無法讀取'
  return message
}

export function fetchReport(code: string, signal?: AbortSignal): Promise<Report> {
  return get<Report>(`/reports/${encodeURIComponent(code)}`, signal).catch((err: unknown) => {
    throw err instanceof ApiError ? new ApiError(err.status, reportErrorMessage(err.message)) : err
  })
}

/** 繁中服排名（Worker 定時掃描公開報告自建）中的一筆擊殺；名次與 PR 為這一場的 rDPS 和其他玩家各自最好的一場比較。 */
export interface TcRanking {
  /** 所有場次（重複上傳只算一次）依 rDPS 的名次，每場不同 */
  rank: number
  /** 繁中服內的百分位（最高 100） */
  pr: number
  report: string
  fight: number
  actor: number
  name: string
  server: string
  /** 排名依據（FFLogs 的 rDPS） */
  rdps: number
  /** 戰鬥在報告中的開始與結束（毫秒，相對於報告開始） */
  fightStart: number
  fightEnd: number
  /** 報告開始時間（Unix 毫秒） */
  reportStart: number
}

/** 某個 rDPS 在繁中服排名中的位置：PR（與其他玩家各自最好的一場比較）與 rDPS 比它高的擊殺數。 */
export interface TcPosition {
  pr: number
  better: number
}

/**
 * 查詢繁中服排名中某 Boss、某職業 PR 在範圍內的紀錄（由高到低）。
 * 帶 rdps（與 player「名稱@伺服器」）時另外回傳該 rDPS 的位置（position）。
 */
/**
 * 已預處理場次的 Boss 施放（Worker 定時從收錄的擊殺整理，src/analysis/castCodec.ts 的編碼）：
 * `{ "報告:戰鬥": 編碼字串 }`；還沒預處理的場次不在結果中（最多 40 場）。
 */
export function fetchPullTimelines(pulls: { report: string; fight: number }[], signal?: AbortSignal): Promise<Record<string, string>> {
  const keys = [...new Set(pulls.map((p) => `${p.report}:${p.fight}`))]
  return get(`/pull-timelines?pulls=${encodeURIComponent(keys.join(','))}`, signal)
}

export function fetchTcRankings(
  query: { encounter: number; difficulty: number; job: string; minPr: number; maxPr: number; rdps?: number; player?: string },
  signal?: AbortSignal,
): Promise<{ count: number; rankings: TcRanking[]; position?: TcPosition }> {
  const params = new URLSearchParams(
    Object.entries(query)
      .filter(([, v]) => v !== undefined)
      .map(([k, v]) => [k, String(v)]),
  )
  return get(`/tc-rankings?${params}`, signal)
}

/** 前輩平均的 PR 區間（固定三組，與 worker/src/timelines.ts 的 TIERS 相同） */
export type AverageTier = 'top' | 'upper' | 'mid'
export const AVERAGE_TIERS: { tier: AverageTier; label: string; range: [number, number] }[] = [
  { tier: 'top', label: 'PR 95+', range: [95, 100] },
  { tier: 'upper', label: '75–94', range: [75, 94] },
  { tier: 'mid', label: '50–74', range: [50, 74] },
]

/** 前輩平均的一筆樣本（castCodec.ts 的編碼） */
export interface AverageSampleData {
  name: string
  server: string
  report: string
  fight: number
  actor: number
  pr: number
  rdps: number
  patch: string
  /** 戰鬥長度（毫秒） */
  duration: number
  boss: string
  casts: string
  buffs: string
  applications: string
}

/**
 * 一個 Boss×職業（坦克再分 MT／ST）×PR 區間的前輩平均樣本：count 為區間內的擊殺數，updatedAt 為最近一次選樣本的時間。
 */
export function fetchAverageSamples(
  query: { encounter: number; difficulty: number; job: string; tier: AverageTier; slot?: 'MT' | 'ST' },
  signal?: AbortSignal,
): Promise<{ count: number; updatedAt: number | null; samples: AverageSampleData[] }> {
  const params = new URLSearchParams({ encounter: String(query.encounter), difficulty: String(query.difficulty), job: query.job, tier: query.tier })
  if (query.slot) params.set('slot', query.slot)
  return get(`/average-samples?${params}`, signal)
}

/** 每位玩家承受的敵方普通攻擊總傷害（角色 ID → 傷害），用來判斷誰在坦 Boss。 */
export async function fetchAutoAttacksTaken(code: string, fightId: number, signal?: AbortSignal): Promise<Map<number, number>> {
  const result: Record<string, unknown> = await get(
    `/reports/${encodeURIComponent(code)}/auto-attacks-taken?fight=${fightId}`,
    signal,
  )
  return new Map(
    Object.entries(result)
      .filter((e): e is [string, number] => typeof e[1] === 'number')
      .map(([id, total]) => [Number(id), total]),
  )
}

/** 一位角色整場的輸出（FFLogs 傷害表；繁中服日誌不排名，但仍有計算 rDPS）。每秒數值。 */
export interface DamageSummary {
  dps: number
  rdps: number
  adps: number
  /** 自己 Buff 給隊友的貢獻、被隊友 Buff 加成的部分（每秒） */
  given: number
  taken: number
}

/** 一場戰鬥中某角色的 DPS／rDPS／aDPS；沒有資料時回傳 null。 */
export async function fetchDamageSummary(code: string, fightId: number, actorId: number, signal?: AbortSignal): Promise<DamageSummary | null> {
  const result: { totalTime?: number | null; entries?: Record<string, Record<string, number>> } = await get(
    `/reports/${encodeURIComponent(code)}/damage-done?fight=${fightId}`,
    signal,
  )
  const e = result.entries?.[String(actorId)]
  const seconds = (result.totalTime ?? 0) / 1000
  if (!e || !(seconds > 0) || typeof e.total !== 'number') return null
  const perSecond = (v: number | undefined, fallback: number) => (typeof v === 'number' ? v : fallback) / seconds
  return {
    dps: perSecond(e.total, 0),
    rdps: perSecond(e.totalRDPS, e.total),
    adps: perSecond(e.totalADPS, e.total),
    given: perSecond(e.totalRDPSGiven, 0),
    taken: perSecond(e.totalRDPSTaken, 0),
  }
}

// Worker 單次最多查詢的 NPC 名稱數
const NPC_BATCH = 20

// 與 Worker 的驗證一致：只查一般的英文名稱
const NPC_NAME = /^[A-Za-z0-9 '\-.,:!&]{1,80}$/

/** 戰鬥名稱可能由多個 NPC 組成，例如 `living liquid / liquid hand / ...`。 */
export function fightNameParts(name: string): string[] {
  return name.split('/').map((p) => p.trim())
}

/** 把戰鬥名稱逐段換成繁中；查不到的段落保留英文。 */
export function translateFightName(name: string, npcNames: Map<string, string>): string {
  return fightNameParts(name)
    .map((p) => npcNames.get(p) ?? p)
    .join(' / ')
}

/** 查詢 Boss（NPC）英文名稱對應的繁中名稱；沒有中文名稱的不在結果中。 */
export async function fetchNpcNames(names: string[], signal?: AbortSignal): Promise<Map<string, string>> {
  const unique = [...new Set(names)].filter((n) => NPC_NAME.test(n) && /[A-Za-z]/.test(n))
  const result = new Map<string, string>()
  for (let i = 0; i < unique.length; i += NPC_BATCH) {
    const params = new URLSearchParams(unique.slice(i, i + NPC_BATCH).map((n) => ['name', n]))
    const batch: Record<string, { name: string }> = await get(`/npc-names?${params}`, signal)
    for (const [en, { name }] of Object.entries(batch)) result.set(en, name)
  }
  return result
}

/** 查詢報告中所有戰鬥名稱（Boss）的繁中名稱。 */
export function fetchFightNames(report: Report, signal?: AbortSignal): Promise<Map<string, string>> {
  return fetchNpcNames(
    report.fights.flatMap((f) => fightNameParts(f.name)),
    signal,
  )
}

/** 把報告的戰鬥名稱換成繁中，英文保留在 englishName。 */
export function translateReport(report: Report, npcNames: Map<string, string>): Report {
  return {
    ...report,
    fights: report.fights.map((f) => {
      const zh = translateFightName(f.name, npcNames)
      return zh === f.name ? f : { ...f, name: zh, englishName: f.name }
    }),
  }
}

export interface EventQuery {
  sourceId?: number
  dataType?: EventDataType
  hostility?: 'Friendlies' | 'Enemies'
}

export interface AbilityName {
  name: string
  /** tc：官方繁中；chs：簡中轉繁 */
  source: 'tc' | 'chs'
}

// Worker 單次最多查詢的技能數
const NAME_BATCH = 500
// Worker 可查的 ID：遊戲技能（Action 表，< 1,000,000）、效果（1,000,000 + 狀態 ID）
// 與道具（FFLogs 以 0x2000000 + 道具 ID 表示，HQ 再加 1,000,000）
const ITEM_OFFSET = 0x2000000
const isNameable = (id: number) =>
  (id > 0 && id < 1_100_000) || (id > ITEM_OFFSET && id < ITEM_OFFSET + 2_000_000)

/** 查詢技能與道具（例如爆發藥）的繁中名稱（經 Worker 代查）；沒有中文名稱的不在結果中。 */
export async function fetchAbilityNames(ids: number[], signal?: AbortSignal): Promise<Map<number, AbilityName>> {
  const unique = [...new Set(ids)].filter(isNameable).sort((a, b) => a - b)
  const names = new Map<number, AbilityName>()
  for (let i = 0; i < unique.length; i += NAME_BATCH) {
    const batch = unique.slice(i, i + NAME_BATCH)
    const result: Record<string, AbilityName> = await get(`/abilities?ids=${batch.join(',')}`, signal)
    for (const [id, name] of Object.entries(result)) names.set(Number(id), name)
  }
  return names
}

/** 敵方可否選中的變化（報告時間）。 */
export interface TargetabilityChange {
  timestamp: number
  sourceID?: number
  targetable: boolean
}

export function fetchTargetability(
  code: string,
  fight: Pick<Fight, 'id' | 'startTime' | 'endTime'>,
  signal?: AbortSignal,
): Promise<TargetabilityChange[]> {
  const params = new URLSearchParams({ fight: String(fight.id), start: String(fight.startTime), end: String(fight.endTime) })
  return get(`/reports/${encodeURIComponent(code)}/targetability?${params}`, signal)
}
const MAX_PAGES = 50

/** 取得整場戰鬥的事件，自動依 nextPageTimestamp 翻頁。 */
export async function fetchFightEvents(
  code: string,
  fight: Pick<Fight, 'id' | 'startTime' | 'endTime'>,
  query: EventQuery = {},
  signal?: AbortSignal,
): Promise<FFLogsEvent[]> {
  const events: FFLogsEvent[] = []
  let start: number | null = fight.startTime

  for (let page = 0; start !== null; page++) {
    if (page >= MAX_PAGES) throw new Error('事件頁數過多，已中止')
    const params = new URLSearchParams({ fight: String(fight.id), start: String(start), end: String(fight.endTime) })
    if (query.sourceId !== undefined) params.set('source', String(query.sourceId))
    if (query.dataType) params.set('dataType', query.dataType)
    if (query.hostility) params.set('hostility', query.hostility)

    const result: { data: FFLogsEvent[]; nextPageTimestamp: number | null } = await get(
      `/reports/${encodeURIComponent(code)}/events?${params}`,
      signal,
    )
    events.push(...result.data)
    start = result.nextPageTimestamp
  }
  return events
}
