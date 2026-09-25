// 職業的官方繁中名稱（遊戲 ClassJob 表，language=tc），以 FFLogs 的 subType 為鍵。
// 職業名稱不常變動，直接內建；新職業加入時補上。
const JOB_NAMES: Record<string, string> = {
  Paladin: '騎士',
  Warrior: '戰士',
  DarkKnight: '暗黑騎士',
  Gunbreaker: '絕槍戰士',
  WhiteMage: '白魔道士',
  Scholar: '學者',
  Astrologian: '占星術師',
  Sage: '賢者',
  Monk: '武僧',
  Dragoon: '龍騎士',
  Ninja: '忍者',
  Samurai: '武士',
  Reaper: '奪魂者',
  Viper: '毒蛇劍士',
  Bard: '吟遊詩人',
  Machinist: '機工士',
  Dancer: '舞者',
  BlackMage: '黑魔道士',
  Summoner: '召喚士',
  RedMage: '赤魔道士',
  Pictomancer: '繪靈法師',
  BlueMage: '青魔道士',
}

export type JobRole = 'tank' | 'healer' | 'dps'

const TANKS = new Set(['Paladin', 'Warrior', 'DarkKnight', 'Gunbreaker'])
const HEALERS = new Set(['WhiteMage', 'Scholar', 'Astrologian', 'Sage'])

/** 職業的職能（坦克／治療／輸出），介面以藍／綠／紅區分；未知職業視為輸出。 */
export function jobRole(subType: string): JobRole {
  return TANKS.has(subType) ? 'tank' : HEALERS.has(subType) ? 'healer' : 'dps'
}

// 隊伍位置的習慣分類：H1 為純治療、H2 為護盾治療；D1／D2 近戰、D3 遠程物理、D4 魔法
type SlotGroup = 'tank' | 'pure' | 'barrier' | 'melee' | 'ranged' | 'caster'
const SLOT_GROUP: Record<string, SlotGroup> = {
  Paladin: 'tank',
  Warrior: 'tank',
  DarkKnight: 'tank',
  Gunbreaker: 'tank',
  WhiteMage: 'pure',
  Astrologian: 'pure',
  Scholar: 'barrier',
  Sage: 'barrier',
  Monk: 'melee',
  Dragoon: 'melee',
  Ninja: 'melee',
  Samurai: 'melee',
  Reaper: 'melee',
  Viper: 'melee',
  Bard: 'ranged',
  Machinist: 'ranged',
  Dancer: 'ranged',
  BlackMage: 'caster',
  Summoner: 'caster',
  RedMage: 'caster',
  Pictomancer: 'caster',
  BlueMage: 'caster',
}
const GROUP_ORDER: SlotGroup[] = ['tank', 'pure', 'barrier', 'melee', 'ranged', 'caster']
// 標準 8 人隊的位置名稱，依排序後的順序分配
const SLOTS = ['MT', 'ST', 'H1', 'H2', 'D1', 'D2', 'D3', 'D4']

/** 標準的 2 坦 2 補 4 輸出隊伍（才標隊伍位置）。 */
export function isStandardParty(players: { subType: string }[]): boolean {
  const roles = players.map((p) => jobRole(p.subType))
  return (
    players.length === 8 &&
    roles.filter((r) => r === 'tank').length === 2 &&
    roles.filter((r) => r === 'healer').length === 2
  )
}

/**
 * 依隊伍位置排序（坦克 → 純治療 → 護盾治療 → 近戰 → 遠程物理 → 魔法），並在標準隊伍中標上 MT／ST／H1／H2／D1～D4。
 * MT／ST 依實際坦 Boss 的情況：tankLoad（承受的 Boss 普通攻擊傷害）較多者為 MT；還沒有資料時坦克不標位置。
 * 組成不標準時不標位置。
 */
export function sortByPartySlot<T extends { id: number; subType: string; name: string }>(
  players: T[],
  tankLoad?: Map<number, number>,
): { player: T; slot: string | null }[] {
  const rank = (p: T) => GROUP_ORDER.indexOf(SLOT_GROUP[p.subType] ?? 'caster')
  const load = (p: T) => (jobRole(p.subType) === 'tank' ? (tankLoad?.get(p.id) ?? 0) : 0)
  const sorted = [...players].sort(
    (a, b) =>
      rank(a) - rank(b) ||
      load(b) - load(a) ||
      jobName(a.subType).localeCompare(jobName(b.subType)) ||
      a.name.localeCompare(b.name),
  )
  const standard = isStandardParty(sorted)
  return sorted.map((player, i) => ({
    player,
    slot: !standard || (jobRole(player.subType) === 'tank' && !tankLoad) ? null : SLOTS[i],
  }))
}

/** FFLogs 的 subType（例如 'BlackMage'）轉為繁中職業名稱；未知的職業沿用原名。 */
export function jobName(subType: string): string {
  return JOB_NAMES[subType] ?? subType
}
