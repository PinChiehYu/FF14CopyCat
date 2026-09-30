// 預處理資料（Worker 存進 D1、前端讀取）的施放編碼：依時間排序，每筆「技能 ID.時間差」以 36 進位表示、空白分隔；
// 時間以 10 毫秒為單位（對齊與機制比對的容許誤差都以秒計，10 毫秒不影響結果）。
// Worker 與前端共用（不依賴 DOM）。

export interface EncodedCast {
  /** 戰鬥時間（毫秒） */
  t: number
  abilityId: number
}

const TICK_MS = 10

export function encodeCasts(casts: EncodedCast[]): string {
  let last = 0
  return [...casts]
    .sort((a, b) => a.t - b.t)
    .map((c) => {
      const tick = Math.round(c.t / TICK_MS)
      const token = `${c.abilityId.toString(36)}.${(tick - last).toString(36)}`
      last = tick
      return token
    })
    .join(' ')
}

export function decodeCasts(encoded: string): EncodedCast[] {
  if (!encoded) return []
  let tick = 0
  return encoded.split(' ').map((token) => {
    const [id, delta] = token.split('.')
    tick += parseInt(delta, 36)
    return { t: tick * TICK_MS, abilityId: parseInt(id, 36) }
  })
}

/** 效果時段（與 analysis/buffs.ts 的 BuffWindow 相同欄位） */
export interface EncodedWindow {
  statusId: number
  start: number
  end: number
  prepull: boolean
  openEnded: boolean
}

/** 效果時段：每筆「效果 ID.開始時間差.持續[.旗標]」（旗標 1＝開打前已有、2＝到戰鬥結束仍未移除），依開始時間排序。 */
export function encodeWindows(windows: EncodedWindow[]): string {
  let last = 0
  return [...windows]
    .sort((a, b) => a.start - b.start)
    .map((w) => {
      const start = Math.round(w.start / TICK_MS)
      const flags = (w.prepull ? 1 : 0) | (w.openEnded ? 2 : 0)
      const token = [w.statusId.toString(36), (start - last).toString(36), Math.max(0, Math.round((w.end - w.start) / TICK_MS)).toString(36)]
      if (flags) token.push(String(flags))
      last = start
      return token.join('.')
    })
    .join(' ')
}

export function decodeWindows(encoded: string): EncodedWindow[] {
  if (!encoded) return []
  let tick = 0
  return encoded.split(' ').map((token) => {
    const [id, delta, duration, flags = '0'] = token.split('.')
    tick += parseInt(delta, 36)
    const f = Number(flags)
    return {
      statusId: parseInt(id, 36),
      start: tick * TICK_MS,
      end: (tick + parseInt(duration, 36)) * TICK_MS,
      prepull: (f & 1) !== 0,
      openEnded: (f & 2) !== 0,
    }
  })
}

/** 對敵人施加或續上效果的每一次（與 analysis/buffs.ts 的 DebuffApplication 相同欄位） */
export interface EncodedApplication {
  t: number
  statusId: number
  targetId: number
}

/** 施加效果：每筆「效果 ID.時間差.目標 ID」，依時間排序。 */
export function encodeApplications(applications: EncodedApplication[]): string {
  let last = 0
  return [...applications]
    .sort((a, b) => a.t - b.t)
    .map((a) => {
      const tick = Math.round(a.t / TICK_MS)
      const token = `${a.statusId.toString(36)}.${(tick - last).toString(36)}.${a.targetId.toString(36)}`
      last = tick
      return token
    })
    .join(' ')
}

export function decodeApplications(encoded: string): EncodedApplication[] {
  if (!encoded) return []
  let tick = 0
  return encoded.split(' ').map((token) => {
    const [id, delta, target] = token.split('.')
    tick += parseInt(delta, 36)
    return { t: tick * TICK_MS, statusId: parseInt(id, 36), targetId: parseInt(target, 36) }
  })
}
