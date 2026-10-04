import { describe, expect, it } from 'vitest'
import { badWeaves } from './weaving'

const GCD = 1
const isGcd = (id: number) => id < 100 || id === 16476
const isItem = () => false
const side = (casts: [number, number][], extra: Partial<Parameters<typeof badWeaves>[0]> = {}) => ({
  playerCasts: casts.map(([t, abilityId]) => ({ t, abilityId })),
  castBars: [],
  deaths: [],
  untargetable: [],
  duration: 60_000,
  ...extra,
})

describe('badWeaves', () => {
  it('flags a third weave that pushes the next GCD back', () => {
    // 2.5 秒 GCD：兩個能力技沒事；三個能力技讓下一個 GCD 晚了 0.7 秒
    const s = side([[1000, GCD], [1700, 200], [2400, 201], [3500, GCD], [4200, 202], [4900, 203], [5600, 204], [6700, GCD]])
    const found = badWeaves(s, 'Samurai', isGcd, isItem, 2500)
    expect(found).toHaveLength(1)
    expect(found[0]).toMatchObject({ start: 3500, end: 6700, allowed: 2, delayMs: 700 })
  })

  it('allows only one weave after a cast of a second or more', () => {
    // 前一個 GCD 詠唱 1.5 秒：兩個能力技就算太多
    const s = side([[1000, GCD], [2600, 200], [3300, 201], [4000, GCD]], {
      castBars: [{ abilityId: GCD, start: 1000, end: 2500, interrupted: false }],
    })
    expect(badWeaves(s, 'BlackMage', isGcd, isItem, 2500)).toMatchObject([{ allowed: 1 }])
  })

  it('does not flag weaves when the GCD was not delayed or during downtime', () => {
    // 三個能力技但間隔沒有超過復唱（例如動畫鎖短）
    expect(badWeaves(side([[1000, GCD], [1500, 200], [2000, 201], [2400, 202], [3400, GCD]]), 'Samurai', isGcd, isItem, 2500)).toEqual([])
    // Boss 無法選中期間的能力技不算
    const downtime = side([[1000, GCD], [2000, 200], [3000, 201], [4000, 202], [9000, GCD]], { untargetable: [{ start: 2500, end: 8500 }] })
    expect(badWeaves(downtime, 'Samurai', isGcd, isItem, 2500)).toEqual([])
  })

  it('lets monks double weave and weave four after Six-sided Star', () => {
    const monk = side([[1000, 16476], [2000, 200], [3000, 201], [4000, 202], [5000, 203], [7000, GCD]])
    expect(badWeaves(monk, 'Monk', isGcd, isItem, 2000)).toEqual([])
    // 一般 GCD 後雙插沒事，三插讓下一個 GCD 晚了就算
    expect(badWeaves(side([[1000, GCD], [1700, 200], [2400, 201], [3300, GCD]]), 'Monk', isGcd, isItem, 2000)).toEqual([])
    expect(badWeaves(side([[1000, GCD], [1700, 200], [2400, 201], [3100, 202], [4200, GCD]]), 'Monk', isGcd, isItem, 2000)).toMatchObject([
      { start: 1000, end: 4200, allowed: 2, delayMs: 1200 },
    ])
  })
})
