import { describe, expect, it } from 'vitest'
import { getJob } from './index'
import { jobName } from './names'

describe('jobName', () => {
  it('translates FFLogs subTypes to official Traditional Chinese names', () => {
    expect(jobName('BlackMage')).toBe('黑魔道士')
    expect(jobName('Viper')).toBe('毒蛇劍士')
    expect(jobName('DarkKnight')).toBe('暗黑騎士')
  })

  it('keeps unknown subTypes', () => {
    expect(jobName('LimitBreak')).toBe('LimitBreak')
  })

  it('uses the same names in job modules', () => {
    for (const subType of ['Viper', 'Samurai', 'Paladin', 'BlackMage']) {
      expect(getJob(subType)?.name).toBe(jobName(subType))
    }
  })
})
