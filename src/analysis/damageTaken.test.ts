import { describe, expect, it } from 'vitest'
import { damageRows, deathRecap, notableRows } from './damageTaken'
import type { DamageHit } from '../compare/load'

const MAX_HP = 100_000
const hit = (t: number, abilityId: number, amount = 30_000, over: Partial<DamageHit> = {}): DamageHit => ({
  t,
  abilityId,
  amount,
  unmitigated: amount,
  multiplier: 1,
  tick: false,
  hpAfter: 50_000,
  maxHp: MAX_HP,
  ...over,
})
const identity = (t: number) => t
const noAuto = () => false

describe('damageRows', () => {
  it('flags hits the reference did not take at the aligned time', () => {
    // 我在 10 秒、60 秒被 A 打中；參考只在 11 秒被打中（對齊後 ±5 秒內）→ 60 秒那一擊是多吃
    const rows = damageRows([hit(10_000, 1), hit(60_000, 1)], [hit(11_000, 1)], identity, [], noAuto)
    expect(rows[0].flagged.map((h) => h.t)).toEqual([60_000])
  })

  it('does not flag when the reference was hit as often at another time', () => {
    // 隨機點名：兩邊各被打中一次，但時間不同
    const rows = damageRows([hit(10_000, 1)], [hit(30_000, 1)], identity, [], noAuto)
    expect(rows[0].flagged).toEqual([])
  })

  it('flags only the extra count, penalized hits first', () => {
    // 我 3 次、參考 1 次（時間都對不上）→ 最多列 2 次，受到懲罰的優先
    const rows = damageRows([hit(10_000, 1), hit(40_000, 1), hit(70_000, 1)], [hit(100_000, 1)], identity, [69_000], noAuto)
    expect(rows[0].flagged.map((h) => [h.t, h.penalized])).toEqual([
      [10_000, false],
      [70_000, true],
    ])
  })

  it('merges abilities with the same key into one row', () => {
    const rows = damageRows([hit(10_000, 1), hit(20_000, 2)], [hit(10_000, 1), hit(20_000, 2)], identity, [], noAuto, () => 'same')
    expect(rows).toHaveLength(1)
    expect(rows[0].mine.count).toBe(2)
  })
  it('uses the alignment to compare times', () => {
    // 我的時間比參考晚 20 秒：我的 30 秒對到參考的 10 秒
    const rows = damageRows([hit(30_000, 1)], [hit(10_000, 1)], (t) => t - 20_000, [], noAuto)
    expect(rows[0].flagged).toEqual([])
  })

  it('merges hits of one mechanic and marks penalties applied around the hit', () => {
    // 同一機制在 1 秒內打兩下；受傷加重在命中判定時施加，比扣血的傷害事件早 1.4 秒
    const rows = damageRows([hit(20_000, 1), hit(20_400, 1)], [], identity, [18_600], noAuto)
    expect(rows[0].flagged).toEqual([{ t: 20_000, abilityId: 1, amount: 60_000, penalized: true }])
  })

  it('ignores DoT ticks and does not flag boss auto-attacks', () => {
    const rows = damageRows([hit(5_000, 7), hit(6_000, 1_004_449, 5_000, { tick: true })], [], identity, [], (id) => id === 7)
    expect(rows.map((r) => r.abilityId)).toEqual([7])
    expect(rows[0].flagged).toEqual([])
  })

  it('only flags penalized hits without a reference', () => {
    const rows = damageRows([hit(10_000, 1), hit(40_000, 1)], null, identity, [40_300], noAuto)
    expect(rows[0].ref).toBeNull()
    expect(rows[0].flagged.map((h) => h.t)).toEqual([40_000])
  })

  it('marks a mitigation gap only on big hits', () => {
    // 大傷害（未減傷 50% 血量）：我減 10%、參考減 30% → 標；小傷害不標
    const big = (t: number, m: number) => hit(t, 1, 50_000 * m, { unmitigated: 50_000, multiplier: m })
    const small = (t: number, m: number) => hit(t, 2, 5_000 * m, { unmitigated: 5_000, multiplier: m })
    const rows = damageRows([big(10_000, 0.9), small(20_000, 0.9)], [big(10_000, 0.7), small(20_000, 0.7)], identity, [], noAuto)
    const byId = new Map(rows.map((r) => [r.abilityId, r]))
    expect(byId.get(1)!.mine.mitigation).toBeCloseTo(0.1)
    expect(byId.get(1)!.mitigationGap).toBe(true)
    expect(byId.get(2)!.mitigationGap).toBe(false)
    expect(notableRows(rows).map((r) => r.abilityId)).toEqual([1])
  })

  it('treats a multi-hit mechanic as one big hit', () => {
    // 每擊 5% 血量、0.5 秒一擊打 4 下 → 每次合計 20%，算大傷害
    const multi = (t0: number, m: number) => [0, 500, 1000, 1500].map((d) => hit(t0 + d, 3, 5_000 * m, { unmitigated: 5_000, multiplier: m }))
    const rows = damageRows(multi(10_000, 0.9), multi(10_000, 0.6), identity, [], noAuto)
    expect(rows[0].mitigationGap).toBe(true)
  })

  it('leaves vulnerable hits out of the mitigation average', () => {
    const rows = damageRows([hit(1_000, 1, 1, { multiplier: 0.8 }), hit(2_000, 1, 1, { multiplier: 2.3 })], null, identity, [], noAuto)
    expect(rows[0].mine.mitigation).toBeCloseTo(0.2)
  })
})

describe('deathRecap', () => {
  it('lists the last hits before the death and what the reference took', () => {
    const mine = [
      hit(1_000, 9), // 超過 10 秒，不列
      hit(95_000, 1, 40_000, { hpAfter: 30_000, multiplier: 0.9 }),
      hit(99_000, 2, 30_000, { hpAfter: 0, multiplier: 1 }),
    ]
    const recap = deathRecap(
      { t: 100_000, abilityId: 2, revivedAt: null },
      mine,
      { hits: [hit(98_000, 2, 20_000, { multiplier: 0.6 })], deaths: [] },
      identity,
    )
    expect(recap.hits.map((h) => [h.abilityId, h.hpBefore, h.hpAfter])).toEqual([
      [1, 0.7, 0.3],
      [2, 0.3, 0],
    ])
    expect(recap.hits[0].mitigation).toBeCloseTo(0.1)
    expect(recap.ref).toEqual({ amount: 20_000, mitigation: expect.closeTo(0.4), died: false })
  })
})
