import type { TimedCast } from './alignment'

export interface MechanicDifference {
  /** 參考時間 */
  t: number
  /** 我的日誌中這個時間點的 Boss 技能（沒有則為空） */
  mine: number[]
  /** 參考日誌中這個時間點的 Boss 技能 */
  ref: number[]
  /** variant：同一時間施放不同技能（隨機變化）；only-mine／only-ref：只有一邊有 */
  kind: 'variant' | 'only-mine' | 'only-ref'
}

export interface MechanicOptions {
  /** 兩邊時間相差多少以內視為同一時間點 */
  windowMs?: number
  /** 同一技能相差多少以內視為同一次機制（轉場附近對齊可能差幾秒） */
  sameAbilityWindowMs?: number
  /** 同一技能這段時間內重複施放視為一次 */
  dedupeMs?: number
  /** 施放次數超過此值的技能（自動攻擊等）不比較 */
  maxOccurrences?: number
}

/**
 * 機制差異一側的技能名稱。同一次攻擊常由多個同名技能 ID 組成（例如多個判定），同名只列一次；
 * 兩邊同名但 ID 不同（例如左右兩種版本）且這一側只有單一 ID 時附上 ID 才分得出來。
 */
export function mechanicLabel(ids: number[], others: number[], abilityName: (id: number) => string): string {
  const byName = new Map<string, number[]>()
  for (const id of ids) byName.set(abilityName(id), [...(byName.get(abilityName(id)) ?? []), id])
  return [...byName]
    .map(([name, own]) => {
      const theirs = others.filter((o) => abilityName(o) === name)
      const differs = theirs.some((o) => !own.includes(o))
      return differs && own.length === 1 ? `${name} #${own[0]}` : name
    })
    .join('、')
}

export interface MergedDifference extends MechanicDifference {
  /** 合併的最後一個時間點（參考時間） */
  last: number
  /** 合併了幾個時間點 */
  count: number
}

/**
 * 顯示用：同一招的連續結算（兩邊的技能名稱與類型都相同、間隔 gapMs 以內）合併成一列，ID 取聯集。
 */
export function mergeRepeats(
  differences: MechanicDifference[],
  abilityName: (id: number) => string,
  gapMs = 6000,
): MergedDifference[] {
  const key = (ids: number[]) => [...new Set(ids.map(abilityName))].sort().join('|')
  const merged: MergedDifference[] = []
  for (const d of differences) {
    const prev = merged.at(-1)
    if (
      prev &&
      prev.kind === d.kind &&
      d.t - prev.last <= gapMs &&
      key(prev.mine) === key(d.mine) &&
      key(prev.ref) === key(d.ref)
    ) {
      prev.last = d.t
      prev.count++
      prev.mine = [...new Set([...prev.mine, ...d.mine])]
      prev.ref = [...new Set([...prev.ref, ...d.ref])]
    } else {
      merged.push({ ...d, last: d.t, count: 1 })
    }
  }
  return merged
}

function dedupe(casts: TimedCast[], dedupeMs: number): TimedCast[] {
  const last = new Map<number, number>()
  return [...casts]
    .sort((a, b) => a.t - b.t)
    .filter((c) => {
      const prev = last.get(c.abilityId)
      last.set(c.abilityId, c.t)
      return prev === undefined || c.t - prev >= dedupeMs
    })
}

function counts(casts: TimedCast[]): Map<number, number> {
  const map = new Map<number, number>()
  for (const c of casts) map.set(c.abilityId, (map.get(c.abilityId) ?? 0) + 1)
  return map
}

/**
 * 找出兩份日誌中 Boss 機制不同的時間點（以參考時間表示）。
 * 同一技能在另一邊 windowMs 內也有施放就算相同；剩下沒配對的，兩邊在同一時間點都有者視為隨機變化。
 * @param mineEnd／refEnd 各自戰鬥結束的參考時間；超過較短一方結束時間的施放不列出
 */
export function mechanicDifferences(
  mineBoss: TimedCast[],
  refBoss: TimedCast[],
  mineToRef: (t: number) => number,
  mineEnd: number,
  refEnd: number,
  { windowMs = 1500, sameAbilityWindowMs = 5000, dedupeMs = 1000, maxOccurrences = 8 }: MechanicOptions = {},
): MechanicDifference[] {
  const mineAll = dedupe(mineBoss, dedupeMs)
  const refAll = dedupe(refBoss, dedupeMs)
  const mineCounts = counts(mineAll)
  const refCounts = counts(refAll)
  const rare = (id: number) => (mineCounts.get(id) ?? 0) <= maxOccurrences && (refCounts.get(id) ?? 0) <= maxOccurrences
  const end = Math.min(mineEnd, refEnd)

  const mine = mineAll.filter((c) => rare(c.abilityId)).map((c) => ({ t: mineToRef(c.t), abilityId: c.abilityId }))
  const ref = refAll.filter((c) => rare(c.abilityId))

  const hasSame = (a: TimedCast, list: TimedCast[]) =>
    list.some((b) => b.abilityId === a.abilityId && Math.abs(a.t - b.t) <= sameAbilityWindowMs)
  const mineOnly = mine.filter((c) => c.t <= end && !hasSame(c, ref))
  const refOnly = ref.filter((c) => c.t <= end && !hasSame(c, mine))

  // 依時間把沒配對的施放合併成時間點（同一時間多個技能算一個機制）
  const events = [
    ...mineOnly.map((c) => ({ ...c, side: 'mine' as const })),
    ...refOnly.map((c) => ({ ...c, side: 'ref' as const })),
  ].sort((a, b) => a.t - b.t)

  const groups: { t: number; last: number; mine: Set<number>; ref: Set<number> }[] = []
  for (const e of events) {
    const g = groups.at(-1)
    if (g && e.t - g.last <= windowMs) {
      g.last = e.t
      g[e.side].add(e.abilityId)
    } else {
      groups.push({ t: e.t, last: e.t, mine: new Set(e.side === 'mine' ? [e.abilityId] : []), ref: new Set(e.side === 'ref' ? [e.abilityId] : []) })
    }
  }

  return groups.map((g) => ({
    t: g.t,
    mine: [...g.mine],
    ref: [...g.ref],
    kind: g.mine.size > 0 && g.ref.size > 0 ? 'variant' : g.mine.size > 0 ? 'only-mine' : 'only-ref',
  }))
}
