import { describe, expect, it } from 'vitest'
import type { AbilityUsage } from '../analysis/metrics'
import { getJob } from '../jobs'
import { abilityCategory } from '../jobs/roleActions'
import { groupUsage } from './usageGroups'

const row = (abilityId: number): AbilityUsage => ({
  abilityId,
  mine: 1,
  ref: 1,
  matched: 1,
  avgDelayMs: 0,
  unmatchedRef: [],
})

describe('groupUsage', () => {
  const paladin = getJob('Paladin')!
  const category = (id: number) => abilityCategory(id, paladin)

  it('orders groups GCD, non-GCD, auto-attack, mitigation, movement and keeps row order', () => {
    const usage = [
      row(3), // Sprint → 移動
      row(20), // Fight or Flight → 非 GCD
      row(7), // Attack → 普通攻擊
      row(7531), // Rampart → 減傷
      row(9), // Fast Blade → GCD
      row(34600427), // 藥水 → 非 GCD
      row(15), // Riot Blade → GCD
      row(36920), // Guardian → 減傷
      row(7546), // True North（輔助）→ 非 GCD
    ]
    const groups = groupUsage(usage, category, paladin.isGcd)
    expect(groups.map((g) => [g.label, g.rows.map((r) => r.abilityId)])).toEqual([
      ['GCD', [9, 15]],
      ['非 GCD', [20, 34600427, 7546]],
      ['普通攻擊', [7]],
      ['減傷', [7531, 36920]],
      ['移動', [3]],
    ])
  })

  it('omits empty groups and treats everything as non-GCD without GCD rules', () => {
    const groups = groupUsage([row(9), row(20)], category)
    expect(groups.map((g) => g.label)).toEqual(['非 GCD'])
  })
})
