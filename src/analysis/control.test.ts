import { describe, expect, it } from 'vitest'
import type { BuffWindow } from './buffs'
import { attachControl, controlNames, controlStatuses, controlWindows } from './control'

const debuff = (statusId: number, start: number, end: number): BuffWindow => ({ statusId, start, end, prepull: false, openEnded: false })

describe('controlStatuses', () => {
  it('treats a boss debuff as control only when no GCD starts during any of its windows on either side', () => {
    const spotlight = 1_004_471 // 完美收尾：期間沒有 GCD
    const burn = 1_004_461 // 蹦迪：期間仍有 GCD
    const long = 1_002_088 // 出血：15 秒，太長不算
    const statuses = controlStatuses([
      { debuffs: [debuff(spotlight, 102_300, 105_300), debuff(burn, 78_300, 101_800), debuff(long, 16_400, 31_400)], gcds: [80_000, 99_500, 106_400] },
      { debuffs: [debuff(spotlight, 346_000, 349_100)], gcds: [345_000, 350_000] },
    ])
    expect([...statuses]).toEqual([spotlight])
  })

  it('ignores a GCD that started just before the debuff landed', () => {
    expect(controlStatuses([{ debuffs: [debuff(1, 10_000, 13_000)], gcds: [10_200] }]).has(1)).toBe(true)
    // 另一邊的某一次期間內有施放：不算
    const both = controlStatuses([
      { debuffs: [debuff(1, 10_000, 13_000)], gcds: [] },
      { debuffs: [debuff(1, 20_000, 23_000)], gcds: [21_500] },
    ])
    expect(both.has(1)).toBe(false)
  })
})

describe('controlWindows / attachControl', () => {
  it('merges overlapping control debuffs and tags the stops they overlap', () => {
    const windows = controlWindows([debuff(1, 102_300, 105_300), debuff(2, 101_800, 105_300), debuff(3, 50_000, 52_000)], new Set([1, 2]))
    expect(windows).toEqual([{ start: 101_800, end: 105_300, statusIds: [2, 1] }])
    const lost = [
      { mineStart: 99_500, mineEnd: 106_400, refStart: 99_000, refEnd: 106_000, refGcds: 1 },
      { mineStart: 65_000, mineEnd: 69_000, refStart: 65_000, refEnd: 69_000, refGcds: 1 },
    ]
    const tagged = attachControl(lost, windows)
    expect(tagged[0].control).toEqual([2, 1])
    expect(tagged[1].control).toBeUndefined()
  })

  it('names control effects and falls back when all are unnamed', () => {
    expect(controlNames([1, 1], () => '完美收尾')).toBe('完美收尾')
    expect(controlNames([], () => 'x')).toBe('無名稱效果')
  })
})
