// 預處理已收錄的擊殺：每場（報告＋戰鬥）存 Boss 施放、每位已收錄玩家存能力技（非 GCD）與道具施放，
// 前端不必逐筆向 FFLogs 抓（搜尋前輩日誌的機制比對、前輩的爆發點位）。在獨立的定時觸發中執行（index.ts）。
// 每場 2～4 個請求：敵方施放、全隊施放（一次取得最多 8 位玩家）、有坦克時承受的普通攻擊（判斷 MT／ST）。
import { encodeCasts, type EncodedCast } from '../../src/analysis/castCodec'
import { GCD_IDS } from '../../src/jobs/generated'
import { GONE_REPORT, type DbLike, type Graphql, type StatementLike } from './crawler'
import { AUTO_ATTACKS_TAKEN_QUERY, EVENTS_QUERY } from './queries'

// Workers 免費方案每次執行最多 50 個對外請求（含權杖與點數查詢），預留幾個
const SUBREQUEST_BUDGET = 46
// 每場最多用到的請求數（敵方、全隊各最多 2 頁，加上 MT／ST）
const REQUESTS_PER_PULL = 5
// 這小時的點數超過此值就不處理（與排名掃描相同，留給訪客）
const POINTS_CEILING = 2000
// 事件最多翻幾頁（一頁 10,000 筆，一場的敵方或全隊施放通常一頁）
const MAX_PAGES = 2
// 同一技能這段時間內的施放只留一次（多個分身同時施放；對齊與機制比對也以 1 秒去重）
const DEDUPE_MS = 1000
// 普通攻擊（Attack、Shot）不是玩家操作的技能
const AUTO_ATTACKS = new Set([7, 8])
const TANKS = new Set(['Paladin', 'Warrior', 'DarkKnight', 'Gunbreaker'])

const POINTS_QUERY = /* GraphQL */ `query { rateLimitData { pointsSpentThisHour } }`

interface RawEvent {
  timestamp: number
  type: string
  sourceID?: number
  abilityGameID?: number
}

/** Boss 施放：敵方的 cast 事件，同一技能 1 秒內只留一次（戰鬥時間）。 */
export function bossTimeline(events: RawEvent[], fightStart: number): EncodedCast[] {
  const last = new Map<number, number>()
  const casts: EncodedCast[] = []
  for (const e of [...events].sort((a, b) => a.timestamp - b.timestamp)) {
    if (e.type !== 'cast' || e.abilityGameID === undefined) continue
    const t = e.timestamp - fightStart
    const prev = last.get(e.abilityGameID)
    if (prev !== undefined && t - prev < DEDUPE_MS) continue
    last.set(e.abilityGameID, t)
    casts.push({ t, abilityId: e.abilityGameID })
  }
  return casts
}

/** 一位玩家的能力技（非 GCD、非普通攻擊）與道具施放（戰鬥時間）。 */
export function playerActions(events: RawEvent[], fightStart: number, actor: number): EncodedCast[] {
  return events
    .filter(
      (e) =>
        e.type === 'cast' &&
        e.sourceID === actor &&
        e.abilityGameID !== undefined &&
        !GCD_IDS.has(e.abilityGameID) &&
        !AUTO_ATTACKS.has(e.abilityGameID),
    )
    .map((e) => ({ t: e.timestamp - fightStart, abilityId: e.abilityGameID! }))
}

/** 坦克的 MT／ST：承受的 Boss 普通攻擊傷害在全隊最多者為 MT。 */
export function tankSlot(actor: number, autoAttacksTaken: { id: number; total: number }[]): 'MT' | 'ST' {
  const own = autoAttacksTaken.find((e) => e.id === actor)?.total ?? 0
  return autoAttacksTaken.every((e) => e.total <= own) && own > 0 ? 'MT' : 'ST'
}

/**
 * 已預處理場次的 Boss 施放：`{ "報告:戰鬥": 編碼字串 }`；沒有預處理（或報告已不公開，boss 為空）的不回傳。
 */
export async function storedTimelines(db: DbLike, pulls: { report: string; fight: number }[]): Promise<Record<string, string>> {
  if (pulls.length === 0) return {}
  const { results } = await db
    .prepare(
      `SELECT report, fight, boss FROM pull_timelines WHERE boss != '' AND (report, fight) IN (VALUES ${pulls.map(() => '(?, ?)').join(', ')})`,
    )
    .bind(...pulls.flatMap((p) => [p.report, p.fight]))
    .all<{ report: string; fight: number; boss: string }>()
  return Object.fromEntries(results.map((r) => [`${r.report}:${r.fight}`, r.boss]))
}

export interface TimelineResult {
  skipped?: string
  pulls: number
  players: number
  failed: number
  /** 這次用掉的 FFLogs 點數（前後兩次查詢的差；同一小時內其他請求也會算進去） */
  points?: number
}

interface PendingRow {
  report: string
  fight: number
  actor: number
  job: string
  fight_start: number
  fight_end: number
}

/** 尚未預處理的場次（最近的報告優先）與其中已收錄的玩家。 */
async function pendingPulls(db: DbLike, limit: number): Promise<{ report: string; fight: number; start: number; end: number; players: PendingRow[] }[]> {
  const { results } = await db
    .prepare(
      `SELECT p.report, p.fight, p.actor, p.job, p.fight_start, p.fight_end FROM parses p
       WHERE (p.report, p.fight) IN (
         SELECT q.report, q.fight FROM parses q
         WHERE NOT EXISTS (SELECT 1 FROM pull_timelines t WHERE t.report = q.report AND t.fight = q.fight)
         GROUP BY q.report, q.fight ORDER BY MAX(q.report_start) DESC LIMIT ?)`,
    )
    .bind(limit)
    .all<PendingRow>()
  type Pull = { report: string; fight: number; start: number; end: number; players: PendingRow[] }
  const pulls = new Map<string, Pull>()
  for (const row of results) {
    const key = `${row.report}/${row.fight}`
    const pull: Pull = pulls.get(key) ?? { report: row.report, fight: row.fight, start: row.fight_start, end: row.fight_end, players: [] }
    pull.players.push(row)
    pulls.set(key, pull)
  }
  return [...pulls.values()]
}

async function fetchEvents(
  graphql: Graphql,
  pull: { report: string; fight: number; start: number; end: number },
  hostilityType: 'Enemies' | 'Friendlies',
): Promise<RawEvent[]> {
  const events: RawEvent[] = []
  let start: number | null = pull.start
  for (let page = 0; start !== null && page < MAX_PAGES; page++) {
    const data: { reportData?: { report?: { events?: { data?: RawEvent[]; nextPageTimestamp?: number | null } } } } | undefined =
      await graphql(EVENTS_QUERY, {
        code: pull.report,
        fightIDs: [pull.fight],
        startTime: start,
        endTime: pull.end,
        dataType: 'Casts',
        hostilityType,
      })
    const got: { data?: RawEvent[]; nextPageTimestamp?: number | null } | undefined = data?.reportData?.report?.events
    events.push(...(got?.data ?? []))
    start = got?.nextPageTimestamp ?? null
  }
  return events
}

/**
 * 預處理一批尚未處理的場次。報告已私人化或刪除的場次記錄為空（boss 為空字串）、不再重試；
 * 報告被移除時由 pruneGoneReports() 一併刪除。
 */
export async function processTimelines(db: DbLike, query: Graphql, now = Date.now()): Promise<TimelineResult> {
  const result: TimelineResult = { pulls: 0, players: 0, failed: 0 }
  let requests = 0
  const graphql: Graphql = (q, v) => {
    requests++
    return query(q, v)
  }
  const points = await graphql<{ rateLimitData?: { pointsSpentThisHour: number } }>(POINTS_QUERY, {})
  if ((points?.rateLimitData?.pointsSpentThisHour ?? 0) > POINTS_CEILING) {
    result.skipped = 'points'
    return result
  }
  const pulls = await pendingPulls(db, Math.floor((SUBREQUEST_BUDGET - requests) / REQUESTS_PER_PULL))
  const writes: StatementLike[] = []
  for (const pull of pulls) {
    if (requests + REQUESTS_PER_PULL > SUBREQUEST_BUDGET) {
      result.skipped = 'subrequests'
      break
    }
    try {
      const enemies = await fetchEvents(graphql, pull, 'Enemies')
      const friendlies = await fetchEvents(graphql, pull, 'Friendlies')
      let autoAttacks: { id: number; total: number }[] = []
      if (pull.players.some((p) => TANKS.has(p.job))) {
        const data = await graphql<{ reportData?: { report?: { table?: { data?: { entries?: { id: number; total: number }[] } } } } }>(
          AUTO_ATTACKS_TAKEN_QUERY,
          { code: pull.report, fightIDs: [pull.fight] },
        )
        autoAttacks = data?.reportData?.report?.table?.data?.entries ?? []
      }
      writes.push(
        db
          .prepare('INSERT OR REPLACE INTO pull_timelines (report, fight, boss, processed_at) VALUES (?, ?, ?, ?)')
          .bind(pull.report, pull.fight, encodeCasts(bossTimeline(enemies, pull.start)), now),
      )
      for (const p of pull.players) {
        const slot = TANKS.has(p.job) ? tankSlot(p.actor, autoAttacks) : ''
        writes.push(
          db
            .prepare('INSERT OR REPLACE INTO parse_actions (report, fight, actor, slot, actions) VALUES (?, ?, ?, ?, ?)')
            .bind(pull.report, pull.fight, p.actor, slot, encodeCasts(playerActions(friendlies, pull.start, p.actor))),
        )
        result.players++
      }
      result.pulls++
    } catch (err) {
      result.failed++
      const message = err instanceof Error ? err.message : String(err)
      console.warn(`timeline ${pull.report}/${pull.fight} failed: ${message}`)
      // 報告已私人化或刪除：記錄為空，不再重試；其他錯誤（額度、網路）下次再試
      if (GONE_REPORT.test(message)) {
        writes.push(
          db
            .prepare('INSERT OR REPLACE INTO pull_timelines (report, fight, boss, processed_at) VALUES (?, ?, ?, ?)')
            .bind(pull.report, pull.fight, '', now),
        )
      }
    }
  }
  if (writes.length > 0) await db.batch(writes)
  // 這次用掉的點數（記錄在 log，調整頻率用）
  if (result.pulls + result.failed > 0) {
    const after = await graphql<{ rateLimitData?: { pointsSpentThisHour: number } }>(POINTS_QUERY, {}).catch(() => undefined)
    const before = points?.rateLimitData?.pointsSpentThisHour
    const spent = after?.rateLimitData?.pointsSpentThisHour
    if (before !== undefined && spent !== undefined && spent >= before) result.points = spent - before
  }
  return result
}
