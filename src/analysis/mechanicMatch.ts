import { buildAlignment, type TimedCast } from './alignment'
import { mechanicDifferences, mergeRepeats } from './mechanics'

/**
 * 兩場同一 Boss 的戰鬥有幾處隨機機制不同（同一時間施放不同技能），0 代表隨機機制相同。
 * 只看「不同變化」：「只有一邊」多半是輸出不同造成的轉場差異，不算隨機機制。
 */
export function variantCount(
  mine: TimedCast[],
  other: TimedCast[],
  mineDuration: number,
  otherDuration: number,
  abilityName: (id: number) => string = (id) => String(id),
): number {
  const alignment = buildAlignment(mine, other)
  const differences = mechanicDifferences(mine, other, alignment.mineToRef, alignment.mineToRef(mineDuration), otherDuration)
  return mergeRepeats(differences, abilityName).filter((d) => d.kind === 'variant').length
}
