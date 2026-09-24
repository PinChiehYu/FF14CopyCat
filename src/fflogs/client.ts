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
    const body = (await res.json().catch(() => null)) as { error?: string } | null
    throw new ApiError(res.status, body?.error ?? `API 錯誤：${res.status}`)
  }
  return (await res.json()) as T
}

export function fetchReport(code: string, signal?: AbortSignal): Promise<Report> {
  return get(`/reports/${encodeURIComponent(code)}`, signal)
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
// Action 表的 ID 範圍；FFLogs 以更大的 ID 表示道具（藥水等），沒有對應的技能名稱
const MAX_ACTION_ID = 1_000_000

/** 查詢技能的繁中名稱（經 Worker 代查）；沒有中文名稱的技能不在結果中。 */
export async function fetchAbilityNames(ids: number[], signal?: AbortSignal): Promise<Map<number, AbilityName>> {
  const unique = [...new Set(ids)].filter((id) => id > 0 && id <= MAX_ACTION_ID).sort((a, b) => a - b)
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
  fight: Fight,
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
