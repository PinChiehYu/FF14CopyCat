// Node 環境的測試（讀 wrangler.toml）：由 tsconfig.node.json 檢查
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { CRAWL_CRON, PRUNE_CRON, TIMELINES_CRON } from './schedule.ts'

describe('schedule', () => {
  it('uses the same cron strings as wrangler.toml', () => {
    const toml = readFileSync(new URL('../wrangler.toml', import.meta.url), 'utf8')
    const crons = JSON.parse(toml.match(/^crons = (\[.*\])$/m)![1]) as string[]
    expect(crons.sort()).toEqual([CRAWL_CRON, PRUNE_CRON, TIMELINES_CRON].sort())
  })

})
