import { playersInFight } from '../fflogs/report'
import { jobName } from '../jobs/names'
import type { Actor, Fight, Report } from '../fflogs/types'
import type { ReportRef } from '../fflogs/url'

/** 依「我的日誌」推導參考日誌的預設選擇。 */
export interface Preference {
  encounterID: number
  /** Boss 名稱（顯示用） */
  bossName: string
  subType: string
}

/** 使用者在下拉選單中手動選的值；null 代表沿用自動選擇。 */
export interface Overrides {
  fightId: number | null
  playerId: number | null
}

export interface Resolved {
  /** 戰鬥選單的選項：參考日誌只列與我同一個 Boss 的戰鬥 */
  fights: Fight[]
  fight: Fight | undefined
  /** 參考日誌沒有同一個 Boss 時的說明（戰鬥選單顯示並停用） */
  fightNote: string | null
  players: Actor[]
  player: Actor | undefined
  /** 無法自動選擇角色時給使用者的說明 */
  note: string | null
  /** 參考日誌只有一位與我同職業的玩家時鎖定，不讓使用者改選 */
  locked: boolean
}

/** 在可選的戰鬥中決定目前的戰鬥：手動選擇 → 連結的 fight → 最後一次擊殺（參考日誌）或最後一場。 */
function pickFight(fights: Fight[], urlRef: ReportRef, overrides: Overrides, preferred?: Preference): Fight | undefined {
  const byId = (id: number | null | undefined) => (id == null ? undefined : fights.find((f) => f.id === id))
  const manual = byId(overrides.fightId)
  if (manual) return manual
  if (urlRef.fight === 'last') return fights.at(-1)
  const fromUrl = byId(typeof urlRef.fight === 'number' ? urlRef.fight : undefined)
  if (fromUrl) return fromUrl
  // 參考日誌：同一個 Boss 優先選最後一次擊殺，沒有擊殺則選最後一場
  if (preferred) return fights.filter((f) => f.kill).at(-1) ?? fights.at(-1)
  return fights.at(-1)
}

/**
 * 決定目前選擇的戰鬥與角色。優先順序：手動選擇 → 連結中的 fight / source → 依我的日誌自動選擇。
 * 參考日誌（有 preferred）：
 * - 戰鬥只列與我同一個 Boss 的場次；沒有時不選戰鬥，並說明「這份報告沒有 X」。
 * - 角色只列與我同職業的玩家：恰好一位時自動選取並鎖定；兩位以上時由使用者（或連結的 source）在其中選擇；沒有時不選。
 */
export function resolveSelection(
  report: Report,
  urlRef: ReportRef,
  overrides: Overrides,
  preferred?: Preference,
): Resolved {
  const fights = preferred ? report.fights.filter((f) => f.encounterID === preferred.encounterID) : report.fights
  const fightNote = preferred && fights.length === 0 ? `這份報告沒有${preferred.bossName}` : null
  const fight = pickFight(fights, urlRef, overrides, preferred)
  const players = fight ? playersInFight(report, fight) : []
  const byId = (id: number | null | undefined) => (id == null ? undefined : players.find((p) => p.id === id))
  const base = { fights, fight, fightNote }

  if (!preferred) {
    const chosen = byId(overrides.playerId) ?? byId(urlRef.sourceId)
    return { ...base, players, player: chosen, note: null, locked: false }
  }
  // 沒有同一個 Boss：角色選單也顯示同樣的說明並停用
  if (!fight) return { ...base, players: [], player: undefined, note: fightNote, locked: false }

  // 已知我的職業：只能選同職業；只有一位時直接鎖定
  const sameJob = players.filter((p) => p.subType === preferred.subType)
  if (sameJob.length === 1) return { ...base, players: sameJob, player: sameJob[0], note: null, locked: true }
  const pick = (id: number | null | undefined) => (id == null ? undefined : sameJob.find((p) => p.id === id))
  const chosen = pick(overrides.playerId) ?? pick(urlRef.sourceId)
  const note = chosen
    ? null
    : sameJob.length > 1
      ? `這場戰鬥有 ${sameJob.length} 位${jobName(preferred.subType)}，請選擇要比較的對象`
      : `這場戰鬥沒有${jobName(preferred.subType)}`
  return { ...base, players: sameJob, player: chosen, note, locked: false }
}
