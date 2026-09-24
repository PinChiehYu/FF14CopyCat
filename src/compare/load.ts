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

export async function loadSide(selection: Selection, signal?: AbortSignal): Promise<SideData> {
  const { report, fight, player } = selection
  const [playerEvents, bossEvents] = await Promise.all([
    fetchFightEvents(report.code, fight, { sourceId: player.id, dataType: 'Casts' }, signal),
    fetchFightEvents(report.code, fight, { hostility: 'Enemies', dataType: 'Casts' }, signal),
  ])
  return {
    selection,
    playerCasts: toCasts(playerEvents, fight),
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
