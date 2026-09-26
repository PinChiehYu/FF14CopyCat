import type { FFLogsEvent, Fight } from '../fflogs/types'
import { toFightTime } from './timeline'

/** 玩家自己給自己的效果（Buff）持續的時段（戰鬥時間）。 */
export interface BuffWindow {
  /** FFLogs 的效果 ID（遊戲狀態 ID＋1,000,000） */
  statusId: number
  start: number
  end: number
  /** 開打前就已存在（開打當下的狀態紀錄有這個效果） */
  prepull: boolean
  /** 到戰鬥結束都沒有移除 */
  openEnded: boolean
}

interface Aura {
  source?: number
  ability?: number
}

/**
 * 開打當下（0:00 的 combatantinfo）玩家自己施加、身上已有的效果 ID。
 * FFLogs 不提供開打前的施放事件，只能從這裡推知開打前用過的技能（例如武士的明鏡止水、騎士的坦姿）。
 */
export function prepullEffects(events: FFLogsEvent[], actorId: number): number[] {
  const info = events.find((e) => e.type === 'combatantinfo' && e.sourceID === actorId)
  const auras = (info?.auras as Aura[] | undefined) ?? []
  return [...new Set(auras.filter((a) => a.source === actorId && a.ability !== undefined).map((a) => a.ability!))]
}

/**
 * 玩家自己給自己的效果時段：applybuff 開始、removebuff 結束；開打前已有的效果從 0:00 開始，
 * 到戰鬥結束仍未移除的以戰鬥結束收尾。
 */
export function selfBuffWindows(events: FFLogsEvent[], fight: Fight, actorId: number): BuffWindow[] {
  const duration = fight.endTime - fight.startTime
  const open = new Map<number, { start: number; prepull: boolean }>()
  for (const id of prepullEffects(events, actorId)) open.set(id, { start: 0, prepull: true })
  const windows: BuffWindow[] = []
  for (const e of events) {
    if (e.sourceID !== actorId || e.targetID !== actorId || e.abilityGameID === undefined) continue
    const t = toFightTime(e.timestamp, fight.startTime)
    if (e.type === 'applybuff') {
      // 重複施加（刷新）視為同一段
      if (!open.has(e.abilityGameID)) open.set(e.abilityGameID, { start: t, prepull: false })
    } else if (e.type === 'removebuff') {
      const started = open.get(e.abilityGameID)
      if (!started) continue
      open.delete(e.abilityGameID)
      windows.push({ statusId: e.abilityGameID, start: started.start, end: t, prepull: started.prepull, openEnded: false })
    }
  }
  for (const [statusId, started] of open) {
    windows.push({ statusId, start: started.start, end: duration, prepull: started.prepull, openEnded: true })
  }
  return windows.sort((a, b) => a.start - b.start)
}
