// Node 環境的測試（讀 wrangler.toml）：由 tsconfig.node.json 檢查
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { CRAWL_CRON, isStaleRun, MAX_RUN_DELAY_MS, PRUNE_CRON, TIMELINES_CRON } from './schedule.ts'

describe('schedule', () => {
  it('uses the same cron strings as wrangler.toml', () => {
    const toml = readFileSync(new URL('../wrangler.toml', import.meta.url), 'utf8')
    const crons = JSON.parse(toml.match(/^crons = (\[.*\])$/m)![1]) as string[]
    expect(crons.sort()).toEqual([CRAWL_CRON, PRUNE_CRON, TIMELINES_CRON].sort())
  })

  it('skips runs delivered long after their scheduled time', () => {
    const scheduled = 1_791_652_609_000
    expect(isStaleRun(scheduled, scheduled + 1_200)).toBe(false)
    expect(isStaleRun(scheduled, scheduled + MAX_RUN_DELAY_MS)).toBe(false)
    // 12 分鐘後才與其他累積的觸發一起送出
    expect(isStaleRun(scheduled, scheduled + 12 * 60_000)).toBe(true)
    expect(isStaleRun(undefined, scheduled)).toBe(false)
  })
})
