import type { DamageHit, Death } from '../compare/load'

// 參考在對齊後時間前後這麼久內被同一招打中，視為同一次機制
const SAME_MECHANIC_WINDOW_MS = 5000
// 死亡回顧：死前多久、最多幾擊
export const RECAP_WINDOW_MS = 10_000
const RECAP_MAX_HITS = 5

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
 * 死亡回顧（死亡建議的說明用）：死前 RECAP_WINDOW_MS 內最後幾擊（含 DoT 跳傷）與血量；
 * 有參考時附上參考在對齊後時間被同一招打中的情形。
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
      .filter((h) => h.abilityId === killing.abilityId && Math.abs(h.t - at) <= SAME_MECHANIC_WINDOW_MS)
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
