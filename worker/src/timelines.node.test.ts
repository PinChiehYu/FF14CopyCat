// Node 環境的測試（使用 node:sqlite）：由 tsconfig.node.json 檢查
import { readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import { decodeCasts } from '../../src/analysis/castCodec.ts'
import type { DbLike, Graphql, StatementLike } from './crawler.ts'
import { AUTO_ATTACKS_TAKEN_QUERY, EVENTS_QUERY } from './queries.ts'
import { bossTimeline, playerActions, processTimelines, storedTimelines, tankSlot } from './timelines.ts'

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

async function addParse(db: DbLike, report: string, fight: number, actor: number, job: string, reportStart = 1) {
  await db
    .prepare(
      'INSERT INTO parses (report, fight, actor, encounter, difficulty, job, name, server, rdps, fight_start, fight_end, report_start) VALUES (?, ?, ?, 100, 101, ?, ?, ?, 20000, 10000, 70000, ?)',
    )
    .bind(report, fight, actor, job, `p${actor}`, '泰坦', reportStart)
    .run()
}

describe('timeline extraction', () => {
  it('keeps one boss cast per ability per second', () => {
    const events = [
      { timestamp: 11_000, type: 'cast', abilityGameID: 500 },
      { timestamp: 11_200, type: 'cast', abilityGameID: 500 }, // 分身同時施放
      { timestamp: 11_100, type: 'begincast', abilityGameID: 600 },
      { timestamp: 14_000, type: 'cast', abilityGameID: 500 },
    ]
    expect(bossTimeline(events, 10_000)).toEqual([
      { t: 1000, abilityId: 500 },
      { t: 4000, abilityId: 500 },
    ])
  })

  it("keeps a player's oGCDs and items, not GCDs, auto-attacks or others' casts", () => {
    const events = [
      { timestamp: 12_000, type: 'cast', sourceID: 5, abilityGameID: 7 }, // 普通攻擊
      { timestamp: 12_500, type: 'cast', sourceID: 5, abilityGameID: 9 }, // GCD
      { timestamp: 13_000, type: 'cast', sourceID: 5, abilityGameID: 7499 }, // 明鏡止水（能力技）
      { timestamp: 13_500, type: 'cast', sourceID: 6, abilityGameID: 7499 }, // 別人
      { timestamp: 14_000, type: 'cast', sourceID: 5, abilityGameID: 1_049_234 }, // 道具
    ]
    expect(playerActions(events, 10_000, 5)).toEqual([
      { t: 3000, abilityId: 7499 },
      { t: 4000, abilityId: 1_049_234 },
    ])
  })

  it('marks the tank that took the most auto-attacks as MT', () => {
    const taken = [
      { id: 1, total: 900 },
      { id: 2, total: 300 },
      { id: 3, total: 20 },
    ]
    expect(tankSlot(1, taken)).toBe('MT')
    expect(tankSlot(2, taken)).toBe('ST')
    expect(tankSlot(9, [])).toBe('ST')
  })
})

describe('processTimelines', () => {
  it('stores the boss casts per pull and the actions of every recorded player', async () => {
    const db = memoryDb()
    await addParse(db, 'AAA', 3, 1, 'Paladin', 2)
    await addParse(db, 'AAA', 3, 2, 'Samurai', 2)
    await addParse(db, 'BBB', 1, 7, 'Samurai', 1)
    const calls: string[] = []
    const graphql: Graphql = async <T>(query: string, variables: Record<string, unknown>) => {
      if (query.includes('rateLimitData')) return { rateLimitData: { pointsSpentThisHour: 100 } } as T
      if (query === AUTO_ATTACKS_TAKEN_QUERY) {
        calls.push(`auto ${variables.code}`)
        return { reportData: { report: { table: { data: { entries: [{ id: 1, total: 500 }, { id: 9, total: 400 }] } } } } } as T
      }
      if (query === EVENTS_QUERY) {
        calls.push(`${variables.hostilityType} ${variables.code}`)
        const data =
          variables.hostilityType === 'Enemies'
            ? [{ timestamp: 20_000, type: 'cast', abilityGameID: 500 }]
            : [
                { timestamp: 21_000, type: 'cast', sourceID: 1, abilityGameID: 20 },
                { timestamp: 22_000, type: 'cast', sourceID: 2, abilityGameID: 7499 },
              ]
        return { reportData: { report: { events: { data, nextPageTimestamp: null } } } } as T
      }
      throw new Error(`unexpected query`)
    }
    const result = await processTimelines(db, graphql, 123)
    // 前後兩次查到的點數相同：這次用掉 0 點
    expect(result).toEqual({ pulls: 2, players: 3, failed: 0, points: 0 })
    // 最近的報告先處理；有坦克的場次才查 MT／ST
    expect(calls).toEqual(['Enemies AAA', 'Friendlies AAA', 'auto AAA', 'Enemies BBB', 'Friendlies BBB'])
    const boss = await db.prepare("SELECT boss FROM pull_timelines WHERE report = 'AAA'").first<{ boss: string }>()
    expect(decodeCasts(boss!.boss)).toEqual([{ t: 10_000, abilityId: 500 }])
    const actions = (await db.prepare("SELECT actor, slot, actions FROM parse_actions WHERE report = 'AAA' ORDER BY actor").all<{ actor: number; slot: string; actions: string }>()).results
    expect(actions.map((a) => [a.actor, a.slot, decodeCasts(a.actions)])).toEqual([
      [1, 'MT', [{ t: 11_000, abilityId: 20 }]],
      [2, '', [{ t: 12_000, abilityId: 7499 }]],
    ])
    // 處理過的不再處理
    expect(await processTimelines(db, graphql, 124)).toEqual({ pulls: 0, players: 0, failed: 0 })
  })

  it('retries transient failures but gives up on reports that are gone', async () => {
    const db = memoryDb()
    await addParse(db, 'GONE', 1, 1, 'Samurai', 2)
    await addParse(db, 'BUSY', 1, 1, 'Samurai', 1)
    const graphql: Graphql = async <T>(query: string, variables: Record<string, unknown>) => {
      if (query.includes('rateLimitData')) return { rateLimitData: { pointsSpentThisHour: 0 } } as T
      throw new Error(variables.code === 'GONE' ? 'You do not have permission to view this report' : 'FFLogs API error: 502')
    }
    const warn = console.warn
    console.warn = () => {}
    expect(await processTimelines(db, graphql, 1)).toMatchObject({ pulls: 0, failed: 2 })
    console.warn = warn
    const stored = (await db.prepare('SELECT report, boss FROM pull_timelines').all<{ report: string; boss: string }>()).results
    expect(stored).toEqual([{ report: 'GONE', boss: '' }])
  })

  it('skips the run when the points for this hour are nearly used up', async () => {
    const db = memoryDb()
    await addParse(db, 'AAA', 3, 1, 'Samurai')
    const graphql: Graphql = async <T>() => ({ rateLimitData: { pointsSpentThisHour: 3000 } }) as T
    expect(await processTimelines(db, graphql)).toEqual({ skipped: 'points', pulls: 0, players: 0, failed: 0 })
  })
})

describe('storedTimelines', () => {
  it('returns the stored boss casts of processed pulls only', async () => {
    const db = memoryDb()
    await db.prepare("INSERT INTO pull_timelines VALUES ('AAA', 3, 'e8.3e8', 1), ('GONE', 1, '', 1)").run()
    const pulls = [
      { report: 'AAA', fight: 3 },
      { report: 'GONE', fight: 1 }, // 報告已不公開
      { report: 'ZZZ', fight: 9 }, // 還沒預處理
    ]
    expect(await storedTimelines(db, pulls)).toEqual({ 'AAA:3': 'e8.3e8' })
    expect(await storedTimelines(db, [])).toEqual({})
  })
})
