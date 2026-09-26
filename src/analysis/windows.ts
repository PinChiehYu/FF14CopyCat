import type { WindowRule } from '../jobs/windows'
import type { TimedCast } from './alignment'
import type { BuffWindow } from './buffs'
import { formatFightTime } from './timeline'

/** 窗口結束時的容許誤差：最後一個 GCD 常在效果移除的同一時間施放 */
const END_TOLERANCE_MS = 100

export interface EvaluatedWindow {
  start: number
  end: number
  /** 窗口內的 GCD 數 */
  gcds: number
  /** 沒達到規則的地方（空的代表合格） */
  issues: string[]
  /** 窗口到戰鬥（或比較範圍）結束都還沒結束：不評分 */
  judged: boolean
}

export interface WindowSummary {
  rule: WindowRule
  windows: EvaluatedWindow[]
  /** 評分的窗口數與合格數 */
  judged: number
  passed: number
  /** 這一邊的遊戲版本沒有這條規則時的說明（不評分） */
  inapplicable?: string
}

/** 某一邊的版本沒有這條規則：沿用另一邊的規則顯示名稱，不評分。 */
export function inapplicableSummary(rule: WindowRule, reason: string): WindowSummary {
  return { rule, windows: [], judged: 0, passed: 0, inapplicable: reason }
}

export type WindowState = 'ok' | 'bad' | 'unjudged'

export function windowState(w: EvaluatedWindow): WindowState {
  return !w.judged ? 'unjudged' : w.issues.length === 0 ? 'ok' : 'bad'
}

/** 滑鼠提示：時段與結果（合格、問題或不評分）。 */
export function windowTitle(w: EvaluatedWindow): string {
  return (
    `${formatFightTime(w.start)}～${formatFightTime(w.end)}：` +
    (!w.judged ? '到比較範圍結束都還沒結束，不評分' : w.issues.length === 0 ? '合格' : w.issues.join('；'))
  )
}

/** 時間軸上的窗口（該側自己的戰鬥時間）。 */
export interface TimelineWindow {
  start: number
  end: number
  state: WindowState
  title: string
}

export function timelineWindow(w: EvaluatedWindow, name: string): TimelineWindow {
  return { start: w.start, end: w.end, state: windowState(w), title: `${name} ${windowTitle(w)}` }
}

// 開打這麼久以內開始的窗口視為開場（部分規則開場的要求不同）
const OPENER_MS = 10_000
// GCD 數封頂計算時扣掉的開頭時間（與 xivanalysis 相同）
const WINDOW_START_OFFSET_MS = 250
// 無法估計 GCD 時使用的預設值
const DEFAULT_GCD_MS = 2500

/** 兩組時段的交集。 */
function intersect(a: BuffWindow[], b: BuffWindow[]): BuffWindow[] {
  const out: BuffWindow[] = []
  for (const x of a) {
    for (const y of b) {
      const start = Math.max(x.start, y.start)
      const end = Math.min(x.end, y.end)
      if (start < end) {
        // 交集的結束點來自哪一段，就沿用那一段是否未結束
        const openEnded = (end === x.end && x.openEnded) || (end === y.end && y.openEnded)
        out.push({ statusId: x.statusId, start, end, prepull: false, openEnded })
      }
    }
  }
  return out
}

/** 依規則的觸發方式取出這一側的窗口。 */
export function ruleWindows(rule: WindowRule, buffs: BuffWindow[], casts: TimedCast[], durationMs: number): BuffWindow[] {
  if (rule.statusId !== undefined) return buffs.filter((b) => b.statusId === rule.statusId)
  if (rule.action) {
    const { id, durationMs: length } = rule.action
    return casts
      .filter((c) => c.abilityId === id)
      .map((c) => ({
        statusId: id,
        start: c.t,
        end: Math.min(c.t + length, durationMs),
        prepull: false,
        openEnded: c.t + length > durationMs,
      }))
  }
  if (rule.allOf && rule.allOf.length > 0) {
    return rule.allOf
      .map((id) => buffs.filter((b) => b.statusId === id))
      .reduce((acc, next) => intersect(acc, next))
      .sort((a, b) => a.start - b.start)
  }
  return []
}

/**
 * 依規則評估一側的每個窗口。
 * @param durationMs 這一側（比較範圍內）的戰鬥長度；由技能觸發的窗口超過這個時間時不評分
 * @param gcdMs 這一側估計的 GCD 間隔，用來依窗口長度封頂應打的 GCD 數
 */
export function evaluateWindows(
  rule: WindowRule,
  buffs: BuffWindow[],
  casts: TimedCast[],
  isGcd: (id: number) => boolean,
  abilityName: (id: number) => string,
  gcdMs: number | null = DEFAULT_GCD_MS,
  durationMs = Infinity,
): WindowSummary {
  const names = (ids: number[]) => [...new Set(ids)].map(abilityName).join('、')
  const openerMs = rule.openerMs ?? OPENER_MS
  const windows = ruleWindows(rule, buffs, casts, durationMs).map((b): EvaluatedWindow => {
      const inside = casts.filter((c) => c.t >= b.start && c.t <= b.end + END_TOLERANCE_MS)
      const gcds = inside.filter(
        (c) =>
          isGcd(c.abilityId) &&
          !rule.ignoredGcds?.includes(c.abilityId) &&
          (!rule.trackedGcds || rule.trackedGcds.includes(c.abilityId)),
      )
      const issues: string[] = []
      const used = (id: number) => inside.filter((c) => c.abilityId === id).length
      const opener = b.start < openerMs
      if (rule.expectedGcds !== undefined) {
        const fit = Math.ceil((b.end - b.start - WINDOW_START_OFFSET_MS) / (gcdMs ?? DEFAULT_GCD_MS))
        const adjust = rule.gcdAdjust ? rule.gcdAdjust.ids.reduce((sum, id) => sum + used(id), 0) * rule.gcdAdjust.perUse : 0
        const base = rule.stacks ? rule.expectedGcds : Math.min(rule.expectedGcds, fit)
        const expected = Math.max(0, base + adjust)
        if (gcds.length < expected) issues.push(`只打了 ${gcds.length} 個 GCD（應 ${expected} 個）`)
      }
      if (rule.allowedGcds) {
        const wrong = gcds.filter((c) => !rule.allowedGcds!.includes(c.abilityId)).map((c) => c.abilityId)
        if (wrong.length > 0) issues.push(`不應使用：${names(wrong)}`)
      }
      for (const limited of rule.limitedActions ?? []) {
        const allowed = opener ? (limited.openerAllowed ?? 0) : 0
        const wrong = limited.ids.filter((id) => used(id) > allowed)
        if (wrong.length > 0) issues.push(`不應使用：${names(wrong)}`)
      }
      for (const group of rule.expectedActions ?? []) {
        if (group.onlyIf && !group.onlyIf.some((id) => used(id) > 0)) continue
        const count = opener && group.openerCount !== undefined ? group.openerCount : group.count
        if (count === 0) continue
        // 問題說明直接列出技能的官方繁中名稱
        if (group.mode === 'each') {
          const missing = group.ids.filter((id) => used(id) < count)
          if (missing.length > 0 && count === 1) issues.push(`缺少：${names(missing)}`)
          for (const id of count > 1 ? missing : []) issues.push(`${abilityName(id)} 只用了 ${used(id)} 次（應 ${count} 次）`)
        } else {
          const total = group.ids.reduce((sum, id) => sum + used(id), 0)
          if (total < count) issues.push(`${names(group.ids)} 合計只用了 ${total} 次（應 ${count} 次）`)
        }
      }
      return { start: b.start, end: b.end, gcds: gcds.length, issues, judged: !b.openEnded }
  })
  const judged = windows.filter((w) => w.judged)
  return { rule, windows, judged: judged.length, passed: judged.filter((w) => w.issues.length === 0).length }
}
