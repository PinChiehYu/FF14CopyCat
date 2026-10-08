import { describe, expect, it } from 'vitest'
import type { FFLogsEvent, Fight } from '../fflogs/types'
import { burstAlignment, burstPoints, enemyRaidDebuffs, raidBuffLabel, raidBuffWindows, type RaidBuffWindow } from './raidBuffs'

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

describe('burstPoints', () => {
  it('groups cooldowns pressed within one GCD into one burst', () => {
    const casts = [
      { t: 7000, abilityId: 100 },
      { t: 7600, abilityId: 101 },
      { t: 9000, abilityId: 200 }, // 不是爆發技能
      { t: 127_000, abilityId: 100 },
    ]
    expect(burstPoints(casts, (id) => id === 100 || id === 101)).toEqual([
      { t: 7000, end: 7600, abilityIds: [100, 101] },
      { t: 127_000, end: 127_000, abilityIds: [100] },
    ])
  })
})

describe('burstPoints with buff windows', () => {
  it('keeps bursts used while the own buff lasts in the same wave, like xivanalysis BuffWindow', () => {
    // 100：戰逃反應（自身效果 20 秒）；101：絕對統治（沒有附帶效果）
    const casts = [
      { t: 634_000, abilityId: 100 },
      { t: 637_000, abilityId: 101 }, // 戰逃反應期間：同一波
      { t: 660_000, abilityId: 101 }, // 效果已結束：另一波
    ]
    const buffEnd = (id: number, t: number) => (id === 100 ? t + 20_000 : undefined)
    expect(burstPoints(casts, () => true, buffEnd)).toEqual([
      { t: 634_000, end: 637_000, abilityIds: [100, 101] },
      { t: 660_000, end: 660_000, abilityIds: [101] },
    ])
    // 沒有附帶效果的：照舊只看一個 GCD 內
    expect(burstPoints(casts, () => true)).toHaveLength(3)
  })
})

describe('burstAlignment', () => {
  // 0:10 起 4 個團隊 Buff（各 20 秒）；2:10 起 4 個；4:10 只有 1 個
  const windows: RaidBuffWindow[] = [
    ...['A', 'B', 'C', 'D'].map((name, i) => ({ name, statusId: i, start: 10_000 + i * 500, end: 30_000 })),
    ...['A', 'B', 'C', 'D'].map((name, i) => ({ name, statusId: i, start: 130_000 + i * 500, end: 150_000 })),
    { name: 'A', statusId: 0, start: 250_000, end: 270_000 },
  ]

  it('counts the raid buffs active shortly after the burst against the most available nearby', () => {
    const [onTime, before, late, alone, none] = burstAlignment(
      [
        { t: 9500, end: 9500, abilityIds: [1] }, // 團隊 Buff 在 0.5～2 秒內陸續生效：算當時
        { t: 126_000, end: 126_000, abilityIds: [1] }, // 團隊 Buff 前 4 秒先開（正常打法）：算當時
        { t: 141_000, end: 141_000, abilityIds: [1] }, // 團隊 Buff 開始 11 秒後才用
        { t: 251_000, end: 251_000, abilityIds: [1] }, // 附近只有 1 個
        { t: 400_000, end: 400_000, abilityIds: [1] }, // 附近沒有團隊 Buff
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

  it('judges a long burst wave by everything it covers', () => {
    // 開場一連串爆發技能（0:05～0:08）：團隊 Buff 在 0:10 起陸續生效，最後一個技能後 5 秒內
    const [wave] = burstAlignment([{ t: 5000, end: 8000, abilityIds: [1, 2, 3] }], windows)
    expect(wave).toMatchObject({ active: 4, available: 4, aligned: true })
  })

  it('reports how early or late a missed burst was', () => {
    const [late, early] = burstAlignment(
      [
        { t: 35_000, end: 35_000, abilityIds: [1] }, // 團隊 Buff 結束後才用
        { t: 120_000, end: 120_000, abilityIds: [1] }, // 團隊 Buff 前 10 秒就用了
      ],
      windows,
    )
    expect(late).toMatchObject({ active: 0, available: 4, aligned: false, offsetMs: 25_000 })
    expect(early).toMatchObject({ active: 0, available: 4, aligned: false, offsetMs: -10_000 })
    // 團隊 Buff 在 4 秒後才陸續生效（5 秒內只到 1 個）：提早先開，算對上
    const [prepared] = burstAlignment([{ t: 126_000, end: 126_000, abilityIds: [1] }], windows.map((w, i) => (i >= 4 && i < 8 ? { ...w, start: 130_000 + (i - 4) * 3000 } : w)))
    expect(prepared).toMatchObject({ active: 1, available: 4, aligned: true, offsetMs: -4000 })
  })
})
