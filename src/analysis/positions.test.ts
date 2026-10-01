import { describe, expect, it } from 'vitest'
import { alignToBoss, attachBossDistances, divergenceKind, attachMechanics, attachUntargetable, attachVariants, bossPoseAt, positionMechanics, compareTracks, divergences, positionAt, toBossFrame, type PositionSample } from './positions'

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
    const [d] = divergences(compareTracks(mine, refP, refBoss, 30_000, { arenaCenter: { x: 100, y: 100 } }))
    expect(d.maxDistance).toBeGreaterThan(20)
    expect(d.mirror).toBe('left-right')
    expect(d.bossFrame).toBeUndefined()
  })

  // 面向朝北（畫面 −y）：θ = −π/2
  const north = -Math.PI / 2
  // 面向只沿用前後 5 秒內的取樣，每秒一筆
  const posed = (x: number, y: number, facing: number) => Array.from({ length: 31 }, (_, sec) => ({ ...s(sec, x, y), facing }))

  it('judges by each side’s own boss when the two bosses stand apart', () => {
    // 兩場 Boss 分站左右平台、都面向場中心；兩人都站在自己 Boss 正面 5 yalm → 場地上相距 30，但相對 Boss 相同
    const refBoss = posed(80, 100, 0) // 面向東
    const mineBoss = posed(120, 100, Math.PI) // 面向西
    const ref = Array.from({ length: 31 }, (_, i) => s(i, 85, 100))
    const mine = Array.from({ length: 31 }, (_, i) => s(i, 115, 100))
    const track = compareTracks(mine, ref, refBoss, 30_000, { mineBoss })
    const p = track.find((q) => q.t === 10_000)!
    expect(p.bossFrame).toBe(true)
    expect(p.bossGap).toBe(40)
    expect(p.arenaDistance).toBe(30)
    expect(p.distance).toBeCloseTo(0)
    expect(divergences(track)).toEqual([])
  })

  it('finds differences relative to the bosses even when the players stand together', () => {
    // 兩人站在一起（場地中央），但我在我的 Boss 正面、參考在參考的 Boss 背後
    const refBoss = posed(80, 100, Math.PI) // 背對場中心
    const mineBoss = posed(120, 100, Math.PI) // 面向場中心
    const ref = Array.from({ length: 31 }, (_, i) => s(i, 100, 100))
    const mine = Array.from({ length: 31 }, (_, i) => s(i, 100, 101))
    const [d] = divergences(compareTracks(mine, ref, refBoss, 30_000, { mineBoss }))
    expect(d.bossFrame).toBe(true)
    expect(d.bossGap).toBe(40)
    expect(d.maxDistance).toBeGreaterThan(30)
  })

  it('keeps arena distances when the two bosses stand together or a facing is missing', () => {
    const refBoss = posed(100, 100, north)
    const ref = Array.from({ length: 31 }, (_, i) => s(i, 95, 100))
    const mine = Array.from({ length: 31 }, (_, i) => s(i, 95, 112))
    // 兩場 Boss 相距 5 yalm（門檻內）
    const near = compareTracks(mine, ref, refBoss, 30_000, { mineBoss: posed(100, 105, north) })
    expect(near.every((p) => !p.bossFrame)).toBe(true)
    expect(near.find((p) => p.t === 10_000)?.distance).toBe(12)
    // 相距 40 yalm 但我的 Boss 沒有面向資料
    const noFacing = compareTracks(mine, ref, refBoss, 30_000, { mineBoss: [s(0, 140, 100), s(30, 140, 100)] })
    expect(noFacing.every((p) => !p.bossFrame)).toBe(true)
  })

  it('classifies each divergence into exactly one kind', () => {
    const base = { start: 0, end: 5000, maxDistance: 10, mirror: null, mechanics: [] }
    const mech = [{ abilityId: 1, t: 1000 }]
    const variant = { t: 0, mine: [1], ref: [2], kind: 'variant' as const }
    expect(divergenceKind({ ...base, variant, untargetable: true, mirror: 'point' })).toBe('variant')
    expect(divergenceKind({ ...base, untargetable: true, mirror: 'point', mechanics: mech })).toBe('untargetable')
    // 對稱且有機制結算：算對稱（不列為站錯），不再同時算「機制」
    expect(divergenceKind({ ...base, mirror: 'point', mechanics: mech })).toBe('mirror')
    expect(divergenceKind({ ...base, mechanics: mech })).toBe('mechanic')
    expect(divergenceKind({ ...base, mechanics: [{ ...mech[0], sameToBoss: true }] })).toBe('same-to-boss')
    expect(divergenceKind(base)).toBe('route')
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
    const [a, b] = attachMechanics(divs, { mine: [], ref: boss, mineToRef: (t) => t }, distance, 8)
    expect(a.mechanics.map((m) => m.abilityId)).toEqual([2])
    expect(b.mechanics).toEqual([])
    // 排列先後用：區段開始前 5 秒內起的施放都附上（不看當下距離），9.5 秒的 1 在內
    expect(a.nearbyCasts?.filter((c) => c.abilityId !== 99)).toEqual([
      { abilityId: 1, t: 9500 },
      { abilityId: 2, t: 13_000 },
      { abilityId: 3, t: 15_500 },
    ])
  })

  it('lists the mechanics of both sides, pairing the same ability within 5 seconds', () => {
    const divs = [{ start: 10_000, end: 20_000, maxDistance: 10, mirror: null, mechanics: [] }]
    // 我的時間比參考晚 2 秒
    const mineToRef = (t: number) => t - 2000
    const ref = [
      { t: 12_000, abilityId: 1 }, // 我在 14.5 秒（參考時間 12.5）結算 → 合成一筆
      { t: 18_000, abilityId: 2 }, // 我這邊沒有 → 只有參考
    ]
    const mine = [
      { t: 14_500, abilityId: 1 },
      { t: 17_000, abilityId: 3 }, // 參考時間 15 秒、只有我
      { t: 40_000, abilityId: 2 }, // 相差太遠，不與參考的 2 配對
    ]
    const [d] = attachMechanics(divs, { mine, ref, mineToRef }, () => 10, 8)
    expect(d.mechanics).toEqual([
      { abilityId: 1, t: 12_000, ref: 12_000, mine: 14_500 },
      { abilityId: 3, t: 15_000, mine: 17_000 },
      { abilityId: 2, t: 18_000, ref: 18_000, mine: undefined },
    ])
  })

  it('measures distances to each side’s own boss and flags positions that match relative to the boss', () => {
    const at = (t: number, x: number, y: number) => [s(t / 1000 - 1, x, y), s(t / 1000 + 1, x, y)]
    // Boss 都面向北（畫面 −y）
    const bossAt = (t: number, x: number, y: number) => at(t, x, y).map((p) => ({ ...p, facing: -Math.PI / 2 }))
    const d = {
      start: 0,
      end: 20_000,
      maxDistance: 20,
      mirror: null,
      mechanics: [
        { abilityId: 1, t: 5000 },
        { abilityId: 2, t: 15_000 },
      ],
    }
    const [out] = attachBossDistances(
      [d],
      {
        // 5 秒：兩場 Boss 相差 20 yalm、兩人都在各自 Boss 北方 5 yalm → 相對位置相同
        // 15 秒：我在 Boss 北方 5、參考在 Boss 南方 5 → 相對差 10
        mine: [...at(5000, 120, 95), ...at(15_000, 120, 95)],
        ref: [...at(5000, 100, 95), ...at(15_000, 100, 105)],
        mineBoss: [...bossAt(5000, 120, 100), ...bossAt(15_000, 120, 100)],
        refBoss: [...bossAt(5000, 100, 100), ...bossAt(15_000, 100, 100)],
      },
      8,
    )
    expect(out.mechanics[0]).toMatchObject({ mineToBoss: 5, refToBoss: 5, sameToBoss: true })
    expect(out.mechanics[1]).toMatchObject({ mineToBoss: 5, refToBoss: 5, sameToBoss: false })
    expect(positionMechanics(out).map((m) => m.abilityId)).toEqual([2])
  })

  it('compares relative positions by each boss’s facing', () => {
    // 兩場 Boss 面向相反，兩人都站在自己 Boss 正面 5 yalm：只平移會差 10，依面向旋轉後相同
    const d = { start: 0, end: 10_000, maxDistance: 30, mirror: null, mechanics: [{ abilityId: 1, t: 5000 }] }
    const [out] = attachBossDistances(
      [d],
      {
        mine: [s(4, 115, 100), s(6, 115, 100)],
        ref: [s(4, 85, 100), s(6, 85, 100)],
        mineBoss: [s(4, 120, 100), s(6, 120, 100)].map((p) => ({ ...p, facing: Math.PI })),
        refBoss: [s(4, 80, 100), s(6, 80, 100)].map((p) => ({ ...p, facing: 0 })),
      },
      8,
    )
    expect(out.mechanics[0].sameToBoss).toBe(true)
  })

  it('does not judge relative positions without boss positions', () => {
    const [out] = attachBossDistances(
      [{ start: 0, end: 10_000, maxDistance: 20, mirror: null, mechanics: [{ abilityId: 1, t: 5000 }] }],
      { mine: [s(4, 120, 95), s(6, 120, 95)], ref: [s(4, 100, 95), s(6, 100, 95)], mineBoss: [], refBoss: [] },
      8,
    )
    expect(out.mechanics[0]).toMatchObject({ mineToBoss: null, refToBoss: null, sameToBoss: false })
  })

  it('marks divergences overlapping a span when the boss cannot be targeted', () => {
    const d = (start: number, end: number) => ({ start, end, maxDistance: 10, mirror: null, mechanics: [] })
    const [a, b] = attachUntargetable([d(10_000, 20_000), d(30_000, 40_000)], [{ start: 18_000, end: 25_000 }])
    expect(a.untargetable).toBe(true)
    expect(b.untargetable).toBeUndefined()
  })

  it('attaches a random mechanic variant during or shortly before a divergence', () => {
    const d = (start: number, end: number) => ({ start, end, maxDistance: 10, mirror: null, mechanics: [] })
    const variant = { t: 25_000, mine: [1], ref: [2], kind: 'variant' as const }
    const onlyMine = { t: 60_000, mine: [3], ref: [], kind: 'only-mine' as const }
    const [a, b, c] = attachVariants([d(30_000, 40_000), d(50_000, 70_000), d(20_000, 24_000)], [variant, onlyMine])
    expect(a.variant).toBe(variant) // 區段開始前 5 秒（10 秒內）
    expect(b.variant).toBeUndefined() // 只有一邊有的不算隨機變化
    expect(c.variant).toBeUndefined() // 區段結束後
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

describe('alignToBoss', () => {
  it('moves my position by the offset between the two bosses and keeps it where a boss is missing', () => {
    // 我那場 Boss 在 (110, 100)、參考的在 (100, 100)：我在自己 Boss 左方 5 yalm，對齊後在參考 Boss 左方 5 yalm
    const mine = [
      { t: 0, x: 105, y: 100 },
      { t: 60_000, x: 50, y: 50 },
    ]
    const mineBoss = [{ t: 0, x: 110, y: 100 }]
    const refBoss = [{ t: 0, x: 100, y: 100 }]
    expect(alignToBoss(mine, mineBoss, refBoss)).toEqual([
      { t: 0, x: 95, y: 100 },
      // 60 秒時沒有 Boss 位置（超過沿用時間）：維持原始位置
      { t: 60_000, x: 50, y: 50 },
    ])
  })
})
