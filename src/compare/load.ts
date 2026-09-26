import type { TimedCast } from '../analysis/alignment'
import {
  enemyDebuffWindows,
  hpSamples,
  playerAuras,
  prepullEffects,
  selfBuffWindows,
  type Aura,
  type BuffWindow,
  type HpSample,
} from '../analysis/buffs'
import type { PositionSample } from '../analysis/positions'
import { toFightTime } from '../analysis/timeline'
import { fetchFightEvents } from '../fflogs/client'
import { jobName } from '../jobs/names'
import type { Actor, FFLogsEvent, Fight, Report } from '../fflogs/types'

export interface Selection {
  report: Report
  fight: Fight
  player: Actor
}

export interface SideData {
  selection: Selection
  /** 玩家施放的技能（不含普通攻擊） */
  playerCasts: TimedCast[]
  /** 普通攻擊：不畫在時間軸，只列入技能使用次數 */
  autoAttacks: TimedCast[]
  bossCasts: TimedCast[]
  /** 玩家位置（戰鬥時間、yalm） */
  playerPositions: PositionSample[]
  /** 主要 Boss（施放最多次的敵人）的位置 */
  bossPositions: PositionSample[]
  /** 玩家自己給自己的效果，以及玩家施加在敵人身上的效果的時段（技能窗口分析用） */
  buffs: BuffWindow[]
  /** 開打當下玩家自己施加、身上已有的效果 ID（推知開打前用過的技能） */
  prepull: number[]
  /** 玩家身上所有效果（任何來源）、血量與讀條：當下狀態面板用，不裁切 */
  auras: Aura[]
  hp: HpSample[]
  castBars: CastBar[]
  /** 戰鬥長度（毫秒） */
  duration: number
}

interface Resources {
  x?: number
  y?: number
}

/** 從事件的 source/targetResources 取出某角色的位置，依時間排序並去除同時間的重複取樣。 */
export function actorPositions(events: FFLogsEvent[], fight: Fight, actorId: number): PositionSample[] {
  const samples: PositionSample[] = []
  for (const e of events) {
    const res = (e.sourceID === actorId ? e.sourceResources : e.targetID === actorId ? e.targetResources : undefined) as
      | Resources
      | undefined
    if (res?.x === undefined || res.y === undefined) continue
    samples.push({ t: toFightTime(e.timestamp, fight.startTime), x: res.x / 100, y: res.y / 100 })
  }
  samples.sort((a, b) => a.t - b.t)
  return samples.filter((s, i) => i === 0 || s.t !== samples[i - 1].t)
}

/** 施放次數最多的敵人視為主要 Boss。 */
function mainEnemy(events: FFLogsEvent[]): number | undefined {
  const counts = new Map<number, number>()
  for (const e of events) {
    if (e.type === 'cast' && e.sourceID !== undefined) counts.set(e.sourceID, (counts.get(e.sourceID) ?? 0) + 1)
  }
  return [...counts].sort((a, b) => b[1] - a[1])[0]?.[0]
}

/** 某場戰鬥的 Boss 施放（找參考日誌時比對隨機機制用）。 */
export async function loadBossCasts(
  code: string,
  fight: Pick<Fight, 'id' | 'startTime' | 'endTime'>,
  signal?: AbortSignal,
): Promise<TimedCast[]> {
  const events = await fetchFightEvents(code, fight, { hostility: 'Enemies', dataType: 'Casts' }, signal)
  return toCasts(events, fight)
}

function toCasts(events: FFLogsEvent[], fight: Pick<Fight, 'startTime'>): TimedCast[] {
  // 詠唱技能另有 begincast 事件，只取實際施放的 cast
  return events
    .filter((e) => e.type === 'cast' && e.abilityGameID !== undefined)
    .map((e) => ({ t: toFightTime(e.timestamp, fight.startTime), abilityId: e.abilityGameID! }))
}

// begincast 與 cast 的最大間隔；超過視為不相關（例如詠唱被打斷後又重新施放）
const MAX_CAST_BAR_MS = 5000

// 普通攻擊（近戰 Attack、遠程 Shot）：全部事件中每場約 300 次，不是玩家操作的技能
export const AUTO_ATTACKS: ReadonlySet<number> = new Set([7, 8])

/** 玩家的普通攻擊（次數可反映是否離 Boss 太遠或停手）。 */
export function autoAttacks(events: FFLogsEvent[], fight: Fight, actorId: number): TimedCast[] {
  return events
    .filter((e) => e.type === 'cast' && e.sourceID === actorId && AUTO_ATTACKS.has(e.abilityGameID ?? -1))
    .map((e) => ({ t: toFightTime(e.timestamp, fight.startTime), abilityId: e.abilityGameID! }))
}

/**
 * 玩家的施放時間取「開始施放」的時間：有詠唱條的技能 FFLogs 的 cast 事件在詠唱結束時，
 * 因此以同技能前一個 begincast 取代。被打斷（只有 begincast 沒有 cast）的詠唱不計。
 */
export function playerCasts(events: FFLogsEvent[], fight: Fight, actorId?: number): TimedCast[] {
  const pending = new Map<number, number>()
  const casts: TimedCast[] = []
  for (const e of events) {
    if (e.abilityGameID === undefined || AUTO_ATTACKS.has(e.abilityGameID)) continue
    // 全部事件中也有別人對玩家施放的，只取玩家自己施放的
    if (actorId !== undefined && e.sourceID !== actorId) continue
    const t = toFightTime(e.timestamp, fight.startTime)
    if (e.type === 'begincast') {
      pending.set(e.abilityGameID, t)
    } else if (e.type === 'cast') {
      const begin = pending.get(e.abilityGameID)
      // 任何施放完成都代表先前未完成的詠唱已被取消（例如移動中斷）；
      // 不清掉的話，之後瞬發同一技能會配對到過期的 begincast，算出負的間隔
      pending.clear()
      casts.push({ t: begin !== undefined && t - begin <= MAX_CAST_BAR_MS ? begin : t, abilityId: e.abilityGameID })
    }
  }
  return casts
}

/** 有詠唱時間的技能讀條（戰鬥時間）；被打斷的詠唱標 interrupted。 */
export interface CastBar {
  abilityId: number
  start: number
  end: number
  interrupted: boolean
}

/**
 * 玩家的讀條：begincast 到同技能的 cast 為一條。詠唱中不能使用其他技能，因此在同技能 cast 之前
 * 出現別的施放或新的詠唱，代表原本的詠唱已被取消（移動等），以那個時間結束並標 interrupted；
 * 戰鬥結束時仍未完成的，以 begincast 的 duration（詠唱時間）結束。
 */
export function castBars(events: FFLogsEvent[], fight: Fight, actorId: number): CastBar[] {
  const bars: CastBar[] = []
  let pending: { abilityId: number; start: number; duration: number } | null = null
  for (const e of events) {
    if (e.sourceID !== actorId || e.abilityGameID === undefined || AUTO_ATTACKS.has(e.abilityGameID)) continue
    if (e.type !== 'begincast' && e.type !== 'cast') continue
    const t = toFightTime(e.timestamp, fight.startTime)
    if (pending) {
      const completed = e.type === 'cast' && e.abilityGameID === pending.abilityId && t - pending.start <= MAX_CAST_BAR_MS
      bars.push({ abilityId: pending.abilityId, start: pending.start, end: t, interrupted: !completed })
      pending = null
      if (completed) continue
    }
    if (e.type === 'begincast') {
      pending = { abilityId: e.abilityGameID, start: t, duration: typeof e.duration === 'number' ? e.duration : 0 }
    }
  }
  if (pending) bars.push({ abilityId: pending.abilityId, start: pending.start, end: pending.start + pending.duration, interrupted: true })
  return bars
}

export async function loadSide(selection: Selection, signal?: AbortSignal): Promise<SideData> {
  const { report, fight, player } = selection
  // 玩家取全部事件（約每 0.4 秒一筆位置），施放與位置都從中取得；只取施放時位置取樣太稀疏
  const [playerEvents, bossEvents] = await Promise.all([
    fetchFightEvents(report.code, fight, { sourceId: player.id, dataType: 'All' }, signal),
    fetchFightEvents(report.code, fight, { hostility: 'Enemies', dataType: 'Casts' }, signal),
  ])
  const boss = mainEnemy(bossEvents)
  return {
    selection,
    playerCasts: playerCasts(playerEvents, fight, player.id),
    autoAttacks: autoAttacks(playerEvents, fight, player.id),
    bossCasts: toCasts(bossEvents, fight),
    playerPositions: actorPositions(playerEvents, fight, player.id),
    bossPositions: boss === undefined ? [] : actorPositions(bossEvents, fight, boss),
    // 自身效果與施加在敵人身上的效果（效果 ID 不重複，放在一起供技能窗口使用）
    buffs: [...selfBuffWindows(playerEvents, fight, player.id), ...enemyDebuffWindows(playerEvents, fight, player.id)].sort(
      (a, b) => a.start - b.start,
    ),
    prepull: prepullEffects(playerEvents, player.id),
    auras: playerAuras(playerEvents, fight, player.id),
    hp: hpSamples(playerEvents, fight, player.id),
    castBars: castBars(playerEvents, fight, player.id),
    duration: fight.endTime - fight.startTime,
  }
}

/**
 * 只保留 endMs（該側自己的戰鬥時間）之前的資料。兩場戰鬥長度不同時，
 * 較長一方超出的部分沒有比較對象，不列入統計。
 */
export function clipSide(side: SideData, endMs: number): SideData {
  const before = <T extends { t: number }>(items: T[]) => items.filter((i) => i.t <= endMs)
  return {
    ...side,
    playerCasts: before(side.playerCasts),
    autoAttacks: before(side.autoAttacks),
    bossCasts: before(side.bossCasts),
    playerPositions: before(side.playerPositions),
    bossPositions: before(side.bossPositions),
    // 比較範圍外才開始的窗口不計；跨過結束點的窗口視為未結束（不評分）
    buffs: side.buffs
      .filter((b) => b.start <= endMs)
      .map((b) => (b.end > endMs ? { ...b, end: endMs, openEnded: true } : b)),
    duration: Math.min(side.duration, endMs),
  }
}

/** 移除不需紀錄的技能（例如坦克的挑釁、退避、坦姿開關），時間軸、技能次數與建議都不顯示。 */
export function withoutAbilities(side: SideData, drop: (abilityId: number) => boolean): SideData {
  return { ...side, playerCasts: side.playerCasts.filter((c) => !drop(c.abilityId)) }
}

/** 兩邊是否可比較；不行時回傳原因。 */
export function incompatibility(mine: Selection, ref: Selection): string | null {
  if (mine.fight.encounterID !== ref.fight.encounterID) {
    return `兩場戰鬥不是同一個 Boss（${mine.fight.name} / ${ref.fight.name}）`
  }
  if (mine.player.subType !== ref.player.subType) {
    return `兩位玩家的職業不同（${jobName(mine.player.subType)} / ${jobName(ref.player.subType)}），目前只支援同職業比較`
  }
  return null
}
