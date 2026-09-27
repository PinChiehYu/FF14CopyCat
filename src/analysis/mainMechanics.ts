import { buildAlignment, type TimedCast } from './alignment'
import { MAIN_MECHANICS } from './mechanicData.generated'
import { mechanicDifferences, mergeRepeats, type MechanicDifference, type MechanicOptions } from './mechanics'

/**
 * Boss 的主要機制（取自 cactbot 時間軸）：技能 ID → 所屬機制（以該組最小的 ID 為鍵）。
 * 沒有資料的 Boss 回傳 null。
 */
export function mainMechanicGroups(encounterID: number): Map<number, number> | null {
  const groups = MAIN_MECHANICS[encounterID]
  if (!groups) return null
  const map = new Map<number, number>()
  for (const group of groups) for (const id of group) map.set(id, group[0])
  return map
}

/** 一個機制的所有技能 ID（含不同版本） */
export function mechanicIds(encounterID: number, key: number): number[] {
  return MAIN_MECHANICS[encounterID]?.find((g) => g[0] === key) ?? [key]
}

/**
 * 只比較主要機制的差異：cactbot 列出的技能才是玩家需要處理的，
 * 其餘（輔助判定、每一下的傷害）不列入；主要機制都要比較，不以施放次數排除。
 * 沒有資料的 Boss 比較全部低頻技能。
 */
export function mainMechanicDifferences(
  encounterID: number,
  mineBoss: TimedCast[],
  refBoss: TimedCast[],
  mineToRef: (t: number) => number,
  mineEnd: number,
  refEnd: number,
  opts: MechanicOptions = {},
): MechanicDifference[] {
  const groups = mainMechanicGroups(encounterID)
  if (!groups) return mechanicDifferences(mineBoss, refBoss, mineToRef, mineEnd, refEnd, opts)
  const main = (casts: TimedCast[]) => casts.filter((c) => groups.has(c.abilityId))
  return mechanicDifferences(main(mineBoss), main(refBoss), mineToRef, mineEnd, refEnd, { maxOccurrences: Infinity, ...opts })
}

/**
 * 兩場同一 Boss 的戰鬥有哪些主要機制的隨機變化不同（同一時間施放不同技能），回傳各機制不同的次數。
 * 只看「不同變化」：「只有一邊」多半是輸出不同造成的轉場差異，不算隨機機制。
 * 沒有資料的 Boss，每個不同處以其中最小的技能 ID 為鍵。
 */
export function variantMechanics(
  encounterID: number,
  mine: TimedCast[],
  other: TimedCast[],
  mineDuration: number,
  otherDuration: number,
): Map<number, number> {
  const alignment = buildAlignment(mine, other)
  const differences = mainMechanicDifferences(
    encounterID,
    mine,
    other,
    alignment.mineToRef,
    alignment.mineToRef(mineDuration),
    otherDuration,
  )
  const groups = mainMechanicGroups(encounterID)
  const result = new Map<number, number>()
  // 同一招連續結算的多個時間點算一次（同機制表的合併）
  for (const d of mergeRepeats(differences, String)) {
    if (d.kind !== 'variant') continue
    const ids = [...d.mine, ...d.ref]
    const keys = groups ? new Set(ids.map((id) => groups.get(id) ?? id)) : new Set([Math.min(...ids)])
    for (const key of keys) result.set(key, (result.get(key) ?? 0) + 1)
  }
  return result
}
