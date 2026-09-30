import { describe, expect, it } from 'vitest'
import { decodeCasts, encodeCasts } from './castCodec'

describe('castCodec', () => {
  it('round-trips casts to the nearest 10 ms, sorted by time', () => {
    const casts = [
      { t: 61_234, abilityId: 42_079 },
      { t: 5_000, abilityId: 7 },
      { t: 5_004, abilityId: 1_002_845 },
    ]
    const encoded = encodeCasts(casts)
    expect(decodeCasts(encoded)).toEqual([
      { t: 5_000, abilityId: 7 },
      { t: 5_000, abilityId: 1_002_845 },
      { t: 61_230, abilityId: 42_079 },
    ])
    // 精簡：每筆只有 36 進位的 ID 與時間差
    expect(encoded.length).toBeLessThan(40)
  })

  it('handles empty input', () => {
    expect(encodeCasts([])).toBe('')
    expect(decodeCasts('')).toEqual([])
  })
})
