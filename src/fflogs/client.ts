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
