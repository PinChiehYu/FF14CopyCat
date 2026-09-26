// 冷卻技是否好了就用：移植 xivanalysis 的 CooldownDowntime（calculateMaxUsages）算出理論最多可用次數，
// 並列出每次使用比冷卻好的時間晚了多久。Boss 無法選取（沒有 Boss 位置）的時段視為停機，不算浪費。
import type { CooldownGroup } from '../jobs/cooldownRules'
import type { TimedCast } from './alignment'
import { BOSS_LIMITS, positionAt, type PositionSample } from './positions'

export interface Downtime {
  start: number
  end: number
}

// 停機判斷的取樣間隔與最短長度（短暫的取樣空缺不算）
const DOWNTIME_STEP_MS = 1000
const MIN_DOWNTIME_MS = 5000

/** Boss 沒有位置（無法選取、轉場）的時段，依時間排序。 */
export function downtimeWindows(bossSamples: PositionSample[], durationMs: number): Downtime[] {
  if (bossSamples.length === 0) return []
  const windows: Downtime[] = []
  let start: number | null = null
  for (let t = 0; t <= durationMs; t += DOWNTIME_STEP_MS) {
    const absent = positionAt(bossSamples, t, BOSS_LIMITS) === null
    if (absent && start === null) start = t
    if (!absent && start !== null) {
      if (t - start >= MIN_DOWNTIME_MS) windows.push({ start, end: t })
      start = null
    }
  }
  if (start !== null && durationMs - start >= MIN_DOWNTIME_MS) windows.push({ start, end: durationMs })
  return windows
}

const inDowntime = (windows: Downtime[], t: number) => windows.find((w) => t >= w.start && t < w.end)

/**
 * 理論最多可用次數（xivanalysis 的 calculateMaxUsages）：從預期第一次使用起，每次冷卻好就用；
 * 停機期間累積的充能留到停機結束再用；有充能的技能不另加容許延遲。
 */
export function maxUsages(
  group: CooldownGroup,
  uses: number[],
  resets: number[],
  durationMs: number,
  downtime: Downtime[],
): number {
  const maxCharges = group.charges || 1
  const step = group.cooldownMs + (maxCharges > 1 ? 0 : group.allowedDowntimeMs)
  const refund = group.resetBy?.refundMs ?? 0
  const pendingResets = [...resets].sort((a, b) => a - b)
  const dtUsages = uses.map((t) => inDowntime(downtime, t)).filter((w): w is Downtime => w !== undefined)
  const expectedFirst = group.firstUseOffsetMs ?? 0

  let charges = maxCharges
  let count = 0
  let current = uses.length > 0 ? Math.min(uses[0], expectedFirst) : expectedFirst
  if ((group.firstUseOffsetMs ?? 0) < 0 && maxCharges === 1 && uses.length > 1 && uses[1] - uses[0] < group.cooldownMs) {
    // 開打前用過：第二次使用早於一個冷卻，代表第一次在開打前
    count += 1
    current = uses[1]
  }

  // 安全上限：避免資料異常時無窮迴圈
  for (let guard = 0; current < durationMs && guard < 10_000; guard++) {
    count += charges
    charges = 0
    current += step
    charges += 1

    while (pendingResets.length > 0 && pendingResets[0] < current) {
      const reset = pendingResets.shift()!
      if (current - refund < reset) {
        if (charges < maxCharges) current -= refund
        else current = reset
      } else {
        current -= refund
      }
    }

    while (current < durationMs && charges < maxCharges && inDowntime(downtime, current)) {
      const w = inDowntime(downtime, current)!
      if (w.end < current + step) {
        count += charges
        charges = 0
      }
      current += step
      charges += 1
    }

    const w = current < durationMs ? inDowntime(downtime, current) : undefined
    if (w) {
      const used = dtUsages.findIndex((d) => d.end === w.end)
      if (used === -1) current = w.end
      else {
        current = dtUsages[used].start
        dtUsages.splice(used, 1)
      }
    }
  }
  return count
}

export interface LateUse {
  /** 使用時間（這一側的戰鬥時間） */
  t: number
  /** 比冷卻好（且不在停機中）的時間晚了多久，已扣掉容許延遲 */
  lateMs: number
}

/**
 * 每次使用晚了多久：以實際的使用模擬充能，充能已滿（技能閒置）卻沒有使用的時間（不含停機），
 * 扣掉容許延遲後記在下一次使用上。第一次使用以預期第一次使用的時間為起點。
 */
export function lateUses(group: CooldownGroup, uses: number[], resets: number[], downtime: Downtime[]): LateUse[] {
  const maxCharges = group.charges || 1
  const refund = group.resetBy?.refundMs ?? 0
  const allowed = maxCharges > 1 ? 0 : group.allowedDowntimeMs
  const events = [
    ...uses.map((t) => ({ t, kind: 'use' as const })),
    ...resets.map((t) => ({ t, kind: 'reset' as const })),
  ].sort((a, b) => a.t - b.t)
  const activeBetween = (a: number, b: number) =>
    b <= a ? 0 : b - a - downtime.reduce((sum, w) => sum + Math.max(0, Math.min(b, w.end) - Math.max(a, w.start)), 0)

  let charges = maxCharges
  // 充能滿的起點（null 代表還沒滿）；開場以預期第一次使用的時間為起點
  let fullSince: number | null = Math.max(0, group.firstUseOffsetMs ?? 0)
  // 下一次充能完成的時間
  let nextCharge = Infinity
  const result: LateUse[] = []

  const advance = (to: number) => {
    while (charges < maxCharges && nextCharge <= to) {
      charges += 1
      if (charges === maxCharges) fullSince = nextCharge
      nextCharge = charges < maxCharges ? nextCharge + group.cooldownMs : Infinity
    }
  }

  for (const e of events) {
    advance(e.t)
    if (e.kind === 'reset') {
      if (charges < maxCharges) nextCharge -= refund
      advance(e.t)
      continue
    }
    const held = fullSince !== null && charges === maxCharges ? activeBetween(fullSince, e.t) : 0
    const late = held - allowed
    if (late > 0) result.push({ t: e.t, lateMs: late })
    // 使用：減少一次充能。模擬的充能為 0 卻能使用，代表實際上已經好了（冷卻時間的四捨五入誤差、
    // 或被其他技能縮短），此時從這次使用重新計時，否則下一次充能會立刻完成、把下一次使用誤判為晚了一輪
    const wasFull = charges === maxCharges
    const early = charges === 0
    charges = Math.max(0, charges - 1)
    if (wasFull || early || nextCharge === Infinity) nextCharge = e.t + group.cooldownMs
    fullSince = null
  }
  return result
}

// 冷卻好後晚了這麼久以上才算「晚用」（列出）
export const LATE_LISTED_MS = 5000

/** 兩邊同一個冷卻技組（依各自版本的規則；該版本沒有時為 null） */
export interface CooldownPair {
  mine: CooldownUsage | null
  ref: CooldownUsage | null
}

export interface CooldownUsage {
  group: CooldownGroup
  /** 比較範圍內的使用次數 */
  uses: number
  /** 理論最多可用次數 */
  max: number
  late: LateUse[]
}

/**
 * 一側所有追蹤的冷卻技。casts 為這一側（比較範圍內）的施放，時間為這一側的戰鬥時間。
 * usedPrepull：開打前已用過的技能組（開打當下身上有它的效果，FFLogs 不記錄開打前的施放），視為 0:00 用了一次。
 */
export function cooldownUsage(
  groups: CooldownGroup[],
  casts: TimedCast[],
  durationMs: number,
  downtime: Downtime[],
  usedPrepull: (group: CooldownGroup) => boolean = () => false,
): CooldownUsage[] {
  return groups.map((group) => {
    const ids = new Set(group.ids)
    const resetIds = new Set(group.resetBy?.ids ?? [])
    const uses = [...(usedPrepull(group) ? [0] : []), ...casts.filter((c) => ids.has(c.abilityId)).map((c) => c.t)]
    const resets = casts.filter((c) => resetIds.has(c.abilityId)).map((c) => c.t)
    return {
      group,
      uses: uses.length,
      // 模型沒有考慮的冷卻縮短、比較範圍邊界等會讓實際次數超過上限（xivanalysis 同樣以 100% 封頂）
      max: Math.max(uses.length, maxUsages(group, uses, resets, durationMs, downtime)),
      late: lateUses(group, uses, resets, downtime),
    }
  })
}
