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
  // 先四捨五入到 0.1 秒再拆分，59.96 秒才會進位成 1:00.0（而不是 0:60.0）
  const tenths = Math.round(Math.abs(ms) / 100)
  const minutes = Math.floor(tenths / 600)
  const seconds = ((tenths % 600) / 10).toFixed(1).padStart(4, '0')
  return `${sign}${minutes}:${seconds}`
}
