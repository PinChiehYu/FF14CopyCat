import { describe, expect, it } from 'vitest'
import { getJob } from '../jobs'
import { abilityCategory } from '../jobs/roleActions'

const paladin = getJob('Paladin')!
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

function usage(
  abilityId: number,
  mine: number,
  ref: number,
  avgDelayMs: number | null = 0,
  matched = Math.min(mine, ref),
  unmatchedRef: number[] = [],
): AbilityUsage {
  return { abilityId, mine, ref, matched, avgDelayMs, unmatchedRef }
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
    // 使用實際的分類：騎士模組（減傷、坦姿）加上職能技能
    category: (id) => abilityCategory(id, paladin),
    mineToRef: (t) => t,
    firstUse: () => undefined,
    ...overrides,
  }
}

describe('generateAdvice', () => {
  it('returns nothing when there is nothing to improve', () => {
    expect(generateAdvice(input({ usage: [usage(1, 5, 5)] }))).toEqual([])
  })

  it('puts deaths first and tells the player not to die', () => {
    const advice = generateAdvice(
      input({
        deaths: {
          mine: [{ t: 120_000, abilityId: 2, revivedAt: 140_000 }],
          ref: [],
        },
        // 死亡期間的停手：註明是因為死亡
        lost: [{ mineStart: 121_000, mineEnd: 139_000, refStart: 121_000, refEnd: 139_000, refGcds: 7 }],
      }),
    )
    expect(advice[0]).toMatchObject({ severity: 'high', title: '你死亡了 1 次：避免死亡是最優先的改進', at: 120_000 })
    expect(advice[0].detail).toContain('2:00.0（Enpi）')
    expect(advice[0].detail).toContain('20.0 秒無法輸出')
    expect(advice[0].detail).toContain('參考在同一場沒有死亡')
    expect(advice[0].detail).toContain('不要死亡')
    const lost = advice.find((a) => a.title.startsWith('2:01.0 停手'))
    expect(lost?.title).toContain('（這段期間你已死亡）')
    expect(lost?.detail).toContain('不要死亡')
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

  it('ranks missed potions and cooldowns above other utility actions', () => {
    // 7546 True North、7541 Second Wind 為其他輔助技能
    const advice = generateAdvice(
      input({ usage: [usage(7546, 0, 4), usage(1, 5, 7), usage(5, 14, 15), usage(4, 0, 3), usage(7541, 0, 1)] }),
    )
    expect(advice.map((a) => a.title)).toEqual([
      'Ikishoten 少用 2 次（你 5 次、參考 7 次）',
      '爆發藥少用 3 次（你 0 次、參考 3 次）',
      '1 個技能各少用 1 次',
      '輔助技能使用次數較少',
    ])
    expect(advice.map((a) => a.severity)).toEqual(['high', 'high', 'medium', 'low'])
    expect(advice[3].detail).toMatch('#7546（0／4）、#7541（0／1）')
  })

  it('ignores tank provoke, shirk and stance toggles', () => {
    // 7533 Provoke、7537 Shirk、28 Iron Will、32065 Release Iron Will
    const advice = generateAdvice(
      input({ usage: [usage(7533, 1, 3), usage(7537, 0, 2), usage(28, 0, 4), usage(32065, 0, 4)] }),
    )
    expect(advice).toEqual([])
  })

  it('lists when the reference used mitigation that I did not', () => {
    // 7535 Reprisal（職能減傷）、7382 Intervention（騎士減傷）
    const advice = generateAdvice(
      input({
        usage: [
          usage(7535, 6, 9, 0, 6, [83_000, 225_000, 400_000]),
          usage(7382, 7, 7, 0, 6, [300_000]),
        ],
      }),
    )
    expect(advice[0]).toMatchObject({
      severity: 'high',
      title: '減傷：#7535 少用 3 次（你 6 次、參考 9 次）',
      at: 83_000,
    })
    expect(advice[0].detail).toMatch('參考在 1:23.0、3:45.0、6:40.0 使用，你在前後 30 秒內沒有使用')
    expect(advice[1]).toMatchObject({ severity: 'medium', title: '減傷：#7382 有 1 次使用時機與參考不同', at: 300_000 })
  })

  it('treats Sprint as an important movement action', () => {
    const [a] = generateAdvice(input({ usage: [usage(3, 0, 6, null, 0, [10_000, 70_000])] }))
    expect(a).toMatchObject({ severity: 'high', title: '移動：Sprint 少用 6 次（你 0 次、參考 6 次）', at: 10_000 })
  })

  it('flags late mitigation', () => {
    const [a] = generateAdvice(input({ usage: [usage(7531, 5, 5, 8000, 5)] })) // Rampart
    expect(a).toMatchObject({ severity: 'medium', title: '減傷：#7531 平均比參考晚 8.0 秒使用' })
  })

  it('detects potions by English name when display names are translated', () => {
    const [a] = generateAdvice(
      input({
        usage: [usage(4, 0, 3)],
        abilityName: () => '3級剛力之幻藥',
        englishName: (id) => names[id],
      }),
    )
    expect(a.title).toBe('爆發藥少用 3 次（你 0 次、參考 3 次）')
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

  it('highlights position differences around boss mechanics and summarises mirrored ones', () => {
    const advice = generateAdvice(
      input({
        divergences: [
          // 機制前後，且同時少打 GCD → 優先
          { start: 100_000, end: 110_000, maxDistance: 15, mirror: null, mechanics: [{ t: 108_000, abilityId: 5 }] },
          // 機制前後（短的也列出）→ 建議
          { start: 150_000, end: 152_000, maxDistance: 12, mirror: null, mechanics: [{ t: 153_000, abilityId: 1 }] },
          // 附近沒有機制、較長 → 參考
          { start: 200_000, end: 210_000, maxDistance: 20, mirror: null, mechanics: [] },
          // 附近沒有機制、太短 → 不列
          { start: 250_000, end: 251_000, maxDistance: 20, mirror: null, mechanics: [] },
          { start: 300_000, end: 400_000, maxDistance: 33, mirror: 'left-right', mechanics: [] },
        ],
        lost: [{ mineStart: 105_000, mineEnd: 109_000, refStart: 105_000, refEnd: 109_000, refGcds: 1 }],
      }),
    )
    const worst = advice.find((a) => a.at === 100_000)!
    expect(worst).toMatchObject({ severity: 'high', title: '1:48.0 機制「Meikyo Shisui」結算時站位與參考不同（最遠 15.0 yalm）' })
    expect(worst.detail).toMatch('少打了 GCD')
    expect(advice.find((a) => a.at === 150_000)).toMatchObject({ severity: 'medium' })
    expect(advice.find((a) => a.at === 200_000)).toMatchObject({ severity: 'low' })
    expect(advice.find((a) => a.at === 200_000)?.title).toMatch('附近沒有 Boss 機制')
    expect(advice.some((a) => a.at === 250_000)).toBe(false)
    expect(advice.find((a) => a.title.includes('不同攻略'))?.title).toMatch('左右對稱')
  })

  it('downgrades position differences caused by a different random mechanic', () => {
    const [a] = generateAdvice(
      input({
        divergences: [{ start: 100_000, end: 110_000, maxDistance: 15, mirror: null, mechanics: [{ t: 104_000, abilityId: 1 }] }],
        mechanics: [{ t: 95_000, mine: [1], ref: [5], kind: 'variant' }],
      }),
    )
    expect(a.severity).toBe('low')
    expect(a.detail).toMatch('隨機機制不同（你：Ikishoten；參考：Meikyo Shisui）')
  })

  it('adds ability IDs when variants share a name', () => {
    const [a] = generateAdvice(
      input({
        abilityName: () => "Hero's Blow",
        divergences: [{ start: 100_000, end: 110_000, maxDistance: 30, mirror: null, mechanics: [{ t: 104_000, abilityId: 42079 }] }],
        mechanics: [{ t: 95_000, mine: [42081], ref: [42079], kind: 'variant' }],
      }),
    )
    expect(a.detail).toMatch("你：Hero's Blow #42081；參考：Hero's Blow #42079")
  })
})
