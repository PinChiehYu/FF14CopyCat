import { describe, expect, it } from 'vitest'
import { defaultPrRange } from './sideDamage'

describe('defaultPrRange', () => {
  it('searches a step above my PR', () => {
    expect(defaultPrRange(40)).toEqual({ min: 41, max: 60 })
    expect(defaultPrRange(0)).toEqual({ min: 1, max: 20 })
  })

  it('caps the range at 100', () => {
    expect(defaultPrRange(85)).toEqual({ min: 86, max: 100 })
    expect(defaultPrRange(100)).toEqual({ min: 100, max: 100 })
  })

  it('falls back to 90–100 without a PR', () => {
    expect(defaultPrRange(null)).toEqual({ min: 90, max: 100 })
  })
})
