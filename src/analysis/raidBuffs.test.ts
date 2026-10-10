import { describe, expect, it } from 'vitest'
import type { FFLogsEvent, Fight } from '../fflogs/types'
import { burstAlignment, burstPoints, enemyRaidDebuffs, raidBuffAction, raidBuffLabel, raidBuffWindows, type RaidBuffWindow } from './raidBuffs'

const names: Record<number, string> = {
  1: 'Battle Litany',
  2: 'Divination',
  3: 'Embolden', // 赤魔自己
  4: 'Embolden', // 隊友
  5: 'Chain Stratagem',
  9: 'Medicated', // 不是團隊 Buff
}
const englishName = (id: number) => names[id]

describe('raidBuffWindows', () => {
  it('merges raid buffs by name and ignores other effects', () => {
    const windows = raidBuffWindows(
      [
        { statusId: 1, start: 10_000, end: 30_000 },
        { statusId: 3, start: 12_000, end: 32_000 },
        { statusId: 4, start: 13_000, end: 33_000 },
        { statusId: 9, start: 10_000, end: 40_000 },
      ],
      [{ statusId: 5, start: 11_000, end: 31_000 }],
      englishName,
    )
    expect(windows).toEqual([
      { name: 'Battle Litany', statusId: 1, start: 10_000, end: 30_000 },
      { name: 'Chain Stratagem', statusId: 5, start: 11_000, end: 31_000 },
      { name: 'Embolden', statusId: 3, start: 12_000, end: 33_000 },
    ])
    // 顯示名稱以效果 ID 查繁中名稱，查不到時沿用英文
    const label = raidBuffLabel(windows, (id) => ({ 1: '戰鬥連禱', 3: '鼓勵' })[id])
    expect(['Battle Litany', 'Embolden', 'Chain Stratagem'].map(label)).toEqual(['戰鬥連禱', '鼓勵', 'Chain Stratagem'])
  })
})

describe('enemyRaidDebuffs', () => {
  it('builds debuff spans on enemies from apply/remove events', () => {
    const fight = { startTime: 1000, endTime: 101_000 } as Fight
    const ev = (timestamp: number, type: string, targetID: number) => ({ timestamp, type, abilityGameID: 5, targetID }) as FFLogsEvent
    expect(enemyRaidDebuffs([ev(11_000, 'applydebuff', 50), ev(31_000, 'removedebuff', 50), ev(91_000, 'applydebuff', 51)], fight)).toEqual([
      { statusId: 5, start: 10_000, end: 30_000 },
      { statusId: 5, start: 90_000, end: 100_000 },
    ])
  })
})

describe('raidBuffWindows with my own raid buffs', () => {
  it('keeps the raid buffs I gave apart from the party ones', () => {
    const windows = raidBuffWindows(
      [
        { statusId: 1, start: 10_000, end: 30_000, sourceId: 7 }, // 我自己的戰鬥連禱
        { statusId: 2, start: 11_000, end: 31_000, sourceId: 8 }, // 隊友的占卜
      ],
      [{ statusId: 5, start: 12_000, end: 32_000, sourceId: 7 }], // 我給敵人的連環計
      englishName,
      7,
    )
    expect(windows).toEqual([
      { name: 'Battle Litany', statusId: 1, start: 10_000, end: 30_000, self: true },
      { name: 'Divination', statusId: 2, start: 11_000, end: 31_000 },
      { name: 'Chain Stratagem', statusId: 5, start: 12_000, end: 32_000, self: true },
    ])
  })
})

describe('burstPoints', () => {
  it('groups burst skills used within 15 seconds into one wave', () => {
    // 機工士：槍管加熱→10 秒後迴轉飛鋸→5 秒後野火是同一波；60 秒後的下一次另一波
    const casts = [
      { t: 100_000, abilityId: 100 },
      { t: 110_000, abilityId: 101 },
      { t: 112_000, abilityId: 200 }, // 不是爆發技能
      { t: 115_000, abilityId: 102 },
      { t: 175_000, abilityId: 100 },
    ]
    expect(burstPoints(casts, (id) => id !== 200)).toEqual([
      { t: 100_000, start: 100_000, end: 115_000, abilityIds: [100, 101, 102], periodMs: 60_000 },
      { t: 175_000, start: 175_000, end: 175_000, abilityIds: [100], periodMs: 60_000 },
    ])
  })

  it('keeps bursts used while the own buff lasts in the same wave, like xivanalysis BuffWindow', () => {
    // 100：戰逃反應（自身效果 30 秒）；101：絕對統治（沒有附帶效果）
    const casts = [
      { t: 634_000, abilityId: 100 },
      { t: 637_000, abilityId: 101 }, // 15 秒內：同一波
      { t: 660_000, abilityId: 101 }, // 26 秒後，但仍在戰逃反應期間：同一波
    ]
    const buffEnd = (id: number, t: number) => (id === 100 ? t + 30_000 : undefined)
    expect(burstPoints(casts, () => true, buffEnd)).toHaveLength(1)
    // 沒有附帶效果的：只看 15 秒內
    expect(burstPoints(casts, () => true)).toHaveLength(2)
  })

  it('takes the longest period in the wave and judges a status-granting skill by the skill used after it', () => {
    // 蝰蛇：蛇靈氣（120 秒，給祖靈降臨預備）12 秒後用祖靈降臨；第二次沒用到祖靈降臨
    const casts = [
      { t: 120_000, abilityId: 34647 },
      { t: 240_000, abilityId: 34647 },
    ]
    const reawaken = new Map([[120_000, 132_000]])
    const points = burstPoints(casts, () => true, undefined, { periodOf: () => 120_000, alignTime: (_, t) => reawaken.get(t) })
    expect(points).toEqual([
      { t: 132_000, start: 120_000, end: 132_000, abilityIds: [34647], periodMs: 120_000 },
      { t: 240_000, start: 240_000, end: 240_000, abilityIds: [34647], periodMs: 120_000 },
    ])
  })
})

describe('burstAlignment', () => {
  // 0:10 起 4 個團隊 Buff（各 20 秒）；2:10 起 4 個；4:10 只有 1 個
  const windows: RaidBuffWindow[] = [
    ...['A', 'B', 'C', 'D'].map((name, i) => ({ name, statusId: i, start: 10_000 + i * 500, end: 30_000 })),
    ...['A', 'B', 'C', 'D'].map((name, i) => ({ name, statusId: i, start: 130_000 + i * 500, end: 150_000 })),
    { name: 'A', statusId: 0, start: 250_000, end: 270_000 },
  ]
  // 一波：判斷時間 t、第一個技能 start（預設與 t 相同）、最後一個技能 end、週期
  const wave = (t: number, { end = t, start = t, periodMs = 60_000 }: { end?: number; start?: number; periodMs?: number } = {}) => ({
    t,
    start,
    end,
    abilityIds: [1],
    periodMs,
  })

  it('counts the raid buffs active shortly after the burst against the most available nearby', () => {
    const [onTime, before, late, alone, none] = burstAlignment(
      [
        wave(9500), // 團隊 Buff 在 0.5～2 秒內陸續生效：算當時
        wave(126_000), // 團隊 Buff 前 4 秒先開（正常打法）：算當時
        wave(141_000), // 團隊 Buff 開始 11 秒後才用
        wave(251_000), // 附近只有 1 個
        wave(400_000), // 1 分鐘爆發、附近沒有團隊 Buff：不評
      ],
      windows,
    )
    expect(onTime).toMatchObject({ active: 4, available: 4, aligned: true, offsetMs: null })
    expect(before).toMatchObject({ active: 3, available: 4, aligned: true, offsetMs: -4000 })
    // 晚用但仍在團隊 Buff 內：照樣對上
    expect(late).toMatchObject({ active: 4, available: 4, aligned: true })
    expect(alone).toMatchObject({ active: 1, available: 1, aligned: true })
    expect(none).toMatchObject({ active: 0, available: 0, aligned: null })
  })

  it('judges a wave by everything it covers, so preparation a few seconds early is fine', () => {
    // 開場一連串爆發技能（0:05～0:08）：團隊 Buff 在 0:10 起陸續生效
    const [opener] = burstAlignment([wave(5000, { end: 8000 })], windows)
    expect(opener).toMatchObject({ active: 4, available: 4, aligned: true })
    // 武士：必殺劍・紅蓮在團隊 Buff 前 5.2 秒、意氣衝天 7 秒後（同一波）：整波內團隊 Buff 開始，算對上
    const [samurai] = burstAlignment([wave(124_800, { end: 131_800 })], windows)
    expect(samurai).toMatchObject({ active: 4, aligned: true })
  })

  it('rates every two-minute burst, looking 60 seconds around for the raid buffs it should have met', () => {
    // 團隊 Buff 35 秒後才開始：2 分鐘爆發照樣評分、判早；1 分鐘爆發附近（20 秒）沒有，不評
    const [twoMinute] = burstAlignment([wave(95_000, { periodMs: 120_000 })], windows)
    expect(twoMinute).toMatchObject({ active: 0, available: 4, aligned: false, offsetMs: -35_000 })
    const [oneMinute] = burstAlignment([wave(95_000)], windows)
    expect(oneMinute).toMatchObject({ aligned: null })
  })

  it('ignores the raid buffs I gave myself', () => {
    const own: RaidBuffWindow[] = [{ name: 'A', statusId: 0, start: 10_000, end: 30_000, self: true }]
    // 只有自己的團隊 Buff：沒有隊友的可以對，不評
    expect(burstAlignment([wave(10_000, { periodMs: 120_000 })], own)[0]).toMatchObject({ active: 0, available: 0, aligned: null })
    // 加上隊友的：只算隊友的
    const [withParty] = burstAlignment([wave(10_000, { periodMs: 120_000 })], [...own, { name: 'B', statusId: 1, start: 11_000, end: 31_000 }])
    expect(withParty).toMatchObject({ active: 1, available: 1, aligned: true, activeNames: ['B'] })
  })

  it('reports how early or late a missed burst was', () => {
    const [late, early] = burstAlignment([wave(35_000), wave(120_000)], windows)
    // 團隊 Buff 結束 5 秒後才用、團隊 Buff 前 10 秒就用了
    expect(late).toMatchObject({ active: 0, available: 4, aligned: false, offsetMs: 25_000, missedNames: ['A', 'B', 'C', 'D'] })
    expect(early).toMatchObject({ active: 0, available: 4, aligned: false, offsetMs: -10_000 })
    // 團隊 Buff 在 4 秒後才陸續生效（5 秒內只到 1 個）：提早先開，算對上
    const [prepared] = burstAlignment([wave(126_000)], windows.map((w, i) => (i >= 4 && i < 8 ? { ...w, start: 130_000 + (i - 4) * 3000 } : w)))
    expect(prepared).toMatchObject({ active: 1, available: 4, aligned: true, offsetMs: -4000, activeNames: ['A'], missedNames: ['B', 'C', 'D'] })
  })
})

describe('raidBuffAction', () => {
  it('finds the action of each raid buff by English name, skipping statuses', () => {
    const ability = (gameID: number, name: string, englishName?: string) => [gameID, { gameID, name, englishName }] as const
    const action = raidBuffAction(
      new Map([
        ability(1_000_786, '戰鬥連禱', 'Battle Litany'), // 效果
        ability(3557, '戰鬥連禱', 'Battle Litany'),
        ability(33218, 'Quadruple Technical Finish'),
        ability(16196, '四色技巧舞步結束', 'Quadruple Technical Finish'),
        ability(1_001_182, 'Meditative Brotherhood'),
      ]),
    )
    expect(action('Battle Litany')?.gameID).toBe(3557)
    // 技能名稱與效果不同：取以效果名稱結尾、ID 最小的
    expect(action('Technical Finish')?.gameID).toBe(16196)
    expect(action('Brotherhood')).toBeUndefined()
  })
})
