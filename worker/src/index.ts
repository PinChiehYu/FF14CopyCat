import { crawl, CRAWL_ZONES, pruneGoneReports } from './crawler'
import { graphqlFor, handleRequest, type CacheLike, type Context, type Env } from './handler'

// Workers 執行環境提供的快取
declare const caches: { default: CacheLike }

// 確認報告是否仍公開的定時觸發（與 wrangler.toml 的 crons 一致；其餘觸發為掃描）
const PRUNE_CRON = '37 * * * *'

export default {
  fetch(request: Request, env: Env, ctx: Context): Promise<Response> {
    return handleRequest(request, env, ctx, caches.default)
  },

  // 定時觸發（wrangler.toml 的 crons）：掃描新的公開報告，更新繁中服排名資料庫；
  // 確認已收錄的報告是否仍公開放在另一個觸發（每次執行各自有對外請求的上限）
  async scheduled(controller: { cron?: string }, env: Env, ctx: Context): Promise<void> {
    if (!env.DB) return
    const db = env.DB
    ctx.waitUntil(
      (async () => {
        if (controller.cron === PRUNE_CRON) {
          console.log('prune', JSON.stringify(await pruneGoneReports(db, graphqlFor(env))))
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
