import { formatFightTime } from './timeline'

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
  /** mineToRef 的反函數：參考時間換算成我的戰鬥時間 */
  refToMine(t: number): number
}

/**
 * 推進差距：兩個錨點之間，兩邊花的時間差了好幾秒、而且之後的時間差一直維持（例如 Boss 血量到了才轉場，
 * 輸出較低的一方較晚推進）。我在這段的施放會被換算擠進參考很短的時間內。
 */
export interface PushDifference {
  /** 這段在我的戰鬥時間的起訖 */
  mineStart: number
  mineEnd: number
  /** 這段在參考時間的起訖（參考在 refEnd 推進） */
  refStart: number
  refEnd: number
  /** 我比參考多花的時間（毫秒）；負值表示我較快推進 */
  deltaMs: number
}

// 時間差跳變至少這麼多才算推進差距
const MIN_PUSH_MS = 3000
// 以跳變前後這段時間內錨點的時間差中位數判斷是否持續（排除隨機機制造成的短暫抖動）
const PUSH_CONTEXT_MS = 30_000
// 相距這麼近的跳變視為同一次推進
const PUSH_MERGE_MS = 15_000

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  const mid = sorted.length >> 1
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}

/** 推進差距的滑鼠提示 */
export function pushTitle(p: PushDifference): string {
  const seconds = (Math.abs(p.deltaMs) / 1000).toFixed(1)
  return p.deltaMs > 0
    ? `參考在 ${formatFightTime(p.refEnd)} 推進，你到 ${formatFightTime(p.mineEnd)}（你的時間）才推進，多花了 ${seconds} 秒；之後的機制都跟著延後。你在這段的施放在時間軸上會擠在一起。`
    : `你比參考早 ${seconds} 秒推進（你的時間 ${formatFightTime(p.mineEnd)}）。`
}

/** 從錨點找出推進差距（依時間排序）。 */
export function pushDifferences(anchors: Anchor[]): PushDifference[] {
  const points = [{ mine: 0, ref: 0 }, ...anchors]
  const offset = (p: { mine: number; ref: number }) => p.ref - p.mine
  const offsetsIn = (from: number, to: number) => points.filter((p) => p.mine >= from && p.mine <= to).map(offset)
  // 某段前後的持續時間差變化：前面 30 秒與後面 30 秒內錨點時間差的中位數之差
  const persistentChange = (a: { mine: number }, b: { mine: number }) =>
    median(offsetsIn(b.mine, b.mine + PUSH_CONTEXT_MS)) - median(offsetsIn(a.mine - PUSH_CONTEXT_MS, a.mine))

  const segments: { a: (typeof points)[number]; b: (typeof points)[number] }[] = []
  for (let i = 0; i + 1 < points.length; i++) {
    const a = points[i]
    const b = points[i + 1]
    const jump = offset(b) - offset(a)
    const change = persistentChange(a, b)
    if (Math.abs(jump) >= MIN_PUSH_MS && Math.abs(change) >= MIN_PUSH_MS && Math.sign(change) === Math.sign(jump)) {
      const last = segments[segments.length - 1]
      if (last && a.mine - last.b.mine <= PUSH_MERGE_MS) last.b = b
      else segments.push({ a, b })
    }
  }
  // 合併後重算：先跳開又跳回的兩段（例如隨機機制）合起來沒有持續的差距
  return segments
    .map(({ a, b }) => ({
      mineStart: a.mine,
      mineEnd: b.mine,
      refStart: a.ref,
      refEnd: b.ref,
      deltaMs: -persistentChange(a, b),
    }))
    .filter((p) => Math.abs(p.deltaMs) >= MIN_PUSH_MS)
}

/** 依錨點做分段線性換算；points 在 from 與 to 上都嚴格遞增，最後一點之後以斜率 1 外推。 */
function piecewise(points: { from: number; to: number }[], t: number): number {
  let lo = 0
  let hi = points.length - 1
  if (t >= points[hi].from) return points[hi].to + (t - points[hi].from)
  if (t <= points[0].from) return points[0].to + (t - points[0].from)
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1
    if (points[mid].from <= t) lo = mid
    else hi = mid
  }
  const a = points[lo]
  const b = points[hi]
  return a.to + ((t - a.from) * (b.to - a.to)) / (b.from - a.from)
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

// 時間差（ref − mine）相差這麼多以上就算不同的一段
const LEVEL_MS = 3000
// 跳開又跳回的一段在我的時間上最長多久（更長的視為真的不同，不去掉）
const DETOUR_MAX_MS = 30_000
// 第一段或最後一段少於這麼多個錨點、而相鄰那段至少這麼多個時，視為配錯
const EDGE_MIN_ANCHORS = 3

/** 依時間差把連續的錨點分段：與目前這段時間差的中位數相差 LEVEL_MS 以上就開始新的一段。 */
function levels(anchors: Anchor[]): Anchor[][] {
  const offset = (a: Anchor) => a.ref - a.mine
  const out: Anchor[][] = []
  for (const a of anchors) {
    const current = out.at(-1)
    if (current && Math.abs(offset(a) - median(current.map(offset))) < LEVEL_MS) current.push(a)
    else out.push([a])
  }
  return out
}

/**
 * 去掉配錯的錨點：隨機順序的機制（例如熱舞綠光開場的 A 面／B 面先後、尾聲的 4 拍／8 拍節奏）會讓
 * 「同一技能的第 n 次」配到另一段機制，時間差「跳開又跳回」，扭曲時間軸並被誤判成推進差距。
 * 依時間差分段後，去掉：
 * - 夾在兩段之間、前後兩段時間差一致、而且在我的時間上不超過 30 秒的一段（連續配錯好幾個也能整段去掉：
 *   M5S 開場 B 面整段 5 個錨點都差 −20 秒）
 * - 第一段或最後一段錨點很少、而相鄰那段錨點夠多時（尾聲配錯，後面沒有錨點可以「跳回」）
 * 每次去掉一段後重新分段。真正的推進是跳過去就不回來（前後兩段不同），不會被去掉。
 */
function dropDetours(anchors: Anchor[]): Anchor[] {
  const offset = (a: Anchor) => a.ref - a.mine
  const level = (l: Anchor[]) => median(l.map(offset))
  const span = (l: Anchor[]) => l[l.length - 1].mine - l[0].mine
  let list = anchors
  for (;;) {
    const ls = levels(list)
    // 先找中間跳開又跳回的段；都沒有了才看首尾（否則開場只有兩個正確錨點時，會先被當成配錯的首段）
    let detour = ls.findIndex(
      (l, k) =>
        k > 0 && k < ls.length - 1 && Math.abs(level(ls[k - 1]) - level(ls[k + 1])) < LEVEL_MS && span(l) <= DETOUR_MAX_MS,
    )
    if (detour < 0 && ls.length >= 2) {
      const edge = (k: number, neighbor: number) => ls[k].length < EDGE_MIN_ANCHORS && ls[neighbor].length >= EDGE_MIN_ANCHORS
      // 開打時兩邊同步（隱含的 (0, 0) 錨點），時間差接近 0 的第一段不算配錯
      if (Math.abs(level(ls[0])) >= LEVEL_MS && edge(0, 1)) detour = 0
      else if (edge(ls.length - 1, ls.length - 2)) detour = ls.length - 1
    }
    if (detour < 0) return list
    const drop = new Set(ls[detour])
    list = list.filter((a) => !drop.has(a))
  }
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
  // 去掉孤立錨點後兩邊仍嚴格遞增（只刪除，不改順序）
  const anchors = dropDetours(longestIncreasing(candidates).filter((a, i, all) => i === 0 || a.mine > all[i - 1].mine))
  const points = [{ mine: 0, ref: 0 }, ...anchors]
  // LIS 保證 ref 嚴格遞增、上面的過濾保證 mine 嚴格遞增，因此兩個方向都能分段內插
  const forward = points.map((p) => ({ from: p.mine, to: p.ref }))
  const backward = points.map((p) => ({ from: p.ref, to: p.mine }))

  return {
    anchors,
    mineToRef: (t) => piecewise(forward, t),
    refToMine: (t) => piecewise(backward, t),
  }
}
