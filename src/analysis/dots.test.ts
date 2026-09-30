import { describe, expect, it } from 'vitest'
import { clipSeverity, evaluateDot } from './dots'
import { DOT_RULES } from '../jobs/dotRules'

const HIGANBANA = DOT_RULES.Samurai[0]
const BLM = DOT_RULES.BlackMage[0]
const window = (statusId: number, start: number, end: number) => ({ statusId, start, end, prepull: false, openEnded: false })

describe('evaluateDot', () => {
  it('measures uptime against the time the boss can be targeted', () => {
    // 120 秒的戰鬥，20～40 秒無法選中；DoT 在 0～60 秒（其中 20 秒無法選中）
    const s = evaluateDot(HIGANBANA, {
      buffs: [window(1_001_228, 0, 60_000)],
      debuffApplications: [],
      untargetable: [{ start: 20_000, end: 40_000 }],
      duration: 120_000,
    })
    expect(s.uptime).toBe(40)
  })

  it('adds up the time overwritten by early refreshes per target', () => {
    // 60 秒的彼岸花：0 秒施加、50 秒續上（覆蓋 10 秒）、130 秒施加（已掉，不算）；另一個目標的第一次不算
    const s = evaluateDot(HIGANBANA, {
      buffs: [],
      debuffApplications: [
        { t: 0, statusId: 1_001_228, targetId: 1 },
        { t: 30_000, statusId: 1_001_228, targetId: 2 },
        { t: 50_000, statusId: 1_001_228, targetId: 1 },
        { t: 130_000, statusId: 1_001_228, targetId: 1 },
      ],
      untargetable: [],
      duration: 120_000,
    })
    expect(s.clips).toEqual([{ t: 50_000, ms: 10_000 }])
    expect(s.clipPerMinMs).toBe(5000)
    expect(clipSeverity(s)).toBe('low')
  })

  it('does not count switching between the single-target and area versions', () => {
    // 高階暴雷 → 高階霹雷：不同效果，不算提早續上；覆蓋率合計
    const s = evaluateDot(BLM, {
      buffs: [window(1_003_871, 0, 20_000), window(1_003_872, 20_000, 44_000)],
      debuffApplications: [
        { t: 0, statusId: 1_003_871, targetId: 1 },
        { t: 20_000, statusId: 1_003_872, targetId: 1 },
      ],
      untargetable: [],
      duration: 60_000,
    })
    expect(s.clips).toEqual([])
    expect(s.uptime).toBeCloseTo(73.33, 1)
  })

  it('lists the stretches without the DoT while the boss can be targeted', () => {
    // 120 秒：開場 2.5 秒才施加、60～90 秒斷掉但 70～80 秒無法選中；0.5 秒的空檔不列
    const s = evaluateDot(HIGANBANA, {
      buffs: [window(1_001_228, 2_500, 60_000), window(1_001_228, 90_000, 110_000), window(1_001_228, 110_500, 120_000)],
      debuffApplications: [],
      untargetable: [{ start: 70_000, end: 80_000 }],
      duration: 120_000,
    })
    expect(s.gaps).toEqual([
      { start: 0, end: 2_500 },
      { start: 60_000, end: 70_000 },
      { start: 80_000, end: 90_000 },
    ])
  })
})
