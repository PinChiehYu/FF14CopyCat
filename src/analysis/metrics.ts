import type { TimedCast } from './alignment'

export interface GcdStats {
  count: number
  /** 推估的 GCD 間隔（毫秒）：1.5～3 秒之間相鄰 GCD 間隔的中位數；GCD 太少時為 null */
  gcdMs: number | null
  /** 空檔總計（毫秒）：每個間隔超出 GCD 的部分加總，含 Boss 無法攻擊的時間 */
  idleMs: number
}

// 容許的誤差（網路延遲、動畫鎖）
const IDLE_TOLERANCE_MS = 100

function median(values: number[]): number | null {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[sorted.length >> 1]
}

function gaps(times: number[]): number[] {
  return times.slice(1).map((t, i) => t - times[i])
}

/** @param gcdTimes 依時間排序的 GCD 開始施放時間 */
export function gcdStats(gcdTimes: number[]): GcdStats {
  const intervals = gaps(gcdTimes)
  const gcdMs = median(intervals.filter((g) => g >= 1500 && g <= 3000))
  const idleMs =
    gcdMs === null ? 0 : intervals.reduce((sum, g) => sum + Math.max(0, g - gcdMs - IDLE_TOLERANCE_MS), 0)
  return { count: gcdTimes.length, gcdMs, idleMs }
}

export interface LostWindow {
  /** 我停手的區間（我的戰鬥時間） */
  mineStart: number
  mineEnd: number
  /** 同一段在參考日誌中的時間 */
  refStart: number
  refEnd: number
  /** 參考在這段期間施放的 GCD 數，即我少打的 GCD 數 */
  refGcds: number
}

/**
 * 找出「我停手、但參考在同一段仍持續施放 GCD」的區間。雙方都停手的時段（Boss 無法攻擊等）不列入。
 * @param gcdMs 我的 GCD 間隔；間隔超過 1.5 倍 GCD（且至少多 1 秒）才視為停手
 */
export function lostGcdWindows(
  mineGcds: number[],
  refGcds: number[],
  mineToRef: (t: number) => number,
  gcdMs: number,
): LostWindow[] {
  const threshold = Math.max(gcdMs * 1.5, gcdMs + 1000)
  // 區間兩端各留半個 GCD，避免把與我兩端 GCD 對應的參考 GCD 算進去
  const margin = gcdMs / 2
  const windows: LostWindow[] = []
  for (let i = 1; i < mineGcds.length; i++) {
    const mineStart = mineGcds[i - 1]
    const mineEnd = mineGcds[i]
    if (mineEnd - mineStart <= threshold) continue
    const refStart = mineToRef(mineStart)
    const refEnd = mineToRef(mineEnd)
    const refCount = refGcds.filter((t) => t > refStart + margin && t < refEnd - margin).length
    if (refCount > 0) windows.push({ mineStart, mineEnd, refStart, refEnd, refGcds: refCount })
  }
  return windows
}

export interface AbilityUsage {
  abilityId: number
  mine: number
  ref: number
  /** 配對成功的使用次數 */
  matched: number
  /** 配對到的使用中，我（對齊後）比參考晚多少毫秒的平均；負值代表較早。沒有配對時為 null */
  avgDelayMs: number | null
}

// 兩次使用相距超過此值就不視為「同一次」
const MAX_MATCH_MS = 30_000

/**
 * 依時間順序配對兩邊的使用（不可交錯）：先求配對數最多，再求時間差總和最小。
 * 用次數不同時，逐次配對會讓後面全部錯位，因此需要允許跳過。
 * @returns 各配對的時間差（mine - ref）
 */
export function matchUses(mine: number[], ref: number[], maxMs = MAX_MATCH_MS): number[] {
  const n = mine.length
  const m = ref.length
  // best[i][j]：mine[i..] 與 ref[j..] 的最佳結果
  const best: { count: number; cost: number; take: boolean; skipMine: boolean }[][] = Array.from(
    { length: n + 1 },
    () => Array.from({ length: m + 1 }, () => ({ count: 0, cost: 0, take: false, skipMine: false })),
  )
  const better = (a: { count: number; cost: number }, b: { count: number; cost: number }) =>
    a.count > b.count || (a.count === b.count && a.cost < b.cost)

  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      const skipMine = best[i + 1][j]
      const skipRef = best[i][j + 1]
      let cell = better(skipMine, skipRef)
        ? { count: skipMine.count, cost: skipMine.cost, take: false, skipMine: true }
        : { count: skipRef.count, cost: skipRef.cost, take: false, skipMine: false }
      const d = Math.abs(mine[i] - ref[j])
      if (d <= maxMs) {
        const take = { count: best[i + 1][j + 1].count + 1, cost: best[i + 1][j + 1].cost + d }
        if (better(take, cell)) cell = { ...take, take: true, skipMine: false }
      }
      best[i][j] = cell
    }
  }

  const delays: number[] = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    const cell = best[i][j]
    if (cell.take) {
      delays.push(mine[i] - ref[j])
      i++
      j++
    } else if (cell.skipMine) i++
    else j++
  }
  return delays
}

/**
 * 各技能的使用次數與時機比較，依次數差距大小排序。
 * @param maxUsesForTiming 使用次數超過此值（連擊等）不計算時機，避免 O(n²) 配對與無意義的結果
 */
export function abilityUsage(
  mineCasts: TimedCast[],
  refCasts: TimedCast[],
  mineToRef: (t: number) => number,
  maxUsesForTiming = 30,
): AbilityUsage[] {
  const group = (casts: TimedCast[], map: (t: number) => number) => {
    const groups = new Map<number, number[]>()
    for (const c of casts) groups.set(c.abilityId, [...(groups.get(c.abilityId) ?? []), map(c.t)])
    return groups
  }
  const mine = group(mineCasts, mineToRef)
  const ref = group(refCasts, (t) => t)
  const ids = new Set([...mine.keys(), ...ref.keys()])

  const rows: AbilityUsage[] = [...ids].map((abilityId) => {
    const m = mine.get(abilityId) ?? []
    const r = ref.get(abilityId) ?? []
    const delays = Math.max(m.length, r.length) <= maxUsesForTiming ? matchUses(m, r) : []
    return {
      abilityId,
      mine: m.length,
      ref: r.length,
      matched: delays.length,
      avgDelayMs: delays.length > 0 ? delays.reduce((a, b) => a + b, 0) / delays.length : null,
    }
  })
  return rows.sort((a, b) => Math.abs(b.ref - b.mine) - Math.abs(a.ref - a.mine) || b.ref - a.ref)
}
