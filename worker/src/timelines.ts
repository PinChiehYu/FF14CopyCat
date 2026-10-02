// 預處理已收錄的擊殺（在獨立的定時觸發中執行，index.ts）：
// 1. 每場（報告＋戰鬥）存 Boss 施放（搜尋前輩日誌的機制比對、前輩平均的對齊用），有坦克時存 MT／ST。
// 2. 前輩平均的樣本：每個 Boss×職業（坦克再分 MT／ST）×PR 區間選最多 30 筆（refreshSamples），
//    只為被選到的玩家存全部施放（含 GCD）、效果時段與死亡次數——不必每位玩家都存（見 docs/TECH_NOTES.md「前輩平均」）。
import { encodeApplications, encodeCasts, encodeWindows, type EncodedCast } from '../../src/analysis/castCodec'
import { enemyDebuffApplications, enemyDebuffWindows, selfBuffWindows } from '../../src/analysis/buffs'
import { patchAt } from '../../src/jobs/patch'
import type { FFLogsEvent, Fight } from '../../src/fflogs/types'
import { CURRENT_ENCOUNTERS, GONE_REPORT, tcRankings, type DbLike, type Graphql, type StatementLike } from './crawler'
import { AUTO_ATTACKS_TAKEN_QUERY, CRON_EVENTS_QUERY } from './queries'

// Workers 免費方案每次執行最多 50 個對外請求（含權杖與點數查詢），預留幾個
const SUBREQUEST_BUDGET = 46
// 每場最多用到的請求數（敵方施放最多 2 頁，加上 MT／ST）
const REQUESTS_PER_PULL = 3
// 每位樣本最多用到的請求數（該玩家的全部事件最多 3 頁）
const REQUESTS_PER_SAMPLE = 3
// Workers 免費方案每次執行只有 10 ms CPU（超過即中斷、不寫入任何結果）：每次只做一小部分，改以較高頻率執行（index.ts）。
// 實測（docs/TECH_NOTES.md）：每次 2 位樣本＋3 場時 CPU 10～15 ms（含每個對外請求與 D1 呼叫的開銷），改為每分鐘 1 位＋2 場
// 每次最多處理幾位樣本與幾場新場次
export const SAMPLES_PER_RUN = 1
export const PULLS_PER_RUN = 2
// 樣本只用到這些事件（playerCasts、selfBuffWindows、enemyDebuffWindows、enemyDebuffApplications 與死亡次數）；
// 只抓這些，存下的資料與抓全部事件時逐字相同（以 6 份日誌驗證，見 docs/TECH_NOTES.md）
const SAMPLE_EVENT_TYPES = ['cast', 'combatantinfo', 'applybuff', 'removebuff', 'applydebuff', 'removedebuff', 'refreshdebuff', 'death']
const SAMPLE_TYPES_FILTER = `type in (${SAMPLE_EVENT_TYPES.map((t) => `'${t}'`).join(', ')})`
/** 再只取該玩家自己施放的（隊友給的效果、治療等別人以玩家為目標的事件約佔一半）；死亡事件的施放者不是玩家，另外保留 */
export const sampleEventsFilter = (actor: number) => `${SAMPLE_TYPES_FILTER} and (source.id = ${actor} or type = 'death')`
// FFLogs 不接受 source.id 時（查詢錯誤）改用只依類型過濾，這個 isolate 之後都用它（資料相同，只是多抓一些）
let sourceFilterRejected = false
// Boss 施放只用 cast（不含詠唱開始）
const BOSS_EVENTS_FILTER = "type = 'cast'"
// 這小時的點數超過此值就不處理（與排名掃描相同，留給訪客）
const POINTS_CEILING = 2000
// 事件最多翻幾頁（一頁 10,000 筆）
const MAX_PAGES = 2
const MAX_SAMPLE_PAGES = 3
// 同一技能這段時間內的施放只留一次（多個分身同時施放；對齊與機制比對也以 1 秒去重）
const DEDUPE_MS = 1000
// 普通攻擊（Attack、Shot）不是玩家操作的技能
const AUTO_ATTACKS = new Set([7, 8])
const TANKS = new Set(['Paladin', 'Warrior', 'DarkKnight', 'Gunbreaker'])

/** 前輩平均的 PR 區間（固定三組，不開放微調） */
export type Tier = 'top' | 'upper' | 'mid'
export const TIERS: Record<Tier, [number, number]> = { top: [95, 100], upper: [75, 94], mid: [50, 74] }
// 每個區間最多幾筆樣本
export const SAMPLES_PER_TIER = 30
// 已選的樣本 PR 在區間前後這麼多以內就保留（避免在邊界的擊殺每小時進進出出）
const PR_BUFFER = 3
// 目前版本的擊殺少於這麼多筆時，用舊版本補
const MIN_CURRENT_PATCH = 10
// 選樣本的那次定時工作重新選幾個 Boss×職業（依序輪替，D1 讀取額度與 CPU 時間有限）
export const COMBOS_PER_RUN = 1

const POINTS_QUERY = /* GraphQL */ `query { rateLimitData { pointsSpentThisHour } }`

interface RawEvent {
  timestamp: number
  type: string
  sourceID?: number
  targetID?: number
  abilityGameID?: number
}

/** Boss 施放：敵方的 cast 事件，同一技能 1 秒內只留一次（戰鬥時間）。 */
export function bossTimeline(events: RawEvent[], fightStart: number): EncodedCast[] {
  const last = new Map<number, number>()
  const casts: EncodedCast[] = []
  for (const e of [...events].sort((a, b) => a.timestamp - b.timestamp)) {
    if (e.type !== 'cast' || e.abilityGameID === undefined) continue
    const t = e.timestamp - fightStart
    const prev = last.get(e.abilityGameID)
    if (prev !== undefined && t - prev < DEDUPE_MS) continue
    last.set(e.abilityGameID, t)
    casts.push({ t, abilityId: e.abilityGameID })
  }
  return casts
}

/** 一位玩家的全部施放（GCD、能力技與道具；不含普通攻擊），戰鬥時間。 */
export function playerCasts(events: RawEvent[], fightStart: number, actor: number): EncodedCast[] {
  return events
    .filter((e) => e.type === 'cast' && e.sourceID === actor && e.abilityGameID !== undefined && !AUTO_ATTACKS.has(e.abilityGameID))
    .map((e) => ({ t: e.timestamp - fightStart, abilityId: e.abilityGameID! }))
}

/** 坦克的 MT／ST：承受的 Boss 普通攻擊傷害在全隊最多者為 MT。 */
export function tankSlot(actor: number, autoAttacksTaken: { id: number; total: number }[]): 'MT' | 'ST' {
  const own = autoAttacksTaken.find((e) => e.id === actor)?.total ?? 0
  return autoAttacksTaken.every((e) => e.total <= own) && own > 0 ? 'MT' : 'ST'
}

/**
 * 已預處理場次的 Boss 施放：`{ "報告:戰鬥": 編碼字串 }`；沒有預處理（或報告已不公開，boss 為空）的不回傳。
 */
export async function storedTimelines(db: DbLike, pulls: { report: string; fight: number }[]): Promise<Record<string, string>> {
  if (pulls.length === 0) return {}
  const { results } = await db
    .prepare(
      `SELECT report, fight, boss FROM pull_timelines WHERE boss != '' AND (report, fight) IN (VALUES ${pulls.map(() => '(?, ?)').join(', ')})`,
    )
    .bind(...pulls.flatMap((p) => [p.report, p.fight]))
    .all<{ report: string; fight: number; boss: string }>()
  return Object.fromEntries(results.map((r) => [`${r.report}:${r.fight}`, r.boss]))
}

// ---- 選樣本 ----

/** 選樣本的候選：一場擊殺與它目前的 PR */
export interface Candidate {
  report: string
  fight: number
  actor: number
  name: string
  server: string
  rdps: number
  pr: number
  /** 繁中服版本（src/jobs/patch.ts） */
  patch: string
}

const sampleKey = (c: { report: string; fight: number; actor: number }) => `${c.report}:${c.fight}:${c.actor}`
const playerKey = (c: { name: string; server: string }) => `${c.name}@${c.server}`

/** 從依 rDPS 排序的清單中平均取 k 筆（涵蓋整個區間，不只取最高的幾筆） */
function spread<T>(list: T[], k: number): T[] {
  if (k <= 0) return []
  if (k >= list.length) return list
  if (k === 1) return [list[Math.floor(list.length / 2)]]
  return Array.from({ length: k }, (_, i) => list[Math.round((i * (list.length - 1)) / (k - 1))])
}

/**
 * 選一個 PR 區間的樣本（每位玩家最多一筆）：
 * - 穩定選取：之前選過、PR 仍在區間 ±PR_BUFFER 內的保留；
 * - 不足 size 筆時從區間內其他玩家補，依 rDPS 平均分布；
 * - 目前版本的擊殺 ≥ MIN_CURRENT_PATCH 筆時只用目前版本，否則舊版本一起用。
 * @param candidates 候選（已排除死亡的樣本、坦克已篩選 MT／ST）
 * @param previous 這個區間之前選的樣本
 */
export function selectTier(candidates: Candidate[], previous: { report: string; fight: number; actor: number }[], tier: [number, number], currentPatch: string, size = SAMPLES_PER_TIER): Candidate[] {
  const [min, max] = tier
  const within = (c: Candidate, pad: number) => c.pr >= min - pad && c.pr <= max + pad
  const byRdps = [...candidates].sort((a, b) => b.rdps - a.rdps)
  const currentCount = new Set(byRdps.filter((c) => within(c, 0) && c.patch === currentPatch).map(playerKey)).size
  const patchOk = (c: Candidate) => currentCount < MIN_CURRENT_PATCH || c.patch === currentPatch
  const before = new Set(previous.map(sampleKey))
  const players = new Set<string>()
  const kept: Candidate[] = []
  for (const c of byRdps) {
    if (kept.length >= size) break
    if (!before.has(sampleKey(c)) || !within(c, PR_BUFFER) || !patchOk(c) || players.has(playerKey(c))) continue
    kept.push(c)
    players.add(playerKey(c))
  }
  // 補足：區間內其他玩家（每人取區間內 rDPS 最高的一場）
  const pool: Candidate[] = []
  for (const c of byRdps) {
    if (!within(c, 0) || !patchOk(c) || players.has(playerKey(c))) continue
    pool.push(c)
    players.add(playerKey(c))
  }
  return [...kept, ...spread(pool, size - kept.length)].sort((a, b) => b.rdps - a.rdps)
}

type Combo = { encounter: number; difficulty: number; job: string }

/**
 * parses_rdps 索引順序中 after 之後的下一個本季 Boss×職業（沒有 after 時為第一個）；以索引查詢只讀一列，不掃整個 parses。
 * 只選本季的 Boss（CURRENT_ENCOUNTERS）：parses 也有舊副本的擊殺，依編號排序時會先輪到它們
 */
async function nextCombo(db: DbLike, after: Combo | null): Promise<Combo | null> {
  // 逐個 Boss 以「encounter = ? AND (difficulty, job) > (?, ?)」查：IN 搭配列值比較時 SQLite 不會用後者定位，會從頭讀起
  const order = 'ORDER BY difficulty, job LIMIT 1'
  for (const encounter of [...CURRENT_ENCOUNTERS].sort((a, b) => a - b)) {
    if (after && encounter < after.encounter) continue
    const next =
      after && encounter === after.encounter
        ? await db
            .prepare(`SELECT encounter, difficulty, job FROM parses WHERE encounter = ? AND (difficulty, job) > (?, ?) ${order}`)
            .bind(encounter, after.difficulty, after.job)
            .first<Combo>()
        : await db.prepare(`SELECT encounter, difficulty, job FROM parses WHERE encounter = ? ${order}`).bind(encounter).first<Combo>()
    if (next) return next
  }
  return null
}

function parseCombo(value: string | undefined): Combo | null {
  try {
    const [encounter, difficulty, job] = JSON.parse(value ?? '') as [number, number, string]
    return typeof encounter === 'number' && typeof difficulty === 'number' && typeof job === 'string' ? { encounter, difficulty, job } : null
  } catch {
    return null
  }
}

/**
 * 依序輪替重新選幾個 Boss×職業的樣本（每次 COMBOS_PER_RUN 組），並清掉不再是樣本的預處理資料。
 * D1 免費方案每天只能寫 10 萬列、讀 500 萬列：只寫有變動的樣本（新選的、換掉的、PR 變了的），不整組重寫。
 * 回傳這次處理的組數。
 */
export async function refreshSamples(db: DbLike, now: number, combosPerRun = COMBOS_PER_RUN): Promise<number> {
  const cursorRow = await db.prepare("SELECT value FROM crawl_state WHERE key = 'samples_cursor'").first<{ value: string }>()
  let cursor = parseCombo(cursorRow?.value)
  const combos: Combo[] = []
  while (combos.length < combosPerRun) {
    const next = (await nextCombo(db, cursor)) ?? (await nextCombo(db, null))
    // 組數比 combosPerRun 少時，繞回已處理的組就停
    if (!next || combos.some((c) => c.encounter === next.encounter && c.difficulty === next.difficulty && c.job === next.job)) break
    combos.push(next)
    cursor = next
  }
  if (combos.length === 0) return 0
  const currentPatch = patchAt(now).key
  const writes: StatementLike[] = []
  // 有死亡（或報告已不公開）的不再選（部分索引 sample_data_excluded，只讀這些列）
  const excluded = new Set(
    (await db.prepare('SELECT report, fight, actor FROM sample_data WHERE deaths != 0').all<{ report: string; fight: number; actor: number }>()).results.map(
      sampleKey,
    ),
  )
  for (const { encounter, difficulty, job } of combos) {
    const { rankings } = await tcRankings(db, encounter, difficulty, job, TIERS.mid[0] - PR_BUFFER, 100, Number.MAX_SAFE_INTEGER)
    const scope = [encounter, difficulty, job]
    const inCombo = 'p.encounter = ? AND p.difficulty = ? AND p.job = ?'
    const slots = new Map(
      TANKS.has(job)
        ? (
            await db
              .prepare(`SELECT t.report, t.fight, t.actor, t.slot FROM tank_slots t JOIN parses p USING (report, fight, actor) WHERE ${inCombo}`)
              .bind(...scope)
              .all<{ report: string; fight: number; actor: number; slot: string }>()
          ).results.map((r) => [sampleKey(r), r.slot])
        : [],
    )
    const previous = (
      await db
        .prepare('SELECT slot, tier, report, fight, actor, pr FROM average_samples WHERE encounter = ? AND difficulty = ? AND job = ?')
        .bind(...scope)
        .all<{ slot: string; tier: Tier; report: string; fight: number; actor: number; pr: number }>()
    ).results
    const previousTiers = new Map(
      (
        await db
          .prepare('SELECT slot, tier, candidates FROM sample_tiers WHERE encounter = ? AND difficulty = ? AND job = ?')
          .bind(...scope)
          .all<{ slot: string; tier: Tier; candidates: number }>()
      ).results.map((t) => [`${t.slot}|${t.tier}`, t.candidates]),
    )
    const candidates: Candidate[] = rankings
      .filter((r) => !excluded.has(sampleKey(r)))
      .map((r) => ({ report: r.report, fight: r.fight, actor: r.actor, name: r.name, server: r.server, rdps: r.rdps, pr: r.pr, patch: patchAt(r.reportStart + r.fightStart).key }))
    const sampleRow = 'encounter = ? AND difficulty = ? AND job = ? AND slot = ? AND tier = ? AND report = ? AND fight = ? AND actor = ?'
    // 這一組選完後仍是樣本的玩家（任一區間），其餘換掉的刪除預處理資料
    const stillSampled = new Set<string>()
    // 坦克的 MT／ST 分開選（還沒判斷 MT／ST 的場次先不選）
    for (const slot of TANKS.has(job) ? ['MT', 'ST'] : ['']) {
      const pool = slot ? candidates.filter((c) => slots.get(sampleKey(c)) === slot) : candidates
      for (const tier of Object.keys(TIERS) as Tier[]) {
        const range = TIERS[tier]
        const before = previous.filter((p) => p.slot === slot && p.tier === tier)
        const picked = selectTier(pool, before, range, currentPatch)
        const pickedKeys = new Set(picked.map(sampleKey))
        const beforeByKey = new Map(before.map((p) => [sampleKey(p), p]))
        let changed = false
        for (const p of before) {
          if (pickedKeys.has(sampleKey(p))) continue
          changed = true
          writes.push(db.prepare(`DELETE FROM average_samples WHERE ${sampleRow}`).bind(encounter, difficulty, job, slot, tier, p.report, p.fight, p.actor))
        }
        for (const c of picked) {
          stillSampled.add(sampleKey(c))
          const old = beforeByKey.get(sampleKey(c))
          if (old) {
            if (old.pr !== c.pr) writes.push(db.prepare(`UPDATE average_samples SET pr = ? WHERE ${sampleRow}`).bind(c.pr, encounter, difficulty, job, slot, tier, c.report, c.fight, c.actor))
            continue
          }
          changed = true
          writes.push(
            db
              .prepare(
                `INSERT INTO average_samples (encounter, difficulty, job, slot, tier, report, fight, actor, name, server, rdps, pr, patch, selected_at, pending)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOT EXISTS (SELECT 1 FROM sample_data d WHERE d.report = ? AND d.fight = ? AND d.actor = ?))`,
              )
              .bind(encounter, difficulty, job, slot, tier, c.report, c.fight, c.actor, c.name, c.server, c.rdps, c.pr, c.patch, now, c.report, c.fight, c.actor),
          )
          // 樣本要有 Boss 施放才能用：該場還沒預處理時排到最前面
          writes.push(db.prepare('UPDATE pull_queue SET priority = 1 WHERE report = ? AND fight = ?').bind(c.report, c.fight))
        }
        // 候選人數或樣本有變才更新（updated_at 為樣本最近一次變動的時間）
        const inTier = pool.filter((c) => c.pr >= range[0] && c.pr <= range[1]).length
        if (changed || previousTiers.get(`${slot}|${tier}`) !== inTier) {
          writes.push(
            db
              .prepare('INSERT OR REPLACE INTO sample_tiers (encounter, difficulty, job, slot, tier, candidates, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
              .bind(encounter, difficulty, job, slot, tier, inTier, now),
          )
        }
      }
    }
    // 不再是樣本的預處理資料刪掉（有死亡的保留當作記號，內容已清空）
    const removed = new Map(previous.filter((p) => !stillSampled.has(sampleKey(p))).map((p) => [sampleKey(p), p]))
    for (const p of removed.values()) {
      writes.push(db.prepare('DELETE FROM sample_data WHERE report = ? AND fight = ? AND actor = ? AND deaths = 0').bind(p.report, p.fight, p.actor))
    }
  }
  const last = combos[combos.length - 1]
  writes.push(
    db
      .prepare("INSERT OR REPLACE INTO crawl_state (key, value) VALUES ('samples_cursor', ?)")
      .bind(JSON.stringify([last.encounter, last.difficulty, last.job])),
  )
  await db.batch(writes)
  return combos.length
}

// ---- 預處理 ----

export interface TimelineResult {
  skipped?: string
  /** 這次重新選樣本的 Boss×職業組數 */
  selected: number
  /** 處理的場次（Boss 施放、MT／ST） */
  pulls: number
  /** 處理的樣本（全部施放、效果與死亡） */
  samples: number
  failed: number
  /** 這次用掉的 FFLogs 點數（前後兩次查詢的差；同一小時內其他請求也會算進去） */
  points?: number
}

interface PullRow {
  report: string
  fight: number
  actor: number
  job: string
  fight_start: number
  fight_end: number
}

type Pull = { report: string; fight: number; start: number; end: number; tanks: number[] }

/** 尚未預處理的場次（pull_queue：含樣本的優先，其次最近的報告）與其中已收錄的坦克；依索引只讀要處理的幾場。 */
async function pendingPulls(db: DbLike, limit: number): Promise<Pull[]> {
  if (limit <= 0) return []
  const { results } = await db
    .prepare(
      `SELECT q.report, q.fight, p.actor, p.job, p.fight_start, p.fight_end
       FROM (SELECT report, fight, priority, report_start FROM pull_queue ORDER BY priority DESC, report_start DESC LIMIT ?) q
       JOIN parses p ON p.report = q.report AND p.fight = q.fight
       ORDER BY q.priority DESC, q.report_start DESC, q.report, q.fight`,
    )
    .bind(limit)
    .all<PullRow>()
  const pulls = new Map<string, Pull>()
  for (const row of results) {
    const key = `${row.report}/${row.fight}`
    const pull = pulls.get(key) ?? { report: row.report, fight: row.fight, start: row.fight_start, end: row.fight_end, tanks: [] }
    if (TANKS.has(row.job)) pull.tanks.push(row.actor)
    pulls.set(key, pull)
  }
  return [...pulls.values()]
}

/** 尚未預處理的樣本（最早選的優先）；部分索引 average_samples_pending 只讀要處理的幾列 */
async function pendingSamples(db: DbLike, limit: number) {
  if (limit <= 0) return []
  const { results } = await db
    .prepare(
      // 同一場擊殺可能同時在兩個區間（邊界的緩衝），多取一些再去重
      `SELECT s.report, s.fight, s.actor, p.fight_start, p.fight_end
       FROM (SELECT report, fight, actor, selected_at FROM average_samples WHERE pending = 1 ORDER BY selected_at LIMIT ?) s
       JOIN parses p USING (report, fight, actor)
       ORDER BY s.selected_at, s.report, s.fight, s.actor`,
    )
    .bind(limit * 2)
    .all<{ report: string; fight: number; actor: number; fight_start: number; fight_end: number }>()
  const unique = new Map(results.map((r) => [sampleKey(r), r]))
  return [...unique.values()].slice(0, limit)
}

async function fetchEvents(
  graphql: Graphql,
  pull: { report: string; fight: number; start: number; end: number },
  variables: { hostilityType?: 'Enemies' | 'Friendlies'; dataType: string; sourceID?: number; filterExpression: string },
  maxPages = MAX_PAGES,
): Promise<RawEvent[]> {
  const events: RawEvent[] = []
  let start: number | null = pull.start
  for (let page = 0; start !== null && page < maxPages; page++) {
    const data: { reportData?: { report?: { events?: { data?: RawEvent[]; nextPageTimestamp?: number | null } } } } | undefined =
      await graphql(CRON_EVENTS_QUERY, { code: pull.report, fightIDs: [pull.fight], startTime: start, endTime: pull.end, ...variables })
    const got: { data?: RawEvent[]; nextPageTimestamp?: number | null } | undefined = data?.reportData?.report?.events
    events.push(...(got?.data ?? []))
    start = got?.nextPageTimestamp ?? null
  }
  return events
}

/** 存一場的 Boss 施放並移出待處理佇列 */
const bossRows = (db: DbLike, report: string, fight: number, boss: string, now: number) => [
  db.prepare('INSERT OR REPLACE INTO pull_timelines (report, fight, boss, processed_at) VALUES (?, ?, ?, ?)').bind(report, fight, boss, now),
  db.prepare('DELETE FROM pull_queue WHERE report = ? AND fight = ?').bind(report, fight),
]

/** 樣本已預處理（含排除的）：不再列為待處理 */
const sampleDone = (db: DbLike, s: { report: string; fight: number; actor: number }) =>
  db.prepare('UPDATE average_samples SET pending = 0 WHERE report = ? AND fight = ? AND actor = ?').bind(s.report, s.fight, s.actor)

/** 一次定時工作的工作量 */
export interface TimelineWork {
  /** 重新選樣本的 Boss×職業組數 */
  combos: number
  /** 預處理的樣本與新場次數上限 */
  samples: number
  pulls: number
}

/**
 * 依排定的時間（分鐘）決定這次的工作：每 10 分鐘一次只選樣本（讀 D1 較多），其餘只預處理。
 * 分開執行是為了讓每次的 CPU 時間都在免費方案的 10 ms 內。
 */
export function timelineWork(minute: number): TimelineWork {
  return minute % 10 === 0 ? { combos: COMBOS_PER_RUN, samples: 0, pulls: 0 } : { combos: 0, samples: SAMPLES_PER_RUN, pulls: PULLS_PER_RUN }
}

/**
 * 一次定時工作：重新選一部分組合的樣本 → 預處理新選到的樣本 → 用剩下的請求預處理新場次（含樣本的場次優先，樣本要有 Boss 施放才能用）。
 * 報告已私人化或刪除的場次記錄為空（boss 為空字串、樣本 deaths 為 -1）、不再重試；報告被移除時由 pruneGoneReports() 一併刪除。
 */
export async function processTimelines(
  db: DbLike,
  query: Graphql,
  now = Date.now(),
  work: TimelineWork = { combos: COMBOS_PER_RUN, samples: SAMPLES_PER_RUN, pulls: PULLS_PER_RUN },
): Promise<TimelineResult> {
  const result: TimelineResult = { selected: 0, pulls: 0, samples: 0, failed: 0 }
  let requests = 0
  const graphql: Graphql = (q, v) => {
    requests++
    return query(q, v)
  }
  result.selected = work.combos > 0 ? await refreshSamples(db, now, work.combos) : 0
  if (work.samples + work.pulls === 0) return result
  const points = await graphql<{ rateLimitData?: { pointsSpentThisHour: number } }>(POINTS_QUERY, {})
  if ((points?.rateLimitData?.pointsSpentThisHour ?? 0) > POINTS_CEILING) {
    result.skipped = 'points'
    return result
  }

  const writes: StatementLike[] = []
  // 樣本：該玩家的全部事件（施放、自身效果、對敵人施加的效果、死亡）
  for (const s of await pendingSamples(db, Math.min(work.samples, Math.floor((SUBREQUEST_BUDGET - requests) / REQUESTS_PER_SAMPLE)))) {
    if (requests + REQUESTS_PER_SAMPLE > SUBREQUEST_BUDGET) {
      result.skipped = 'subrequests'
      break
    }
    const pull = { report: s.report, fight: s.fight, start: s.fight_start, end: s.fight_end }
    try {
      const sampleEvents = (filterExpression: string) => fetchEvents(graphql, pull, { dataType: 'All', sourceID: s.actor, filterExpression }, MAX_SAMPLE_PAGES)
      let raw: RawEvent[]
      if (sourceFilterRejected) raw = await sampleEvents(SAMPLE_TYPES_FILTER)
      else {
        try {
          raw = await sampleEvents(sampleEventsFilter(s.actor))
        } catch (err) {
          if (GONE_REPORT.test(err instanceof Error ? err.message : String(err))) throw err
          console.warn(`source filter failed, falling back to type filter: ${err instanceof Error ? err.message : String(err)}`)
          sourceFilterRejected = true
          raw = await sampleEvents(SAMPLE_TYPES_FILTER)
        }
      }
      const events = raw as FFLogsEvent[]
      const fight = { startTime: s.fight_start, endTime: s.fight_end } as Fight
      const deaths = events.filter((e) => e.type === 'death' && e.targetID === s.actor).length
      // 有死亡的樣本排除：只留死亡次數當作記號
      const [casts, buffs, applications] =
        deaths > 0
          ? ['', '', '']
          : [
              encodeCasts(playerCasts(events, s.fight_start, s.actor)),
              encodeWindows([...selfBuffWindows(events, fight, s.actor), ...enemyDebuffWindows(events, fight, s.actor)]),
              encodeApplications(enemyDebuffApplications(events, fight, s.actor)),
            ]
      writes.push(
        db
          .prepare('INSERT OR REPLACE INTO sample_data (report, fight, actor, casts, buffs, applications, deaths, processed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
          .bind(s.report, s.fight, s.actor, casts, buffs, applications, deaths, now),
        sampleDone(db, s),
      )
      result.samples++
    } catch (err) {
      result.failed++
      const message = err instanceof Error ? err.message : String(err)
      console.warn(`sample ${s.report}/${s.fight}/${s.actor} failed: ${message}`)
      if (GONE_REPORT.test(message)) {
        writes.push(
          db
            .prepare("INSERT OR REPLACE INTO sample_data (report, fight, actor, casts, buffs, applications, deaths, processed_at) VALUES (?, ?, ?, '', '', '', -1, ?)")
            .bind(s.report, s.fight, s.actor, now),
          sampleDone(db, s),
        )
      }
    }
  }

  // 新場次：Boss 施放，有坦克時判斷 MT／ST
  for (const pull of await pendingPulls(db, Math.min(work.pulls, Math.floor((SUBREQUEST_BUDGET - requests) / REQUESTS_PER_PULL)))) {
    if (requests + REQUESTS_PER_PULL > SUBREQUEST_BUDGET) {
      result.skipped = 'subrequests'
      break
    }
    try {
      const enemies = await fetchEvents(graphql, pull, { hostilityType: 'Enemies', dataType: 'Casts', filterExpression: BOSS_EVENTS_FILTER })
      if (pull.tanks.length > 0) {
        const data = await graphql<{ reportData?: { report?: { table?: { data?: { entries?: { id: number; total: number }[] } } } } }>(
          AUTO_ATTACKS_TAKEN_QUERY,
          { code: pull.report, fightIDs: [pull.fight] },
        )
        const autoAttacks = data?.reportData?.report?.table?.data?.entries ?? []
        for (const actor of pull.tanks) {
          writes.push(
            db
              .prepare('INSERT OR REPLACE INTO tank_slots (report, fight, actor, slot) VALUES (?, ?, ?, ?)')
              .bind(pull.report, pull.fight, actor, tankSlot(actor, autoAttacks)),
          )
        }
      }
      writes.push(...bossRows(db, pull.report, pull.fight, encodeCasts(bossTimeline(enemies, pull.start)), now))
      result.pulls++
    } catch (err) {
      result.failed++
      const message = err instanceof Error ? err.message : String(err)
      console.warn(`timeline ${pull.report}/${pull.fight} failed: ${message}`)
      // 報告已私人化或刪除：記錄為空，不再重試；其他錯誤（額度、網路）下次再試
      if (GONE_REPORT.test(message)) writes.push(...bossRows(db, pull.report, pull.fight, '', now))
    }
  }
  if (writes.length > 0) await db.batch(writes)
  // 這次用掉的點數（記錄在 log，調整頻率用）
  if (result.pulls + result.samples + result.failed > 0) {
    const after = await graphql<{ rateLimitData?: { pointsSpentThisHour: number } }>(POINTS_QUERY, {}).catch(() => undefined)
    const before = points?.rateLimitData?.pointsSpentThisHour
    const spent = after?.rateLimitData?.pointsSpentThisHour
    if (before !== undefined && spent !== undefined && spent >= before) result.points = spent - before
  }
  return result
}

// ---- 讀取 ----

export interface AverageSample {
  name: string
  server: string
  report: string
  fight: number
  actor: number
  pr: number
  rdps: number
  patch: string
  /** 戰鬥長度（毫秒） */
  duration: number
  /** Boss 施放、玩家施放、效果時段、施加效果（src/analysis/castCodec.ts 的編碼） */
  boss: string
  casts: string
  buffs: string
  applications: string
}

/**
 * 一個區間的前輩平均樣本（已預處理、沒有死亡、該場有 Boss 施放的），依 rDPS 由高到低；
 * count 為區間內的擊殺數，updatedAt 為最近一次選樣本的時間（還沒選過時為 null）。
 */
export async function averageSamples(
  db: DbLike,
  scope: { encounter: number; difficulty: number; job: string; slot: string; tier: Tier },
): Promise<{ count: number; updatedAt: number | null; samples: AverageSample[] }> {
  const bind = [scope.encounter, scope.difficulty, scope.job, scope.slot, scope.tier]
  const meta = await db
    .prepare('SELECT candidates, updated_at FROM sample_tiers WHERE encounter = ? AND difficulty = ? AND job = ? AND slot = ? AND tier = ?')
    .bind(...bind)
    .first<{ candidates: number; updated_at: number }>()
  const { results } = await db
    .prepare(
      `SELECT s.name, s.server, s.report, s.fight, s.actor, s.pr, s.rdps, s.patch, p.fight_end - p.fight_start AS duration,
         t.boss, d.casts, d.buffs, d.applications
       FROM average_samples s
       JOIN parses p USING (report, fight, actor)
       JOIN sample_data d USING (report, fight, actor)
       JOIN pull_timelines t ON t.report = s.report AND t.fight = s.fight
       WHERE s.encounter = ? AND s.difficulty = ? AND s.job = ? AND s.slot = ? AND s.tier = ? AND d.deaths = 0 AND t.boss != ''
       ORDER BY s.rdps DESC`,
    )
    .bind(...bind)
    .all<AverageSample>()
  return { count: meta?.candidates ?? 0, updatedAt: meta?.updated_at ?? null, samples: results }
}
