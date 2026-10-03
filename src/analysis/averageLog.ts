// 前輩平均：把一群前輩（同 Boss、同職業、同一 PR 區間的樣本，見 worker/src/timelines.ts）的施放合成一份「平均的施放」，
// 換算成我的戰鬥時間，當作參考日誌比較。規則見 docs/DESIGN.md「前輩平均」。
import { buildAlignment, type TimedCast } from './alignment'

export interface AverageSampleInput {
  /** Boss 施放（樣本自己的戰鬥時間） */
  boss: TimedCast[]
  /** 玩家的施放（含 GCD，不含普通攻擊；樣本自己的戰鬥時間） */
  casts: TimedCast[]
  /** 戰鬥長度（毫秒） */
  duration: number
}

/** 合成的施放：consistency 為一致度（0～1，該位置用這個技能的前輩比例），時間軸以透明度表示 */
export interface AveragedCast extends TimedCast {
  consistency: number
}

export interface AverageResult {
  casts: AveragedCast[]
  /** 比較範圍結束（我的時間）：過半數樣本已擊殺的時間；我比多數前輩快時為我的戰鬥結束 */
  rangeEnd: number
  /** 用到的樣本數（對齊錨點太少的不用） */
  used: number
  /** 每位用到的樣本換成我的時間的施放（到該樣本擊殺或比較範圍結束為止）：逐位計算統計再取中位數用 */
  aligned: TimedCast[][]
}

export interface AverageOptions {
  /** cactbot 主要機制（同一條目的不同版本視為同一機制，見 mainMechanics.ts） */
  knownGroups?: Map<number, number>
  isGcd: (abilityId: number) => boolean
}

// 錨點太少的樣本對齊不可靠，不用（與單一參考的 MIN_ANCHORS 相同）
const MIN_ANCHORS = 5
// 過半數：某位置（GCD）或某次使用（能力技）有至少這個比例的「仍在戰鬥中」的樣本才成立
const MAJORITY = 0.5
// GCD 位置：相鄰的 GCD 相差超過這麼久就是不同位置；一個位置最寬這麼多（避免漂移時把相鄰兩個 GCD 併成一個）
const GCD_GAP_MS = 1000
const GCD_MAX_SPREAD_MS = 1500
// 合成後相鄰的 GCD 太近（同一位置被切成兩半）時只留樣本多的
const GCD_MIN_SEPARATION_MS = 1500
// 能力技：同一技能相鄰兩次使用相差超過「冷卻的一半」（至少這麼久）就是不同次
const OGCD_MIN_GAP_MS = 5000
// 每位樣本都只用一次的技能（不知道冷卻）：相差這麼久才算不同次
const OGCD_SINGLE_GAP_MS = 30_000

const median = (values: number[]): number => {
  const sorted = [...values].sort((a, b) => a - b)
  const mid = sorted.length >> 1
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}

interface Aligned {
  casts: TimedCast[]
  /** 樣本的戰鬥結束（我的時間） */
  end: number
}

/** 樣本的施放換成我的時間（以兩邊的 Boss 施放對齊）；錨點太少時為 null */
function alignSample(mineBoss: TimedCast[], mineDuration: number, sample: AverageSampleInput, knownGroups?: Map<number, number>): Aligned | null {
  const alignment = buildAlignment(mineBoss, sample.boss, { knownGroups })
  if (alignment.anchors.length < MIN_ANCHORS) return null
  const casts = sample.casts
    .map((c) => ({ t: alignment.refToMine(c.t), abilityId: c.abilityId }))
    .filter((c) => c.t >= 0 && c.t <= mineDuration)
  return { casts, end: alignment.refToMine(sample.duration) }
}

interface Hit {
  t: number
  abilityId: number
  sample: number
}

/** 依時間把相鄰的施放分群：與前一個相差超過 gap、或與群的第一個相差超過 spread 就開新群 */
function clusters(hits: Hit[], gap: number, spread = Infinity): Hit[][] {
  const groups: Hit[][] = []
  for (const h of [...hits].sort((a, b) => a.t - b.t)) {
    const current = groups.at(-1)
    if (current && h.t - current.at(-1)!.t <= gap && h.t - current[0].t <= spread) current.push(h)
    else groups.push([h])
  }
  return groups
}

/**
 * GCD：先不分技能把所有樣本的 GCD 分成「位置」；過半數仍在戰鬥中的樣本在該位置有 GCD 才成立，
 * 取樣本中最常見的技能放在它的中位數時間，一致度＝用這個技能的樣本 ÷ 在該位置有 GCD 的樣本。
 */
function averageGcds(hits: Hit[], alive: (t: number) => number): AveragedCast[] {
  const placed: (AveragedCast & { samples: number })[] = []
  for (const group of clusters(hits, GCD_GAP_MS, GCD_MAX_SPREAD_MS)) {
    // 每位樣本在一個位置只算一次（取最早的）
    const bySample = new Map<number, Hit>()
    for (const h of group) if (!bySample.has(h.sample)) bySample.set(h.sample, h)
    const present = [...bySample.values()]
    const at = median(present.map((h) => h.t))
    if (present.length < MAJORITY * alive(at)) continue
    const counts = new Map<number, Hit[]>()
    for (const h of present) counts.set(h.abilityId, [...(counts.get(h.abilityId) ?? []), h])
    const [abilityId, users] = [...counts.entries()].sort((a, b) => b[1].length - a[1].length)[0]
    placed.push({ t: median(users.map((h) => h.t)), abilityId, consistency: users.length / present.length, samples: present.length })
  }
  // 太近的兩個位置（同一位置被切開）只留樣本多的
  const result: (AveragedCast & { samples: number })[] = []
  for (const c of placed.sort((a, b) => a.t - b.t)) {
    const last = result.at(-1)
    if (last && c.t - last.t < GCD_MIN_SEPARATION_MS) {
      if (c.samples > last.samples) result[result.length - 1] = c
    } else result.push(c)
  }
  return result.map(({ t, abilityId, consistency }) => ({ t, abilityId, consistency }))
}

/**
 * 能力技與道具：同一技能所有樣本的使用時間排序後分群（相鄰相差超過冷卻的一半就切開）；
 * 有用的樣本數 ÷ 當時仍在戰鬥中的樣本數 ≥ 過半數的群，在中位數時間放一次（同一群中樣本多用的次數取中位數，
 * 例如有兩次充能連續使用）。一致度＝使用的比例。
 */
function averageOgcds(hits: Hit[], alive: (t: number) => number): AveragedCast[] {
  const byAbility = new Map<number, Hit[]>()
  for (const h of hits) byAbility.set(h.abilityId, [...(byAbility.get(h.abilityId) ?? []), h])
  const result: AveragedCast[] = []
  for (const [abilityId, uses] of byAbility) {
    // 冷卻：每位樣本相鄰兩次使用的最短間隔，取中位數
    const gaps: number[] = []
    const bySample = new Map<number, number[]>()
    for (const h of uses) bySample.set(h.sample, [...(bySample.get(h.sample) ?? []), h.t])
    for (const times of bySample.values()) {
      const sorted = times.sort((a, b) => a - b)
      const shortest = Math.min(...sorted.slice(1).map((t, i) => t - sorted[i]))
      if (Number.isFinite(shortest)) gaps.push(shortest)
    }
    const gap = gaps.length > 0 ? Math.max(OGCD_MIN_GAP_MS, median(gaps) / 2) : OGCD_SINGLE_GAP_MS
    for (const group of clusters(uses, gap)) {
      const perSample = new Map<number, number[]>()
      for (const h of group) perSample.set(h.sample, [...(perSample.get(h.sample) ?? []), h.t])
      const at = median(group.map((h) => h.t))
      const share = perSample.size / Math.max(1, alive(at))
      if (share < MAJORITY) continue
      const times = [...perSample.values()]
      const count = Math.max(1, Math.round(median(times.map((t) => t.length))))
      for (let i = 0; i < count; i++) {
        const ith = times.filter((t) => t.length > i).map((t) => t[i])
        result.push({ t: median(ith), abilityId, consistency: Math.min(1, share) })
      }
    }
  }
  return result
}

/**
 * 前輩平均的施放（我的時間）：每位樣本以 Boss 施放對齊到我的戰鬥，再分 GCD 與能力技合成。
 * 比較範圍到過半數樣本已擊殺的時間（我比多數前輩快時到我的戰鬥結束）。
 */
export function averageCasts(mineBoss: TimedCast[], mineDuration: number, samples: AverageSampleInput[], options: AverageOptions): AverageResult {
  const aligned = samples.flatMap((s) => {
    const a = alignSample(mineBoss, mineDuration, s, options.knownGroups)
    return a ? [a] : []
  })
  if (aligned.length === 0) return { casts: [], rangeEnd: 0, used: 0, aligned: [] }
  const ends = aligned.map((a) => a.end)
  const rangeEnd = Math.min(mineDuration, median(ends))
  // 這個時間（我的時間）仍在戰鬥中的樣本數
  const alive = (t: number) => ends.filter((e) => e > t).length
  const hits = aligned.flatMap((a, sample) => a.casts.filter((c) => c.t <= a.end).map((c) => ({ t: c.t, abilityId: c.abilityId, sample })))
  const casts = [
    ...averageGcds(hits.filter((h) => options.isGcd(h.abilityId)), alive),
    ...averageOgcds(hits.filter((h) => !options.isGcd(h.abilityId)), alive),
  ].sort((a, b) => a.t - b.t)
  return { casts, rangeEnd, used: aligned.length, aligned: aligned.map((a) => a.casts.filter((c) => c.t <= Math.min(a.end, rangeEnd))) }
}
