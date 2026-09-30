// 從繁中服排名（Worker 的 /tc-rankings）隨機挑一組同 Boss、同職業的擊殺，印出本站的測試網址（我的日誌＋參考日誌）。
// 用於定期以隨機日誌測試網站（見 scripts/ui-audit.js）。
// 用法：node scripts/random-logs.mjs [站台網址，預設正式站]
const API = 'https://ff14-copycat-api.ff14-copycat.workers.dev'
const SITE = process.argv[2] ?? 'https://pinchiehyu.github.io/FF14CopyCat/'
const HEADERS = { Origin: 'https://pinchiehyu.github.io' }
// 本季零式（CRAWL_ZONES＝68）的 Boss 與戰鬥職業
const ENCOUNTERS = [97, 98, 99, 100]
const JOBS = [
  'Paladin', 'Warrior', 'DarkKnight', 'Gunbreaker',
  'WhiteMage', 'Scholar', 'Astrologian', 'Sage',
  'Monk', 'Dragoon', 'Ninja', 'Samurai', 'Reaper', 'Viper',
  'Bard', 'Machinist', 'Dancer',
  'BlackMage', 'Summoner', 'RedMage', 'Pictomancer',
]

const pick = (list) => list[Math.floor(Math.random() * list.length)]
const fflogsUrl = (r) => `https://www.fflogs.com/reports/${r.report}#fight=${r.fight}&source=${r.actor}`

// 找到就印出；不用 process.exit()（Windows 上連線還在關閉時結束行程會觸發 libuv 斷言）
async function main() {
for (let attempt = 0; attempt < 10; attempt++) {
  const encounter = pick(ENCOUNTERS)
  const job = pick(JOBS)
  const res = await fetch(`${API}/tc-rankings?encounter=${encounter}&difficulty=101&job=${job}&minPr=0&maxPr=100`, { headers: HEADERS })
  if (!res.ok) continue
  const { rankings } = await res.json()
  // 兩筆不同報告：我的日誌取任一筆，參考取另一份報告的一筆
  if (rankings.length < 2) continue
  const mine = pick(rankings)
  const others = rankings.filter((r) => r.report !== mine.report)
  if (others.length === 0) continue
  const ref = pick(others)
  const params = (extra) => new URLSearchParams({ mine: fflogsUrl(mine), ...extra }).toString()
  console.log(JSON.stringify({
    encounter,
    job,
    mine: `${mine.name} @ ${mine.server} PR ${mine.pr}`,
    ref: `${ref.name} @ ${ref.server} PR ${ref.pr}`,
    compare: `${SITE}?${params({ ref: fflogsUrl(ref) })}`,
    solo: `${SITE}?${params({})}`,
  }, null, 2))
  return true
}
return false
}

if (!(await main())) {
  console.error('找不到可用的隨機日誌（排名資料不足或 Worker 無法連線）')
  process.exitCode = 1
}
