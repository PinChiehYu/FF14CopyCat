import type { AbilityUsage } from '../analysis/metrics'
import type { AbilityCategory } from '../jobs/roleActions'
import { AUTO_ATTACKS } from './load'

export type UsageGroupKey = 'gcd' | 'ogcd' | 'auto' | 'mitigation' | 'movement'

export interface UsageGroup {
  key: UsageGroupKey
  label: string
  rows: AbilityUsage[]
}

// 顯示順序：GCD → 非 GCD → 普通攻擊 → 減傷 → 移動
const GROUPS: { key: UsageGroupKey; label: string }[] = [
  { key: 'gcd', label: 'GCD' },
  { key: 'ogcd', label: '非 GCD' },
  { key: 'auto', label: '普通攻擊' },
  { key: 'mitigation', label: '減傷' },
  { key: 'movement', label: '移動' },
]

/** 技能所屬分組：普通攻擊、減傷、移動優先於 GCD 判斷；其餘（含輔助技能、藥水）依是否為 GCD 分組。 */
export function usageGroupOf(
  abilityId: number,
  category: (id: number) => AbilityCategory,
  isGcd?: (id: number) => boolean,
): UsageGroupKey {
  if (AUTO_ATTACKS.has(abilityId)) return 'auto'
  const kind = category(abilityId)
  if (kind === 'mitigation') return 'mitigation'
  if (kind === 'movement') return 'movement'
  return isGcd?.(abilityId) ? 'gcd' : 'ogcd'
}

/** 依固定順序分組，組內維持原本的排序；空的分組不回傳。 */
export function groupUsage(
  usage: AbilityUsage[],
  category: (id: number) => AbilityCategory,
  isGcd?: (id: number) => boolean,
): UsageGroup[] {
  return GROUPS.map(({ key, label }) => ({
    key,
    label,
    rows: usage.filter((u) => usageGroupOf(u.abilityId, category, isGcd) === key),
  })).filter((g) => g.rows.length > 0)
}
