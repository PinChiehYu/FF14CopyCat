import type { Ability, Actor, Fight, Report } from './types'

export function abilityIconUrl(icon: string): string {
  return `https://assets.rpglogs.com/img/ff/abilities/${icon}`
}

/** FFLogs 的效果（Status）ID＝1,000,000＋狀態 ID；效果圖示為 24×32 直式，顯示時要維持比例 */
export function isStatusId(id: number): boolean {
  return id >= 1_000_000 && id < 2_000_000
}

export function abilityMap(report: Report): Map<number, Ability> {
  return new Map(report.masterData.abilities.map((a) => [a.gameID, a]))
}

// FFLogs 把極限技記成 type 'Player' 的假角色（名稱如 'Limit Break'、'Multiple Players'）。
const NON_PLAYER_SUBTYPES = new Set(['LimitBreak', 'Unknown'])

/** 該場戰鬥中可供選擇比較的真實玩家。 */
export function playersInFight(report: Report, fight: Fight): Actor[] {
  const ids = new Set(fight.friendlyPlayers ?? [])
  return report.masterData.actors.filter(
    (a) => a.type === 'Player' && ids.has(a.id) && !NON_PLAYER_SUBTYPES.has(a.subType),
  )
}
