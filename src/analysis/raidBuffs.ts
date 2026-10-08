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
}

/** 團隊 Buff 的顯示名稱：以時段中的效果 ID 查繁中名稱；查不到時沿用英文 */
export function raidBuffLabel(windows: RaidBuffWindow[], abilityName: (id: number) => string | undefined): (name: string) => string {
  const ids = new Map(windows.map((w) => [w.name, w.statusId]))
  return (name) => {
    const id = ids.get(name)
    return (id === undefined ? undefined : abilityName(id)) ?? name
  }
}

// 爆發點之後這麼久內開始的團隊 Buff 也算「當時」：爆發技能常在團隊 Buff 前一兩個 GCD 先開（例如武士開場的意氣衝天），
// 團隊 Buff 也在幾個 GCD 內陸續生效
export const ACTIVE_WINDOW_MS = 5000
// 一個 GCD 內連續按下的爆發技能算同一波
const SAME_BURST_MS = 2500
// 爆發點前後這麼久內「最多同時有幾個」團隊 Buff，當作這次本來可以對上的數量
export const LOOKAROUND_MS = 20_000

/**
 * 我身上的團隊 Buff 與敵人身上的團隊 Debuff，依名稱合併成時段。
 * @param auras 我身上的效果（見 buffs.ts 的 playerAuras）
 * @param enemyDebuffs 敵人身上的效果時段（見 enemyRaidDebuffs）
 * @param englishName 效果 ID 的英文名稱（FFLogs 報告的名稱）
 */
export function raidBuffWindows(
  auras: { statusId: number; start: number; end: number }[],
  enemyDebuffs: { statusId: number; start: number; end: number }[],
  englishName: (statusId: number) => string | undefined,
): RaidBuffWindow[] {
  const byName = new Map<string, { start: number; end: number }[]>()
  const statusIds = new Map<string, number>()
  for (const a of [...auras, ...enemyDebuffs]) {
    const name = englishName(a.statusId)
    if (!name || !RAID_BUFFS.has(name)) continue
    byName.set(name, [...(byName.get(name) ?? []), { start: a.start, end: a.end }])
    if (!statusIds.has(name)) statusIds.set(name, a.statusId)
  }
  const windows: RaidBuffWindow[] = []
  for (const [name, spans] of byName) {
    spans.sort((a, b) => a.start - b.start)
    let current: { start: number; end: number } | null = null
    for (const s of spans) {
      if (current && s.start <= current.end) current.end = Math.max(current.end, s.end)
      else {
        if (current) windows.push({ name, statusId: statusIds.get(name)!, ...current })
        current = { ...s }
      }
    }
    if (current) windows.push({ name, statusId: statusIds.get(name)!, ...current })
  }
  return windows.sort((a, b) => a.start - b.start)
}

/**
 * 敵人身上的效果時段（任一個敵人有就算；多個敵人的時段合併），從「Debuffs、Enemies」的事件取得。
 * 只用來找團隊 Debuff（連環計、介毒之術），不限施加者。
 */
export function enemyRaidDebuffs(events: FFLogsEvent[], fight: Fight): { statusId: number; start: number; end: number }[] {
  const duration = fight.endTime - fight.startTime
  const open = new Map<string, number>()
  const spans: { statusId: number; start: number; end: number }[] = []
  for (const e of [...events].sort((a, b) => a.timestamp - b.timestamp)) {
    if (e.abilityGameID === undefined) continue
    const key = `${e.abilityGameID}|${e.targetID}`
    const t = toFightTime(e.timestamp, fight.startTime)
    if (e.type === 'applydebuff' || e.type === 'refreshdebuff') {
      if (!open.has(key)) open.set(key, t)
    } else if (e.type === 'removedebuff') {
      const start = open.get(key)
      if (start === undefined) continue
      open.delete(key)
      spans.push({ statusId: e.abilityGameID, start, end: t })
    }
  }
  for (const [key, start] of open) spans.push({ statusId: Number(key.split('|')[0]), start, end: duration })
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

/** 一個爆發點（我的時間）與當時的團隊 Buff */
export interface BurstAlignment {
  t: number
  /** 這波爆發用的技能（一個 GCD 內連續按下的算同一波） */
  abilityIds: number[]
  /** 這一波（到最後一個技能後 ACTIVE_WINDOW_MS）內最多同時有幾個團隊 Buff（「當時」） */
  active: number
  /** 「當時」的團隊 Buff 名稱 */
  activeNames: string[]
  /** 前後 20 秒內最多同時有幾個（這次本來可以對上的數量） */
  available: number
  /** 對上：當時 ≥ 可對上數量的一半，或那一波團隊 Buff 在使用後 ACTIVE_WINDOW_MS 內開始；附近沒有團隊 Buff 時為 null（不評） */
  aligned: boolean | null
  /** 沒有全部對上時，與團隊 Buff 最多的時間點相差多久（正數＝晚用、負數＝早用）；全部對上時為 null */
  offsetMs: number | null
}

/** 每個爆發點與團隊 Buff 的對齊情形 */
export function burstAlignment(bursts: BurstPoint[], windows: RaidBuffWindow[]): BurstAlignment[] {
  return bursts.map(({ t, end, abilityIds }) => {
    // 一整波（從第一個到最後一個技能之後 ACTIVE_WINDOW_MS）內最多同時有幾個
    const now = peak(windows, t, end + ACTIVE_WINDOW_MS)
    const around = peak(windows, t - LOOKAROUND_MS, t + LOOKAROUND_MS)
    const activeNames = raidBuffsAt(windows, now.point)
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
      aligned: available === 0 ? null : now.count * 2 >= available || earlyOk,
      offsetMs,
    }
  })
}

/**
 * 爆發點：輸出類、冷卻 60 秒以上的冷卻技（見 cooldowns.ts 的 isNonOffensiveCooldown）每次使用，以及強化藥（爆發藥）。
 * 依時間排序；一個 GCD 內連續按下的、或在附帶效果持續期間內用的算同一波爆發（時間取第一個）。
 */
export interface BurstPoint {
  t: number
  /** 這一波最後一個技能的時間（只有一個時與 t 相同） */
  end: number
  abilityIds: number[]
}

/**
 * @param buffEnd 爆發技能附帶的自身效果（例如戰逃反應、強化藥）的結束時間；沒有時 undefined。
 *   與 xivanalysis 的 BuffWindow 相同：效果持續期間內用的爆發技能算同一波
 */
export function burstPoints(
  casts: { t: number; abilityId: number }[],
  isBurst: (abilityId: number) => boolean,
  buffEnd: (abilityId: number, t: number) => number | undefined = () => undefined,
): BurstPoint[] {
  const points: BurstPoint[] = []
  // 目前這一波可以接續到的時間：最後一個技能後一個 GCD，或附帶效果結束
  let until = -Infinity
  for (const c of casts.filter((x) => isBurst(x.abilityId)).sort((a, b) => a.t - b.t)) {
    const current = points.at(-1)
    if (current && c.t <= until) {
      if (!current.abilityIds.includes(c.abilityId)) current.abilityIds.push(c.abilityId)
      current.end = c.t
    } else points.push({ t: c.t, end: c.t, abilityIds: [c.abilityId] })
    until = Math.max(until, c.t + SAME_BURST_MS, buffEnd(c.abilityId, c.t) ?? -Infinity)
  }
  return points
}
