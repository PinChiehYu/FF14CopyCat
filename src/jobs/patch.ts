// 日誌的遊戲版本：依戰鬥時間對照繁中服的版本上線日期（本工具只處理繁中服日誌）。
// FFLogs 的報告沒有遊戲版本（masterData.gameVersion 固定為 1、logVersion 是 FFLogs 解析器的版本），
// 繁中服的更新時程也與國際服不同（2026-09 繁中服為 7.25、國際服為 7.5）。
// 技能窗口規則移植自 xivanalysis，依國際服的版本撰寫；繁中服 7.2 的職業技能等同國際服 7.3，
// 因此每個繁中服版本另記一個「套用規則的國際服版本」。

export interface GamePatch {
  /** 繁中服的版本（顯示用），例如 '7.2'、'7.25' */
  key: string
  /** 套用技能窗口規則時對應的國際服版本（xivanalysis 的版本），例如繁中服 7.2 → '7.3' */
  rules: string
}

const utc = (y: number, m: number, d: number, h = 0) => Date.UTC(y, m - 1, d, h)

// 繁中服：官方公告（7.1 2026-04-21、7.2 2026-07-28、7.25 2026-09-23）；更早的版本一律視為 7.0。
// 維護在台灣時間早上結束，以當天 00:00（UTC+8）為準。**繁中服每次改版都要在這裡加上新版本。**
// 繁中服 7.2 起的職業技能等同國際服 7.3（使用者確認）；7.2 以前未確認，視為同版本。
const TC_PATCHES: [number, GamePatch][] = [
  [0, { key: '7.0', rules: '7.0' }],
  [utc(2026, 4, 20, 16), { key: '7.1', rules: '7.1' }],
  [utc(2026, 7, 27, 16), { key: '7.2', rules: '7.3' }],
  [utc(2026, 9, 22, 16), { key: '7.25', rules: '7.3' }],
]

/** 某個時間點（毫秒）的繁中服遊戲版本。 */
export function patchAt(timestampMs: number): GamePatch {
  let patch = TC_PATCHES[0][1]
  for (const [date, p] of TC_PATCHES) if (timestampMs >= date) patch = p
  return patch
}

/** 比較版本號：'7.05' < '7.1' < '7.2' < '7.25' < '7.3'。 */
export function comparePatch(a: string, b: string): number {
  return Number(a) - Number(b)
}

/** 版本是否在範圍內（from 含、before 不含）。 */
export function inPatchRange(patch: string, range: { from?: string; before?: string } | undefined): boolean {
  if (!range) return true
  if (range.from !== undefined && comparePatch(patch, range.from) < 0) return false
  if (range.before !== undefined && comparePatch(patch, range.before) >= 0) return false
  return true
}
