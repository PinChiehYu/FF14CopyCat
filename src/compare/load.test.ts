import { describe, expect, it } from 'vitest'
import type { Actor, FFLogsEvent, Fight, Report } from '../fflogs/types'
import {
  actorPositions,
  autoAttacks,
  clipSide,
  incompatibility,
  playerCasts,
  type Selection,
  type SideData,
} from './load'

describe('actorPositions', () => {
  const fight = { startTime: 1000 } as Fight
  it('reads source or target resources of the actor in yalms', () => {
    const events: FFLogsEvent[] = [
      { timestamp: 3000, type: 'damage', sourceID: 9, targetID: 6, targetResources: { x: 10500, y: 9800 } },
      { timestamp: 2000, type: 'cast', sourceID: 6, sourceResources: { x: 10000, y: 10000 } },
      { timestamp: 2000, type: 'damage', sourceID: 6, sourceResources: { x: 10000, y: 10000 } }, // 同時間重複
      { timestamp: 4000, type: 'cast', sourceID: 9, sourceResources: { x: 0, y: 0 } }, // 別人
    ]
    expect(actorPositions(events, fight, 6)).toEqual([
      { t: 1000, x: 100, y: 100 },
      { t: 2000, x: 105, y: 98 },
    ])
  })
})

describe('playerCasts', () => {
  const fight = { startTime: 1000 } as Fight
  const ev = (timestamp: number, type: string, abilityGameID: number): FFLogsEvent => ({ timestamp, type, abilityGameID })

  it('uses the begincast time for cast-bar abilities and drops interrupted casts', () => {
    const events = [
      ev(2000, 'cast', 1), // 瞬發
      ev(3000, 'begincast', 2),
      ev(4300, 'cast', 2), // 詠唱 1.3 秒
      ev(5000, 'begincast', 3), // 被打斷，沒有 cast
      ev(6000, 'cast', 4),
    ]
    expect(playerCasts(events, fight)).toEqual([
      { t: 1000, abilityId: 1 },
      { t: 2000, abilityId: 2 },
      { t: 5000, abilityId: 4 },
    ])
  })

  it('separates auto-attacks from other casts', () => {
    const events = [
      { timestamp: 2000, type: 'cast', abilityGameID: 7, sourceID: 6 }, // Attack
      { timestamp: 2500, type: 'cast', abilityGameID: 8, sourceID: 6 }, // Shot
      { timestamp: 2800, type: 'cast', abilityGameID: 7, sourceID: 9 }, // 別人的普通攻擊
      { timestamp: 3000, type: 'cast', abilityGameID: 9, sourceID: 6 },
    ]
    expect(playerCasts(events, fight, 6)).toEqual([{ t: 2000, abilityId: 9 }])
    expect(autoAttacks(events, fight, 6)).toEqual([
      { t: 1000, abilityId: 7 },
      { t: 1500, abilityId: 8 },
    ])
  })

  it('keeps only casts by the given actor', () => {
    const events = [
      { timestamp: 2000, type: 'cast', abilityGameID: 1, sourceID: 6 },
      { timestamp: 3000, type: 'cast', abilityGameID: 2, sourceID: 7 }, // 別人對玩家施放
    ]
    expect(playerCasts(events, fight, 6)).toEqual([{ t: 1000, abilityId: 1 }])
  })
})

function selection(encounterID: number, subType: string): Selection {
  const fight = { id: 1, name: `Boss ${encounterID}`, encounterID } as Fight
  const player = { id: 1, name: 'p', subType } as Actor
  return { report: {} as Report, fight, player }
}

describe('clipSide', () => {
  it('drops data after the end time', () => {
    const side: SideData = {
      selection: {} as Selection,
      playerCasts: [
        { t: 1000, abilityId: 1 },
        { t: 9000, abilityId: 1 },
      ],
      autoAttacks: [{ t: 8000, abilityId: 7 }],
      bossCasts: [{ t: 5000, abilityId: 2 }],
      playerPositions: [
        { t: 4000, x: 100, y: 100 },
        { t: 6000, x: 100, y: 100 },
      ],
      bossPositions: [],
      duration: 10_000,
    }
    const clipped = clipSide(side, 5000)
    expect(clipped.playerCasts).toEqual([{ t: 1000, abilityId: 1 }])
    expect(clipped.autoAttacks).toEqual([])
    expect(clipped.bossCasts).toHaveLength(1)
    expect(clipped.playerPositions).toHaveLength(1)
    expect(clipped.duration).toBe(5000)
  })
})

describe('incompatibility', () => {
  it('accepts same encounter and job', () => {
    expect(incompatibility(selection(98, 'Viper'), selection(98, 'Viper'))).toBeNull()
  })

  it('rejects different encounters or jobs', () => {
    expect(incompatibility(selection(98, 'Viper'), selection(99, 'Viper'))).toMatch('Boss')
    expect(incompatibility(selection(98, 'Viper'), selection(98, 'Samurai'))).toMatch('職業不同（毒蛇劍士 / 武士）')
  })
})
