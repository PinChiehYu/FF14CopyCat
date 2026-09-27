// Boss 強制控場：敵人施加在玩家身上、期間無法施放的 debuff（例如熱舞綠光的「完美收尾」）。
// 遊戲資料沒有「控場」的分類，名稱也看不出來，因此由日誌判斷：在兩份日誌的每一次期間內，
// 玩家都沒有開始任何 GCD 的 debuff 就是控場。
import type { BuffWindow } from './buffs'
import type { LostWindow } from './metrics'

// 控場期間的長度範圍：太短的看不出是否停手；太長的（例如整段轉場都掛著）多半只是剛好沒有攻擊目標
const MIN_CONTROL_MS = 1000
const MAX_CONTROL_MS = 10_000
// debuff 施加後這麼短的時間內開始的 GCD 視為施加前就已開始（不算在期間內施放）
const GRACE_MS = 300

export interface ControlSide {
  /** 敵人施加在玩家身上的 debuff（見 debuffsOnPlayer） */
  debuffs: BuffWindow[]
  /** 玩家開始施放 GCD 的時間 */
  gcds: number[]
}

/** 兩份日誌都符合「每次期間都沒有開始 GCD」的 debuff（效果 ID）。 */
export function controlStatuses(sides: ControlSide[]): Set<number> {
  const ok = new Map<number, boolean>()
  for (const side of sides) {
    for (const d of side.debuffs) {
      const length = d.end - d.start
      const idle =
        !d.openEnded &&
        length >= MIN_CONTROL_MS &&
        length <= MAX_CONTROL_MS &&
        !side.gcds.some((t) => t > d.start + GRACE_MS && t < d.end)
      ok.set(d.statusId, (ok.get(d.statusId) ?? true) && idle)
    }
  }
  return new Set([...ok].filter(([, idle]) => idle).map(([id]) => id))
}

export interface ControlWindow {
  start: number
  end: number
  /** 這段期間的控場 debuff（同時施加的多個效果合併成一段） */
  statusIds: number[]
}

/** 一側的控場時段（重疊的合併）。 */
export function controlWindows(debuffs: BuffWindow[], statuses: Set<number>): ControlWindow[] {
  const out: ControlWindow[] = []
  for (const d of debuffs.filter((b) => statuses.has(b.statusId)).sort((a, b) => a.start - b.start)) {
    const last = out.at(-1)
    if (last && d.start <= last.end) {
      last.end = Math.max(last.end, d.end)
      if (!last.statusIds.includes(d.statusId)) last.statusIds.push(d.statusId)
    } else {
      out.push({ start: d.start, end: d.end, statusIds: [d.statusId] })
    }
  }
  return out
}

/** 標示少打 GCD 的時段中，我身上有控場的（控場與停手區間重疊至少 1 秒）。 */
export function attachControl(lost: LostWindow[], mineControl: ControlWindow[]): LostWindow[] {
  return lost.map((w) => {
    const hits = mineControl.filter((c) => Math.min(c.end, w.mineEnd) - Math.max(c.start, w.mineStart) >= MIN_CONTROL_MS)
    return hits.length === 0 ? w : { ...w, control: [...new Set(hits.flatMap((c) => c.statusIds))] }
  })
}
/** 控場效果的顯示名稱；control 已去掉無名稱的效果，全部都沒有名稱時為空陣列，顯示「無名稱效果」。 */
export function controlNames(ids: number[], abilityName: (id: number) => string): string {
  return ids.length > 0 ? [...new Set(ids.map(abilityName))].join('、') : '無名稱效果'
}