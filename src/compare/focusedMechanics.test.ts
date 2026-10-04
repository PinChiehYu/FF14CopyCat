import { describe, expect, it } from 'vitest'
import type { TimedCast } from '../analysis/alignment'
import { mainMechanicGroups, mechanicOccurrences } from '../analysis/mainMechanics'
import { focusChecker } from './focusedMechanics'

const cast = (seconds: number, abilityId: number): TimedCast => ({ t: seconds * 1000, abilityId })
// M8S（Howling Blade）：41885／41889 是同一隨機機制的不同版本
const M8S = 100
const key = mainMechanicGroups(M8S)!.get(41885)!
const occurrences = mechanicOccurrences(M8S, [cast(40, 41885), cast(100, 41889)])
// 99999：cactbot 沒列、與 41885 同名的後續判定
const names: Record<number, string> = { 41885: 'Stonefang', 41889: 'Windfang', 99999: 'Stonefang' }
const englishName = (id: number) => names[id]

describe('focusChecker', () => {
  it('highlights nothing while every occurrence is focused', () => {
    expect(focusChecker(M8S, occurrences, new Set(), englishName)).toBeNull()
    // 沒有主要機制資料的 Boss
    expect(focusChecker(1, occurrences, new Set([`${key}#1`]), englishName)).toBeNull()
  })

  it('highlights the occurrences still focused after one is unchecked', () => {
    const isFocused = focusChecker(M8S, occurrences, new Set([`${key}#1`]), englishName)!
    expect(isFocused(41885, 40_000)).toBe(false)
    expect(isFocused(41889, 100_000)).toBe(true)
    // 不是隨機機制（沒有時間點）的技能不高光
    expect(isFocused(41906, 10_000)).toBe(false)
  })

  it('matches an unlisted ability to the mechanic of the same name', () => {
    const isFocused = focusChecker(M8S, occurrences, new Set([`${key}#1`]), englishName)!
    expect(isFocused(99999, 100_000)).toBe(true)
    expect(isFocused(99999, 40_000)).toBe(false)
    // 名稱對不到任何主要機制
    expect(isFocused(12345, 100_000)).toBe(false)
  })
})
