import { describe, expect, it } from 'vitest'
import { BURST_RULES } from './burstRules'
import { JOB_CATEGORIES } from './generated'

describe('BURST_RULES', () => {
  it('covers every combat job and lists each skill once per job', () => {
    expect(Object.keys(BURST_RULES).sort()).toEqual(Object.keys(JOB_CATEGORIES).sort())
    for (const rules of Object.values(BURST_RULES)) {
      const ids = rules.flatMap((r) => [...r.ids, ...(r.alignAt?.ids ?? [])])
      expect(new Set(ids).size).toBe(ids.length)
    }
  })
})
