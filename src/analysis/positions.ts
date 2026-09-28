import type { TimedCast } from './alignment'
import type { MechanicDifference } from './mechanics'

/** 位置取樣，座標單位為 yalm（FFLogs 原始值 ÷ 100），時間為戰鬥時間（毫秒）。 */
export interface PositionSample {
  t: number
  x: number
  y: number
  /** 面向（弧度；FFLogs 原始值 ÷ 100），方向為 (cos, sin)，與座標同一平面 */
  facing?: number
}

export interface Point {
  x: number
  y: number
}

export interface InterpolationLimits {
  /** 相鄰取樣相距超過此值時不內插（例如死亡、無事件的期間） */
  maxGapMs: number
  /** 超出取樣範圍或取樣中斷時，最多沿用最近取樣這麼久 */
  maxHoldMs: number
}

// 玩家事件密集（約每 0.4 秒一筆），可以嚴格
export const PLAYER_LIMITS: InterpolationLimits = { maxGapMs: 4000, maxHoldMs: 1000 }
// Boss 位置只來自 Boss 的施放，取樣稀疏，但 Boss 移動不頻繁
export const BOSS_LIMITS: InterpolationLimits = { maxGapMs: 30_000, maxHoldMs: 10_000 }

/** 以線性內插取得某時間點的位置；資料不足時回傳 null。samples 需依時間排序。 */
export function positionAt(
  samples: PositionSample[],
  t: number,
  { maxGapMs, maxHoldMs }: InterpolationLimits = PLAYER_LIMITS,
): Point | null {
  if (samples.length === 0) return null
  let lo = 0
  let hi = samples.length - 1
  if (t <= samples[0].t) return samples[0].t - t <= maxHoldMs ? samples[0] : null
  if (t >= samples[hi].t) return t - samples[hi].t <= maxHoldMs ? samples[hi] : null
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1
    if (samples[mid].t <= t) lo = mid
    else hi = mid
  }
  const a = samples[lo]
  const b = samples[hi]
  if (b.t - a.t > maxGapMs) {
    // 取樣中斷：只在靠近兩端時沿用最近的點
    if (t - a.t <= maxHoldMs) return a
    if (b.t - t <= maxHoldMs) return b
    return null
  }
  const k = (t - a.t) / (b.t - a.t)
  return { x: a.x + (b.x - a.x) * k, y: a.y + (b.y - a.y) * k }
}

/**
 * 把我的位置對齊到參考的 Boss：保留我相對於我那一場 Boss 的位置（只平移、不旋轉，北方仍朝上），
 * 放到同一時間參考 Boss 的位置上。兩場 Boss 站位不同（換場落點、位移時間不同）時，比較的是相對於 Boss 的站位。
 * 任一邊當下沒有 Boss 位置（無法選中、轉場等）時沿用原始位置。
 * @param samples 我的位置（參考時間）
 * @param mineBoss 我的日誌的 Boss 位置（參考時間）
 */
export function alignToBoss(samples: PositionSample[], mineBoss: PositionSample[], refBoss: PositionSample[]): PositionSample[] {
  return samples.map((s) => {
    const mb = positionAt(mineBoss, s.t, BOSS_LIMITS)
    const rb = positionAt(refBoss, s.t, BOSS_LIMITS)
    return mb && rb ? { ...s, x: s.x - mb.x + rb.x, y: s.y - mb.y + rb.y } : s
  })
}

// Boss 面向取最接近的取樣，最多相差這麼久
const FACING_HOLD_MS = 5000

/** 某時間點 Boss 的位置與面向；任一項沒有資料時回傳 null。 */
export function bossPoseAt(samples: PositionSample[], t: number): { at: Point; facing: number } | null {
  const at = positionAt(samples, t, BOSS_LIMITS)
  if (!at) return null
  let facing: number | undefined
  let best = Infinity
  for (const s of samples) {
    if (s.facing === undefined) continue
    const d = Math.abs(s.t - t)
    if (d < best) {
      best = d
      facing = s.facing
    }
    if (s.t > t + FACING_HOLD_MS) break
  }
  return facing !== undefined && best <= FACING_HOLD_MS ? { at, facing } : null
}

/**
 * 換算成以 Boss 為基準的座標：Boss 在原點、Boss 面向朝上（畫面的 −y）。
 * 面向 θ 的方向為 (cos θ, sin θ)，旋轉 −π/2 − θ 後落在 (0, −1)。
 */
export function toBossFrame(p: Point, pose: { at: Point; facing: number }): Point {
  const dx = p.x - pose.at.x
  const dy = p.y - pose.at.y
  const phi = -Math.PI / 2 - pose.facing
  const cos = Math.cos(phi)
  const sin = Math.sin(phi)
  return { x: dx * cos - dy * sin, y: dx * sin + dy * cos }
}

export function distance(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.y - b.y)
}

export type MirrorKind = 'left-right' | 'front-back' | 'point'

export const MIRROR_LABELS: Record<MirrorKind, string> = {
  'left-right': '左右對稱',
  'front-back': '前後對稱',
  point: '點對稱',
}

/** 以 center 為中心的三種對稱。 */
function mirrors(p: Point, center: Point): { kind: MirrorKind; p: Point }[] {
  return [
    { kind: 'left-right', p: { x: 2 * center.x - p.x, y: p.y } },
    { kind: 'front-back', p: { x: p.x, y: 2 * center.y - p.y } },
    { kind: 'point', p: { x: 2 * center.x - p.x, y: 2 * center.y - p.y } },
  ]
}

/** 以樣本中位數估計場地中心（Boss 大多站在場中央）。 */
export function estimateCenter(samples: PositionSample[]): Point {
  if (samples.length === 0) return { x: 100, y: 100 }
  const mid = (values: number[]) => [...values].sort((a, b) => a - b)[values.length >> 1]
  return { x: mid(samples.map((s) => s.x)), y: mid(samples.map((s) => s.y)) }
}

export interface TrackPoint {
  /** 參考時間 */
  t: number
  mine: Point | null
  ref: Point | null
  boss: Point | null
  /** 兩人距離（yalm） */
  distance: number | null
  /** 把參考位置以 Boss 或場地中心做對稱後，與我的最短距離 */
  mirroredDistance: number | null
  /** 最短距離對應的對稱方式 */
  mirror: MirrorKind | null
}

/**
 * 以參考時間為基準，每 stepMs 取樣兩人位置。
 * @param mineSamples 我的位置，時間已換算成參考時間（需依時間排序）
 * @param arenaCenter 場地中心；不同攻略常以場地中心對稱（連 Boss 位置也對稱時，以 Boss 為中心判斷不出來）
 */
export function compareTracks(
  mineSamples: PositionSample[],
  refSamples: PositionSample[],
  bossSamples: PositionSample[],
  durationMs: number,
  arenaCenter: Point = estimateCenter(bossSamples),
  stepMs = 500,
): TrackPoint[] {
  const track: TrackPoint[] = []
  for (let t = 0; t <= durationMs; t += stepMs) {
    const mine = positionAt(mineSamples, t)
    const ref = positionAt(refSamples, t)
    const boss = positionAt(bossSamples, t, BOSS_LIMITS)
    const d = mine && ref ? distance(mine, ref) : null
    let mirroredDistance: number | null = null
    let mirror: MirrorKind | null = null
    if (mine && ref) {
      for (const center of boss ? [boss, arenaCenter] : [arenaCenter]) {
        for (const m of mirrors(ref, center)) {
          const md = distance(mine, m.p)
          if (mirroredDistance === null || md < mirroredDistance) {
            mirroredDistance = md
            mirror = m.kind
          }
        }
      }
    }
    track.push({ t, mine, ref, boss, distance: d, mirroredDistance, mirror })
  }
  return track
}

export interface Divergence {
  start: number
  end: number
  maxDistance: number
  /** 區段內多數時間，我的位置接近參考的對稱位置（可能是不同攻略）；否則為 null */
  mirror: MirrorKind | null
  /** 區段期間結算的 Boss 機制（兩邊都列出，見 attachMechanics）；站位差異在機制結算時才有明顯意義 */
  mechanics: DivergenceMechanic[]
  /** 區段期間（或開始前不久）兩邊的 Boss 隨機機制不同（見 attachVariants）：站位不同可能是機制造成 */
  variant?: MechanicDifference
  /** 區段與任一邊 Boss 無法選中的時段重疊（轉場等，玩家常被強制移動或無法移動；見 attachUntargetable） */
  untargetable?: boolean
}

/** 站位差異期間結算的 Boss 機制。兩邊都有（相差 PAIR_MECHANIC_MS 內）時合成一筆，只有一邊結算時另一邊的時間為空。 */
export interface DivergenceMechanic {
  abilityId: number
  /** 參考時間（排序、游標與距離用）：參考有結算時為參考的時間，否則為我的時間換算成參考時間 */
  t: number
  /** 我的日誌中結算的時間（我的戰鬥時間） */
  mine?: number
  /** 參考日誌中結算的時間 */
  ref?: number
  /** 結算當下（參考時間 t）我離我那一場 Boss、參考離參考那一場 Boss 的距離；沒有位置資料時為 null（見 attachBossDistances） */
  mineToBoss?: number | null
  refToBoss?: number | null
  /**
   * 兩人相對於各自 Boss 的位置（北方朝上、只平移）相距不超過門檻：站位不同是兩場 Boss 的位置不同造成，
   * 不算機制結算時的站位不同（見 positionMechanics）
   */
  sameToBoss?: boolean
}

/** 算作「機制結算時站位不同」的機制：排除兩人相對於各自 Boss 位置相近的。 */
export function positionMechanics(d: Divergence): DivergenceMechanic[] {
  return d.mechanics.filter((m) => !m.sameToBoss)
}

// 隨機機制差異發生在區段開始前這麼久以內，也視為相關（機制通常先施放、後結算）
export const VARIANT_LEAD_MS = 10_000

/** 標示每段站位差異相關的 Boss 隨機機制差異（同一時間兩邊施放不同技能）。 */
export function attachVariants(divergences: Divergence[], mechanics: MechanicDifference[]): Divergence[] {
  const variants = mechanics.filter((m) => m.kind === 'variant')
  return divergences.map((d) => {
    const variant = variants.find((m) => m.t >= d.start - VARIANT_LEAD_MS && m.t <= d.end)
    return variant ? { ...d, variant } : d
  })
}

export interface MechanicOptions {
  /** 施放超過此次數的 Boss 技能（自動攻擊等）不算機制 */
  maxOccurrences?: number
  /** 同一技能這段時間內重複施放視為一次 */
  dedupeMs?: number
}

/** 取樣軌跡中最接近 t 的點的兩人距離。 */
export function distanceAt(track: TrackPoint[], t: number): number | null {
  if (track.length === 0) return null
  const step = track.length > 1 ? track[1].t - track[0].t : 1
  return track[Math.min(track.length - 1, Math.max(0, Math.round(t / step)))].distance
}

// 兩邊同一技能的結算相差這麼久以內視為同一次（與 Boss 機制差異的配對相同）
export const PAIR_MECHANIC_MS = 5000

/** 機制候選：同一技能短時間內重複施放只算一次，施放次數多的（自動攻擊等）不算機制。 */
function mechanicCasts(bossCasts: TimedCast[], { maxOccurrences = 8, dedupeMs = 1000 }: MechanicOptions): TimedCast[] {
  const last = new Map<number, number>()
  const deduped = [...bossCasts]
    .sort((a, b) => a.t - b.t)
    .filter((c) => {
      const prev = last.get(c.abilityId)
      last.set(c.abilityId, c.t)
      return prev === undefined || c.t - prev >= dedupeMs
    })
  const counts = new Map<number, number>()
  for (const c of deduped) counts.set(c.abilityId, (counts.get(c.abilityId) ?? 0) + 1)
  return deduped.filter((c) => (counts.get(c.abilityId) ?? 0) <= maxOccurrences)
}

/**
 * 找出每段站位差異期間結算的 Boss 機制，兩邊都列出：任一邊的 Boss 施放完成（約為機制結算）落在區段內，
 * 且結算當下兩人距離超過門檻。只看區段前後時間的話，機制密集的戰鬥（例如 Howling Blade）
 * 會掛上還沒分開或已回到相近位置時結算的機制。另一邊 PAIR_MECHANIC_MS 內有同一技能時合成一筆（附上兩邊的時間），
 * 兩場的機制時間不同（轉場、推進）時也看得出各自何時結算。
 * @param bossCasts 兩邊的 Boss 施放（各自的戰鬥時間）；mineToRef 把我的時間換算成參考時間
 * @param distance 參考時間 t 時兩人的距離
 */
export function attachMechanics(
  divergences: Divergence[],
  bossCasts: { mine: TimedCast[]; ref: TimedCast[]; mineToRef: (t: number) => number },
  distance: (t: number) => number | null,
  thresholdYalm: number,
  options: MechanicOptions = {},
): Divergence[] {
  const ref = mechanicCasts(bossCasts.ref, options)
  const mine = mechanicCasts(bossCasts.mine, options).map((c) => ({ ...c, own: c.t, t: bossCasts.mineToRef(c.t) }))
  const apart = (t: number) => {
    const d0 = distance(t)
    return d0 !== null && d0 > thresholdYalm
  }

  return divergences.map((d) => {
    const inside = (t: number) => t >= d.start && t <= d.end && apart(t)
    const used = new Set<number>()
    const out: DivergenceMechanic[] = []
    // 參考的機制：找我這邊最近的同一技能（不限區段內，另一邊的結算時間也列出）
    for (const r of ref.filter((c) => inside(c.t))) {
      let best = -1
      for (let i = 0; i < mine.length; i++) {
        const gap = Math.abs(mine[i].t - r.t)
        if (used.has(i) || mine[i].abilityId !== r.abilityId || gap > PAIR_MECHANIC_MS) continue
        if (best < 0 || gap < Math.abs(mine[best].t - r.t)) best = i
      }
      if (best >= 0) used.add(best)
      out.push({ abilityId: r.abilityId, t: r.t, ref: r.t, mine: best >= 0 ? mine[best].own : undefined })
    }
    // 只有我這邊在區段內結算的
    mine.forEach((m, i) => {
      if (!used.has(i) && inside(m.t)) out.push({ abilityId: m.abilityId, t: m.t, mine: m.own })
    })
    return { ...d, mechanics: out.sort((a, b) => a.t - b.t) }
  })
}

/**
 * 機制結算當下兩人各自離自己那一場 Boss 的距離，以及相對於各自 Boss 的位置是否相近（sameToBoss）。
 * 許多機制以 Boss 為基準（鋼鐵月環、扇形等），兩場 Boss 站位不同時，場地上相距很遠也可能都站對了。
 * 任一邊沒有 Boss 位置（無法選中等）時不判斷，照場地上的距離算。
 * @param samples 全部為參考時間；mineBoss 為我的日誌的 Boss 位置
 */
export function attachBossDistances(
  divergences: Divergence[],
  samples: { mine: PositionSample[]; ref: PositionSample[]; mineBoss: PositionSample[]; refBoss: PositionSample[] },
  thresholdYalm: number,
): Divergence[] {
  return divergences.map((d) => ({
    ...d,
    mechanics: d.mechanics.map((m) => {
      const mine = positionAt(samples.mine, m.t)
      const ref = positionAt(samples.ref, m.t)
      const mineBoss = positionAt(samples.mineBoss, m.t, BOSS_LIMITS)
      const refBoss = positionAt(samples.refBoss, m.t, BOSS_LIMITS)
      const mineToBoss = mine && mineBoss ? distance(mine, mineBoss) : null
      const refToBoss = ref && refBoss ? distance(ref, refBoss) : null
      const sameToBoss =
        mine !== null &&
        ref !== null &&
        mineBoss !== null &&
        refBoss !== null &&
        Math.hypot(mine.x - mineBoss.x - (ref.x - refBoss.x), mine.y - mineBoss.y - (ref.y - refBoss.y)) <= thresholdYalm
      return { ...m, mineToBoss, refToBoss, sameToBoss }
    }),
  }))
}

/**
 * 標示與 Boss 無法選中的時段重疊的站位差異（任一邊；時段為參考時間）。轉場時玩家常被強制移動、落地後無法移動，
 * 日誌沒有「無法移動」的狀態，位置取樣也稀疏，站位差異照樣顯示但不當成站錯。
 */
export function attachUntargetable(divergences: Divergence[], spans: { start: number; end: number }[]): Divergence[] {
  return divergences.map((d) => (spans.some((s) => s.start < d.end && s.end > d.start) ? { ...d, untargetable: true } : d))
}

/** 對稱位置能解釋大部分差距：對稱後距離在門檻的 3/4 內，且不到原距離的一半。 */
function explainedByMirror(p: TrackPoint, threshold: number): boolean {
  return (
    p.distance !== null &&
    p.mirroredDistance !== null &&
    p.mirroredDistance <= threshold * 0.75 &&
    p.mirroredDistance < p.distance / 2
  )
}

/**
 * 找出兩人距離持續超過門檻的區段。
 * @param thresholdYalm 距離門檻
 * @param minDurationMs 至少持續多久才列出
 * @param mergeGapMs 間隔小於此值的相鄰區段合併
 */
export function divergences(
  track: TrackPoint[],
  thresholdYalm = 8,
  minDurationMs = 2000,
  mergeGapMs = 2000,
): Divergence[] {
  const raw: { start: number; end: number; points: TrackPoint[] }[] = []
  for (const p of track) {
    const far = p.distance !== null && p.distance > thresholdYalm
    const last = raw.at(-1)
    if (!far) continue
    if (last && p.t - last.end <= mergeGapMs) {
      last.end = p.t
      last.points.push(p)
    } else {
      raw.push({ start: p.t, end: p.t, points: [p] })
    }
  }
  return raw
    .filter((r) => r.end - r.start >= minDurationMs)
    .map((r) => {
      // 同一種對稱方式要能解釋區段內過半的時間，才視為不同攻略；
      // 否則六種候選（三種對稱 × 兩個中心）容易湊巧解釋掉真正的站位錯誤
      const kinds = new Map<MirrorKind, number>()
      for (const p of r.points) {
        if (explainedByMirror(p, thresholdYalm)) kinds.set(p.mirror!, (kinds.get(p.mirror!) ?? 0) + 1)
      }
      const [common, count] = [...kinds].sort((a, b) => b[1] - a[1])[0] ?? [null, 0]
      return {
        start: r.start,
        end: r.end,
        maxDistance: Math.max(...r.points.map((p) => p.distance ?? 0)),
        mirror: count > r.points.length / 2 ? common : null,
        mechanics: [],
      }
    })
}
