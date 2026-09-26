// 日誌的遊戲版本：依戰鬥時間對照繁中服的版本上線日期（本工具只處理繁中服日誌）。
// FFLogs 的報告沒有遊戲版本（masterData.gameVersion 固定為 1、logVersion 是 FFLogs 解析器的版本），
// 繁中服的更新時程也與國際服不同（2026-09 繁中服為 7.25、國際服為 7.5），不能沿用 xivanalysis 的國際服日期。

const utc = (y: number, m: number, d: number, h = 0) => Date.UTC(y, m - 1, d, h)

// 繁中服：官方公告（7.1 2026-04-21、7.2 2026-07-28、7.25 2026-09-23）；更早的版本一律視為 7.0。
// 維護在台灣時間早上結束，以當天 00:00（UTC+8）為準。**繁中服每次改版都要在這裡加上新版本。**
const TC_PATCHES: [string, number][] = [
  ['7.0', 0],
  ['7.1', utc(2026, 4, 20, 16)],
  ['7.2', utc(2026, 7, 27, 16)],
  ['7.25', utc(2026, 9, 22, 16)],
]

/** 某個時間點（毫秒）的繁中服遊戲版本，例如 '7.2'、'7.25'。 */
export function patchAt(timestampMs: number): string {
  let key = TC_PATCHES[0][0]
  for (const [k, date] of TC_PATCHES) if (timestampMs >= date) key = k
  return key
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
