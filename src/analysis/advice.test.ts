import { describe, expect, it } from 'vitest'
import { getJob } from '../jobs'
import { abilityCategory } from '../jobs/roleActions'
import { generateAdvice, generateAverageAdvice, generateSoloAdvice, groupAdvice, LOST_GCD_SECTION, type Advice, type AdviceInput, type SoloAdviceInput } from './advice'
import { DOT_RULES } from '../jobs/dotRules'
import { COOLDOWN_RULES } from '../jobs/cooldownRules'
import { isNonOffensiveCooldown } from './cooldowns'
import type { WindowRule } from '../jobs/windows'
import type { AbilityUsage } from './metrics'

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

describe('heal abilities', () => {
  it('lists fewer uses of a heal-only oGCD as a suggestion, not a priority', () => {
    // 1：只有治療的能力技（例如生命回生法）；2：治療 GCD（不比次數）；5：一般能力技
    const advice = generateAdvice(input({ usage: [usage(1, 4, 7), usage(2, 4, 7), usage(5, 1, 4)], isHeal: (id) => id === 1 || id === 2 }))
    const heal = advice.filter((a) => a.kind === 'heal')
    expect(heal.map((a) => [a.severity, a.title])).toEqual([['medium', '治療：Ikishoten 少用 3 次（你 4 次、參考 7 次）']])
    expect(advice.find((a) => a.title.startsWith('Meikyo Shisui'))?.severity).toBe('high')
    // 少用 1 次不提
    expect(generateAdvice(input({ usage: [usage(1, 6, 7)], isHeal: (id) => id === 1 })).some((a) => a.kind === 'heal')).toBe(false)
  })

  it('treats abilities the job data marks as heals the same way', () => {
    // 補師的即刻詠唱（7561）：日誌判斷不出來，由職業資料分類
    const ast = getJob('Astrologian')!
    const advice = generateAdvice(input({ usage: [usage(7561, 0, 3)], category: (id) => abilityCategory(id, ast) }))
    expect(advice.map((a) => [a.kind, a.severity, a.title])).toEqual([['heal', 'medium', '治療：#7561 少用 3 次（你 0 次、參考 3 次）']])
  })

  it('skips heals used very often and heals already reviewed as cooldowns', () => {
    const isHeal = (id: number) => id === 1
    // 參考用了 30 次以上（例如每次都用的治療）：次數依隊伍受傷情況，不比較
    expect(generateAdvice(input({ usage: [usage(1, 20, 31)], isHeal })).some((a) => a.kind === 'heal')).toBe(false)
    expect(generateAdvice(input({ usage: [usage(1, 20, 30)], isHeal })).some((a) => a.kind === 'heal')).toBe(true)
    // 已由冷卻技規則追蹤的不另提
    const [, , liturgy] = COOLDOWN_RULES.WhiteMage
    const tracked = { group: { ...liturgy, ids: [1] }, uses: 2, max: 5, late: [] }
    expect(generateAdvice(input({ usage: [usage(1, 2, 5)], isHeal, cooldowns: [{ mine: tracked, ref: tracked }] })).some((a) => a.kind === 'heal')).toBe(false)
  })
})

describe('generateAdvice', () => {
  it('returns nothing when there is nothing to improve', () => {
    expect(generateAdvice(input({ usage: [usage(1, 5, 5)] }))).toEqual([])
  })

  it('puts deaths first and tells the player not to die', () => {
    const advice = generateAdvice(
      input({
        deaths: {
          mine: [{ t: 120_000, abilityId: 2, revivedAt: 140_000 }],
        },
        // 死亡期間的停手：註明是因為死亡
        lost: [{ mineStart: 121_000, mineEnd: 139_000, refStart: 121_000, refEnd: 139_000, refGcds: 7 }],
      }),
    )
    expect(advice[0]).toMatchObject({ severity: 'high', title: '你死亡了 1 次：避免死亡是最優先的改進', at: 120_000 })
    expect(advice[0].detail).toContain('2:00.0（Enpi）')
    expect(advice[0].detail).toContain('20.0 秒無法輸出')
    expect(advice[0].detail).toContain('不要死亡')
    // 停手總結註明其中幾段是死亡期間
    const lost = advice.find((a) => a.title.includes('段你停手'))
    expect(lost?.detail).toContain('其中 1 段你已死亡')
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

  it('summarises lost GCD windows in one item that points to the list below', () => {
    const advice = generateAdvice(
      input({
        lost: [
          { mineStart: 10_000, mineEnd: 16_000, refStart: 10_000, refEnd: 16_000, refGcds: 3 },
          { mineStart: 60_000, mineEnd: 64_000, refStart: 60_000, refEnd: 64_000, refGcds: 1 },
        ],
      }),
    )
    // 只有一則總結，不逐段列出；「查看」捲到「少打 GCD 的時段」
    expect(advice).toHaveLength(1)
    expect(advice[0]).toMatchObject({ severity: 'high', title: '有 2 段你停手、參考仍在輸出，共少打 4 個 GCD', section: LOST_GCD_SECTION })
    expect(advice[0].at).toBeUndefined()
    expect(advice[0].detail).toContain('見下方「少打 GCD 的時段」')
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
    // 止損技直接少了輸出：列為優先，放在技能與強化藥這組
    expect(filler?.severity).toBe('high')
    expect(groupAdvice([filler!]).map((g) => g.key)).toEqual(['usage'])
    // 參考在同一段都用了：機制造成，不提
    expect(generateAdvice(input({ fillers: { mine: [60_000], ref: [58_000] }, fillerId: 7486 })).some((a) => a.title.includes('（止損技）'))).toBe(false)
    // 用得比參考少：不提
    expect(generateAdvice(input({ fillers: { mine: [60_000], ref: [20_000, 200_000] }, fillerId: 7486 })).some((a) => a.title.includes('（止損技）'))).toBe(false)
  })

  it('lists filler times in chronological order', () => {
    const advice = generateAdvice(input({ fillers: { mine: [120_000, 60_000], ref: [] }, fillerId: 7486 }))
    expect(advice.find((a) => a.title.includes('（止損技）'))?.detail).toContain('1:00.0、2:00.0')
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
    expect(advice.map((a) => [a.severity, a.title])).toEqual([['high', '#2247（止損技）用了 3 次']])
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
        penalties: [{ start: 150_000, end: 180_000 }],
        potionUses: 0,
      }),
    )
    expect(advice.map((a) => [a.severity, a.title])).toEqual([
      ['high', '你死亡了 1 次：避免死亡是最優先的改進'],
      ['high', '有 1 段停手，約少打 3 個 GCD'],
      // 懲罰效果與死亡同列為優先
      ['high', '被施加傷害降低 1 次，共 30.0 秒'],
      ['medium', 'Meikyo Shisui：2 次中 1 次合格'],
      ['medium', '整場沒有使用強化藥'],
      ['low', '1 段停手是 Boss 控場造成'],
    ])
    // 不和參考比較
    expect(advice.every((a) => !a.title.includes('參考'))).toBe(true)
    expect(advice[0].detail).toMatch('20.0 秒無法輸出')
    // 只發生一次的問題不加「（1 次）」
    expect(advice[3].detail).toBe('常見問題：只打了 2 個 GCD（應 3 個）。對照時間軸上Meikyo Shisui期間使用的技能。')
  })

  it('merges the same shortfall across windows and lists each count', () => {
    const window = (issues: string[], start: number) => ({ start, end: start + 10_000, gcds: 3, issues, judged: true })
    const [advice] = generateSoloAdvice(
      solo({
        windows: [
          {
            rule: meikyo,
            judged: 3,
            passed: 0,
            windows: [
              window(['暗影鋒、暗影波動 合計只用了 3 次（應 5 次）', '缺少：血亂'], 50_000),
              window(['暗影鋒、暗影波動 合計只用了 2 次（應 5 次）', '缺少：血亂'], 100_000),
              window(['暗影鋒、暗影波動 合計只用了 4 次（應 5 次）'], 150_000),
            ],
          },
        ],
        potionUses: null,
      }),
    )
    expect(advice.detail).toBe('常見問題：暗影鋒、暗影波動 合計只用了 3、2、4 次（應 5 次）；缺少：血亂（2 次）。對照時間軸上Meikyo Shisui期間使用的技能。')
  })
})

describe('death recap and penalty advice', () => {
  it('adds a death recap to the death advice', () => {
    const [death] = generateAdvice(
      input({
        deaths: { mine: [{ t: 100_000, abilityId: 2, revivedAt: null }] },
        deathRecaps: [
          {
            death: { t: 100_000, abilityId: 2, revivedAt: null },
            hits: [{ t: 99_000, abilityId: 2, amount: 52_980, hpBefore: 0.3, hpAfter: 0, mitigation: 0, tick: false }],
            ref: { amount: 31_005, mitigation: 0.38, died: false },
          },
        ],
      }),
    )
    expect(death.kind).toBe('death')
    expect(death.detail).toContain('1:39.0 Enpi 52,980（剩 0%）')
    expect(death.detail).toContain('參考在同一時間吃「Enpi」受到 31,005（減傷 38%），沒有死亡。')
  })

  it('reports any Damage Down without comparing with the reference', () => {
    const penalties = (count: number) => ({ mine: Array.from({ length: count }, (_, i) => ({ start: i * 10_000, end: i * 10_000 + 5000 })) })
    expect(generateAdvice(input({ penalties: penalties(0) })).some((a) => a.kind === 'penalty')).toBe(false)
    // 本來就不該被施加：不列參考的次數
    expect(generateAdvice(input({ penalties: penalties(1) })).find((a) => a.kind === 'penalty')?.title).toBe('被施加傷害降低 1 次，共 5.0 秒')
    expect(generateAdvice(input({ penalties: penalties(2) })).find((a) => a.kind === 'penalty')?.title).toBe('被施加傷害降低 2 次，共 10.0 秒')
  })

  it('ignores Damage Down removed within a second, with or without a reference', () => {
    // 施加後立刻移除（實測 40 毫秒）的不列入；滿 1 秒的列入
    const blip = [{ start: 1000, end: 1040 }]
    const second = [{ start: 1000, end: 2000 }]
    expect(generateAdvice(input({ penalties: { mine: blip } })).some((a) => a.kind === 'penalty')).toBe(false)
    expect(generateAdvice(input({ penalties: { mine: second } })).find((a) => a.kind === 'penalty')?.title).toBe('被施加傷害降低 1 次，共 1.0 秒')
    const solo = (penalties: { start: number; end: number }[]): SoloAdviceInput => ({
      abilityName: (id) => `#${id}`,
      deaths: [],
      durationMs: 600_000,
      stops: [],
      windows: [],
      cooldowns: [],
      penalties,
      potionUses: 1,
    })
    expect(generateSoloAdvice(solo(blip))).toEqual([])
    expect(generateSoloAdvice(solo([...blip, ...second])).map((a) => a.title)).toEqual(['被施加傷害降低 1 次，共 1.0 秒'])
  })
})

describe('advice kinds', () => {
  it('tags every generated advice with a kind', () => {
    const advice = generateAdvice(
      input({
        usage: [usage(1, 3, 6), usage(3, 0, 2, null, 0, [5_000])],
        lost: [{ mineStart: 10_000, mineEnd: 16_000, refStart: 10_000, refEnd: 16_000, refGcds: 3 }],
      }),
    )
    expect(advice.map((x) => x.kind)).toEqual(['gcd', 'usage', 'movement'])
  })
})
describe('groupAdvice', () => {
  const a = (severity: Advice['severity'], kind: Advice['kind'], title: string): Advice => ({ severity, kind, title, detail: '' })

  it('keeps related advice together in the tab of its most severe item', () => {
    const groups = groupAdvice([
      a('medium', 'gcd', 'stop 1'),
      a('high', 'gcd', 'stop summary'),
      a('low', 'position', 'route'),
      a('medium', 'penalty', 'damage down'),
      a('medium', 'cooldown', 'cooldown'),
      a('high', 'potion', 'potion'),
    ])
    expect(groups.map((g) => [g.key, g.severity, g.items.map((x) => x.title)])).toEqual([
      ['gcd', 'high', ['stop summary', 'stop 1']],
      ['usage', 'high', ['potion', 'cooldown']],
      ['penalty', 'medium', ['damage down']],
      ['position', 'low', ['route']],
    ])
  })

  it('orders groups of the same severity by importance', () => {
    const groups = groupAdvice([a('medium', 'position', 'p'), a('medium', 'dot', 'd'), a('medium', 'window', 'w')])
    expect(groups.map((g) => g.key)).toEqual(['window', 'dot', 'position'])
    // 穿插過多排在技能窗口與技能與強化藥之前
    expect(groupAdvice([a('medium', 'usage', 'u'), a('medium', 'weave', 'w'), a('medium', 'window', 'x')]).map((g) => g.key)).toEqual(['weave', 'window', 'usage'])
    // 組內：團隊減傷 → 自身減傷 → 移動，同類維持產生順序
    const [mitigation] = groupAdvice([
      a('medium', 'partyMitigation', 'veil'),
      a('medium', 'movement', 'sprint'),
      a('medium', 'partyMitigation', 'reprisal'),
      a('medium', 'mitigation', 'rampart'),
    ])
    expect(mitigation.items.map((x) => x.title)).toEqual(['veil', 'reprisal', 'rampart', 'sprint'])
    // 同類依時間點排序，沒有時間點的總結在前
    const [usage] = groupAdvice([
      { ...a('medium', 'cooldown', 'late'), at: 300_000 },
      { ...a('medium', 'cooldown', 'early'), at: 30_000 },
      a('medium', 'cooldown', 'summary'),
    ])
    expect(usage.items.map((x) => x.title)).toEqual(['summary', 'early', 'late'])
    // 懲罰效果緊接在死亡之後
    expect(groupAdvice([a('high', 'gcd', 'g'), a('high', 'penalty', 'p'), a('high', 'death', 'd')]).map((g) => g.key)).toEqual([
      'death',
      'penalty',
      'gcd',
    ])
  })
})
describe('cooldown advice', () => {
  const [assize, presence, liturgy] = COOLDOWN_RULES.WhiteMage
  const usageOf = (group: typeof assize, uses: number, max: number) => ({ group, uses, max, late: [] })
  const solo = (cooldowns: SoloAdviceInput['cooldowns']): SoloAdviceInput => ({
    abilityName: (id) => `#${id}`,
    deaths: [],
    durationMs: 600_000,
    stops: [],
    windows: [],
    cooldowns,
    penalties: [],
    potionUses: 1,
  })

  it('only reviews damage cooldowns against the maximum uses', () => {
    const advice = generateSoloAdvice(
      solo([
        { mine: usageOf(assize, 10, 14), ref: null },
        // 治療技能（禮儀之鈴）：不以最多可用次數檢討
        { mine: usageOf(liturgy, 2, 5), ref: null, nonOffensive: isNonOffensiveCooldown(liturgy, getJob('WhiteMage')) },
      ]),
    )
    expect(advice.map((a) => a.title)).toEqual(['#3571：最多可用 14 次，你用了 10 次'])
  })

  it('marks heal, mitigation and movement cooldowns as not offensive', () => {
    const whm = getJob('WhiteMage')
    // 法令（輸出）；神速詠唱（xivanalysis 只在建議提）；禮儀之鈴（治療，xivanalysis 只在建議提）
    expect(isNonOffensiveCooldown(assize, whm)).toBe(false)
    expect(isNonOffensiveCooldown(presence, whm)).toBe(false)
    expect(isNonOffensiveCooldown(liturgy, whm)).toBe(true)
    // 分類為治療／減傷的技能：職業資料的全大赦、職能技能的雪仇
    expect(isNonOffensiveCooldown({ ...assize, ids: [7433] }, whm)).toBe(true)
    expect(isNonOffensiveCooldown({ ...assize, ids: [7535] }, getJob('Paladin'))).toBe(true)
  })
})
describe('generateAverageAdvice', () => {
  const solo: SoloAdviceInput = {
    abilityName: (id) => names[id] ?? `#${id}`,
    deaths: [{ t: 120_000, abilityId: 2, revivedAt: 140_000 }],
    durationMs: 600_000,
    stops: [],
    windows: [],
    cooldowns: [],
    penalties: [],
    potionUses: 0,
  }

  it('words only the comparisons as against the peer average', () => {
    const compare = input({
      usage: [usage(4, 0, 2)],
      lost: [{ mineStart: 10_000, mineEnd: 16_000, refStart: 10_000, refEnd: 16_000, refGcds: 3 }],
    })
    const advice = generateAverageAdvice(solo, compare)
    // 只看自己的建議（死亡、沒用強化藥）照只有我的日誌的文字
    const own = generateSoloAdvice({ ...solo, stops: [] })
    for (const a of own) expect(advice).toContainEqual(a)
    // 與前輩平均比較的建議改稱「前輩平均」
    const compared = advice.filter((a) => !own.includes(a) && !own.some((o) => o.title === a.title))
    expect(compared.length).toBeGreaterThan(0)
    for (const a of compared) expect(`${a.title}${a.detail}`).not.toContain('參考')
    expect(compared.some((a) => `${a.title}${a.detail}`.includes('前輩平均'))).toBe(true)
    // 整場沒用強化藥已有一則，不再列「爆發藥少用」
    expect(advice.filter((a) => a.kind === 'potion').map((a) => a.title)).toEqual(['整場沒有使用強化藥'])
  })

  it('compares potions with the peer average when some were used', () => {
    const advice = generateAverageAdvice({ ...solo, deaths: [], potionUses: 1 }, input({ usage: [usage(4, 1, 2)] }))
    expect(advice.map((a) => a.title)).toEqual(['爆發藥少用 1 次（你 1 次、前輩平均 2 次）'])
  })
})

describe('burst advice', () => {
  const burst = (t: number, active: number, available: number, offsetMs: number | null) => ({
    t,
    abilityIds: [1],
    active,
    activeNames: [],
    available,
    missedNames: [],
    aligned: available === 0 ? null : active * 2 >= available,
    offsetMs,
  })
  const solo: SoloAdviceInput = {
    abilityName: (id) => names[id] ?? `#${id}`,
    deaths: [],
    durationMs: 600_000,
    stops: [],
    windows: [],
    cooldowns: [],
    penalties: [],
    potionUses: 1,
  }

  it('lists bursts that missed the raid buffs, with or without a reference', () => {
    const bursts = [burst(10_000, 4, 4, null), burst(250_000, 0, 4, 25_000), burst(370_000, 1, 4, -8000)]
    const [advice] = generateSoloAdvice({ ...solo, bursts })
    expect(advice).toMatchObject({ kind: 'burst', severity: 'high', title: '2 次爆發沒對上團隊 Buff', at: 250_000 })
    expect(advice.detail).toContain('4:10.0 Ikishoten（當時 0 個、附近最多 4 個，晚 25.0 秒）、6:10.0 Ikishoten（當時 1 個、附近最多 4 個，早 8.0 秒）')
    // 有參考時一樣只看自己；時間換成參考的時間軸
    const compared = generateAdvice(input({ bursts, mineToRef: (t) => t + 1000 })).find((a) => a.kind === 'burst')
    expect(compared).toMatchObject({ severity: 'high', at: 251_000 })
  })

  it('does not blame bursts when the party had at most one raid buff nearby', () => {
    expect(generateSoloAdvice({ ...solo, bursts: [burst(10_000, 0, 1, 5000), burst(70_000, 0, 0, null)] })).toEqual([])
    // 只錯開 1 次：建議
    expect(generateSoloAdvice({ ...solo, bursts: [burst(10_000, 0, 3, 9000)] })[0].severity).toBe('medium')
  })
})
