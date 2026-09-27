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
  const differences = mechanicDifferences(main(mineBoss), main(refBoss), mineToRef, mineEnd, refEnd, {
    maxOccurrences: Infinity,
    groupOf: (id) => groups.get(id),
    ...opts,
  })
  // 「只有一邊」的主要機制，另一邊同一時間卻有非主要機制的施放：是同一招的不同版本，只是另一邊的版本 cactbot 沒列
  // （例如三連指向最後一下 #42808 是主要機制，同一時間二連指向的 #42799 不是），不是被跳過的機制
  const windowMs = opts.windowMs ?? SAME_TIME_MS
  const minor = (casts: TimedCast[], toRef: (t: number) => number) =>
    casts.filter((c) => !groups.has(c.abilityId)).map((c) => toRef(c.t))
  const mineMinor = minor(mineBoss, mineToRef)
  const refMinor = minor(refBoss, (t) => t)
  const near = (times: number[], t: number) => times.some((x) => Math.abs(x - t) <= windowMs)
  return differences.filter(
    (d) =>
      !(d.kind === 'only-mine' && near(refMinor, d.t)) && !(d.kind === 'only-ref' && near(mineMinor, d.t)),
  )
}

// 與 mechanicDifferences 的預設相同：兩邊相差這麼近以內視為同一時間點
const SAME_TIME_MS = 1500
/**
 * 兩場同一 Boss 的戰鬥中，主要機制的隨機變化不同（同一時間施放不同技能）的時間點，
 * 每個時間點附上涉及的機制（主要機制的鍵）。以時間點計數：同一時間多個機制不同算一處。
 * 只看「不同變化」：「只有一邊」多半是輸出不同造成的轉場差異，不算隨機機制。
 * 沒有資料的 Boss，每個時間點以其中最小的技能 ID 為鍵。
 */
export function variantPoints(
  encounterID: number,
  mine: TimedCast[],
  other: TimedCast[],
  mineDuration: number,
  otherDuration: number,
): { t: number; keys: number[] }[] {
  const groups = mainMechanicGroups(encounterID)
  const alignment = buildAlignment(mine, other, { knownGroups: groups ?? undefined })
  const differences = mainMechanicDifferences(
    encounterID,
    mine,
    other,
    alignment.mineToRef,
    alignment.mineToRef(mineDuration),
    otherDuration,
  )
  // 同一招連續結算的多個時間點算一處（同機制表的合併）
  return mergeRepeats(differences, String)
    .filter((d) => d.kind === 'variant')
    .map((d) => {
      const ids = [...d.mine, ...d.ref]
      return { t: d.t, keys: groups ? [...new Set(ids.map((id) => groups.get(id) ?? id))] : [Math.min(...ids)] }
    })
}