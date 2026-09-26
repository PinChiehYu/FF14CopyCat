import { API_BASE } from '../config'
import type { EventDataType, FFLogsEvent, Fight, Report } from './types'

export class ApiError extends Error {
  readonly status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

async function get<T>(path: string, signal?: AbortSignal): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, { signal })
  if (!res.ok) {
    // 429：本站的每 IP 限制；503：FFLogs 的請求上限
    if (res.status === 429 || res.status === 503) {
      throw new ApiError(res.status, '請求過多，暫時無法取得資料，請稍候一分鐘再試')
    }
    const body = (await res.json().catch(() => null)) as { error?: string } | null
    throw new ApiError(res.status, body?.error ?? `API 錯誤：${res.status}`)
  }
  return (await res.json()) as T
}

export function fetchReport(code: string, signal?: AbortSignal): Promise<Report> {
  return get(`/reports/${encodeURIComponent(code)}`, signal)
}

/** 繁中服排名（Worker 定時掃描公開報告自建）中的一筆擊殺；名次與 PR 依該玩家 rDPS 最好的一場。 */
export interface TcRanking {
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

/** 查詢繁中服排名中某 Boss、某職業 PR 在範圍內的紀錄（由高到低）。 */
export function fetchTcRankings(
  query: { encounter: number; difficulty: number; job: string; minPr: number; maxPr: number },
  signal?: AbortSignal,
): Promise<{ count: number; rankings: TcRanking[] }> {
  const params = new URLSearchParams(Object.entries(query).map(([k, v]) => [k, String(v)]))
  return get(`/tc-rankings?${params}`, signal)
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
