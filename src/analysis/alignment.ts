import { formatFightTime } from './timeline'

/** 已正規化到戰鬥開始（毫秒）的施放事件。 */
export interface TimedCast {
  t: number
  abilityId: number
  /** 施放者的遊戲 NPC ID（Boss 施放才有；用來排除只在一邊日誌中出現的施放者，見 load.ts 的 withSharedCasters） */
  source?: number
}

export interface Anchor {
  /** 我的日誌中的戰鬥時間 */
  mine: number
  /** 參考日誌中的戰鬥時間 */
  ref: number
  abilityId: number
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
    ? `參考在 ${formatFightTime(p.refEnd)} 推進，你到 ${formatFightTime(p.mineEnd)}（你的時間）才推進，多花了 ${seconds} 秒；之後的機制都跟著延後。`
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
  /**
   * 已知的機制分組（技能 ID → 組的代表 ID），例如 cactbot 時間軸同一條目的不同版本（放入 A 面／B 面）。
   * 第一次對齊就把同一組當成同一個機制，兩邊同一時間選到不同版本時也能依時間配上。
   */
  knownGroups?: ReadonlyMap<number, number>
}

/** 去重後的一次施放；key 為技能 ID，或所屬隨機機制組的代表 ID（同一組的技能視為同一個機制） */
interface KeyedCast extends TimedCast {
  key: number
}

// 同一組隨機機制（見 variantGroups）的技能在這段時間內都算同一次機制（一次機制常由多個判定技能組成）
const GROUP_DEDUPE_MS = 5000
// 第一次對齊至少要有這麼多錨點才找隨機機制組
const MIN_ANCHORS_FOR_GROUPS = 3
// 兩邊同一機制的時間差最多這麼多（依血量推進的轉場會讓時間差逐步拉大；騎士基準到戰鬥最後差 61 秒）
const MAX_DRIFT_MS = 120_000

/**
 * 依時間排序並去重：同一技能（或同一組隨機機制）在短時間內重複施放視為一次，只留第一次。
 * @param groups 技能 ID → 所屬隨機機制組的代表 ID
 */
function keyedCasts(casts: TimedCast[], dedupeMs: number, groups: ReadonlyMap<number, number> = new Map()): KeyedCast[] {
  const last = new Map<number, number>()
  const out: KeyedCast[] = []
  for (const cast of [...casts].sort((a, b) => a.t - b.t)) {
    const group = groups.get(cast.abilityId)
    const key = group ?? cast.abilityId
    const prev = last.get(key)
    if (prev !== undefined && cast.t - prev < (group !== undefined ? GROUP_DEDUPE_MS : dedupeMs)) continue
    last.set(key, cast.t)
    out.push({ ...cast, key })
  }
  return out
}

// 兩邊不同技能相距這麼近（對齊後）才算同一個時間點的隨機變化；同一技能在另一邊這麼近以內有施放就不算
const VARIANT_WINDOW_MS = 1500
const SAME_ABILITY_WINDOW_MS = 5000

/**
 * 隨機機制組：對齊後同一時間點兩邊施放不同技能（例如放入 A 面／B 面、二連／三連／四連指向），
 * 互為最近的一對就歸成同一組（會連鎖，例如二連—四連、三連—四連合成一組）。遊戲資料沒有這種分組，
 * 兩邊選到同一個變化時技能 ID 相同、本來就會配上，所以只需要從這兩場不同的地方找。
 * 回傳 技能 ID → 組的代表 ID（只含有被歸組的技能）。
 */
export function variantGroups(
  mineBoss: TimedCast[],
  refBoss: TimedCast[],
  mineToRef: (t: number) => number,
  dedupeMs: number,
): Map<number, number> {
  const side = (casts: TimedCast[], toRef: (t: number) => number) =>
    keyedCasts(casts, dedupeMs).map((c) => ({ t: toRef(c.t), abilityId: c.abilityId }))
  const mine = side(mineBoss, mineToRef)
  const ref = side(refBoss, (t) => t)
  const unmatched = (list: TimedCast[], other: TimedCast[]) =>
    list.filter((c) => !other.some((o) => o.abilityId === c.abilityId && Math.abs(o.t - c.t) <= SAME_ABILITY_WINDOW_MS))
  const mineOnly = unmatched(mine, ref)
  const refOnly = unmatched(ref, mine)
  const nearest = (c: TimedCast, list: TimedCast[]) => {
    let best: TimedCast | undefined
    for (const o of list) {
      const d = Math.abs(o.t - c.t)
      if (d <= VARIANT_WINDOW_MS && (!best || d < Math.abs(best.t - c.t))) best = o
    }
    return best
  }

  const parent = new Map<number, number>()
  const find = (id: number): number => {
    const p = parent.get(id) ?? id
    if (p === id) return id
    const root = find(p)
    parent.set(id, root)
    return root
  }
  for (const m of mineOnly) {
    const r = nearest(m, refOnly)
    if (r && nearest(r, mineOnly) === m) {
      const a = find(m.abilityId)
      const b = find(r.abilityId)
      if (a !== b) parent.set(Math.max(a, b), Math.min(a, b))
    }
  }
  const groups = new Map<number, number>()
  for (const id of parent.keys()) groups.set(id, find(id))
  // 代表 ID 本身也屬於該組
  for (const root of new Set(groups.values())) groups.set(root, root)
  return groups
}

// 挑選錨點時，時間差每跳 1 秒扣掉的分數（以錨點數計），一次跳動最多扣這麼多：小抖動照樣扣分，
// 大跳動的扣分有上限（真正的推進後錨點少時也不會被整段捨棄）
const OFFSET_JUMP_PENALTY_PER_S = 0.5
const MAX_JUMP_PENALTY = 2
// 錨點與前一個錨點相距這麼久以上才得滿分 1，較近的依比例：密集的連續施放（熱舞綠光的 Let's Dance! Remix 每 0.75 秒一次，
// 方向隨機）整段挪 3 步能多對上幾個同 ID 的施放，每個都算 1 分時會勝過時間差的穩定（±2.5 秒的錯配）
const FULL_GAIN_GAP_MS = 1000

/**
 * 從候選配對中，取兩邊時間都遞增、分數最高的一串：每個錨點 +1（與前一個錨點相距不到 1 秒時依比例），
 * 時間差（ref − mine）每跳 1 秒 −0.5、一次最多 −2，從戰鬥開始 (0, 0) 起算。兩場從 0 同步開始，時間差只在推進（依血量的轉場）時改變、之後維持，
 * 所以分數最高的一串就是「從 0 開始、同一個機制對同一個機制」的配對：時間軸固定的戰鬥（熱舞綠光）
 * 時間差一直接近 0；推進後時間差跳一次、之後的錨點都在新的時間差上。
 * @param pairs 依 mine、再依 ref 排序
 */
function bestChain(pairs: Anchor[]): Anchor[] {
  const offset = (a: Anchor) => a.ref - a.mine
  const penalty = (ms: number) => Math.min((Math.abs(ms) / 1000) * OFFSET_JUMP_PENALTY_PER_S, MAX_JUMP_PENALTY)
  const gain = (gap: number) => Math.min(1, gap / FULL_GAIN_GAP_MS)
  const score: number[] = []
  const prev: number[] = []
  pairs.forEach((p, i) => {
    let best = gain(p.mine) - penalty(offset(p))
    let from = -1
    for (let j = 0; j < i; j++) {
      const q = pairs[j]
      if (q.mine >= p.mine || q.ref >= p.ref) continue
      const s = score[j] + gain(p.mine - q.mine) - penalty(offset(p) - offset(q))
      if (s > best) {
        best = s
        from = j
      }
    }
    score[i] = best
    prev[i] = from
  })
  let end = -1
  score.forEach((s, i) => {
    if (end < 0 || s > score[end]) end = i
  })
  const result: Anchor[] = []
  for (let k = end; k >= 0; k = prev[k]) result.push(pairs[k])
  return result.reverse()
}

/**
 * 以 Boss 技能為錨點對齊兩份日誌的時間軸。
 * 1. 候選配對：兩邊同一技能、時間差在 MAX_DRIFT_MS 內的所有施放（不依「第幾次」，所以隨機順序不同也配得上）。
 * 2. 取分數最高的一串（bestChain：從 0 開始、時間差穩定）。
 * 3. 對齊兩次：第一次找出同一時間點兩邊施放不同技能的隨機機制組（variantGroups，例如放入 A 面／B 面），
 *    第二次把同一組的技能當成同一個機制（例如我的「放入 A 面」配參考同一時間的「放入 B 面」）。
 * 錨點之間線性內插，戰鬥開始 (0, 0) 為隱含錨點，最後一個錨點之後以斜率 1 外推。
 */
export function buildAlignment(
  mineBoss: TimedCast[],
  refBoss: TimedCast[],
  { dedupeMs = 1000, knownGroups = new Map() }: AlignmentOptions = {},
): Alignment {
  const first = alignWith(mineBoss, refBoss, dedupeMs, knownGroups)
  // 第一次對齊要有足夠的錨點，找出的「同一時間點」才可靠
  if (first.anchors.length < MIN_ANCHORS_FOR_GROUPS) return first
  const groups = variantGroups(mineBoss, refBoss, first.mineToRef, dedupeMs)
  return groups.size === 0 ? first : alignWith(mineBoss, refBoss, dedupeMs, mergeGroups(knownGroups, groups))
}

/** 合併兩組「技能 ID → 代表 ID」的分組（有共同技能的組合成一組），代表 ID 取組內最小的。 */
function mergeGroups(a: ReadonlyMap<number, number>, b: ReadonlyMap<number, number>): Map<number, number> {
  const parent = new Map<number, number>()
  const find = (id: number): number => {
    const p = parent.get(id) ?? id
    if (p === id) return id
    const root = find(p)
    parent.set(id, root)
    return root
  }
  const union = (x: number, y: number) => {
    const rx = find(x)
    const ry = find(y)
    if (rx !== ry) parent.set(Math.max(rx, ry), Math.min(rx, ry))
  }
  for (const groups of [a, b]) for (const [id, key] of groups) union(id, key)
  const merged = new Map<number, number>()
  for (const id of [...a.keys(), ...b.keys()]) merged.set(id, find(id))
  return merged
}

function alignWith(
  mineBoss: TimedCast[],
  refBoss: TimedCast[],
  dedupeMs: number,
  groups: ReadonlyMap<number, number>,
): Alignment {
  const mine = keyedCasts(mineBoss, dedupeMs, groups)
  const ref = keyedCasts(refBoss, dedupeMs, groups)
  // 依時間配對，頻繁施放的技能也不會像「第 n 次」那樣錯位，因此不限制施放次數
  const refByKey = new Map<number, KeyedCast[]>()
  for (const r of ref) if (r.t > 0) refByKey.set(r.key, [...(refByKey.get(r.key) ?? []), r])

  // 同一技能（或同一組）在時間差上限內的所有施放都是候選；已依時間排序，候選依 mine、再依 ref 排序
  const candidates: Anchor[] = []
  for (const m of mine) {
    if (m.t <= 0) continue
    for (const r of refByKey.get(m.key) ?? []) {
      if (Math.abs(r.t - m.t) <= MAX_DRIFT_MS) candidates.push({ mine: m.t, ref: r.t, abilityId: m.abilityId })
    }
  }
  // bestChain 保證兩邊都嚴格遞增（同一時間點只會留一個），因此兩個方向都能分段內插
  const anchors = bestChain(candidates)
  const points = [{ mine: 0, ref: 0 }, ...anchors]
  const forward = points.map((p) => ({ from: p.mine, to: p.ref }))
  const backward = points.map((p) => ({ from: p.ref, to: p.mine }))

  return {
    anchors,
    mineToRef: (t) => piecewise(forward, t),
    refToMine: (t) => piecewise(backward, t),
  }
}