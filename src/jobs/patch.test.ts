import { describe, expect, it } from 'vitest'
import { comparePatch, inPatchRange, patchAt } from './patch'
import { pairedWindowRules, windowRules } from './windows'

const at = (iso: string) => Date.parse(iso)

describe('patchAt', () => {
  it('uses the Traditional Chinese schedule, mapping TC 7.2 to the global 7.3 rules', () => {
    // 基準日誌：2026-08 的繁中服為 7.2，技能等同國際服 7.3
    expect(patchAt(at('2026-08-19T12:00:00Z'))).toEqual({ key: '7.2', rules: '7.3' })
    expect(patchAt(at('2026-09-25T12:00:00Z'))).toEqual({ key: '7.25', rules: '7.3' })
    expect(patchAt(at('2026-05-01T12:00:00Z'))).toEqual({ key: '7.1', rules: '7.1' })
    expect(patchAt(at('2026-01-01T12:00:00Z')).key).toBe('7.0')
    // 改版當天台灣時間 00:00 起
    expect(patchAt(at('2026-07-27T15:59:00Z')).key).toBe('7.1')
    expect(patchAt(at('2026-07-27T16:00:00Z')).key).toBe('7.2')
  })

  it('does not use the 7.2 Starry Muse rules for current TC logs', () => {
    const starry = windowRules('Pictomancer', patchAt(at('2026-08-19T12:00:00Z')).rules)[0]
    expect(starry.limitedActions).toBeDefined()
  })

  it('compares patch numbers', () => {
    expect(comparePatch('7.05', '7.1')).toBeLessThan(0)
    expect(comparePatch('7.25', '7.3')).toBeLessThan(0)
    expect(inPatchRange('7.25', { from: '7.2', before: '7.3' })).toBe(true)
    expect(inPatchRange('7.4', { before: '7.4' })).toBe(false)
  })
})

describe('window rules by patch', () => {
  it('requires Lion Heart in every No Mercy window from 7.4, only after Bloodfest before', () => {
    const lionHeart = (patch: string) => windowRules('Gunbreaker', patch).find((r) => r.key === 'no-mercy')!.expectedActions!.at(-1)!
    expect(lionHeart('7.2').onlyIf).toBeDefined()
    expect(lionHeart('7.5').onlyIf).toBeUndefined()
  })

  it('drops Manafication from 7.4 and uses the 7.2 Starry Muse rules only in 7.2', () => {
    expect(windowRules('RedMage', '7.3').map((r) => r.key)).toEqual(['manafication'])
    expect(windowRules('RedMage', '7.5')).toEqual([])
    const starry = (patch: string) => windowRules('Pictomancer', patch)[0]
    expect(starry('7.25').limitedActions).toBeUndefined()
    expect(starry('7.25').expectedGcds).toBe(9)
    expect(starry('7.5').limitedActions).toBeDefined()
    expect(starry('7.1').limitedActions).toBeDefined()
  })

  it('pairs the rules of both sides by key', () => {
    const pairs = pairedWindowRules('RedMage', '7.2', '7.5')
    expect(pairs).toHaveLength(1)
    expect(pairs[0].mine?.key).toBe('manafication')
    expect(pairs[0].ref).toBeNull()
    // 同版本時兩邊是同一條規則
    const gnb = pairedWindowRules('Gunbreaker', '7.2', '7.25')
    expect(gnb.every((p) => p.mine === p.ref)).toBe(true)
  })
})
