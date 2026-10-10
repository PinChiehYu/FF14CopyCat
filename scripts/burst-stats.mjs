// 爆發技的資料驗證：以繁中服高 PR 擊殺統計每個職業的冷卻技「用在隊友團隊 Buff 期間」的比例，
// 作為 src/jobs/burstRules.ts 的依據（結果記在 TECH_NOTES.md「爆發技的資料驗證」）。只讀，經已部署的 Worker 查 FFLogs。
// 用法：node scripts/burst-stats.mjs [職業…]（不指定時跑全部 21 職業；每職業每個 Boss 取 PR 95+ 的前 2 場，共約 8 場）
// 請求約每 1.5 秒一個（Worker 每 IP 每分鐘 60 次的限制內）；全部職業約 700 個請求、20 分鐘。
const API = 'https://ff14-copycat-api.ff14-copycat.workers.dev'
const HEADERS = { Origin: 'https://pinchiehyu.github.io' }
const ENCOUNTERS = [97, 98, 99, 100]
const PER_ENCOUNTER = 2
const JOBS = [
  'Paladin', 'Warrior', 'DarkKnight', 'Gunbreaker',
  'WhiteMage', 'Scholar', 'Astrologian', 'Sage',
  'Monk', 'Dragoon', 'Ninja', 'Samurai', 'Reaper', 'Viper',
  'Bard', 'Machinist', 'Dancer',
  'BlackMage', 'Summoner', 'RedMage', 'Pictomancer',
]
// 與 src/analysis/raidBuffs.ts 的 RAID_BUFF_NAMES 相同
const RAID_BUFFS = new Set([
  'Battle Litany', 'Divination', 'Technical Finish', 'Brotherhood', 'Searing Light', 'Arcane Circle',
  'Embolden', 'Radiant Finale', 'Battle Voice', 'Starry Muse', 'Chain Stratagem', 'Dokumori',
])
// 使用後這麼久內有隊友的團隊 Buff 就算「用在團隊 Buff 期間」（同 ACTIVE_WINDOW_MS）
const ACTIVE_MS = 5000
// 只統計一場用不到這麼多次的技能（排除 GCD 與短冷卻的能力技）
const MAX_USES = 20
// 與 burstRules.ts 的 alignAt 相同：觸發技能之後 30 秒內第一次使用的技能才是真正的爆發，另外統計它用在團隊 Buff 期間的比例
const ALIGN_AT = { 16482: [25781], 34647: [34626], 16472: [36932], 16164: [36937], 36992: [36998], 7521: [37007] }
const ALIGN_WITHIN_MS = 30_000

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let last = 0
async function get(path) {
  const wait = last + 1500 - Date.now()
  if (wait > 0) await sleep(wait)
  last = Date.now()
  for (let attempt = 0; attempt < 4; attempt++) {
    const res = await fetch(`${API}${path}`, { headers: HEADERS })
    if (res.ok) return res.json()
    if (res.status === 429 || res.status === 503 || res.status === 504) {
      await sleep(20_000 * (attempt + 1))
      continue
    }
    throw new Error(`${res.status} ${path}`)
  }
  throw new Error(`retries exhausted ${path}`)
}

async function events(code, fight, extra) {
  const all = []
  let start = fight.startTime
  while (start !== null && start !== undefined) {
    const params = new URLSearchParams({ fight: String(fight.id), start: String(start), end: String(fight.endTime), ...extra })
    const page = await get(`/reports/${code}/events?${params}`)
    all.push(...page.data)
    start = page.nextPageTimestamp
  }
  return all
}

/** 隊友（不是我）給的團隊 Buff 時段：我身上的效果與敵人身上的團隊 Debuff */
function otherRaidBuffs(playerEvents, enemyEvents, actor, nameOf) {
  const spans = []
  const open = new Map()
  const handle = (e, target, applyTypes, removeType) => {
    if (e.abilityGameID === undefined || !RAID_BUFFS.has(nameOf(e.abilityGameID))) return
    if (e.sourceID === actor) return
    const key = `${e.abilityGameID}|${e.sourceID}|${target}`
    if (applyTypes.includes(e.type)) {
      if (!open.has(key)) open.set(key, e.timestamp)
    } else if (e.type === removeType && open.has(key)) {
      spans.push([open.get(key), e.timestamp])
      open.delete(key)
    }
  }
  for (const e of playerEvents) if (e.targetID === actor) handle(e, actor, ['applybuff', 'refreshbuff'], 'removebuff')
  for (const e of enemyEvents) handle(e, e.targetID, ['applydebuff', 'refreshdebuff'], 'removedebuff')
  for (const [, start] of open) spans.push([start, Infinity])
  return spans
}

const median = (xs) => {
  if (xs.length === 0) return null
  const s = [...xs].sort((a, b) => a - b)
  return s[Math.floor(s.length / 2)]
}

async function job(name) {
  const logs = []
  for (const encounter of ENCOUNTERS) {
    const { rankings } = await get(`/tc-rankings?encounter=${encounter}&difficulty=101&job=${name}&minPr=95&maxPr=100`)
    const seen = new Set()
    for (const r of rankings) {
      if (seen.has(r.report)) continue
      seen.add(r.report)
      logs.push(r)
      if (seen.size >= PER_ENCOUNTER) break
    }
  }
  // 技能 ID → { name, uses, inBuff, intervals[], logs }
  const stats = new Map()
  for (const r of logs) {
    try {
      const report = await get(`/reports/${r.report}`)
      const fight = report.fights.find((f) => f.id === r.fight)
      const names = new Map(report.masterData.abilities.map((a) => [a.gameID, a.name]))
      const nameOf = (id) => names.get(id)
      const playerEvents = await events(r.report, fight, { source: String(r.actor), dataType: 'All' })
      const enemyEvents = await events(r.report, fight, { dataType: 'Debuffs', hostility: 'Enemies' })
      const buffs = otherRaidBuffs(playerEvents, enemyEvents, r.actor, nameOf)
      const casts = playerEvents.filter((e) => e.type === 'cast' && e.sourceID === r.actor && e.abilityGameID !== undefined)
      const byAbility = new Map()
      for (const c of casts) byAbility.set(c.abilityGameID, [...(byAbility.get(c.abilityGameID) ?? []), c.timestamp])
      for (const [trigger, follow] of Object.entries(ALIGN_AT)) {
        for (const t of byAbility.get(Number(trigger)) ?? []) {
          const next = casts.find((c) => follow.includes(c.abilityGameID) && c.timestamp >= t && c.timestamp <= t + ALIGN_WITHIN_MS)
          if (!next) continue
          const key = `${trigger}→${next.abilityGameID}`
          const s = stats.get(key) ?? { name: `${nameOf(Number(trigger))} → ${nameOf(next.abilityGameID)}`, uses: 0, inBuff: 0, intervals: [], logs: 0, aligned: true }
          s.uses++
          if (buffs.some(([a, b]) => a <= next.timestamp + ACTIVE_MS && b > next.timestamp)) s.inBuff++
          stats.set(key, s)
        }
      }
      for (const [id, times] of byAbility) {
        if (times.length > MAX_USES) continue
        const s = stats.get(id) ?? { name: nameOf(id) ?? `#${id}`, uses: 0, inBuff: 0, intervals: [], logs: 0 }
        s.logs++
        times.forEach((t, i) => {
          s.uses++
          if (buffs.some(([a, b]) => a <= t + ACTIVE_MS && b > t)) s.inBuff++
          if (i > 0) s.intervals.push(t - times[i - 1])
        })
        stats.set(id, s)
      }
    } catch (err) {
      console.error(`  skip ${r.report}#${r.fight}: ${err.message}`)
    }
  }
  // 只列一場平均用 2 次以上、間隔中位數 ≥ 50 秒的技能（冷卻技）
  const rows = [...stats.entries()]
    .map(([id, s]) => ({ id, ...s, interval: median(s.intervals) }))
    .filter((s) => s.aligned || (s.interval !== null && s.interval >= 50_000 && s.uses / s.logs >= 2))
    .sort((a, b) => b.inBuff / b.uses - a.inBuff / a.uses)
  console.log(`\n## ${name}（${logs.length} 場）`)
  console.log('| 技能 | ID | 次數 | 用在隊友團隊 Buff 期間 | 間隔中位數 |')
  console.log('|---|---|---|---|---|')
  for (const s of rows) {
    console.log(`| ${s.name} | ${s.id} | ${s.uses} | ${Math.round((s.inBuff / s.uses) * 100)}% | ${s.interval === null ? '—' : `${Math.round(s.interval / 1000)} 秒`} |`)
  }
}

async function main() {
  const targets = process.argv.slice(2).length > 0 ? process.argv.slice(2) : JOBS
  for (const name of targets) await job(name)
}
main()
