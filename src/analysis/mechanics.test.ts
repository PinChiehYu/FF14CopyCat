import { describe, expect, it } from 'vitest'
import type { TimedCast } from './alignment'
import { mechanicDifferences } from './mechanics'

const cast = (seconds: number, abilityId: number): TimedCast => ({ t: seconds * 1000, abilityId })
const identity = (t: number) => t

describe('mechanicDifferences', () => {
  it('reports random variants cast at the same aligned time', () => {
    const mine = [cast(10, 1), cast(23, 42642), cast(40, 3)]
    const ref = [cast(10, 1), cast(23.1, 42641), cast(40, 3)]
    expect(mechanicDifferences(mine, ref, identity, 60_000, 60_000)).toEqual([
      { t: 23_000, mine: [42642], ref: [42641], kind: 'variant' },
    ])
  })

  it('uses the aligned time for my casts', () => {
    const mine = [cast(30, 5)]
    const ref = [cast(20, 6)]
    const [d] = mechanicDifferences(mine, ref, (t) => t - 10_000, 60_000, 60_000)
    expect(d).toEqual({ t: 20_000, mine: [5], ref: [6], kind: 'variant' })
  })

  it('groups simultaneous casts and reports one-sided mechanics', () => {
    const mine = [cast(10, 7), cast(10.5, 8)]
    const ref = [cast(10, 9), cast(30, 4)]
    expect(mechanicDifferences(mine, ref, identity, 60_000, 60_000)).toEqual([
      { t: 10_000, mine: [7, 8], ref: [9], kind: 'variant' },
      { t: 30_000, mine: [], ref: [4], kind: 'only-ref' },
    ])
  })

  it('treats the same ability a few seconds apart as the same mechanic', () => {
    // 轉場附近對齊差 3 秒，不應列成「只有我」與「只有參考」
    const mine = [cast(339.7, 5), cast(351.7, 6)]
    const ref = [cast(341.7, 5), cast(354.8, 6)]
    expect(mechanicDifferences(mine, ref, identity, 600_000, 600_000)).toEqual([])
  })

  it('ignores frequent abilities and casts after the shorter fight ends', () => {
    const autos = Array.from({ length: 20 }, (_, i) => cast(i * 3, 99))
    const mine = [...autos, cast(50, 1)]
    const ref = [cast(50, 1), cast(80, 2)] // 80 秒時我的戰鬥已結束
    expect(mechanicDifferences(mine, ref, identity, 60_000, 90_000)).toEqual([])
  })
})
