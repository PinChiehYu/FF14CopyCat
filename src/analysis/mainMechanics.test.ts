import { describe, expect, it } from 'vitest'
import type { TimedCast } from './alignment'
import { mainMechanicDifferences, mainMechanicGroups, variantMechanics } from './mainMechanics'

const cast = (seconds: number, abilityId: number): TimedCast => ({ t: seconds * 1000, abilityId })
// M8S（Howling Blade）：Stonefang／Windfang 的四個版本是同一機制；41906～41909 各自是單獨的機制
const M8S = 100
const common = [cast(10, 41906), cast(20, 41907), cast(30, 41908), cast(60, 41909)]

describe('main mechanics', () => {
  it('groups the versions of a mechanic listed together in the cactbot timeline', () => {
    const groups = mainMechanicGroups(M8S)!
    expect(groups.get(41886)).toBe(groups.get(41885))
    expect(groups.get(41890)).toBe(groups.get(41885))
    expect(groups.get(41906)).not.toBe(groups.get(41885))
    expect(mainMechanicGroups(1)).toBeNull()
  })

  it('compares only the main mechanics', () => {
    // 99999 不是主要機制（輔助判定）：兩邊不同也不列出
    const mine = [...common, cast(40, 41885), cast(45, 99999)]
    const ref = [...common, cast(40, 41889)]
    const diffs = mainMechanicDifferences(M8S, mine, ref, (t) => t, 70_000, 70_000)
    expect(diffs).toEqual([{ t: 40_000, mine: [41885], ref: [41889], kind: 'variant' }])
  })

  it('counts the differing random mechanics by mechanic', () => {
    const mine = [...common, cast(40, 41885)]
    const ref = [...common, cast(40, 41889)]
    const key = mainMechanicGroups(M8S)!.get(41885)!
    expect([...variantMechanics(M8S, mine, ref, 70_000, 70_000)]).toEqual([[key, 1]])
    expect(variantMechanics(M8S, mine, mine, 70_000, 70_000).size).toBe(0)
  })
})
