// 日誌的遊戲版本：依角色的伺服器判斷繁中服或國際服，再依戰鬥時間對照各自的版本上線日期。
// FFLogs 的報告沒有遊戲版本（masterData.gameVersion 固定為 1、logVersion 是 FFLogs 解析器的版本），
// 繁中服的更新時程也與國際服不同（2026-09 繁中服為 7.25、國際服為 7.5），因此不能只看日期。

export type Edition = 'global' | 'tc'

export interface GamePatch {
  /** 版本號，例如 '7.2'、'7.25' */
  key: string
  edition: Edition
}

/** 繁中服的伺服器名稱（與 worker/src/crawler.ts 的 TC_SERVERS 相同） */
const TC_SERVERS: ReadonlySet<string> = new Set(['泰坦', '奧汀', '利維坦', '迦樓羅', '伊弗利特', '鳳凰', '巴哈姆特'])

const utc = (y: number, m: number, d: number, h = 0) => Date.UTC(y, m - 1, d, h)

// 國際服：xivanalysis src/data/PATCHES/patches.ts（dawntrail 分支 b240252）
const GLOBAL_PATCHES: [string, number][] = [
  ['7.0', utc(2024, 6, 28, 9)],
  ['7.01', utc(2024, 7, 16, 7)],
  ['7.05', utc(2024, 7, 30, 10)],
  ['7.1', utc(2024, 11, 12, 8)],
  ['7.2', utc(2025, 3, 25, 8)],
  ['7.3', utc(2025, 8, 5, 8)],
  ['7.4', utc(2025, 12, 16, 8)],
  ['7.5', utc(2026, 4, 28, 8)],
]

// 繁中服：官方公告（7.1 2026-04-21、7.2 2026-07-28、7.25 2026-09-23）；更早的版本一律視為 7.0。
// 維護在台灣時間早上結束，以當天 00:00（UTC+8）為準
const TC_PATCHES: [string, number][] = [
  ['7.0', 0],
  ['7.1', utc(2026, 4, 20, 16)],
  ['7.2', utc(2026, 7, 27, 16)],
  ['7.25', utc(2026, 9, 22, 16)],
]

export function editionOf(server: string | null | undefined): Edition {
  return server && TC_SERVERS.has(server) ? 'tc' : 'global'
}

/** 某個時間點（毫秒）、某伺服器的遊戲版本。 */
export function patchAt(timestampMs: number, server: string | null | undefined): GamePatch {
  const edition = editionOf(server)
  const table = edition === 'tc' ? TC_PATCHES : GLOBAL_PATCHES
  let key = table[0][0]
  for (const [k, date] of table) if (timestampMs >= date) key = k
  return { key, edition }
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

export function patchLabel(p: GamePatch): string {
  return `${p.key}（${p.edition === 'tc' ? '繁中服' : '國際服'}）`
}
