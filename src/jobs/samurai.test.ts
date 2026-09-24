import { describe, expect, it } from 'vitest'
import { getJob } from './index'

describe('samurai', () => {
  const samurai = getJob('Samurai')!

  it('classifies GCDs seen in real logs', () => {
    for (const id of [36963, 7478, 7479, 7480, 7481, 7482, 7487, 7489, 16486, 25781, 25782, 36966, 36968]) {
      expect(samurai.isGcd(id), String(id)).toBe(true)
    }
  })

  it('classifies oGCDs seen in real logs', () => {
    // Shinten, Gyoten, Hagakure, Meditate, Meikyo, Senei, Ikishoten, Shoha, Tengentsu, Zanshin, True North, 藥水
    for (const id of [7490, 7492, 7495, 7497, 7499, 16481, 16482, 16487, 36962, 36964, 7546, 34600427]) {
      expect(samurai.isGcd(id), String(id)).toBe(false)
    }
  })
})
