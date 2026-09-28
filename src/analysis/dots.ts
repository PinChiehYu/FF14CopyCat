import type { BuffWindow, DebuffApplication } from './buffs'
import { DOT_DURATION_OVERRIDES, fflogsStatusId, type DotRule } from '../jobs/dotRules'

export interface DotSummary {
  rule: DotRule
  /** 覆蓋率（%）：DoT 在敵人身上的時間 ÷ Boss 可選中的時間，上限 100 */
  uptime: number
  /** 提早續上每分鐘覆蓋掉的時間（毫秒）；規則不檢查時為 null */
  clipPerMinMs: number | null
  /** 每次提早續上（覆蓋掉剩餘時間 > 0）：時間與覆蓋掉的毫秒數 */
  clips: { t: number; ms: number }[]
  /** 施加與續上的次數 */
  applications: number
}

interface Span {
  start: number
  end: number
}

/** 時段聯集（排序、合併重疊） */
function union(spans: Span[]): Span[] {
  const merged: Span[] = []
  for (const s of [...spans].sort((a, b) => a.start - b.start)) {
    const last = merged.at(-1)
    if (last && s.start <= last.end) last.end = Math.max(last.end, s.end)
    else if (s.end > s.start) merged.push({ ...s })
  }
  return merged
}

const length = (spans: Span[]) => spans.reduce((sum, s) => sum + s.end - s.start, 0)

/** a 扣掉 b 的部分（兩者都已是聯集） */
function subtract(a: Span[], b: Span[]): Span[] {
  const out: Span[] = []
  for (const s of a) {
    let pieces = [s]
    for (const cut of b) {
      pieces = pieces.flatMap((p) =>
        cut.end <= p.start || cut.start >= p.end
          ? [p]
          : [
              ...(cut.start > p.start ? [{ start: p.start, end: cut.start }] : []),
              ...(cut.end < p.end ? [{ start: cut.end, end: p.end }] : []),
            ],
      )
    }
    out.push(...pieces)
  }
  return out
}

/**
 * 一條 DoT 規則的覆蓋率與提早續上（移植自 xivanalysis 的 core DoTs，簡化處見 TECH_NOTES.md「DoT」）：
 * - 覆蓋率：規則內各效果在任一敵人身上的時段聯集（buffs 已合併同一效果的多個目標），扣掉 Boss 無法選中的時間，
 *   除以 Boss 可選中的時間。
 * - 提早續上：同一效果、同一目標的下一次施加時，上一次還剩的時間（持續時間 −（這次 − 上次），負值代表已掉，不算）；
 *   不同效果互換（例如高階雷電與高階中雷電）不算。總和除以 Boss 可選中的分鐘數。
 * @param side 各自的戰鬥時間
 */
export function evaluateDot(
  rule: DotRule,
  side: { buffs: BuffWindow[]; debuffApplications: DebuffApplication[]; untargetable: Span[]; duration: number },
): DotSummary {
  const ids = new Map(rule.statusIds.map((id) => [fflogsStatusId(id), DOT_DURATION_OVERRIDES[id] ?? rule.durationMs]))
  const down = union(side.untargetable.map((s) => ({ start: Math.max(0, s.start), end: Math.min(side.duration, s.end) })))
  const targetable = side.duration - length(down)
  const covered = subtract(
    union(side.buffs.filter((b) => ids.has(b.statusId)).map((b) => ({ start: b.start, end: Math.min(b.end, side.duration) }))),
    down,
  )
  const uptime = targetable > 0 ? Math.min(100, (length(covered) / targetable) * 100) : 0

  const applications = side.debuffApplications.filter((a) => ids.has(a.statusId))
  const last = new Map<string, number>()
  const clips: { t: number; ms: number }[] = []
  for (const a of applications) {
    const key = `${a.statusId}|${a.targetId}`
    const previous = last.get(key)
    last.set(key, a.t)
    if (previous === undefined) continue
    const ms = ids.get(a.statusId)! - (a.t - previous)
    if (ms > 0) clips.push({ t: a.t, ms })
  }
  const total = clips.reduce((sum, c) => sum + c.ms, 0)
  return {
    rule,
    uptime,
    clipPerMinMs: rule.clipTiers && targetable > 0 ? total / (targetable / 60000) : rule.clipTiers ? 0 : null,
    clips,
    applications: applications.length,
  }
}

/** 提早續上的嚴重程度（xivanalysis 的 TieredSuggestion：達到門檻才提） */
export function clipSeverity(summary: DotSummary): 'low' | 'medium' | 'high' | null {
  const tiers = summary.rule.clipTiers
  const v = summary.clipPerMinMs
  if (!tiers || v === null) return null
  if (v >= tiers.high) return 'high'
  if (v >= tiers.medium) return 'medium'
  if (v >= tiers.low) return 'low'
  return null
}
