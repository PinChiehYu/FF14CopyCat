// 技能窗口規則的格式與查詢：某個效果（Buff）期間應該做到的事，參考 xivanalysis（MIT）的職業模組。
// 各職業的規則在 windowRules.ts。
import { inPatchRange } from './patch'
import { RULES } from './windowRules'

export interface ExpectedActions {
  ids: number[]
  /** each：每個技能各要用 count 次；total：這組技能合計要用 count 次 */
  mode: 'each' | 'total'
  count: number
  /** 開場的窗口（見 WindowRule.openerMs）改用這個次數 */
  openerCount?: number
  /** 只有窗口內用了其中任一技能時才要求（例如忍者的天理人道只在天地人窗口要求） */
  onlyIf?: number[]
}

/** 窗口內不應使用的技能（xivanalysis 的 LimitedActionsEvaluator，上限 0）。 */
export interface LimitedActions {
  ids: number[]
  /** 開場的窗口允許的次數 */
  openerAllowed?: number
}

export interface WindowRule {
  key: string
  /**
   * 觸發窗口的方式（三擇一）：
   * - statusId：效果期間（自身效果或施加在敵人身上的效果，效果 ID＝狀態 ID＋1,000,000）
   * - action：施放某技能後固定一段時間（例如龍騎的武神槍後 20 秒）
   * - allOf：多個效果同時存在的期間（例如吟遊詩人三個 Buff 重疊的爆發期）
   */
  statusId?: number
  action?: { id: number; durationMs: number }
  allOf?: number[]
  /** 開打這麼久以內開始的窗口視為開場（預設 10 秒） */
  openerMs?: number
  /**
   * 窗口內應打的 GCD 數。依時間結束的窗口（stacks 為 false）另以窗口長度封頂：
   * 最多 ceil((長度 − 250 ms) ÷ GCD)，與 xivanalysis 的 ExpectedGcdCountEvaluator 相同
   */
  expectedGcds?: number
  /** 以層數消耗結束的效果（例如明鏡止水），或 xivanalysis 不封頂的規則：GCD 數不依窗口長度封頂 */
  stacks?: boolean
  /** 窗口內每用一次這些技能，應打的 GCD 數增減（例如忍者天地人 +1、武僧六合星導腳 −1） */
  gcdAdjust?: { ids: number[]; perUse: number }
  /**
   * 只計算這些 GCD（GCD 數與 allowedGcds 都只看這些）；例如明鏡止水只影響武士的連擊技，
   * 居合術、燕返、奧義斬浪不消耗明鏡止水，不列入判斷
   */
  trackedGcds?: number[]
  /** 窗口內只能使用這些 GCD */
  allowedGcds?: number[]
  /** 不計入 GCD 數的技能（例如騎士的深仁厚澤是治療、忍者的結印） */
  ignoredGcds?: number[]
  /** 窗口內應使用的技能 */
  expectedActions?: ExpectedActions[]
  /** 窗口內不應使用的技能 */
  limitedActions?: LimitedActions[]
  /** 規則出處（xivanalysis 模組） */
  source: string
  /**
   * 適用的遊戲版本（from 含、before 不含）；同一個 key 可有多個版本的規則，依列出的順序取第一個適用的
   * （xivanalysis 以 parser.patch 分支的規則，例如絕槍的終結之心 7.4 起每個窗口都要求）
   */
  patches?: { from?: string; before?: string }
  /** 這個版本的規則與其他版本的差異（顯示在滑鼠提示與版本不同時的說明） */
  patchNote?: string
}

/**
 * 職業的技能窗口規則；沒有規則的職業回傳空陣列。指定版本時，每個 key 只取第一個適用該版本的規則，
 * 沒有適用的就不列（例如赤魔的魔元化只到 7.3）；不指定時列出所有規則（查名稱用）。
 */
export function windowRules(subType: string, patch?: string): WindowRule[] {
  const all = RULES[subType] ?? []
  if (patch === undefined) return all
  const seen = new Set<string>()
  return all.filter((rule) => {
    if (seen.has(rule.key) || !inPatchRange(patch, rule.patches)) return false
    seen.add(rule.key)
    return true
  })
}

/** 兩邊各自版本的規則，依 key 配對（依規則列出的順序）；某一邊的版本沒有這條規則時為 null。 */
export function pairedWindowRules(
  subType: string,
  minePatch: string,
  refPatch: string,
): { key: string; mine: WindowRule | null; ref: WindowRule | null }[] {
  const mine = windowRules(subType, minePatch)
  const ref = windowRules(subType, refPatch)
  const keys = [...new Set((RULES[subType] ?? []).map((r) => r.key))]
  return keys
    .map((key) => ({ key, mine: mine.find((r) => r.key === key) ?? null, ref: ref.find((r) => r.key === key) ?? null }))
    .filter((p) => p.mine || p.ref)
}

/** 規則中出現的所有技能與效果 ID（查詢繁中名稱用：沒用過的技能不在報告的技能清單中）。 */
export function ruleIds(rule: WindowRule): number[] {
  return [
    rule.statusId,
    rule.action?.id,
    ...(rule.allOf ?? []),
    ...(rule.trackedGcds ?? []),
    ...(rule.allowedGcds ?? []),
    ...(rule.ignoredGcds ?? []),
    ...(rule.gcdAdjust?.ids ?? []),
    ...(rule.expectedActions ?? []).flatMap((g) => [...g.ids, ...(g.onlyIf ?? [])]),
    ...(rule.limitedActions ?? []).flatMap((g) => g.ids),
  ].filter((id): id is number => id !== undefined)
}

/** 規則顯示用的圖示來源（效果或技能 ID）。 */
export function ruleDisplayId(rule: WindowRule): number {
  return rule.statusId ?? rule.action?.id ?? rule.allOf?.[0] ?? 0
}

/** 規則的顯示名稱，由官方繁中名稱組成：效果名稱、「技能 後 N 秒」或「效果＋效果」。 */
export function ruleName(rule: WindowRule, abilityName: (id: number) => string): string {
  if (rule.action) return `${abilityName(rule.action.id)} 後 ${rule.action.durationMs / 1000} 秒`
  if (rule.allOf) return rule.allOf.map(abilityName).join('＋')
  return abilityName(ruleDisplayId(rule))
}
