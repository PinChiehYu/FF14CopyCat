import { playersInFight } from '../fflogs/report'
import type { Actor, Fight, Report } from '../fflogs/types'
import type { ReportRef } from '../fflogs/url'

/** 依「我的日誌」推導參考日誌的預設選擇。 */
export interface Preference {
  encounterID: number
  subType: string
}

/** 使用者在下拉選單中手動選的值；null 代表沿用自動選擇。 */
export interface Overrides {
  fightId: number | null
  playerId: number | null
}

export interface Resolved {
  fight: Fight | undefined
  players: Actor[]
  player: Actor | undefined
  /** 無法自動選擇角色時給使用者的說明 */
  note: string | null
}

function pickFight(report: Report, urlRef: ReportRef, overrides: Overrides, preferred?: Preference): Fight | undefined {
  const byId = (id: number | null | undefined) => (id == null ? undefined : report.fights.find((f) => f.id === id))
  const manual = byId(overrides.fightId)
  if (manual) return manual
  if (urlRef.fight === 'last') return report.fights.at(-1)
  const fromUrl = byId(typeof urlRef.fight === 'number' ? urlRef.fight : undefined)
  if (fromUrl) return fromUrl
  if (preferred) {
    // 同一個 Boss 優先選最後一次擊殺，沒有擊殺則選最後一場
    const same = report.fights.filter((f) => f.encounterID === preferred.encounterID)
    const match = same.filter((f) => f.kill).at(-1) ?? same.at(-1)
    if (match) return match
  }
  return report.fights.at(-1)
}

/**
 * 決定目前選擇的戰鬥與角色。優先順序：手動選擇 → 連結中的 fight / source → 依我的日誌自動選擇。
 * 角色自動選擇：這場戰鬥中與我同職業的玩家恰好一位時自動選取；兩位以上或沒有時留給使用者選。
 */
export function resolveSelection(
  report: Report,
  urlRef: ReportRef,
  overrides: Overrides,
  preferred?: Preference,
): Resolved {
  const fight = pickFight(report, urlRef, overrides, preferred)
  const players = fight ? playersInFight(report, fight) : []
  const byId = (id: number | null | undefined) => (id == null ? undefined : players.find((p) => p.id === id))

  const chosen = byId(overrides.playerId) ?? byId(urlRef.sourceId)
  if (chosen || !preferred) return { fight, players, player: chosen, note: null }

  const sameJob = players.filter((p) => p.subType === preferred.subType)
  if (sameJob.length === 1) return { fight, players, player: sameJob[0], note: null }
  const note =
    sameJob.length > 1
      ? `這場戰鬥有 ${sameJob.length} 位 ${preferred.subType}，請選擇要比較的對象`
      : `這場戰鬥沒有 ${preferred.subType}`
  return { fight, players, player: undefined, note }
}
