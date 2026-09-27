import { describe, expect, it } from 'vitest'
import type { PushDifference } from './alignment'
import { displayAxis } from './displayAxis'

// 推進前兩邊同步；參考在 100～102 秒推進，我 100～110 秒（多花 8 秒）；之後我的時間 = 參考 + 8 秒
const slower: PushDifference = { mineStart: 100_000, mineEnd: 110_000, refStart: 100_000, refEnd: 102_000, deltaMs: 8000 }
const mineToRef = (t: number) => (t <= 100_000 ? t : t <= 110_000 ? 100_000 + (t - 100_000) * 0.2 : t - 8000)

describe('displayAxis', () => {
  it('lays out a slower push at full length and leaves the reference blank after its push', () => {
    const axis = displayAxis([slower], mineToRef)
    expect(axis.ref(50_000)).toBe(50_000)
    expect(axis.mine(50_000)).toBe(50_000)
    // 推進中：我的施放照實際間隔排開（不擠在 2 秒內）
    expect(axis.mine(105_000)).toBe(105_000)
    // 推進後兩邊接回同一個位置
    expect(axis.ref(102_000)).toBe(110_000)
    expect(axis.mine(110_000)).toBe(110_000)
    expect(axis.ref(150_000)).toBe(158_000)
    expect(axis.mine(158_000)).toBe(158_000)
    expect(axis.gaps).toEqual([{ start: 102_000, end: 110_000, side: 'ref', push: slower }])
  })

  it('leaves my side blank when I push faster', () => {
    const faster: PushDifference = { mineStart: 100_000, mineEnd: 101_000, refStart: 100_000, refEnd: 106_000, deltaMs: -5000 }
    const toRef = (t: number) => (t <= 100_000 ? t : t <= 101_000 ? 100_000 + (t - 100_000) * 6 : t + 5000)
    const axis = displayAxis([faster], toRef)
    expect(axis.ref(106_000)).toBe(106_000)
    expect(axis.mine(101_000)).toBe(106_000)
    expect(axis.gaps).toEqual([{ start: 101_000, end: 106_000, side: 'mine', push: faster }])
  })

  it('maps display time back to reference time', () => {
    const axis = displayAxis([slower], mineToRef)
    expect(axis.toRef(50_000)).toBe(50_000)
    // 參考空白的時段：取推進完成的時間
    expect(axis.toRef(105_000)).toBe(102_000)
    expect(axis.toRef(158_000)).toBe(150_000)
  })

  it('is the reference time when there is no push', () => {
    const axis = displayAxis([], (t) => t - 1000)
    expect(axis.ref(30_000)).toBe(30_000)
    expect(axis.mine(30_000)).toBe(29_000)
    expect(axis.gaps).toEqual([])
  })
})
