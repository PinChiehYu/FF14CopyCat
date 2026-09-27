import { describe, expect, it } from 'vitest'
import { formatFightTime, toFightTime } from './timeline'

describe('timeline', () => {
  it('normalizes report timestamps to fight time', () => {
    expect(toFightTime(125_000, 120_000)).toBe(5_000)
  })

  it('formats fight time', () => {
    expect(formatFightTime(0)).toBe('0:00.0')
    expect(formatFightTime(65_432)).toBe('1:05.4')
    expect(formatFightTime(-1_500)).toBe('-0:01.5')
    // 四捨五入進位到下一分鐘
    expect(formatFightTime(59_960)).toBe('1:00.0')
    expect(formatFightTime(119_999)).toBe('2:00.0')
  })
})
