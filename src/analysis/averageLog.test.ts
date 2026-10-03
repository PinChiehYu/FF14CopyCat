import { describe, expect, it } from 'vitest'
import { averageCasts, type AverageSampleInput } from './averageLog'

// 每 10 秒一個 Boss 技能（不同 ID），對齊用
const boss = Array.from({ length: 30 }, (_, i) => ({ t: i * 10_000, abilityId: 9000 + i }))
const GCD_A = 1
const GCD_B = 2
const OGCD = 100
const RARE = 101
const isGcd = (id: number) => id < 100

/** 一位樣本：每 2.5 秒一個 GCD（jitter 毫秒的偏移），能力技每 60 秒一次 */
function sample(options: { jitter?: number; duration?: number; gcd?: (i: number) => number; rare?: boolean } = {}): AverageSampleInput {
  const { jitter = 0, duration = 300_000, gcd = () => GCD_A, rare = false } = options
  const casts = []
  for (let i = 0; i * 2500 < duration; i++) casts.push({ t: i * 2500 + jitter, abilityId: gcd(i) })
  for (let t = 1000; t < duration; t += 60_000) casts.push({ t: t + jitter, abilityId: OGCD })
  if (rare) casts.push({ t: 100_000, abilityId: RARE })
  return { boss, casts, duration }
}

describe('averageCasts', () => {
  it('places one GCD per position with the most common ability and its consistency', () => {
    // 3 位樣本的 GCD 只差幾十毫秒；第 4 個位置有一位用了不同的技能
    const samples = [sample({ jitter: 0 }), sample({ jitter: 40 }), sample({ jitter: 80, gcd: (i) => (i === 3 ? GCD_B : GCD_A) })]
    const { casts, used, rangeEnd } = averageCasts(boss, 300_000, samples, { isGcd })
    expect(used).toBe(3)
    expect(rangeEnd).toBe(300_000)
    const gcds = casts.filter((c) => isGcd(c.abilityId))
    expect(gcds).toHaveLength(120)
    expect(gcds[0]).toEqual({ t: 40, abilityId: GCD_A, consistency: 1 })
    expect(gcds[3]).toMatchObject({ abilityId: GCD_A, consistency: 2 / 3 })
  })

  it('keeps an ability only where most samples used it', () => {
    // 只有 1／3 的樣本用了 RARE：不放；OGCD 每位都用：每 60 秒一次
    const { casts } = averageCasts(boss, 300_000, [sample({ rare: true }), sample(), sample()], { isGcd })
    expect(casts.some((c) => c.abilityId === RARE)).toBe(false)
    expect(casts.filter((c) => c.abilityId === OGCD).map((c) => c.t)).toEqual([1000, 61_000, 121_000, 181_000, 241_000])
  })

  it('aligns each sample to my time by the boss casts', () => {
    // 樣本在 150 秒後推進慢 5 秒（之後的 Boss 施放與自己的施放都晚 5 秒）：換成我的時間後與我同步
    const late = (t: number) => (t >= 150_000 ? t + 5000 : t)
    const pushed = (): AverageSampleInput => {
      const s = sample()
      return { boss: s.boss.map((c) => ({ ...c, t: late(c.t) })), casts: s.casts.map((c) => ({ ...c, t: late(c.t) })), duration: late(s.duration) }
    }
    const { casts } = averageCasts(boss, 300_000, [pushed(), pushed()], { isGcd })
    expect(casts.filter((c) => c.abilityId === OGCD).map((c) => Math.round(c.t))).toEqual([1000, 61_000, 121_000, 181_000, 241_000])
  })

  it('ends the comparison when most samples have killed the boss, and counts only samples still fighting', () => {
    // 我打 300 秒；3 位樣本分別 200、250、290 秒擊殺 → 中位數 250 秒
    const samples = [sample({ duration: 200_000 }), sample({ duration: 250_000 }), sample({ duration: 290_000 })]
    const { casts, rangeEnd } = averageCasts(boss, 300_000, samples, { isGcd })
    expect(rangeEnd).toBe(250_000)
    // 250～290 秒只剩 1 位仍在戰鬥：1／1 仍是過半數，GCD 照放
    expect(casts.filter((c) => isGcd(c.abilityId)).at(-1)!.t).toBeGreaterThan(280_000)
  })

  it('skips samples that cannot be aligned', () => {
    const unaligned = { ...sample(), boss: [{ t: 0, abilityId: 1 }] }
    expect(averageCasts(boss, 300_000, [unaligned], { isGcd })).toEqual({ casts: [], rangeEnd: 0, used: 0, aligned: [] })
  })
})
