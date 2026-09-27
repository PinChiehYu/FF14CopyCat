import { describe, expect, it } from 'vitest'
import type { TimedCast } from './alignment'
import { mainMechanicDifferences, mainMechanicGroups, variantPoints } from './mainMechanics'

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

  it('lists the time points where random mechanics differ, with the mechanics involved', () => {
    const mine = [...common, cast(40, 41885)]
    const ref = [...common, cast(40, 41889)]
    const key = mainMechanicGroups(M8S)!.get(41885)!
    expect(variantPoints(M8S, mine, ref, 70_000, 70_000)).toEqual([{ t: 40_000, keys: [key] }])
    expect(variantPoints(M8S, mine, mine, 70_000, 70_000)).toEqual([])
  })

  it('counts two mechanics that differ at the same time as one point', () => {
    // 同一時間點兩組機制都不同（例如魔技與群狼劍同時）：算一處，涉及兩個機制
    const groups = mainMechanicGroups(M8S)!
    const mine = [...common, cast(40, 41885), cast(40.2, 41880)]
    const ref = [...common, cast(40, 41889), cast(40.2, 42927)]
    const points = variantPoints(M8S, mine, ref, 70_000, 70_000)
    expect(points).toHaveLength(1)
    expect(points[0].keys.sort()).toEqual([groups.get(41880), groups.get(41885)].sort())
  })

  it('compares main mechanics however often they are cast', () => {
    // 主要機制不以施放次數排除：每邊 10 次的機制仍比較（沒有資料時超過 8 次的不比）
    const repeated = (id: number) => Array.from({ length: 10 }, (_, i) => cast(100 + i * 10, id))
    const mine = [...common, ...repeated(41906), cast(250, 41885)]
    const ref = [...common, ...repeated(41906), cast(250, 41889)]
    expect(mainMechanicDifferences(M8S, mine, ref, (t) => t, 300_000, 300_000)).toEqual([
      { t: 250_000, mine: [41885], ref: [41889], kind: 'variant' },
    ])
  })

  it('does not report a one-sided main mechanic when the other side cast a minor version at that time', () => {
    // 三連指向最後一下（主要機制）對上二連指向同一時間的後續判定（cactbot 沒列）：同一招的不同版本，不是被跳過
    const mine = [...common, cast(40, 41910), cast(50, 41911)]
    const ref = [...common, cast(40.3, 99999)]
    expect(mainMechanicDifferences(M8S, mine, ref, (t) => t, 70_000, 70_000)).toEqual([
      { t: 50_000, mine: [41911], ref: [], kind: 'only-mine' },
    ])
  })

  it('counts consecutive resolutions once and ignores one-sided mechanics', () => {
    // 同一招連續結算 3 次算一次；只有一邊的機制（多半是轉場差異）不算隨機機制不同
    const mine = [...common, cast(40, 41885), cast(42, 41885), cast(44, 41885), cast(50, 41910)]
    const ref = [...common, cast(40, 41889), cast(42, 41889), cast(44, 41889)]
    const key = mainMechanicGroups(M8S)!.get(41885)!
    expect(variantPoints(M8S, mine, ref, 70_000, 70_000)).toEqual([{ t: 40_000, keys: [key] }])
  })

  it('falls back to all infrequent abilities for bosses without data', () => {
    const autos = Array.from({ length: 20 }, (_, i) => cast(i * 3, 99))
    const mine = [cast(10, 1), cast(20, 2), cast(30, 3), cast(40, 10), ...autos]
    const ref = [cast(10, 1), cast(20, 2), cast(30, 3), cast(40, 11)]
    expect(mainMechanicDifferences(1, mine, ref, (t) => t, 60_000, 60_000)).toEqual([
      { t: 40_000, mine: [10], ref: [11], kind: 'variant' },
    ])
    // 沒有資料時以各處最小的技能 ID 為鍵
    expect(variantPoints(1, mine, ref, 60_000, 60_000)).toEqual([{ t: 40_000, keys: [10] }])
  })
})
