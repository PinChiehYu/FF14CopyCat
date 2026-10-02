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
// 本季零式的 Boss（CRAWL_ZONES 的副本；換季時一起更新）。掃到的報告中也有其他副本的擊殺（舊零式等），
// 前輩平均只為這些 Boss 選樣本
export const CURRENT_ENCOUNTERS = [97, 98, 99, 100]

const PAGE_SIZE = 25
// FFLogs 報告列表允許的最大頁碼（超過回錯誤），見 pageOutcome()
export const MAX_PAGE = 25
// 每小時執行一次（wrangler.toml），每次最多 6 頁：每小時約 300 點列表＋傷害表，留大部分額度給訪客
const PAGES_PER_RUN = 6
// Workers 免費方案每次執行最多 50 個對外請求；留一些給取得 FFLogs 授權
const SUBREQUEST_BUDGET = 47
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
}

/**
 * 掃描一頁報告清單：未處理過的報告中，繁中服玩家的擊殺查傷害表存入 parses。
 * 回傳是否還有下一頁；這小時的額度快用完時回傳 null（不處理）；這次執行的請求數用完時存入已處理的報告、
 * 不推進進度並回傳 null。進度狀態 `state` 與結果在同一批寫入。
 */
async function scanPage(
  db: DbLike,
  graphql: Graphql,
  query: { zoneID: number; startTime: number; endTime: number; page: number },
  now: number,
  result: CrawlResult,
  state: (outcome: PageOutcome) => StatementLike[],
  budgetLeft: () => boolean = () => true,
): Promise<PageOutcome | null> {
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
    let stored = 0
    const kills = tcKills(report)
    if (kills.length > 0) {
      if (!budgetLeft()) {
        result.skipped = 'subrequests'
        if (writes.length > 0) await db.batch(writes)
        return null
      }
      result.tcReports++
      const tables = await graphql<{ reportData?: { report?: Record<string, { data?: { entries?: DamageEntry[] } }> } }>(
        damageQuery(kills.map((f) => f.id)),
        { code: report.code },
      )
      for (const fight of kills) {
        const entries = tables?.reportData?.report?.[`f${fight.id}`]?.data?.entries ?? []
        const parses = parsesFromDamage(report, fight, entries)
        // 有收錄玩家的場次排入預處理（timelines.ts）
        if (parses.length > 0) {
          writes.push(
            db.prepare('INSERT OR IGNORE INTO pull_queue (report, fight, report_start) VALUES (?, ?, ?)').bind(parses[0].report, parses[0].fight, parses[0].reportStart),
          )
        }
        for (const p of parses) {
          result.parses++
          stored++
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
    // 沒有收錄任何擊殺的報告不需要確認是否仍公開（pruneGoneReports）
    writes.push(
      db.prepare('INSERT OR REPLACE INTO scanned_reports (code, scanned_at, checked_at) VALUES (?, ?, ?)').bind(report.code, now, stored > 0 ? null : NEVER_CHECK),
    )
  }
  const outcome = pageOutcome(query, listed?.has_more_pages ?? false, reports)
  await db.batch([...writes, ...state(outcome)])
  return outcome
}

/** 一頁的結果：是否還有下一頁；翻到 FFLogs 允許的最後一頁仍有下一頁時，附上剩下未列出的時間範圍（narrowed） */
interface PageOutcome {
  hasMore: boolean
  narrowed?: { startTime: number; endTime: number }
}

/**
 * FFLogs 的報告列表最多只能翻到第 MAX_PAGE 頁（之後回錯誤「The maximum allowed page is 25」）。
 * 最後一頁仍有下一頁時，把時間範圍縮到這一頁還沒涵蓋的那一側，從第 1 頁重新列出：依這一頁報告的開始時間判斷
 * 列表的排序（新到舊或舊到新），已列出的是 [最舊, 結束] 或 [開始, 最新]。邊界多留 1 毫秒，同一時間開始的報告
 * 會再列一次（已處理的會跳過），不會漏掉。
 */
export function pageOutcome(query: { startTime: number; endTime: number; page: number }, hasMore: boolean, reports: { startTime: number }[]): PageOutcome {
  if (!hasMore || query.page < MAX_PAGE || reports.length === 0) return { hasMore }
  const first = reports[0].startTime
  const last = reports[reports.length - 1].startTime
  const newestFirst = first >= last
  const oldest = Math.min(first, last)
  const newest = Math.max(first, last)
  return {
    hasMore,
    narrowed: newestFirst
      ? { startTime: query.startTime, endTime: Math.max(query.startTime, oldest + 1) }
      : { startTime: Math.min(query.endTime, newest - 1), endTime: query.endTime },
  }
}

// 已收錄的報告多久確認一次是否仍公開，每次執行最多確認幾份（一份一個查詢，點數很少）。
// 在獨立的定時觸發中執行（index.ts 的 PRUNE_CRON）：Workers 免費方案每次執行最多 50 個對外請求，
// 與掃描放在同一次時，掃描用掉 40 多個，只剩 3 個給確認（其餘失敗被當成暫時的錯誤跳過）
const CHECK_INTERVAL_MS = 24 * 3600_000
export const CHECKS_PER_RUN = 40
// 沒有收錄擊殺的報告的 checked_at：排在確認順序的最後，永遠不會輪到（不必每次都讀過一遍）。
// 舊資料由 pruneGoneReports 讀到時補上（不需要請求），每次最多 SCANS_PER_RUN 份
export const NEVER_CHECK = Number.MAX_SAFE_INTEGER
const SCANS_PER_RUN = 200
const CHECK_QUERY = /* GraphQL */ `query ($code: String!) { reportData { report(code: $code) { code } } }`
// FFLogs 對設為私人與已刪除的報告回傳的錯誤；其他錯誤（額度、網路）視為暫時的，下次再確認
export const GONE_REPORT = /permission to view this report|report does not exist/i

export interface PruneResult {
  /** 確認是否仍公開的報告數與其中被移除的（設為私人或已刪除） */
  checkedReports: number
  removedReports: number
  /** 查詢失敗（非私人／刪除）、下次再確認的報告數 */
  failedReports: number
}

/** 收錄後被設為私人或刪除的報告：前端打不開，從排名中移除（紀錄刪除，報告仍記在 scanned_reports，不會再收錄）。 */
export async function pruneGoneReports(db: DbLike, graphql: Graphql, now = Date.now()): Promise<PruneResult> {
  const result: PruneResult = { checkedReports: 0, removedReports: 0, failedReports: 0 }
  const { results: due } = await db
    .prepare(
      // 依索引 scanned_reports_check 的順序只讀到期的幾列（D1 每日讀取額度）；EXISTS 以主鍵查 parses
      `SELECT s.code, EXISTS (SELECT 1 FROM parses p WHERE p.report = s.code) listed FROM scanned_reports s
       WHERE COALESCE(s.checked_at, s.scanned_at) < ? ORDER BY COALESCE(s.checked_at, s.scanned_at) LIMIT ?`,
    )
    .bind(now - CHECK_INTERVAL_MS, SCANS_PER_RUN)
    .all<{ code: string; listed: number }>()
  const writes: StatementLike[] = due
    .filter((r) => !r.listed)
    .map((r) => db.prepare('UPDATE scanned_reports SET checked_at = ? WHERE code = ?').bind(NEVER_CHECK, r.code))
  const results = due.filter((r) => r.listed).slice(0, CHECKS_PER_RUN)
  for (const { code } of results) {
    let gone: boolean
    try {
      const data = await graphql<{ reportData?: { report?: { code: string } | null } }>(CHECK_QUERY, { code })
      gone = !data?.reportData?.report
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      if (!GONE_REPORT.test(message)) {
        result.failedReports++
        console.warn(`check ${code} failed: ${message}`)
        continue
      }
      gone = true
    }
    result.checkedReports++
    if (gone) {
      result.removedReports++
      writes.push(db.prepare('DELETE FROM parses WHERE report = ?').bind(code))
      // 預處理的資料一併刪除（timelines.ts）
      writes.push(db.prepare('DELETE FROM pull_timelines WHERE report = ?').bind(code))
      writes.push(db.prepare('DELETE FROM pull_queue WHERE report = ?').bind(code))
      writes.push(db.prepare('DELETE FROM tank_slots WHERE report = ?').bind(code))
      // 前輩平均的樣本：下次選樣本時以其他擊殺補上
      writes.push(db.prepare('DELETE FROM average_samples WHERE report = ?').bind(code))
      writes.push(db.prepare('DELETE FROM sample_data WHERE report = ?').bind(code))
    }
    writes.push(db.prepare('UPDATE scanned_reports SET checked_at = ? WHERE code = ?').bind(now, code))
  }
  if (writes.length > 0) await db.batch(writes)
  return result
}

/**
 * 定時執行一次，存入繁中服玩家的擊殺：
 * 1. 先掃最近兩天（跨次執行逐頁輪完一輪；時間窗的起點在一輪開始時固定，新上傳的報告只會讓後面的頁往後移，不會漏掉）。
 * 2. 剩下的頁數往回補舊資料（從 60 天前一天一天往後），追上最近兩天的起點就停止。
 */
export async function crawl(db: DbLike, query: Graphql, now = Date.now(), zoneID = CRAWL_ZONES[0]): Promise<CrawlResult> {
  const result: CrawlResult = { pages: 0, recentPages: 0, reports: 0, tcReports: 0, parses: 0 }
  // 計算對外請求數（列表＋每份繁中服報告的傷害表），避免超過 Workers 每次執行的請求上限；
  // 一頁中途用完時，已處理的報告照常存入、不推進頁碼，下次重新列出這一頁（已處理的會跳過）
  let requests = 0
  const graphql: Graphql = (q, v) => {
    requests++
    return query(q, v)
  }
  const budgetLeft = () => requests < SUBREQUEST_BUDGET
  // 至少還能列出一頁並查一份報告才開始新的一頁
  const canScanPage = () => {
    if (requests + 2 <= SUBREQUEST_BUDGET) return true
    result.skipped = 'subrequests'
    return false
  }
  const prefix = `zone${zoneID}`
  const num = async (key: string) => {
    const value = await getState(db, `${prefix}:${key}`)
    return value ? Number(value) : null
  }
  let cursor = (await num('cursor')) ?? now - BACKFILL_MS
  // 舊版存過超過上限的頁碼（第 26 頁會回錯誤）：退回最後一頁，該頁仍有下一頁時改縮小時間範圍
  let page = Math.min((await num('page')) ?? 1, MAX_PAGE)
  // 補舊資料這個時間窗的結束；縮小過範圍時，目前列出的子範圍為 list_start～list_end
  let windowEnd = (await num('window_end')) ?? null
  let listStart = (await num('list_start')) ?? null
  let listEnd = (await num('list_end')) ?? null
  let recentStart = (await num('recent_start')) ?? now - RECENT_MS
  let recentPage = Math.min((await num('recent_page')) ?? 1, MAX_PAGE)
  let recentEnd = (await num('recent_end')) ?? null
  const backfillEnd = now - RECENT_MS
  const backfilling = cursor < backfillEnd - BACKFILL_SLACK_MS || ((page > 1 || listEnd !== null) && cursor < backfillEnd)

  // 1. 最近兩天：一輪掃完就停（下一輪留到下次執行，避免同一次重複列出相同的頁）；
  // 翻到最後一頁仍有下一頁時縮小範圍（recent_start／recent_end）從第 1 頁重新列出
  const recentBudget = backfilling ? RECENT_PAGES_WHILE_BACKFILLING : PAGES_PER_RUN
  while (result.recentPages < recentBudget && canScanPage()) {
    const query = { zoneID, startTime: recentStart, endTime: recentEnd ?? now, page: recentPage }
    const outcome = await scanPage(
      db,
      graphql,
      query,
      now,
      result,
      ({ hasMore, narrowed }) => [
        setState(db, `${prefix}:recent_start`, String(narrowed?.startTime ?? (hasMore ? recentStart : now - RECENT_MS))),
        setState(db, `${prefix}:recent_end`, narrowed ? String(narrowed.endTime) : hasMore && recentEnd !== null ? String(recentEnd) : ''),
        setState(db, `${prefix}:recent_page`, String(narrowed ? 1 : hasMore ? recentPage + 1 : 1)),
      ],
      budgetLeft,
    )
    if (outcome === null) return result
    result.recentPages++
    if (!outcome.hasMore) {
      recentStart = now - RECENT_MS
      recentEnd = null
      recentPage = 1
      break
    }
    if (outcome.narrowed) {
      recentStart = outcome.narrowed.startTime
      recentEnd = outcome.narrowed.endTime
      recentPage = 1
    } else recentPage++
  }

  // 2. 補舊資料：同一時間窗還有下一頁就翻頁（翻到最後一頁仍有就縮小範圍），否則前進到下一個時間窗
  while (backfilling && result.pages < PAGES_PER_RUN && cursor < backfillEnd && canScanPage()) {
    const end = windowEnd ?? Math.min(cursor + WINDOW_MS, backfillEnd)
    const query = { zoneID, startTime: listStart ?? cursor, endTime: listEnd ?? end, page }
    const outcome = await scanPage(
      db,
      graphql,
      query,
      now,
      result,
      ({ hasMore, narrowed }) => [
        setState(db, `${prefix}:cursor`, String(hasMore ? cursor : end)),
        setState(db, `${prefix}:page`, String(narrowed ? 1 : hasMore ? page + 1 : 1)),
        setState(db, `${prefix}:window_end`, hasMore ? String(end) : ''),
        setState(db, `${prefix}:list_start`, narrowed ? String(narrowed.startTime) : hasMore && listStart !== null ? String(listStart) : ''),
        setState(db, `${prefix}:list_end`, narrowed ? String(narrowed.endTime) : hasMore && listEnd !== null ? String(listEnd) : ''),
      ],
      budgetLeft,
    )
    if (outcome === null) return result
    if (!outcome.hasMore) {
      page = 1
      cursor = end
      windowEnd = listStart = listEnd = null
    } else if (outcome.narrowed) {
      page = 1
      windowEnd = end
      listStart = outcome.narrowed.startTime
      listEnd = outcome.narrowed.endTime
    } else {
      page++
      windowEnd = end
    }
  }
  return result
}

export interface RankedParse {
  /** 這一場在所有場次（重複上傳只算一次）中依 rDPS 的順位，每場不同 */
  rank: number
  /** 繁中服內的百分位（最高 100、最低 0）：這一場與其他玩家各自最好的一場比較 */
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

/** 任一 rDPS（例如使用者自己的一場，不一定在資料庫中）在繁中服排名中的位置。 */
export interface RankPosition {
  /** 與其他玩家各自最好的一場比較的百分位（同每場擊殺的 PR） */
  pr: number
  /** rDPS 比它高的擊殺場數（重複上傳只算一次） */
  better: number
}

/**
 * 某 Boss、某職業的繁中服排名（依 rDPS）：每一場擊殺各自計算 PR（和其他玩家各自最好的一場比較），名次為所有場次依 rDPS 的順位；
 * 回傳 PR 在 [minPr, maxPr] 之間的擊殺（依 rDPS 由高到低，重複上傳的只留一筆）前 limit 筆與總人數。
 * 傳入 position 時另外回傳該 rDPS 的 PR 與比它高的擊殺數；player（名稱@伺服器）在資料庫中時不和自己的最好一場比較。
 */
export async function tcRankings(
  db: DbLike,
  encounter: number,
  difficulty: number,
  job: string,
  minPr: number,
  maxPr: number,
  limit = 100,
  position?: { rdps: number; player?: string },
): Promise<{ count: number; rankings: RankedParse[]; position?: RankPosition }> {
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
  // 每位玩家最好的一場（依 rDPS 由高到低，第一次出現即最好的一場），由高到低
  const player = (r: { name: string; server: string }) => `${r.name}@${r.server}`
  const bests = new Map<string, number>()
  for (const r of results) if (!bests.has(player(r))) bests.set(player(r), r.rdps)
  const bestList = [...bests.values()]
  const count = bestList.length
  // 高於 v 的「最好一場」有幾個（bestList 由高到低，二分搜尋）
  const above = (v: number) => {
    let lo = 0
    let hi = bestList.length
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (bestList[mid] > v) lo = mid + 1
      else hi = mid
    }
    return lo
  }
  // 每一場擊殺各自的 PR：勝過幾位其他玩家的最好一場（不和自己的最好一場比較）。
  // 同一人較差的一場有自己的 PR，PR 範圍內的每一場都列出，找得到隨機機制與我相同的機率較高。
  // 同一場戰鬥被不同人重複上傳只留一筆：FFLogs 沒有跨報告的戰鬥識別碼，以戰鬥的實際開始時間（報告開始＋戰鬥在報告中的開始）判斷，
  // 同一場在不同報告中完全相同
  // 名次為所有場次依 rDPS 的順位（PR 相同的場次 rDPS 仍不同，名次不重複）
  const seen = new Set<string>()
  const rankings: RankedParse[] = []
  let rank = 0
  for (const r of results) {
    const duplicate = `${player(r)}|${r.report_start + r.fight_start}`
    if (seen.has(duplicate)) continue
    seen.add(duplicate)
    rank++
    const pr = percentile(1 + above(r.rdps) - (bests.get(player(r))! > r.rdps ? 1 : 0), count)
    if (pr < minPr || pr > maxPr) continue
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
  if (!position) return { count, rankings }
  // 指定的 rDPS：和其他玩家各自最好的一場比較（不在資料庫中的玩家也算進總人數）
  const self = position.player !== undefined && bests.has(position.player) ? position.player : undefined
  const othersAbove = above(position.rdps) - (self !== undefined && bests.get(self)! > position.rdps ? 1 : 0)
  const total = count - (self !== undefined ? 1 : 0) + 1
  const counted = new Set<string>()
  let better = 0
  for (const r of results) {
    if (r.rdps <= position.rdps) break
    const duplicate = `${player(r)}|${r.report_start + r.fight_start}`
    if (counted.has(duplicate)) continue
    counted.add(duplicate)
    better++
  }
  return { count, rankings, position: { pr: percentile(1 + othersAbove, total), better } }
}
