import { describe, expect, it } from 'vitest'
import { getJob } from './index'
import { jobName, sortByPartySlot } from './names'

describe('jobName', () => {
  it('translates FFLogs subTypes to official Traditional Chinese names', () => {
    expect(jobName('BlackMage')).toBe('黑魔道士')
    expect(jobName('Viper')).toBe('毒蛇劍士')
    expect(jobName('DarkKnight')).toBe('暗黑騎士')
  })

  it('keeps unknown subTypes', () => {
    expect(jobName('LimitBreak')).toBe('LimitBreak')
  })

  it('uses the same names in job modules', () => {
    for (const subType of ['Viper', 'Samurai', 'Paladin', 'BlackMage']) {
      expect(getJob(subType)?.name).toBe(jobName(subType))
    }
  })
})

const p = (name: string, subType: string) => ({ name, subType })

describe('sortByPartySlot', () => {
  it('orders a standard party MT/ST/H1/H2/D1-D4', () => {
    const party = [
      p('a', 'BlackMage'),
      p('b', 'DarkKnight'),
      p('c', 'Bard'),
      p('d', 'WhiteMage'),
      p('e', 'Scholar'),
      p('f', 'Viper'),
      p('g', 'Paladin'),
      p('h', 'Dragoon'),
    ]
    expect(sortByPartySlot(party).map(({ player, slot }) => `${slot}:${player.subType}`)).toEqual([
      'MT:DarkKnight', // 同組依職業繁中名稱排序（暗黑騎士 < 騎士）
      'ST:Paladin',
      'H1:WhiteMage',
      'H2:Scholar',
      'D1:Viper',
      'D2:Dragoon',
      'D3:Bard',
      'D4:BlackMage',
    ])
  })

  it('sorts without slot labels for a non-standard party', () => {
    const result = sortByPartySlot([p('a', 'BlackMage'), p('b', 'Samurai'), p('c', 'Warrior')])
    expect(result.map(({ player, slot }) => [player.subType, slot])).toEqual([
      ['Warrior', null],
      ['Samurai', null],
      ['BlackMage', null],
    ])
  })
})
