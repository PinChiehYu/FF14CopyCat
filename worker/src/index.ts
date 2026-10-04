import { CRAWL_DIFFICULTY, crawl, CRAWL_ZONES, CURRENT_ENCOUNTERS, flagSuspectFights, pruneGoneReports } from './crawler'
import { graphqlFor, handleRequest, setTokenStore, type CacheLike, type Context, type Env } from './handler'
import { CRAWL_CRON, CRAWL_REPORTS_PER_RUN, PRUNE_CRON } from './schedule'
import { processTimelines, timelineWork } from './timelines'

// Workers 執行環境提供的快取
declare const caches: { default: CacheLike }

export default {
  fetch(request: Request, env: Env, ctx: Context): Promise<Response> {
    // FFLogs 權杖存在 Cloudflare 快取，同一個資料中心的 isolate 共用（重新部署後不必每個 isolate 都換權杖）
    setTokenStore(caches.default)
    return handleRequest(request, env, ctx, caches.default)
  },

  async scheduled(controller: { cron?: string; scheduledTime?: number }, env: Env, ctx: Context): Promise<void> {
    if (!env.DB) return
    setTokenStore(caches.default)
    const db = env.DB
    const minute = new Date(controller.scheduledTime ?? Date.now()).getUTCMinutes()
    ctx.waitUntil(
      (async () => {
        if (controller.cron === PRUNE_CRON) {
          console.log('prune', JSON.stringify(await pruneGoneReports(db, graphqlFor(env))))
          // 每小時一次（5 分）標記一個本季 Boss 傷害數字不可信的場次，依小時輪流（讀整個 Boss 的全隊總傷害）
          if (minute < 10) {
            const hour = new Date(controller.scheduledTime ?? Date.now()).getUTCHours()
            const encounter = CURRENT_ENCOUNTERS[hour % CURRENT_ENCOUNTERS.length]
            console.log(`suspect ${encounter}`, JSON.stringify(await flagSuspectFights(db, encounter, CRAWL_DIFFICULTY)))
          }
          return
        }
        // 其餘觸發一律預處理：改排程後 Cloudflare 可能還會以舊的排程字串觸發一段時間（2026-10-02 實測超過 15 分鐘），
        // 不依賴字串完全相同；工作量依分鐘決定，與觸發頻率無關
        if (controller.cron !== CRAWL_CRON) {
          console.log('timelines', JSON.stringify(await processTimelines(db, graphqlFor(env), Date.now(), timelineWork(minute))))
          return
        }
        // 還在補舊資料時，最近兩天與補舊資料輪流（7、17…57 分補舊資料）
        const backfillOnly = Math.floor(minute / 5) % 2 === 1
        for (const zone of CRAWL_ZONES) {
          const result = await crawl(db, graphqlFor(env), Date.now(), zone, { pages: 1, backfillOnly, maxRequests: 1 + CRAWL_REPORTS_PER_RUN })
          console.log(`crawl zone ${zone}`, JSON.stringify(result))
        }
      })(),
    )
  },
}
