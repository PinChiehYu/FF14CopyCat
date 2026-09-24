import { describe, expect, it } from 'vitest'
import { buildAlignment, type TimedCast } from './alignment'

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

  it('matches the nth occurrence and merges simultaneous casts', () => {
    const mine = [cast(10, 7), cast(10.2, 7), cast(40, 7)]
    const ref = [cast(12, 7), cast(45, 7)]
    const { anchors } = buildAlignment(mine, ref)
    expect(anchors.map((a) => [a.occurrence, a.mine, a.ref])).toEqual([
      [1, 10_000, 12_000],
      [2, 40_000, 45_000],
    ])
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
