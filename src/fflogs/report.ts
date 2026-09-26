import type { Ability, Actor, Fight, Report } from './types'

export function abilityIconUrl(icon: string): string {
  return `https://assets.rpglogs.com/img/ff/abilities/${icon}`
}

/** FFLogs 的效果（Status）ID＝1,000,000＋狀態 ID；效果圖示為 24×32 直式，顯示時要維持比例 */
export function isStatusId(id: number): boolean {
  return id >= 1_000_000 && id < 2_000_000
}

/**
 * 遊戲資料沒有名稱的技能：FFLogs 以 `unknown_<16 進位 ID>` 表示（遊戲資料各語言的名稱都是空的）。
 * 例如熱舞綠光的 #42693（`unknown_a6c5`）是 Boss 對環境施放、沒有傷害的演出動作，對使用者沒有意義。
 */
export function isUnnamedAbility(name: string | undefined): boolean {
  return !name || /^unknown_[0-9a-f]+$/i.test(name)
}

/** FFLogs 的道具 ID：0x2000000＋遊戲道具 ID（HQ 再加 1,000,000）。 */
export function isItemId(id: number): boolean {
  return id >= 0x2000000
}

/** 爆發藥（強化藥）的英文名稱（依名稱判斷的規則一律用英文名稱）。 */
export function isPotionName(englishName: string): boolean {
  return /Gemdraught|Tincture|Draught|Potion/i.test(englishName)
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
