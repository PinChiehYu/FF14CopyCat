import { describe, expect, it } from 'vitest'
import { buildAlignment, pushDifferences, type Anchor, type TimedCast } from './alignment'

const cast = (seconds: number, abilityId: number): TimedCast => ({ t: seconds * 1000, abilityId })

describe('buildAlignment', () => {
  it('interpolates between anchors and extrapolates after the last one', () => {
    // 參考日誌第二個機制早了 10 秒（例如輸出較高而提早轉場）
    const mine = [cast(10, 1), cast(60, 2), cast(90, 3)]
    const ref = [cast(10, 1), cast(50, 2), cast(80, 3)]
    const { anchors, mineToRef } = buildAlignment(mine, ref)

    expect(anchors.map((a) => a.abilityId)).toEqual([1, 2, 3])
    expect(mineToRef(5_000)).toBe(5_000)
    expect(mineToRef(35_000)).toBe(30_000) // 10→10 與 60→50 之間
    expect(mineToRef(100_000)).toBe(90_000) // 最後錨點之後斜率 1
  })

  it('inverts the mapping with refToMine', () => {
    const mine = [cast(10, 1), cast(60, 2), cast(90, 3)]
    const ref = [cast(10, 1), cast(50, 2), cast(80, 3)]
    const { mineToRef, refToMine } = buildAlignment(mine, ref)
    for (const t of [0, 5_000, 35_000, 75_000, 100_000]) {
      expect(refToMine(mineToRef(t))).toBeCloseTo(t)
    }
  })

  it('matches the nth occurrence and merges simultaneous casts', () => {
    const mine = [cast(10, 7), cast(10.2, 7), cast(40, 7)]
    const ref = [cast(12, 7), cast(45, 7)]
    const { anchors } = buildAlignment(mine, ref)
    expect(anchors.map((a) => [a.occurrence, a.mine, a.ref])).toEqual([
      [1, 10_000, 12_000],
      [2, 40_000, 45_000],
    ])
  })

  it('drops an isolated anchor from a mechanic with a random order', () => {
    // A 面／B 面先後隨機（熱舞綠光）：兩邊順序相反，配出的錨點時間差 ±20 秒，前後的錨點都一致
    const common = [cast(10, 1), cast(20, 2), cast(30, 3), cast(70, 4), cast(80, 5), cast(90, 6)]
    const mine = [...common, cast(40, 10), cast(60, 11)]
    const ref = [...common, cast(40, 11), cast(60, 10)]
    const { anchors, mineToRef } = buildAlignment(mine, ref)
    expect(anchors.map((a) => a.abilityId)).toEqual([1, 2, 3, 4, 5, 6])
    expect(mineToRef(50_000)).toBe(50_000)
    expect(pushDifferences(anchors)).toEqual([])
  })

  it('keeps the anchors around a real push', () => {
    // 60 秒後參考都早 10 秒：前後兩邊的時間差不同，不是孤立錨點
    const mine = [cast(10, 1), cast(20, 2), cast(30, 3), cast(60, 4), cast(70, 5), cast(80, 6)]
    const ref = [cast(10, 1), cast(20, 2), cast(30, 3), cast(50, 4), cast(60, 5), cast(70, 6)]
    expect(buildAlignment(mine, ref).anchors).toHaveLength(6)
  })

  it('ignores frequent abilities such as auto-attacks', () => {
    const autos = (offset: number) => Array.from({ length: 20 }, (_, i) => cast(offset + i * 3, 99))
    const mine = [...autos(0), cast(30, 1)]
    const ref = [...autos(1), cast(33, 1)]
    const { anchors } = buildAlignment(mine, ref)
    expect(anchors.map((a) => a.abilityId)).toEqual([1])
  })

  it('drops pairings that contradict the time order', () => {
    // 能力 5 在兩份日誌的出現順序顛倒（例如隨機機制），應被捨棄
    const mine = [cast(10, 1), cast(20, 5), cast(30, 2), cast(40, 3)]
    const ref = [cast(10, 1), cast(30, 2), cast(40, 3), cast(45, 5)]
    const { anchors } = buildAlignment(mine, ref)
    expect(anchors.map((a) => a.abilityId)).toEqual([1, 2, 3])
  })

  it('falls back to identity when nothing matches', () => {
    const { anchors, mineToRef } = buildAlignment([cast(10, 1)], [cast(10, 2)])
    expect(anchors).toEqual([])
    expect(mineToRef(12_345)).toBe(12_345)
  })
})

describe('pushDifferences', () => {
  // 錨點：[我的秒數, 參考的秒數]
  const anchors = (pairs: [number, number][]): Anchor[] =>
    pairs.map(([m, r], i) => ({ mine: m * 1000, ref: r * 1000, abilityId: i + 1, occurrence: 1 }))

  it('finds a persistent jump such as pushing a phase later than the reference', () => {
    // 第一階段兩邊同步；參考 100 秒推進、我 109 秒才推進；轉場後時間差維持 −9 秒
    const pushes = pushDifferences(
      anchors([[20, 20], [50, 50], [80, 80], [99.5, 99.4], [109, 100], [170, 161], [190, 181], [220, 211]]),
    )
    expect(pushes).toHaveLength(1)
    expect(pushes[0]).toMatchObject({ mineStart: 99_500, mineEnd: 109_000, refStart: 99_400, refEnd: 100_000 })
    // 前後各取中位數：推進前的時間差約 −0.05 秒，之後 −9 秒
    expect(pushes[0].deltaMs).toBe(8950)
  })

  it('ignores short wobbles from random mechanics', () => {
    // 5:56 附近一個錨點偏了約 4 秒，之後回到原本的時間差
    const pushes = pushDifferences(anchors([[340, 340], [351, 351.2], [356.6, 352.8], [358.6, 356.8], [359.7, 359.9], [364, 364.1], [378, 378.2]]))
    expect(pushes).toEqual([])
  })

  it('drops a jump that is undone shortly after', () => {
    // 先慢 5 秒、10 秒後又追回：兩段合併後沒有持續的差距
    const pushes = pushDifferences(anchors([[30, 30], [60, 60], [90, 85], [100, 100], [130, 130], [160, 160]]))
    expect(pushes).toEqual([])
  })

  it('reports a faster push as a negative difference', () => {
    const pushes = pushDifferences(anchors([[30, 30], [60, 60], [90, 95], [120, 125], [150, 155]]))
    expect(pushes).toHaveLength(1)
    expect(pushes[0].deltaMs).toBe(-5000)
  })
})
