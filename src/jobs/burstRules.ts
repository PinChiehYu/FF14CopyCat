// 各職業的爆發技（「爆發與團隊 Buff」判斷要不要對上團隊 Buff 的技能）。
// 只列職業的爆發技：好了就用的技能（乙太超流、暴食、吸取能量、疾風極意、側風誘導箭、迴轉飛鋸、三連詠唱、腐穢大地、弓形衝波等）
// 與給狀態、量譜的準備動作（技巧舞步、槍管加熱、活殺自在、詠唱強化）不列；給狀態、之後才打出爆發的技能（蛇靈氣、意氣衝天、
// 掠影示現、血壤、烈日龍神召喚、魔元化）照常列在卡片上，但以 alignAt 的後續技能的時間判斷。自己的團隊 Buff 列入，判斷時只看隊友的團隊 Buff。
// 技能 ID 取自 cooldownRules.ts（已查證）與遊戲資料；依據與資料驗證見 TECH_NOTES.md「爆發技的資料驗證」。

export interface BurstRule {
  key: string
  /** 同一技能的各等級／變化 */
  ids: number[]
  /**
   * 爆發的週期：120 秒＝2 分鐘爆發（每次都要對上團隊 Buff，一律評分）；
   * 60 秒＝1 分鐘爆發（每兩次有一次對上，兩輪團隊 Buff 之間的那次不評）
   */
  periodMs: 60_000 | 120_000
  /**
   * 這個技能只是給狀態，真正的爆發是之後用的技能：以觸發後 withinMs 內第一次使用 alignAt 技能的時間判斷；
   * 期限內沒用到時以觸發技能的時間判斷
   */
  alignAt?: { ids: number[]; withinMs: number }
  source: string
}

const MIN = 60_000
const TWO_MIN = 120_000

export const BURST_RULES: Record<string, BurstRule[]> = {
  Paladin: [
    { key: 'fight-or-flight', ids: [20], periodMs: MIN, source: '戰逃反應' },
    { key: 'imperator', ids: [36921], periodMs: MIN, source: '絕對統治（在戰逃反應期間用）' },
  ],
  Warrior: [{ key: 'inner-release', ids: [7389], periodMs: MIN, source: '原初的解放' }],
  DarkKnight: [
    { key: 'delirium', ids: [7390], periodMs: MIN, source: '血亂' },
    // 掠影示現給掠影的蔑視：以之後的掠影的蔑視判斷（資料：掠影示現 68%、掠影的蔑視 83% 在隊友的團隊 Buff 內）
    { key: 'living-shadow', ids: [16472], periodMs: TWO_MIN, alignAt: { ids: [36932], withinMs: 30_000 }, source: '掠影示現→掠影的蔑視' },
  ],
  Gunbreaker: [
    { key: 'no-mercy', ids: [16138], periodMs: MIN, source: '無情' },
    // 血壤給崛起之心：以之後的崛起之心判斷（資料：血壤 80%、崛起之心 98%）
    { key: 'bloodfest', ids: [16164], periodMs: TWO_MIN, alignAt: { ids: [36937], withinMs: 30_000 }, source: '血壤→崛起之心' },
  ],
  WhiteMage: [{ key: 'presence-of-mind', ids: [136], periodMs: TWO_MIN, source: '神速咏唱' }],
  Scholar: [{ key: 'chain-stratagem', ids: [7436], periodMs: TWO_MIN, source: '連環計（自己的團隊 Buff）' }],
  Astrologian: [{ key: 'divination', ids: [16552], periodMs: TWO_MIN, source: '占卜（自己的團隊 Buff）' }],
  // 賢者沒有爆發技（只看強化藥）
  Sage: [],
  Monk: [
    { key: 'brotherhood', ids: [7396], periodMs: TWO_MIN, source: '義結金蘭（自己的團隊 Buff）' },
    { key: 'riddle-of-fire', ids: [7395], periodMs: MIN, source: '紅蓮極意' },
  ],
  Dragoon: [
    { key: 'battle-litany', ids: [3557], periodMs: TWO_MIN, source: '戰鬥連禱（自己的團隊 Buff）' },
    { key: 'dragonfire-dive', ids: [96], periodMs: TWO_MIN, source: '龍炎衝' },
    { key: 'lance-charge', ids: [85], periodMs: MIN, source: '猛槍' },
  ],
  Ninja: [
    { key: 'dokumori', ids: [36957], periodMs: TWO_MIN, source: '介毒之術（自己的團隊 Buff）' },
    { key: 'ten-chi-jin', ids: [7403], periodMs: TWO_MIN, source: '天地人' },
    { key: 'meisui', ids: [16489], periodMs: TWO_MIN, source: '命水' },
    { key: 'kunais-bane', ids: [36958], periodMs: MIN, source: '百雷銃（活殺自在是準備動作，不列）' },
  ],
  Samurai: [
    // 意氣衝天給奧義斬浪預備：以之後的奧義斬浪判斷
    { key: 'ikishoten', ids: [16482], periodMs: TWO_MIN, alignAt: { ids: [25781], withinMs: 30_000 }, source: '意氣衝天→奧義斬浪' },
    { key: 'hissatsu-guren', ids: [7496, 16481], periodMs: MIN, source: '必殺劍・紅蓮／閃影' },
  ],
  Reaper: [{ key: 'arcane-circle', ids: [24405], periodMs: TWO_MIN, source: '神秘環（自己的團隊 Buff）' }],
  Viper: [
    // 蛇靈氣給祖靈降臨預備：以之後的祖靈降臨判斷（祖靈降臨靠量譜、一輪用好幾次，只有蛇靈氣之後的那次代表 2 分鐘爆發）
    { key: 'serpents-ire', ids: [34647], periodMs: TWO_MIN, alignAt: { ids: [34626], withinMs: 30_000 }, source: '蛇靈氣→祖靈降臨' },
  ],
  Bard: [
    { key: 'battle-voice', ids: [118], periodMs: TWO_MIN, source: '戰鬥之聲（自己的團隊 Buff）' },
    { key: 'radiant-finale', ids: [25785], periodMs: TWO_MIN, source: '光明神的最終樂章（自己的團隊 Buff）' },
    { key: 'raging-strikes', ids: [101], periodMs: TWO_MIN, source: '猛者強擊' },
    { key: 'barrage', ids: [107], periodMs: TWO_MIN, source: '縱情' },
  ],
  Machinist: [{ key: 'wildfire', ids: [2878], periodMs: TWO_MIN, source: '野火（槍管加熱是準備動作，不列）' }],
  Dancer: [
    // 技巧舞步只是開始跳舞，真正給團隊 Buff 的是技巧舞步結束（各色）
    { key: 'technical-finish', ids: [16004, 16193, 16194, 16195, 16196, 33215, 33216, 33217, 33218], periodMs: TWO_MIN, source: '技巧舞步結束（自己的團隊 Buff）' },
    { key: 'devilment', ids: [16011], periodMs: TWO_MIN, source: '進攻之探戈' },
  ],
  // 黑魔沒有固定對齊團隊 Buff 的爆發技（資料：黑魔紋只有 52%、間隔漂移，詠唱強化 65%），只看強化藥
  BlackMage: [],
  Summoner: [
    { key: 'searing-light', ids: [25801], periodMs: TWO_MIN, source: '灼熱之光（自己的團隊 Buff）' },
    // 烈日龍神召喚（2 分鐘的召喚；龍神、鳳凰召喚不列）在灼熱之光前施放：以之後的烈日龍神迸發判斷（資料：召喚 51%、迸發 95%）
    { key: 'solar-bahamut', ids: [36992], periodMs: TWO_MIN, alignAt: { ids: [36998], withinMs: 30_000 }, source: '烈日龍神召喚→烈日龍神迸發' },
  ],
  RedMage: [
    { key: 'embolden', ids: [7520], periodMs: TWO_MIN, source: '鼓勵（自己的團隊 Buff）' },
    // 魔元化給光芒四射：以之後的光芒四射判斷（資料：魔元化 71%、光芒四射 100%）
    { key: 'manafication', ids: [7521], periodMs: TWO_MIN, alignAt: { ids: [37007], withinMs: 30_000 }, source: '魔元化→光芒四射' },
  ],
  Pictomancer: [{ key: 'starry-muse', ids: [34675], periodMs: TWO_MIN, source: '星空構想（自己的團隊 Buff）' }],
}

/** 職業的爆發技；沒有規則的職業回傳空陣列（只看強化藥） */
export function burstRules(subType: string): BurstRule[] {
  return BURST_RULES[subType] ?? []
}
