import type { TimedCast } from './alignment'

/** 位置取樣，座標單位為 yalm（FFLogs 原始值 ÷ 100），時間為戰鬥時間（毫秒）。 */
export interface PositionSample {
  t: number
  x: number
  y: number
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
  /** 區段期間結算的 Boss 機制（見 attachMechanics）；站位差異在機制結算時才有明顯意義 */
  mechanics: TimedCast[]
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

/**
 * 找出每段站位差異期間結算的 Boss 機制：Boss 施放完成（約為機制結算）落在區段內，
 * 且結算當下兩人距離超過門檻。只看區段前後時間的話，機制密集的戰鬥（例如 Howling Blade）
 * 會掛上還沒分開或已回到相近位置時結算的機制。
 * @param bossCasts 參考日誌的 Boss 施放（參考時間）
 * @param distance 參考時間 t 時兩人的距離
 */
export function attachMechanics(
  divergences: Divergence[],
  bossCasts: TimedCast[],
  distance: (t: number) => number | null,
  thresholdYalm: number,
  { maxOccurrences = 8, dedupeMs = 1000 }: MechanicOptions = {},
): Divergence[] {
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
  const mechanics = deduped.filter((c) => (counts.get(c.abilityId) ?? 0) <= maxOccurrences)

  return divergences.map((d) => ({
    ...d,
    mechanics: mechanics.filter((m) => {
      const d0 = distance(m.t)
      return m.t >= d.start && m.t <= d.end && d0 !== null && d0 > thresholdYalm
    }),
  }))
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
