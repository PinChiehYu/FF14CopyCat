import { describe, expect, it } from 'vitest'
import { FOLLOW_UP_RULES } from '../jobs/followUpRules'
import { followUpResults } from './followUps'

const cast = (t: number, abilityId: number) => ({ t, abilityId })

describe('followUpResults', () => {
  const rule = { key: 'uncoiled-twinfang', parents: [34633], followUp: [34644] }

  it('lists parents that were not followed up', () => {
    // 10 秒：有接；40 秒：沒接（下一次前一招前都沒有）；70 秒：12 秒後才接，超過 10 秒算漏接
    const [r] = followUpResults([rule], [cast(10_000, 34633), cast(11_000, 34644), cast(40_000, 34633), cast(70_000, 34633), cast(82_000, 34644)])
    expect(r.parents).toBe(3)
    expect(r.missed).toEqual([40_000, 70_000])
  })

  it('does not credit one follow-up to two parents', () => {
    // 兩次前一招之間沒接，接在第二次之後：只算第二次有接
    const [r] = followUpResults([rule], [cast(10_000, 34633), cast(12_000, 34633), cast(13_000, 34644)])
    expect(r.missed).toEqual([10_000])
  })

  it('accepts any of several parents', () => {
    const coil = { key: 'coil-twinfang', parents: [34621, 34622], followUp: [34636] }
    const [r] = followUpResults([coil], [cast(10_000, 34621), cast(11_000, 34636), cast(30_000, 34622), cast(31_000, 34636)])
    expect(r).toMatchObject({ parents: 2, missed: [] })
  })

  it('has no duplicate rule keys per job', () => {
    for (const rules of Object.values(FOLLOW_UP_RULES)) expect(new Set(rules.map((r) => r.key)).size).toBe(rules.length)
  })
})
