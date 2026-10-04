// 排程字串與 wrangler.toml 一致的檢查在 schedule.node.test.ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CRAWL_CRON, PRUNE_CRON, TIMELINES_CRON } from './schedule'

// 定時工作本身另有測試（crawler／timelines），這裡只確認哪個排程執行哪個工作
vi.mock('./crawler', () => ({
  CRAWL_DIFFICULTY: 101,
  CRAWL_ZONES: [68],
  CURRENT_ENCOUNTERS: [97, 98, 99, 100],
  crawl: vi.fn(async () => ({})),
  flagSuspectFights: vi.fn(async () => ({})),
  pruneGoneReports: vi.fn(async () => ({})),
}))
vi.mock('./timelines', () => ({
  processTimelines: vi.fn(async () => ({})),
  timelineWork: (minute: number) => ({ minute }),
}))
vi.mock('./handler', () => ({
  graphqlFor: () => async () => ({}),
  handleRequest: vi.fn(),
  setTokenStore: () => {},
}))

const { crawl, flagSuspectFights, pruneGoneReports } = await import('./crawler')
const { processTimelines } = await import('./timelines')
const worker = (await import('./index')).default

/** 以 UTC 時間觸發一次排程，等工作完成 */
async function fire(cron: string, iso: string, env: Record<string, unknown> = { DB: {} }): Promise<void> {
  const pending: Promise<unknown>[] = []
  await worker.scheduled({ cron, scheduledTime: Date.parse(iso) }, env as never, { waitUntil: (p: Promise<unknown>) => pending.push(p) } as never)
  await Promise.all(pending)
}

describe('scheduled', () => {
  beforeEach(() => {
    vi.stubGlobal('caches', { default: {} })
    vi.spyOn(console, 'log').mockImplementation(() => {})
  })
  afterEach(() => {
    vi.clearAllMocks()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('crawls one page with two reports, alternating recent and backfill', async () => {
    await fire(CRAWL_CRON, '2026-10-04T03:02:00Z')
    await fire(CRAWL_CRON, '2026-10-04T03:07:00Z')
    expect(vi.mocked(crawl).mock.calls.map((c) => [c[3], c[4]])).toEqual([
      [68, { pages: 1, backfillOnly: false, maxRequests: 3 }],
      [68, { pages: 1, backfillOnly: true, maxRequests: 3 }],
    ])
    expect(processTimelines).not.toHaveBeenCalled()
  })

  it('prunes every run and flags one boss per hour in turn', async () => {
    await fire(PRUNE_CRON, '2026-10-04T05:05:00Z')
    await fire(PRUNE_CRON, '2026-10-04T05:15:00Z')
    expect(pruneGoneReports).toHaveBeenCalledTimes(2)
    // 只有整點後的第一次（5 分）；5 點 → CURRENT_ENCOUNTERS[5 % 4]
    expect(vi.mocked(flagSuspectFights).mock.calls.map((c) => [c[1], c[2]])).toEqual([[98, 101]])
  })

  it('runs timelines for the every-minute cron and any cron it does not know', async () => {
    await fire(TIMELINES_CRON, '2026-10-04T03:10:00Z')
    // 改排程後 Cloudflare 可能還會以舊的排程字串觸發
    await fire('7-59/10 * * * *', '2026-10-04T03:17:00Z')
    expect(vi.mocked(processTimelines).mock.calls.map((c) => c[3])).toEqual([{ minute: 10 }, { minute: 17 }])
    expect(crawl).not.toHaveBeenCalled()
    expect(pruneGoneReports).not.toHaveBeenCalled()
  })

  it('does nothing without a database', async () => {
    await fire(TIMELINES_CRON, '2026-10-04T03:10:00Z', {})
    expect(processTimelines).not.toHaveBeenCalled()
  })
})
