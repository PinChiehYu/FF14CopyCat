import type { AbilityCategory } from '../jobs/roleActions'
import type { MechanicDifference } from './mechanics'
import type { AbilityUsage, GcdStats, LostWindow } from './metrics'
import { MIRROR_LABELS, type Divergence, type TrackPoint } from './positions'
import { formatFightTime } from './timeline'

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
  // 同名不同 ID 的變化（例如左右兩種版本）附上 ID 才分得出來
  const all = [...m.mine, ...m.ref]
  const label = (id: number) => {
    const name = input.abilityName(id)
    return all.some((o) => o !== id && input.abilityName(o) === name) ? `${name} #${id}` : name
  }
  const names = (ids: number[]) => ids.map(label).join('、')
  return `這段之前 Boss 的隨機機制不同（你：${names(m.mine)}；參考：${names(m.ref)}），差異可能是機制造成。`
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
    items.push({
      severity: w.refGcds >= 3 ? 'high' : 'medium',
      title: `${formatFightTime(w.mineStart)} 停手 ${seconds(w.mineEnd - w.mineStart)} 秒`,
      detail: `參考在同一段打了 ${w.refGcds} 個 GCD。${movement}${mechanicNote(input, w.refStart, w.refEnd)}`,
      at: w.refStart,
    })
  }
  return items
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

const CATEGORY_LABELS: Partial<Record<AbilityCategory, string>> = { mitigation: '減傷', movement: '移動' }

/**
 * 減傷與移動技能：使用者指定為重要的學習課題。列出參考有用、我在前後 30 秒內沒有對應使用的時間點，
 * 讓使用者對照參考在哪個機制使用。
 */
function mitigationAdvice(u: AbilityUsage, name: string, kind: 'mitigation' | 'movement'): Advice | null {
  const label = CATEGORY_LABELS[kind]
  const fewer = u.ref - u.mine
  const missed = u.unmatchedRef
  if (missed.length > 0 || fewer > 0) {
    const listed = missed.slice(0, MAX_LISTED_TIMES).map(formatFightTime).join('、')
    const more = missed.length > MAX_LISTED_TIMES ? ` 等 ${missed.length} 次` : ''
    return {
      severity: Math.max(missed.length, fewer) >= 2 ? 'high' : 'medium',
      title:
        fewer > 0
          ? `${label}：${name} 少用 ${fewer} 次（你 ${u.mine} 次、參考 ${u.ref} 次）`
          : `${label}：${name} 有 ${missed.length} 次使用時機與參考不同`,
      detail:
        (missed.length > 0 ? `參考在 ${listed}${more} 使用，你在前後 30 秒內沒有使用。` : '') +
        `${label}技能的使用時機是重要的學習課題，對照時間軸看參考在哪個機制使用。`,
      at: missed[0],
    }
  }
  if (u.matched >= 2 && u.avgDelayMs !== null && u.avgDelayMs > LATE_COOLDOWN_MS) {
    return {
      severity: 'medium',
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
    if (kind === 'mitigation' || kind === 'movement') {
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
      // 機制本身隨機不同時，站位不同是合理的，降為參考
      severity: byVariant ? 'low' : overlapsLost(d) ? 'high' : 'medium',
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

const ORDER: Record<Severity, number> = { high: 0, medium: 1, low: 2 }

/** 依各階段的分析結果產生規則式建議，依重要性排序。 */
export function generateAdvice(input: AdviceInput): Advice[] {
  const items = [...lostGcdAdvice(input), ...gcdSpeedAdvice(input), ...usageAdvice(input), ...positionAdvice(input)]
  // 穩定排序：同等級維持產生順序（停手 → GCD 速度 → 技能 → 站位）
  return items.map((a, i) => ({ a, i })).sort((x, y) => ORDER[x.a.severity] - ORDER[y.a.severity] || x.i - y.i).map((x) => x.a)
}
