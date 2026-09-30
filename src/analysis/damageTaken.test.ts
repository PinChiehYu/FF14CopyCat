import { describe, expect, it } from 'vitest'
import { deathRecap } from './damageTaken'
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

  it('has no reference comparison when the reference was not hit by the killing blow', () => {
    const recap = deathRecap({ t: 10_000, abilityId: 2, revivedAt: null }, [hit(9_000, 2)], { hits: [hit(40_000, 2)], deaths: [] }, identity)
    expect(recap.ref).toBeNull()
  })
})
