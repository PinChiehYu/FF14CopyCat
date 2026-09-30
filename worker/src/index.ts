import { crawl, CRAWL_ZONES, pruneGoneReports } from './crawler'
import { graphqlFor, handleRequest, setTokenStore, type CacheLike, type Context, type Env } from './handler'
import { processTimelines } from './timelines'

// Workers 執行環境提供的快取
declare const caches: { default: CacheLike }

// 確認報告是否仍公開的定時觸發（與 wrangler.toml 的 crons 一致；其餘觸發為掃描）
const PRUNE_CRON = '37 * * * *'
// 預處理已收錄擊殺的 Boss 施放與玩家能力技（timelines.ts）
const TIMELINE_CRON = '2-59/10 * * * *'

export default {
  fetch(request: Request, env: Env, ctx: Context): Promise<Response> {
    // FFLogs 權杖存在 Cloudflare 快取，同一個資料中心的 isolate 共用（重新部署後不必每個 isolate 都換權杖）
    setTokenStore(caches.default)
    return handleRequest(request, env, ctx, caches.default)
  },

  // 定時觸發（wrangler.toml 的 crons）：掃描新的公開報告，更新繁中服排名資料庫；
  // 確認已收錄的報告是否仍公開放在另一個觸發（每次執行各自有對外請求的上限）
  async scheduled(controller: { cron?: string }, env: Env, ctx: Context): Promise<void> {
    if (!env.DB) return
    setTokenStore(caches.default)
    const db = env.DB
    ctx.waitUntil(
      (async () => {
        if (controller.cron === PRUNE_CRON) {
          console.log('prune', JSON.stringify(await pruneGoneReports(db, graphqlFor(env))))
          return
        }
        if (controller.cron === TIMELINE_CRON) {
          console.log('timelines', JSON.stringify(await processTimelines(db, graphqlFor(env))))
          return
        }
        for (const zone of CRAWL_ZONES) {
          const result = await crawl(db, graphqlFor(env), Date.now(), zone)
          console.log(`crawl zone ${zone}`, JSON.stringify(result))
        }
      })(),
    )
  },
}
