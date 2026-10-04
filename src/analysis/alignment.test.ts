import { describe, expect, it } from 'vitest'
import { buildAlignment, pushDifferences, variantGroups, type Anchor, type TimedCast } from './alignment'

const cast = (seconds: number, abilityId: number): TimedCast => ({ t: seconds * 1000, abilityId })

describe('buildAlignment', () => {
  it('interpolates between anchors and extrapolates after the last one', () => {
    // 參考日誌第二個機制起早了 10 秒（例如輸出較高而提早轉場）；推進後有 3 個以上錨點才會保留這次跳動
    const mine = [cast(10, 1), cast(60, 2), cast(90, 3), cast(95, 4), cast(100, 5)]
    const ref = [cast(10, 1), cast(50, 2), cast(80, 3), cast(85, 4), cast(90, 5)]
    const { anchors, mineToRef } = buildAlignment(mine, ref)

    expect(anchors.map((a) => a.abilityId)).toEqual([1, 2, 3, 4, 5])
    expect(mineToRef(5_000)).toBe(5_000)
    expect(mineToRef(35_000)).toBe(30_000) // 10→10 與 60→50 之間
    expect(mineToRef(110_000)).toBe(100_000) // 最後錨點之後斜率 1
  })

  it('inverts the mapping with refToMine', () => {
    const mine = [cast(10, 1), cast(60, 2), cast(90, 3), cast(95, 4), cast(100, 5)]
    const ref = [cast(10, 1), cast(50, 2), cast(80, 3), cast(85, 4), cast(90, 5)]
    const { mineToRef, refToMine } = buildAlignment(mine, ref)
    for (const t of [0, 5_000, 35_000, 75_000, 100_000]) {
      expect(refToMine(mineToRef(t))).toBeCloseTo(t)
    }
  })

  it('pairs casts of the same ability by time and merges simultaneous casts', () => {
    const mine = [cast(10, 7), cast(10.2, 7), cast(40, 7)]
    const ref = [cast(10.5, 7), cast(40.5, 7)]
    const { anchors } = buildAlignment(mine, ref)
    expect(anchors.map((a) => [a.abilityId, a.mine, a.ref])).toEqual([
      [7, 10_000, 10_500],
      [7, 40_000, 40_500],
    ])
  })

  it('pairs the variants of a mechanic whose order is random', () => {
    // A 面／B 面先後隨機（熱舞綠光）：兩邊順序相反；依時間配對、同一時間兩邊不同的技能歸成一組
    const common = [cast(10, 1), cast(20, 2), cast(30, 3), cast(70, 4), cast(80, 5), cast(90, 6)]
    const mine = [...common, cast(40, 10), cast(60, 11)]
    const ref = [...common, cast(40, 11), cast(60, 10)]
    const { anchors, mineToRef } = buildAlignment(mine, ref)
    // 同一時間兩邊不同技能（10／11）歸成同一組，我的放入 A 面配參考同一時間的放入 B 面
    expect(anchors.map((a) => [a.abilityId, a.mine, a.ref])).toContainEqual([10, 40_000, 40_000])
    expect(anchors.map((a) => [a.abilityId, a.mine, a.ref])).toContainEqual([11, 60_000, 60_000])
    expect(mineToRef(50_000)).toBe(50_000)
    expect(pushDifferences(anchors)).toEqual([])
    // 只有兩邊在同一時間不同的技能才歸成一組，共同的技能不歸組
    const groups = variantGroups(mine, ref, mineToRef, 1000)
    expect(groups.get(10)).toBe(groups.get(11))
    expect(groups.has(1)).toBe(false)
  })

  it('does not group a mechanic that only one side cast', () => {
    // M8S 轉場前第二次空間斬：輸出夠高時被跳過，另一邊在那個時間點沒有對應的技能，不是隨機變化
    const common = [cast(10, 1), cast(20, 2), cast(30, 3), cast(60, 4), cast(70, 5)]
    const mine = [...common, cast(40, 50), cast(50, 50)]
    const ref = [...common, cast(40, 50)]
    const first = buildAlignment(mine, ref)
    expect(variantGroups(mine, ref, first.mineToRef, 1000).size).toBe(0)
  })

  it('does not pair the same ability across a swapped random order', () => {
    // 實例（M5S）：A／B 面相反時，同 ID 的放入與播放在另一邊早 20 秒；依時間配對不會配到那一次
    const common = [cast(10, 1), cast(15, 2), cast(20, 3), cast(65, 4), cast(75, 5), cast(80, 6)]
    const mine = [...common, cast(27, 10), cast(47, 11), cast(58, 12), cast(59, 13)]
    const ref = [...common, cast(27, 11), cast(38, 12), cast(39, 13), cast(47, 10)]
    const { anchors, mineToRef } = buildAlignment(mine, ref)
    // 錨點的時間差都是 0（放入 A／B 面歸成同一組後同一時間配對）
    expect(anchors.every((a) => a.ref === a.mine)).toBe(true)
    expect(anchors.map((a) => a.abilityId)).toEqual(expect.arrayContaining([1, 2, 3, 4, 5, 6]))
    expect(mineToRef(50_000)).toBe(50_000)
  })

  it('pairs the last random mechanic with the one at the same time', () => {
    // 尾聲的隨機機制不同（我 4 拍、參考 8 拍），參考較晚才出現的 4 拍不會配到我這一次
    const common = [cast(10, 1), cast(20, 2), cast(30, 3), cast(40, 4)]
    const mine = [...common, cast(50, 10)]
    const ref = [...common, cast(50, 11), cast(70, 10)]
    const { anchors } = buildAlignment(mine, ref)
    // 4 拍／8 拍歸成同一組：我的 4 拍配參考同時間的 8 拍，不會配到參考較晚的 4 拍
    expect(anchors.map((a) => [a.abilityId, a.mine, a.ref])).toEqual([
      [1, 10_000, 10_000],
      [2, 20_000, 20_000],
      [3, 30_000, 30_000],
      [4, 40_000, 40_000],
      [10, 50_000, 50_000],
    ])
    expect(pushDifferences(anchors)).toEqual([])
  })

  it('keeps the anchors around a real push', () => {
    // 60 秒後參考都早 10 秒（依血量推進）：時間差跳一次後維持
    const mine = [cast(10, 1), cast(20, 2), cast(30, 3), cast(60, 4), cast(70, 5), cast(80, 6)]
    const ref = [cast(10, 1), cast(20, 2), cast(30, 3), cast(50, 4), cast(60, 5), cast(70, 6)]
    const { anchors } = buildAlignment(mine, ref)
    expect(anchors).toHaveLength(6)
    expect(pushDifferences(anchors)).toEqual([{ mineStart: 30_000, mineEnd: 60_000, refStart: 30_000, refEnd: 50_000, deltaMs: 10_000 }])
  })

  it('pairs frequent abilities with the same cast at the same time, not a neighbouring one', () => {
    // 每 3 秒一次的技能，參考晚 0.5 秒：配到同一次（時間差 0.5 秒），不會配到相鄰的一次（差 2.5／3.5 秒）
    const autos = (offset: number) => Array.from({ length: 20 }, (_, i) => cast(offset + i * 3, 99))
    const { anchors, mineToRef } = buildAlignment(autos(1), autos(1.5))
    expect(anchors).toHaveLength(20)
    expect(anchors.every((a) => a.ref - a.mine === 500)).toBe(true)
    expect(mineToRef(30_000)).toBe(30_500)
  })

  it('drops pairings that contradict the time order', () => {
    // 能力 5 在兩份日誌的出現順序顛倒（例如隨機機制），應被捨棄
    const mine = [cast(10, 1), cast(20, 5), cast(30, 2), cast(40, 3)]
    const ref = [cast(10, 1), cast(30, 2), cast(40, 3), cast(45, 5)]
    const { anchors } = buildAlignment(mine, ref)
    expect(anchors.map((a) => a.abilityId)).toEqual([1, 2, 3])
  })

  it('pairs known versions of a mechanic at the same time from the first pass', () => {
    // 實例（M5S 3hCzxvn79fRTbQGP #30）：兩邊 A 面／B 面整段相反（相隔 19 秒）。只看技能 ID 時，我的 A 面整段
    // （放入、指向的多個判定、播放）會配到參考 19 秒後的 A 面；cactbot 把 A／B 面列為同一機制，同一時間就能配上
    const common = [cast(10, 1), cast(15, 2), cast(20, 3), cast(65, 4), cast(75, 5), cast(80, 6)]
    const aSide = (t: number) => [cast(t, 10), cast(t + 7, 20), cast(t + 8.2, 21), cast(t + 8.9, 22), cast(t + 10.5, 23), cast(t + 11.1, 30), cast(t + 12.2, 31)]
    const bSide = (t: number) => [cast(t, 11), cast(t + 7, 24), cast(t + 8.6, 25), cast(t + 10.6, 26), cast(t + 11.2, 32), cast(t + 12.3, 33)]
    const mine = [...common, ...aSide(27.5), ...bSide(47)]
    const ref = [...common, ...bSide(27.5), ...aSide(47)]
    const knownGroups = new Map([
      [10, 10], [11, 10], // 放入 A 面／B 面
      [20, 20], [21, 20], [22, 20], [23, 20], [24, 20], [25, 20], [26, 20], // 各種指向
      [30, 30], [31, 30], [32, 30], [33, 30], // 播放 A 面／B 面
    ])
    const { anchors } = buildAlignment(mine, ref, { knownGroups })
    expect(anchors.every((a) => Math.abs(a.ref - a.mine) <= 500)).toBe(true)
    expect(pushDifferences(anchors)).toEqual([])
  })

  it('only pairs casts of the same ability within the drift limit', () => {
    // 時間差上限 120 秒：超過的不是同一次機制
    expect(buildAlignment([cast(10, 1)], [cast(140, 1)]).anchors).toEqual([])
    expect(buildAlignment([cast(10, 1)], [cast(100, 1)]).anchors).toHaveLength(1)
  })

  it('does not group variants when the first pass has too few anchors', () => {
    // 第一次對齊少於 3 個錨點時「同一時間點」不可靠，不找隨機機制組：同時間的不同技能不會配成錨點
    const mine = [cast(10, 1), cast(20, 2), cast(40, 10)]
    const ref = [cast(10, 1), cast(20, 2), cast(40, 11)]
    expect(buildAlignment(mine, ref).anchors.map((a) => a.abilityId)).toEqual([1, 2])
  })

  it('falls back to identity when nothing matches', () => {
    const { anchors, mineToRef } = buildAlignment([cast(10, 1)], [cast(10, 2)])
    expect(anchors).toEqual([])
    expect(mineToRef(12_345)).toBe(12_345)
  })
})

describe('pushDifferences', () => {
  // 錨點：[我的秒數, 參考的秒數]
  const anchors = (pairs: [number, number][]): Anchor[] =>
    pairs.map(([m, r], i) => ({ mine: m * 1000, ref: r * 1000, abilityId: i + 1 }))

  it('finds a persistent jump such as pushing a phase later than the reference', () => {
    // 第一階段兩邊同步；參考 100 秒推進、我 109 秒才推進；轉場後時間差維持 −9 秒
    const pushes = pushDifferences(
      anchors([[20, 20], [50, 50], [80, 80], [99.5, 99.4], [109, 100], [170, 161], [190, 181], [220, 211]]),
    )
    expect(pushes).toHaveLength(1)
    expect(pushes[0]).toMatchObject({ mineStart: 99_500, mineEnd: 109_000, refStart: 99_400, refEnd: 100_000 })
    // 前後各取中位數：推進前的時間差約 −0.05 秒，之後 −9 秒
    expect(pushes[0].deltaMs).toBe(8950)
  })

  it('ignores short wobbles from random mechanics', () => {
    // 5:56 附近一個錨點偏了約 4 秒，之後回到原本的時間差
    const pushes = pushDifferences(anchors([[340, 340], [351, 351.2], [356.6, 352.8], [358.6, 356.8], [359.7, 359.9], [364, 364.1], [378, 378.2]]))
    expect(pushes).toEqual([])
  })

  it('drops a jump that is undone shortly after', () => {
    // 先慢 5 秒、10 秒後又追回：兩段合併後沒有持續的差距
    const pushes = pushDifferences(anchors([[30, 30], [60, 60], [90, 85], [100, 100], [130, 130], [160, 160]]))
    expect(pushes).toEqual([])
  })

  it('reports a faster push as a negative difference', () => {
    const pushes = pushDifferences(anchors([[30, 30], [60, 60], [90, 95], [120, 125], [150, 155]]))
    expect(pushes).toHaveLength(1)
    expect(pushes[0].deltaMs).toBe(-5000)
  })
})
