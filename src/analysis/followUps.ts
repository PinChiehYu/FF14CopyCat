// 追擊漏接：前一招之後（下一次前一招之前、FOLLOW_UP_WITHIN_MS 內）沒有接追擊的時間點
import { FOLLOW_UP_WITHIN_MS, type FollowUpRule } from '../jobs/followUpRules'
import type { TimedCast } from './alignment'

export interface FollowUpResult {
  rule: FollowUpRule
  /** 前一招的次數 */
  parents: number
  /** 沒有接追擊的前一招時間（這一側的戰鬥時間） */
  missed: number[]
}

export function followUpResults(rules: FollowUpRule[], casts: TimedCast[]): FollowUpResult[] {
  return rules.map((rule) => {
    const parents = casts.filter((c) => rule.parents.includes(c.abilityId)).map((c) => c.t).sort((a, b) => a - b)
    const follows = casts.filter((c) => rule.followUp.includes(c.abilityId)).map((c) => c.t)
    const missed = parents.filter((t, i) => {
      const until = Math.min(parents[i + 1] ?? Infinity, t + FOLLOW_UP_WITHIN_MS)
      return !follows.some((f) => f > t && f <= until)
    })
    return { rule, parents: parents.length, missed }
  })
}
