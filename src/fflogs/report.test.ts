import { describe, expect, it } from 'vitest'
import { isStatusId, playersInFight } from './report'
import type { Actor, Fight, Report } from './types'

function actor(id: number, name: string, subType: string, type = 'Player'): Actor {
  return { id, name, type, subType, server: null, petOwner: null, gameID: 0 }
}

const fight: Fight = {
  id: 13,
  name: 'Brute Abombinator',
  encounterID: 0,
  difficulty: 101,
  kill: true,
  startTime: 0,
  endTime: 1,
  friendlyPlayers: [2, 10, 34, 46],
}

const report: Report = {
  code: 'x',
  title: 'x',
  startTime: 0,
  endTime: 1,
  fights: [fight],
  masterData: {
    actors: [
      actor(2, '死魚眼', 'BlackMage'),
      actor(10, 'Multiple Players', 'LimitBreak'),
      actor(34, 'Risen', 'Viper'),
      actor(46, 'Limit Break', 'LimitBreak'),
      actor(47, '冽寒銀雪', 'Viper'), // 不在這場戰鬥
      actor(66, 'Boss', 'Boss', 'NPC'),
    ],
    abilities: [],
  },
}

describe('playersInFight', () => {
  it('returns real players in the fight, excluding limit break pseudo-actors', () => {
    expect(playersInFight(report, fight).map((a) => a.id)).toEqual([2, 34])
  })
})

describe('isStatusId', () => {
  it('matches status IDs only', () => {
    expect(isStatusId(1_001_233)).toBe(true) // 明鏡止水
    expect(isStatusId(7499)).toBe(false) // 技能
    expect(isStatusId(0x2000000 + 44162)).toBe(false) // 道具
  })
})