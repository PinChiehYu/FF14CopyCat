// 把輸入的日誌連結保存在本頁網址的 query（例如 ?mine=...&ref=...）：重新整理後可還原，網址也能直接分享。
// 用 replaceState 更新，不會增加瀏覽紀錄。

import type { Selection } from './compare/load'
import { reportUrl } from './fflogs/url'

// avg：參考改用前輩平均時的 PR 區間（見 compare/averageSide.ts）
export type LogKey = 'mine' | 'ref' | 'avg'

export function readLogParam(key: LogKey): string {
  return new URLSearchParams(window.location.search).get(key) ?? ''
}

export function writeLogParam(key: LogKey, value: string): void {
  const params = new URLSearchParams(window.location.search)
  if (value.trim()) params.set(key, value.trim())
  else params.delete(key)
  const query = params.toString()
  const url = `${window.location.pathname}${query ? `?${query}` : ''}${window.location.hash}`
  if (url !== `${window.location.pathname}${window.location.search}${window.location.hash}`) {
    window.history.replaceState(window.history.state, '', url)
  }
}

/**
 * 這次比較的分享連結：依目前選的戰鬥與角色產生，只含 mine／ref（不帶其他參數，例如驗證用的 ?v=），
 * 開啟後直接還原兩邊的戰鬥與角色。
 * @param base 本頁網址（origin＋pathname）
 */
export function shareUrl(mine: Selection, reference: Selection, base: string): string {
  const params = new URLSearchParams({
    mine: reportUrl(mine.report.code, mine.fight.id, mine.player.id),
    ref: reportUrl(reference.report.code, reference.fight.id, reference.player.id),
  })
  return `${base}?${params}`
}