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

/** combatantinfo.auras 的一筆：開打當下身上的效果 */
interface CombatantAura {
  source?: number
  ability?: number
}

/**
 * 開打當下（0:00 的 combatantinfo）玩家自己施加、身上已有的效果 ID。
 * FFLogs 不提供開打前的施放事件，只能從這裡推知開打前用過的技能（例如武士的明鏡止水、騎士的坦姿）。
 */
export function prepullEffects(events: FFLogsEvent[], actorId: number): number[] {
  const info = events.find((e) => e.type === 'combatantinfo' && e.sourceID === actorId)
  const auras = (info?.auras as CombatantAura[] | undefined) ?? []
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

/** 玩家身上的效果（任何來源）：當下狀態面板用。 */
export interface Aura {
  statusId: number
  /** 施加者（可能是玩家自己、隊友或敵人） */
  sourceId: number
  start: number
  end: number
  debuff: boolean
}

/**
 * 玩家身上所有效果的時段：自己、隊友給的 Buff 與敵人給的 Debuff。開打當下已有的（combatantinfo.auras）從 0:00 起算，
 * 到戰鬥結束仍在的以戰鬥結束收尾。同一效果、同一施加者重複施加（刷新）視為同一段。
 */
export function playerAuras(events: FFLogsEvent[], fight: Fight, actorId: number): Aura[] {
  const duration = fight.endTime - fight.startTime
  const open = new Map<string, { statusId: number; sourceId: number; start: number; debuff: boolean }>()
  const info = events.find((e) => e.type === 'combatantinfo' && e.sourceID === actorId)
  for (const a of (info?.auras as CombatantAura[] | undefined) ?? []) {
    if (a.ability === undefined || a.source === undefined) continue
    open.set(`${a.ability}|${a.source}`, { statusId: a.ability, sourceId: a.source, start: 0, debuff: false })
  }
  const auras: Aura[] = []
  for (const e of events) {
    if (e.targetID !== actorId || e.abilityGameID === undefined || e.sourceID === undefined) continue
    const key = `${e.abilityGameID}|${e.sourceID}`
    const t = toFightTime(e.timestamp, fight.startTime)
    if (e.type === 'applybuff' || e.type === 'applydebuff') {
      if (!open.has(key)) open.set(key, { statusId: e.abilityGameID, sourceId: e.sourceID, start: t, debuff: e.type === 'applydebuff' })
    } else if (e.type === 'removebuff' || e.type === 'removedebuff') {
      const started = open.get(key)
      if (!started) continue
      open.delete(key)
      auras.push({ ...started, end: t })
    }
  }
  for (const started of open.values()) auras.push({ ...started, end: duration })
  return auras.sort((a, b) => a.start - b.start)
}

/** 某個時間點身上的效果。 */
export function aurasAt(auras: Aura[], t: number): Aura[] {
  return auras.filter((a) => a.start <= t && t < a.end)
}

/** 血量取樣（戰鬥時間）。 */
export interface HpSample {
  t: number
  hp: number
  maxHp: number
  /** 護盾（FFLogs 以最大血量的百分比表示） */
  absorb: number
}

interface HpResources {
  hitPoints?: number
  maxHitPoints?: number
  absorb?: number
}

/** 從事件的 source／targetResources 取出玩家的血量，依時間排序。 */
export function hpSamples(events: FFLogsEvent[], fight: Fight, actorId: number): HpSample[] {
  const samples: HpSample[] = []
  for (const e of events) {
    const res = (e.sourceID === actorId ? e.sourceResources : e.targetID === actorId ? e.targetResources : undefined) as
      | HpResources
      | undefined
    if (res?.hitPoints === undefined || !res.maxHitPoints) continue
    samples.push({ t: toFightTime(e.timestamp, fight.startTime), hp: res.hitPoints, maxHp: res.maxHitPoints, absorb: res.absorb ?? 0 })
  }
  return samples.sort((a, b) => a.t - b.t)
}

/** 某個時間點（含之前最近一次取樣）的血量。 */
export function hpAt(samples: HpSample[], t: number): HpSample | undefined {
  let lo = 0
  let hi = samples.length - 1
  let found: HpSample | undefined
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (samples[mid].t <= t) {
      found = samples[mid]
      lo = mid + 1
    } else {
      hi = mid - 1
    }
  }
  return found
}

/**
 * 玩家施加在敵人身上的效果（例如忍者的毒盛、攻擊力降低類的減益）時段。
 * 同一效果可能同時掛在多個敵人身上（範圍技能），同一效果重疊的時段合併成一段。
 */
export function enemyDebuffWindows(events: FFLogsEvent[], fight: Fight, actorId: number): BuffWindow[] {
  const duration = fight.endTime - fight.startTime
  const open = new Map<string, { statusId: number; start: number }>()
  const raw: BuffWindow[] = []
  for (const e of events) {
    if (e.sourceID !== actorId || e.targetID === undefined || e.targetID === actorId || e.abilityGameID === undefined) continue
    const key = `${e.abilityGameID}|${e.targetID}`
    const t = toFightTime(e.timestamp, fight.startTime)
    if (e.type === 'applydebuff') {
      if (!open.has(key)) open.set(key, { statusId: e.abilityGameID, start: t })
    } else if (e.type === 'removedebuff') {
      const started = open.get(key)
      if (!started) continue
      open.delete(key)
      raw.push({ statusId: started.statusId, start: started.start, end: t, prepull: false, openEnded: false })
    }
  }
  for (const started of open.values()) {
    raw.push({ statusId: started.statusId, start: started.start, end: duration, prepull: false, openEnded: true })
  }
  // 合併同一效果重疊的時段
  const merged: BuffWindow[] = []
  for (const w of raw.sort((a, b) => a.statusId - b.statusId || a.start - b.start)) {
    const last = merged.at(-1)
    if (last && last.statusId === w.statusId && w.start <= last.end) {
      if (w.end > last.end) {
        last.end = w.end
        last.openEnded = w.openEnded
      }
    } else {
      merged.push({ ...w })
    }
  }
  return merged.sort((a, b) => a.start - b.start)
}
