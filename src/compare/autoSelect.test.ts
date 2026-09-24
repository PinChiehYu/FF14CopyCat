import { describe, expect, it } from 'vitest'
import type { Actor, Fight, Report } from '../fflogs/types'
import { resolveSelection, type Overrides } from './autoSelect'

function fight(id: number, encounterID: number, kill: boolean, players: number[]): Fight {
  return { id, name: `E${encounterID}`, encounterID, difficulty: 101, kill, startTime: 0, endTime: 1, friendlyPlayers: players }
}

function player(id: number, subType: string): Actor {
  return { id, name: `p${id}`, type: 'Player', subType, server: null, petOwner: null, gameID: 0 }
}

const report: Report = {
  code: 'x',
  title: 'x',
  startTime: 0,
  endTime: 1,
  fights: [
    fight(1, 100, false, [1, 2, 3]),
    fight(2, 100, true, [1, 2, 3]), // Howling Blade 擊殺：一位武士
    fight(3, 100, false, [1, 2, 3]),
    fight(4, 97, true, [1, 2, 3, 4]), // Dancing Green 擊殺：兩位蝰蛇
    fight(5, 98, true, [1, 2]),
  ],
  masterData: {
    actors: [player(1, 'Samurai'), player(2, 'Viper'), player(3, 'Paladin'), player(4, 'Viper')],
    abilities: [],
  },
}

const none: Overrides = { fightId: null, playerId: null }

describe('resolveSelection', () => {
  it('without preference: URL fight/source, else last fight and no player', () => {
    expect(resolveSelection(report, { reportCode: 'x' }, none)).toMatchObject({ fight: { id: 5 }, player: undefined })
    expect(resolveSelection(report, { reportCode: 'x', fight: 2, sourceId: 3 }, none)).toMatchObject({
      fight: { id: 2 },
      player: { id: 3 },
    })
  })

  it('picks the last kill of the same encounter and the only same-job player', () => {
    const r = resolveSelection(report, { reportCode: 'x' }, none, { encounterID: 100, subType: 'Samurai' })
    expect(r).toMatchObject({ fight: { id: 2 }, player: { id: 1 }, note: null })
  })

  it('does not pick a player when two share the job', () => {
    const r = resolveSelection(report, { reportCode: 'x' }, none, { encounterID: 97, subType: 'Viper' })
    expect(r.fight?.id).toBe(4)
    expect(r.player).toBeUndefined()
    expect(r.note).toMatch('2 位 Viper')
  })

  it('explains when the job is absent', () => {
    const r = resolveSelection(report, { reportCode: 'x' }, none, { encounterID: 97, subType: 'Samurai' })
    expect(r.fight?.id).toBe(4)
    expect(r.player?.id).toBe(1)

    const absent = resolveSelection(report, { reportCode: 'x' }, none, { encounterID: 98, subType: 'Paladin' })
    expect(absent.player).toBeUndefined()
    expect(absent.note).toMatch('沒有 Paladin')
  })

  it('respects URL and manual choices over the preference', () => {
    const pref = { encounterID: 100, subType: 'Samurai' }
    expect(resolveSelection(report, { reportCode: 'x', fight: 5, sourceId: 2 }, none, pref)).toMatchObject({
      fight: { id: 5 },
      player: { id: 2 },
    })
    expect(resolveSelection(report, { reportCode: 'x' }, { fightId: 3, playerId: 3 }, pref)).toMatchObject({
      fight: { id: 3 },
      player: { id: 3 },
    })
  })

  it('falls back to the last fight when the encounter is missing', () => {
    const r = resolveSelection(report, { reportCode: 'x' }, none, { encounterID: 999, subType: 'Samurai' })
    expect(r.fight?.id).toBe(5)
  })
})
