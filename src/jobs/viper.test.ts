import { describe, expect, it } from 'vitest'
import { getJob } from './index'

describe('viper', () => {
  const viper = getJob('Viper')!

  it('classifies GCDs and oGCDs', () => {
    expect(viper.isGcd(34606)).toBe(true) // Steel Fangs
    expect(viper.isGcd(34626)).toBe(true) // Reawaken
    expect(viper.isGcd(34633)).toBe(true) // Uncoiled Fury
    expect(viper.isGcd(34634)).toBe(false) // Death Rattle
    expect(viper.isGcd(34647)).toBe(false) // Serpent's Ire
    expect(viper.isGcd(7546)).toBe(false) // True North
  })

  it('returns undefined for jobs without a module', () => {
    expect(getJob('Samurai')).toBeUndefined()
  })
})
