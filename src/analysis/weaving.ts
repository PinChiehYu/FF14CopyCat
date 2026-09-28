import { GCD_TIMING } from '../jobs/generated'

// 穿插過多導致 GCD 延後（移植自 xivanalysis〔MIT〕dawntrail b240252 的 core/modules/AlwaysBeCasting/Weaving 與各職業的 Weaving）

// 前一個 GCD 的詠唱時間 → 之後可以穿插幾個能力技（xivanalysis 的 CAST_TIME_MAX_WEAVES）
const CAST_TIME_MAX_WEAVES: [number, number][] = [
  [2500, 0],
  [1000, 1],
  [0, 2],
]
// 復唱短於這個值時少穿插一個
const REDUCE_MAX_WEAVES_RECAST_BELOW = 1800
const DEFAULT_MAX_WEAVES = 2
const BASE_RECAST = 2500
// 繪靈法師長詠唱技能後的穿插數：動畫鎖 0.6 秒
const ANIMATION_LOCK = 600

// 各職業的例外（技能 ID 取自 xivanalysis src/data/ACTIONS）
const SIX_SIDED_STAR = 16476
const STARDIVER = 16480
const UNCOILED_FURY = 34633
const DREAM_WITHIN_A_DREAM = 3566
/** 不是真正施放的技能（賢者 Pneuma 的治療、繪靈 Star Prism 的治療） */
const IGNORED = new Set([27524, 34682])
/** 繪靈法師的長詠唱技能：動物／武器／風景彩繪、減色魔法、彗星之黑、彩虹點滴 */
const PCT_LONG_CASTS = new Set([34664, 34665, 34666, 34667, 34668, 34669, 34653, 34654, 34655, 34659, 34660, 34661, 34663, 34688])

/** 建議的嚴重程度（xivanalysis 的 WEAVING_SEVERITY：1 次中、5 次高；學者 1 次低、5 次中、10 次高） */
export function weavingSeverity(count: number, subType: string): 'low' | 'medium' | 'high' | null {
  if (subType === 'Scholar') return count >= 10 ? 'high' : count >= 5 ? 'medium' : count >= 1 ? 'low' : null
  return count >= 5 ? 'high' : count >= 1 ? 'medium' : null
}

export interface BadWeave {
  /** 前一個 GCD 開始的時間（該側的戰鬥時間；開打時沒有前一個 GCD 為 0） */
  start: number
  /** 下一個 GCD 開始的時間 */
  end: number
  /** 穿插的能力技 */
  weaves: { t: number; abilityId: number }[]
  /** 可以穿插的數量 */
  allowed: number
  /** GCD 延後的時間（兩個 GCD 間隔扣掉 Boss 無法選中與前一個 GCD 的復唱） */
  delayMs: number
}

interface Span {
  start: number
  end: number
}

const overlap = (spans: Span[], start: number, end: number) =>
  spans.reduce((sum, s) => sum + Math.max(0, Math.min(s.end, end) - Math.max(s.start, start)), 0)

/**
 * 穿插過多：兩個 GCD 之間的能力技比可以穿插的多，而且兩個 GCD 的間隔（扣掉 Boss 無法選中）超過前一個 GCD 的復唱。
 * 可以穿插的數量依前一個 GCD 的實際詠唱時間（瞬發 2、1 秒以上 1、2.5 秒以上 0；復唱短於 1.8 秒再少 1），
 * 復唱為遊戲資料的基本復唱乘上這一側的技能速度（實測 GCD ÷ 2.5 秒）。死亡的那一段、最後一個 GCD 之後不算；開打前的能力技不算。
 * @param side 該側的戰鬥時間；castBars 用來判斷實際詠唱時間（有讀條的才算詠唱，即刻詠唱等瞬發的不算）
 * @param gcdMs 這一側的 GCD（gcdStats 的推估）；沒有時以 2.5 秒計
 */
export function badWeaves(
  side: {
    playerCasts: { t: number; abilityId: number }[]
    castBars: { abilityId: number; start: number; end: number; interrupted: boolean }[]
    deaths: { t: number; revivedAt: number | null }[]
    untargetable: Span[]
    duration: number
  },
  subType: string,
  isGcd: (abilityId: number) => boolean,
  isItem: (abilityId: number) => boolean,
  gcdMs: number | null,
): BadWeave[] {
  const speed = (gcdMs ?? BASE_RECAST) / BASE_RECAST
  const casts = side.playerCasts.filter((c) => !IGNORED.has(c.abilityId) && !isItem(c.abilityId))
  const castTime = (c: { t: number; abilityId: number }) => {
    const bar = side.castBars.find((b) => b.abilityId === c.abilityId && b.start === c.t && !b.interrupted)
    return bar ? bar.end - bar.start : 0
  }
  const recast = (abilityId: number) => (GCD_TIMING[abilityId]?.[1] ?? BASE_RECAST) * speed

  const maxWeaves = (lead: { t: number; abilityId: number } | null, weaves: { abilityId: number }[]) => {
    if (subType === 'Monk') return lead?.abilityId === SIX_SIDED_STAR ? 4 : 2
    if (subType === 'Dragoon' && weaves.some((w) => w.abilityId === STARDIVER)) return 1
    if (!lead) return DEFAULT_MAX_WEAVES
    const cast = castTime(lead)
    if (subType === 'Pictomancer' && PCT_LONG_CASTS.has(lead.abilityId)) {
      return Math.round((recast(lead.abilityId) - cast - ANIMATION_LOCK) / ANIMATION_LOCK)
    }
    let max = CAST_TIME_MAX_WEAVES.find(([min]) => cast >= min)![1]
    if (recast(lead.abilityId) < REDUCE_MAX_WEAVES_RECAST_BELOW) max -= 1
    if (subType === 'Viper' && lead.abilityId === UNCOILED_FURY) max += 1
    // 忍者：日誌重複記錄的夢幻三段不算
    if (subType === 'Ninja') max += Math.max(0, weaves.filter((w) => w.abilityId === DREAM_WITHIN_A_DREAM).length - 1)
    return max
  }

  const found: BadWeave[] = []
  let lead: { t: number; abilityId: number } | null = null
  let weaves: { t: number; abilityId: number }[] = []
  const close = (end: number, trail: { t: number; abilityId: number }) => {
    const start = lead?.t ?? 0
    // 死亡的那一段不算（xivanalysis 在死亡時重新開始計算）
    const died = side.deaths.some((d) => d.t > start && d.t <= end)
    const counted = weaves.filter((w) => w.t >= 0 && overlap(side.untargetable, w.t, w.t + 1) === 0)
    if (!died && counted.length > 0) {
      const gap = end - start - overlap(side.untargetable, start, end)
      const leadRecast = lead ? recast(lead.abilityId) : (gcdMs ?? BASE_RECAST)
      const allowed = maxWeaves(lead, weaves)
      if (gap > leadRecast && counted.length > allowed) {
        found.push({ start, end, weaves: counted, allowed, delayMs: gap - leadRecast })
      }
    }
    lead = trail
    weaves = []
  }
  for (const c of casts) {
    if (isGcd(c.abilityId)) close(c.t, c)
    else weaves.push(c)
  }
  // 最後一個 GCD 之後（戰鬥結束或比較範圍的結束點）沒有下一個 GCD 被延後，不檢查
  // （xivanalysis 以戰鬥結束當作下一個 GCD；比較範圍裁切時那不是真的結束）
  return found
}
