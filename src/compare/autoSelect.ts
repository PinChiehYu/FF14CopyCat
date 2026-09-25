import { playersInFight } from '../fflogs/report'
import { jobName } from '../jobs/names'
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
  /** 參考日誌只有一位與我同職業的玩家時鎖定，不讓使用者改選 */
  locked: boolean
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
 * 參考日誌（有 preferred）只列出與我同職業的玩家：恰好一位時自動選取並鎖定；兩位以上時由使用者（或連結的 source）
 * 在其中選擇；沒有時不選。
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

  if (!preferred) {
    const chosen = byId(overrides.playerId) ?? byId(urlRef.sourceId)
    return { fight, players, player: chosen, note: null, locked: false }
  }

  // 已知我的職業：只能選同職業；只有一位時直接鎖定
  const sameJob = players.filter((p) => p.subType === preferred.subType)
  if (sameJob.length === 1) return { fight, players: sameJob, player: sameJob[0], note: null, locked: true }
  const pick = (id: number | null | undefined) => (id == null ? undefined : sameJob.find((p) => p.id === id))
  const chosen = pick(overrides.playerId) ?? pick(urlRef.sourceId)
  const note = chosen
    ? null
    : sameJob.length > 1
      ? `這場戰鬥有 ${sameJob.length} 位${jobName(preferred.subType)}，請選擇要比較的對象`
      : `這場戰鬥沒有${jobName(preferred.subType)}`
  return { fight, players: sameJob, player: chosen, note, locked: false }
}
