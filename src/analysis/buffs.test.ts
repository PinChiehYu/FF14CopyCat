import { describe, expect, it } from 'vitest'
import type { FFLogsEvent, Fight } from '../fflogs/types'
import { aurasAt, enemyDebuffWindows, hpAt, hpSamples, playerAuras, prepullEffects, selfBuffWindows } from './buffs'

const fight = { id: 1, startTime: 10_000, endTime: 70_000 } as Fight
const me = 6

describe('buffs', () => {
  const events: FFLogsEvent[] = [
    {
      timestamp: 10_000,
      type: 'combatantinfo',
      sourceID: me,
      auras: [
        { source: me, ability: 1_001_233 }, // 明鏡止水（開打前）
        { source: me, ability: 1_000_048 }, // 進食
        { source: me, ability: 1_001_084 }, // 食物效果時間延長：不顯示
        { source: 11, ability: 1_002_609 }, // 別人給的盾
      ],
    },
    { timestamp: 13_000, type: 'removebuff', sourceID: me, targetID: me, abilityGameID: 1_001_233 },
    { timestamp: 20_000, type: 'applybuff', sourceID: me, targetID: me, abilityGameID: 1_001_233 },
    { timestamp: 21_000, type: 'applybuff', sourceID: me, targetID: me, abilityGameID: 1_001_233 }, // 刷新
    { timestamp: 26_000, type: 'removebuff', sourceID: me, targetID: me, abilityGameID: 1_001_233 },
    { timestamp: 30_000, type: 'applybuff', sourceID: 8, targetID: me, abilityGameID: 1_000_125 }, // 別人給的
    { timestamp: 65_000, type: 'applybuff', sourceID: me, targetID: me, abilityGameID: 1_001_233 },
  ]

  it('lists self-applied effects present at the pull', () => {
    expect(prepullEffects(events, me)).toEqual([1_001_233, 1_000_048])
  })

  it('collects every aura on the player: own, from party members and debuffs from enemies', () => {
    const auras = playerAuras(
      [
        ...events,
        { timestamp: 35_000, type: 'removebuff', sourceID: 8, targetID: me, abilityGameID: 1_000_125 },
        { timestamp: 40_000, type: 'applydebuff', sourceID: 99, targetID: me, abilityGameID: 1_002_941 },
        { timestamp: 45_000, type: 'removedebuff', sourceID: 99, targetID: me, abilityGameID: 1_002_941 },
      ],
      fight,
      me,
    )
    // 戰鬥時間 22 秒：開打前就有的進食、隊友的盾（開打前）與隊友 8 給的 Buff（20～25 秒）
    expect(aurasAt(auras, 22_000).map((a) => [a.statusId, a.sourceId, a.debuff])).toEqual([
      [1_000_048, me, false],
      [1_002_609, 11, false],
      [1_000_125, 8, false],
    ])
    // 敵人給的 Debuff：戰鬥時間 30～35 秒
    expect(aurasAt(auras, 32_000).find((a) => a.debuff)).toMatchObject({ statusId: 1_002_941, sourceId: 99, start: 30_000, end: 35_000 })
  })

  it('reads HP samples and finds the latest one at a time', () => {
    const samples = hpSamples(
      [
        { timestamp: 12_000, type: 'damage', sourceID: 99, targetID: me, targetResources: { hitPoints: 80, maxHitPoints: 100, absorb: 5 } },
        { timestamp: 11_000, type: 'cast', sourceID: me, targetID: 99, sourceResources: { hitPoints: 100, maxHitPoints: 100 } },
      ],
      fight,
      me,
    )
    expect(samples.map((s) => [s.t, s.hp])).toEqual([
      [1000, 100],
      [2000, 80],
    ])
    expect(hpAt(samples, 1500)?.hp).toBe(100)
    expect(hpAt(samples, 500)).toBeUndefined()
  })

  it('merges debuffs the player applies to several enemies', () => {
    const debuff = 1_003_849
    const windows = enemyDebuffWindows(
      [
        { timestamp: 20_000, type: 'applydebuff', sourceID: me, targetID: 50, abilityGameID: debuff },
        { timestamp: 20_100, type: 'applydebuff', sourceID: me, targetID: 51, abilityGameID: debuff },
        { timestamp: 40_000, type: 'removedebuff', sourceID: me, targetID: 50, abilityGameID: debuff },
        { timestamp: 41_000, type: 'removedebuff', sourceID: me, targetID: 51, abilityGameID: debuff },
        { timestamp: 50_000, type: 'applydebuff', sourceID: 9, targetID: 50, abilityGameID: debuff }, // 別人施加
        { timestamp: 60_000, type: 'applydebuff', sourceID: me, targetID: 50, abilityGameID: debuff },
      ],
      fight,
      me,
    )
    expect(windows).toEqual([
      { statusId: debuff, start: 10_000, end: 31_000, prepull: false, openEnded: false },
      { statusId: debuff, start: 50_000, end: 60_000, prepull: false, openEnded: true },
    ])
  })

  it('builds self buff windows including pre-pull and open-ended ones', () => {
    const meikyo = selfBuffWindows(events, fight, me).filter((w) => w.statusId === 1_001_233)
    expect(meikyo).toEqual([
      { statusId: 1_001_233, start: 0, end: 3000, prepull: true, openEnded: false },
      { statusId: 1_001_233, start: 10_000, end: 16_000, prepull: false, openEnded: false },
      { statusId: 1_001_233, start: 55_000, end: 60_000, prepull: false, openEnded: true },
    ])
  })
})
