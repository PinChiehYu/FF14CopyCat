// Node 環境的測試（使用 node:sqlite）：由 tsconfig.node.json 檢查，Worker 的 tsconfig 不含 Node 型別
import { readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import { crawl, percentile, tcRankings, type DbLike, type Graphql, type StatementLike } from './crawler.ts'

/** 以 Node 內建的 SQLite 實作 D1 的最小介面，套用與正式環境相同的 schema.sql。 */
function memoryDb(): DbLike {
  const sqlite = new DatabaseSync(':memory:')
  sqlite.exec(readFileSync(new URL('../schema.sql', import.meta.url), 'utf8'))
  const statement = (sql: string, values: unknown[] = []): StatementLike => ({
    bind: (...next) => statement(sql, next),
    first: async <T>() => (sqlite.prepare(sql).get(...(values as never[])) as T) ?? null,
    all: async <T>() => ({ results: sqlite.prepare(sql).all(...(values as never[])) as T[] }),
    run: async () => sqlite.prepare(sql).run(...(values as never[])),
  })
  return {
    prepare: (sql) => statement(sql),
    batch: async (statements) => {
      for (const s of statements) await s.run()
    },
  }
}

const tcReport = {
  code: 'TC1',
  startTime: 1_000,
  fights: [
    { id: 3, encounterID: 100, difficulty: 101, startTime: 10_000, endTime: 110_000, friendlyPlayers: [1, 2] },
    { id: 4, encounterID: 100, difficulty: 100, startTime: 200_000, endTime: 300_000, friendlyPlayers: [1, 2] }, // 非零式：不存
  ],
  masterData: {
    actors: [
      { id: 1, name: '席德', server: '泰坦', subType: 'Samurai' },
      { id: 2, name: 'Lavid', server: 'Gilgamesh', subType: 'Paladin' }, // 非繁中服：不存
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
    expect(result).toMatchObject({ tcReports: 1, parses: 1 })
    expect(calls.filter((c) => c === 'damage')).toHaveLength(1)
    const rows = await db.prepare('SELECT report, fight, actor, job, dps, rdps FROM parses').all()
    expect(rows.results).toEqual([{ report: 'TC1', fight: 3, actor: 1, job: 'Samurai', dps: 25_000, rdps: 30_000 }])

    // 再掃一次：已處理過的報告不再查傷害表
    const again = fakeGraphql([tcReport, globalReport])
    await crawl(db, again.graphql, 10 * 24 * 3600_000 + 1, 68)
    expect(again.calls.filter((c) => c === 'damage')).toHaveLength(0)
  })

  it('fills rDPS for parses stored before the column existed', async () => {
    const db = memoryDb()
    await db
      .prepare(
        "INSERT INTO parses (report, fight, actor, encounter, difficulty, job, name, server, dps, fight_start, fight_end, report_start) VALUES ('TC1', 3, 1, 100, 101, 'Samurai', '席德', '泰坦', 25000, 10000, 110000, 0)",
      )
      .run()
    const { graphql, calls } = fakeGraphql([])
    expect(await crawl(db, graphql, 10 * 24 * 3600_000, 68)).toMatchObject({ rdpsFilled: 1 })
    expect(calls.filter((c) => c === 'damage')).toHaveLength(1)
    expect(await db.prepare('SELECT rdps FROM parses').first()).toEqual({ rdps: 30_000 })
    // 補完後不再查
    const again = fakeGraphql([])
    expect(await crawl(db, again.graphql, 10 * 24 * 3600_000 + 1, 68)).toMatchObject({ rdpsFilled: 0 })
    expect(again.calls.filter((c) => c === 'damage')).toHaveLength(0)
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

    // 下一小時：同一輪繼續第 4、5 頁（起點不變），掃完後剩下的頁數補舊資料
    const second = listingGraphql(recent)
    expect(await crawl(db, second.graphql, now + 3600_000, 68)).toMatchObject({ pages: 6, recentPages: 2 })
    expect(second.lists.slice(0, 2).map((l) => [l.startTime, l.page])).toEqual([
      [now - 2 * DAY, 4],
      [now - 2 * DAY, 5],
    ])
    expect(await state(db, 'recent_page')).toBe(1)
    expect(await state(db, 'recent_start')).toBe(now + 3600_000 - 2 * DAY)
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

  it('stops when the hourly points are mostly used', async () => {
    const graphql: Graphql = async <T>() =>
      ({ rateLimitData: { pointsSpentThisHour: 3000 }, reportData: { reports: { has_more_pages: false, data: [tcReport] } } }) as T
    const result = await crawl(memoryDb(), graphql, 10 * 24 * 3600_000, 68)
    expect(result).toMatchObject({ skipped: 'points', tcReports: 0 })
  })
})

describe('tcRankings', () => {
  it('ranks characters by the rDPS of their best parse and lists all their kills', async () => {
    const db = memoryDb()
    // rdps 為排名依據；dps 預設與 rdps 相同
    const insert = (report: string, name: string, rdps: number | null, job = 'Samurai', dps = rdps ?? 0) =>
      db
        .prepare(
          'INSERT INTO parses (report, fight, actor, encounter, difficulty, job, name, server, dps, rdps, fight_start, fight_end, report_start) VALUES (?, 1, 1, 100, 101, ?, ?, ?, ?, ?, 0, 1, 0)',
        )
        .bind(report, job, name, '泰坦', dps, rdps)
        .run()
    await insert('A', '甲', 30_000)
    await insert('B', '甲', 31_000) // 同一人較好的一場
    await insert('C', '乙', 29_000)
    await insert('D', '丙', 28_000)
    await insert('E', '丁', 20_000, 'Samurai', 33_000) // DPS 最高但 rDPS 最低：依 rDPS 排最後
    await insert('J', '己', null, 'Samurai', 50_000) // 還沒補上 rDPS：不列入
    await insert('H', '乙', 29_000) // 同一場被另一人重複上傳：只留一筆
    await insert('I', '丙', 25_000) // 同一人較差的一場：沿用最好一場的名次與 PR
    // 其他職業不列入人數與名次（包括同一人玩其他職業）
    await insert('F', '戊', 40_000, 'Ninja')
    await insert('G', '丁', 35_000, 'Ninja')

    const all = await tcRankings(db, 100, 101, 'Samurai', 0, 100)
    expect(all.count).toBe(4)
    expect(all.rankings.map((r) => [r.name, r.report, r.rank, r.pr])).toEqual([
      ['甲', 'B', 1, 100],
      ['甲', 'A', 1, 100],
      ['乙', 'C', 2, 66],
      ['丙', 'D', 3, 33],
      ['丙', 'I', 3, 33],
      ['丁', 'E', 4, 0],
    ])
    const mid = await tcRankings(db, 100, 101, 'Samurai', 30, 70)
    expect(mid.rankings.map((r) => r.report)).toEqual(['C', 'D', 'I'])
    expect((await tcRankings(db, 100, 101, 'Samurai', 0, 100, 2)).rankings.map((r) => r.report)).toEqual(['B', 'A'])
    const ninja = await tcRankings(db, 100, 101, 'Ninja', 0, 100)
    expect(ninja.rankings.map((r) => [r.name, r.rank, r.pr])).toEqual([
      ['戊', 1, 100],
      ['丁', 2, 0],
    ])
  })

  it('computes percentiles', () => {
    expect(percentile(1, 1)).toBe(100)
    expect(percentile(1, 100)).toBe(100)
    expect(percentile(100, 100)).toBe(0)
  })
})
