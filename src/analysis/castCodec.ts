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
