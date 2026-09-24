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
  abilityName: (id: number) => string
  isGcd?: (id: number) => boolean
  /** 職業的防禦／輔助技能（職業模組提供） */
  isUtility?: (id: number) => boolean
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

// 職能技能：依攻略使用，少用通常不影響輸出，只列為低優先
const ROLE_ACTIONS = new Set([
  3, // Sprint
  // 坦克
  7531, // Rampart
  7533, // Provoke
  7535, // Reprisal
  7537, // Shirk
  7538, // Interject
  7540, // Low Blow
  // 近戰／遠程物理
  7541, // Second Wind
  7542, // Bloodbath
  7546, // True North
  7548, // Arm's Length
  7549, // Feint
  7551, // Head Graze
  7557, // Peloton
  7863, // Leg Sweep
  // 法系
  7559, // Surecast
  7560, // Addle
  7562, // Lucid Dreaming
  // 治療
  7568, // Esuna
  7571, // Rescue
])
const POTION_NAME = /Gemdraught|Tincture|Draught|Potion/i

// 停手時段中，兩人平均距離超過此值（yalm）就提示可能是走位路線不同
const MOVEMENT_DISTANCE_YALM = 5
// 冷卻技平均晚超過此值（毫秒）才提示
const LATE_COOLDOWN_MS = 5000
// 站位差異持續超過此值（毫秒）才提示
const LONG_DIVERGENCE_MS = 5000
// 最多列出幾段停手／站位
const MAX_ITEMS = 3

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

function usageAdvice({ usage, abilityName, isGcd, isUtility, firstUse, mineToRef }: AdviceInput): Advice[] {
  const items: Advice[] = []
  const slightlyFewer: string[] = []
  const roleFewer: string[] = []

  for (const u of usage) {
    const name = abilityName(u.abilityId)
    // 職能技能與職業的防禦／輔助技能都依攻略使用
    const role = ROLE_ACTIONS.has(u.abilityId) || (isUtility?.(u.abilityId) ?? false)
    const gcd = isGcd?.(u.abilityId) ?? false
    const fewer = u.ref - u.mine

    if (POTION_NAME.test(name)) {
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
      title: '職能與防禦技能使用次數較少',
      detail: `${roleFewer.join('、')}（你／參考）。這些技能依攻略與減傷分配使用，次數不同不一定是錯誤。`,
    })
  }
  return items
}

function positionAdvice(input: AdviceInput): Advice[] {
  const { divergences, lost, mechanics } = input
  const overlapsLost = (d: Divergence) => lost.some((w) => w.refStart < d.end && w.refEnd > d.start)
  const unexplained = divergences
    .filter((d) => !d.mirror && d.end - d.start >= LONG_DIVERGENCE_MS)
    .sort((a, b) => b.end - b.start - (a.end - a.start))
  const items: Advice[] = unexplained.slice(0, MAX_ITEMS).map((d) => {
    const byMechanic = mechanicNear(mechanics, d.start, d.end) !== undefined
    return {
      // 機制本身不同時，站位不同是合理的，降一級
      severity: byMechanic ? 'low' : overlapsLost(d) ? 'high' : 'medium',
      title: `${formatFightTime(d.start)} 起 ${seconds(d.end - d.start)} 秒站位與參考不同（最遠 ${d.maxDistance.toFixed(1)} yalm）`,
      detail:
        (overlapsLost(d)
          ? '這段同時少打了 GCD，站位可能讓你無法持續攻擊。對照俯視圖看參考的站位與移動路線。'
          : '對照俯視圖看參考的站位與移動路線；若是攻略分配不同可忽略。') + mechanicNote(input, d.start, d.end),
      at: d.start,
    }
  })

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
