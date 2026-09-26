import { describe, expect, it } from 'vitest'
import { windowRules } from '../jobs/windows'
import type { BuffWindow } from './buffs'
import { evaluateWindows } from './windows'

const name = (id: number) => `#${id}`
const gcd = new Set([7481, 7482, 7480, 7484, 7485, 7478, 7479, 36963])
const isGcd = (id: number) => gcd.has(id)
const meikyo = windowRules('Samurai')[0]
const window = (start: number, end: number, openEnded = false): BuffWindow => ({
  statusId: 1_001_233,
  start,
  end,
  prepull: false,
  openEnded,
})

describe('evaluateWindows', () => {
  it('passes a Meikyo window with 3 Sen GCDs, counting the GCD at the removal time', () => {
    const casts = [
      { t: 1000, abilityId: 7481 },
      { t: 3100, abilityId: 7482 },
      { t: 5200, abilityId: 7480 },
    ]
    const summary = evaluateWindows(meikyo, [window(900, 5200)], casts, isGcd, name)
    expect(summary).toMatchObject({ judged: 1, passed: 1 })
    expect(summary.windows[0].gcds).toBe(3)
  })

  it('reports too few GCDs and disallowed GCDs', () => {
    const casts = [
      { t: 1000, abilityId: 7481 },
      { t: 3100, abilityId: 36963 }, // 曉風：明鏡止水期間不應使用
    ]
    const [w] = evaluateWindows(meikyo, [window(900, 4000)], casts, isGcd, name).windows
    expect(w.issues).toEqual(['只打了 2 個 GCD（應 3 個）', '不應使用：#36963'])
  })

  it('ignores GCDs that do not consume Meikyo (Iaijutsu, Tsubame)', () => {
    const casts = [
      { t: 1000, abilityId: 7481 },
      { t: 3100, abilityId: 36966 }, // 天道雪月花：不計
      { t: 5200, abilityId: 7482 },
      { t: 7300, abilityId: 7480 },
    ]
    const summary = evaluateWindows(meikyo, [window(900, 7300)], casts, (id) => isGcd(id) || id === 36966, name)
    expect(summary.passed).toBe(1)
    expect(summary.windows[0].gcds).toBe(3)
  })

  it('does not judge windows cut by the end of the fight', () => {
    const summary = evaluateWindows(meikyo, [window(900, 2000, true)], [], isGcd, name)
    expect(summary).toMatchObject({ judged: 0, passed: 0 })
    expect(summary.windows[0].judged).toBe(false)
  })

  it('checks expected actions for Fight or Flight', () => {
    const fof = windowRules('Paladin')[0]
    const casts = [16459, 25748, 25749, 25750, 3539, 16460, 36918, 7384, 36922, 25747, 23, 16461].map((abilityId, i) => ({
      t: 1000 + i * 1000,
      abilityId,
    }))
    const pldGcd = new Set([3538, 16459, 25748, 25749, 25750, 3539, 16460, 36918, 36919, 7384])
    const [w] = evaluateWindows(fof, [{ ...window(900, 21000), statusId: 1_000_076 }], casts, (id) => pldGcd.has(id), name).windows
    // 少了瀝血劍（#3538）；GCD 仍有 8 個
    expect(w.gcds).toBe(8)
    expect(w.issues).toEqual(['缺少：#3538'])
  })

  it('caps expected GCDs by window length for time-based windows', () => {
    const fof = windowRules('Paladin')[0]
    const casts = [16459, 25748].map((abilityId, i) => ({ t: 1000 + i * 2500, abilityId }))
    // 5 秒的窗口：最多 ceil((5000 − 250) ÷ 2500) = 2 個 GCD
    const [w] = evaluateWindows(fof, [{ ...window(900, 5900), statusId: 1_000_076 }], casts, () => true, name, 2500).windows
    expect(w.issues.some((i) => i.startsWith('只打了'))).toBe(false)
  })

  it('builds windows from an action with a fixed duration', () => {
    const rule = { key: 'x', action: { id: 3555, durationMs: 20_000 }, expectedActions: [{ ids: [7400], mode: 'each' as const, count: 1 }], source: '' }
    const casts = [
      { t: 10_000, abilityId: 3555 },
      { t: 15_000, abilityId: 7400 },
      { t: 60_000, abilityId: 3555 }, // 戰鬥在 70 秒結束：未結束不評分
    ]
    const s = evaluateWindows(rule, [], casts, () => false, name, 2500, 70_000)
    expect(s.windows.map((w) => [w.start, w.end, w.judged, w.issues.length])).toEqual([
      [10_000, 30_000, true, 0],
      [60_000, 70_000, false, 1],
    ])
  })

  it('builds windows where all listed statuses overlap', () => {
    const rule = { key: 'x', allOf: [1, 2, 3], source: '' }
    const b = (statusId: number, start: number, end: number): BuffWindow => ({ statusId, start, end, prepull: false, openEnded: false })
    const s = evaluateWindows(rule, [b(1, 0, 20), b(2, 2, 22), b(3, 3, 25), b(1, 100, 120)], [], () => false, name)
    expect(s.windows.map((w) => [w.start, w.end])).toEqual([[3, 20]])
  })

  it('applies opener counts, conditional expectations, GCD adjustments and limited actions', () => {
    const kunai = windowRules('Ninja')[0]
    const casts = [
      { t: 5000, abilityId: 2267 }, // 雷遁（開場只要 1 次）
      { t: 6000, abilityId: 3566 },
      { t: 7000, abilityId: 16492 },
      { t: 8000, abilityId: 3563 }, // 強甲破點突：開場允許 1 次
    ]
    const debuff = { statusId: 1_003_906, start: 4000, end: 19_000, prepull: false, openEnded: false }
    const [w] = evaluateWindows(kunai, [debuff], casts, () => false, name).windows
    // 沒用天地人：天理人道不要求；GCD 規則因判斷全部非 GCD 而只剩 GCD 數
    expect(w.issues).toEqual(['只打了 0 個 GCD（應 6 個）'])
  })
})
