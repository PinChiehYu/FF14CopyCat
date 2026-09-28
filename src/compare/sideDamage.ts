import { useEffect, useState } from 'react'
import { fetchDamageSummary, fetchTcRankings, type DamageSummary } from '../fflogs/client'
import type { Selection } from './load'

/** 一側整場的 DPS／rDPS 與在繁中服排名中的位置 */
export interface SideDamage {
  summary: DamageSummary | null
  /** 繁中服 PR（見 fetchTcRankings 的 position）；未擊殺、查不到或沒有排名資料時為 null */
  pr: { pr: number; better: number; count: number } | null
}

/**
 * 一側整場的 DPS／rDPS（FFLogs 傷害表），擊殺時再查這個 rDPS 在繁中服排名的 PR（與其他玩家各自最好的一場比較；
 * 自己已在排名中時扣掉自己，與排名表的 PR 一致）。查詢中為 undefined，不阻擋比較結果。
 * 摘要表與「搜尋前輩日誌」都會查同一側，網址相同，Worker 與瀏覽器的快取會共用。
 */
export function useSideDamage(selection: Selection | null): SideDamage | undefined {
  const [result, setResult] = useState<{ key: string; damage: SideDamage } | null>(null)
  const key = selection ? `${selection.report.code}/${selection.fight.id}/${selection.player.id}` : null
  useEffect(() => {
    if (!selection) return
    const controller = new AbortController()
    const { report, fight, player } = selection
    const load = async (): Promise<SideDamage> => {
      const summary = await fetchDamageSummary(report.code, fight.id, player.id, controller.signal).catch(() => null)
      if (!summary || !fight.kill) return { summary, pr: null }
      const ranking = await fetchTcRankings(
        {
          encounter: fight.encounterID,
          difficulty: fight.difficulty ?? 0,
          job: player.subType,
          // 只要位置：列表只取 PR 100（通常一兩筆）
          minPr: 100,
          maxPr: 100,
          rdps: Math.round(summary.rdps),
          player: player.server ? `${player.name}@${player.server}` : undefined,
        },
        controller.signal,
      ).catch(() => null)
      const pr = ranking?.position && ranking.count > 0 ? { ...ranking.position, count: ranking.count } : null
      return { summary, pr }
    }
    load().then((damage) => {
      if (!controller.signal.aborted) setResult({ key: key!, damage })
    })
    return () => controller.abort()
    // selection 物件會隨名稱翻譯更新，只依 ID 組成的 key 重新查詢
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [key])
  return result && result.key === key ? result.damage : undefined
}

// 預設搜尋「比我高一段」的前輩：PR 高 1～20
const PR_STEP_ABOVE = 20

/** 搜尋前輩日誌的預設 PR 範圍：比我的 PR 高一段（我的 PR＋1～＋20，上限 100）；沒有 PR 時 90～100。 */
export function defaultPrRange(pr: number | null): { min: number; max: number } {
  if (pr === null) return { min: 90, max: 100 }
  return { min: Math.min(pr + 1, 100), max: Math.min(pr + PR_STEP_ABOVE, 100) }
}
