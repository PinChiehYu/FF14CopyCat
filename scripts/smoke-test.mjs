// 部署後的冒煙測試：確認正式站與 Worker 代理實際可用。
// 用法：node scripts/smoke-test.mjs [站台網址]
// 預設測正式站；GitHub Actions 在部署完成後執行，並以 EXPECTED_SCRIPT 確認已換成本次建置。

const SITE = (process.argv[2] ?? 'https://pinchiehyu.github.io/FF14CopyCat/').replace(/\/?$/, '/')
const API = 'https://ff14-copycat-api.ff14-copycat.workers.dev'
const ORIGIN = new URL(SITE).origin
// 公開測試報告：Sugar Riot，fight 11 為擊殺
const REPORT = 'WATKBdHRh7m8PNQt'

let failed = 0

async function check(name, fn, { retries = 0, delayMs = 10_000 } = {}) {
  for (let attempt = 0; ; attempt++) {
    try {
      const detail = await fn()
      console.log(`✓ ${name}${detail ? ` — ${detail}` : ''}`)
      return
    } catch (err) {
      if (attempt < retries) {
        console.log(`… ${name} 失敗（${err.message}），${delayMs / 1000} 秒後重試`)
        await new Promise((r) => setTimeout(r, delayMs))
        continue
      }
      console.error(`✗ ${name} — ${err.message}`)
      failed++
      return
    }
  }
}

async function get(url, init) {
  const res = await fetch(url, { cache: 'no-store', ...init })
  if (!res.ok) throw new Error(`${url} 回應 ${res.status}`)
  return res
}

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

let report

await check(
  '正式站載入最新建置並指向 Worker',
  async () => {
    const html = await (await get(SITE)).text()
    const script = /src="([^"]+\.js)"/.exec(html)?.[1]
    assert(script && !script.startsWith('/src/'), '頁面引用的是原始碼而非建置結果（Pages Source 是否為 GitHub Actions？）')
    const expected = process.env.EXPECTED_SCRIPT
    assert(!expected || script.endsWith(expected), `正式站仍是舊版 ${script}，預期 ${expected}`)
    const js = await (await get(new URL(script, SITE))).text()
    assert(js.includes(API), `建置檔中找不到 Worker 網址 ${API}`)
    return script
  },
  // Pages CDN 更新需要一點時間
  { retries: 6 },
)

await check('Worker 回傳報告', async () => {
  report = await (await get(`${API}/reports/${REPORT}`, { headers: { Origin: ORIGIN } })).json()
  assert(report.fights?.length > 0, '沒有 fights')
  assert(report.masterData?.actors?.length > 0, '沒有 actors')
  assert(report.masterData?.abilities?.length > 0, '沒有 abilities')
  return `${report.fights.length} 場戰鬥`
})

await check('Worker 回傳戰鬥事件（含位置）', async () => {
  const fight = report?.fights.find((f) => f.id === 11)
  assert(fight, '找不到 fight 11')
  const params = new URLSearchParams({
    fight: '11',
    start: String(fight.startTime),
    end: String(fight.endTime),
    dataType: 'Casts',
    hostility: 'Enemies',
  })
  const events = await (await get(`${API}/reports/${REPORT}/events?${params}`, { headers: { Origin: ORIGIN } })).json()
  assert(events.data?.length > 0, '沒有事件')
  assert(events.data.some((e) => e.sourceResources?.x !== undefined), '事件沒有位置資料')
  return `${events.data.length} 筆`
})

await check('Worker 拒絕未允許的來源', async () => {
  const res = await fetch(`${API}/reports/${REPORT}`, { headers: { Origin: 'https://evil.example' } })
  assert(res.status === 403, `預期 403，實際 ${res.status}`)
})

if (failed) {
  console.error(`\n${failed} 項冒煙測試失敗`)
  process.exit(1)
}
console.log('\n冒煙測試全部通過')
