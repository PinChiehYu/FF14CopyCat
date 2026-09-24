import { describe, expect, it } from 'vitest'
import { getJob } from './index'

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

  it('marks defensive and movement abilities as utility', () => {
    expect(blm.utility?.has(157)).toBe(true) // Manaward
    expect(blm.utility?.has(36988)).toBe(true) // Retrace
    expect(blm.utility?.has(3573)).toBe(false) // Ley Lines 是輸出技能
  })
})
