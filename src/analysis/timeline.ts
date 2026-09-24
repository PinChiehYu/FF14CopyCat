/**
 * FFLogs 事件的 timestamp 是相對於整份報告開始的毫秒數。
 * 比較兩份日誌前，一律先轉成相對於該場戰鬥開始的毫秒數。
 */
export function toFightTime(reportTimestamp: number, fightStartTime: number): number {
  return reportTimestamp - fightStartTime
}

/** 將毫秒格式化為 m:ss.s，方便在時間軸上顯示。 */
export function formatFightTime(ms: number): string {
  const sign = ms < 0 ? '-' : ''
  const abs = Math.abs(ms)
  const minutes = Math.floor(abs / 60_000)
  const seconds = ((abs % 60_000) / 1000).toFixed(1).padStart(4, '0')
  return `${sign}${minutes}:${seconds}`
}
