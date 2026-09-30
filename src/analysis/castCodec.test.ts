import { describe, expect, it } from 'vitest'
import { decodeApplications, decodeCasts, decodeWindows, encodeApplications, encodeCasts, encodeWindows } from './castCodec'

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
    expect(encodeWindows([])).toBe('')
    expect(decodeWindows('')).toEqual([])
    expect(encodeApplications([])).toBe('')
    expect(decodeApplications('')).toEqual([])
  })

  it('round-trips effect windows with their prepull and open-ended flags', () => {
    const windows = [
      { statusId: 1_001_233, start: 30_000, end: 45_000, prepull: false, openEnded: true },
      { statusId: 1_000_048, start: 0, end: 600_000, prepull: true, openEnded: false },
    ]
    expect(decodeWindows(encodeWindows(windows))).toEqual([windows[1], windows[0]])
  })

  it('round-trips debuff applications with their targets', () => {
    const applications = [
      { t: 12_000, statusId: 1_001_228, targetId: 40 },
      { t: 3_000, statusId: 1_001_228, targetId: 41 },
    ]
    expect(decodeApplications(encodeApplications(applications))).toEqual([applications[1], applications[0]])
  })
})
