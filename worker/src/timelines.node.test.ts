// Node 環境的測試（使用 node:sqlite）：由 tsconfig.node.json 檢查
import { readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import { decodeCasts, decodeWindows } from '../../src/analysis/castCodec.ts'
import type { DbLike, Graphql, StatementLike } from './crawler.ts'
import { AUTO_ATTACKS_TAKEN_QUERY, CRON_EVENTS_QUERY } from './queries.ts'
import {
  averageSamples,
  bossTimeline,
  playerCasts,
  processTimelines,
  refreshSamples,
  timelineWork,
  selectTier,
  storedTimelines,
  tankSlot,
  type Candidate,
} from './timelines.ts'

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

// 2026-09-30（繁中服 7.25）
const NOW = Date.UTC(2026, 8, 30)

async function addParse(db: DbLike, report: string, fight: number, actor: number, job: string, rdps = 20000, reportStart = NOW - 86_400_000) {
  await db
    .prepare(
      'INSERT INTO parses (report, fight, actor, encounter, difficulty, job, name, server, rdps, fight_start, fight_end, report_start) VALUES (?, ?, ?, 100, 101, ?, ?, ?, ?, 10000, 70000, ?)',
    )
    .bind(report, fight, actor, job, `p${actor}`, '泰坦', rdps, reportStart)
    .run()
  // 排名掃描收錄擊殺時同時排入預處理（crawler.ts）
  await db.prepare('INSERT OR IGNORE INTO pull_queue (report, fight, report_start) VALUES (?, ?, ?)').bind(report, fight, reportStart).run()
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

  it("keeps a player's GCDs, oGCDs and items, not auto-attacks or others' casts", () => {
    const events = [
      { timestamp: 12_000, type: 'cast', sourceID: 5, abilityGameID: 7 }, // 普通攻擊
      { timestamp: 12_500, type: 'cast', sourceID: 5, abilityGameID: 9 }, // GCD
      { timestamp: 13_000, type: 'cast', sourceID: 5, abilityGameID: 7499 }, // 能力技
      { timestamp: 13_500, type: 'cast', sourceID: 6, abilityGameID: 7499 }, // 別人
      { timestamp: 13_600, type: 'begincast', sourceID: 5, abilityGameID: 9 }, // 讀條開始不算
      { timestamp: 14_000, type: 'cast', sourceID: 5, abilityGameID: 1_049_234 }, // 道具
    ]
    expect(playerCasts(events, 10_000, 5)).toEqual([
      { t: 2500, abilityId: 9 },
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

describe('selectTier', () => {
  const candidate = (i: number, pr: number, over: Partial<Candidate> = {}): Candidate => ({
    report: `R${i}`,
    fight: 1,
    actor: i,
    name: `p${i}`,
    server: '泰坦',
    rdps: 10_000 + pr * 100 + i,
    pr,
    patch: '7.25',
    ...over,
  })
  const top: [number, number] = [95, 100]

  it('spreads new samples over the whole tier, one kill per player', () => {
    const list = Array.from({ length: 20 }, (_, i) => candidate(i, 80 + i))
    // 同一位玩家的另一場：只取一筆
    list.push(candidate(99, 99, { name: 'p19', report: 'X' }))
    const picked = selectTier(list, [], [80, 99], '7.25', 5)
    expect(picked).toHaveLength(5)
    expect(new Set(picked.map((c) => c.name)).size).toBe(5)
    // 涵蓋最高與最低
    expect(picked.map((c) => c.pr)).toContain(80)
    expect(Math.max(...picked.map((c) => c.pr))).toBe(99)
  })

  it('keeps previous samples within the buffer and only fills the gap', () => {
    const list = [candidate(1, 93), candidate(2, 96), candidate(3, 98), candidate(4, 99), candidate(5, 91)]
    const picked = selectTier(list, [list[0], list[4]], top, '7.25', 3)
    // PR 93 仍在 95 − 3 以內保留；PR 91 超出緩衝換掉；補 2 筆
    expect(picked.map((c) => c.actor)).toContain(1)
    expect(picked.map((c) => c.actor)).not.toContain(5)
    expect(picked).toHaveLength(3)
  })

  it('uses older patches only when the current patch has too few kills', () => {
    const old = Array.from({ length: 12 }, (_, i) => candidate(i, 96, { patch: '7.2' }))
    const current = Array.from({ length: 3 }, (_, i) => candidate(100 + i, 97))
    expect(selectTier([...old, ...current], [], top, '7.25', 30)).toHaveLength(15)
    const manyCurrent = Array.from({ length: 10 }, (_, i) => candidate(200 + i, 97))
    expect(selectTier([...old, ...manyCurrent], [], top, '7.25', 30).every((c) => c.patch === '7.25')).toBe(true)
  })
})

describe('refreshSamples', () => {
  it('selects samples per tier, splits tanks by MT/ST and skips excluded kills', async () => {
    const db = memoryDb()
    await addParse(db, 'AAA', 1, 1, 'Samurai', 30000)
    await addParse(db, 'BBB', 1, 2, 'Samurai', 20000)
    await addParse(db, 'CCC', 1, 3, 'Samurai', 10000)
    await addParse(db, 'AAA', 1, 4, 'Paladin', 30000)
    await addParse(db, 'BBB', 1, 5, 'Paladin', 20000)
    // 死亡的樣本排除；坦克只有判斷過 MT／ST 的才選
    await db.prepare("INSERT INTO sample_data VALUES ('CCC', 1, 3, '', '', '', 1, 1)").run()
    await db.prepare("INSERT INTO tank_slots VALUES ('AAA', 1, 4, 'MT')").run()
    expect(await refreshSamples(db, NOW, 4)).toBe(2)
    const rows = (await db.prepare('SELECT job, slot, tier, actor FROM average_samples ORDER BY job, actor').all<{ job: string; slot: string; tier: string; actor: number }>()).results
    // 武士：3 人 PR 100／50／0 → 100 在 top、50 在 mid（0 分以下不選），死亡的 CCC 排除
    expect(rows).toEqual([
      { job: 'Paladin', slot: 'MT', tier: 'top', actor: 4 },
      { job: 'Samurai', slot: '', tier: 'top', actor: 1 },
      { job: 'Samurai', slot: '', tier: 'mid', actor: 2 },
    ])
    const tiers = (await db.prepare("SELECT slot, tier, candidates FROM sample_tiers WHERE job = 'Samurai' ORDER BY tier").all()).results
    expect(tiers).toEqual([
      { slot: '', tier: 'mid', candidates: 1 },
      { slot: '', tier: 'top', candidates: 1 },
      { slot: '', tier: 'upper', candidates: 0 },
    ])
  })

  it('drops the stored data of kills that are no longer samples but keeps the death markers', async () => {
    const db = memoryDb()
    await addParse(db, 'AAA', 1, 1, 'Samurai')
    // 之前選的 OLD 已不在排名中（被換掉）；DIED 有死亡，留著當記號
    await db
      .prepare(
        "INSERT INTO average_samples VALUES (100, 101, 'Samurai', '', 'top', 'OLD', 1, 9, 'p9', '泰坦', 1, 99, '7.25', 1, 0), (100, 101, 'Samurai', '', 'top', 'DIED', 1, 8, 'p8', '泰坦', 1, 99, '7.25', 1, 0)",
      )
      .run()
    await db.prepare("INSERT INTO sample_data VALUES ('OLD', 1, 9, 'x', '', '', 0, 1), ('DIED', 1, 8, '', '', '', 2, 1)").run()
    await refreshSamples(db, NOW)
    const left = (await db.prepare('SELECT report FROM sample_data ORDER BY report').all<{ report: string }>()).results
    expect(left).toEqual([{ report: 'DIED' }])
    expect((await db.prepare('SELECT report, pending FROM average_samples').all()).results).toEqual([{ report: 'AAA', pending: 1 }])
  })

  it('only selects samples for the current raid tier', async () => {
    const db = memoryDb()
    // 掃到的報告中也有舊副本（編號較小、排在前面）的擊殺
    await db
      .prepare(
        "INSERT INTO parses (report, fight, actor, encounter, difficulty, job, name, server, rdps, fight_start, fight_end, report_start) VALUES ('OLD', 1, 1, 80, 101, 'Bard', 'p1', '泰坦', 30000, 0, 60000, 0)",
      )
      .run()
    await addParse(db, 'NEW', 1, 2, 'Samurai', 30000)
    expect(await refreshSamples(db, NOW, 4)).toBe(1)
    expect((await db.prepare('SELECT DISTINCT encounter FROM sample_tiers').all()).results).toEqual([{ encounter: 100 }])
  })

  it('only rewrites samples that changed and rotates through the combos', async () => {
    const db = memoryDb()
    await addParse(db, 'AAA', 1, 1, 'Samurai', 30000)
    await addParse(db, 'BBB', 1, 2, 'Bard', 30000)
    await addParse(db, 'CCC', 1, 3, 'Ninja', 30000)
    // 依 Boss×職業的順序輪替，最後繞回第一組
    const cursor = async () => (await db.prepare("SELECT value FROM crawl_state WHERE key = 'samples_cursor'").first<{ value: string }>())?.value
    expect(await refreshSamples(db, NOW, 1)).toBe(1)
    expect(await cursor()).toBe('[100,101,"Bard"]')
    await refreshSamples(db, NOW + 1, 2)
    expect(await cursor()).toBe('[100,101,"Samurai"]')
    await refreshSamples(db, NOW + 2, 1)
    expect(await cursor()).toBe('[100,101,"Bard"]')
    // 組數比每次的上限少：每組只處理一次
    expect(await refreshSamples(db, NOW + 3, 10)).toBe(3)
    // 樣本沒變：不重寫（選取與更新時間維持第一次選的）
    const bard = await db.prepare("SELECT selected_at FROM average_samples WHERE job = 'Bard'").first<{ selected_at: number }>()
    expect(bard?.selected_at).toBe(NOW)
    const tier = await db.prepare("SELECT updated_at FROM sample_tiers WHERE job = 'Bard' AND tier = 'top'").first<{ updated_at: number }>()
    expect(tier?.updated_at).toBe(NOW)
    // 新選的樣本：該場排到預處理佇列的最前面
    expect((await db.prepare('SELECT report, priority FROM pull_queue ORDER BY report').all()).results).toEqual([
      { report: 'AAA', priority: 1 },
      { report: 'BBB', priority: 1 },
      { report: 'CCC', priority: 1 },
    ])
  })
})

describe('processTimelines', () => {
  it('stores samples first, then boss casts and tank slots of new pulls (pulls with samples first)', async () => {
    const db = memoryDb()
    await addParse(db, 'NEW', 1, 1, 'Paladin', 30000, NOW - 1000)
    await addParse(db, 'OLD', 3, 2, 'Samurai', 30000, NOW - 86_400_000)
    const calls: string[] = []
    const filters = new Set<string>()
    const graphql: Graphql = async <T>(query: string, variables: Record<string, unknown>) => {
      if (query.includes('rateLimitData')) return { rateLimitData: { pointsSpentThisHour: 100 } } as T
      if (query === AUTO_ATTACKS_TAKEN_QUERY) {
        calls.push(`auto ${variables.code}`)
        return { reportData: { report: { table: { data: { entries: [{ id: 1, total: 500 }, { id: 9, total: 400 }] } } } } } as T
      }
      if (query === CRON_EVENTS_QUERY) {
        calls.push(variables.sourceID ? `All ${variables.code}/${variables.sourceID}` : `${variables.hostilityType} ${variables.code}`)
        // 只取需要的事件類型（不含傷害與治療）
        filters.add(String(variables.filterExpression))
        const data =
          variables.hostilityType === 'Enemies'
            ? [{ timestamp: 20_000, type: 'cast', abilityGameID: 500 }]
            : [
                { timestamp: 21_000, type: 'cast', sourceID: 2, abilityGameID: 7477 },
                { timestamp: 22_000, type: 'applybuff', sourceID: 2, targetID: 2, abilityGameID: 1_001_233 },
                { timestamp: 30_000, type: 'removebuff', sourceID: 2, targetID: 2, abilityGameID: 1_001_233 },
              ]
        return { reportData: { report: { events: { data, nextPageTimestamp: null } } } } as T
      }
      throw new Error('unexpected query')
    }
    const result = await processTimelines(db, graphql, NOW, { combos: 4, samples: 2, pulls: 3 })
    expect([...filters].sort()).toEqual([
      "type = 'cast'",
      "type in ('cast', 'combatantinfo', 'applybuff', 'removebuff', 'applydebuff', 'removedebuff', 'refreshdebuff', 'death')",
    ])
    // 選樣本：武士 OLD/3/2 在 top；騎士還沒判斷 MT／ST，這次不選
    expect(result).toEqual({ selected: 2, pulls: 2, samples: 1, failed: 0, hourPoints: 100 })
    // 樣本先處理；新場次中含樣本的（OLD）優先於較新的報告（NEW）
    expect(calls).toEqual(['All OLD/2', 'Enemies OLD', 'Enemies NEW', 'auto NEW'])
    const sample = await db.prepare('SELECT casts, buffs, deaths FROM sample_data').first<{ casts: string; buffs: string; deaths: number }>()
    expect(decodeCasts(sample!.casts)).toEqual([{ t: 11_000, abilityId: 7477 }])
    expect(decodeWindows(sample!.buffs)).toEqual([{ statusId: 1_001_233, start: 12_000, end: 20_000, prepull: false, openEnded: false }])
    expect(sample!.deaths).toBe(0)
    const slot = await db.prepare("SELECT slot FROM tank_slots WHERE report = 'NEW'").first<{ slot: string }>()
    expect(slot?.slot).toBe('MT')
    // 處理完的場次移出佇列、樣本不再列為待處理
    expect(await db.prepare('SELECT COUNT(*) AS n FROM pull_queue').first()).toEqual({ n: 0 })
    expect(await db.prepare('SELECT pending FROM average_samples').first()).toEqual({ pending: 0 })
    // 讀取：樣本已預處理、該場有 Boss 施放
    const read = await averageSamples(db, { encounter: 100, difficulty: 101, job: 'Samurai', slot: '', tier: 'top' })
    expect(read.count).toBe(1)
    expect(read.updatedAt).toBe(NOW)
    expect(read.samples.map((s) => [s.name, s.pr, s.duration, decodeCasts(s.boss)])).toEqual([['p2', 100, 60_000, [{ t: 10_000, abilityId: 500 }]]])
  })

  it('marks samples with deaths as excluded and keeps nothing else for them', async () => {
    const db = memoryDb()
    await addParse(db, 'AAA', 1, 2, 'Samurai')
    const graphql: Graphql = async <T>(query: string, variables: Record<string, unknown>) => {
      if (query.includes('rateLimitData')) return { rateLimitData: { pointsSpentThisHour: 0 } } as T
      const data = variables.sourceID
        ? [
            { timestamp: 21_000, type: 'cast', sourceID: 2, abilityGameID: 7477 },
            { timestamp: 40_000, type: 'death', sourceID: 50, targetID: 2 },
          ]
        : []
      if (query === CRON_EVENTS_QUERY) return { reportData: { report: { events: { data, nextPageTimestamp: null } } } } as T
      throw new Error('unexpected query')
    }
    await processTimelines(db, graphql, NOW)
    expect(await db.prepare('SELECT casts, buffs, deaths FROM sample_data').first()).toEqual({ casts: '', buffs: '', deaths: 1 })
    expect((await averageSamples(db, { encounter: 100, difficulty: 101, job: 'Samurai', slot: '', tier: 'top' })).samples).toEqual([])
    // 下次選樣本時排除
    await refreshSamples(db, NOW + 1)
    expect(await db.prepare('SELECT COUNT(*) AS n FROM average_samples').first()).toEqual({ n: 0 })
  })

  it('retries transient failures but gives up on reports that are gone', async () => {
    const db = memoryDb()
    await addParse(db, 'GONE', 1, 1, 'Samurai', 30000, NOW - 1000)
    await addParse(db, 'BUSY', 1, 2, 'Samurai', 10000, NOW - 2000)
    const graphql: Graphql = async <T>(query: string, variables: Record<string, unknown>) => {
      if (query.includes('rateLimitData')) return { rateLimitData: { pointsSpentThisHour: 0 } } as T
      throw new Error(variables.code === 'GONE' ? 'You do not have permission to view this report' : 'FFLogs API error: 502')
    }
    const warn = console.warn
    console.warn = () => {}
    expect(await processTimelines(db, graphql, NOW)).toMatchObject({ pulls: 0, samples: 0 })
    console.warn = warn
    const stored = (await db.prepare('SELECT report, boss FROM pull_timelines').all<{ report: string; boss: string }>()).results
    expect(stored).toEqual([{ report: 'GONE', boss: '' }])
    expect(await db.prepare("SELECT deaths FROM sample_data WHERE report = 'GONE'").first()).toEqual({ deaths: -1 })
  })

  it('skips the run when the points for this hour are nearly used up', async () => {
    const db = memoryDb()
    await addParse(db, 'AAA', 3, 1, 'Samurai')
    const graphql: Graphql = async <T>() => ({ rateLimitData: { pointsSpentThisHour: 3000 } }) as T
    expect(await processTimelines(db, graphql, NOW, { combos: 0, samples: 2, pulls: 3 })).toEqual({ skipped: 'points', selected: 0, pulls: 0, samples: 0, failed: 0, hourPoints: 3000 })
  })

  it('does not store a sample when the query returns no casts of the player', async () => {
    const db = memoryDb()
    await addParse(db, 'AAA', 3, 2, 'Samurai')
    const graphql: Graphql = async <T>(query: string) => {
      if (query.includes('rateLimitData')) return { rateLimitData: { pointsSpentThisHour: 0 } } as T
      return { reportData: { report: { events: { data: [], nextPageTimestamp: null } } } } as T
    }
    const warn = console.warn
    console.warn = () => {}
    expect(await processTimelines(db, graphql, NOW, { combos: 1, samples: 1, pulls: 0 })).toMatchObject({ samples: 0, failed: 1 })
    console.warn = warn
    // 沒有寫入，樣本仍待處理
    expect(await db.prepare('SELECT COUNT(*) AS n FROM sample_data').first()).toEqual({ n: 0 })
    expect(await db.prepare('SELECT pending FROM average_samples').first()).toEqual({ pending: 1 })
  })

  it('splits the work: selecting samples every 10 minutes, processing otherwise', async () => {
    expect(timelineWork(0)).toEqual({ combos: 1, samples: 0, pulls: 0 })
    expect(timelineWork(12)).toEqual({ combos: 0, samples: 1, pulls: 2 })
    // 只選樣本的那次不查 FFLogs
    const db = memoryDb()
    await addParse(db, 'AAA', 3, 1, 'Samurai')
    const graphql: Graphql = async () => {
      throw new Error('unexpected query')
    }
    expect(await processTimelines(db, graphql, NOW, timelineWork(10))).toEqual({ selected: 1, pulls: 0, samples: 0, failed: 0 })
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
