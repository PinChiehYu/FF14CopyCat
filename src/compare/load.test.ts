import { describe, expect, it } from 'vitest'
import type { Actor, FFLogsEvent, Fight, Report } from '../fflogs/types'
import { incompatibility, playerCasts, type Selection } from './load'

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
})

function selection(encounterID: number, subType: string): Selection {
  const fight = { id: 1, name: `Boss ${encounterID}`, encounterID } as Fight
  const player = { id: 1, name: 'p', subType } as Actor
  return { report: {} as Report, fight, player }
}

describe('incompatibility', () => {
  it('accepts same encounter and job', () => {
    expect(incompatibility(selection(98, 'Viper'), selection(98, 'Viper'))).toBeNull()
  })

  it('rejects different encounters or jobs', () => {
    expect(incompatibility(selection(98, 'Viper'), selection(99, 'Viper'))).toMatch('Boss')
    expect(incompatibility(selection(98, 'Viper'), selection(98, 'Samurai'))).toMatch('職業')
  })
})
