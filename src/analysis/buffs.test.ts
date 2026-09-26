import { describe, expect, it } from 'vitest'
import type { FFLogsEvent, Fight } from '../fflogs/types'
import { prepullEffects, selfBuffWindows } from './buffs'

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

  it('builds self buff windows including pre-pull and open-ended ones', () => {
    const meikyo = selfBuffWindows(events, fight, me).filter((w) => w.statusId === 1_001_233)
    expect(meikyo).toEqual([
      { statusId: 1_001_233, start: 0, end: 3000, prepull: true, openEnded: false },
      { statusId: 1_001_233, start: 10_000, end: 16_000, prepull: false, openEnded: false },
      { statusId: 1_001_233, start: 55_000, end: 60_000, prepull: false, openEnded: true },
    ])
  })
})
