import { describe, expect, it } from 'vitest'
import { attachMechanics, bossPoseAt, compareTracks, divergences, positionAt, toBossFrame, type PositionSample } from './positions'

const s = (seconds: number, x: number, y: number): PositionSample => ({ t: seconds * 1000, x, y })

describe('positionAt', () => {
  const samples = [s(0, 100, 100), s(2, 104, 100), s(20, 90, 90)]

  it('interpolates between close samples', () => {
    expect(positionAt(samples, 1000)).toEqual({ x: 102, y: 100 })
  })

  it('does not interpolate across long gaps', () => {
    expect(positionAt(samples, 2500)).toEqual(samples[1]) // 靠近前一個取樣
    expect(positionAt(samples, 10_000)).toBeNull()
  })

  it('extrapolates only briefly beyond the ends', () => {
    expect(positionAt(samples, 20_500)).toEqual(samples[2])
    expect(positionAt(samples, 30_000)).toBeNull()
    expect(positionAt([], 0)).toBeNull()
  })
})

describe('compareTracks / divergences', () => {
  const boss = [s(0, 100, 100), s(30, 100, 100)]
  // 參考一直站在 Boss 西側 5 yalm
  const ref = Array.from({ length: 31 }, (_, i) => s(i, 95, 100))

  it('finds sustained divergences and flags mirrored positions', () => {
    // 我在 10～16 秒跑到 Boss 東側（參考位置的左右對稱）
    const mine = Array.from({ length: 31 }, (_, i) => (i >= 10 && i <= 16 ? s(i, 105, 100) : s(i, 95, 100)))
    const track = compareTracks(mine, ref, boss, 30_000)
    expect(track.find((p) => p.t === 12_000)?.distance).toBe(10)

    const [d, ...rest] = divergences(track)
    expect(rest).toEqual([])
    expect(d.start).toBeGreaterThanOrEqual(9000)
    expect(d.end).toBeLessThanOrEqual(17_000)
    expect(d.maxDistance).toBe(10)
    expect(d.mirror).toBe('left-right')
  })

  it('does not flag non-mirrored divergences as mirrored', () => {
    const mine = Array.from({ length: 31 }, (_, i) => (i >= 10 && i <= 16 ? s(i, 95, 115) : s(i, 95, 100)))
    const [d] = divergences(compareTracks(mine, ref, boss, 30_000))
    expect(d.mirror).toBeNull()
  })

  it('detects mirroring around the arena center when the boss is mirrored too', () => {
    // 兩隊連 Boss 都在場地的另一側（參考 Boss 在西 92、我方對應位置在東）
    const refBoss = [s(0, 92, 100), s(30, 92, 100)]
    const refP = Array.from({ length: 31 }, (_, i) => s(i, 88, 100))
    const mine = Array.from({ length: 31 }, (_, i) => s(i, 112, 101))
    const [d] = divergences(compareTracks(mine, refP, refBoss, 30_000, { x: 100, y: 100 }))
    expect(d.maxDistance).toBeGreaterThan(20)
    expect(d.mirror).toBe('left-right')
  })

  it('attaches boss mechanics resolving while the players are apart', () => {
    const divs = [
      { start: 10_000, end: 16_000, maxDistance: 10, mirror: null, mechanics: [] },
      { start: 40_000, end: 42_000, maxDistance: 12, mirror: null, mechanics: [] },
    ]
    const autos = Array.from({ length: 20 }, (_, i) => ({ t: i * 3000, abilityId: 99 })) // 自動攻擊
    const boss = [
      ...autos,
      { t: 9500, abilityId: 1 }, // 區段開始前，還沒分開 → 不算
      { t: 13_000, abilityId: 2 }, // 區段中、相距 10 → 算
      { t: 15_500, abilityId: 3 }, // 區段中但該點距離已回到 5 → 不算
      { t: 43_500, abilityId: 4 }, // 區段結束後 → 不算
    ]
    const distance = (t: number) => (t === 15_500 ? 5 : t >= 10_000 && t <= 16_000 ? 10 : 2)
    const [a, b] = attachMechanics(divs, boss, distance, 8)
    expect(a.mechanics.map((m) => m.abilityId)).toEqual([2])
    expect(b.mechanics).toEqual([])
  })

  it('ignores short blips', () => {
    const mine = Array.from({ length: 31 }, (_, i) => (i === 10 ? s(i, 120, 100) : s(i, 95, 100)))
    expect(divergences(compareTracks(mine, ref, boss, 30_000))).toEqual([])
  })
})

describe('bossPoseAt / toBossFrame', () => {
  // Boss 在 (100, 100)，面向 +x（θ = 0）
  const boss: PositionSample[] = [
    { t: 0, x: 100, y: 100, facing: 0 },
    { t: 10_000, x: 100, y: 100 },
  ]

  it('takes the position and the nearest facing', () => {
    expect(bossPoseAt(boss, 5000)).toEqual({ at: { x: 100, y: 100 }, facing: 0 })
    // 面向取樣相差超過 5 秒：沒有面向
    expect(bossPoseAt([{ t: 0, x: 100, y: 100 }, { t: 20_000, x: 100, y: 100, facing: 0 }], 5000)).toBeNull()
  })

  it('puts the boss at the origin facing up', () => {
    const pose = { at: { x: 100, y: 100 }, facing: 0 }
    // + 0 把 −0 變成 0
    const round = (p: { x: number; y: number }) => ({ x: Math.round(p.x * 100) / 100 + 0, y: Math.round(p.y * 100) / 100 + 0 })
    expect(round(toBossFrame({ x: 105, y: 100 }, pose))).toEqual({ x: 0, y: -5 }) // 正面 → 上
    expect(round(toBossFrame({ x: 95, y: 100 }, pose))).toEqual({ x: 0, y: 5 }) // 背面 → 下
    // 面向朝上時，Boss 的右手邊（面向方向順時針 90°，座標 +y）在畫面右側
    expect(round(toBossFrame({ x: 100, y: 105 }, pose))).toEqual({ x: 5, y: 0 })
  })
})
