// 繁中服排名資料庫的定時掃描：FFLogs 不替繁中服排名（沒有區域、報告排名為空），
// 因此定時列出零式副本的公開報告，挑出繁中服玩家的擊殺，以傷害表算出每位玩家的 rDPS 存進 D1。
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
// 每次執行先掃最近這段時間的報告（近期擊殺最常被拿來參考，也涵蓋晚上傳的報告），再用剩下的頁數往回補舊資料
const RECENT_MS = 2 * 24 * 3600_000
// 還在補舊資料時，最近兩天最多用幾頁（其餘給補資料）；補完後全部頁數都給最近兩天
const RECENT_PAGES_WHILE_BACKFILLING = 3
// 補舊資料的時間窗（依報告開始時間）
const WINDOW_MS = 24 * 3600_000
// 第一次執行時往前補的天數
const BACKFILL_MS = 60 * 24 * 3600_000
// 補舊資料追上「最近兩天」的起點後就停止；落後超過這麼久（例如停擺過）才再補一次
const BACKFILL_SLACK_MS = 12 * 3600_000
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
  /** FFLogs 的 rDPS 總量（total − 隊友 Buff 加成 ＋ 自己 Buff 給隊友的貢獻） */
  totalRDPS?: number
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
  rdps: number
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

/** 由傷害表算出繁中服玩家的 rDPS（沒有 totalRDPS 時以 DPS 代替）。 */
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
          rdps: (e.totalRDPS ?? e.total) / seconds,
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
  /** 其中用在最近兩天的頁數 */
  recentPages: number
  reports: number
  tcReports: number
  parses: number
  /** 確認是否仍公開的報告數與其中被移除的（設為私人或已刪除） */
  checkedReports: number
  removedReports: number
}

/**
 * 掃描一頁報告清單：未處理過的報告中，繁中服玩家的擊殺查傷害表存入 parses。
 * 回傳是否還有下一頁；這小時的額度快用完時回傳 null（不處理）。進度狀態 `state` 與結果在同一批寫入。
 */
async function scanPage(
  db: DbLike,
  graphql: Graphql,
  query: { zoneID: number; startTime: number; endTime: number; page: number },
  now: number,
  result: CrawlResult,
  state: (hasMore: boolean) => StatementLike[],
): Promise<boolean | null> {
  const data = await graphql<{
    rateLimitData?: { pointsSpentThisHour: number }
    reportData?: { reports?: { has_more_pages: boolean; data: ListedReport[] } }
  }>(LIST_QUERY, { ...query, limit: PAGE_SIZE })
  if ((data?.rateLimitData?.pointsSpentThisHour ?? 0) > POINTS_CEILING) {
    result.skipped = 'points'
    return null
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
                'INSERT OR REPLACE INTO parses (report, fight, actor, encounter, difficulty, job, name, server, rdps, fight_start, fight_end, report_start) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
              )
              .bind(p.report, p.fight, p.actor, p.encounter, p.difficulty, p.job, p.name, p.server, p.rdps, p.fightStart, p.fightEnd, p.reportStart),
          )
        }
      }
    }
    writes.push(db.prepare('INSERT OR REPLACE INTO scanned_reports (code, scanned_at) VALUES (?, ?)').bind(report.code, now))
  }
  const hasMore = listed?.has_more_pages ?? false
  await db.batch([...writes, ...state(hasMore)])
  return hasMore
}

// 已收錄的報告多久確認一次是否仍公開，每次執行最多確認幾份（一份一個查詢，點數很少）
const CHECK_INTERVAL_MS = 24 * 3600_000
const CHECKS_PER_RUN = 20
const CHECK_QUERY = /* GraphQL */ `query ($code: String!) { reportData { report(code: $code) { code } } }`
// FFLogs 對設為私人與已刪除的報告回傳的錯誤；其他錯誤（額度、網路）視為暫時的，下次再確認
const GONE_REPORT = /permission to view this report|report does not exist/i

/** 收錄後被設為私人或刪除的報告：前端打不開，從排名中移除（紀錄刪除，報告仍記在 scanned_reports，不會再收錄）。 */
async function pruneGoneReports(db: DbLike, graphql: Graphql, now: number, result: CrawlResult): Promise<void> {
  const { results } = await db
    .prepare(
      `SELECT s.code FROM scanned_reports s WHERE s.code IN (SELECT DISTINCT report FROM parses)
       AND COALESCE(s.checked_at, s.scanned_at) < ? ORDER BY COALESCE(s.checked_at, s.scanned_at) LIMIT ?`,
    )
    .bind(now - CHECK_INTERVAL_MS, CHECKS_PER_RUN)
    .all<{ code: string }>()
  const writes: StatementLike[] = []
  for (const { code } of results) {
    let gone: boolean
    try {
      const data = await graphql<{ reportData?: { report?: { code: string } | null } }>(CHECK_QUERY, { code })
      gone = !data?.reportData?.report
    } catch (err) {
      if (!GONE_REPORT.test(err instanceof Error ? err.message : String(err))) continue
      gone = true
    }
    result.checkedReports++
    if (gone) {
      result.removedReports++
      writes.push(db.prepare('DELETE FROM parses WHERE report = ?').bind(code))
    }
    writes.push(db.prepare('UPDATE scanned_reports SET checked_at = ? WHERE code = ?').bind(now, code))
  }
  if (writes.length > 0) await db.batch(writes)
}

/**
 * 定時執行一次，存入繁中服玩家的擊殺：
 * 1. 先掃最近兩天（跨次執行逐頁輪完一輪；時間窗的起點在一輪開始時固定，新上傳的報告只會讓後面的頁往後移，不會漏掉）。
 * 2. 剩下的頁數往回補舊資料（從 60 天前一天一天往後），追上最近兩天的起點就停止。
 * 3. 確認已收錄的報告是否仍公開（每份每天一次），被設為私人或刪除的從排名移除。
 */
export async function crawl(db: DbLike, graphql: Graphql, now = Date.now(), zoneID = CRAWL_ZONES[0]): Promise<CrawlResult> {
  const result: CrawlResult = { pages: 0, recentPages: 0, reports: 0, tcReports: 0, parses: 0, checkedReports: 0, removedReports: 0 }
  const prefix = `zone${zoneID}`
  let cursor = Number((await getState(db, `${prefix}:cursor`)) ?? now - BACKFILL_MS)
  let page = Number((await getState(db, `${prefix}:page`)) ?? 1)
  let recentStart = Number((await getState(db, `${prefix}:recent_start`)) ?? now - RECENT_MS)
  let recentPage = Number((await getState(db, `${prefix}:recent_page`)) ?? 1)
  const backfillEnd = now - RECENT_MS
  const backfilling = cursor < backfillEnd - BACKFILL_SLACK_MS || (page > 1 && cursor < backfillEnd)

  // 1. 最近兩天：一輪掃完就停（下一輪留到下次執行，避免同一次重複列出相同的頁）
  const recentBudget = backfilling ? RECENT_PAGES_WHILE_BACKFILLING : PAGES_PER_RUN
  while (result.recentPages < recentBudget) {
    const hasMore = await scanPage(db, graphql, { zoneID, startTime: recentStart, endTime: now, page: recentPage }, now, result, (more) => [
      setState(db, `${prefix}:recent_start`, String(more ? recentStart : now - RECENT_MS)),
      setState(db, `${prefix}:recent_page`, String(more ? recentPage + 1 : 1)),
    ])
    if (hasMore === null) return result
    result.recentPages++
    if (!hasMore) {
      recentStart = now - RECENT_MS
      recentPage = 1
      break
    }
    recentPage++
  }

  // 2. 補舊資料：同一時間窗還有下一頁就翻頁，否則前進到下一個時間窗
  while (backfilling && result.pages < PAGES_PER_RUN && cursor < backfillEnd) {
    const windowEnd = Math.min(cursor + WINDOW_MS, backfillEnd)
    const hasMore = await scanPage(db, graphql, { zoneID, startTime: cursor, endTime: windowEnd, page }, now, result, (more) => [
      setState(db, `${prefix}:cursor`, String(more ? cursor : windowEnd)),
      setState(db, `${prefix}:page`, String(more ? page + 1 : 1)),
    ])
    if (hasMore === null) return result
    if (hasMore) {
      page++
    } else {
      page = 1
      cursor = windowEnd
    }
  }
  await pruneGoneReports(db, graphql, now, result)
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
  /** 排名依據（FFLogs 的 rDPS） */
  rdps: number
  fightStart: number
  fightEnd: number
  reportStart: number
}

/** 百分位：排第 rank 名（共 count 人）勝過多少比例的玩家。 */
export function percentile(rank: number, count: number): number {
  return count <= 1 ? 100 : Math.floor(((count - rank) / (count - 1)) * 100)
}

/**
 * 某 Boss、某職業的繁中服排名（依 rDPS）：玩家（名稱＋伺服器）的名次與 PR 依每人最好的一場計算，
 * 回傳 PR 在 [minPr, maxPr] 之間的玩家的所有擊殺（依 rDPS 由高到低，重複上傳的只留一筆）前 limit 筆與總人數。
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
  const { results } = await db
    .prepare(
      `SELECT report, fight, actor, name, server, rdps, fight_start, fight_end, report_start
       FROM parses WHERE encounter = ? AND difficulty = ? AND job = ?
       ORDER BY rdps DESC, report_start, report`,
    )
    .bind(encounter, difficulty, job)
    .all<{
      report: string
      fight: number
      actor: number
      name: string
      server: string
      rdps: number
      fight_start: number
      fight_end: number
      report_start: number
    }>()
  // 玩家的名次與 PR 以每人最好的一場計算（依 rDPS 由高到低，第一次出現即最好的一場）
  const player = (r: { name: string; server: string }) => `${r.name}@${r.server}`
  const ranks = new Map<string, number>()
  for (const r of results) if (!ranks.has(player(r))) ranks.set(player(r), ranks.size + 1)
  const count = ranks.size
  // 列出 PR 範圍內玩家的所有擊殺：好的玩家常有多場，找得到隨機機制與我相同的機率較高。
  // 同一場戰鬥被不同人重複上傳只留一筆：FFLogs 沒有跨報告的戰鬥識別碼，以戰鬥的實際開始時間（報告開始＋戰鬥在報告中的開始）判斷，
  // 同一場在不同報告中完全相同
  const seen = new Set<string>()
  const rankings: RankedParse[] = []
  for (const r of results) {
    const rank = ranks.get(player(r))!
    const pr = percentile(rank, count)
    if (pr < minPr || pr > maxPr) continue
    const duplicate = `${player(r)}|${r.report_start + r.fight_start}`
    if (seen.has(duplicate)) continue
    seen.add(duplicate)
    rankings.push({
      rank,
      pr,
      report: r.report,
      fight: r.fight,
      actor: r.actor,
      name: r.name,
      server: r.server,
      rdps: r.rdps,
      fightStart: r.fight_start,
      fightEnd: r.fight_end,
      reportStart: r.report_start,
    })
    if (rankings.length >= limit) break
  }
  return { count, rankings }
}
