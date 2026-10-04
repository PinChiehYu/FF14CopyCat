import { describe, expect, it } from 'vitest'
import type { Actor, FFLogsEvent, Fight, Report } from '../fflogs/types'
import {
  actorPositions,
  autoAttacks,
  bossPositions,
  castBars,
  clipSide,
  damageTaken,
  deathAt,
  untargetableSpans,
  deaths,
  healOnlyAbilities,
  incompatibility,
  playerCasts,
  unifyPotions,
  withSharedCasters,
  withoutUnnamedBossCasts,
  type Selection,
  type SideData,
} from './load'

describe('actorPositions', () => {
  const fight = { startTime: 1000 } as Fight
  it('reads source or target resources of the actor in yalms', () => {
    const events: FFLogsEvent[] = [
      { timestamp: 3000, type: 'damage', sourceID: 9, targetID: 6, targetResources: { x: 10500, y: 9800 } },
      { timestamp: 2000, type: 'cast', sourceID: 6, sourceResources: { x: 10000, y: 10000 } },
      { timestamp: 2000, type: 'damage', sourceID: 6, sourceResources: { x: 10000, y: 10000 } }, // 同時間重複
      { timestamp: 4000, type: 'cast', sourceID: 9, sourceResources: { x: 0, y: 0 } }, // 別人
    ]
    expect(actorPositions(events, fight, 6)).toEqual([
      { t: 1000, x: 100, y: 100 },
      { t: 2000, x: 105, y: 98 },
    ])
  })

  it('ignores stale absorbed coordinates and prefers own events at the same time', () => {
    const events: FFLogsEvent[] = [
      { timestamp: 1000, type: 'cast', sourceID: 6, sourceResources: { x: 10000, y: 10000 } },
      // 護盾吸收帶的是過時的座標
      { timestamp: 2000, type: 'absorbed', sourceID: 9, targetID: 6, targetResources: { x: 9000, y: 9000 } },
      // 同一時間：別人對我的治療排在前面，但自己施放的較可靠
      { timestamp: 3000, type: 'heal', sourceID: 9, targetID: 6, targetResources: { x: 10300, y: 10000 } },
      { timestamp: 3000, type: 'cast', sourceID: 6, sourceResources: { x: 10200, y: 10000 } },
    ]
    expect(actorPositions(events, fight, 6)).toEqual([
      { t: 0, x: 100, y: 100 },
      { t: 2000, x: 102, y: 100 },
    ])
  })

  it('removes there-and-back spikes but keeps one-way dashes', () => {
    const cast = (t: number, x: number) => ({ timestamp: t, type: 'cast', sourceID: 6, sourceResources: { x: x * 100, y: 10000 } })
    const events: FFLogsEvent[] = [
      cast(1000, 100),
      cast(1500, 100.2),
      cast(1550, 98), // 0.05 秒跳回 2.2 yalm 又回來：尖點
      cast(1600, 100.3),
      cast(2000, 100.5),
      cast(2300, 110), // 衝刺：單向，保留
      cast(2600, 110.2),
    ]
    expect(actorPositions(events, fight, 6).map((s) => s.x)).toEqual([100, 100.2, 100.3, 100.5, 110, 110.2])
  })
})

describe('bossPositions', () => {
  const fight = { startTime: 0 } as Fight
  const enemy = (id: number, subType: string): Actor => ({ id, name: 'Howling Blade', type: 'NPC', subType, server: null, petOwner: null, gameID: 0 })
  // 84 號是隱形的機制施放者（施放最多、subType NPC），80、107 號是兩個階段的 Boss 本體
  const actors = [enemy(84, 'NPC'), enemy(80, 'Boss'), enemy(107, 'Boss')]
  const enemyEvents: FFLogsEvent[] = [
    { timestamp: 1000, type: 'cast', sourceID: 84, sourceResources: { x: 10000, y: 10000 } },
    { timestamp: 2000, type: 'cast', sourceID: 84, sourceResources: { x: 10000, y: 10000 } },
    { timestamp: 3000, type: 'cast', sourceID: 84, sourceResources: { x: 10000, y: 10000 } },
    { timestamp: 1500, type: 'cast', sourceID: 80, sourceResources: { x: 10000, y: 9000 } },
    { timestamp: 9000, type: 'cast', sourceID: 107, sourceResources: { x: 11000, y: 10000 } },
  ]
  // 玩家攻擊 Boss 的事件：目標位置
  const playerEvents: FFLogsEvent[] = [{ timestamp: 2500, type: 'damage', sourceID: 6, targetID: 80, targetResources: { x: 10100, y: 9000 } }]

  it('uses the actors whose subType is Boss, from boss casts and player events', () => {
    expect(bossPositions(actors, enemyEvents, playerEvents, fight)).toEqual([
      { t: 1500, x: 100, y: 90 },
      { t: 2500, x: 101, y: 90 },
      { t: 9000, x: 110, y: 100 },
    ])
  })

  it('falls back to the enemy with the most casts when no actor is a Boss', () => {
    expect(bossPositions([enemy(84, 'NPC')], enemyEvents, [], fight).map((p) => p.t)).toEqual([1000, 2000, 3000])
  })
})

describe('playerCasts', () => {
  const fight = { startTime: 1000 } as Fight
  const ev = (timestamp: number, type: string, abilityGameID: number): FFLogsEvent => ({ timestamp, type, abilityGameID })

  it('uses the begincast time for cast-bar abilities and drops interrupted casts', () => {
    const events = [
      ev(2000, 'cast', 1), // 瞬發
      ev(3000, 'begincast', 2),
      ev(4300, 'cast', 2), // 詠唱 1.3 秒
      ev(5000, 'begincast', 3), // 被打斷，沒有 cast
      ev(6000, 'cast', 4),
    ]
    expect(playerCasts(events, fight)).toEqual([
      { t: 1000, abilityId: 1 },
      { t: 2000, abilityId: 2 },
      { t: 5000, abilityId: 4 },
    ])
  })

  it('drops begincasts cancelled by a later cast', () => {
    // 詠唱 Fall Malefic 被移動取消 → 瞬發 Combust → 之後瞬發（例如即刻詠唱）Fall Malefic
    const events = [
      ev(10_000, 'begincast', 1),
      ev(10_500, 'cast', 2),
      ev(12_000, 'cast', 1),
    ]
    expect(playerCasts(events, fight)).toEqual([
      { t: 9500, abilityId: 2 },
      { t: 11_000, abilityId: 1 }, // 不是過期的 begincast（9000）
    ])
  })

  it('separates auto-attacks from other casts', () => {
    const events = [
      { timestamp: 2000, type: 'cast', abilityGameID: 7, sourceID: 6 }, // Attack
      { timestamp: 2500, type: 'cast', abilityGameID: 8, sourceID: 6 }, // Shot
      { timestamp: 2800, type: 'cast', abilityGameID: 7, sourceID: 9 }, // 別人的普通攻擊
      { timestamp: 3000, type: 'cast', abilityGameID: 9, sourceID: 6 },
    ]
    expect(playerCasts(events, fight, 6)).toEqual([{ t: 2000, abilityId: 9 }])
    expect(autoAttacks(events, fight, 6)).toEqual([
      { t: 1000, abilityId: 7 },
      { t: 1500, abilityId: 8 },
    ])
  })

  it('keeps only casts by the given actor', () => {
    const events = [
      { timestamp: 2000, type: 'cast', abilityGameID: 1, sourceID: 6 },
      { timestamp: 3000, type: 'cast', abilityGameID: 2, sourceID: 7 }, // 別人對玩家施放
    ]
    expect(playerCasts(events, fight, 6)).toEqual([{ t: 1000, abilityId: 1 }])
  })
})

function selection(encounterID: number, subType: string): Selection {
  const fight = { id: 1, name: `Boss ${encounterID}`, encounterID } as Fight
  const player = { id: 1, name: 'p', subType } as Actor
  return { report: {} as Report, fight, player }
}

describe('healOnlyAbilities', () => {
  it('finds abilities that only heal, also when the heal is recorded on the effect of the same name', () => {
    const names: Record<number, string> = {
      189: 'Lustrate',
      7434: 'Excogitation',
      1001220: 'Excogitation',
      167: 'Energy Drain',
      7436: 'Chain Stratagem',
    }
    const ev = (type: string, abilityGameID: number, sourceID = 6) => ({ timestamp: 0, type, sourceID, abilityGameID }) as FFLogsEvent
    const events = [
      ev('cast', 189),
      ev('heal', 189),
      // 治療記在同名效果上
      ev('cast', 7434),
      ev('heal', 1001220),
      // 有傷害也有治療：不算
      ev('cast', 167),
      ev('damage', 167),
      ev('heal', 167),
      // 不治療的團隊 Buff
      ev('cast', 7436),
      // 別人的治療不算
      ev('heal', 7436, 9),
    ]
    expect(healOnlyAbilities(events, 6, (id) => names[id]).sort((a, b) => a - b)).toEqual([189, 7434])
  })
})

describe('deaths', () => {
  it('finds deaths with the killing blow and the time the player acts again', () => {
    const fight = { startTime: 1000, endTime: 60_000 } as Fight
    const list = deaths(
      [
        { timestamp: 9000, type: 'damage', sourceID: 50, targetID: 2, abilityGameID: 42075 },
        { timestamp: 10_000, type: 'death', sourceID: 50, targetID: 2, killingAbilityGameID: 42075 },
        { timestamp: 15_000, type: 'cast', sourceID: 9, targetID: 2, abilityGameID: 125 }, // 別人復活我
        { timestamp: 21_000, type: 'cast', sourceID: 2, targetID: 50, abilityGameID: 3577 },
        { timestamp: 30_000, type: 'damage', sourceID: 50, targetID: 2, abilityGameID: 42078 },
        { timestamp: 31_000, type: 'death', sourceID: 50, targetID: 2, abilityGameID: 0 }, // 沒有致命一擊：取最後受到的傷害
      ],
      fight,
      2,
    )
    expect(list).toEqual([
      { t: 9000, abilityId: 42075, revivedAt: 20_000 },
      { t: 30_000, abilityId: 42078, revivedAt: null },
    ])
    expect(deathAt(list, 15_000)?.t).toBe(9000)
    expect(deathAt(list, 25_000)).toBeUndefined()
    expect(deathAt(list, 50_000)?.t).toBe(30_000)
  })
})

describe('damageTaken', () => {
  it('collects enemy hits on the player with mitigation and HP', () => {
    const fight = { startTime: 1000, endTime: 60_000 } as Fight
    const actors = [
      { id: 2, type: 'Player' },
      { id: 3, type: 'Pet' },
      { id: 50, type: 'NPC' },
    ] as Actor[]
    const hits = damageTaken(
      [
        { timestamp: 5000, type: 'calculateddamage', sourceID: 50, targetID: 2, abilityGameID: 42831, amount: 19_275 },
        {
          timestamp: 5200,
          type: 'damage',
          sourceID: 50,
          targetID: 2,
          abilityGameID: 42831,
          amount: 19_275,
          absorbed: 80_936,
          unmitigatedAmount: 170_237,
          multiplier: 0.59,
          targetResources: { hitPoints: 151_317, maxHitPoints: 170_592 },
        },
        { timestamp: 6000, type: 'damage', sourceID: 2, targetID: 50, abilityGameID: 100, amount: 5000 }, // 我打敵人
        { timestamp: 6500, type: 'damage', sourceID: 3, targetID: 2, abilityGameID: 101, amount: 10 }, // 寵物（友方）
        { timestamp: 7000, type: 'damage', sourceID: -1, targetID: 2, abilityGameID: 1_004_449, amount: 14_571, tick: true },
        { timestamp: 7000, type: 'damage', sourceID: 50, targetID: 2, abilityGameID: 500_000, amount: 14_571, tick: true }, // 重複的跳傷
      ],
      fight,
      2,
      actors,
    )
    expect(hits).toEqual([
      { t: 4200, abilityId: 42831, amount: 100_211, unmitigated: 170_237, multiplier: 0.59, tick: false, hpAfter: 151_317, maxHp: 170_592 },
      { t: 6000, abilityId: 1_004_449, amount: 14_571, unmitigated: 14_571, multiplier: null, tick: true, hpAfter: null, maxHp: null },
    ])
  })
})
describe('castBars', () => {
  it('pairs begincast with its cast and marks cancelled casts', () => {
    const fight = { startTime: 1000, endTime: 60_000 } as Fight
    const e = (timestamp: number, type: string, abilityGameID: number, extra = {}) => ({
      timestamp,
      type,
      sourceID: 2,
      abilityGameID,
      ...extra,
    })
    const bars = castBars(
      [
        e(2000, 'begincast', 3577, { duration: 1660 }), // 炎之四：完成
        e(3660, 'cast', 3577),
        e(4000, 'begincast', 152, { duration: 3500 }), // 爆炎：被瞬發的技能取消
        e(5000, 'cast', 16505),
        e(6000, 'cast', 7), // 普通攻擊不計
        e(8000, 'begincast', 3577, { duration: 1660 }), // 戰鬥結束時仍在詠唱
      ],
      fight,
      2,
    )
    expect(bars).toEqual([
      { abilityId: 3577, start: 1000, end: 2660, interrupted: false },
      { abilityId: 152, start: 3000, end: 4000, interrupted: true },
      { abilityId: 3577, start: 7000, end: 8660, interrupted: true },
    ])
  })
})

describe('clipSide', () => {
  it('drops data after the end time', () => {
    const side: SideData = {
      selection: {} as Selection,
      playerCasts: [
        { t: 1000, abilityId: 1 },
        { t: 9000, abilityId: 1 },
      ],
      autoAttacks: [{ t: 8000, abilityId: 7 }],
      bossCasts: [{ t: 5000, abilityId: 2 }],
      playerPositions: [
        { t: 4000, x: 100, y: 100 },
        { t: 6000, x: 100, y: 100 },
      ],
      bossPositions: [],
      buffs: [
        { statusId: 1_001_233, start: 1000, end: 3000, prepull: false, openEnded: false },
        { statusId: 1_001_233, start: 4000, end: 7000, prepull: false, openEnded: false },
        { statusId: 1_001_233, start: 6000, end: 8000, prepull: false, openEnded: false },
      ],
      debuffApplications: [
        { t: 3000, statusId: 1_003_849, targetId: 50 },
        { t: 6000, statusId: 1_003_849, targetId: 50 },
      ],
      // 傷害降低等敵人給的 debuff（懲罰與控場用）
      bossDebuffs: [
        { statusId: 1_002_911, start: 1000, end: 2000, prepull: false, openEnded: false },
        { statusId: 1_002_911, start: 4500, end: 9000, prepull: false, openEnded: false },
        { statusId: 1_002_911, start: 6000, end: 7000, prepull: false, openEnded: false },
      ],
      prepull: [],
      auras: [],
      hp: [],
      castBars: [],
      damageTaken: [],
      deaths: [{ t: 9000, abilityId: 1, revivedAt: null }],
      untargetable: [
        { start: 2000, end: 3000 },
        { start: 4000, end: 7000 },
        { start: 8000, end: 9000 },
      ],
      duration: 10_000,
    }
    const clipped = clipSide(side, 5000)
    // 跨過結束點的窗口截斷並標為未結束，之後才開始的不計
    expect(clipped.buffs.map((b) => [b.end, b.openEnded])).toEqual([
      [3000, false],
      [5000, true],
    ])
    expect(clipped.bossDebuffs.map((b) => [b.start, b.end, b.openEnded])).toEqual([
      [1000, 2000, false],
      [4500, 5000, true],
    ])
    expect(clipped.debuffApplications.map((d) => d.t)).toEqual([3000])
    expect(clipped.playerCasts).toEqual([{ t: 1000, abilityId: 1 }])
    expect(clipped.deaths).toEqual([])
    expect(clipped.autoAttacks).toEqual([])
    expect(clipped.bossCasts).toHaveLength(1)
    expect(clipped.playerPositions).toHaveLength(1)
    expect(clipped.duration).toBe(5000)
    // 無法選中的時段截到結束點
    expect(clipped.untargetable).toEqual([
      { start: 2000, end: 3000 },
      { start: 4000, end: 5000 },
    ])
  })
})

describe('untargetableSpans', () => {
  const actor = (id: number, subType: string) => ({ id, subType }) as Actor
  const fight = { startTime: 100_000, endTime: 700_000 }
  const at = (s: number, sourceID: number, targetable: boolean) => ({ timestamp: 100_000 + s * 1000, sourceID, targetable })

  it('finds the spans when no boss can be targeted', () => {
    // 實例（M8S BF76r8yKh4wGaYkm #10）：3:01.6 召喚光狼時 Boss 無法選中、4:00.2 回來；6:40.1 轉場，7:25.6 第二階段的 Boss 本體（另一個角色）出現
    // 光狼（NPC）可否選中不影響
    const actors = [actor(110, 'Boss'), actor(116, 'NPC'), actor(127, 'Boss')]
    const changes = [at(181.6, 110, false), at(190.9, 116, true), at(239.5, 116, false), at(240.2, 110, true), at(400.1, 110, false), at(445.6, 127, true)]
    expect(untargetableSpans(changes, actors, fight)).toEqual([
      { start: 181_600, end: 240_200 },
      { start: 400_100, end: 445_600 },
    ])
  })

  it('drops very short spans and keeps one open until the fight ends', () => {
    const changes = [at(10, 1, false), at(10.5, 1, true), at(500, 1, false)]
    expect(untargetableSpans(changes, [actor(1, 'Boss')], fight)).toEqual([{ start: 500_000, end: 600_000 }])
  })
})

describe('unifyPotions', () => {
  const side = (casts: [number, number][], medicatedAt: number[]): SideData => ({
    selection: {} as Selection,
    playerCasts: casts.map(([t, abilityId]) => ({ t, abilityId })),
    autoAttacks: [],
    bossCasts: [],
    playerPositions: [],
    bossPositions: [],
    buffs: medicatedAt.map((start) => ({ statusId: 1_000_049, start, end: start + 30_000, prepull: false, openEnded: false })),
    debuffApplications: [],
    bossDebuffs: [],
    prepull: [],
    auras: [],
    hp: [],
    castBars: [],
    damageTaken: [],
    deaths: [],
    untargetable: [],
    duration: 600_000,
  })

  it('treats items followed by the Medicated effect as the same potion on both sides', () => {
    const potion = 0x2000000 + 1_045_995 // 剛力之寶藥 3 級 HQ
    const chakrams = 0x2000000 + 1_046_026 // 繁中服 2026-08 的日誌吃藥時記成的道具（國際服資料為武器）
    const food = 0x2000000 + 46_000
    const { mine, ref, potionId } = unifyPotions(
      side([[6000, potion], [360_000, potion]], [6500, 360_500]),
      side([[6600, chakrams], [374_000, chakrams], [1000, food]], [7000, 374_300]),
    )
    expect(potionId).toBe(potion)
    expect(mine.playerCasts.map((c) => c.abilityId)).toEqual([potion, potion])
    // 沒有得到強化藥效果的道具（食物）不變
    expect(ref.playerCasts.map((c) => c.abilityId)).toEqual([potion, potion, food])
  })

  it('uses the reference potion when I did not drink one', () => {
    const chakrams = 0x2000000 + 1_046_026
    const { mine, potionId } = unifyPotions(side([], []), side([[6600, chakrams]], [7000]))
    expect(potionId).toBe(chakrams)
    expect(mine.playerCasts).toEqual([])
  })
})

describe('incompatibility', () => {
  it('accepts same encounter and job', () => {
    expect(incompatibility(selection(98, 'Viper'), selection(98, 'Viper'))).toBeNull()
  })

  it('rejects different encounters or jobs', () => {
    expect(incompatibility(selection(98, 'Viper'), selection(99, 'Viper'))).toMatch('Boss')
    expect(incompatibility(selection(98, 'Viper'), selection(98, 'Samurai'))).toMatch('職業不同（毒蛇劍士 / 武士）')
  })
})

describe('boss cast filters', () => {
  const side = (bossCasts: SideData['bossCasts'], abilities: { gameID: number; name: string }[] = []): SideData => ({
    selection: { report: { masterData: { abilities } } } as unknown as Selection,
    playerCasts: [],
    autoAttacks: [],
    bossCasts,
    playerPositions: [],
    bossPositions: [],
    buffs: [],
    debuffApplications: [],
    bossDebuffs: [],
    prepull: [],
    auras: [],
    hp: [],
    castBars: [],
    damageTaken: [],
    deaths: [],
    untargetable: [],
    duration: 600_000,
  })

  it('keeps only casters present in both logs and casts without a known caster', () => {
    // 施放者 18000 只在我的日誌中（例如只被一邊記錄的雜兵）；沒有 source 的是臨時編號的施放者，一律保留
    const [mine, ref] = withSharedCasters(
      side([{ t: 1000, abilityId: 1, source: 17000 }, { t: 2000, abilityId: 2, source: 18000 }, { t: 3000, abilityId: 3 }]),
      side([{ t: 1000, abilityId: 1, source: 17000 }, { t: 4000, abilityId: 4 }]),
    )
    expect(mine.bossCasts.map((c) => c.abilityId)).toEqual([1, 3])
    expect(ref.bossCasts.map((c) => c.abilityId)).toEqual([1, 4])
  })

  it('removes boss casts without a name', () => {
    const filtered = withoutUnnamedBossCasts(
      side(
        [{ t: 1000, abilityId: 42693 }, { t: 2000, abilityId: 42694 }, { t: 3000, abilityId: 42695 }],
        [
          { gameID: 42693, name: 'unknown_a6c5' },
          { gameID: 42694, name: '' },
          { gameID: 42695, name: 'Deep Cut' },
        ],
      ),
    )
    expect(filtered.bossCasts.map((c) => c.abilityId)).toEqual([42695])
  })
})
