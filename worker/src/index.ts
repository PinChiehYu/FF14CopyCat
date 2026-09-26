import { crawl, CRAWL_ZONES } from './crawler'
import { graphqlFor, handleRequest, type CacheLike, type Context, type Env } from './handler'

// Workers 執行環境提供的快取
declare const caches: { default: CacheLike }

export default {
  fetch(request: Request, env: Env, ctx: Context): Promise<Response> {
    return handleRequest(request, env, ctx, caches.default)
  },

  // 定時觸發（wrangler.toml 的 crons）：掃描新的公開報告，更新繁中服排名資料庫
  async scheduled(_controller: unknown, env: Env, ctx: Context): Promise<void> {
    if (!env.DB) return
    const db = env.DB
    ctx.waitUntil(
      (async () => {
        for (const zone of CRAWL_ZONES) {
          const result = await crawl(db, graphqlFor(env), Date.now(), zone)
          console.log(`crawl zone ${zone}`, JSON.stringify(result))
        }
      })(),
    )
  },
}
