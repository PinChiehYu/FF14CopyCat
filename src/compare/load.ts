import type { TimedCast } from '../analysis/alignment'
import { toFightTime } from '../analysis/timeline'
import { fetchFightEvents } from '../fflogs/client'
import type { Actor, FFLogsEvent, Fight, Report } from '../fflogs/types'

export interface Selection {
  report: Report
  fight: Fight
  player: Actor
}

export interface SideData {
  selection: Selection
  playerCasts: TimedCast[]
  bossCasts: TimedCast[]
  /** 戰鬥長度（毫秒） */
  duration: number
}

function toCasts(events: FFLogsEvent[], fight: Fight): TimedCast[] {
  // 詠唱技能另有 begincast 事件，只取實際施放的 cast
  return events
    .filter((e) => e.type === 'cast' && e.abilityGameID !== undefined)
    .map((e) => ({ t: toFightTime(e.timestamp, fight.startTime), abilityId: e.abilityGameID! }))
}

// begincast 與 cast 的最大間隔；超過視為不相關（例如詠唱被打斷後又重新施放）
const MAX_CAST_BAR_MS = 5000

/**
 * 玩家的施放時間取「開始施放」的時間：有詠唱條的技能 FFLogs 的 cast 事件在詠唱結束時，
 * 因此以同技能前一個 begincast 取代。被打斷（只有 begincast 沒有 cast）的詠唱不計。
 */
export function playerCasts(events: FFLogsEvent[], fight: Fight): TimedCast[] {
  const pending = new Map<number, number>()
  const casts: TimedCast[] = []
  for (const e of events) {
    if (e.abilityGameID === undefined) continue
    const t = toFightTime(e.timestamp, fight.startTime)
    if (e.type === 'begincast') {
      pending.set(e.abilityGameID, t)
    } else if (e.type === 'cast') {
      const begin = pending.get(e.abilityGameID)
      pending.delete(e.abilityGameID)
      casts.push({ t: begin !== undefined && t - begin <= MAX_CAST_BAR_MS ? begin : t, abilityId: e.abilityGameID })
    }
  }
  return casts
}

export async function loadSide(selection: Selection, signal?: AbortSignal): Promise<SideData> {
  const { report, fight, player } = selection
  const [playerEvents, bossEvents] = await Promise.all([
    fetchFightEvents(report.code, fight, { sourceId: player.id, dataType: 'Casts' }, signal),
    fetchFightEvents(report.code, fight, { hostility: 'Enemies', dataType: 'Casts' }, signal),
  ])
  return {
    selection,
    playerCasts: playerCasts(playerEvents, fight),
    bossCasts: toCasts(bossEvents, fight),
    duration: fight.endTime - fight.startTime,
  }
}

/** 兩邊是否可比較；不行時回傳原因。 */
export function incompatibility(mine: Selection, ref: Selection): string | null {
  if (mine.fight.encounterID !== ref.fight.encounterID) {
    return `兩場戰鬥不是同一個 Boss（${mine.fight.name} / ${ref.fight.name}）`
  }
  if (mine.player.subType !== ref.player.subType) {
    return `兩位玩家的職業不同（${mine.player.subType} / ${ref.player.subType}），目前只支援同職業比較`
  }
  return null
}
