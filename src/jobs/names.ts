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

/** FFLogs 的 subType（例如 'BlackMage'）轉為繁中職業名稱；未知的職業沿用原名。 */
export function jobName(subType: string): string {
  return JOB_NAMES[subType] ?? subType
}
