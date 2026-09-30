import type { DamageHit, Death } from '../compare/load'

// 我的一擊在參考對齊後時間前後這麼久內，參考也被同一技能打中就不算多吃
export const EXTRA_HIT_WINDOW_MS = 5000
// 受傷加重、傷害降低在這一擊之前 PENALTY_BEFORE_MS 到之後 PENALTY_AFTER_MS 內施加，視為這一擊造成的懲罰：
// 懲罰在命中判定（calculateddamage）時施加，實際扣血的 damage 事件常晚 1～2 秒
const PENALTY_BEFORE_MS = 2500
const PENALTY_AFTER_MS = 1000
// 同一技能的幾擊與前一擊相距這麼近時視為同一次（同一個機制連續打幾下）
const SAME_INSTANCE_MS = 1000
// 減傷比參考少這麼多（0～1）以上才標
export const MITIGATION_GAP = 0.1
// 每次（同一機制的連續幾擊合計）平均未減傷傷害達最大血量的這個比例以上，才算值得減傷的大傷害
const BIG_HIT_SHARE = 0.15
// 死亡回顧：死前多久、最多幾擊
export const RECAP_WINDOW_MS = 10_000
const RECAP_MAX_HITS = 5

/** 受到懲罰（受傷加重、傷害降低）或多吃的一擊 */
export interface FlaggedHit {
  t: number
  abilityId: number
  amount: number
  /** 這一擊之後很快被施加受傷加重或傷害降低 */
  penalized: boolean
}

/** 同一技能在一邊的統計（只算直接傷害，不含 DoT 跳傷） */
export interface SideHits {
  count: number
  total: number
  /** 平均減傷（0～1；1 − 承受倍率，受傷加重的一擊不列入）；沒有可用的倍率時為 null */
  mitigation: number | null
}

export interface DamageRow {
  abilityId: number
  mine: SideHits
  /** 沒有參考時為 null */
  ref: SideHits | null
  /** 參考在同一時間沒有被打中的（沒有參考時：造成受傷加重／傷害降低的）；同一次機制的幾擊合併為一筆 */
  flagged: FlaggedHit[]
  /** 我的減傷比參考少 MITIGATION_GAP 以上、且是大傷害 */
  mitigationGap: boolean
  /** 我第一次被打中的時間（我的時間）；沒被打中時為 null */
  firstHit: number | null
}

const directHits = (hits: DamageHit[]) => hits.filter((h) => !h.tick)

function mitigationOf(hits: DamageHit[]): number | null {
  const ms = hits.flatMap((h) => (h.multiplier !== null && h.multiplier <= 1 ? [1 - h.multiplier] : []))
  return ms.length ? ms.reduce((a, b) => a + b, 0) / ms.length : null
}

function sideHits(hits: DamageHit[]): SideHits {
  return { count: hits.length, total: hits.reduce((sum, h) => sum + h.amount, 0), mitigation: mitigationOf(hits) }
}

function penalizedAt(t: number, penaltyTimes: number[]): boolean {
  return penaltyTimes.some((p) => p >= t - PENALTY_BEFORE_MS && p <= t + PENALTY_AFTER_MS)
}

/** 依時間分成幾次：與前一擊相距 SAME_INSTANCE_MS 內的算同一次（同一個機制連續打幾下） */
function chains<T extends { t: number }>(list: T[]): T[][] {
  const out: T[][] = []
  for (const h of list) {
    const last = out.at(-1)
    if (last && h.t - last.at(-1)!.t <= SAME_INSTANCE_MS) last.push(h)
    else out.push([h])
  }
  return out
}

/** 同一次機制的幾擊合併為一筆（時間取第一擊、傷害相加） */
function instances(list: FlaggedHit[]): FlaggedHit[] {
  return chains(list).map((c) => ({ ...c[0], amount: c.reduce((s, h) => s + h.amount, 0), penalized: c.some((h) => h.penalized) }))
}

/**
 * 依技能整理兩邊受到的直接傷害（DoT 跳傷另計，普通攻擊不判斷多吃）：
 * - 有參考：我被打中的次數（同一機制的幾擊算一次）比參考多時，才找出多吃的：
 *   在對齊後時間 ±EXTRA_HIT_WINDOW_MS 內參考沒有被同一技能打中的，最多列出次數差（優先列受到懲罰的）。
 *   次數相同但時間不同多半是隨機點名或對齊誤差，不算。
 *   兩邊都被打中的大傷害，我的平均減傷比參考少 MITIGATION_GAP 以上 → 減傷差距。
 * - 沒有參考：造成受傷加重／傷害降低的一擊。
 * @param mineToRef 我的時間換成參考時間
 * @param penaltyTimes 我身上被施加受傷加重、傷害降低的時間（我的時間）
 * @param isAutoAttack Boss 普通攻擊（坦克 MT／ST 不同時會誤判，不判斷多吃）
 * @param keyOf 合併成同一列的鍵（例如英文名稱：同名不同 ID 的技能合併）；預設為技能 ID
 */
export function damageRows(
  mine: DamageHit[],
  ref: DamageHit[] | null,
  mineToRef: (t: number) => number,
  penaltyTimes: number[],
  isAutoAttack: (abilityId: number) => boolean,
  keyOf: (abilityId: number) => string | number = (id) => id,
): DamageRow[] {
  const group = (hits: DamageHit[]) => {
    const map = new Map<string | number, DamageHit[]>()
    for (const h of directHits(hits)) map.set(keyOf(h.abilityId), [...(map.get(keyOf(h.abilityId)) ?? []), h])
    return map
  }
  const mineBy = group(mine)
  const refBy = ref ? group(ref) : null
  const keys = [...new Set([...mineBy.keys(), ...(refBy?.keys() ?? [])])]
  return keys.map((key) => {
    const m = mineBy.get(key) ?? []
    const r = refBy?.get(key) ?? []
    const abilityId = (m[0] ?? r[0]).abilityId
    const flag = (h: DamageHit): FlaggedHit => ({ t: h.t, abilityId: h.abilityId, amount: h.amount, penalized: penalizedAt(h.t, penaltyTimes) })
    let flagged: FlaggedHit[]
    if (refBy === null) flagged = instances(m.filter((h) => penalizedAt(h.t, penaltyTimes)).map(flag))
    else if (isAutoAttack(abilityId)) flagged = []
    else {
      const extra = instances(m.map(flag)).length - instances(r.map(flag)).length
      const unmatched = instances(m.filter((h) => !r.some((x) => Math.abs(x.t - mineToRef(h.t)) <= EXTRA_HIT_WINDOW_MS)).map(flag))
      flagged = [...unmatched]
        .sort((a, b) => Number(b.penalized) - Number(a.penalized) || a.t - b.t)
        .slice(0, Math.max(0, extra))
        .sort((a, b) => a.t - b.t)
    }
    const mineHits = sideHits(m)
    const refHits = refBy ? sideHits(r) : null
    const maxHp = m.find((h) => h.maxHp)?.maxHp ?? null
    // 每次機制的未減傷傷害（連續幾擊合計）平均：多段攻擊（例如八連）每一擊小，但整次是大傷害
    const perInstance = chains(m).map((c) => c.reduce((s, h) => s + h.unmitigated, 0))
    const avgUnmitigated = perInstance.length ? perInstance.reduce((a, b) => a + b, 0) / perInstance.length : 0
    const mitigationGap =
      refHits !== null &&
      mineHits.mitigation !== null &&
      refHits.mitigation !== null &&
      refHits.mitigation - mineHits.mitigation >= MITIGATION_GAP &&
      maxHp !== null &&
      avgUnmitigated >= maxHp * BIG_HIT_SHARE
    return { abilityId, mine: mineHits, ref: refHits, flagged, mitigationGap, firstHit: m[0]?.t ?? null }
  })
}
/** 值得看的列：有多吃（或受到懲罰）、減傷差距；依多吃次數、受到的傷害排序 */
export function notableRows(rows: DamageRow[]): DamageRow[] {
  return sortRows(rows.filter((r) => r.flagged.length > 0 || r.mitigationGap))
}

export function sortRows(rows: DamageRow[]): DamageRow[] {
  return [...rows].sort((a, b) => b.flagged.length - a.flagged.length || Number(b.mitigationGap) - Number(a.mitigationGap) || b.mine.total - a.mine.total)
}

export interface RecapHit {
  t: number
  abilityId: number
  amount: number
  /** 這一擊前後的血量比例（0～1）；FFLogs 沒有血量時為 null */
  hpBefore: number | null
  hpAfter: number | null
  /** 這一擊的減傷（0～1）；受傷加重時為負值；沒有倍率時為 null */
  mitigation: number | null
  tick: boolean
}

export interface DeathRecap {
  death: Death
  hits: RecapHit[]
  /** 參考在對齊後時間被同一招（致命一擊）打中的情形；沒有參考或參考沒被打中時為 null */
  ref: { amount: number; mitigation: number | null; died: boolean } | null
}

/**
 * 死亡回顧：死前 RECAP_WINDOW_MS 內最後幾擊（含 DoT 跳傷）與血量；有參考時附上參考在對齊後時間被同一招打中的情形。
 */
export function deathRecap(
  death: Death,
  mine: DamageHit[],
  ref: { hits: DamageHit[]; deaths: Death[] } | null,
  mineToRef: (t: number) => number,
): DeathRecap {
  const hits = mine
    .filter((h) => h.t > death.t - RECAP_WINDOW_MS && h.t <= death.t)
    .slice(-RECAP_MAX_HITS)
    .map((h) => {
      const ratio = (hp: number | null) => (hp !== null && h.maxHp ? Math.max(0, Math.min(1, hp / h.maxHp)) : null)
      return {
        t: h.t,
        abilityId: h.abilityId,
        amount: h.amount,
        hpBefore: h.hpAfter !== null ? ratio(h.hpAfter + h.amount) : null,
        hpAfter: ratio(h.hpAfter),
        mitigation: h.multiplier !== null ? 1 - h.multiplier : null,
        tick: h.tick,
      }
    })
  const killing = [...hits].reverse().find((h) => !h.tick) ?? hits.at(-1)
  let refHit: DeathRecap['ref'] = null
  if (ref && killing) {
    const at = mineToRef(killing.t)
    const match = ref.hits
      .filter((h) => h.abilityId === killing.abilityId && Math.abs(h.t - at) <= EXTRA_HIT_WINDOW_MS)
      .sort((a, b) => Math.abs(a.t - at) - Math.abs(b.t - at))[0]
    if (match) {
      refHit = {
        amount: match.amount,
        mitigation: match.multiplier !== null ? 1 - match.multiplier : null,
        died: ref.deaths.some((d) => Math.abs(d.t - match.t) <= 2000),
      }
    }
  }
  return { death, hits, ref: refHit }
}
