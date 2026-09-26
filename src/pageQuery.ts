// 把輸入的日誌連結保存在本頁網址的 query（例如 ?mine=...&ref=...）：重新整理後可還原，網址也能直接分享。
// 用 replaceState 更新，不會增加瀏覽紀錄。

export type LogKey = 'mine' | 'ref'

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
