import type { JobModule } from './index'

/**
 * 技能在分析中的分類：
 * - ignored：不需要紀錄（坦克的挑釁、退避、坦姿開關），從時間軸、技能次數與建議中移除
 * - mitigation：減傷（重要的學習課題，有專屬建議）
 * - movement：移動（衝刺、位移技能，同樣是重要的學習課題）
 * - utility：其他依攻略使用的輔助技能（合併為低優先建議）
 * - normal：一般輸出技能
 */
export type AbilityCategory = 'ignored' | 'mitigation' | 'movement' | 'utility' | 'normal'

// 所有職業共用的職能技能與通用技能
const ROLE_IGNORED = new Set([
  7533, // Provoke
  7537, // Shirk
  // 坦克姿態開關（騎士的 Iron Will 在騎士模組）
  48, // Defiance
  32066, // Release Defiance
  3629, // Grit
  32067, // Release Grit
  16142, // Royal Guard
  32068, // Release Royal Guard
])

const ROLE_MITIGATION = new Set([
  7531, // Rampart
  7535, // Reprisal
  7549, // Feint
  7560, // Addle
])

const ROLE_MOVEMENT = new Set([
  3, // Sprint
  7557, // Peloton（遠程物理的全隊移動速度提升）
])

const ROLE_UTILITY = new Set([
  7538, // Interject
  7540, // Low Blow
  7541, // Second Wind
  7542, // Bloodbath
  7546, // True North
  7548, // Arm's Length
  7551, // Head Graze
  7863, // Leg Sweep
  7559, // Surecast
  7562, // Lucid Dreaming
  7568, // Esuna
  7571, // Rescue
])

export function abilityCategory(abilityId: number, job?: JobModule): AbilityCategory {
  if (ROLE_IGNORED.has(abilityId) || job?.ignored?.has(abilityId)) return 'ignored'
  if (ROLE_MITIGATION.has(abilityId) || job?.mitigation?.has(abilityId)) return 'mitigation'
  if (ROLE_MOVEMENT.has(abilityId) || job?.movement?.has(abilityId)) return 'movement'
  if (ROLE_UTILITY.has(abilityId) || job?.utility?.has(abilityId)) return 'utility'
  return 'normal'
}
