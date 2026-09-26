import type { AbilityCategory } from '../jobs/roleActions'
import type { PushDifference } from './alignment'
import type { Death } from '../compare/load'
import { ruleName } from '../jobs/windows'
import { mechanicLabel, type MechanicDifference } from './mechanics'
import type { AbilityUsage, GcdStats, LostWindow } from './metrics'
import { MIRROR_LABELS, type Divergence, type TrackPoint } from './positions'
import { formatFightTime } from './timeline'
import type { WindowSummary } from './windows'

export type Severity = 'high' | 'medium' | 'low'

export interface Advice {
  severity: Severity
  title: string
  detail: string
  /** 可跳轉的參考時間 */
  at?: number
}

export interface AdviceInput {
  /** 戰鬥長度（參考時間，毫秒） */
  durationMs: number
  gcd: { mine: GcdStats; ref: GcdStats } | null
  lost: LostWindow[]
  usage: AbilityUsage[]
  divergences: Divergence[]
  track: TrackPoint[]
  /** 顯示名稱（可能是繁中） */
  abilityName: (id: number) => string
  /** 英文名稱，供依名稱判斷的規則（例如藥水）使用；未提供時用 abilityName */
  englishName?: (id: number) => string
  isGcd?: (id: number) => boolean
  /** 技能分類（jobs/roleActions.ts）；未提供時全部視為一般技能 */
  category?: (id: number) => AbilityCategory
  /** 我的戰鬥時間換算成參考時間 */
  mineToRef: (t: number) => number
  /** 我第一次使用某技能的時間（我的戰鬥時間） */
  firstUse: (abilityId: number) => number | undefined
  /** Boss 機制不同的時間點 */
  mechanics?: MechanicDifference[]
  /** 技能窗口（jobs/windows.ts 的規則）評估結果，兩邊依規則順序對應 */
  windows?: { mine: WindowSummary; ref: WindowSummary }[]
  /** 開打當下身上已有的自身效果（推知開打前用過的技能） */
  prepull?: { mine: number[]; ref: number[] }
  /** 死亡（各自的戰鬥時間） */
  deaths?: { mine: Death[]; ref: Death[] }
  /** 我的戰鬥長度（我的時間；死亡到戰鬥結束都沒恢復時計算無法行動的時間） */
  mineDurationMs?: number
  /** 推進差距（例如轉場）：只含比較範圍內的 */
  pushes?: PushDifference[]
}

// 機制差異發生在時段開始前這麼久以內，也視為相關（機制通常先施放、後結算）
const MECHANIC_LEAD_MS = 10_000

/** 與時段相關的 Boss 隨機變化（同時間施放不同技能）。 */
function mechanicNear(mechanics: MechanicDifference[] | undefined, start: number, end: number) {
  return mechanics?.find((m) => m.kind === 'variant' && m.t >= start - MECHANIC_LEAD_MS && m.t <= end)
}

function mechanicNote(input: AdviceInput, start: number, end: number): string {
  const m = mechanicNear(input.mechanics, start, end)
  if (!m) return ''
  const names = (ids: number[], others: number[]) => mechanicLabel(ids, others, input.abilityName)
  return `這段之前 Boss 的隨機機制不同（你：${names(m.mine, m.ref)}；參考：${names(m.ref, m.mine)}），差異可能是機制造成。`
}

const POTION_NAME = /Gemdraught|Tincture|Draught|Potion/i
// 減傷／移動建議中最多列出幾個參考有用、我沒用的時間點
const MAX_LISTED_TIMES = 5

// 停手時段中，兩人平均距離超過此值（yalm）就提示可能是走位路線不同
const MOVEMENT_DISTANCE_YALM = 5
// 冷卻技平均晚超過此值（毫秒）才提示
const LATE_COOLDOWN_MS = 5000
// 站位差異持續超過此值（毫秒）才提示
const LONG_DIVERGENCE_MS = 5000
// 最多列出幾段停手／站位
const MAX_ITEMS = 3
// 機制結算時的站位差異最多列出幾段
const MAX_MECHANIC_POSITIONS = 5

const seconds = (ms: number) => (ms / 1000).toFixed(1)

function averageDistance(track: TrackPoint[], start: number, end: number): number | null {
  const ds = track.filter((p) => p.t >= start && p.t <= end && p.distance !== null).map((p) => p.distance!)
  return ds.length ? ds.reduce((a, b) => a + b, 0) / ds.length : null
}

function lostGcdAdvice(input: AdviceInput): Advice[] {
  const { lost, track } = input
  if (lost.length === 0) return []
  const total = lost.reduce((sum, w) => sum + w.refGcds, 0)
  const top = [...lost].sort((a, b) => b.refGcds - a.refGcds || b.mineEnd - b.mineStart - (a.mineEnd - a.mineStart))
  const items: Advice[] = [
    {
      // 與個別時段同等級時，排序會讓總結排在前面
      severity: total >= 3 ? 'high' : 'medium',
      title: `有 ${lost.length} 段你停手、參考仍在輸出，共少打 ${total} 個 GCD`,
      detail: '這些時段參考在同一個機制仍持續施放 GCD。檢查是否能提早移動、在移動中穿插 GCD，或縮短走位距離。',
    },
  ]
  for (const w of top.slice(0, MAX_ITEMS)) {
    const d = averageDistance(track, w.refStart, w.refEnd)
    const movement =
      d !== null && d > MOVEMENT_DISTANCE_YALM ? `這段期間你與參考平均相距 ${d.toFixed(1)} yalm，可能是走位路線不同。` : ''
    // 停手是因為死亡：根本原因是死亡，不是手慢
    const died = input.deaths?.mine.find((x) => x.t < w.mineEnd && (x.revivedAt === null || x.revivedAt > w.mineStart))
    items.push({
      severity: w.refGcds >= 3 ? 'high' : 'medium',
      title: `${formatFightTime(w.mineStart)} 停手 ${seconds(w.mineEnd - w.mineStart)} 秒${died ? '（這段期間你已死亡）' : ''}`,
      detail: died
        ? `參考在同一段打了 ${w.refGcds} 個 GCD。你在 ${formatFightTime(died.t)} 死亡${died.abilityId !== null ? `（${input.abilityName(died.abilityId)}）` : ''}，死亡期間無法輸出：先學會避開這個機制，不要死亡。`
        : `參考在同一段打了 ${w.refGcds} 個 GCD。${movement}${mechanicNote(input, w.refStart, w.refEnd)}`,
      at: w.refStart,
    })
  }
  return items
}

/** 死亡：最優先的改進。列出每次死亡的時間與致命技能，並與參考比較。 */
function deathAdvice(input: AdviceInput): Advice[] {
  const mine = input.deaths?.mine ?? []
  if (mine.length === 0) return []
  const refCount = input.deaths?.ref.length ?? 0
  const list = mine
    .map((d) => `${formatFightTime(d.t)}${d.abilityId !== null ? `（${input.abilityName(d.abilityId)}）` : ''}`)
    .join('、')
  const unable = mine.reduce((sum, d) => sum + ((d.revivedAt ?? input.mineDurationMs ?? d.t) - d.t), 0)
  return [
    {
      severity: 'high',
      title: `你死亡了 ${mine.length} 次：避免死亡是最優先的改進`,
      detail:
        `死亡時間與致命技能：${list}。` +
        (unable > 0 ? `死亡到恢復行動共 ${seconds(unable)} 秒無法輸出，` : '死亡期間無法輸出，') +
        `還會消耗隊友的復活與資源、增加全隊的壓力。${refCount === 0 ? '參考在同一場沒有死亡。' : `參考死亡 ${refCount} 次。`}` +
        '先對照站位與時間軸，確認參考怎麼避開這些機制或用了哪些減傷，不要死亡。',
      at: input.mineToRef(mine[0].t),
    },
  ]
}

function gcdSpeedAdvice({ gcd, durationMs }: AdviceInput): Advice[] {
  if (!gcd?.mine.gcdMs || !gcd.ref.gcdMs) return []
  const slower = gcd.mine.gcdMs - gcd.ref.gcdMs
  if (slower <= 10) return []
  // 整場以各自的 GCD 間隔能打的 GCD 數差距
  const lostGcds = durationMs / gcd.ref.gcdMs - durationMs / gcd.mine.gcdMs
  return [
    {
      severity: lostGcds >= 3 ? 'high' : 'medium',
      title: `GCD 比參考慢 ${slower.toFixed(0)} 毫秒，整場約少 ${lostGcds.toFixed(1)} 個 GCD`,
      detail: `你的 GCD 間隔 ${(gcd.mine.gcdMs / 1000).toFixed(3)} 秒、參考 ${(gcd.ref.gcdMs / 1000).toFixed(3)} 秒。檢查技能速度配裝，以及職業的加速效果是否全程維持。`,
    },
  ]
}

type CooldownKind = 'mitigation' | 'partyMitigation' | 'movement'

const CATEGORY_LABELS: Record<CooldownKind, string> = { mitigation: '自身減傷', partyMitigation: '團隊減傷', movement: '移動' }

// 「優先」只留影響輸出的項目（死亡、停手、爆發等）：減傷與移動最多到「建議」；
// 自身減傷只要保住自己即可，列為「參考」；團隊減傷影響隊友生存，列為「建議」
const COOLDOWN_SEVERITY: Record<CooldownKind, Severity> = { mitigation: 'low', partyMitigation: 'medium', movement: 'medium' }

const COOLDOWN_NOTES: Record<CooldownKind, string> = {
  mitigation: '自身減傷只要能保住自己即可，時機不一定要與參考相同。',
  partyMitigation: '團隊減傷影響隊友的生存，是重要的學習課題，對照時間軸看參考在哪個機制使用。',
  movement: '移動技能的使用時機是重要的學習課題，對照時間軸看參考在哪個機制使用。',
}

/**
 * 減傷與移動技能：列出參考有用、我在前後 30 秒內沒有對應使用的時間點，讓使用者對照參考在哪個機制使用。
 */
function mitigationAdvice(u: AbilityUsage, name: string, kind: CooldownKind): Advice | null {
  const label = CATEGORY_LABELS[kind]
  const fewer = u.ref - u.mine
  const missed = u.unmatchedRef
  if (missed.length > 0 || fewer > 0) {
    const listed = missed.slice(0, MAX_LISTED_TIMES).map(formatFightTime).join('、')
    const more = missed.length > MAX_LISTED_TIMES ? ` 等 ${missed.length} 次` : ''
    return {
      severity: COOLDOWN_SEVERITY[kind],
      title:
        fewer > 0
          ? `${label}：${name} 少用 ${fewer} 次（你 ${u.mine} 次、參考 ${u.ref} 次）`
          : `${label}：${name} 有 ${missed.length} 次使用時機與參考不同`,
      detail:
        (missed.length > 0 ? `參考在 ${listed}${more} 使用，你在前後 30 秒內沒有使用。` : '') + COOLDOWN_NOTES[kind],
      at: missed[0],
    }
  }
  if (u.matched >= 2 && u.avgDelayMs !== null && u.avgDelayMs > LATE_COOLDOWN_MS) {
    return {
      severity: COOLDOWN_SEVERITY[kind],
      title: `${label}：${name} 平均比參考晚 ${seconds(u.avgDelayMs)} 秒使用`,
      detail: `比較了 ${u.matched} 次使用。${label}太晚可能來不及涵蓋機制，對照時間軸看參考的使用時機。`,
    }
  }
  return null
}

function usageAdvice({ usage, abilityName, englishName, isGcd, category, firstUse, mineToRef }: AdviceInput): Advice[] {
  const items: Advice[] = []
  const slightlyFewer: string[] = []
  const roleFewer: string[] = []

  for (const u of usage) {
    const name = abilityName(u.abilityId)
    const kind = category?.(u.abilityId) ?? 'normal'
    if (kind === 'ignored') continue
    if (kind === 'mitigation' || kind === 'partyMitigation' || kind === 'movement') {
      const advice = mitigationAdvice(u, name, kind)
      if (advice) items.push(advice)
      continue
    }
    // 其他輔助技能依攻略使用，只合併為低優先
    const role = kind === 'utility'
    const gcd = isGcd?.(u.abilityId) ?? false
    const fewer = u.ref - u.mine

    if (POTION_NAME.test((englishName ?? abilityName)(u.abilityId))) {
      if (fewer > 0) {
        items.push({
          severity: 'high',
          title: `爆發藥少用 ${fewer} 次（你 ${u.mine} 次、參考 ${u.ref} 次）`,
          detail: `${name}：爆發藥應配合團隊爆發窗口使用，參考整場用了 ${u.ref} 次。`,
        })
      }
      continue
    }

    if (role) {
      if (fewer > 0) roleFewer.push(`${name}（${u.mine}／${u.ref}）`)
      continue
    }

    if (gcd && u.ref === 0 && u.mine >= 3) {
      const first = firstUse(u.abilityId)
      items.push({
        severity: 'medium',
        title: `使用了 ${u.mine} 次 ${name}，參考完全沒用`,
        detail: '參考沒有用到這個技能，可能代表你有段時間無法以正常循環攻擊（例如離 Boss 太遠）。檢查這些時間點的走位。',
        at: first !== undefined ? mineToRef(first) : undefined,
      })
      continue
    }

    // GCD 的次數差是少打 GCD 的結果，已由停手與 GCD 速度的建議涵蓋，只比較 oGCD 的次數
    if (!gcd && fewer >= 2 && u.ref <= 30) {
      items.push({
        severity: 'high',
        title: `${name} 少用 ${fewer} 次（你 ${u.mine} 次、參考 ${u.ref} 次）`,
        detail: '冷卻好就用，避免拖延導致整場少用；若是為了對齊爆發而延後，確認沒有因此少用。',
      })
    } else if (!gcd && fewer === 1 && u.ref <= 30) {
      slightlyFewer.push(name)
    } else if (u.matched >= 2 && u.avgDelayMs !== null && u.avgDelayMs > LATE_COOLDOWN_MS) {
      items.push({
        severity: 'medium',
        title: `${name} 平均比參考晚 ${seconds(u.avgDelayMs)} 秒使用`,
        detail: `比較了 ${u.matched} 次使用。延後可能錯過團隊爆發窗口，或讓後面的使用次數減少。`,
      })
    }
  }

  if (slightlyFewer.length > 0) {
    items.push({
      severity: 'medium',
      title: `${slightlyFewer.length} 個技能各少用 1 次`,
      detail: `${slightlyFewer.join('、')}。可能是戰鬥長度不同或某次延後使用，檢查冷卻好時是否立即使用。`,
    })
  }
  if (roleFewer.length > 0) {
    items.push({
      severity: 'low',
      title: '輔助技能使用次數較少',
      detail: `${roleFewer.join('、')}（你／參考）。這些技能依攻略需要使用，次數不同不一定是錯誤。`,
    })
  }
  return items
}

function positionAdvice(input: AdviceInput): Advice[] {
  const { divergences, lost, mechanics, abilityName } = input
  const overlapsLost = (d: Divergence) => lost.some((w) => w.refStart < d.end && w.refEnd > d.start)
  const lostNote = (d: Divergence) => (overlapsLost(d) ? '這段同時少打了 GCD，站位可能讓你無法持續攻擊。' : '')
  const unexplained = divergences.filter((d) => !d.mirror)

  // 站位差異在 Boss 機制結算時才有明顯意義：有機制的差異優先列出，並指出是哪個機制
  const atMechanic = unexplained
    .filter((d) => d.mechanics.length > 0)
    .sort((a, b) => Number(overlapsLost(b)) - Number(overlapsLost(a)) || b.maxDistance - a.maxDistance)
    .slice(0, MAX_MECHANIC_POSITIONS)
  const items: Advice[] = atMechanic.map((d) => {
    const names = [...new Set(d.mechanics.map((m) => abilityName(m.abilityId)))].slice(0, 2).join('、')
    const byVariant = mechanicNear(mechanics, d.start, d.end) !== undefined
    return {
      // 機制本身隨機不同時，站位不同是合理的，降為參考；少打的 GCD 已由停手建議列為優先，站位本身最多到「建議」
      severity: byVariant ? 'low' : 'medium',
      title: `${formatFightTime(d.mechanics[0].t)} 機制「${names}」結算時站位與參考不同（最遠 ${d.maxDistance.toFixed(1)} yalm）`,
      detail:
        `差異從 ${formatFightTime(d.start)} 持續 ${seconds(d.end - d.start)} 秒。${lostNote(d)}` +
        '對照俯視圖看參考在這個機制的站位與移動路線；若是攻略分配不同可忽略。' +
        mechanicNote(input, d.start, d.end),
      at: d.start,
    }
  })

  // 附近沒有機制的站位差異通常只是移動路線不同，只列出較長的幾段、列為參考
  const elsewhere = unexplained
    .filter((d) => d.mechanics.length === 0 && d.end - d.start >= LONG_DIVERGENCE_MS)
    .sort((a, b) => b.end - b.start - (a.end - a.start))
    .slice(0, MAX_ITEMS)
  for (const d of elsewhere) {
    items.push({
      severity: 'low',
      title: `${formatFightTime(d.start)} 起 ${seconds(d.end - d.start)} 秒站位與參考不同（附近沒有 Boss 機制）`,
      detail: `最遠 ${d.maxDistance.toFixed(1)} yalm。${lostNote(d)}附近沒有 Boss 機制，差異可能只是移動路線不同。`,
      at: d.start,
    })
  }

  const mirrored = divergences.filter((d) => d.mirror)
  if (mirrored.length > 0) {
    const kinds = [...new Set(mirrored.map((d) => MIRROR_LABELS[d.mirror!]))].join('、')
    items.push({
      severity: 'low',
      title: `${mirrored.length} 段站位差異可能是不同攻略（${kinds}）`,
      detail: '你的位置接近參考位置的對稱點，通常是隊伍攻略或分配不同，不一定是錯誤。',
      at: mirrored[0].start,
    })
  }
  return items
}

// 合格率比參考低這麼多以上列為優先
const WINDOW_HIGH_GAP = 0.3
// 常見問題最多列出幾項
const MAX_WINDOW_ISSUES = 2

/** 技能窗口（例如明鏡止水、戰逃反應期間該做的事）合格率比參考低時提出，並列出最常見的問題。 */
function windowAdvice(input: AdviceInput): Advice[] {
  const items: Advice[] = []
  for (const { mine, ref } of input.windows ?? []) {
    if (mine.judged === 0) continue
    const mineRate = mine.passed / mine.judged
    // 參考的版本沒有這條規則：無從比較
    if (ref.inapplicable) continue
    const refRate = ref.judged > 0 ? ref.passed / ref.judged : 1
    if (mineRate >= refRate || mine.passed === mine.judged) continue
    const failed = mine.windows.filter((w) => w.judged && w.issues.length > 0)
    const counts = new Map<string, number>()
    for (const w of failed) for (const issue of w.issues) counts.set(issue, (counts.get(issue) ?? 0) + 1)
    const common = [...counts]
      .sort((a, b) => b[1] - a[1])
      .slice(0, MAX_WINDOW_ISSUES)
      .map(([issue, n]) => `${issue}（${n} 次）`)
      .join('；')
    const name = ruleName(mine.rule, input.abilityName)
    items.push({
      severity: refRate - mineRate >= WINDOW_HIGH_GAP ? 'high' : 'medium',
      title: `${name}：你 ${mine.judged} 次中 ${mine.passed} 次合格，參考 ${ref.judged} 次中 ${ref.passed} 次`,
      detail: `常見問題：${common}。對照時間軸上${name}期間參考使用的技能。`,
      at: input.mineToRef(failed[0].start),
    })
  }
  return items
}

/** 參考開打前有用、我沒有的自身效果（例如開打前的明鏡止水、坦姿、進食）。 */
function prepullAdvice(input: AdviceInput): Advice[] {
  if (!input.prepull) return []
  const missing = input.prepull.ref.filter((id) => !input.prepull!.mine.includes(id))
  if (missing.length === 0) return []
  return [
    {
      severity: 'medium',
      title: `開打前參考有使用：${missing.map(input.abilityName).join('、')}`,
      detail: '開打當下參考身上已有這些自身效果，你沒有；可能是開打前的準備（技能、坦姿或進食）不同。',
      at: 0,
    },
  ]
}

// 推進慢超過這麼多（毫秒）列為優先
const SLOW_PUSH_HIGH_MS = 8000

/** 推進較慢（例如 Boss 血量到了才轉場）：這之前的輸出較低，之後的機制也都跟著延後。 */
function pushAdvice(input: AdviceInput): Advice[] {
  return (input.pushes ?? [])
    .filter((p) => p.deltaMs > 0)
    .map((p): Advice => {
      const died = input.deaths?.mine.some((d) => d.t < p.mineEnd)
      return {
        severity: p.deltaMs >= SLOW_PUSH_HIGH_MS ? 'high' : 'medium',
        title: `${formatFightTime(p.refEnd)} 推進比參考慢 ${seconds(p.deltaMs)} 秒`,
        detail:
          `參考在 ${formatFightTime(p.refEnd)} 推進（例如 Boss 血量到了而轉場），你到 ${formatFightTime(p.mineEnd)} 才推進，` +
          `之後的機制都晚了約 ${seconds(p.deltaMs)} 秒。推進時間取決於全隊輸出，` +
          (died ? '你在這之前有死亡，也會拖慢推進；' : '') +
          '對照這之前的 GCD、技能窗口與爆發是否對齊，看自己能補上多少。',
        at: p.refEnd,
      }
    })
}

const ORDER: Record<Severity, number> = { high: 0, medium: 1, low: 2 }

/** 依各階段的分析結果產生規則式建議，依重要性排序。 */
export function generateAdvice(input: AdviceInput): Advice[] {
  const items = [
    ...deathAdvice(input),
    ...lostGcdAdvice(input),
    ...gcdSpeedAdvice(input),
    ...pushAdvice(input),
    ...windowAdvice(input),
    ...prepullAdvice(input),
    ...usageAdvice(input),
    ...positionAdvice(input),
  ]
  // 穩定排序：同等級維持產生順序（死亡 → 停手 → GCD 速度 → 推進 → 技能窗口 → 開打前 → 技能 → 站位）
  return items.map((a, i) => ({ a, i })).sort((x, y) => ORDER[x.a.severity] - ORDER[y.a.severity] || x.i - y.i).map((x) => x.a)
}
