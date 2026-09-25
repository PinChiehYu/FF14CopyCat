import { describe, expect, it } from 'vitest'
import { getJob } from './index'
import { abilityCategory } from './roleActions'

describe('paladin', () => {
  const paladin = getJob('Paladin')!

  it('classifies GCDs seen in real logs', () => {
    // Fast Blade、Riot Blade、Royal Authority、Atonement 系列、Holy Spirit、Confiteor 系列、Goring Blade
    for (const id of [9, 15, 3539, 16460, 36918, 36919, 7384, 16459, 25748, 25749, 25750, 3538]) {
      expect(paladin.isGcd(id), String(id)).toBe(true)
    }
  })

  it('ignores provoke, shirk and stance toggles but keeps mitigation', () => {
    expect(abilityCategory(7533, paladin)).toBe('ignored') // Provoke
    expect(abilityCategory(7537, paladin)).toBe('ignored') // Shirk
    expect(abilityCategory(28, paladin)).toBe('ignored') // Iron Will
    expect(abilityCategory(32065, paladin)).toBe('ignored') // Release Iron Will
    expect(abilityCategory(38, paladin)).toBe('normal') // Berserk（戰士），不是騎士的技能
    expect(abilityCategory(36920, paladin)).toBe('mitigation') // Guardian
    expect(abilityCategory(7531, paladin)).toBe('mitigation') // Rampart
    expect(abilityCategory(3541, paladin)).toBe('utility') // Clemency
  })

  it('classifies oGCDs seen in real logs', () => {
    // Fight or Flight、Circle of Scorn、Expiacion、Intervene、Imperator、Blade of Honor、Holy Sheltron、Guardian、藥水
    for (const id of [20, 23, 25747, 16461, 36921, 36922, 25746, 36920, 34600427]) {
      expect(paladin.isGcd(id), String(id)).toBe(false)
    }
  })
})
