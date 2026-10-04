// 定時觸發的排程字串（與 wrangler.toml 的 crons 一致；index.node.test.ts 檢查）。Workers 免費方案每次執行只有 10 ms CPU
// （超過即中斷、不寫入任何結果），所以每次只做一小部分、以較高頻率執行：
// 掃描新的公開報告：每 5 分鐘一頁（2、7、12…57 分）
export const CRAWL_CRON = '2-59/5 * * * *'
// 確認報告是否仍公開：每 10 分鐘（5、15…55 分）
export const PRUNE_CRON = '5-59/10 * * * *'
// 預處理已收錄擊殺的 Boss 施放與樣本（timelines.ts）：'* * * * *' 每分鐘，整 10 分鐘的那一次改為選樣本（其餘觸發，見 index.ts 的 scheduled()）
export const TIMELINES_CRON = '* * * * *'
// 掃描一次最多查幾份繁中服報告的傷害表（一份可能有多場擊殺，傷害表較大；5 份時實測 CPU 27 ms）。
// 一頁還有沒查的繁中服報告時，下次重新列出同一頁（已處理的跳過）
export const CRAWL_REPORTS_PER_RUN = 2
