import { describe, expect, it } from 'vitest'
import { generateAdvice, type AdviceInput } from './advice'
import type { AbilityUsage } from './metrics'
import type { TrackPoint } from './positions'

const names: Record<number, string> = {
  1: 'Ikishoten',
  2: 'Enpi',
  3: 'Sprint',
  4: 'Grade 3 Gemdraught of Strength [HQ]',
  5: 'Meikyo Shisui',
  6: 'Gekko',
}

function usage(abilityId: number, mine: number, ref: number, avgDelayMs: number | null = 0, matched = Math.min(mine, ref)): AbilityUsage {
  return { abilityId, mine, ref, matched, avgDelayMs }
}

function input(overrides: Partial<AdviceInput> = {}): AdviceInput {
  return {
    durationMs: 600_000,
    gcd: null,
    lost: [],
    usage: [],
    divergences: [],
    track: [],
    abilityName: (id) => names[id] ?? `#${id}`,
    isGcd: (id) => id === 2 || id === 6,
    mineToRef: (t) => t,
    firstUse: () => undefined,
    ...overrides,
  }
}

describe('generateAdvice', () => {
  it('returns nothing when there is nothing to improve', () => {
    expect(generateAdvice(input({ usage: [usage(1, 5, 5)] }))).toEqual([])
  })

  it('summarises lost GCD windows and notes movement differences', () => {
    const track: TrackPoint[] = [10_000, 12_000, 14_000].map((t) => ({
      t,
      mine: null,
      ref: null,
      boss: null,
      distance: 12,
      mirroredDistance: null,
      mirror: null,
    }))
    const advice = generateAdvice(
      input({
        lost: [
          { mineStart: 10_000, mineEnd: 16_000, refStart: 10_000, refEnd: 16_000, refGcds: 3 },
          { mineStart: 60_000, mineEnd: 64_000, refStart: 60_000, refEnd: 64_000, refGcds: 1 },
        ],
        track,
      }),
    )
    expect(advice[0].title).toMatch('共少打 4 個 GCD')
    const worst = advice.find((a) => a.at === 10_000)!
    expect(worst.severity).toBe('high')
    expect(worst.detail).toMatch('走位路線不同')
  })

  it('estimates GCDs lost to a slower GCD', () => {
    const [a] = generateAdvice(
      input({ gcd: { mine: { count: 1, gcdMs: 2177, idleMs: 0 }, ref: { count: 1, gcdMs: 2141, idleMs: 0 } } }),
    )
    // 600 秒：280.2 - 275.6 ≈ 4.6 個
    expect(a.title).toMatch('慢 36 毫秒')
    expect(a.title).toMatch('約少 4.6 個 GCD')
  })

  it('ranks missed potions and cooldowns above role actions', () => {
    const advice = generateAdvice(
      input({ usage: [usage(3, 0, 6), usage(1, 5, 7), usage(5, 14, 15), usage(4, 0, 3)] }),
    )
    expect(advice.map((a) => a.title)).toEqual([
      'Ikishoten 少用 2 次（你 5 次、參考 7 次）',
      '爆發藥少用 3 次（你 0 次、參考 3 次）',
      '1 個技能各少用 1 次',
      '職能技能使用次數較少',
    ])
    expect(advice.map((a) => a.severity)).toEqual(['high', 'high', 'medium', 'low'])
    expect(advice[3].detail).toMatch('Sprint（0／6）')
  })

  it('does not treat fewer GCDs as missed cooldowns', () => {
    // Gekko（GCD）少用是少打 GCD 的結果
    expect(generateAdvice(input({ usage: [usage(6, 17, 20)] }))).toEqual([])
  })

  it('flags late cooldowns and GCDs the reference never used', () => {
    const advice = generateAdvice(
      input({
        usage: [usage(5, 15, 15, 8000, 15), usage(2, 5, 0, null, 0), usage(6, 41, 48)],
        firstUse: (id) => (id === 2 ? 30_000 : undefined),
        mineToRef: (t) => t - 1000,
      }),
    )
    // 同等級維持輸入順序；連擊 GCD（Gekko）的次數差已反映在 GCD 數，不逐一列出
    expect(advice.map((a) => a.title)).toEqual(['Meikyo Shisui 平均比參考晚 8.0 秒使用', '使用了 5 次 Enpi，參考完全沒用'])
    expect(advice[1].at).toBe(29_000)
  })

  it('reports unexplained position differences and summarises mirrored ones', () => {
    const advice = generateAdvice(
      input({
        divergences: [
          { start: 100_000, end: 110_000, maxDistance: 15, mirror: null },
          { start: 200_000, end: 201_000, maxDistance: 20, mirror: null }, // 太短
          { start: 300_000, end: 400_000, maxDistance: 33, mirror: 'left-right' },
        ],
        lost: [{ mineStart: 105_000, mineEnd: 109_000, refStart: 105_000, refEnd: 109_000, refGcds: 1 }],
      }),
    )
    const position = advice.find((a) => a.at === 100_000)!
    expect(position.severity).toBe('high')
    expect(position.detail).toMatch('少打了 GCD')
    expect(advice.find((a) => a.title.includes('不同攻略'))?.title).toMatch('左右對稱')
    expect(advice.some((a) => a.at === 200_000)).toBe(false)
  })
})
