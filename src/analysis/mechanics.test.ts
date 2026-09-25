import { describe, expect, it } from 'vitest'
import { mechanicLabel, mergeRepeats } from './mechanics'

describe('mergeRepeats', () => {
  const names: Record<number, string> = { 1: '音頻爆炸', 2: '音頻爆炸', 5: '靜音爆炸', 7: '放入B面', 8: '放入A面' }
  const name = (id: number) => names[id]

  it('merges consecutive resolutions of the same mechanic', () => {
    const merged = mergeRepeats(
      [
        { t: 191_500, mine: [1], ref: [5], kind: 'variant' },
        { t: 196_500, mine: [1, 2], ref: [5], kind: 'variant' },
        { t: 201_500, mine: [2], ref: [5], kind: 'variant' },
        { t: 230_000, mine: [1], ref: [5], kind: 'variant' }, // 間隔太久
        { t: 232_000, mine: [7], ref: [8], kind: 'variant' }, // 不同技能
      ],
      name,
    )
    expect(merged.map((m) => [m.t, m.last, m.count, m.mine])).toEqual([
      [191_500, 201_500, 3, [1, 2]],
      [230_000, 230_000, 1, [1]],
      [232_000, 232_000, 1, [7]],
    ])
  })
})

describe('mechanicLabel', () => {
  const names: Record<number, string> = {
    1: '四連指向、定格＆播放',
    2: '四連指向、定格＆播放',
    3: '四連指向、定格＆播放',
    4: '四連指向、定格＆播放',
    10: '英雄之擊',
    11: '英雄之擊',
    20: '月焚',
  }
  const name = (id: number) => names[id]

  it('shows a multi-hit attack made of several same-name IDs once', () => {
    expect(mechanicLabel([1, 2, 3, 4], [], name)).toBe('四連指向、定格＆播放')
    expect(mechanicLabel([1, 2, 3, 4, 20], [1, 2, 3], name)).toBe('四連指向、定格＆播放、月焚')
  })

  it('keeps the IDs for variants with the same name on the other side', () => {
    expect(mechanicLabel([10], [11], name)).toBe('英雄之擊 #10')
    expect(mechanicLabel([11], [10], name)).toBe('英雄之擊 #11')
    // 連續結算合併後一邊有多個 ID
    expect(mechanicLabel([11, 12], [11, 10], (id) => (id === 12 ? '英雄之擊' : name(id)))).toBe('英雄之擊 #12')
  })
})
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
