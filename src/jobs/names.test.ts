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

let nextId = 1
const p = (name: string, subType: string) => ({ id: nextId++, name, subType })

describe('sortByPartySlot', () => {
  it('labels the tank who took more boss auto-attacks MT', () => {
    const party = [
      p('pld', 'Paladin'),
      p('war', 'Warrior'),
      p('whm', 'WhiteMage'),
      p('sch', 'Scholar'),
      p('sam', 'Samurai'),
      p('vpr', 'Viper'),
      p('brd', 'Bard'),
      p('blm', 'BlackMage'),
    ]
    const [pld, war] = party
    const load = new Map([
      [pld.id, 2_130_458],
      [war.id, 3_638_563],
    ])
    const slots = sortByPartySlot(party, load).map(({ player, slot }) => `${slot}:${player.name}`)
    expect(slots.slice(0, 2)).toEqual(['MT:war', 'ST:pld'])
    // 還沒有資料時坦克不標位置，其餘照常
    expect(sortByPartySlot(party).map(({ slot }) => slot)).toEqual([null, null, 'H1', 'H2', 'D1', 'D2', 'D3', 'D4'])
  })

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
    expect(sortByPartySlot(party, new Map()).map(({ player, slot }) => `${slot}:${player.subType}`)).toEqual([
      'MT:DarkKnight', // 沒有承傷差異時依職業繁中名稱排序（暗黑騎士 < 騎士）
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
