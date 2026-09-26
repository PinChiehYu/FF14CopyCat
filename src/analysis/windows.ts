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

/** 依規則評估一側的每個窗口。 */
export function evaluateWindows(
  rule: WindowRule,
  buffs: BuffWindow[],
  casts: TimedCast[],
  isGcd: (id: number) => boolean,
  abilityName: (id: number) => string,
): WindowSummary {
  const names = (ids: number[]) => [...new Set(ids)].map(abilityName).join('、')
  const windows = buffs
    .filter((b) => b.statusId === rule.statusId)
    .map((b): EvaluatedWindow => {
      const inside = casts.filter((c) => c.t >= b.start && c.t <= b.end + END_TOLERANCE_MS)
      const gcds = inside.filter(
        (c) =>
          isGcd(c.abilityId) &&
          !rule.ignoredGcds?.includes(c.abilityId) &&
          (!rule.trackedGcds || rule.trackedGcds.includes(c.abilityId)),
      )
      const issues: string[] = []
      if (rule.expectedGcds !== undefined && gcds.length < rule.expectedGcds) {
        issues.push(`只打了 ${gcds.length} 個 GCD（應 ${rule.expectedGcds} 個）`)
      }
      if (rule.allowedGcds) {
        const wrong = gcds.filter((c) => !rule.allowedGcds!.includes(c.abilityId)).map((c) => c.abilityId)
        if (wrong.length > 0) issues.push(`不應使用：${names(wrong)}`)
      }
      for (const group of rule.expectedActions ?? []) {
        const used = (id: number) => inside.filter((c) => c.abilityId === id).length
        if (group.mode === 'each') {
          const missing = group.ids.filter((id) => used(id) < group.count)
          if (missing.length > 0) issues.push(`${group.label}缺少：${names(missing)}`)
        } else {
          const total = group.ids.reduce((sum, id) => sum + used(id), 0)
          if (total < group.count) issues.push(`${group.label}只用了 ${total} 個（應 ${group.count} 個）`)
        }
      }
      return { start: b.start, end: b.end, gcds: gcds.length, issues, judged: !b.openEnded }
    })
  const judged = windows.filter((w) => w.judged)
  return { rule, windows, judged: judged.length, passed: judged.filter((w) => w.issues.length === 0).length }
}
