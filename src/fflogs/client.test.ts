import { describe, expect, it } from 'vitest'
import { fightNameParts, translateFightName } from './client'

describe('translateFightName', () => {
  const names = new Map([
    ['Howling Blade', '呼嘯之劍'],
    ['living liquid', '有生命活水'],
    ['liquid hand', '活水之手'],
  ])

  it('translates a single boss name', () => {
    expect(translateFightName('Howling Blade', names)).toBe('呼嘯之劍')
  })

  it('translates each part of a multi-NPC fight name and keeps unknown parts', () => {
    expect(fightNameParts('living liquid / liquid hand / ... ')).toEqual(['living liquid', 'liquid hand', '...'])
    expect(translateFightName('living liquid / liquid hand / Cruise Chaser', names)).toBe('有生命活水 / 活水之手 / Cruise Chaser')
  })
})
