// 日誌的遊戲版本：依戰鬥時間對照繁中服的版本上線日期（本工具只處理繁中服日誌）。
// FFLogs 的報告沒有遊戲版本（masterData.gameVersion 固定為 1、logVersion 是 FFLogs 解析器的版本），
// 繁中服的更新時程也與國際服不同（2026-09 繁中服為 7.25、國際服為 7.5），不能沿用 xivanalysis 的國際服日期。
// 繁中服的內容版本與職業技能的版本也不一定相同：7.2 起的內容搭配 7.3 的職業技能調整（使用者確認）。

export interface GamePatch {
  /** 內容版本（副本、劇情），例如 '7.2'、'7.25' */
  content: string
  /** 職業技能的版本（技能窗口規則依這個選用），例如 '7.3' */
  jobs: string
}

const utc = (y: number, m: number, d: number, h = 0) => Date.UTC(y, m - 1, d, h)

// 繁中服：官方公告（7.1 2026-04-21、7.2 2026-07-28、7.25 2026-09-23）；更早的版本一律視為 7.0。
// 維護在台灣時間早上結束，以當天 00:00（UTC+8）為準。**繁中服每次改版都要在這裡加上新版本。**
// 7.2 起的職業技能是 7.3 的調整；7.2 以前沒有確認，視為與內容版本相同。
const TC_PATCHES: [number, GamePatch][] = [
  [0, { content: '7.0', jobs: '7.0' }],
  [utc(2026, 4, 20, 16), { content: '7.1', jobs: '7.1' }],
  [utc(2026, 7, 27, 16), { content: '7.2', jobs: '7.3' }],
  [utc(2026, 9, 22, 16), { content: '7.25', jobs: '7.3' }],
]

/** 某個時間點（毫秒）的繁中服遊戲版本。 */
export function patchAt(timestampMs: number): GamePatch {
  let patch = TC_PATCHES[0][1]
  for (const [date, p] of TC_PATCHES) if (timestampMs >= date) patch = p
  return patch
}

/** 顯示用：內容版本，職業技能版本不同時附註，例如「7.2（技能 7.3）」。 */
export function patchLabel(p: GamePatch): string {
  return p.jobs === p.content ? p.content : `${p.content}（技能 ${p.jobs}）`
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
