import { describe, expect, it } from 'vitest'
import { getJob } from '../jobs'
import { abilityCategory } from '../jobs/roleActions'
import { generateAdvice, generateSoloAdvice, type AdviceInput, type SoloAdviceInput } from './advice'
import { DOT_RULES } from '../jobs/dotRules'
import type { WindowRule } from '../jobs/windows'
import type { AbilityUsage } from './metrics'
import type { TrackPoint } from './positions'

const paladin = getJob('Paladin')!

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

  it('points out pushing a phase later than the reference, but not an earlier push', () => {
    const advice = generateAdvice(
      input({
        pushes: [
          { mineStart: 390_800, mineEnd: 400_500, refStart: 390_400, refEnd: 391_200, deltaMs: 8_900 },
          { mineStart: 500_000, mineEnd: 505_000, refStart: 500_000, refEnd: 510_000, deltaMs: -5_000 },
        ],
      }),
    )
    expect(advice).toHaveLength(1)
    expect(advice[0]).toMatchObject({ severity: 'high', title: '6:31.2 推進比參考慢 8.9 秒', at: 391_200 })
    expect(advice[0].detail).toContain('你到 6:40.5 才推進')
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

  it('groups stops caused by boss control into one low item', () => {
    const advice = generateAdvice(
      input({
        lost: [
          { mineStart: 100_000, mineEnd: 105_000, refStart: 100_000, refEnd: 105_000, refGcds: 2, control: [1] },
          { mineStart: 200_000, mineEnd: 204_000, refStart: 200_000, refEnd: 204_000, refGcds: 1, control: [1] },
        ],
      }),
    )
    // 控場造成的停手不列為停手建議，只合併成一則參考
    expect(advice).toHaveLength(1)
    expect(advice[0]).toMatchObject({ severity: 'low', title: '2 段停手是 Boss 控場造成', at: 100_000 })
    expect(advice[0].detail).toMatch('1:40.0（Ikishoten）、3:20.0（Ikishoten）')
  })

  it('summarises lost GCD windows and notes movement differences', () => {
    const track: TrackPoint[] = [10_000, 12_000, 14_000].map((t) => ({
      t,
      mine: null,
      ref: null,
      boss: null,
      distance: 12,
      arenaDistance: 12,
      bossGap: null,
      bossFrame: false,
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

  it('lists party mitigation the reference used and I did not as a suggestion, never a priority', () => {
    // 7535 Reprisal（職能、降低敵人傷害）、7382 Intervention（騎士、給隊友）
    const advice = generateAdvice(
      input({
        usage: [
          usage(7535, 6, 9, 0, 6, [83_000, 225_000, 400_000]),
          usage(7382, 7, 7, 0, 6, [300_000]),
        ],
      }),
    )
    expect(advice[0]).toMatchObject({
      severity: 'medium',
      title: '團隊減傷：#7535 少用 3 次（你 6 次、參考 9 次）',
      at: 83_000,
    })
    expect(advice[0].detail).toMatch('參考在 1:23.0、3:45.0、6:40.0 使用，你在前後 30 秒內沒有使用')
    expect(advice[0].detail).toContain('影響隊友的生存')
    expect(advice[1]).toMatchObject({ severity: 'medium', title: '團隊減傷：#7382 有 1 次使用時機與參考不同', at: 300_000 })
  })

  it('puts self mitigation under reference only', () => {
    // 7531 Rampart、17 Sentinel（只保護自己）
    const advice = generateAdvice(input({ usage: [usage(7531, 2, 5, 0, 2, [60_000, 180_000, 300_000]), usage(17, 3, 3, 8000, 3)] }))
    expect(advice.map((a) => [a.severity, a.title])).toEqual([
      ['low', '自身減傷：#7531 少用 3 次（你 2 次、參考 5 次）'],
      ['low', '自身減傷：#17 平均比參考晚 8.0 秒使用'],
    ])
    expect(advice[0].detail).toContain('保住自己即可')
  })

  it('treats Sprint as movement, at most a suggestion', () => {
    const [a] = generateAdvice(input({ usage: [usage(3, 0, 6, null, 0, [10_000, 70_000])] }))
    expect(a).toMatchObject({ severity: 'medium', title: '移動：Sprint 少用 6 次（你 0 次、參考 6 次）', at: 10_000 })
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
          // 區段中有機制結算，且同時少打 GCD → 優先
          { start: 100_000, end: 110_000, maxDistance: 15, mirror: null, mechanics: [{ t: 108_000, abilityId: 5 }] },
          // 區段中有機制結算（短的也列出）→ 建議
          { start: 150_000, end: 152_000, maxDistance: 12, mirror: null, mechanics: [{ t: 151_000, abilityId: 1 }] },
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
    // 同時少打 GCD：排在最前，但站位本身最多到「建議」（停手已由停手建議列為優先）
    expect(worst).toMatchObject({ severity: 'medium', title: '1:48.0 機制「Meikyo Shisui」結算時站位與參考不同（最遠 15.0 yalm）' })
    expect(worst.detail).toMatch('少打了 GCD')
    expect(advice.find((a) => a.at === 150_000)).toMatchObject({ severity: 'medium' })
    expect(advice.find((a) => a.at === 200_000)).toMatchObject({ severity: 'low' })
    expect(advice.find((a) => a.at === 200_000)?.title).toMatch('附近沒有 Boss 機制')
    expect(advice.some((a) => a.at === 250_000)).toBe(false)
    expect(advice.find((a) => a.title.includes('不同攻略'))?.title).toMatch('左右對稱')
  })

  it('groups position differences caused by a different random mechanic into one low item', () => {
    const variant = { t: 95_000, mine: [1], ref: [5], kind: 'variant' as const }
    const advice = generateAdvice(
      input({
        divergences: [
          { start: 100_000, end: 110_000, maxDistance: 15, mirror: null, mechanics: [{ t: 104_000, abilityId: 1 }], variant },
          { start: 200_000, end: 210_000, maxDistance: 15, mirror: 'left-right', mechanics: [], variant },
        ],
        mechanics: [variant],
      }),
    )
    // 不逐段列出，也不算在「可能是不同攻略」
    expect(advice).toHaveLength(1)
    expect(advice[0]).toMatchObject({ severity: 'low', title: '2 段站位差異發生在 Boss 隨機機制不同時', at: 100_000 })
    expect(advice[0].detail).toMatch('1:40.0（你：Ikishoten；參考：Meikyo Shisui）')
  })

  it('ignores mechanics where both players stand the same relative to their own boss', () => {
    const advice = generateAdvice(
      input({
        divergences: [
          // 第一個機制相對 Boss 相同 → 標題改用第二個
          {
            start: 100_000,
            end: 110_000,
            maxDistance: 15,
            mirror: null,
            mechanics: [
              { t: 101_000, abilityId: 1, sameToBoss: true },
              { t: 108_000, abilityId: 5, sameToBoss: false },
            ],
          },
          // 全部相對 Boss 相同：不算機制結算時站位不同，也不是「附近沒有機制」
          { start: 200_000, end: 210_000, maxDistance: 20, mirror: null, mechanics: [{ t: 205_000, abilityId: 1, sameToBoss: true }] },
        ],
      }),
    )
    expect(advice.map((a) => a.title)).toEqual(['1:48.0 機制「Meikyo Shisui」結算時站位與參考不同（最遠 15.0 yalm）'])
  })

  it('groups position differences while the boss cannot be targeted into one low item', () => {
    const advice = generateAdvice(
      input({
        divergences: [
          // 轉場時機制結算、相距很遠：不列為站錯
          { start: 100_000, end: 106_000, maxDistance: 17, mirror: null, mechanics: [{ t: 101_000, abilityId: 1 }], untargetable: true },
          // 也不算在「可能是不同攻略」
          { start: 200_000, end: 210_000, maxDistance: 15, mirror: 'left-right', mechanics: [], untargetable: true },
        ],
      }),
    )
    expect(advice).toHaveLength(1)
    expect(advice[0]).toMatchObject({ severity: 'low', title: '2 段站位差異發生在 Boss 無法選中時', at: 100_000 })
    expect(advice[0].detail).toMatch('1:40.0、3:20.0。')
  })

  it('adds ability IDs when variants share a name', () => {
    const variant = { t: 95_000, mine: [42081], ref: [42079], kind: 'variant' as const }
    const [a] = generateAdvice(
      input({
        abilityName: () => "Hero's Blow",
        divergences: [{ start: 100_000, end: 110_000, maxDistance: 30, mirror: null, mechanics: [{ t: 104_000, abilityId: 42079 }], variant }],
        mechanics: [variant],
      }),
    )
    expect(a.detail).toMatch("你：Hero's Blow #42081；參考：Hero's Blow #42079")
  })
})

describe('weaving advice', () => {
  const weave = (start: number, delayMs: number) => ({ start, end: start + 3000, weaves: [{ t: start + 700, abilityId: 23 }], allowed: 2, delayMs })

  it('reports bad weaves when I have more than the reference', () => {
    const advice = generateAdvice(input({ weaving: { mine: [weave(10_000, 700), weave(20_000, 1200)], ref: [] }, subType: 'Paladin' }))
    const item = advice.find((a) => a.title.startsWith('穿插過多'))
    expect(item).toMatchObject({ severity: 'medium', title: '穿插過多 2 次，GCD 共延後 1.9 秒（參考 0 次）', at: 20_000 })
    // 不比參考多時不提
    const same = generateAdvice(input({ weaving: { mine: [weave(10_000, 700)], ref: [weave(9000, 500)] }, subType: 'Paladin' }))
    expect(same.some((a) => a.title.startsWith('穿插過多'))).toBe(false)
  })

  it('uses the scholar tiers', () => {
    const advice = generateAdvice(input({ weaving: { mine: [weave(10_000, 700)], ref: [] }, subType: 'Scholar' }))
    expect(advice.find((a) => a.title.startsWith('穿插過多'))?.severity).toBe('low')
  })
})

describe('ranged filler advice', () => {
  it('lists fillers the reference did not need around the same time', () => {
    const advice = generateAdvice(input({ fillers: { mine: [60_000, 120_000], ref: [62_000] }, fillerId: 7486 }))
    const filler = advice.find((a) => a.title.includes('（止損技）'))
    expect(filler?.title).toBe('#7486（止損技）用了 2 次（參考 1 次），其中 1 次參考沒有用')
    expect(filler?.at).toBe(120_000)
    // 參考在同一段都用了：機制造成，不提
    expect(generateAdvice(input({ fillers: { mine: [60_000], ref: [58_000] }, fillerId: 7486 })).some((a) => a.title.includes('（止損技）'))).toBe(false)
  })

  it('reports my fillers without a reference', () => {
    const advice = generateSoloAdvice({
      abilityName: (id) => `#${id}`,
      deaths: [],
      durationMs: 600_000,
      stops: [],
      windows: [],
      cooldowns: [],
      penalties: [],
      potionUses: 1,
      fillers: [30_000, 90_000, 150_000],
      fillerId: 2247,
    })
    expect(advice.map((a) => [a.severity, a.title])).toEqual([['medium', '#2247（止損技）用了 3 次']])
  })
})

describe('generateSoloAdvice', () => {
  const solo = (overrides: Partial<SoloAdviceInput> = {}): SoloAdviceInput => ({
    abilityName: (id) => names[id] ?? `#${id}`,
    deaths: [],
    durationMs: 600_000,
    stops: [],
    windows: [],
    cooldowns: [],
    penalties: [],
    potionUses: 1,
    ...overrides,
  })
  const meikyo = { key: 'meikyo', statusId: 5, expectedGcds: 3 } as unknown as WindowRule

  it('returns nothing when there is nothing to improve', () => {
    expect(generateSoloAdvice(solo())).toEqual([])
  })

  it('flags DoT uptime below the target and early refreshes', () => {
    const rule = DOT_RULES.Samurai[0]
    const dot = { rule, uptime: 78, clipPerMinMs: 35_000, clips: [{ t: 144_000, ms: 3600 }], applications: 10, gaps: [] }
    const advice = generateSoloAdvice(solo({ dots: [{ mine: dot, ref: null }] }))
    expect(advice.map((a) => [a.severity, a.title])).toEqual([
      ['high', '#1001228 覆蓋率 78.0%（目標 90%）'],
      ['medium', '#1001228 提早續上：每分鐘覆蓋掉 35.0 秒'],
    ])
    expect(advice[1].at).toBe(144_000)
    // 達到目標、沒有達到提醒門檻時不提
    expect(generateSoloAdvice(solo({ dots: [{ mine: { ...dot, uptime: 95, clipPerMinMs: 500 }, ref: null }] }))).toEqual([])
  })

  it('judges by rules only, without comparing to a reference', () => {
    const advice = generateSoloAdvice(
      solo({
        deaths: [{ t: 100_000, abilityId: 6, revivedAt: 120_000 }],
        stops: [
          { mineStart: 200_000, mineEnd: 210_000, refStart: 200_000, refEnd: 210_000, refGcds: 3 },
          { mineStart: 300_000, mineEnd: 304_000, refStart: 300_000, refEnd: 304_000, refGcds: 1, control: [5] },
        ],
        windows: [
          {
            rule: meikyo,
            judged: 2,
            passed: 1,
            windows: [
              { start: 50_000, end: 60_000, gcds: 3, issues: [], judged: true },
              { start: 400_000, end: 410_000, gcds: 2, issues: ['只打了 2 個 GCD（應 3 個）'], judged: true },
            ],
          },
        ],
        penalties: [{ statusId: 1_002_911, start: 150_000, end: 180_000 }],
        potionUses: 0,
      }),
    )
    expect(advice.map((a) => [a.severity, a.title])).toEqual([
      ['high', '你死亡了 1 次：避免死亡是最優先的改進'],
      ['high', '有 1 段停手，約少打 3 個 GCD'],
      ['high', '3:20.0 停手 10.0 秒'],
      ['medium', 'Meikyo Shisui：2 次中 1 次合格'],
      ['medium', '被施加傷害降低 1 次，共 30.0 秒'],
      ['medium', '整場沒有使用強化藥'],
      ['low', '1 段停手是 Boss 控場造成'],
    ])
    // 不和參考比較
    expect(advice.every((a) => !a.title.includes('參考'))).toBe(true)
    expect(advice[0].detail).toMatch('20.0 秒無法輸出')
  })
})
