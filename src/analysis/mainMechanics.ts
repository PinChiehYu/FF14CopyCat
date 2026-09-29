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
): { t: number; mineT: number; keys: number[] }[] {
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
      return {
        t: d.t,
        // 我的時間：對到我的機制時間點（見 mechanicOccurrences）
        mineT: alignment.refToMine(d.t),
        keys: groups ? [...new Set(ids.map((id) => groups.get(id) ?? id))] : [Math.min(...ids)],
      }
    })
}

/** 我的戰鬥中一次會隨機的主要機制：`id` 為「組鍵#第幾次」，換了我的其他場次仍能對應 */
export interface MechanicOccurrence {
  id: string
  /** 機制（主要機制的組鍵） */
  key: number
  /** 這個機制的第幾次（1 起） */
  n: number
  /** 我的戰鬥時間 */
  t: number
  /** 我這次遇到的技能（版本） */
  ids: number[]
}

// 同一個機制這段時間內的連續施放算一次（同 mergeRepeats 的預設）
const OCCURRENCE_GAP_MS = 6000
// 差異的時間點與我的某次機制相差這麼近以內，視為同一次
const OCCURRENCE_MATCH_MS = 10_000

/**
 * 我的戰鬥中每一次主要機制（cactbot 同一條目的施放，6 秒內的連續施放算一次），依機制各自編號。
 * 只列會隨機的：該機制有 2 個以上的技能版本，而且這次沒有把所有版本同時施放（同時全放的是同一招的多個判定）。
 * 編號包含所有次數（不隨機的那幾次也佔一個號碼），第 N 次在不同場次中指的是同一次。沒有資料的 Boss 回傳空清單。
 */
export function mechanicOccurrences(encounterID: number, mineCasts: TimedCast[]): MechanicOccurrence[] {
  const groups = mainMechanicGroups(encounterID)
  if (!groups) return []
  const runs = new Map<number, { start: number; last: number; ids: Set<number> }[]>()
  for (const c of [...mineCasts].sort((a, b) => a.t - b.t)) {
    const key = groups.get(c.abilityId)
    if (key === undefined) continue
    const list = runs.get(key) ?? []
    const run = list.at(-1)
    if (run && c.t - run.last <= OCCURRENCE_GAP_MS) {
      run.last = c.t
      run.ids.add(c.abilityId)
    } else {
      list.push({ start: c.t, last: c.t, ids: new Set([c.abilityId]) })
    }
    runs.set(key, list)
  }
  const found: MechanicOccurrence[] = []
  for (const [key, list] of runs) {
    const versions = mechanicIds(encounterID, key)
    if (versions.length < 2) continue
    list.forEach((run, i) => {
      if (run.ids.size >= versions.length) return
      found.push({ id: `${key}#${i + 1}`, key, n: i + 1, t: run.start, ids: [...run.ids].sort((a, b) => a - b) })
    })
  }
  return found.sort((a, b) => a.t - b.t)
}

/** 差異時間點的某個機制（組鍵、我的時間）對到我的哪一次：同一機制、時間最近且 10 秒內；沒有時 null */
export function occurrenceOf(occurrences: MechanicOccurrence[], key: number, mineT: number): string | null {
  let best: MechanicOccurrence | null = null
  for (const o of occurrences) {
    if (o.key !== key || Math.abs(o.t - mineT) > OCCURRENCE_MATCH_MS) continue
    if (!best || Math.abs(o.t - mineT) < Math.abs(best.t - mineT)) best = o
  }
  return best?.id ?? null
}