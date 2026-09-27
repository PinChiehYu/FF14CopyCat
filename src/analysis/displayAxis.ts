import type { PushDifference } from './alignment'

/** 時間軸上一側空白的時段（顯示時間）：另一側在這段推進較慢、多花的時間。 */
export interface AxisGap {
  start: number
  end: number
  /** 空白的一側（推進較快的一方） */
  side: 'mine' | 'ref'
  push: PushDifference
}

export interface DisplayAxis {
  /** 參考時間 → 顯示時間 */
  ref: (t: number) => number
  /** 我的戰鬥時間 → 顯示時間 */
  mine: (t: number) => number
  /** 顯示時間 → 參考時間（點擊時間尺用；落在參考空白的時段時取推進完成的時間） */
  toRef: (d: number) => number
  gaps: AxisGap[]
}

/**
 * 並排時間軸的橫軸。平常以參考時間為準、我的施放依對齊換算；推進差距（一方較慢推進）的時段兩邊各自照實際長度排開，
 * 較快的一方在後面補上空白，而不是把較慢一方的施放擠在一起。
 * 推進時段是相鄰兩個錨點之間（mineStart～mineEnd 對應 refStart～refEnd），對齊在這段是線性的，前後都接得上。
 */
export function displayAxis(pushes: PushDifference[], mineToRef: (t: number) => number): DisplayAxis {
  const sorted = [...pushes].sort((a, b) => a.refStart - b.refStart)
  // 每次推進在參考時間軸插入的空白（我較慢時）
  const extra = (p: PushDifference) => Math.max(0, p.mineEnd - p.mineStart - (p.refEnd - p.refStart))

  const ref = (t: number) => {
    let off = 0
    for (const p of sorted) if (t >= p.refEnd) off += extra(p)
    return t + off
  }
  const mine = (t: number) => {
    const p = sorted.find((q) => t >= q.mineStart && t < q.mineEnd)
    return p ? ref(p.refStart) + (t - p.mineStart) : ref(mineToRef(t))
  }
  const toRef = (d: number) => {
    let off = 0
    for (const p of sorted) {
      if (d < p.refEnd + off) return d - off
      if (d < p.refEnd + off + extra(p)) return p.refEnd
      off += extra(p)
    }
    return d - off
  }

  const gaps: AxisGap[] = sorted.map((p) => {
    const start = ref(p.refStart)
    const mineSpan = p.mineEnd - p.mineStart
    const refSpan = p.refEnd - p.refStart
    return mineSpan >= refSpan
      ? { start: start + refSpan, end: start + mineSpan, side: 'ref' as const, push: p }
      : { start: start + mineSpan, end: start + refSpan, side: 'mine' as const, push: p }
  })
  return { ref, mine, toRef, gaps: gaps.filter((g) => g.end > g.start) }
}
