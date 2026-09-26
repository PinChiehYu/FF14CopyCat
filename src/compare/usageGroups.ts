import type { AbilityUsage } from '../analysis/metrics'
import type { AbilityCategory } from '../jobs/roleActions'
import { AUTO_ATTACKS } from './load'

export type UsageGroupKey = 'gcd' | 'ogcd' | 'auto' | 'partyMitigation' | 'mitigation' | 'movement'

export interface UsageGroup {
  key: UsageGroupKey
  label: string
  rows: AbilityUsage[]
}

// 顯示順序：GCD → 非 GCD → 普通攻擊 → 團隊減傷 → 自身減傷 → 移動
const GROUPS: { key: UsageGroupKey; label: string }[] = [
  { key: 'gcd', label: 'GCD' },
  { key: 'ogcd', label: '非 GCD' },
  { key: 'auto', label: '普通攻擊' },
  { key: 'partyMitigation', label: '團隊減傷' },
  { key: 'mitigation', label: '自身減傷' },
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
  if (kind === 'partyMitigation') return 'partyMitigation'
  if (kind === 'mitigation') return 'mitigation'
  if (kind === 'movement') return 'movement'
  return isGcd?.(abilityId) ? 'gcd' : 'ogcd'
}

/** 組內排序：我比參考少用的技能在前（少得越多越前面），其餘維持原本的排序。 */
function fewerFirst(a: AbilityUsage, b: AbilityUsage): number {
  const fewerA = Math.max(0, a.ref - a.mine)
  const fewerB = Math.max(0, b.ref - b.mine)
  return fewerB - fewerA
}

/** 依固定順序分組，組內少用的技能優先；空的分組不回傳。 */
export function groupUsage(
  usage: AbilityUsage[],
  category: (id: number) => AbilityCategory,
  isGcd?: (id: number) => boolean,
): UsageGroup[] {
  return GROUPS.map(({ key, label }) => ({
    key,
    label,
    rows: usage.filter((u) => usageGroupOf(u.abilityId, category, isGcd) === key).sort(fewerFirst),
  })).filter((g) => g.rows.length > 0)
}
