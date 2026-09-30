import type { AbilityCategory } from '../jobs/roleActions'
import { LATE_LISTED_MS, type CooldownPair } from './cooldowns'
import type { Death } from '../compare/load'
import { ruleName } from '../jobs/windows'
import { mechanicLabel, type MechanicDifference } from './mechanics'
import type { AbilityUsage, GcdStats, LostWindow } from './metrics'
import {
  divergenceKind,
  MIRROR_LABELS,
  positionMechanics,
  type Divergence,
  type DivergenceKind,
  type TrackPoint,
} from './positions'
import { formatFightTime } from './timeline'
import { isPotionName } from '../fflogs/report'
import { controlNames } from './control'
import type { WindowSummary } from './windows'
import { clipSeverity, type DotSummary } from './dots'
import { fflogsStatusId } from '../jobs/dotRules'
import { compareFillers, isRangedFiller } from '../jobs/rangedFillers'
import { weavingSeverity, type BadWeave } from './weaving'
import type { DeathRecap } from './damageTaken'

export type Severity = 'high' | 'medium' | 'low'

/** 建議的類別：建議區依類別分組（見 ADVICE_GROUPS） */
export type AdviceKind =
  | 'death'
  | 'gcd'
  | 'cooldown'
  | 'dot'
  | 'window'
  | 'prepull'
  | 'usage'
  | 'potion'
  | 'partyMitigation'
  | 'mitigation'
  | 'movement'
  | 'weave'
  | 'filler'
  | 'position'
  | 'penalty'

export interface Advice {
  severity: Severity
  title: string
  detail: string
  /** 可跳轉的參考時間 */
  at?: number
  /** 「查看」改為捲到頁面上的這個區塊（元素 id），例如停手總結捲到「少打 GCD 的時段」 */
  section?: string
  /** 產生時由 generateAdvice／generateSoloAdvice 依來源填入 */
  kind?: AdviceKind
}

/** 「少打 GCD 的時段」／「停手時段」區塊標題的 id */
export const LOST_GCD_SECTION = 'lost-gcd-windows'

/** 為一組建議標上類別（已有類別的不變，例如技能使用次數中的減傷與強化藥） */
const tag = (kind: AdviceKind, items: Advice[]): Advice[] => items.map((a) => (a.kind ? a : { ...a, kind }))

/**
 * 建議的分組：相關的類別放在同一組一起列出（例如停手的總結與各段、冷卻技與強化藥），
 * 依陣列順序為同等級時的重要性。
 */
export const ADVICE_GROUPS: { key: string; label: string; kinds: AdviceKind[] }[] = [
  { key: 'death', label: '死亡', kinds: ['death'] },
  // 懲罰效果（傷害降低）與死亡同為機制失誤的直接結果，緊接在死亡之後
  { key: 'penalty', label: '懲罰效果', kinds: ['penalty'] },
  { key: 'gcd', label: '停手與 GCD', kinds: ['gcd'] },
  { key: 'window', label: '技能窗口', kinds: ['window'] },
  // 止損技（威力低的遠程 GCD）直接少了輸出，與技能使用放在同一組
  { key: 'usage', label: '技能與強化藥', kinds: ['potion', 'cooldown', 'filler', 'usage'] },
  { key: 'dot', label: 'DoT', kinds: ['dot'] },
  { key: 'weave', label: '穿插過多', kinds: ['weave'] },
  { key: 'mitigation', label: '減傷與移動', kinds: ['partyMitigation', 'mitigation', 'movement'] },
  { key: 'prepull', label: '開打前', kinds: ['prepull'] },
  { key: 'position', label: '站位', kinds: ['position'] },
]

const GROUP_INDEX = new Map(ADVICE_GROUPS.flatMap((g, i) => g.kinds.map((k) => [k, i] as const)))

export interface AdviceGroup {
  key: string
  label: string
  /** 組內最高的等級（建議區依各則等級分頁後在每個分頁內分組，同一分頁內各組等級相同） */
  severity: Severity
  items: Advice[]
}

/** 沒有類別的建議各自成一組（排在有類別的之後） */
const groupKey = (a: Advice) => (a.kind ? ADVICE_GROUPS[GROUP_INDEX.get(a.kind)!].key : `title:${a.title}`)

/**
 * 依組整理建議：同一組的一起列出；組的順序依最高等級、再依 ADVICE_GROUPS 的重要性。
 * 組內依等級、再依組內類別的順序（例如團隊減傷 → 自身減傷 → 移動），同類別維持產生順序（總結在前）。
 * 建議區先依各則的等級分頁，再對每個分頁的建議分組。
 */
export function groupAdvice(advice: Advice[]): AdviceGroup[] {
  const groups = new Map<string, Advice[]>()
  for (const a of advice) groups.set(groupKey(a), [...(groups.get(groupKey(a)) ?? []), a])
  return [...groups.entries()]
    .map(([key, items]) => {
      const def = ADVICE_GROUPS.find((g) => g.key === key)
      const kindOrder = (a: Advice) => (def && a.kind ? def.kinds.indexOf(a.kind) : 0)
      const sorted = items
        .map((a, i) => ({ a, i }))
        .sort((x, y) => ORDER[x.a.severity] - ORDER[y.a.severity] || kindOrder(x.a) - kindOrder(y.a) || x.i - y.i)
        .map((x) => x.a)
      return { key, label: def?.label ?? '', severity: sorted[0].severity, items: sorted, order: def ? ADVICE_GROUPS.indexOf(def) : ADVICE_GROUPS.length }
    })
    .sort((a, b) => ORDER[a.severity] - ORDER[b.severity] || a.order - b.order)
    .map(({ order: _order, ...g }) => g)
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
  /** 冷卻技是否好了就用（xivanalysis 的 CooldownDowntime） */
  cooldowns?: CooldownPair[]
  /** DoT 覆蓋率與提早續上（xivanalysis 的 DoTs），兩邊依規則順序對應 */
  dots?: DotPair[]
  /** 算止損的止損技施放時間（各自的戰鬥時間；見 jobs/rangedFillers.ts 的 lossFillerTimes） */
  fillers?: { mine: number[]; ref: number[] }
  /** 這個職業的止損技 ID（名稱用） */
  fillerId?: number
  /** 穿插過多（見 analysis/weaving.ts），各自的戰鬥時間 */
  weaving?: { mine: BadWeave[]; ref: BadWeave[] }
  /** 職業（FFLogs subType；穿插過多的分級用） */
  subType?: string
  /** 我每次死亡的死亡回顧 */
  deathRecaps?: DeathRecap[]
  /** 傷害降低（各自的時間）：我比參考多時提出 */
  penalties?: { mine: { start: number; end: number }[]; ref: { start: number; end: number }[] }
}

/** 同一條 DoT 規則兩邊的結果；沒有參考時 ref 為 null */
export interface DotPair {
  mine: DotSummary
  ref: DotSummary | null
}


// 減傷／移動建議中最多列出幾個參考有用、我沒用的時間點
const MAX_LISTED_TIMES = 5

// 冷卻技平均晚超過此值（毫秒）才提示
const LATE_COOLDOWN_MS = 5000
// 站位差異持續超過此值（毫秒）才提示
const LONG_DIVERGENCE_MS = 5000
// 最多列出幾段站位
const MAX_ITEMS = 3
// 機制結算時的站位差異最多列出幾段
const MAX_MECHANIC_POSITIONS = 5

const seconds = (ms: number) => (ms / 1000).toFixed(1)

/**
 * 停手（少打 GCD）：只列一則總結，「查看」捲到下方「少打 GCD 的時段」清單；各段的時間、長度與參考的 GCD 數在清單中，不逐段列成建議。
 */
function lostGcdAdvice(input: AdviceInput): Advice[] {
  // Boss 控場造成的停手不是操作問題：不列入停手建議，合併成一則參考
  const controlled = input.lost.filter((w) => w.control)
  const lost = input.lost.filter((w) => !w.control)
  const controlItems: Advice[] =
    controlled.length === 0
      ? []
      : [
          {
            severity: 'low',
            title: `${controlled.length} 段停手是 Boss 控場造成`,
            detail:
              `${controlled.map((w) => `${formatFightTime(w.mineStart)}（${controlNames(w.control!, input.abilityName)}）`).join('、')}：` +
              '你身上有 Boss 施加、期間無法施放的效果，參考在同一段仍在施放（例如隨機點名的時間不同），不是操作問題。',
            at: controlled[0].refStart,
          },
        ]
  if (lost.length === 0) return controlItems
  const total = lost.reduce((sum, w) => sum + w.refGcds, 0)
  // 停手是因為死亡：根本原因是死亡（由死亡建議處理），不是手慢
  const whileDead = lost.filter((w) =>
    input.deaths?.mine.some((x) => x.t < w.mineEnd && (x.revivedAt === null || x.revivedAt > w.mineStart)),
  ).length
  return [
    {
      severity: total >= 3 ? 'high' : 'medium',
      title: `有 ${lost.length} 段你停手、參考仍在輸出，共少打 ${total} 個 GCD`,
      detail:
        '這些時段參考在同一個機制仍持續施放 GCD。檢查是否能提早移動、在移動中穿插 GCD，或縮短走位距離。' +
        (whileDead > 0 ? `其中 ${whileDead} 段你已死亡。` : '') +
        '各段的時間、長度與參考打的 GCD 數見下方「少打 GCD 的時段」。',
      section: LOST_GCD_SECTION,
    },
    ...controlItems,
  ]
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
        recapText(input.deathRecaps?.[0], input.abilityName) +
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

function usageAdvice({ usage, abilityName, englishName, isGcd, category, firstUse, mineToRef, cooldowns }: AdviceInput): Advice[] {
  const items: Advice[] = []
  // 已由冷卻技建議涵蓋的技能不再提「少用」
  const tracked = new Set((cooldowns ?? []).flatMap(({ mine, ref }) => (mine ?? ref)!.group.ids))
  const slightlyFewer: string[] = []
  const roleFewer: string[] = []

  for (const u of usage) {
    const name = abilityName(u.abilityId)
    const kind = category?.(u.abilityId) ?? 'normal'
    if (kind === 'ignored') continue
    if (kind === 'mitigation' || kind === 'partyMitigation' || kind === 'movement') {
      const advice = mitigationAdvice(u, name, kind)
      if (advice) items.push({ ...advice, kind })
      continue
    }
    // 其他輔助技能依攻略使用，只合併為低優先
    const role = kind === 'utility'
    const gcd = isGcd?.(u.abilityId) ?? false
    const fewer = u.ref - u.mine

    if (isPotionName((englishName ?? abilityName)(u.abilityId))) {
      if (fewer > 0) {
        items.push({
          kind: 'potion',
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

    // 止損技另由 fillerAdvice 依時間與參考比較
    if (isRangedFiller(u.abilityId)) continue

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
    if (tracked.has(u.abilityId)) continue
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
  const { divergences, lost, abilityName } = input
  const overlapsLost = (d: Divergence) => lost.some((w) => w.refStart < d.end && w.refEnd > d.start)
  const lostNote = (d: Divergence) => (overlapsLost(d) ? '這段同時少打了 GCD，站位可能讓你無法持續攻擊。' : '')
  const frameNote = (d: Divergence) =>
    d.bossFrame ? `兩場 Boss 站在不同位置（相距 ${(d.bossGap ?? 0).toFixed(0)} yalm），距離以各自的 Boss 為基準。` : ''
  // 分類與卡片、摘要共用（divergenceKind）
  const ofKind = (kind: DivergenceKind) => divergences.filter((d) => divergenceKind(d) === kind)
  // 兩邊隨機機制不同（見 attachVariants）的站位差異是機制造成的，不逐段列出，最後合併成一則參考
  const byVariant = ofKind('variant')
  // Boss 無法選中（轉場等）時玩家常被強制移動或無法移動，站位差異不算站錯，同樣合併成一則參考
  const untargetable = ofKind('untargetable')

  // 站位差異在 Boss 機制結算時才有明顯意義：有機制的差異優先列出，並指出是哪個機制
  // （兩人相對於各自 Boss 位置相近的機制不算，見 positionMechanics；只有這種機制的段不列出）
  const atMechanic = ofKind('mechanic')
    .sort((a, b) => Number(overlapsLost(b)) - Number(overlapsLost(a)) || b.maxDistance - a.maxDistance)
    .slice(0, MAX_MECHANIC_POSITIONS)
  const items: Advice[] = atMechanic.map((d) => {
    const mechanics = positionMechanics(d)
    const names = [...new Set(mechanics.map((m) => abilityName(m.abilityId)))].slice(0, 2).join('、')
    return {
      // 少打的 GCD 已由停手建議列為優先，站位本身最多到「建議」
      severity: 'medium',
      title: `${formatFightTime(mechanics[0].t)} 機制「${names}」結算時站位與參考不同（最遠 ${d.maxDistance.toFixed(1)} yalm）`,
      detail:
        `差異從 ${formatFightTime(d.start)} 持續 ${seconds(d.end - d.start)} 秒。${frameNote(d)}${lostNote(d)}` +
        '對照俯視圖看參考在這個機制的站位與移動路線；若是攻略分配不同可忽略。',
      at: d.start,
    }
  })

  // 附近沒有機制的站位差異通常只是移動路線不同，只列出較長的幾段、列為參考
  const elsewhere = ofKind('route')
    .filter((d) => d.end - d.start >= LONG_DIVERGENCE_MS)
    .sort((a, b) => b.end - b.start - (a.end - a.start))
    .slice(0, MAX_ITEMS)
  for (const d of elsewhere) {
    items.push({
      severity: 'low',
      title: `${formatFightTime(d.start)} 起 ${seconds(d.end - d.start)} 秒站位與參考不同（附近沒有 Boss 機制）`,
      detail: `最遠 ${d.maxDistance.toFixed(1)} yalm。${frameNote(d)}${lostNote(d)}附近沒有 Boss 機制，差異可能只是移動路線不同。`,
      at: d.start,
    })
  }

  if (byVariant.length > 0) {
    const names = (ids: number[], others: number[]) => mechanicLabel(ids, others, abilityName)
    const listed = byVariant
      .slice(0, MAX_LISTED_TIMES)
      .map((d) => `${formatFightTime(d.start)}（你：${names(d.variant!.mine, d.variant!.ref)}；參考：${names(d.variant!.ref, d.variant!.mine)}）`)
    items.push({
      severity: 'low',
      title: `${byVariant.length} 段站位差異發生在 Boss 隨機機制不同時`,
      detail: `${listed.join('、')}${byVariant.length > listed.length ? ' 等' : ''}。兩邊的機制不同，站位不同多半是機制造成，不是站錯。`,
      at: byVariant[0].start,
    })
  }

  if (untargetable.length > 0) {
    const listed = untargetable.slice(0, MAX_LISTED_TIMES).map((d) => formatFightTime(d.start))
    items.push({
      severity: 'low',
      title: `${untargetable.length} 段站位差異發生在 Boss 無法選中時`,
      detail: `${listed.join('、')}${untargetable.length > listed.length ? ' 等' : ''}。轉場等 Boss 無法選中的期間，玩家常被強制移動或無法移動，站位不同不一定是站錯。`,
      at: untargetable[0].start,
    })
  }

  const mirrored = ofKind('mirror')
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

// 冷卻技晚用的時間點最多列出幾個
const MAX_LATE_LISTED = 3

/**
 * 冷卻技沒有好了就用（xivanalysis 的 CooldownDowntime）：我比理論最多可用次數少、而且使用率比參考低時提出，
 * 列出晚了 5 秒以上的時間點。只檢討輸出技能：治療、減傷、移動等（nonOffensive）依機制使用，不以最多可用次數要求。
 */
function cooldownAdvice(input: Pick<AdviceInput, 'cooldowns' | 'abilityName' | 'mineToRef'>): Advice[] {
  const items: Advice[] = []
  for (const { mine, ref, nonOffensive } of input.cooldowns ?? []) {
    if (!mine || mine.max === 0 || nonOffensive) continue
    const lost = mine.max - mine.uses
    if (lost <= 0) continue
    const mineRate = mine.uses / mine.max
    const refRate = ref && ref.max > 0 ? ref.uses / ref.max : 1
    if (ref && mineRate >= refRate) continue
    const name = input.abilityName(mine.group.ids[0])
    const late = mine.late.filter((l) => l.lateMs >= LATE_LISTED_MS).sort((a, b) => b.lateMs - a.lateMs)
    const listed = late
      .slice(0, MAX_LATE_LISTED)
      .sort((a, b) => a.t - b.t)
      .map((l) => `${formatFightTime(input.mineToRef(l.t))}（晚 ${seconds(l.lateMs)} 秒）`)
      .join('、')
    items.push({
      severity: lost >= 2 ? 'high' : 'medium',
      title: `${name}：最多可用 ${mine.max} 次，你用了 ${mine.uses} 次${ref ? `（參考 ${ref.uses}／${ref.max}）` : ''}`,
      detail:
        (late.length > 0 ? `冷卻好後晚了 5 秒以上才用的有 ${late.length} 次：${listed}${late.length > MAX_LATE_LISTED ? ' 等' : ''}。` : '') +
        '冷卻好就用，才不會整場少用；若是為了對齊爆發而延後，確認沒有因此少用一次。',
      at: late.length > 0 ? input.mineToRef(late[0].t) : undefined,
    })
  }
  return items
}

// 提早續上最多列出幾次
const MAX_CLIPS_LISTED = 3
// 覆蓋率比目標低這麼多（百分點）以上列為優先
const DOT_UPTIME_HIGH_GAP = 10

/**
 * DoT（xivanalysis 的 DoTs）：覆蓋率未達目標、提早續上達到門檻時提出；有參考時只在我比參考差時提。
 * 時間：我的戰鬥時間以 mineToRef 換成參考時間。
 */
function dotAdvice(input: { dots?: DotPair[]; abilityName: (id: number) => string; mineToRef: (t: number) => number }): Advice[] {
  const items: Advice[] = []
  for (const { mine, ref } of input.dots ?? []) {
    const name = mine.rule.statusIds.map((id) => input.abilityName(fflogsStatusId(id))).join('／')
    const target = mine.rule.uptimeTarget
    if (mine.uptime < target && (!ref || mine.uptime < ref.uptime)) {
      items.push({
        severity: target - mine.uptime >= DOT_UPTIME_HIGH_GAP ? 'high' : 'medium',
        title: `${name} 覆蓋率 ${mine.uptime.toFixed(1)}%（目標 ${target}%${ref ? `，參考 ${ref.uptime.toFixed(1)}%` : ''}）`,
        detail: '掉了就補上，覆蓋率越高輸出越高（Boss 無法選中的時間不算）；對照時間軸找出掉了的時段。',
      })
    }
    const severity = clipSeverity(mine)
    if (severity && mine.clipPerMinMs !== null && (!ref || ref.clipPerMinMs === null || mine.clipPerMinMs > ref.clipPerMinMs)) {
      const worst = [...mine.clips].sort((a, b) => b.ms - a.ms).slice(0, MAX_CLIPS_LISTED)
      items.push({
        severity,
        title: `${name} 提早續上：每分鐘覆蓋掉 ${seconds(mine.clipPerMinMs)} 秒${ref?.clipPerMinMs != null ? `（參考 ${seconds(ref.clipPerMinMs)} 秒）` : ''}`,
        detail:
          `覆蓋最多的：${[...worst].sort((a, b) => a.t - b.t).map((c) => `${formatFightTime(input.mineToRef(c.t))}（剩 ${seconds(c.ms)} 秒）`).join('、')}。` +
          '還沒結束就再施加會浪費剩下的傷害，等快結束時再續上。',
        at: worst.length > 0 ? input.mineToRef(worst[0].t) : undefined,
      })
    }
  }
  return items
}

// 穿插過多最多列出幾次
const MAX_WEAVES_LISTED = 5

/**
 * 穿插過多導致 GCD 延後（xivanalysis 的 Weaving）：依次數分級；有參考時只在我比參考多時提。
 * 時間：我的戰鬥時間以 mineToRef 換成參考時間。
 */
function weavingAdvice(input: {
  weaving?: { mine: BadWeave[]; ref: BadWeave[] | null }
  subType?: string
  abilityName: (id: number) => string
  mineToRef: (t: number) => number
}): Advice[] {
  const w = input.weaving
  if (!w || w.mine.length === 0 || (w.ref && w.mine.length <= w.ref.length)) return []
  const severity = weavingSeverity(w.mine.length, input.subType ?? '')
  if (!severity) return []
  const delay = w.mine.reduce((sum, b) => sum + b.delayMs, 0)
  const byDelay = [...w.mine].sort((a, b) => b.delayMs - a.delayMs)
  const worst = byDelay.slice(0, MAX_WEAVES_LISTED).sort((a, b) => a.start - b.start)
  return [
    {
      severity,
      title: `穿插過多 ${w.mine.length} 次，GCD 共延後 ${seconds(delay)} 秒${w.ref ? `（參考 ${w.ref.length} 次）` : ''}`,
      detail:
        `延後最多的：${worst
          .map((b) => `${formatFightTime(input.mineToRef(b.start))}（${b.weaves.map((a) => input.abilityName(a.abilityId)).join('、')}，晚 ${seconds(b.delayMs)} 秒）`)
          .join('、')}。` + '一個 GCD 之間穿插的能力技太多會延後下一個 GCD；把能力技分散到其他 GCD 之間，或在瞬發 GCD 之後穿插。',
      // 「查看」跳到延後最多的一次
      at: input.mineToRef(byDelay[0].start),
    },
  ]
}

// 止損技最多列出幾次（止損技威力低、直接少了輸出，一律列為優先）
const MAX_FILLERS_LISTED = 5

/**
 * 止損技（近戰與坦克的遠程 GCD，見 jobs/rangedFillers.ts）：
 * 有參考時，列出參考在同一段（前後 5 秒）沒有用止損技的次數；沒有參考時列出我用的次數。
 * @param fillers 算止損的施放時間（各自的戰鬥時間；開場起手、強化效果中的已排除）
 */
function fillerAdvice(input: {
  fillers?: { mine: number[]; ref: number[] | null }
  abilityName: (id: number) => string
  fillerId?: number
  mineToRef: (t: number) => number
}): Advice[] {
  const f = input.fillers
  if (!f || f.mine.length === 0) return []
  const name = input.fillerId !== undefined ? input.abilityName(input.fillerId) : '止損技'
  const list = (times: number[]) =>
    times
      .slice(0, MAX_FILLERS_LISTED)
      .map((t) => formatFightTime(t))
      .join('、') + (times.length > MAX_FILLERS_LISTED ? ' 等' : '')
  const mineRef = f.mine.map(input.mineToRef)
  if (f.ref === null) {
    return [
      {
        severity: 'high',
        title: `${name}（止損技）用了 ${f.mine.length} 次`,
        detail: `${list(mineRef)}。止損技威力低，代表那時離 Boss 太遠；檢查是否能提早移動、貼近 Boss 或改用較強的遠程技能。選了參考日誌後可以看前輩在同一段是否也需要。`,
        at: mineRef[0],
      },
    ]
  }
  const { shared, onlyMine } = compareFillers(mineRef, f.ref)
  if (onlyMine.length === 0) return []
  return [
    {
      severity: 'high',
      title: `${name}（止損技）用了 ${f.mine.length} 次（參考 ${f.ref.length} 次），其中 ${onlyMine.length} 次參考沒有用`,
      detail:
        `參考在同一段（前後 5 秒）沒有用止損技：${list(onlyMine)}。止損技威力低，對照這些時間的站位，看參考怎麼留在 Boss 身邊。` +
        (shared.length > 0 ? `另外 ${shared.length} 次參考也用了，多半是機制造成。` : ''),
      at: onlyMine[0],
    },
  ]
}

const percent = (v: number) => `${Math.round(v * 100)}%`

/** 死亡回顧的摘要文字（死亡建議的細節用） */
function recapText(recap: DeathRecap | undefined, abilityName: (id: number) => string): string {
  if (!recap || recap.hits.length === 0) return ''
  const hits = recap.hits
    .filter((h) => !h.tick)
    .map((h) => `${formatFightTime(h.t)} ${abilityName(h.abilityId)} ${h.amount.toLocaleString()}${h.hpAfter !== null ? `（剩 ${percent(h.hpAfter)}）` : ''}`)
  const last = recap.hits.findLast((h) => !h.tick)
  const ref =
    recap.ref && last
      ? `參考在同一時間吃「${abilityName(last.abilityId)}」受到 ${recap.ref.amount.toLocaleString()}` +
        `${recap.ref.mitigation !== null ? `（減傷 ${percent(recap.ref.mitigation)}）` : ''}${recap.ref.died ? '，也死亡。' : '，沒有死亡。'}`
      : ''
  return (hits.length ? `第一次死亡前 10 秒：${hits.join('、')}。` : '') + ref
}

/** 傷害降低（機制失誤的懲罰）：比較模式中我比參考多時提出 */
function penaltyAdvice(input: Pick<AdviceInput, 'penalties' | 'mineToRef'>): Advice[] {
  const p = input.penalties
  if (!p || p.mine.length === 0 || p.mine.length <= p.ref.length) return []
  const total = p.mine.reduce((sum, x) => sum + (x.end - x.start), 0)
  return [
    {
      // 懲罰效果與死亡同為機制失誤的直接結果，列為優先
      severity: 'high',
      title: `被施加傷害降低 ${p.mine.length} 次，共 ${seconds(total)} 秒（參考 ${p.ref.length} 次）`,
      detail: `${p.mine.map((x) => formatFightTime(input.mineToRef(x.start))).join('、')}：傷害降低通常是機制處理失誤的懲罰，期間輸出下降。對照時間軸看是哪個機制。`,
      at: input.mineToRef(p.mine[0].start),
    },
  ]
}

const ORDER: Record<Severity, number> = { high: 0, medium: 1, low: 2 }

function sortAdvice(items: Advice[]): Advice[] {
  return items.map((a, i) => ({ a, i })).sort((x, y) => ORDER[x.a.severity] - ORDER[y.a.severity] || x.i - y.i).map((x) => x.a)
}

/** 還沒有參考日誌時的建議輸入：只有我的資料，時間都是我的戰鬥時間。 */
export interface SoloAdviceInput {
  abilityName: (id: number) => string
  deaths: Death[]
  durationMs: number
  /** 停手時段（見 metrics.ts 的 idleWindows；refGcds 為估計少打的 GCD 數，control 為控場造成的） */
  stops: LostWindow[]
  /** 技能窗口（我依規則的評分） */
  windows: WindowSummary[]
  /** 冷卻技（ref 為 null） */
  cooldowns: CooldownPair[]
  /** 讓輸出下降的懲罰效果（傷害降低；衰弱、瀕死是死亡的結果，由死亡建議處理） */
  penalties: { statusId: number; start: number; end: number }[]
  /** 整場的強化藥使用次數；沒有規則可判斷（例如找不到強化藥）時為 null */
  potionUses: number | null
  /** DoT（ref 為 null） */
  dots?: DotPair[]
  /** 算止損的止損技施放時間（見 jobs/rangedFillers.ts 的 lossFillerTimes） */
  fillers?: number[]
  /** 這個職業的止損技 ID（名稱用） */
  fillerId?: number
  /** 穿插過多（見 analysis/weaving.ts） */
  weaving?: BadWeave[]
  /** 職業（FFLogs subType；穿插過多的分級用） */
  subType?: string
  /** 我每次死亡的死亡回顧 */
  deathRecaps?: DeathRecap[]
}

/**
 * 還沒有參考日誌時的建議：只用規則判斷（死亡、停手、冷卻技、技能窗口、懲罰效果、強化藥），
 * 需要與參考比較的（站位、機制、GCD 速度、技能時機）等選了參考日誌才提出。
 */
export function generateSoloAdvice(input: SoloAdviceInput): Advice[] {
  const { abilityName } = input
  const items: Advice[] = []

  if (input.deaths.length > 0) {
    const list = input.deaths.map((d) => `${formatFightTime(d.t)}${d.abilityId !== null ? `（${abilityName(d.abilityId)}）` : ''}`).join('、')
    const unable = input.deaths.reduce((sum, d) => sum + ((d.revivedAt ?? input.durationMs) - d.t), 0)
    items.push({
      kind: 'death',
      severity: 'high',
      title: `你死亡了 ${input.deaths.length} 次：避免死亡是最優先的改進`,
      detail:
        `死亡時間與致命技能：${list}。死亡到恢復行動共 ${seconds(unable)} 秒無法輸出，還會消耗隊友的復活與資源、增加全隊的壓力。` +
        recapText(input.deathRecaps?.[0], abilityName) +
        '對照時間軸確認這些機制的處理方式；選了參考日誌後可以看前輩怎麼避開或用了哪些減傷。',
      at: input.deaths[0].t,
    })
  }

  // 停手：控場造成的合併成一則參考，其餘依估計少打的 GCD 數
  const controlled = input.stops.filter((w) => w.control)
  const stops = input.stops.filter((w) => !w.control)
  if (stops.length > 0) {
    const total = stops.reduce((sum, w) => sum + w.refGcds, 0)
    items.push({
      kind: 'gcd',
      severity: total >= 3 ? 'high' : 'medium',
      title: `有 ${stops.length} 段停手，約少打 ${total} 個 GCD`,
      detail:
        '依你的 GCD 間隔估計（Boss 無法選中與死亡的時間已扣除）。檢查是否能提早移動、在移動中穿插 GCD，或縮短走位距離；' +
        '選了參考日誌後可以看前輩在同一段是否仍在輸出。各段的時間與長度見下方「停手時段」。',
      section: LOST_GCD_SECTION,
    })
  }
  if (controlled.length > 0) {
    items.push({
      kind: 'gcd',
      severity: 'low',
      title: `${controlled.length} 段停手是 Boss 控場造成`,
      detail: `${controlled.map((w) => `${formatFightTime(w.mineStart)}（${controlNames(w.control!, abilityName)}）`).join('、')}：你身上有 Boss 施加、期間無法施放的效果，不是操作問題。`,
      at: controlled[0].mineStart,
    })
  }

  items.push(...tag('cooldown', cooldownAdvice({ cooldowns: input.cooldowns, abilityName, mineToRef: (t) => t })))
  items.push(...tag('dot', dotAdvice({ dots: input.dots, abilityName, mineToRef: (t) => t })))
  items.push(
    ...tag('weave', weavingAdvice({
      weaving: input.weaving && { mine: input.weaving, ref: null },
      subType: input.subType,
      abilityName,
      mineToRef: (t) => t,
    })),
  )
  items.push(
    ...tag('filler', fillerAdvice({
      fillers: input.fillers && { mine: input.fillers, ref: null },
      fillerId: input.fillerId,
      abilityName,
      mineToRef: (t) => t,
    })),
  )

  // 技能窗口：依規則評分，有不合格就提出（沒有參考可比較合格率）
  for (const summary of input.windows) {
    if (summary.inapplicable || summary.judged === 0 || summary.passed === summary.judged) continue
    const failed = summary.windows.filter((w) => w.judged && w.issues.length > 0)
    const counts = new Map<string, number>()
    for (const w of failed) for (const issue of w.issues) counts.set(issue, (counts.get(issue) ?? 0) + 1)
    const common = [...counts]
      .sort((a, b) => b[1] - a[1])
      .slice(0, MAX_WINDOW_ISSUES)
      .map(([issue, n]) => `${issue}（${n} 次）`)
      .join('；')
    const name = ruleName(summary.rule, abilityName)
    items.push({
      kind: 'window',
      severity: 'medium',
      title: `${name}：${summary.judged} 次中 ${summary.passed} 次合格`,
      detail: `常見問題：${common}。對照時間軸上${name}期間使用的技能。`,
      at: failed[0].start,
    })
  }

  if (input.penalties.length > 0) {
    const total = input.penalties.reduce((sum, p) => sum + (p.end - p.start), 0)
    items.push({
      kind: 'penalty',
      severity: 'high',
      title: `被施加傷害降低 ${input.penalties.length} 次，共 ${seconds(total)} 秒`,
      detail: `${input.penalties.map((p) => formatFightTime(p.start)).join('、')}：傷害降低通常是機制處理失誤的懲罰，期間輸出下降。對照時間軸看是哪個機制。`,
      at: input.penalties[0].start,
    })
  }

  if (input.potionUses === 0) {
    items.push({
      kind: 'potion',
      severity: 'medium',
      title: '整場沒有使用強化藥',
      detail: '強化藥通常在開場與之後的爆發期使用（冷卻 4 分 30 秒），能明顯提高輸出。',
    })
  }

  return sortAdvice(items)
}

/** 依各階段的分析結果產生規則式建議，依重要性排序。 */
export function generateAdvice(input: AdviceInput): Advice[] {
  const items = [
    ...tag('death', deathAdvice(input)),
    ...tag('gcd', lostGcdAdvice(input)),
    ...tag('gcd', gcdSpeedAdvice(input)),
    ...tag('cooldown', cooldownAdvice(input)),
    ...tag('dot', dotAdvice(input)),
    ...tag('window', windowAdvice(input)),
    ...tag('prepull', prepullAdvice(input)),
    ...tag('usage', usageAdvice(input)),
    ...tag('penalty', penaltyAdvice(input)),
    ...tag('weave', weavingAdvice(input)),
    ...tag('filler', fillerAdvice(input)),
    ...tag('position', positionAdvice(input)),
  ]
  // 穩定排序：同等級維持產生順序（死亡 → 停手 → GCD 速度 → 冷卻技 → DoT → 技能窗口 → 開打前 → 技能 → 站位）
  return sortAdvice(items)
}
