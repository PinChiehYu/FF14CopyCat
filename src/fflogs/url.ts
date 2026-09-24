export interface ReportRef {
  reportCode: string
  /** 數字 fight id，或 'last' 代表報告中最後一場；未指定則為 undefined。 */
  fight?: number | 'last'
  /** FFLogs 的 actor id（連結中的 source 參數）。 */
  sourceId?: number
}

const REPORT_PATH = /^\/reports\/((?:a:)?[A-Za-z0-9]+)\/?$/

/**
 * 解析 FFLogs 報告連結，例如
 * https://www.fflogs.com/reports/AbCd1234#fight=5&type=damage-done&source=3
 * fight / source 可能出現在 hash 或 query string。無法解析時回傳 null。
 */
export function parseReportUrl(input: string): ReportRef | null {
  let url: URL
  try {
    url = new URL(input.trim())
  } catch {
    return null
  }
  if (!/(^|\.)fflogs\.com$/.test(url.hostname)) return null

  const match = REPORT_PATH.exec(url.pathname)
  if (!match) return null

  const params = new URLSearchParams(url.search)
  new URLSearchParams(url.hash.replace(/^#/, '')).forEach((value, key) => params.set(key, value))

  const ref: ReportRef = { reportCode: match[1] }

  const fight = params.get('fight')
  if (fight === 'last') ref.fight = 'last'
  else if (fight && /^\d+$/.test(fight)) ref.fight = Number(fight)

  const source = params.get('source')
  if (source && /^\d+$/.test(source)) ref.sourceId = Number(source)

  return ref
}
