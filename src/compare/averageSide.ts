// 前輩平均參考：取同 Boss、同職業、同 PR 區間的前輩樣本（Worker 預處理），合成一份參考（我的時間），
// 交給比較流程當作參考日誌（見 Comparison.tsx 的 average）。
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { averageCasts } from '../analysis/averageLog'
import { decodeCasts } from '../analysis/castCodec'
import { mainMechanicGroups } from '../analysis/mainMechanics'
import { gcdStats, type GcdStats } from '../analysis/metrics'
import { fetchAutoAttacksTaken, fetchAverageSamples, AVERAGE_TIERS, type AverageSampleData, type AverageTier } from '../fflogs/client'
import { getJob } from '../jobs'
import { jobRole } from '../jobs/names'
import type { SideData } from './load'

/**
 * 前輩平均是否開放：開發中，只在本機（vite dev）出現；正式站不顯示。
 * 多數 Boss×職業的樣本足夠後才推出（docs/DESIGN.md「前輩平均」）。
 */
export const AVERAGE_ENABLED = import.meta.env.DEV

/** 平均參考的資訊（摘要表、樣本清單、提示用） */
export interface AverageInfo {
  tier: AverageTier
  /** 區間內的擊殺數（候選人數） */
  count: number
  /** 最近一次選樣本的時間 */
  updatedAt: number | null
  /** 樣本（依 rDPS 由高到低） */
  samples: AverageSampleData[]
  /** 對齊後實際用到的樣本數 */
  used: number
  /** 樣本 rDPS 的中位數 */
  rdps: number | null
  /** 樣本中最常見的版本 */
  patch: string | null
  /** 坦克的 MT／ST（依我這場判斷） */
  slot: 'MT' | 'ST' | null
  /** GCD 數、間隔與空檔：每位樣本在比較範圍內各自計算後取中位數（合成的 GCD 位置取中位數時間，間隔會有誤差）；沒有職業模組時為 null */
  gcd: GcdStats | null
}

// 樣本少於這麼多時提示「結果接近單一前輩，僅供參考」
export const FEW_SAMPLES = 10

const median = (values: number[]): number | null => {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  const mid = sorted.length >> 1
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}

function mostCommon(values: string[]): string | null {
  const counts = new Map<string, number>()
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1)
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null
}

/** 我這場坦克的 MT／ST：承受的 Boss 普通攻擊傷害在全隊最多者為 MT（與 Worker 的 tankSlot 相同） */
async function tankSlot(mine: SideData, signal: AbortSignal): Promise<'MT' | 'ST'> {
  const taken = await fetchAutoAttacksTaken(mine.selection.report.code, mine.selection.fight.id, signal)
  const own = taken.get(mine.selection.player.id) ?? 0
  return own > 0 && [...taken.values()].every((v) => v <= own) ? 'MT' : 'ST'
}

/**
 * 合成的參考：施放為前輩平均（我的時間、附一致度），Boss 施放與無法選中沿用我的（已在我的時間），
 * 戰鬥長度為比較範圍結束；位置、效果、死亡等逐場資料沒有（各區塊比照只有我的日誌處理）。
 */
export function averageSide(mine: SideData, samples: AverageSampleData[]): { side: SideData; used: number; gcd: GcdStats | null } {
  const job = getJob(mine.selection.player.subType)
  const result = averageCasts(
    mine.bossCasts,
    mine.duration,
    samples.map((s) => ({ boss: decodeCasts(s.boss), casts: decodeCasts(s.casts), duration: s.duration })),
    { knownGroups: mainMechanicGroups(mine.selection.fight.encounterID) ?? undefined, isGcd: (id) => (job ? job.isGcd(id) : true) },
  )
  const side: SideData = {
    selection: mine.selection,
    playerCasts: result.casts,
    autoAttacks: [],
    bossCasts: mine.bossCasts,
    playerPositions: [],
    bossPositions: [],
    buffs: [],
    debuffApplications: [],
    bossDebuffs: [],
    prepull: [],
    auras: [],
    hp: [],
    castBars: [],
    deaths: [],
    damageTaken: [],
    untargetable: mine.untargetable,
    duration: result.rangeEnd,
  }
  const perSample = job ? result.aligned.map((casts) => gcdStats(casts.filter((c) => job.isGcd(c.abilityId)).map((c) => c.t))) : []
  const gcdMs = perSample.flatMap((g) => (g.gcdMs === null ? [] : [g.gcdMs]))
  const gcd =
    perSample.length === 0
      ? null
      : {
          count: Math.round(median(perSample.map((g) => g.count))!),
          gcdMs: median(gcdMs),
          idleMs: median(perSample.map((g) => g.idleMs))!,
        }
  return { side, used: result.used, gcd }
}

export type AverageState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; side: SideData | null; info: AverageInfo }

/** 載入我這場對應的前輩樣本並合成平均參考；tier 為 null 時不載入 */
export function useAverageReference(mine: SideData | undefined, tier: AverageTier | null): AverageState | null {
  const [state, setState] = useState<{ key: string; value: AverageState } | null>(null)
  const key = mine && tier ? `${mine.selection.report.code}/${mine.selection.fight.id}/${mine.selection.player.id}/${tier}` : null
  // 只依選擇的 ID 與區間重新載入；Boss 繁中名稱晚到會換掉 SideData 物件，但資料不變
  const latest = useRef({ mine, tier })
  useLayoutEffect(() => {
    latest.current = { mine, tier }
  })
  useEffect(() => {
    const { mine, tier } = latest.current
    if (!mine || !tier || key === null) return
    const controller = new AbortController()
    const set = (value: AverageState) => !controller.signal.aborted && setState({ key, value })
    set({ status: 'loading' })
    ;(async () => {
      const { fight, player } = mine.selection
      const slot = jobRole(player.subType) === 'tank' ? await tankSlot(mine, controller.signal) : null
      const data = await fetchAverageSamples(
        { encounter: fight.encounterID, difficulty: fight.difficulty ?? 0, job: player.subType, tier, slot: slot ?? undefined },
        controller.signal,
      )
      const { side, used, gcd } = data.samples.length > 0 ? averageSide(mine, data.samples) : { side: null, used: 0, gcd: null }
      set({
        status: 'ready',
        side: used > 0 ? side : null,
        info: {
          tier,
          count: data.count,
          updatedAt: data.updatedAt,
          samples: data.samples,
          used,
          rdps: median(data.samples.map((s) => s.rdps)),
          patch: mostCommon(data.samples.map((s) => s.patch)),
          slot,
          gcd,
        },
      })
    })().catch((err: unknown) => set({ status: 'error', message: err instanceof Error ? err.message : String(err) }))
    return () => controller.abort()
  }, [key])
  return key !== null && state?.key === key ? state.value : key !== null ? { status: 'loading' } : null
}

/** 區間的顯示名稱 */
export const tierLabel = (tier: AverageTier) => AVERAGE_TIERS.find((t) => t.tier === tier)!.label
