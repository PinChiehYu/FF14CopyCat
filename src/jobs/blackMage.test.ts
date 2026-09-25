import { describe, expect, it } from 'vitest'
import { getJob } from './index'
import { abilityCategory } from './roleActions'

describe('blackMage', () => {
  const blm = getJob('BlackMage')!

  it('classifies GCDs seen in real logs', () => {
    // Fire III、Blizzard III、Blizzard IV、Fire IV、Despair、Umbral Soul、Xenoglossy、Paradox、High Thunder、Flare Star
    for (const id of [152, 154, 3576, 3577, 16505, 16506, 16507, 25797, 36986, 36989]) {
      expect(blm.isGcd(id), String(id)).toBe(true)
    }
  })

  it('classifies oGCDs seen in real logs', () => {
    // Transpose、Manaward、Manafont、Ley Lines、Triplecast、Amplifier、Retrace、Swiftcast、藥水
    for (const id of [149, 157, 158, 3573, 7421, 25796, 36988, 7561, 34600430]) {
      expect(blm.isGcd(id), String(id)).toBe(false)
    }
  })

  it('classifies mitigation and movement abilities', () => {
    expect(abilityCategory(157, blm)).toBe('mitigation') // Manaward
    expect(abilityCategory(155, blm)).toBe('movement') // Aetherial Manipulation
    expect(abilityCategory(36988, blm)).toBe('movement') // Retrace
    expect(abilityCategory(3, blm)).toBe('movement') // Sprint（職能）
    expect(abilityCategory(7560, blm)).toBe('mitigation') // Addle（職能）
    expect(abilityCategory(3573, blm)).toBe('normal') // Ley Lines 是輸出技能
  })
})
