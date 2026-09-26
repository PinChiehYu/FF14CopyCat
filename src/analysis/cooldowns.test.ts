import { describe, expect, it } from 'vitest'
import type { CooldownGroup } from '../jobs/cooldownRules'
import { cooldownUsage, downtimeWindows, lateUses, maxUsages } from './cooldowns'

const group = (extra: Partial<CooldownGroup> = {}): CooldownGroup => ({
  key: 'test',
  ids: [1],
  cooldownMs: 60_000,
  charges: 1,
  allowedDowntimeMs: 1250,
  source: 'test',
  ...extra,
})

describe('maxUsages', () => {
  it('counts uses every cooldown from the expected first use', () => {
    // 60 秒冷卻＋1.25 秒容許：0、61.25、122.5、183.75 → 4 次（200 秒內）
    expect(maxUsages(group(), [0], [], 200_000, [])).toBe(4)
    // 第一次使用預期在 10 秒
    expect(maxUsages(group({ firstUseOffsetMs: 10_000 }), [], [], 200_000, [])).toBe(4)
  })

  it('does not count downtime as lost', () => {
    // 50～150 秒 Boss 無法選取：61.25 的使用延到 150、之後 211.25 → 0、150、211.25 → 3 次（240 秒內）
    expect(maxUsages(group(), [0], [], 240_000, [{ start: 50_000, end: 150_000 }])).toBe(3)
    expect(maxUsages(group(), [0], [], 240_000, [])).toBe(4)
  })

  it('stacks charges', () => {
    // 30 秒冷卻、2 次充能：開場 2 次，之後每 30 秒 1 次 → 2 + floor(100/30)=5 次（100 秒內）
    expect(maxUsages(group({ cooldownMs: 30_000, charges: 2 }), [0], [], 100_000, [])).toBe(5)
  })
})

describe('lateUses', () => {
  it('reports how long a ready cooldown was held', () => {
    // 冷卻好（60 秒）後 70 秒才用：晚 10 秒，扣掉容許 1.25 秒
    expect(lateUses(group(), [0, 70_000], [], [])).toEqual([{ t: 70_000, lateMs: 8750 }])
  })

  it('ignores held time during downtime', () => {
    // 60～75 秒 Boss 無法選取，75 秒後才能用：80 秒使用只晚 5 秒
    expect(lateUses(group(), [0, 80_000], [], [{ start: 60_000, end: 75_000 }])).toEqual([{ t: 80_000, lateMs: 3750 }])
  })

  it('counts only time capped at full charges', () => {
    // 2 次充能：0 秒用 1 次（剩 1）、30 秒回滿，40 秒才用：晚 10 秒（充能技能沒有容許延遲）
    expect(lateUses(group({ cooldownMs: 30_000, charges: 2 }), [0, 40_000], [], [])).toEqual([{ t: 40_000, lateMs: 10_000 }])
    // 還沒滿就用：不算晚
    expect(lateUses(group({ cooldownMs: 30_000, charges: 2 }), [0, 10_000], [], [])).toEqual([])
  })

  it('restarts the timer when a use comes a few ms before the computed ready time', () => {
    // 實例（騎士戰逃反應 513.3 → 573.296 → 634.1 秒）：第二次比 60 秒冷卻早 4 毫秒，第三次都不算晚
    expect(lateUses(group(), [0, 59_996, 120_800], [], [])).toEqual([])
  })

  it('measures the first use from the expected opener time', () => {
    expect(lateUses(group({ firstUseOffsetMs: 10_000 }), [15_000], [], [])).toEqual([{ t: 15_000, lateMs: 3750 }])
  })
})

describe('downtimeWindows / cooldownUsage', () => {
  it('finds boss-absent windows and evaluates a group', () => {
    // 每 10 秒一筆 Boss 取樣，但 40～100 秒沒有（超過 BOSS_LIMITS 的 30 秒內插上限）
    const boss = [0, 10, 20, 30, 40, 100, 110, 120, 130, 140, 150, 160, 170, 180, 190, 200].map((s) => ({ t: s * 1000, x: 100, y: 100 }))
    const windows = downtimeWindows(boss, 200_000)
    expect(windows).toHaveLength(1)
    expect(windows[0].start).toBeGreaterThan(40_000)
    expect(windows[0].end).toBeLessThanOrEqual(100_000)
    const [usage] = cooldownUsage([group()], [{ t: 0, abilityId: 1 }, { t: 130_000, abilityId: 1 }, { t: 5000, abilityId: 2 }], 200_000, windows)
    expect(usage.uses).toBe(2)
    expect(usage.max).toBeGreaterThan(2)
  })
})
