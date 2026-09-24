/** 已正規化到戰鬥開始（毫秒）的施放事件。 */
export interface TimedCast {
  t: number
  abilityId: number
}

export interface Anchor {
  /** 我的日誌中的戰鬥時間 */
  mine: number
  /** 參考日誌中的戰鬥時間 */
  ref: number
  abilityId: number
  /** 該技能在各自日誌中的第幾次施放（從 1 開始） */
  occurrence: number
}

export interface Alignment {
  anchors: Anchor[]
  /** 把我的戰鬥時間換算成參考日誌中「同一個機制」的時間 */
  mineToRef(t: number): number
}

export interface AlignmentOptions {
  /** 同一技能在這段時間內重複施放（多個分身同時施放）視為一次 */
  dedupeMs?: number
  /** 施放次數超過此值的技能（自動攻擊、反覆出現的招式）不當錨點，避免次數錯位 */
  maxOccurrences?: number
}

interface Occurrence extends TimedCast {
  key: string
  occurrence: number
}

function occurrences(casts: TimedCast[], dedupeMs: number): { list: Occurrence[]; counts: Map<number, number> } {
  const sorted = [...casts].sort((a, b) => a.t - b.t)
  const last = new Map<number, number>()
  const counts = new Map<number, number>()
  const list: Occurrence[] = []
  for (const cast of sorted) {
    const prev = last.get(cast.abilityId)
    if (prev !== undefined && cast.t - prev < dedupeMs) continue
    last.set(cast.abilityId, cast.t)
    const occurrence = (counts.get(cast.abilityId) ?? 0) + 1
    counts.set(cast.abilityId, occurrence)
    list.push({ ...cast, occurrence, key: `${cast.abilityId}#${occurrence}` })
  }
  return { list, counts }
}

/** 依 mine 排序的配對中，取 ref 嚴格遞增的最長子序列，去掉時間順序矛盾的錯誤配對。 */
function longestIncreasing(pairs: Anchor[]): Anchor[] {
  const tails: number[] = []
  const prev = new Array<number>(pairs.length)
  pairs.forEach((pair, i) => {
    let lo = 0
    let hi = tails.length
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (pairs[tails[mid]].ref < pair.ref) lo = mid + 1
      else hi = mid
    }
    prev[i] = lo > 0 ? tails[lo - 1] : -1
    tails[lo] = i
  })
  const result: Anchor[] = []
  for (let k = tails.length ? tails[tails.length - 1] : -1; k >= 0; k = prev[k]) result.push(pairs[k])
  return result.reverse()
}

/**
 * 以 Boss 技能為錨點對齊兩份日誌的時間軸。
 * 錨點 = 兩份日誌中「同一技能的第 n 次施放」，錨點之間線性內插，
 * 戰鬥開始 (0, 0) 為隱含錨點，最後一個錨點之後以斜率 1 外推。
 */
export function buildAlignment(
  mineBoss: TimedCast[],
  refBoss: TimedCast[],
  { dedupeMs = 1000, maxOccurrences = 8 }: AlignmentOptions = {},
): Alignment {
  const mine = occurrences(mineBoss, dedupeMs)
  const ref = occurrences(refBoss, dedupeMs)
  const refByKey = new Map(ref.list.map((o) => [o.key, o]))
  const rare = (id: number) =>
    (mine.counts.get(id) ?? 0) <= maxOccurrences && (ref.counts.get(id) ?? 0) <= maxOccurrences

  const candidates: Anchor[] = []
  for (const o of mine.list) {
    const match = refByKey.get(o.key)
    if (match && rare(o.abilityId) && o.t > 0 && match.t > 0) {
      candidates.push({ mine: o.t, ref: match.t, abilityId: o.abilityId, occurrence: o.occurrence })
    }
  }
  // 同一時間點多個技能只留第一個，確保內插區段長度 > 0
  const anchors = longestIncreasing(candidates).filter((a, i, all) => i === 0 || a.mine > all[i - 1].mine)
  const points = [{ mine: 0, ref: 0 }, ...anchors]

  return {
    anchors,
    mineToRef(t: number): number {
      // 找出 t 所在的區段（points 依 mine 遞增）
      let lo = 0
      let hi = points.length - 1
      if (t >= points[hi].mine) return points[hi].ref + (t - points[hi].mine)
      if (t <= points[0].mine) return points[0].ref + (t - points[0].mine)
      while (hi - lo > 1) {
        const mid = (lo + hi) >> 1
        if (points[mid].mine <= t) lo = mid
        else hi = mid
      }
      const a = points[lo]
      const b = points[hi]
      return a.ref + ((t - a.mine) * (b.ref - a.ref)) / (b.mine - a.mine)
    },
  }
}
