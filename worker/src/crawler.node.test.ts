// Node 環境的測試（使用 node:sqlite）：由 tsconfig.node.json 檢查，Worker 的 tsconfig 不含 Node 型別
import { memoryDb } from './testDb.node.ts'
import { describe, expect, it } from 'vitest'
import { backfillDamage, crawl, flagSuspectFights, MAX_PAGE, NEVER_CHECK, pageOutcome, pruneGoneReports, percentile, tcRankings, tcRankingsAbove, type DbLike, type Graphql } from './crawler.ts'

const tcReport = {
  code: 'TC1',
  startTime: 1_000,
  fights: [
    { id: 3, encounterID: 100, difficulty: 101, startTime: 10_000, endTime: 110_000, friendlyPlayers: [1, 2, 3] },
    { id: 4, encounterID: 100, difficulty: 100, startTime: 200_000, endTime: 300_000, friendlyPlayers: [1, 2] }, // 非零式：不存
  ],
  masterData: {
    actors: [
      { id: 1, name: '席德', server: '泰坦', subType: 'Samurai' },
      { id: 2, name: 'Lavid', server: 'Gilgamesh', subType: 'Paladin' }, // 非繁中服：不存
      { id: 3, name: '甲', server: '泰坦', subType: 'Paladin' }, // 傷害表沒有 totalRDPS：以 total 代替
    ],
  },
}
const globalReport = { ...tcReport, code: 'NA1', masterData: { actors: [{ id: 1, name: 'x', server: 'Gilgamesh', subType: 'Samurai' }] } }

function fakeGraphql(listed: unknown[]): { graphql: Graphql; calls: string[] } {
  const calls: string[] = []
  const graphql: Graphql = async <T>(query: string) => {
    calls.push(query.includes('reports(') ? 'list' : 'damage')
    if (query.includes('reports(')) {
      return { rateLimitData: { pointsSpentThisHour: 10 }, reportData: { reports: { has_more_pages: false, data: listed } } } as T
    }
    return {
      reportData: {
        report: {
          f3: {
            data: {
              entries: [
                { id: 1, name: '席德', type: 'Samurai', total: 2_500_000, totalRDPS: 3_000_000 },
                { id: 2, name: 'Lavid', type: 'Paladin', total: 2_000_000 },
                { id: 3, name: '甲', type: 'Paladin', total: 2_000_000 },
                { id: 9, name: 'Limit Break', type: 'LimitBreak', total: 100_000 },
              ],
            },
          },
        },
      },
    } as T
  }
  return { graphql, calls }
}

describe('crawl', () => {
  it('stores savage kills of Traditional Chinese players and skips scanned reports', async () => {
    const db = memoryDb()
    const { graphql, calls } = fakeGraphql([tcReport, globalReport])
    const result = await crawl(db, graphql, 10 * 24 * 3600_000, 68)
    // 只有繁中服的報告查傷害表；非繁中服、非零式、非玩家不存
    expect(result).toMatchObject({ tcReports: 1, parses: 2 })
    expect(calls.filter((c) => c === 'damage')).toHaveLength(1)
    const rows = await db.prepare('SELECT report, fight, actor, job, rdps FROM parses ORDER BY actor').all()
    expect(rows.results).toEqual([
      { report: 'TC1', fight: 3, actor: 1, job: 'Samurai', rdps: 30_000 },
      { report: 'TC1', fight: 3, actor: 3, job: 'Paladin', rdps: 20_000 },
    ])
    // 全隊總傷害：傷害表所有角色（含非繁中服與極限技）的 total 加總
    expect(await db.prepare('SELECT report, fight, encounter, difficulty, total, suspect FROM fight_damage').all()).toEqual({
      results: [{ report: 'TC1', fight: 3, encounter: 100, difficulty: 101, total: 6_600_000, suspect: 0 }],
    })

    // 再掃一次：已處理過的報告不再查傷害表
    const again = fakeGraphql([tcReport, globalReport])
    await crawl(db, again.graphql, 10 * 24 * 3600_000 + 1, 68)
    expect(again.calls.filter((c) => c === 'damage')).toHaveLength(0)
  })

  // 以下未指定選項的測試是預設值（每次 6 頁、最多 47 個請求）；正式排程每次 1 頁、2 份報告（index.ts，見下方「production options」）
  it('stops before the per-run request limit and resumes the same page next time (default options)', async () => {
    const db = memoryDb()
    const now = 100 * 24 * 3600_000
    await db.prepare("INSERT INTO crawl_state (key, value) VALUES ('zone68:cursor', ?)").bind(String(now - 2 * 24 * 3600_000 - 3600_000)).run()
    // 一頁 60 份繁中服報告：每份都要查傷害表，這次執行查不完
    const reports = Array.from({ length: 60 }, (_, i) => ({ ...tcReport, code: `R${i}` }))
    let damage = 0
    let listings = 0
    const graphql: Graphql = async <T>(query: string) => {
      if (query.includes('reports(')) listings++
      if (query.includes('reports(')) return { rateLimitData: { pointsSpentThisHour: 10 }, reportData: { reports: { has_more_pages: true, data: reports } } } as T
      damage++
      return { reportData: { report: {} } } as T
    }
    const first = await crawl(db, graphql, now, 68)
    expect(first.skipped).toBe('subrequests')
    // Workers 免費方案每次執行最多 50 個對外請求（另留給權杖等）：GraphQL 請求不超過 47 個
    expect(listings + damage).toBeLessThanOrEqual(47)
    expect(listings + damage).toBeGreaterThanOrEqual(45)
    // 頁碼不推進；已處理的報告記為已掃描，下次同一頁只處理剩下的
    expect(await db.prepare("SELECT value FROM crawl_state WHERE key = 'zone68:recent_page'").first()).toBeNull()
    const before = damage
    await crawl(db, graphql, now + 1000, 68)
    expect(damage - before).toBe(60 - before)
  })

  const DAY = 24 * 3600_000
  const state = async (db: DbLike, key: string) =>
    Number((await db.prepare('SELECT value FROM crawl_state WHERE key = ?').bind(`zone68:${key}`).first<{ value: string }>())!.value)

  /** 記錄每次列出報告清單的時間窗，可指定哪些頁還有下一頁 */
  function listingGraphql(hasMore: (q: { startTime: number; page: number }) => boolean) {
    const lists: { startTime: number; endTime: number; page: number }[] = []
    const graphql: Graphql = async <T>(_query: string, vars: Record<string, unknown>) => {
      const q = vars as { startTime: number; endTime: number; page: number }
      lists.push({ startTime: q.startTime, endTime: q.endTime, page: q.page })
      return { rateLimitData: { pointsSpentThisHour: 10 }, reportData: { reports: { has_more_pages: hasMore(q), data: [] } } } as T
    }
    return { graphql, lists }
  }

  it('scans the last two days first, then backfills old days with the remaining pages', async () => {
    const db = memoryDb()
    const now = 100 * DAY
    const { graphql, lists } = listingGraphql(() => false)
    const result = await crawl(db, graphql, now, 68)
    // 最近兩天一頁就掃完（沒有下一頁），剩下 5 頁從 60 天前一天一天往後補
    expect(lists[0]).toEqual({ startTime: now - 2 * DAY, endTime: now, page: 1 })
    expect(result).toMatchObject({ pages: 6, recentPages: 1 })
    expect(await state(db, 'cursor')).toBe(now - 55 * DAY)
  })

  it('continues a recent-days round across runs and caps it while backfilling', async () => {
    const db = memoryDb()
    const now = 100 * DAY
    // 最近兩天有 5 頁
    const recent = (q: { startTime: number; page: number }) => q.startTime >= now - 2 * DAY && q.page < 5
    const first = listingGraphql(recent)
    expect(await crawl(db, first.graphql, now, 68)).toMatchObject({ pages: 6, recentPages: 3 })
    expect(await state(db, 'recent_page')).toBe(4)

    // 下一次執行：同一輪繼續第 4、5 頁（起點不變），掃完後剩下的頁數補舊資料
    const second = listingGraphql(recent)
    expect(await crawl(db, second.graphql, now + 3600_000, 68)).toMatchObject({ pages: 6, recentPages: 2 })
    expect(second.lists.slice(0, 2).map((l) => [l.startTime, l.page])).toEqual([
      [now - 2 * DAY, 4],
      [now - 2 * DAY, 5],
    ])
    expect(await state(db, 'recent_page')).toBe(1)
    expect(await state(db, 'recent_start')).toBe(now + 3600_000 - 2 * DAY)
  })

  it('scans one page per run, alternating recent days and backfill (CPU limit of the free plan)', async () => {
    const db = memoryDb()
    const now = 100 * DAY
    const recent = (q: { startTime: number; page: number }) => q.startTime >= now - 2 * DAY && q.page < 5
    const first = listingGraphql(recent)
    expect(await crawl(db, first.graphql, now, 68, { pages: 1 })).toMatchObject({ pages: 1, recentPages: 1 })
    const second = listingGraphql(recent)
    expect(await crawl(db, second.graphql, now, 68, { pages: 1, backfillOnly: true })).toMatchObject({ pages: 1, recentPages: 0 })
    expect(second.lists).toEqual([{ startTime: now - 60 * DAY, endTime: now - 59 * DAY, page: 1 }])
  })

  it('queries two reports per run with the production options and resumes the same page', async () => {
    const db = memoryDb()
    const now = 100 * DAY
    const reports = Array.from({ length: 5 }, (_, i) => ({ ...tcReport, code: `P${i}` }))
    const { graphql, calls } = fakeGraphql(reports)
    // 正式排程：1 頁，1 個清單請求＋2 份報告的傷害表（index.ts 的 CRAWL_REPORTS_PER_RUN）
    const result = await crawl(db, graphql, now, 68, { pages: 1, maxRequests: 3 })
    expect(result).toMatchObject({ skipped: 'subrequests', tcReports: 2 })
    expect(calls).toEqual(['list', 'damage', 'damage'])
    // 頁碼不推進：下次同一頁從第 3 份報告繼續
    expect(await db.prepare("SELECT value FROM crawl_state WHERE key = 'zone68:recent_page'").first()).toBeNull()
    const next = fakeGraphql(reports)
    expect(await crawl(db, next.graphql, now + 300_000, 68, { pages: 1, maxRequests: 3 })).toMatchObject({ tcReports: 2 })
  })

  it('gives every page to the last two days once the backfill has caught up', async () => {
    const db = memoryDb()
    const now = 100 * DAY
    await db.prepare("INSERT INTO crawl_state (key, value) VALUES ('zone68:cursor', ?)").bind(String(now - 2 * DAY - 3600_000)).run()
    const { graphql, lists } = listingGraphql((q) => q.page < 10)
    expect(await crawl(db, graphql, now, 68)).toMatchObject({ pages: 6, recentPages: 6 })
    // 補舊資料只落後一小時：不補
    expect(lists.every((l) => l.startTime === now - 2 * DAY)).toBe(true)
  })

  it('narrows the time range instead of asking FFLogs for a page beyond 25', async () => {
    const db = memoryDb()
    const now = 100 * DAY
    const start = now - 60 * DAY
    // 舊版卡在第 26 頁（FFLogs 回錯誤「The maximum allowed page is 25」）
    for (const [key, value] of [['cursor', start], ['page', 26], ['recent_start', now - 2 * DAY]]) {
      await db.prepare('INSERT INTO crawl_state (key, value) VALUES (?, ?)').bind(`zone68:${key}`, String(value)).run()
    }
    const lists: { startTime: number; endTime: number; page: number }[] = []
    const graphql: Graphql = async <T>(_query: string, vars: Record<string, unknown>) => {
      const q = vars as { startTime: number; endTime: number; page: number }
      lists.push({ startTime: q.startTime, endTime: q.endTime, page: q.page })
      if (q.page > 25) throw new Error('The maximum allowed page is 25 until the performance of paginated queries can be improved.')
      const recent = q.startTime >= now - 2 * DAY
      // 補舊資料這一天報告很多：新到舊排列，最後一頁的最舊報告在 start + 6 小時，仍有下一頁
      const data = recent ? [] : [{ code: `r${lists.length}a`, startTime: start + 8 * 3600_000, fights: [] }, { code: `r${lists.length}b`, startTime: start + 6 * 3600_000, fights: [] }]
      const hasMore = !recent && (q.page < 25 || q.endTime > start + 6 * 3600_000 + 1)
      return { rateLimitData: { pointsSpentThisHour: 10 }, reportData: { reports: { has_more_pages: hasMore, data } } } as T
    }
    await crawl(db, graphql, now, 68)
    const backfill = lists.filter((l) => l.startTime < now - 2 * DAY)
    // 退回第 25 頁；仍有下一頁 → 只列還沒涵蓋的 [開始, 最舊 + 1 毫秒]，從第 1 頁重新開始
    expect(backfill[0]).toEqual({ startTime: start, endTime: start + DAY, page: 25 })
    expect(backfill[1]).toEqual({ startTime: start, endTime: start + 6 * 3600_000 + 1, page: 1 })
    expect(lists.every((l) => l.page <= 25)).toBe(true)
  })

  it('stops when the hourly points are mostly used', async () => {
    const graphql: Graphql = async <T>() =>
      ({ rateLimitData: { pointsSpentThisHour: 3000 }, reportData: { reports: { has_more_pages: false, data: [tcReport] } } }) as T
    const result = await crawl(memoryDb(), graphql, 10 * 24 * 3600_000, 68)
    expect(result).toMatchObject({ skipped: 'points', tcReports: 0 })
  })
})

describe('tcRankings', () => {
  it('reads only the kills that can reach the PR threshold, with identical results (sample selection)', async () => {
    const db = memoryDb()
    // 固定種子的隨機資料：同一人多場、rDPS 相同、重複上傳（戰鬥的實際開始時間相同）
    let seed = 7
    const rand = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31)
    for (let i = 0; i < 400; i++) {
      const player = Math.floor(rand() * 120)
      const rdps = Math.round(20_000 + rand() * 15_000)
      const start = rand() < 0.05 ? 7_000_000 + player : i * 3_600_000
      // 約 5% 是傷害數字不可信的場次：兩種查法都要排除
      const suspect = rand() < 0.05 ? 1 : 0
      await db
        .prepare(
          "INSERT INTO parses (report, fight, actor, encounter, difficulty, job, name, server, rdps, fight_start, fight_end, report_start, suspect) VALUES (?, 1, 1, 100, 101, 'Samurai', ?, '泰坦', ?, 0, 600000, ?, ?)",
        )
        .bind(`R${i}`, `p${player}`, rdps, start, suspect)
        .run()
    }
    for (const minPr of [0, 1, 47, 50, 75, 95, 100]) {
      const { rankings } = await tcRankings(db, 100, 101, 'Samurai', minPr, 100, Number.MAX_SAFE_INTEGER)
      expect(await tcRankingsAbove(db, 100, 101, 'Samurai', minPr), String(minPr)).toEqual(rankings)
    }
  })

  it('gives every kill its own rank and PR against the best rDPS of other characters',async () => {
    const db = memoryDb()
    // 戰鬥的實際開始時間＝報告開始＋戰鬥在報告中的開始；預設每份報告不同
    const insert = (report: string, name: string, rdps: number, job = 'Samurai', reportStart = report.charCodeAt(0) * 3600_000, fightStart = 0) =>
      db
        .prepare(
          'INSERT INTO parses (report, fight, actor, encounter, difficulty, job, name, server, rdps, fight_start, fight_end, report_start) VALUES (?, 1, 1, 100, 101, ?, ?, ?, ?, ?, ?, ?)',
        )
        .bind(report, job, name, '泰坦', rdps, fightStart, fightStart + 600_000, reportStart)
        .run()
    await insert('A', '甲', 30_000)
    await insert('B', '甲', 31_000) // 同一人較好的一場
    await insert('C', '乙', 29_000, 'Samurai', 1_000_000, 50_000)
    await insert('D', '丙', 28_000)
    await insert('E', '丁', 20_000)
    // 同一場被另一人重複上傳（報告開始時間不同，但戰鬥的實際開始時間相同）：只留一筆
    await insert('H', '乙', 29_000, 'Samurai', 1_020_000, 30_000)
    await insert('I', '丙', 25_000) // 同一人較差的一場：自己的名次與 PR（勝過丁）
    await insert('K', '丙', 25_000) // rDPS 相同但是另一場：保留
    await insert('L', '乙', 27_000) // 乙較差的一場：輸給丙最好的一場，PR 比乙最好的一場低
    // 其他職業不列入人數與名次（包括同一人玩其他職業）
    await insert('F', '戊', 40_000, 'Ninja')
    await insert('G', '丁', 35_000, 'Ninja')

    const all = await tcRankings(db, 100, 101, 'Samurai', 0, 100)
    expect(all.count).toBe(4)
    expect(all.rankings.map((r) => [r.name, r.report, r.rank, r.pr])).toEqual([
      // 名次為所有場次依 rDPS 的順位（重複上傳的 H 不佔名次）；PR 為這一場與其他玩家最好一場比較
      ['甲', 'B', 1, 100],
      ['甲', 'A', 2, 100],
      ['乙', 'C', 3, 66],
      ['丙', 'D', 4, 33],
      ['乙', 'L', 5, 33],
      ['丙', 'I', 6, 33],
      ['丙', 'K', 7, 33],
      ['丁', 'E', 8, 0],
    ])
    const mid = await tcRankings(db, 100, 101, 'Samurai', 30, 70)
    expect(mid.rankings.map((r) => r.report)).toEqual(['C', 'D', 'L', 'I', 'K'])
    // 乙最好的一場在範圍內，較差的一場不在
    const top = await tcRankings(db, 100, 101, 'Samurai', 60, 100)
    expect(top.rankings.map((r) => r.report)).toEqual(['B', 'A', 'C'])
    expect((await tcRankings(db, 100, 101, 'Samurai', 0, 100, 2)).rankings.map((r) => r.report)).toEqual(['B', 'A'])
    const ninja = await tcRankings(db, 100, 101, 'Ninja', 0, 100)
    expect(ninja.rankings.map((r) => [r.name, r.rank, r.pr])).toEqual([
      ['戊', 1, 100],
      ['丁', 2, 0],
    ])
  })

  it('places any rDPS among the rankings, excluding the player’s own best', async () => {
    const db = memoryDb()
    const insert = (report: string, name: string, rdps: number, reportStart = report.charCodeAt(0) * 3600_000, fightStart = 0) =>
      db
        .prepare(
          'INSERT INTO parses (report, fight, actor, encounter, difficulty, job, name, server, rdps, fight_start, fight_end, report_start) VALUES (?, 1, 1, 100, 101, ?, ?, ?, ?, ?, ?, ?)',
        )
        .bind(report, 'Samurai', name, '泰坦', rdps, fightStart, fightStart + 600_000, reportStart)
        .run()
    await insert('A', '甲', 30_000)
    await insert('B', '甲', 31_000)
    await insert('C', '乙', 29_000, 1_000_000, 50_000)
    await insert('H', '乙', 29_000, 1_020_000, 30_000) // C 的重複上傳
    await insert('D', '丙', 28_000)
    await insert('L', '丙', 27_000)
    await insert('E', '丁', 20_000)
    const at = (rdps: number, player?: string) => tcRankings(db, 100, 101, 'Samurai', 0, 100, 1, { rdps, player }).then((r) => r.position)
    // 不在資料庫的玩家：和 4 位的最好一場比較、總共 5 人；比它高的擊殺 B、A
    expect(await at(29_500)).toEqual({ pr: 75, better: 2 })
    // 乙自己的最好一場：同 C 的 PR
    expect(await at(29_000, '乙@泰坦')).toEqual({ pr: 66, better: 2 })
    // 丙較差的一場：不和自己的最好一場（28,000）比較；比它高的有 B、A、C、D、L（H 是重複上傳）
    expect(await at(26_000, '丙@泰坦')).toEqual({ pr: 33, better: 5 })
  })

  it('computes percentiles', () => {
    expect(percentile(1, 1)).toBe(100)
    expect(percentile(1, 100)).toBe(100)
    expect(percentile(100, 100)).toBe(0)
  })
})

describe('pruneGoneReports', () => {
  it('removes parses of reports that became private or were deleted', async () => {
    const db = memoryDb()
    const now = 10 * 24 * 3600_000
    for (const code of ['OK', 'PRIV', 'GONE', 'FLAKY', 'NEW']) {
      await db
        .prepare(
          "INSERT INTO parses (report, fight, actor, encounter, difficulty, job, name, server, rdps, fight_start, fight_end, report_start) VALUES (?, 1, 1, 100, 101, 'Samurai', '席德', '泰坦', 1, 0, 1, 0)",
        )
        .bind(code)
        .run()
      // NEW 剛收錄，還不用確認
      await db.prepare('INSERT INTO scanned_reports (code, scanned_at) VALUES (?, ?)').bind(code, code === 'NEW' ? now : 0).run()
      // 預處理、傷害與前輩平均樣本的資料
      for (const sql of [
        "INSERT INTO pull_timelines (report, fight, boss, processed_at) VALUES (?, 1, '', 0)",
        'INSERT INTO pull_queue (report, fight, report_start) VALUES (?, 1, 0)',
        'INSERT INTO fight_damage (report, fight, encounter, difficulty, total) VALUES (?, 1, 100, 101, 1)',
        'INSERT INTO damage_queue (report, fight, report_start) VALUES (?, 1, 0)',
        "INSERT INTO tank_slots (report, fight, actor, slot) VALUES (?, 1, 1, 'MT')",
        "INSERT INTO average_samples (encounter, difficulty, job, slot, tier, report, fight, actor, name, server, rdps, pr, patch, selected_at) VALUES (100, 101, 'Samurai', '', 'top', ?, 1, 1, '席德', '泰坦', 1, 99, '7.2', 0)",
        "INSERT INTO sample_data (report, fight, actor, casts, buffs, applications, deaths, processed_at) VALUES (?, 1, 1, '', '', '', 0, 0)",
      ]) {
        await db.prepare(sql).bind(code).run()
      }
    }
    // 沒有收錄擊殺的舊報告：不查 FFLogs，標為不必確認
    await db.prepare('INSERT INTO scanned_reports (code, scanned_at) VALUES (?, 0)').bind('EMPTY').run()
    const checked: string[] = []
    const graphql: Graphql = async <T>(query: string, vars: Record<string, unknown>) => {
      if (query.includes('reports(')) return { rateLimitData: { pointsSpentThisHour: 10 }, reportData: { reports: { has_more_pages: false, data: [] } } } as T
      const code = vars.code as string
      checked.push(code)
      if (code === 'PRIV') throw new Error('You do not have permission to view this report.')
      if (code === 'GONE') throw new Error('This report does not exist.')
      if (code === 'FLAKY') throw new Error('Too many requests')
      return { reportData: { report: { code } } } as T
    }
    expect(await pruneGoneReports(db, graphql, now)).toEqual({ checkedReports: 3, removedReports: 2, failedReports: 1 })
    expect(checked.sort()).toEqual(['FLAKY', 'GONE', 'OK', 'PRIV'])
    // 不再公開的報告的所有資料一併刪除，其他報告的保留
    for (const table of ['parses', 'pull_timelines', 'pull_queue', 'fight_damage', 'damage_queue', 'tank_slots', 'average_samples', 'sample_data']) {
      const left = await db.prepare(`SELECT report FROM ${table} ORDER BY report`).all<{ report: string }>()
      expect([table, left.results.map((r) => r.report)]).toEqual([table, ['FLAKY', 'NEW', 'OK']])
    }
    const empty = await db.prepare("SELECT checked_at FROM scanned_reports WHERE code = 'EMPTY'").first<{ checked_at: number }>()
    expect(empty?.checked_at).toBe(NEVER_CHECK)

    // 一小時後：暫時失敗的再確認一次，已確認的一天內不再確認
    checked.length = 0
    await pruneGoneReports(db, graphql, now + 3600_000)
    expect(checked).toEqual(['FLAKY'])
  })
})

describe('fights with untrustworthy damage', () => {
  const insertParse = (db: DbLike, report: string, rdps: number) =>
    db
      .prepare(
        "INSERT INTO parses (report, fight, actor, encounter, difficulty, job, name, server, rdps, fight_start, fight_end, report_start) VALUES (?, 1, 1, 100, 101, 'Samurai', ?, '泰坦', ?, 0, 600000, 0)",
      )
      .bind(report, `p-${report}`, rdps)
      .run()
  const insertDamage = (db: DbLike, report: string, total: number) =>
    db.prepare('INSERT INTO fight_damage (report, fight, encounter, difficulty, total) VALUES (?, 1, 100, 101, ?)').bind(report, total).run()

  it('flags fights whose party damage is far above the median of the boss and leaves them out of the rankings', async () => {
    const db = memoryDb()
    for (let i = 0; i < 24; i++) {
      await insertParse(db, `OK${i}`, 30_000 + i * 10)
      await insertDamage(db, `OK${i}`, 105_000_000 + i * 100_000)
    }
    // 傷害數字錯誤的日誌：全隊總傷害為 Boss 血量的 1.6 倍，rDPS 也虛高
    await insertParse(db, 'BAD', 50_000)
    await insertDamage(db, 'BAD', 168_000_000)
    expect((await tcRankings(db, 100, 101, 'Samurai', 0, 100)).rankings[0].report).toBe('BAD')

    expect(await flagSuspectFights(db, 100, 101)).toMatchObject({ flagged: 1, cleared: 0 })
    expect(await db.prepare("SELECT suspect FROM parses WHERE report = 'BAD'").first()).toEqual({ suspect: 1 })
    const { count, rankings } = await tcRankings(db, 100, 101, 'Samurai', 0, 100)
    expect(rankings.map((r) => r.report)).not.toContain('BAD')
    expect(count).toBe(24)
    expect((await tcRankingsAbove(db, 100, 101, 'Samurai', 0)).map((r) => r.report)).not.toContain('BAD')
    // 再跑一次沒有變動就不寫入
    expect(await flagSuspectFights(db, 100, 101)).toMatchObject({ flagged: 0, cleared: 0 })

    // 中位數變高（例如換了血量更多的版本）後不再超過：取消標記
    for (let i = 0; i < 30; i++) await insertDamage(db, `HIGH${i}`, 150_000_000)
    expect(await flagSuspectFights(db, 100, 101)).toMatchObject({ flagged: 0, cleared: 1 })
    expect(await db.prepare("SELECT suspect FROM parses WHERE report = 'BAD'").first()).toEqual({ suspect: 0 })
  })

  it('does not flag anything while the boss has too few kills', async () => {
    const db = memoryDb()
    for (let i = 0; i < 5; i++) await insertDamage(db, `OK${i}`, 100_000_000)
    await insertDamage(db, 'BAD', 300_000_000)
    expect(await flagSuspectFights(db, 100, 101)).toEqual({ median: null, flagged: 0, cleared: 0 })
  })

  it('backfills the party damage of fights stored before, one report per call', async () => {
    const db = memoryDb()
    await insertParse(db, 'OLD', 30_000)
    await db.prepare("INSERT INTO damage_queue (report, fight, report_start) VALUES ('OLD', 1, 0), ('GONE', 1, 1)").run()
    await db
      .prepare(
        "INSERT INTO parses (report, fight, actor, encounter, difficulty, job, name, server, rdps, fight_start, fight_end, report_start) VALUES ('GONE', 1, 1, 100, 101, 'Samurai', 'g', '泰坦', 1, 0, 1, 1)",
      )
      .run()
    const graphql: Graphql = async <T>(_query: string, vars: Record<string, unknown>) => {
      if (vars.code === 'GONE') throw new Error('This report does not exist.')
      return { reportData: { report: { f1: { data: { entries: [{ total: 60_000_000 }, { total: 45_000_000 }] } } } } } as T
    }
    // 最新的報告先（GONE）：已不公開，移出佇列
    expect(await backfillDamage(db, graphql)).toEqual({ fights: 0, failed: 1 })
    expect(await backfillDamage(db, graphql)).toEqual({ fights: 1, failed: 0 })
    expect(await db.prepare('SELECT report, total FROM fight_damage').all()).toEqual({ results: [{ report: 'OLD', total: 105_000_000 }] })
    expect(await db.prepare('SELECT COUNT(*) AS n FROM damage_queue').first()).toEqual({ n: 0 })
    expect(await backfillDamage(db, graphql)).toEqual({ fights: 0, failed: 0 })
  })
})

describe('pageOutcome', () => {
  const q = { startTime: 1000, endTime: 9000, page: MAX_PAGE }
  it('keeps paging before the last allowed page', () => {
    expect(pageOutcome({ ...q, page: 3 }, true, [{ startTime: 8000 }, { startTime: 5000 }])).toEqual({ hasMore: true })
    expect(pageOutcome(q, false, [{ startTime: 8000 }])).toEqual({ hasMore: false })
  })

  it('narrows to the side the last page has not covered, for either sort order', () => {
    // 新到舊：已列出 [5000, 9000]，剩下 [1000, 5001]
    expect(pageOutcome(q, true, [{ startTime: 8000 }, { startTime: 5000 }])).toEqual({ hasMore: true, narrowed: { startTime: 1000, endTime: 5001 } })
    // 舊到新：已列出 [1000, 6000]，剩下 [5999, 9000]
    expect(pageOutcome(q, true, [{ startTime: 2000 }, { startTime: 6000 }])).toEqual({ hasMore: true, narrowed: { startTime: 5999, endTime: 9000 } })
  })
})
