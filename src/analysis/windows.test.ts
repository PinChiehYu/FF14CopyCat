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
    expect(w.issues).toEqual(['高威力 GCD缺少：#3538'])
  })
})
