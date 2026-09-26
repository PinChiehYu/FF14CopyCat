// 繁中服排名資料庫的定時掃描：FFLogs 不替繁中服排名（沒有區域、報告排名為空），
// 因此定時列出零式副本的公開報告，挑出繁中服玩家的擊殺，以傷害表算出每位玩家的 DPS 存進 D1。
// 額度：每小時 3,600 點由所有訪客共用；列出 25 份報告約 50 點、一份報告的傷害表約 2 點。

/** D1 的最小介面（方便在 Node 測試中以假物件替代）。 */
export interface DbLike {
  prepare(sql: string): StatementLike
  batch(statements: StatementLike[]): Promise<unknown>
}
export interface StatementLike {
  bind(...values: unknown[]): StatementLike
  first<T = Record<string, unknown>>(): Promise<T | null>
  all<T = Record<string, unknown>>(): Promise<{ results: T[] }>
  run(): Promise<unknown>
}

export type Graphql = <T>(query: string, variables: Record<string, unknown>) => Promise<T | undefined>

/** 繁中服的伺服器（FFLogs 報告中玩家的 server 欄位）。 */
export const TC_SERVERS: ReadonlySet<string> = new Set(['泰坦', '奧汀', '利維坦', '迦樓羅', '伊弗利特', '鳳凰', '巴哈姆特'])

// 掃描的副本：目前的零式（AAC Cruiserweight，zone 68）；換季時更新
export const CRAWL_ZONES = [68]
export const CRAWL_DIFFICULTY = 101

const PAGE_SIZE = 25
// 每小時執行一次（wrangler.toml），每次最多 6 頁：每小時約 300 點列表＋傷害表，留大部分額度給訪客
const PAGES_PER_RUN = 6
// 每次掃描的時間窗（依報告開始時間）
const WINDOW_MS = 24 * 3600_000
// 第一次執行時往前補的天數
const BACKFILL_MS = 60 * 24 * 3600_000
// 追上現在後，重新掃描最近這段時間（晚上傳的報告）
const RESCAN_MS = 2 * 24 * 3600_000
// 這小時已用超過這麼多點就跳過，把額度留給訪客
const POINTS_CEILING = 2000

const LIST_QUERY = /* GraphQL */ `
  query ($zoneID: Int!, $startTime: Float, $endTime: Float, $page: Int, $limit: Int) {
    rateLimitData { pointsSpentThisHour }
    reportData {
      reports(zoneID: $zoneID, startTime: $startTime, endTime: $endTime, page: $page, limit: $limit) {
        has_more_pages
        data {
          code
          startTime
          fights(killType: Kills) { id encounterID difficulty startTime endTime friendlyPlayers }
          masterData { actors(type: "Player") { id name server subType } }
        }
      }
    }
  }
`

interface ListedReport {
  code: string
  startTime: number
  fights: { id: number; encounterID: number; difficulty: number | null; startTime: number; endTime: number; friendlyPlayers: number[] | null }[]
  masterData: { actors: { id: number; name: string; server: string | null; subType: string }[] } | null
}

interface DamageEntry {
  id: number
  name: string
  type: string
  total: number
}

export interface Parse {
  report: string
  fight: number
  actor: number
  encounter: number
  difficulty: number
  job: string
  name: string
  server: string
  dps: number
  fightStart: number
  fightEnd: number
  reportStart: number
}

const NOT_PLAYERS = new Set(['LimitBreak', 'Pet', 'NPC', 'Unknown'])

/** 一份報告中繁中服玩家的擊殺（只取掃描的難度），以及要查的傷害表戰鬥。 */
export function tcKills(report: ListedReport): ListedReport['fights'] {
  const tc = (report.masterData?.actors ?? []).some((a) => a.server !== null && TC_SERVERS.has(a.server))
  if (!tc) return []
  return report.fights.filter((f) => f.difficulty === CRAWL_DIFFICULTY)
}

/** 由傷害表算出繁中服玩家的 DPS。 */
export function parsesFromDamage(report: ListedReport, fight: ListedReport['fights'][number], entries: DamageEntry[]): Parse[] {
  const actors = new Map((report.masterData?.actors ?? []).map((a) => [a.id, a]))
  const seconds = (fight.endTime - fight.startTime) / 1000
  if (seconds <= 0) return []
  return entries
    .filter((e) => !NOT_PLAYERS.has(e.type))
    .flatMap((e) => {
      const actor = actors.get(e.id)
      if (!actor?.server || !TC_SERVERS.has(actor.server)) return []
      return [
        {
          report: report.code,
          fight: fight.id,
          actor: e.id,
          encounter: fight.encounterID,
          difficulty: fight.difficulty ?? 0,
          job: e.type,
          name: actor.name,
          server: actor.server,
          dps: e.total / seconds,
          fightStart: fight.startTime,
          fightEnd: fight.endTime,
          reportStart: report.startTime,
        },
      ]
    })
}

/** 一份報告多場戰鬥的傷害表合成一個查詢（以別名區分）。 */
function damageQuery(fightIds: number[]): string {
  const tables = fightIds.map((id) => `f${id}: table(fightIDs: [${id}], dataType: DamageDone)`).join('\n')
  return `query ($code: String!) { reportData { report(code: $code) { ${tables} } } }`
}

async function getState(db: DbLike, key: string): Promise<string | null> {
  const row = await db.prepare('SELECT value FROM crawl_state WHERE key = ?').bind(key).first<{ value: string }>()
  return row?.value ?? null
}

function setState(db: DbLike, key: string, value: string): StatementLike {
  return db.prepare('INSERT OR REPLACE INTO crawl_state (key, value) VALUES (?, ?)').bind(key, value)
}

export interface CrawlResult {
  skipped?: string
  pages: number
  reports: number
  tcReports: number
  parses: number
}

/** 定時執行一次：依進度掃描一個時間窗內的報告，存入繁中服玩家的擊殺。 */
export async function crawl(db: DbLike, graphql: Graphql, now = Date.now(), zoneID = CRAWL_ZONES[0]): Promise<CrawlResult> {
  const result: CrawlResult = { pages: 0, reports: 0, tcReports: 0, parses: 0 }
  const prefix = `zone${zoneID}`
  let cursor = Number((await getState(db, `${prefix}:cursor`)) ?? now - BACKFILL_MS)
  let page = Number((await getState(db, `${prefix}:page`)) ?? 1)

  for (let i = 0; i < PAGES_PER_RUN; i++) {
    const windowEnd = Math.min(cursor + WINDOW_MS, now)
    const data = await graphql<{
      rateLimitData?: { pointsSpentThisHour: number }
      reportData?: { reports?: { has_more_pages: boolean; data: ListedReport[] } }
    }>(LIST_QUERY, { zoneID, startTime: cursor, endTime: windowEnd, page, limit: PAGE_SIZE })
    if ((data?.rateLimitData?.pointsSpentThisHour ?? 0) > POINTS_CEILING) {
      result.skipped = 'points'
      break
    }
    const listed = data?.reportData?.reports
    result.pages++
    const reports = listed?.data ?? []
    result.reports += reports.length

    const codes = reports.map((r) => r.code)
    const scanned = new Set(
      codes.length === 0
        ? []
        : (
            await db
              .prepare(`SELECT code FROM scanned_reports WHERE code IN (${codes.map(() => '?').join(',')})`)
              .bind(...codes)
              .all<{ code: string }>()
          ).results.map((r) => r.code),
    )
    const writes: StatementLike[] = []
    for (const report of reports.filter((r) => !scanned.has(r.code))) {
      const kills = tcKills(report)
      if (kills.length > 0) {
        result.tcReports++
        const tables = await graphql<{ reportData?: { report?: Record<string, { data?: { entries?: DamageEntry[] } }> } }>(
          damageQuery(kills.map((f) => f.id)),
          { code: report.code },
        )
        for (const fight of kills) {
          const entries = tables?.reportData?.report?.[`f${fight.id}`]?.data?.entries ?? []
          for (const p of parsesFromDamage(report, fight, entries)) {
            result.parses++
            writes.push(
              db
                .prepare(
                  'INSERT OR REPLACE INTO parses (report, fight, actor, encounter, difficulty, job, name, server, dps, fight_start, fight_end, report_start) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
                )
                .bind(p.report, p.fight, p.actor, p.encounter, p.difficulty, p.job, p.name, p.server, p.dps, p.fightStart, p.fightEnd, p.reportStart),
            )
          }
        }
      }
      writes.push(db.prepare('INSERT OR REPLACE INTO scanned_reports (code, scanned_at) VALUES (?, ?)').bind(report.code, now))
    }

    // 推進進度：同一時間窗還有下一頁就翻頁，否則前進到下一個時間窗；追上現在後回頭重掃最近兩天
    if (listed?.has_more_pages) {
      page++
    } else {
      page = 1
      cursor = windowEnd >= now ? now - RESCAN_MS : windowEnd
    }
    writes.push(setState(db, `${prefix}:cursor`, String(cursor)), setState(db, `${prefix}:page`, String(page)))
    await db.batch(writes)
  }
  return result
}

export interface RankedParse {
  rank: number
  /** 繁中服內的百分位（最高 100、最低 0） */
  pr: number
  report: string
  fight: number
  actor: number
  name: string
  server: string
  dps: number
  fightStart: number
  fightEnd: number
  reportStart: number
}

/** 百分位：排第 rank 名（共 count 人）勝過多少比例的玩家。 */
export function percentile(rank: number, count: number): number {
  return count <= 1 ? 100 : Math.floor(((count - rank) / (count - 1)) * 100)
}

/**
 * 某 Boss、某職業的繁中服排名：每位玩家（名稱＋伺服器）只取最好的一場，依 DPS 由高到低，
 * 回傳 PR 在 [minPr, maxPr] 之間的前 limit 筆與總人數。
 */
export async function tcRankings(
  db: DbLike,
  encounter: number,
  difficulty: number,
  job: string,
  minPr: number,
  maxPr: number,
  limit = 100,
): Promise<{ count: number; rankings: RankedParse[] }> {
  // SQLite：GROUP BY 搭配 MAX() 時，其他欄位取自最大值那一列
  const { results } = await db
    .prepare(
      `SELECT report, fight, actor, name, server, MAX(dps) AS dps, fight_start, fight_end, report_start
       FROM parses WHERE encounter = ? AND difficulty = ? AND job = ?
       GROUP BY name, server ORDER BY dps DESC`,
    )
    .bind(encounter, difficulty, job)
    .all<{
      report: string
      fight: number
      actor: number
      name: string
      server: string
      dps: number
      fight_start: number
      fight_end: number
      report_start: number
    }>()
  const count = results.length
  const rankings = results
    .map((r, i) => ({
      rank: i + 1,
      pr: percentile(i + 1, count),
      report: r.report,
      fight: r.fight,
      actor: r.actor,
      name: r.name,
      server: r.server,
      dps: r.dps,
      fightStart: r.fight_start,
      fightEnd: r.fight_end,
      reportStart: r.report_start,
    }))
    .filter((r) => r.pr >= minPr && r.pr <= maxPr)
    .slice(0, limit)
  return { count, rankings }
}
