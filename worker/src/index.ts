import { crawl, CRAWL_ZONES, pruneGoneReports } from './crawler'
import { graphqlFor, handleRequest, setTokenStore, type CacheLike, type Context, type Env } from './handler'
import { processTimelines, timelineWork } from './timelines'

// Workers 執行環境提供的快取
declare const caches: { default: CacheLike }

// 定時觸發（與 wrangler.toml 的 crons 一致）。Workers 免費方案每次執行只有 10 ms CPU（超過即中斷、不寫入任何結果），
// 所以每次只做一小部分、以較高頻率執行：
// 掃描新的公開報告：每 10 分鐘一頁（7、17…57 分）
const CRAWL_CRON = '7-59/10 * * * *'
// 確認報告是否仍公開：每 10 分鐘（5、15…55 分）
const PRUNE_CRON = '5-59/10 * * * *'
// 預處理已收錄擊殺的 Boss 施放與樣本（timelines.ts）：'* * * * *' 每分鐘，整 10 分鐘的那一次改為選樣本（其餘觸發，見 scheduled()）
// 掃描一次最多查幾份繁中服報告的傷害表（一份可能有多場擊殺，傷害表較大）
const CRAWL_REPORTS_PER_RUN = 5

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
          return
        }
        // 其餘觸發一律預處理：改排程後 Cloudflare 可能還會以舊的排程字串觸發一段時間（2026-10-02 實測超過 15 分鐘），
        // 不依賴字串完全相同；工作量依分鐘決定，與觸發頻率無關
        if (controller.cron !== CRAWL_CRON) {
          console.log('timelines', JSON.stringify(await processTimelines(db, graphqlFor(env), Date.now(), timelineWork(minute))))
          return
        }
        // 還在補舊資料時，最近兩天與補舊資料輪流（17、37、57 分補舊資料）
        const backfillOnly = Math.floor(minute / 10) % 2 === 1
        for (const zone of CRAWL_ZONES) {
          const result = await crawl(db, graphqlFor(env), Date.now(), zone, { pages: 1, backfillOnly, maxRequests: 1 + CRAWL_REPORTS_PER_RUN })
          console.log(`crawl zone ${zone}`, JSON.stringify(result))
        }
      })(),
    )
  },
}
