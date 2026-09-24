import { describe, expect, it } from 'vitest'
import { compareTracks, divergences, positionAt, type PositionSample } from './positions'

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

  it('ignores short blips', () => {
    const mine = Array.from({ length: 31 }, (_, i) => (i === 10 ? s(i, 120, 100) : s(i, 95, 100)))
    expect(divergences(compareTracks(mine, ref, boss, 30_000))).toEqual([])
  })
})
