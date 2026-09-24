import { describe, expect, it } from 'vitest'
import { abilityUsage, gcdStats, lostGcdWindows, matchUses } from './metrics'

const every = (start: number, end: number, step: number) =>
  Array.from({ length: Math.floor((end - start) / step) + 1 }, (_, i) => start + i * step)
const identity = (t: number) => t

describe('gcdStats', () => {
  it('estimates the GCD and sums idle time beyond it', () => {
    // 2.1 秒 GCD，中間停手 10 秒
    const times = [...every(0, 21_000, 2100), ...every(31_000, 52_000, 2100)]
    const stats = gcdStats(times)
    expect(stats.count).toBe(times.length)
    expect(stats.gcdMs).toBe(2100)
    expect(stats.idleMs).toBe(10_000 - 2100 - 100)
  })

  it('handles too few GCDs', () => {
    expect(gcdStats([0])).toEqual({ count: 1, gcdMs: null, idleMs: 0 })
  })
})

describe('lostGcdWindows', () => {
  it('reports stops where the reference kept casting', () => {
    const ref = every(0, 40_000, 2000)
    const mine = [...every(0, 10_000, 2000), ...every(20_000, 40_000, 2000)] // 10～20 秒停手
    expect(lostGcdWindows(mine, ref, identity, 2000)).toEqual([
      { mineStart: 10_000, mineEnd: 20_000, refStart: 10_000, refEnd: 20_000, refGcds: 4 },
    ])
  })

  it('ignores downtime shared by both', () => {
    const both = [...every(0, 10_000, 2000), ...every(30_000, 40_000, 2000)]
    expect(lostGcdWindows(both, both, identity, 2000)).toEqual([])
  })

  it('maps my stop into reference time', () => {
    const ref = every(0, 40_000, 2000)
    const mine = [0, 2000, 4000, 14_000, 16_000]
    const [w] = lostGcdWindows(mine, ref, (t) => t + 5000, 2000)
    // 兩端各留半個 GCD → (10, 18) 秒間參考的 12、14、16 秒
    expect([w.refStart, w.refEnd, w.refGcds]).toEqual([9000, 19_000, 3])
  })
})

describe('matchUses', () => {
  it('pairs uses in order', () => {
    expect(matchUses([10_000, 70_000], [8000, 66_000, 126_000])).toEqual([2000, 4000])
  })

  it('skips an extra use instead of shifting every later pair', () => {
    // 參考多用了一次（40 秒），逐次配對會讓 100 秒那次對到 40 秒
    expect(matchUses([10_000, 100_000], [10_000, 40_000, 101_000])).toEqual([0, -1000])
  })

  it('does not pair uses more than 30 seconds apart', () => {
    expect(matchUses([0], [100_000])).toEqual([])
  })
})

describe('abilityUsage', () => {
  it('counts uses and averages the aligned delay of matched uses', () => {
    const mine = [
      { t: 10_000, abilityId: 1 },
      { t: 70_000, abilityId: 1 },
      { t: 5000, abilityId: 2 },
    ]
    const ref = [
      { t: 8000, abilityId: 1 },
      { t: 66_000, abilityId: 1 },
      { t: 126_000, abilityId: 1 },
      { t: 5000, abilityId: 2 },
    ]
    const rows = abilityUsage(mine, ref, identity)
    expect(rows[0]).toEqual({ abilityId: 1, mine: 2, ref: 3, matched: 2, avgDelayMs: 3000 })
    expect(rows[1]).toEqual({ abilityId: 2, mine: 1, ref: 1, matched: 1, avgDelayMs: 0 })
  })

  it('reports abilities used by only one side', () => {
    const rows = abilityUsage([{ t: 0, abilityId: 9 }], [], identity)
    expect(rows).toEqual([{ abilityId: 9, mine: 1, ref: 0, matched: 0, avgDelayMs: null }])
  })

  it('skips timing for spammed abilities', () => {
    const spam = Array.from({ length: 40 }, (_, i) => ({ t: i * 2000, abilityId: 5 }))
    expect(abilityUsage(spam, spam, identity)[0]).toMatchObject({ matched: 0, avgDelayMs: null })
  })
})
