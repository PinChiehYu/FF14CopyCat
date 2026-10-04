import { describe, expect, it } from 'vitest'
import { encodeCasts } from '../analysis/castCodec'
import type { AverageSampleData } from '../fflogs/client'
import { getJob } from '../jobs'
import { averageSide } from './averageSide'
import type { Selection, SideData } from './load'

const samurai = getJob('Samurai')!
// 武士的一個 GCD 與一個能力技（依遊戲資料判斷）
const GCD = [7477, 7478, 7479, 7480, 7481].find((id) => samurai.isGcd(id))!
const OGCD = 7499
const boss = Array.from({ length: 30 }, (_, i) => ({ t: i * 10_000, abilityId: 9000 + i }))

function sampleData(gcdMs: number, duration: number): AverageSampleData {
  const casts = []
  for (let t = 0; t < duration; t += gcdMs) casts.push({ t, abilityId: GCD })
  casts.push({ t: 1000, abilityId: OGCD })
  return {
    name: 'x',
    server: 'y',
    report: 'R',
    fight: 1,
    actor: 1,
    pr: 99,
    rdps: 1,
    patch: '7.2',
    duration,
    boss: encodeCasts(boss),
    casts: encodeCasts(casts.sort((a, b) => a.t - b.t)),
    buffs: '',
    applications: '',
  }
}

const mine = {
  selection: { player: { subType: 'Samurai' }, fight: { encounterID: 0 } } as unknown as Selection,
  bossCasts: boss,
  untargetable: [],
  duration: 300_000,
} as unknown as SideData

describe('averageSide', () => {
  it('takes the GCD stats as the median of each sample', () => {
    // 三位樣本的 GCD 分別 2.40、2.45、2.50 秒：中位數 2.45 秒（不從合成的 GCD 位置算）
    const { gcd, used, side } = averageSide(mine, [sampleData(2400, 300_000), sampleData(2450, 300_000), sampleData(2500, 300_000)])
    expect(used).toBe(3)
    expect(gcd?.gcdMs).toBeCloseTo(2450, -1)
    expect(side.duration).toBe(300_000)
    expect(side.bossCasts).toBe(mine.bossCasts)
  })
})
