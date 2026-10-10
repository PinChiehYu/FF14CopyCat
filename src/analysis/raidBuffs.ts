import type { FFLogsEvent, Fight } from '../fflogs/types'
import { toFightTime } from './timeline'

/**
 * 團隊 Buff（英文名稱；依名稱比對，同名的不同效果 ID 視為同一個，例如赤魔的鼓勵自己與隊友是不同 ID）：
 * 施加在隊友身上的增傷，以及連環計、介毒之術這兩個施加在敵人身上的（敵人身上的另外查詢）。
 */
export const RAID_BUFF_NAMES: readonly string[] = [
  'Battle Litany',
  'Divination',
  'Technical Finish',
  'Brotherhood',
  'Searing Light',
  'Arcane Circle',
  'Embolden',
  'Radiant Finale',
  'Battle Voice',
  'Starry Muse',
  'Chain Stratagem',
  'Dokumori',
]
const RAID_BUFFS = new Set(RAID_BUFF_NAMES)

/** 一個團隊 Buff 的時段（我的戰鬥時間）；同名的重疊時段已合併 */
export interface RaidBuffWindow {
  /** 英文名稱（判斷與合併用） */
  name: string
  /** 其中一個效果 ID（查繁中名稱用，見 raidBuffLabel） */
  statusId: number
  start: number
  end: number
  /** 我自己給的（判斷爆發是否對上時不算，見 burstAlignment） */
  self?: boolean
}

/** 團隊 Buff 的顯示名稱：以時段中的效果 ID 查繁中名稱；查不到時沿用英文 */
export function raidBuffLabel(windows: RaidBuffWindow[], abilityName: (id: number) => string | undefined): (name: string) => string {
  const ids = new Map(windows.map((w) => [w.name, w.statusId]))
  return (name) => {
    const id = ids.get(name)
    return (id === undefined ? undefined : abilityName(id)) ?? name
  }
}

/**
 * 團隊 Buff 的技能（顯示圖示用）：在報告的技能清單中找英文名稱相同的技能（不含效果與道具）；
 * 技能名稱與效果不同時取名稱以效果名稱結尾的（例如效果 Technical Finish 的技能是 Quadruple Technical Finish），多個時取 ID 最小的。
 */
export function raidBuffAction<T extends { gameID: number; name: string; englishName?: string }>(abilities: Map<number, T>): (name: string) => T | undefined {
  const actions = [...abilities.values()].filter((a) => a.gameID < 1_000_000).sort((a, b) => a.gameID - b.gameID)
  const byName = new Map<string, T>()
  for (const name of RAID_BUFF_NAMES) {
    const english = (a: T) => a.englishName ?? a.name
    const found = actions.find((a) => english(a) === name) ?? actions.find((a) => english(a).endsWith(` ${name}`))
    if (found) byName.set(name, found)
  }
  return (name) => byName.get(name)
}

// 一波爆發之後這麼久內開始的團隊 Buff 也算「當時」：團隊 Buff 在幾個 GCD 內陸續生效
export const ACTIVE_WINDOW_MS = 5000
// 相鄰的爆發技相隔這麼久以內算同一波：準備動作與之後的爆發技常相隔十幾秒
// （例如武士必殺劍・紅蓮→意氣衝天 7 秒、機工士野火前後的技能 10＋5 秒）；60／120 秒的兩波相隔約 60 秒，不會併在一起
export const SAME_BURST_MS = 15_000

/**
 * 找「這次本來可以對上」的那一輪團隊 Buff 時看前後多久：2 分鐘爆發看前後 60 秒（每次都要對上，離得遠也要找到那一輪），
 * 1 分鐘爆發看前後 20 秒（兩輪團隊 Buff 之間的那次附近沒有團隊 Buff，不評）
 */
export function lookaroundMs(periodMs: number): number {
  return periodMs >= 120_000 ? 60_000 : 20_000
}

/**
 * 我身上的團隊 Buff 與敵人身上的團隊 Debuff，依名稱（與是否為我自己給的）合併成時段。
 * @param auras 我身上的效果（見 buffs.ts 的 playerAuras）
 * @param enemyDebuffs 敵人身上的效果時段（見 enemyRaidDebuffs）
 * @param englishName 效果 ID 的英文名稱（FFLogs 報告的名稱）
 * @param selfId 我的角色 ID：我施放的團隊 Buff 標為 self（判斷爆發是否對上時只看隊友的）
 */
export function raidBuffWindows(
  auras: { statusId: number; start: number; end: number; sourceId?: number }[],
  enemyDebuffs: { statusId: number; start: number; end: number; sourceId?: number }[],
  englishName: (statusId: number) => string | undefined,
  selfId?: number,
): RaidBuffWindow[] {
  const byKey = new Map<string, { name: string; self: boolean; spans: { start: number; end: number }[] }>()
  const statusIds = new Map<string, number>()
  for (const a of [...auras, ...enemyDebuffs]) {
    const name = englishName(a.statusId)
    if (!name || !RAID_BUFFS.has(name)) continue
    const self = selfId !== undefined && a.sourceId === selfId
    const key = `${name}|${self}`
    const group = byKey.get(key) ?? { name, self, spans: [] }
    group.spans.push({ start: a.start, end: a.end })
    byKey.set(key, group)
    if (!statusIds.has(name)) statusIds.set(name, a.statusId)
  }
  const windows: RaidBuffWindow[] = []
  for (const { name, self, spans } of byKey.values()) {
    const push = (s: { start: number; end: number }) => windows.push({ name, statusId: statusIds.get(name)!, ...s, ...(self ? { self } : {}) })
    spans.sort((a, b) => a.start - b.start)
    let current: { start: number; end: number } | null = null
    for (const s of spans) {
      if (current && s.start <= current.end) current.end = Math.max(current.end, s.end)
      else {
        if (current) push(current)
        current = { ...s }
      }
    }
    if (current) push(current)
  }
  return windows.sort((a, b) => a.start - b.start)
}

/**
 * 敵人身上的效果時段（任一個敵人有就算；多個敵人的時段合併），從「Debuffs、Enemies」的事件取得。
 * 只用來找團隊 Debuff（連環計、介毒之術）；保留施加者，判斷爆發時排除我自己給的。
 */
export function enemyRaidDebuffs(events: FFLogsEvent[], fight: Fight): { statusId: number; start: number; end: number; sourceId?: number }[] {
  const duration = fight.endTime - fight.startTime
  const open = new Map<string, { start: number; sourceId?: number }>()
  const spans: { statusId: number; start: number; end: number; sourceId?: number }[] = []
  const span = (statusId: number, start: number, end: number, sourceId?: number) =>
    spans.push({ statusId, start, end, ...(sourceId === undefined ? {} : { sourceId }) })
  for (const e of [...events].sort((a, b) => a.timestamp - b.timestamp)) {
    if (e.abilityGameID === undefined) continue
    const key = `${e.abilityGameID}|${e.targetID}|${e.sourceID}`
    const t = toFightTime(e.timestamp, fight.startTime)
    if (e.type === 'applydebuff' || e.type === 'refreshdebuff') {
      if (!open.has(key)) open.set(key, { start: t, sourceId: e.sourceID })
    } else if (e.type === 'removedebuff') {
      const opened = open.get(key)
      if (opened === undefined) continue
      open.delete(key)
      span(e.abilityGameID, opened.start, t, opened.sourceId)
    }
  }
  for (const [key, { start, sourceId }] of open) span(Number(key.split('|')[0]), start, duration, sourceId)
  return spans
}

/** 某個時間點有效的團隊 Buff 名稱 */
export function raidBuffsAt(windows: RaidBuffWindow[], t: number): string[] {
  return [...new Set(windows.filter((w) => w.start <= t && t < w.end).map((w) => w.name))]
}

/** 一段時間內同時有效的團隊 Buff 最多幾個；at 為那一波團隊 Buff 中最早開始的時間（可能在區間之前） */
function peak(windows: RaidBuffWindow[], from: number, to: number): { count: number; at: number; point: number } {
  // 數量只在某個時段開始時增加：檢查區間起點與區間內每個時段的起點
  const points = [from, ...windows.map((w) => w.start).filter((s) => s > from && s <= to)].sort((a, b) => a - b)
  let best = { count: 0, at: from, point: from }
  for (const p of points) {
    const count = raidBuffsAt(windows, p).length
    if (count > best.count) {
      const active = windows.filter((w) => w.start <= p && p < w.end)
      best = { count, at: Math.min(...active.map((w) => w.start)), point: p }
    }
  }
  return best
}

/** 一個爆發點（我的時間）與當時的團隊 Buff；團隊 Buff 只算隊友給的（自己給的一定對上，不算） */
export interface BurstAlignment {
  /** 判斷用的時間（見 BurstPoint.t） */
  t: number
  /** 這波爆發用的技能 */
  abilityIds: number[]
  /** 這一波（第一個技能到最後一個技能後 ACTIVE_WINDOW_MS）內最多同時有幾個團隊 Buff（「當時」） */
  active: number
  /** 「當時」的團隊 Buff 名稱 */
  activeNames: string[]
  /** 前後（lookaroundMs）內最多同時有幾個（這次本來可以對上的數量） */
  available: number
  /** 附近有、但「當時」沒有的團隊 Buff 名稱（前後最多的那個時間點） */
  missedNames: string[]
  /** 對上：當時 ≥ 可對上數量的一半，或那一波團隊 Buff 在使用後 ACTIVE_WINDOW_MS 內開始；附近沒有團隊 Buff 時為 null（不評） */
  aligned: boolean | null
  /** 沒有全部對上時，與團隊 Buff 最多的時間點相差多久（正數＝晚用、負數＝早用）；全部對上時為 null */
  offsetMs: number | null
}

/** 每個爆發點與隊友的團隊 Buff 的對齊情形 */
export function burstAlignment(bursts: BurstPoint[], windows: RaidBuffWindow[]): BurstAlignment[] {
  const others = windows.filter((w) => !w.self)
  return bursts.map(({ t, start, end, abilityIds, periodMs }) => {
    // 一整波（從第一個技能到最後一個技能之後 ACTIVE_WINDOW_MS）內最多同時有幾個：準備動作在團隊 Buff 前幾秒用也算當時
    const now = peak(others, start, end + ACTIVE_WINDOW_MS)
    const range = lookaroundMs(periodMs)
    const around = peak(others, t - range, t + range)
    const activeNames = raidBuffsAt(others, now.point)
    const available = Math.max(around.count, now.count)
    const offsetMs = now.count >= available ? null : t - around.at
    // 團隊 Buff 陸續生效：那一波在使用後 ACTIVE_WINDOW_MS 內開始的，提早先開也算對上
    const earlyOk = offsetMs !== null && offsetMs < 0 && -offsetMs <= ACTIVE_WINDOW_MS
    return {
      t,
      abilityIds,
      active: now.count,
      activeNames,
      available,
      missedNames: around.count > now.count ? raidBuffsAt(others, around.point).filter((n) => !activeNames.includes(n)) : [],
      aligned: available === 0 ? null : now.count * 2 >= available || earlyOk,
      offsetMs,
    }
  })
}

/** 一波爆發：職業的爆發技（見 jobs/burstRules.ts）與強化藥，相隔 SAME_BURST_MS 以內的連續使用算同一波 */
export interface BurstPoint {
  /** 判斷用的時間：這一波的第一個技能；有技能設定 alignAt（例如蝰蛇蛇靈氣→祖靈降臨）時為那個之後的技能的使用時間 */
  t: number
  /** 這一波第一個技能的時間 */
  start: number
  /** 這一波最後一個技能（或 alignAt 的技能）的時間 */
  end: number
  abilityIds: number[]
  /** 這一波的週期：有 2 分鐘爆發技（或強化藥）就是 120 秒，否則 60 秒（見 lookaroundMs） */
  periodMs: number
}

/**
 * @param buffEnd 爆發技能附帶的自身效果（例如戰逃反應、強化藥）的結束時間；沒有時 undefined。
 *   效果持續期間內用的爆發技能算同一波（與 xivanalysis 的 BuffWindow 相同）
 * @param periodOf 技能的爆發週期（毫秒），預設 60 秒
 * @param alignTime 技能設定了 alignAt 時，回傳之後那個技能的使用時間；沒有時回傳 undefined
 */
export function burstPoints(
  casts: { t: number; abilityId: number }[],
  isBurst: (abilityId: number) => boolean,
  buffEnd: (abilityId: number, t: number) => number | undefined = () => undefined,
  { periodOf = () => 60_000, alignTime = () => undefined }: { periodOf?: (abilityId: number) => number; alignTime?: (abilityId: number, t: number) => number | undefined } = {},
): BurstPoint[] {
  const points: BurstPoint[] = []
  // 目前這一波可以接續到的時間：最後一個技能後 SAME_BURST_MS，或附帶效果結束
  let until = -Infinity
  for (const c of casts.filter((x) => isBurst(x.abilityId)).sort((a, b) => a.t - b.t)) {
    let current = points.at(-1)
    if (!current || c.t > until) {
      current = { t: c.t, start: c.t, end: c.t, abilityIds: [], periodMs: 0 }
      points.push(current)
    }
    if (!current.abilityIds.includes(c.abilityId)) current.abilityIds.push(c.abilityId)
    current.end = Math.max(current.end, c.t)
    current.periodMs = Math.max(current.periodMs, periodOf(c.abilityId))
    const aligned = alignTime(c.abilityId, c.t)
    if (aligned !== undefined) {
      // 以之後的技能判斷：取這一波中最早的
      current.t = current.t === current.start ? aligned : Math.min(current.t, aligned)
      current.end = Math.max(current.end, aligned)
    }
    until = Math.max(until, c.t + SAME_BURST_MS, buffEnd(c.abilityId, c.t) ?? -Infinity)
  }
  return points
}
